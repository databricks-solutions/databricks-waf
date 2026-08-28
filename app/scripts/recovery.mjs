// Backup, restore and recovery rehearsal for the Lakebase database bound by the DAB.
//
// The archive contains the App-owned `waf` schema only. The Lakebase project, branch, endpoint and
// database are customer infrastructure and stay outside the bundle, so this command resolves them
// from the same explicit profile/target as `lifecycle.mjs` and refuses to act on an ambient database.

import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  openSync,
  readSync,
  linkSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { bundleFacts, commandEnvironment } from './lifecycle.mjs';

const ACTIONS = new Set(['backup', 'restore', 'cleanup']);
const DATABASE_ENV = [
  'LAKEBASE_ENDPOINT',
  'PGAPPNAME',
  'PGDATABASE',
  'PGHOST',
  'PGHOSTADDR',
  'PGPASSWORD',
  'PGPASSFILE',
  'PGPORT',
  'PGSERVICE',
  'PGSERVICEFILE',
  'PGSSLMODE',
  'PGUSER',
  'WAF_PG_SCHEMA',
  'WAF_RECOVERY_APP_ROLE',
  'WAF_RECOVERY_EXPECTED',
  'WAF_RECOVERY_OWNER_ROLE',
];
const APP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPOSITORY = resolve(APP, '..');
const SCHEMA = 'waf';
const MANIFEST_VERSION = 1;

function valueAfter(argv, name) {
  const joined = argv.find((one) => one.startsWith(`${name}=`));
  if (joined != null) return joined.slice(name.length + 1).trim();
  const at = argv.indexOf(name);
  if (at === -1) return undefined;
  const value = argv[at + 1]?.trim();
  return value == null || value === '' || value.startsWith('--') ? undefined : value;
}

export function parseRecoveryArgs(argv) {
  const action = argv[0];
  if (!ACTIONS.has(action)) throw new Error(`Choose one recovery action: ${[...ACTIONS].join(', ')}.`);
  const profile = valueAfter(argv, '--profile');
  const target = valueAfter(argv, '--target');
  const archive = valueAfter(argv, '--archive');
  if (profile == null) throw new Error('--profile is required; recovery never selects a workspace for you.');
  if (target == null) throw new Error('--target is required; recovery resolves the database from the DAB.');
  if (archive == null) throw new Error('--archive is required and must be an absolute path outside the checkout.');

  const apply = argv.includes('--apply');
  const plaintext = argv.includes('--plaintext-ok');
  const recipient = valueAfter(argv, '--gpg-recipient');
  const retainUntil = valueAfter(argv, '--retain-until');
  const databaseId = valueAfter(argv, '--database-id');
  const confirm = valueAfter(argv, '--confirm');
  const expected = {
    result: valueAfter(argv, '--expect-result'),
    review: valueAfter(argv, '--expect-review'),
    action: valueAfter(argv, '--expect-action'),
    publication: valueAfter(argv, '--expect-publication'),
  };

  if (action === 'backup') {
    if (retainUntil == null) throw new Error('backup requires --retain-until YYYY-MM-DD.');
    if (Number(plaintext) + Number(recipient != null) !== 1) {
      throw new Error('backup requires exactly one of --gpg-recipient <key> or --plaintext-ok.');
    }
    if (databaseId != null || confirm != null) {
      throw new Error('--database-id and --confirm do not belong to backup.');
    }
  } else {
    if (databaseId == null) throw new Error(`${action} requires --database-id <new-recovery-database-id>.`);
    if (retainUntil != null || recipient != null || plaintext) {
      throw new Error('--retain-until, --gpg-recipient and --plaintext-ok belong only to backup.');
    }
    if (Object.values(expected).some((one) => one != null)) {
      throw new Error('Expected record ids are stored by backup and cannot be replaced during restore or cleanup.');
    }
    if (action !== 'cleanup' && confirm != null) throw new Error('--confirm belongs only to cleanup.');
  }

  return {
    action,
    profile,
    target,
    archive,
    apply,
    plaintext,
    recipient,
    retainUntil,
    databaseId,
    confirm,
    expected: compact(expected),
  };
}

