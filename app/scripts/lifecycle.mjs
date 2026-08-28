// One command path for the bundle lifecycle.
//
// The bundle, the schedule-principal grant tool and the operating notes already existed. What did
// not exist was an executable boundary between them: an installer had to know that `bundle deploy`
// does not restart an App, that app updates can replace OBO scopes, which grants belong to the
// scheduled identity, and which bound resources survive `bundle destroy`. This command makes those
// transitions explicit and refuses every mutating operation unless `--apply` is present.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ACTIONS = new Set(['validate', 'install', 'upgrade', 'rollback', 'uninstall']);
const DEFAULT_SCOPES = new Set(['iam.access-control:read', 'iam.current-user:read']);
const DEPLOYMENT_POLL_ATTEMPTS = 600;
const DEPLOYMENT_POLL_INTERVAL_MS = 2_000;
const FAILED_DEPLOYMENT_STATES = new Set(['CANCELLED', 'FAILED']);
const WORKSPACE_OVERRIDE_ENV = Object.freeze([
  'DATABRICKS_HOST',
  'DATABRICKS_TOKEN',
  'DATABRICKS_USERNAME',
  'DATABRICKS_PASSWORD',
  'DATABRICKS_CLIENT_ID',
  'DATABRICKS_CLIENT_SECRET',
  'DATABRICKS_ACCOUNT_ID',
  'DATABRICKS_WORKSPACE_ID',
  'DATABRICKS_CONFIG_PROFILE',
  'DATABRICKS_BUNDLE_TARGET',
]);

/** Explicit profile/target selection cannot be trusted while a higher-precedence env selector survives. */
export function commandEnvironment(overrides = {}, inherited = process.env) {
  const clean = { ...inherited };
  for (const name of WORKSPACE_OVERRIDE_ENV) delete clean[name];
  return { ...clean, ...overrides };
}

function valueAfter(argv, name) {
  const joined = argv.find((one) => one.startsWith(`${name}=`));
  if (joined != null) return joined.slice(name.length + 1).trim();
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1]?.trim();
  return value == null || value === '' || value.startsWith('--') ? undefined : value;
}

export function parseLifecycleArgs(argv) {
  const action = argv[0];
  if (!ACTIONS.has(action)) {
    throw new Error(`Choose one lifecycle action: ${[...ACTIONS].join(', ')}.`);
  }
  const profile = valueAfter(argv, '--profile');
  const target = valueAfter(argv, '--target');
  if (profile == null) throw new Error('--profile is required; the lifecycle never selects a workspace for you.');
  if (target == null) throw new Error('--target is required; use `default` for labs or `customer` for an install.');

  const apply = argv.includes('--apply');
  const confirm = valueAfter(argv, '--confirm');
  const to = valueAfter(argv, '--to');
  const fromDeployment = valueAfter(argv, '--from-deployment');
  const catalogs = valueAfter(argv, '--schedule-catalogs');
  const sharing = argv.includes('--schedule-sharing');

  if (action === 'rollback' && to == null) {
    throw new Error('rollback requires --to <commit-or-tag>; check out that exact source before running it.');
  }
  if (action === 'rollback' && apply && fromDeployment == null) {
    throw new Error('an applied rollback requires --from-deployment <current-deployment-id>.');
  }
  if (action !== 'rollback' && (to != null || fromDeployment != null)) {
    throw new Error('--to and --from-deployment belong only to rollback.');
  }
  if (action !== 'uninstall' && confirm != null) {
    throw new Error('--confirm belongs only to uninstall.');
  }
  if (catalogs != null && catalogs === '') throw new Error('--schedule-catalogs needs `all` or catalog names.');

  return { action, profile, target, apply, confirm, to, fromDeployment, catalogs, sharing };
}

function isPresent(value) {
  return typeof value === 'string' && value.trim() !== '';
}