export function parseDatabaseResource(name) {
  const matched = /^(projects\/[a-z0-9-]+\/branches\/[a-z0-9-]+)\/databases\/([a-z0-9-]+)$/.exec(name);
  if (matched == null) {
    throw new Error(`Lakebase database ${name} is not an Autoscaling database resource name.`);
  }
  return { branch: matched[1], databaseId: matched[2] };
}

export function cleanupToken(
  context,
  manifest,
  databaseResource,
  recoveryOwnerResource,
  recoveryDatabasePresent = true
) {
  const recoveryOwner = recoveryOwnerRole(databaseResource.split('/').at(-1));
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        host: context.host,
        profile: context.profile,
        target: context.target,
        source: context.database,
        recovery: databaseResource,
        recoveryDatabasePresent,
        recoveryOwner,
        recoveryOwnerResource: recoveryOwnerResource ?? null,
        archive: manifest.archive.sha256,
      })
    )
    .digest('hex');
  return `delete-recovery:${databaseResource.split('/').at(-1)}:${digest}`;
}

export class RecoveryRunner {
  run(command, args, { json = false, allow = [0], env = {}, cwd = APP } = {}) {
    const inherited = commandEnvironment({}, process.env);
    for (const name of DATABASE_ENV) delete inherited[name];
    const answer = spawnSync(command, args, {
      cwd,
      env: { ...inherited, ...env },
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
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

export function runRecovery(options, runner = new RecoveryRunner(), beforeMutation = () => {}) {
  const archive = archivePaths(options.archive);
  const context = resolveContext(options, runner);
  const output = contextLines(context, options.action, archive);

  if (options.action === 'backup') return backup(options, runner, context, archive, output, beforeMutation);

  const manifest = loadManifest(archive.manifest);
  verifyArchive(archive.path, manifest);
  if (manifest.source.schema !== SCHEMA) throw new Error(`Archive schema is ${manifest.source.schema}, not ${SCHEMA}.`);
  verifyManifestSource(manifest, context);
  const targetResource = `${context.branch}/databases/${validatedDatabaseId(options.databaseId)}`;
  if (targetResource === context.database)
    throw new Error('Recovery target resolves to the currently bound source database.');

  if (options.action === 'restore') {
    return restore(options, runner, context, archive, manifest, targetResource, output, beforeMutation);
  }
  return cleanup(options, runner, context, archive, manifest, targetResource, output, beforeMutation);
}

function backup(options, runner, context, archive, output, beforeMutation) {
  validateRetention(options.retainUntil);
  requireNewArchive(archive);
  const parent = secureParent(archive.path);
  const source = databaseContext(runner, options, context.database, context.appClientId);
  output.push(
    `Source database: ${source.resource}`,
    `PostgreSQL database: ${source.database}`,
    `Endpoint: ${source.endpoint}`,
    `Schema: ${SCHEMA}`,
    `Archive: ${archive.path}`,
    `Manifest: ${archive.manifest}`,
    `Retain until: ${options.retainUntil}`,
    options.recipient == null
      ? 'Encryption: plaintext explicitly accepted; directory is private and files are mode 0600'
      : `Encryption: GPG recipient ${options.recipient}`
  );

  const before = inspect(runner, options, source, context.expectedRole, options.expected);
  output.push(`Source inspection: ${before.tables.length} tables, digest ${before.schemaDigest}.`);
  if (!options.apply) {
    output.push('', 'Dry run only. Re-run with --apply after reviewing this source and destination.');
    return { context, source, inspection: before, output };
  }

  beforeMutation([...output]);
  const temporary = join(parent, `.${archive.basename}.${randomUUID()}.pgcustom`);
  const encrypted = `${temporary}.gpg`;
  try {
    const env = databaseEnvironment(runner, options, source, true);
    runner.run(
      'pg_dump',
      [
        '--format=custom',
        '--compress=6',
        '--no-owner',
        '--no-privileges',
        '--serializable-deferrable',
        `--schema=${SCHEMA}`,
        `--file=${temporary}`,
      ],
      { env }
    );
    chmodSync(temporary, 0o600);
    runner.run('pg_restore', ['--list', temporary]);
    const after = inspect(runner, options, source, context.expectedRole, options.expected);
    const stable = before.schemaDigest === after.schemaDigest;

    let completed = temporary;
    let encryption = { kind: 'none' };
    if (options.recipient != null) {
      runner.run('gpg', [
        '--batch',
        '--yes',
        '--encrypt',
        '--recipient',
        options.recipient,
        '--output',
        encrypted,
        temporary,
      ]);
      chmodSync(encrypted, 0o600);
      completed = encrypted;
      encryption = { kind: 'gpg', recipient: options.recipient };
    }
    publishFile(completed, archive.path);

    const manifest = {
      version: MANIFEST_VERSION,
      createdAt: new Date().toISOString(),
      retainUntil: options.retainUntil,
      source: {
        workspaceHost: context.host,
        bundle: context.bundle,
        target: context.target,
        branch: context.branch,
        database: context.database,
        postgresDatabase: source.database,
        endpoint: source.endpoint,
        schema: SCHEMA,
        actor: context.actor,
        app: context.app,
        appRole: context.expectedRole,
      },
      expectations: options.expected,
      acceptanceExpectationSetComplete: expectationSetComplete(options.expected),
      consistency: {
        kind: 'pg_dump single-transaction snapshot',
        sourceStableAcrossArchive: stable,
        beforeDigest: before.schemaDigest,
        afterDigest: after.schemaDigest,
      },
      sourceInspection: stable ? after : undefined,
      archive: {
        format: 'postgres-custom',
        sha256: fileDigest(archive.path),
        bytes: lstatSync(archive.path).size,
        encryption,
      },
      durableUnityCatalogArtifacts: [],
    };
    writePrivateJson(archive.manifest, manifest);
    output.push(
      '',
      `Backup written: ${archive.path}`,
      `Archive SHA-256: ${manifest.archive.sha256}`,
      stable
        ? `Source was stable across the archive; schema digest ${after.schemaDigest}.`
        : 'Source changed while the archive was taken; the archive is consistent, but it cannot prove equality to either adjacent inspection.',
      expectationSetComplete(options.expected)
        ? `The manifest names the final assessment, review and action required by the 108b rehearsal.${options.expected.publication == null ? ' No closed-month publication was available on this fresh installation.' : ' It also names a closed-month publication.'}`
        : 'This is an operational backup, not complete 108b rehearsal evidence: the final assessment, review or action was not supplied.'
    );
    return { context, source, manifest, output };
  } catch (error) {
    if (!existsSync(archive.manifest) && existsSync(archive.path)) unlinkSync(archive.path);
    throw error;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    if (existsSync(encrypted)) unlinkSync(encrypted);
  }
}

function restore(options, runner, context, archive, manifest, targetResource, output, beforeMutation) {
  const existing = databases(runner, options, context.branch).find((one) => one.name === targetResource);
  if (existing != null)
    throw new Error(`Recovery database ${targetResource} already exists; restore requires an empty new target.`);
  const receiptPath = restoreReceipt(archive.path, options.databaseId);
  if (existsSync(receiptPath)) {
    throw new Error(`Restore receipt ${receiptPath} already exists; recovery evidence is never overwritten.`);
  }
  const roles = roleContext(runner, options, context.branch, context.appClientId);
  const postgresDatabase = postgresDatabaseName(options.databaseId);
  const recoveryOwner = recoveryOwnerRole(options.databaseId);
  output.push(
    `Source archive: ${archive.path}`,
    `Archive SHA-256: ${manifest.archive.sha256}`,
    `Will create empty database: ${targetResource}`,
    `Will restore schema: ${SCHEMA}`,
    `PostgreSQL database name: ${postgresDatabase}`,
    `Database owner: ${roles.appRoleResource}`,
    `Restored-object owner: ${recoveryOwner} (shared only with the operator and App role ${roles.appRole})`,
    `Original database retained: ${context.database}`
  );
  if (!options.apply) {
    output.push('', 'Dry run only. Re-run with --apply to create and restore this new database.');
    return { context, manifest, targetResource, output };
  }

  beforeMutation([...output]);
  let created = false;
  const plain = temporaryArchive(runner, archive, manifest);
  try {
    runner.run(
      'databricks',
      [
        'postgres',
        'create-database',
        context.branch,
        '--json',
        JSON.stringify({
          spec: {
            postgres_database: postgresDatabase,
            role: roles.appRoleResource,
          },
        }),
        '--database-id',
        options.databaseId,
        '--profile',
        options.profile,
        '-o',
        'json',
      ],
      { json: true }
    );
    created = true;
    const target = databaseContext(runner, options, targetResource, context.appClientId);
    if (!databaseIsEmpty(runner, options, target)) {
      throw new Error(`New recovery database ${targetResource} is not empty; it was not restored.`);
    }
    runner.run(
      'psql',
      [
        '--no-psqlrc',
        '--set',
        'ON_ERROR_STOP=on',
        '--single-transaction',
        '--command',
        `create role ${quoteIdentifier(recoveryOwner)} nologin; grant ${quoteIdentifier(recoveryOwner)} to current_user; grant ${quoteIdentifier(recoveryOwner)} to ${quoteIdentifier(roles.appRole)};`,
      ],
      { env: databaseEnvironment(runner, options, target, true) }
    );
    const recoveryOwnerResource = requireRecoveryOwnerResource(runner, options, context.branch, recoveryOwner);
    runner.run(
      'databricks',
      [
        'postgres',
        'update-database',
        targetResource,
        'spec.role',
        '--json',
        JSON.stringify({ spec: { role: recoveryOwnerResource } }),
        '--profile',
        options.profile,
        '-o',
        'json',
      ],
      { json: true }
    );
    const ownedTarget = databaseContext(runner, options, targetResource, context.appClientId);
    if (ownedTarget.ownerRoleResource !== recoveryOwnerResource) {
      throw new Error(
        `Recovery database owner is ${String(ownedTarget.ownerRoleResource)}, not ${recoveryOwnerResource}.`
      );
    }
    runner.run(
      'pg_restore',
      [
        '--single-transaction',
        '--exit-on-error',
        '--no-owner',
        '--no-privileges',
        '--role',
        recoveryOwner,
        '--dbname',
        ownedTarget.database,
        plain.path,
      ],
      { env: databaseEnvironment(runner, options, ownedTarget, true) }
    );
    const inspection = inspect(runner, options, ownedTarget, ownedTarget.appRole, manifest.expectations, recoveryOwner);
    if (
      manifest.consistency.sourceStableAcrossArchive === true &&
      manifest.sourceInspection?.schemaDigest !== inspection.schemaDigest
    ) {
      throw new Error(
        `Restored schema digest ${inspection.schemaDigest} differs from stable source digest ${manifest.sourceInspection?.schemaDigest}.`
      );
    }
    const receipt = {
      version: 1,
      restoredAt: new Date().toISOString(),
      archiveSha256: manifest.archive.sha256,
      sourceDatabase: manifest.source.database,
      targetDatabase: ownedTarget.resource,
      targetPostgresDatabase: ownedTarget.database,
      targetEndpoint: ownedTarget.endpoint,
      recoveryOwner,
      recoveryOwnerResource,
      sourceDatabaseRetained: context.database,
      inspection,
      acceptanceExpectationSetComplete: manifest.acceptanceExpectationSetComplete === true,
    };
    writePrivateJson(receiptPath, receipt);
    output.push(
      '',
      `Restore verified: ${ownedTarget.resource}`,
      `Receipt: ${receiptPath}`,
      `Schema digest: ${inspection.schemaDigest}`,
      `Stored record digests: intact across ${inspection.records.tables.length} record tables.`,
      `App-effective ownership: ${inspection.ownership.database} through ${inspection.ownership.schema}.`,
      'The original database was not changed. Follow the runbook to bind the prior App commit to this recovery database.'
    );
    return { context, manifest, target: ownedTarget, inspection, receipt, receiptPath, output };
  } catch (error) {
    if (created) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)} Recovery database ${targetResource} was retained for inspection; use cleanup with its confirmation token.`
      );
    }
    throw error;
  } finally {
    plain.remove();
  }
}

function cleanup(options, runner, context, archive, manifest, targetResource, output, beforeMutation) {
  const target = databases(runner, options, context.branch).find((one) => one.name === targetResource);
  const recoveryOwner = recoveryOwnerRole(options.databaseId);
  const recoveryOwnerResource = optionalRecoveryOwnerResource(runner, options, context.branch, recoveryOwner);
  if (target == null && recoveryOwnerResource == null) {
    throw new Error(`Neither recovery database ${targetResource} nor owner role ${recoveryOwner} exists.`);
  }
  const token = cleanupToken(context, manifest, targetResource, recoveryOwnerResource, target != null);
  output.push(
    target == null
      ? `Recovery database is already absent: ${targetResource}`
      : `Will delete recovery database: ${targetResource}`,
    recoveryOwnerResource == null
      ? `Recovery owner role is absent: ${recoveryOwner}`
      : `Will delete recovery owner role after its database: ${recoveryOwnerResource} (${recoveryOwner})`,
    `Will retain source database: ${context.database}`,
    `Will retain archive through the recorded date ${manifest.retainUntil}: ${archive.path}`,
    `Confirmation token: ${token}`
  );
  if (!options.apply) return { context, manifest, targetResource, token, output };
  if (options.confirm !== token) throw new Error(`Refusing cleanup: pass --confirm ${token}.`);
  beforeMutation([...output]);
  if (target != null) {
    runner.run('databricks', ['postgres', 'delete-database', targetResource, '--profile', options.profile]);
  }
  if (recoveryOwnerResource != null) {
    runner.run('databricks', ['postgres', 'delete-role', recoveryOwnerResource, '--profile', options.profile]);
  }
  output.push(
    '',
    recoveryOwnerResource == null
      ? 'Recovery database deleted; no dedicated owner role existed. The source database and retained archive were not changed.'
      : 'Recovery database and its dedicated owner role deleted. The source database and retained archive were not changed.'
  );
  return { context, manifest, targetResource, token, output };
}

function resolveContext(options, runner) {
  const auth = runner.run('databricks', ['auth', 'describe', '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  if (auth?.status !== 'success' || typeof auth?.details?.host !== 'string') {
    throw new Error(`Profile ${options.profile} is not authenticated to a workspace.`);
  }
  const resolved = runner.run(
    'databricks',
    ['bundle', 'validate', '--profile', options.profile, '--target', options.target, '-o', 'json'],
    { json: true }
  );
  resolved.workspace = { ...resolved.workspace, host: resolved.workspace?.host ?? auth.details.host };
  const facts = bundleFacts(resolved);
  if (facts.target !== options.target)
    throw new Error(`The CLI resolved target ${facts.target}, not ${options.target}.`);
  if (resolved?.workspace?.profile != null && resolved.workspace.profile !== options.profile) {
    throw new Error(`The CLI resolved profile ${resolved.workspace.profile}, not ${options.profile}.`);
  }
  const parsed = parseDatabaseResource(facts.postgresDatabase);
  if (facts.postgresBranch !== parsed.branch) {
    throw new Error(
      `The DAB database ${facts.postgresDatabase} is outside its declared branch ${facts.postgresBranch}.`
    );
  }
  const app = runner.run('databricks', ['apps', 'get', facts.app, '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  const appClientId = app?.service_principal_client_id;
  if (typeof appClientId !== 'string' || appClientId.trim() === '') {
    throw new Error(`App ${facts.app} has no reported service-principal client id.`);
  }
  const roles = roleContext(runner, options, parsed.branch, appClientId);
  return {
    bundle: facts.bundle,
    target: facts.target,
    profile: options.profile,
    host: facts.host,
    actor: facts.actor,
    app: facts.app,
    appClientId,
    expectedRole: roles.appRole,
    appRoleResource: roles.appRoleResource,
    branch: parsed.branch,
    database: facts.postgresDatabase,
  };
}

function databaseContext(runner, options, resource, appClientId) {
  const parsed = parseDatabaseResource(resource);
  const endpoint = endpoints(runner, options, parsed.branch).find(
    (one) => one?.status?.endpoint_type === 'ENDPOINT_TYPE_READ_WRITE'
  );
  if (endpoint == null || typeof endpoint?.status?.hosts?.host !== 'string') {
    throw new Error(`Branch ${parsed.branch} has no reported read-write endpoint host.`);
  }
  const database = databases(runner, options, parsed.branch).find((one) => one.name === resource);
  if (database == null || typeof database?.status?.postgres_database !== 'string') {
    throw new Error(`Database resource ${resource} does not exist or has no PostgreSQL name.`);
  }
  const actor = runner.run('databricks', ['current-user', 'me', '--profile', options.profile, '-o', 'json'], {
    json: true,
  });
  if (typeof actor?.userName !== 'string' || actor.userName.trim() === '') {
    throw new Error('The selected profile has no reported userName for PostgreSQL authentication.');
  }
  const roles = roleContext(runner, options, parsed.branch, appClientId);
  return {
    resource,
    branch: parsed.branch,
    databaseId: parsed.databaseId,
    database: database.status.postgres_database,
    endpoint: endpoint.name,
    host: endpoint.status.hosts.host,
    port: 5432,
    user: actor.userName,
    appRole: roles.appRole,
    ownerRoleResource: database.status.role,
  };
}

function endpoints(runner, options, branch) {
  const answer = runner.run(
    'databricks',
    ['postgres', 'list-endpoints', branch, '--profile', options.profile, '-o', 'json'],
    {
      json: true,
    }
  );
  return Array.isArray(answer) ? answer : [];
}

function databases(runner, options, branch) {
  const answer = runner.run(
    'databricks',
    ['postgres', 'list-databases', branch, '--profile', options.profile, '-o', 'json'],
    {
      json: true,
    }
  );
  return Array.isArray(answer) ? answer : [];
}

function roleContext(runner, options, branch, appClientId) {
  const roles = postgresRoles(runner, options, branch);
  const app = roles.find((one) => one?.status?.postgres_role === appClientId);
  const appRole = app?.status?.postgres_role;
  const appRoleResource = app?.name;
  if (typeof appRole !== 'string' || appRole.trim() === '') {
    throw new Error(`Branch ${branch} has no PostgreSQL role for App service principal ${appClientId}.`);
  }
  if (typeof appRoleResource !== 'string' || !appRoleResource.startsWith(`${branch}/roles/`)) {
    throw new Error(`Branch ${branch} reports no valid role resource for App service principal ${appClientId}.`);
  }
  return { appRole, appRoleResource };
}

function postgresRoles(runner, options, branch) {
  const answer = runner.run(
    'databricks',
    ['postgres', 'list-roles', branch, '--profile', options.profile, '-o', 'json'],
    {
      json: true,
    }
  );
  return Array.isArray(answer) ? answer : [];
}

function optionalRecoveryOwnerResource(runner, options, branch, recoveryOwner) {
  const matches = postgresRoles(runner, options, branch).filter(
    (one) => one?.status?.postgres_role === recoveryOwner && one?.status?.auth_method === 'NO_LOGIN'
  );
  if (matches.length > 1) throw new Error(`Branch ${branch} reports more than one role named ${recoveryOwner}.`);
  const resource = matches[0]?.name;
  if (resource == null) return undefined;
  if (typeof resource !== 'string' || !resource.startsWith(`${branch}/roles/`)) {
    throw new Error(`Branch ${branch} reports an invalid resource for recovery owner ${recoveryOwner}.`);
  }
  return resource;
}

function requireRecoveryOwnerResource(runner, options, branch, recoveryOwner) {
  const resource = optionalRecoveryOwnerResource(runner, options, branch, recoveryOwner);
  if (resource == null) throw new Error(`Lakebase did not report the created recovery owner ${recoveryOwner}.`);
  return resource;
}

function databaseEnvironment(runner, options, context, password) {
  const env = {
    DATABRICKS_CONFIG_PROFILE: options.profile,
    LAKEBASE_ENDPOINT: context.endpoint,
    PGAPPNAME: 'databricks-waf-recovery',
    PGDATABASE: context.database,
    PGHOST: context.host,
    PGPORT: String(context.port),
    PGSSLMODE: 'require',
    PGUSER: context.user,
    WAF_PG_SCHEMA: SCHEMA,
  };
  if (!password) return env;
  const credential = runner.run(
    'databricks',
    ['postgres', 'generate-database-credential', context.endpoint, '--profile', options.profile, '-o', 'json'],
    { json: true }
  );
  if (typeof credential?.token !== 'string' || credential.token === '') {
    throw new Error(`Lakebase returned no database credential for ${context.endpoint}.`);
  }
  return { ...env, PGPASSWORD: credential.token };
}

function inspect(runner, options, database, appRole, expected, recoveryOwner) {
  return runner.run('node', ['--import', 'tsx', 'scripts/recovery-inspect.mts'], {
    json: true,
    env: {
      ...databaseEnvironment(runner, options, database, false),
      WAF_RECOVERY_APP_ROLE: appRole,
      WAF_RECOVERY_EXPECTED: JSON.stringify(expected),
      ...(recoveryOwner == null ? {} : { WAF_RECOVERY_OWNER_ROLE: recoveryOwner }),
    },
  });
}

function databaseIsEmpty(runner, options, database) {
  const answer = runner
    .run(
      'psql',
      [
        '--no-psqlrc',
        '--tuples-only',
        '--no-align',
        '--set',
        'ON_ERROR_STOP=on',
        '--command',
        `select (select count(*) from information_schema.tables where table_schema not in ('pg_catalog','information_schema')) + (select count(*) from pg_namespace where nspname = '${SCHEMA}')`,
      ],
      { env: databaseEnvironment(runner, options, database, true) }
    )
    .trim();
  return answer === '0';
}

function archivePaths(raw) {
  if (!isAbsolute(raw)) throw new Error('--archive must be an absolute path.');
  const path = resolve(raw);
  const inside = relative(REPOSITORY, path);
  if (inside === '' || (!inside.startsWith('..') && !isAbsolute(inside))) {
    throw new Error('Recovery archives may not be written inside the repository checkout.');
  }
  return { path, manifest: `${path}.manifest.json`, basename: path.split('/').at(-1) };
}

function secureParent(path) {
  const parent = realpathSync(dirname(path));
  const mode = lstatSync(parent).mode & 0o777;
  if ((mode & 0o077) !== 0) {
    throw new Error(`Archive directory ${parent} must not grant group or other access; use chmod 700.`);
  }
  return parent;
}

function requireNewArchive(archive) {
  if (existsSync(archive.path) || existsSync(archive.manifest)) {
    throw new Error(`Archive or manifest already exists at ${archive.path}; backups never overwrite evidence.`);
  }
}

function publishFile(source, destination) {
  linkSync(source, destination);
  chmodSync(destination, 0o600);
  unlinkSync(source);
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}

function loadManifest(path) {
  if (!existsSync(path)) throw new Error(`Recovery manifest ${path} does not exist.`);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  if (manifest?.version !== MANIFEST_VERSION) {
    throw new Error(`Recovery manifest version is ${String(manifest?.version)}, not ${String(MANIFEST_VERSION)}.`);
  }
  return manifest;
}

function verifyManifestSource(manifest, context) {
  const expected = {
    workspaceHost: context.host,
    bundle: context.bundle,
    target: context.target,
    branch: context.branch,
    database: context.database,
  };
  for (const [field, value] of Object.entries(expected)) {
    if (manifest?.source?.[field] !== value) {
      throw new Error(
        `Recovery manifest source ${field} is ${String(manifest?.source?.[field])}, not selected DAB value ${value}.`
      );
    }
  }
}

function verifyArchive(path, manifest) {
  if (!existsSync(path)) throw new Error(`Recovery archive ${path} does not exist.`);
  const actual = fileDigest(path);
  if (actual !== manifest?.archive?.sha256) {
    throw new Error(`Recovery archive SHA-256 is ${actual}, not manifest value ${String(manifest?.archive?.sha256)}.`);
  }
}

function temporaryArchive(runner, archive, manifest) {
  if (manifest.archive.encryption?.kind === 'none') {
    runner.run('pg_restore', ['--list', archive.path]);
    return { path: archive.path, remove: () => undefined };
  }
  if (manifest.archive.encryption?.kind !== 'gpg') {
    throw new Error(`Unsupported archive encryption ${String(manifest.archive.encryption?.kind)}.`);
  }
  const path = join(dirname(archive.path), `.${archive.basename}.${randomUUID()}.decrypted`);
  try {
    runner.run('gpg', ['--batch', '--decrypt', '--output', path, archive.path]);
    chmodSync(path, 0o600);
    runner.run('pg_restore', ['--list', path]);
    return { path, remove: () => existsSync(path) && unlinkSync(path) };
  } catch (error) {
    if (existsSync(path)) unlinkSync(path);
    throw error;
  }
}

function fileDigest(path) {
  const hash = createHash('sha256');
  const descriptor = openSync(path, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    for (;;) {
      const read = readSync(descriptor, buffer, 0, buffer.length, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    closeSync(descriptor);
  }
  return hash.digest('hex');
}

function restoreReceipt(archive, databaseId) {
  return `${archive}.restore-${databaseId}.json`;
}

function validatedDatabaseId(raw) {
  if (!/^[a-z][a-z0-9-]{3,62}$/.test(raw ?? '')) {
    throw new Error(
      'Recovery database id must be 4-63 characters, start with a lowercase letter and contain only lowercase letters, digits and hyphens.'
    );
  }
  return raw;
}

function postgresDatabaseName(databaseId) {
  return validatedDatabaseId(databaseId).replaceAll('-', '_');
}

function recoveryOwnerRole(databaseId) {
  const digest = createHash('sha256').update(validatedDatabaseId(databaseId)).digest('hex').slice(0, 16);
  return `waf_recovery_owner_${digest}`;
}

function validateRetention(raw) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw ?? '')) throw new Error('--retain-until must be YYYY-MM-DD.');
  const until = new Date(`${raw}T23:59:59.999Z`);
  if (!Number.isFinite(until.getTime()) || until <= new Date()) {
    throw new Error('--retain-until must be a real future UTC date.');
  }
}

function expectationSetComplete(expected) {
  return ['result', 'review', 'action'].every((key) => typeof expected[key] === 'string');
}

function contextLines(context, action, archive) {
  return [
    `${action} ${context.bundle} recovery data on ${context.host}`,
    `Actor: ${context.actor}`,
    `Target/profile: ${context.target} / ${context.profile}`,
    `App: ${context.app}`,
    `Current DAB database: ${context.database}`,
    `Archive path: ${archive.path}`,
  ];
}

function quoteIdentifier(value) {
  return `"${value.replace(/"/g, '""')}"`;
}

function compact(value) {
  return Object.fromEntries(Object.entries(value).filter(([, one]) => one != null));
}

function main() {
  try {
    const options = parseRecoveryArgs(process.argv.slice(2));
    let reported = 0;
    const result = runRecovery(options, undefined, (lines) => {
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