export function bundleFacts(resolved) {
  const app = resolved?.resources?.apps?.app;
  const job = resolved?.resources?.jobs?.scheduled_assessment;
  const warehouse = app?.resources?.find((one) => one.name === 'sql-warehouse')?.sql_warehouse;
  const postgres = app?.resources?.find((one) => one.name === 'postgres')?.postgres;
  const workspace = resolved?.workspace;
  const scheduleClient = resolved?.variables?.schedule_client_id?.value;
  const missing = [];

  if (!isPresent(resolved?.bundle?.name)) missing.push('bundle name');
  if (!isPresent(workspace?.host)) missing.push('workspace host');
  if (!isPresent(app?.name)) missing.push('app resource');
  if (!isPresent(warehouse?.id)) missing.push('sql_warehouse_id');
  if (!isPresent(postgres?.branch)) missing.push('postgres_branch');
  if (!isPresent(postgres?.database)) missing.push('postgres_database');
  if (job == null) missing.push('scheduled job resource');
  if (missing.length > 0) throw new Error(`The resolved bundle is incomplete: ${missing.join(', ')}.`);

  return {
    bundle: resolved.bundle.name,
    target: resolved.bundle.target,
    host: workspace.host,
    actor: workspace.current_user?.userName ?? workspace.current_user?.displayName ?? 'not reported',
    app: app.name,
    appKey: 'app',
    job: job.name,
    warehouse: warehouse.id,
    postgresBranch: postgres.branch,
    postgresDatabase: postgres.database,
    scopes: [...(app.user_api_scopes ?? [])],
    scheduleClient: isPresent(scheduleClient) ? scheduleClient : undefined,
    schedulePaused: job.schedule?.pause_status === 'PAUSED',
    workspaceRoot: workspace.root_path,
  };
}

export function planFacts(answer) {
  const entries = Object.entries(answer?.plan ?? {}).map(([resource, change]) => ({
    resource,
    action: change?.action ?? 'unknown',
  }));
  if (entries.length === 0) throw new Error('The DAB plan named no managed resources.');
  return entries;
}

export function isIdempotent(answer) {
  return planFacts(answer).every((one) => one.action === 'skip');
}

export function uninstallToken(facts, profile, inventory) {
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        bundle: facts.bundle,
        profile,
        target: facts.target,
        host: facts.host,
        app: facts.app,
        deploymentId: inventory.deploymentId,
        jobId: inventory.jobId,
        removes: inventory.removes,
        retains: inventory.retains,
        scheduledRevocation: inventory.scheduledRevocation,
      })
    )
    .digest('hex');
  return `destroy:${facts.bundle}:${profile}:${facts.target}:${facts.app}:${digest}`;
}

export function uninstallInventory(facts, summary, deployed, scheduledRevocation) {
  const app = summary?.resources?.apps?.app;
  const job = summary?.resources?.jobs?.scheduled_assessment;
  const deploymentId = deployed?.active_deployment?.deployment_id;
  const jobId = job?.id;
  if (!isPresent(deploymentId) || !isPresent(jobId)) {
    throw new Error('Uninstall inventory is incomplete: the active deployment id and scheduled job id are required.');
  }
  return {
    removes: [
      `Databricks App ${app?.name ?? facts.app} (active deployment ${deploymentId})`,
      `Lakeflow Job ${job?.name ?? facts.job} (${jobId})`,
      `bundle workspace files under ${facts.workspaceRoot}`,
    ],
    retains: [
      `Lakebase database ${facts.postgresDatabase}`,
      `Lakebase branch ${facts.postgresBranch}`,
      `SQL warehouse ${facts.warehouse}`,
      'all customer records in the bound Lakebase database',
    ],
    deploymentId,
    jobId,
    scheduledRevocation,
  };
}

export function verifyDeployment(deployed, facts) {
  const problems = [];
  if (deployed?.app_status?.state !== 'RUNNING') problems.push(`app state ${deployed?.app_status?.state ?? 'missing'}`);
  if (deployed?.active_deployment?.status?.state !== 'SUCCEEDED') {
    problems.push(`deployment state ${deployed?.active_deployment?.status?.state ?? 'missing'}`);
  }
  if (!isPresent(deployed?.active_deployment?.deployment_id)) problems.push('deployment id missing');

  const effective = new Set(deployed?.effective_user_api_scopes ?? []);
  const expected = new Set([...facts.scopes, ...DEFAULT_SCOPES]);
  for (const scope of facts.scopes) if (!effective.has(scope)) problems.push(`effective scope missing: ${scope}`);
  for (const scope of DEFAULT_SCOPES) if (!effective.has(scope)) problems.push(`default scope missing: ${scope}`);
  for (const scope of effective) if (!expected.has(scope)) problems.push(`unexpected effective scope: ${scope}`);

  const resources = new Map((deployed?.resources ?? []).map((one) => [one.name, one]));
  const warehouse = resources.get('sql-warehouse')?.sql_warehouse;
  if (warehouse?.id !== facts.warehouse) {
    problems.push('the deployed SQL warehouse differs from the resolved bundle');
  }
  if (warehouse?.permission !== 'CAN_USE') problems.push('the deployed SQL warehouse binding is not CAN_USE');
  const postgres = resources.get('postgres')?.postgres;
  if (postgres?.branch !== facts.postgresBranch || postgres?.database !== facts.postgresDatabase) {
    problems.push('the deployed Lakebase binding differs from the resolved bundle');
  }
  if (postgres?.permission !== 'CAN_CONNECT_AND_CREATE') {
    problems.push('the deployed Lakebase binding is not CAN_CONNECT_AND_CREATE');
  }
  if (problems.length > 0) throw new Error(`Post-deploy verification failed: ${problems.join('; ')}.`);

  return {
    deploymentId: deployed.active_deployment.deployment_id,
    url: deployed.url,
    appState: deployed.app_status.state,
    deploymentState: deployed.active_deployment.status.state,
  };
}

export function scheduleArgs(options, facts, { revoke = false } = {}) {
  if (facts.scheduleClient == null) return undefined;
  const args = ['scripts/schedule-principal.mjs', '--client-id', facts.scheduleClient];
  if (revoke) args.push('--revoke');
  if (!revoke && options.catalogs != null) args.push('--catalogs', options.catalogs);
  if (!revoke && options.sharing) args.push('--sharing');
  if (options.apply) args.push('--apply');
  return args;
}

export class CommandRunner {
  run(command, args, { json = false, allow = [0], env = {} } = {}) {
    const answer = spawnSync(command, args, {
      cwd: process.cwd(),
      env: commandEnvironment(env),
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
    if (answer.error != null) throw answer.error;
    if (!allow.includes(answer.status ?? -1)) {
      throw new Error(
        `${command} ${args.join(' ')} failed (${String(answer.status)}):\n${answer.stderr || answer.stdout}`
      );
    }
    const stdout = answer.stdout ?? '';
    return json ? JSON.parse(stdout === '' ? 'null' : stdout) : stdout;
  }
}

function cliArgs(options, args, { json = false } = {}) {
  const result = [...args, '--profile', options.profile, '--target', options.target];
  if (json) result.push('-o', 'json');
  return result;
}

function gitAt(runner, ref) {
  return runner.run('git', ['rev-parse', `${ref}^{commit}`]).trim();
}

function appTreeChanges(runner) {
  return runner.run('git', ['status', '--porcelain=v1', '--untracked-files=all', '--', '.']).trim();
}

function optionalApp(runner, options, name) {
  try {
    return runner.run('databricks', ['apps', 'get', name, '--profile', options.profile, '-o', 'json'], { json: true });
  } catch (error) {
    if (/RESOURCE_DOES_NOT_EXIST|does not exist|not found/i.test(String(error))) return undefined;
    throw error;
  }
}

function deploymentSlots(app) {
  return [
    ['active', app?.active_deployment],
    ['pending', app?.pending_deployment],
  ].flatMap(([slot, deployment]) => (isPresent(deployment?.deployment_id) ? [{ slot, deployment }] : []));
}

function deploymentIds(app) {
  return new Set(deploymentSlots(app).map(({ deployment }) => deployment.deployment_id));
}

function deploymentReading(app) {
  const slots = deploymentSlots(app)
    .map(({ slot, deployment }) => `${slot}=${deployment.deployment_id}:${deployment.status?.state ?? 'state missing'}`)
    .join(', ');
  return `app=${app?.app_status?.state ?? 'state missing'}; ${slots === '' ? 'no deployments' : slots}`;
}

function pauseSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Join this invocation to the deployment created after `bundle run app`.
 *
 * The first DAB deploy can itself create an App deployment, so the lifecycle records both App slots
 * immediately before the run command and refuses to treat either id as the run's result. The poll
 * controls are injectable because the production lifecycle is synchronous while unit tests must not
 * spend real time waiting for the platform.
 */
export function waitForRequestedDeployment(
  runner,
  options,
  appName,
  preRun,
  { attempts = DEPLOYMENT_POLL_ATTEMPTS, pause = pauseSynchronously, intervalMs = DEPLOYMENT_POLL_INTERVAL_MS } = {}
) {
  const preRunIds = deploymentIds(preRun);
  let boundId;
  let last;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    last = runner.run('databricks', ['apps', 'get', appName, '--profile', options.profile, '-o', 'json'], {
      json: true,
    });
    const slots = deploymentSlots(last);
    const newSlots = slots.filter(({ deployment }) => !preRunIds.has(deployment.deployment_id));

    if (boundId == null) {
      const newIds = [...new Set(newSlots.map(({ deployment }) => deployment.deployment_id))];
      if (newIds.length > 1) {
        throw new Error(
          `App run produced more than one new deployment (${newIds.join(', ')}); refusing an ambiguous join. ` +
            `Pre-run ids: ${[...preRunIds].join(', ') || 'none'}.`
        );
      }
      boundId = newIds[0];
    }

    if (boundId != null) {
      const replacements = [
        ...new Set(
          newSlots.map(({ deployment }) => deployment.deployment_id).filter((deploymentId) => deploymentId !== boundId)
        ),
      ];
      if (replacements.length > 0) {
        throw new Error(
          `Deployment ${boundId} was replaced by ${replacements.join(', ')} while the lifecycle was waiting; ` +
            'refusing concurrent deployment drift.'
        );
      }

      const bound = slots.find(({ deployment }) => deployment.deployment_id === boundId);
      const state = bound?.deployment?.status?.state;
      if (FAILED_DEPLOYMENT_STATES.has(state)) {
        throw new Error(`Deployment ${boundId} failed with state ${state}.`);
      }
      if (bound?.slot === 'active' && state === 'SUCCEEDED' && last?.app_status?.state === 'RUNNING') {
        return { app: last, deploymentId: boundId };
      }
    }

    if (attempt + 1 < attempts) pause(intervalMs);
  }

  throw new Error(
    `Timed out waiting for the App deployment requested by bundle run. Pre-run ids: ` +
      `${[...preRunIds].join(', ') || 'none'}. Bound id: ${boundId ?? 'none'}. ` +
      `Last observed: ${deploymentReading(last)}.`
  );
}

function verifyRequestedDeployment(deployed, requestedId, facts) {
  const activeId = deployed?.active_deployment?.deployment_id;
  const pendingId = deployed?.pending_deployment?.deployment_id;
  if (activeId !== requestedId || (isPresent(pendingId) && pendingId !== requestedId)) {
    throw new Error(
      `Requested deployment ${requestedId} did not remain the sole active deployment through lifecycle completion. ` +
        `Final reading: ${deploymentReading(deployed)}.`
    );
  }
  return verifyDeployment(deployed, facts);
}

function schedule(runner, options, facts, revoke = false) {
  const args = scheduleArgs(options, facts, { revoke });
  if (args == null) return 'Scheduled identity is not configured; the deployed job remains paused.';
  const env = { DATABRICKS_CONFIG_PROFILE: options.profile, DATABRICKS_BUNDLE_TARGET: options.target };
  return runner.run('node', args, { allow: options.apply ? [0] : [0, 1], env });
}

function linesFor(facts, plan, action) {
  return [
    `${action} ${facts.bundle} on ${facts.host}`,
    `Actor: ${facts.actor}`,
    `Target/profile: ${facts.target} / ${facts.profile ?? ''}`.trim(),
    `App: ${facts.app}`,
    `Scheduled job: ${facts.job} (${facts.schedulePaused ? 'paused' : 'not reported paused'})`,
    `Store retained outside the bundle: ${facts.postgresDatabase}`,
    ...plan.map((one) => `  ${one.action.padEnd(8)} ${one.resource}`),
  ];
}

export function runLifecycle(options, runner = new CommandRunner(), beforeMutation = () => {}, deploymentPoll = {}) {
  const auth = runner.run('databricks', ['auth', 'describe', '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  if (auth?.status !== 'success' || !isPresent(auth?.details?.host)) {
    throw new Error(`Profile ${options.profile} is not authenticated to a workspace.`);
  }
  const resolved = runner.run('databricks', cliArgs(options, ['bundle', 'validate'], { json: true }), { json: true });
  resolved.workspace = { ...resolved.workspace, host: resolved.workspace?.host ?? auth.details.host };
  const facts = { ...bundleFacts(resolved), profile: options.profile };
  if (facts.target !== options.target) {
    throw new Error(`The CLI resolved target ${facts.target}, not ${options.target}.`);
  }
  if (resolved?.workspace?.profile != null && resolved.workspace.profile !== options.profile) {
    throw new Error(`The CLI resolved profile ${resolved.workspace.profile}, not ${options.profile}.`);
  }
  const planned = runner.run('databricks', cliArgs(options, ['bundle', 'plan'], { json: true }), { json: true });
  const plan = planFacts(planned);
  const output = linesFor(facts, plan, options.action);

  if (options.action === 'validate') {
    output.push('', schedule(runner, { ...options, apply: false }, facts));
    return { facts, plan, output };
  }

  const before = optionalApp(runner, options, facts.app);
  if (options.action === 'install' && before != null) {
    throw new Error(`App ${facts.app} already exists. Use upgrade so the current deployment is recorded first.`);
  }
  if (['upgrade', 'rollback', 'uninstall'].includes(options.action) && before == null) {
    throw new Error(`App ${facts.app} does not exist. Use install.`);
  }

  if (options.action === 'rollback') {
    const changes = appTreeChanges(runner);
    if (changes !== '') {
      throw new Error(`Rollback requires a clean app checkout; these paths differ from HEAD:\n${changes}`);
    }
    const current = gitAt(runner, 'HEAD');
    const wanted = gitAt(runner, options.to);
    if (current !== wanted) {
      throw new Error(`Rollback source mismatch: HEAD is ${current}, while ${options.to} resolves to ${wanted}.`);
    }
    if (options.apply && before?.active_deployment?.deployment_id !== options.fromDeployment) {
      throw new Error(
        `Rollback guard failed: active deployment is ${before?.active_deployment?.deployment_id ?? 'missing'}, ` +
          `not ${options.fromDeployment}.`
      );
    }
  }

  if (options.action === 'uninstall') {
    const summary = runner.run('databricks', cliArgs(options, ['bundle', 'summary'], { json: true }), { json: true });
    const scheduledRevocation = schedule(runner, { ...options, apply: false }, facts, true);
    const inventory = uninstallInventory(facts, summary, before, scheduledRevocation);
    output.push('', 'Will remove:', ...inventory.removes.map((one) => `  - ${one}`));
    output.push('', 'Will retain:', ...inventory.retains.map((one) => `  - ${one}`));
    output.push('', 'Scheduled identity revocation preview:', inventory.scheduledRevocation);
    const token = uninstallToken(facts, options.profile, inventory);
    output.push('', `Confirmation token: ${token}`);
    if (!options.apply) return { facts, plan, inventory, output };
    if (options.confirm !== token) throw new Error(`Refusing uninstall: pass --confirm ${token}.`);
    beforeMutation([...output]);
    output.push('', schedule(runner, options, facts, true));
    runner.run('databricks', cliArgs(options, ['bundle', 'destroy', '--auto-approve']));
    output.push('', 'Bundle resources removed. Retained resources above were not deleted.');
    return { facts, plan, inventory, output };
  }

  if (!options.apply) {
    output.push('', 'Dry run only. Re-run with --apply after reviewing the plan.');
    output.push(schedule(runner, { ...options, apply: false }, facts));
    return { facts, plan, output, before };
  }

  beforeMutation([...output]);
  runner.run('databricks', cliArgs(options, ['bundle', 'deploy', '--auto-approve', '--fail-on-active-runs']));
  const preRun = runner.run('databricks', ['apps', 'get', facts.app, '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  runner.run('databricks', cliArgs(options, ['bundle', 'run', facts.appKey]));
  const requested = waitForRequestedDeployment(runner, options, facts.app, preRun, deploymentPoll);
  output.push('', schedule(runner, options, facts));

  const afterPlan = runner.run('databricks', cliArgs(options, ['bundle', 'plan'], { json: true }), { json: true });
  if (!isIdempotent(afterPlan)) throw new Error('Post-deploy DAB plan is not idempotent.');
  const finalApp = runner.run('databricks', ['apps', 'get', facts.app, '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  const verified = verifyRequestedDeployment(finalApp, requested.deploymentId, facts);
  output.push(
    '',
    `Running deployment: ${verified.deploymentId}`,
    `URL: ${verified.url}`,
    'Second DAB plan: no changes.'
  );
  return { facts, plan, output, before, verified };
}

function main() {
  try {
    const options = parseLifecycleArgs(process.argv.slice(2));
    let reported = 0;
    const result = runLifecycle(options, undefined, (lines) => {
      console.log(lines.join('\n'));
      reported = lines.length;
    });
    const remaining = result.output.slice(reported);
    if (remaining.length > 0) console.log(`${reported > 0 ? '\n' : ''}${remaining.join('\n')}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) main();
