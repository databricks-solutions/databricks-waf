import { describe, expect, it } from 'vitest';
import {
  bundleFacts,
  commandEnvironment,
  isIdempotent,
  parseLifecycleArgs,
  runLifecycle,
  uninstallInventory,
  uninstallToken,
  verifyDeployment,
} from './lifecycle.mjs';

const scopes = [
  'sql.statement-execution',
  'sql.warehouses:read',
  'catalog.catalogs:read',
  'catalog.schemas:read',
  'catalog.tables:read',
  'model-serving',
  'vector-search',
  'sql.query-history:read',
];

const resolved = {
  bundle: { name: 'waf-assessment', target: 'customer' },
  workspace: {
    host: 'https://customer.cloud.databricks.com',
    profile: 'customer-profile',
    root_path: '/Workspace/Users/operator/.bundle/waf-assessment/customer',
    current_user: { userName: 'operator@example.com' },
  },
  resources: {
    apps: {
      app: {
        name: 'databricks-waf-assessment',
        user_api_scopes: scopes,
        resources: [
          { name: 'sql-warehouse', sql_warehouse: { id: 'warehouse-1', permission: 'CAN_USE' } },
          {
            name: 'postgres',
            postgres: {
              branch: 'projects/waf/branches/production',
              database: 'projects/waf/branches/production/databases/databricks-postgres',
              permission: 'CAN_CONNECT_AND_CREATE',
            },
          },
        ],
      },
    },
    jobs: {
      scheduled_assessment: {
        name: 'Well-Architected assessment',
        schedule: { pause_status: 'PAUSED' },
      },
    },
  },
  variables: { schedule_client_id: { value: '' } },
};

const plan = {
  plan: {
    'resources.apps.app': { action: 'skip' },
    'resources.jobs.scheduled_assessment': { action: 'skip' },
  },
};

const deployed = {
  app_status: { state: 'RUNNING' },
  active_deployment: { deployment_id: 'deployment-new', status: { state: 'SUCCEEDED' } },
  url: 'https://waf.aws.databricksapps.com',
  effective_user_api_scopes: [...scopes, 'iam.access-control:read', 'iam.current-user:read'],
  resources: resolved.resources.apps.app.resources,
};

class FakeRunner {
  readonly calls: Array<{ command: string; args: string[] }> = [];
  app: unknown;
  appReads: unknown[] = [];
  changes = '';
  scheduleClient = '';
  readonly events?: string[];

  constructor(app?: unknown, events?: string[]) {
    this.app = app;
    this.events = events;
  }

  run(command: string, args: string[]) {
    this.calls.push({ command, args });
    this.events?.push(`command:${args.join(' ')}`);
    const words = args.join(' ');
    if (command === 'git' && words.includes('status --porcelain')) return this.changes;
    if (command === 'git' && words.includes('rev-parse')) return 'commit-old\n';
    if (words.startsWith('auth describe')) {
      return { status: 'success', details: { host: 'https://customer.cloud.databricks.com' } };
    }
    if (words.startsWith('bundle validate')) {
      return { ...resolved, variables: { schedule_client_id: { value: this.scheduleClient } } };
    }
    if (words.startsWith('bundle plan')) return plan;
    if (words.startsWith('bundle summary')) {
      return {
        resources: {
          apps: { app: { name: 'databricks-waf-assessment' } },
          jobs: { scheduled_assessment: { id: 'job-1', name: 'Well-Architected assessment' } },
        },
      };
    }
    if (words.startsWith('apps get')) {
      if (this.appReads.length > 0) this.app = this.appReads.shift();
      if (this.app == null) throw new Error('RESOURCE_DOES_NOT_EXIST: app does not exist');
      return this.app;
    }
    if (words.startsWith('bundle deploy')) return '';
    if (words.startsWith('bundle run')) {
      this.app = deployed;
      return '';
    }
    if (words.startsWith('bundle destroy')) return '';
    if (command === 'node' && words.startsWith('scripts/schedule-principal.mjs')) {
      return words.includes('--revoke') && !words.includes('--apply')
        ? 'Would revoke scheduled identity access.'
        : 'Revoked scheduled identity access.';
    }
    throw new Error(`Unexpected fake command: ${command} ${words}`);
  }
}

const options = {
  action: 'upgrade' as const,
  profile: 'customer-profile',
  target: 'customer',
  apply: false,
  confirm: undefined,
  to: undefined,
  fromDeployment: undefined,
  catalogs: undefined,
  sharing: false,
};

describe('lifecycle arguments', () => {
  it('requires the operator to choose both profile and target', () => {
    expect(() => parseLifecycleArgs(['validate'])).toThrow(/--profile is required/);
    expect(() => parseLifecycleArgs(['validate', '--profile', 'labs'])).toThrow(/--target is required/);
    expect(parseLifecycleArgs(['validate', '--profile=labs', '--target=default'])).toMatchObject({
      action: 'validate',
      profile: 'labs',
      target: 'default',
      apply: false,
    });
  });

  it('makes an applied rollback identify both source and the deployment being replaced', () => {
    expect(() =>
      parseLifecycleArgs(['rollback', '--profile', 'labs', '--target', 'default', '--apply', '--to', 'v1'])
    ).toThrow(/--from-deployment/);
    expect(
      parseLifecycleArgs([
        'rollback',
        '--profile',
        'labs',
        '--target',
        'default',
        '--apply',
        '--to',
        'v1',
        '--from-deployment',
        'deployment-2',
      ])
    ).toMatchObject({ to: 'v1', fromDeployment: 'deployment-2' });
  });
});

describe('workspace selection', () => {
  it('removes inherited workspace selectors before applying explicit lifecycle values', () => {
    const env = commandEnvironment(
      { DATABRICKS_CONFIG_PROFILE: 'labs', DATABRICKS_BUNDLE_TARGET: 'default' },
      {
        PATH: '/bin',
        DATABRICKS_HOST: 'https://wrong.example.com',
        DATABRICKS_TOKEN: 'wrong-token',
        DATABRICKS_CONFIG_PROFILE: 'wrong-profile',
      }
    );

    expect(env).toEqual({ PATH: '/bin', DATABRICKS_CONFIG_PROFILE: 'labs', DATABRICKS_BUNDLE_TARGET: 'default' });
  });
});

describe('resolved bundle facts', () => {
  it('names the external resources the bundle binds but does not own', () => {
    const facts = bundleFacts(resolved);
    expect(facts.warehouse).toBe('warehouse-1');
    expect(facts.postgresDatabase).toContain('databricks-postgres');
    expect(facts.schedulePaused).toBe(true);
  });

  it('refuses a half-configured clean clone before a deployment command is built', () => {
    const broken = structuredClone(resolved);
    broken.resources.apps.app.resources[1].postgres!.database = '';
    expect(() => bundleFacts(broken)).toThrow(/postgres_database/);
  });

  it('recognises a second no-change DAB plan as the idempotence proof', () => {
    expect(isIdempotent(plan)).toBe(true);
    expect(isIdempotent({ plan: { 'resources.apps.app': { action: 'update' } } })).toBe(false);
  });
});

describe('post-deploy verification', () => {
  it('holds runtime state, OBO scopes and both bindings against the resolved bundle', () => {
    expect(verifyDeployment(deployed, bundleFacts(resolved))).toEqual({
      deploymentId: 'deployment-new',
      url: 'https://waf.aws.databricksapps.com',
      appState: 'RUNNING',
      deploymentState: 'SUCCEEDED',
    });
  });

  it('catches the destructive app update case where an OBO scope disappeared', () => {
    const withoutQueryHistory = {
      ...deployed,
      effective_user_api_scopes: deployed.effective_user_api_scopes.filter((one) => one !== 'sql.query-history:read'),
    };
    expect(() => verifyDeployment(withoutQueryHistory, bundleFacts(resolved))).toThrow(/sql\.query-history:read/);
  });

  it('catches an unexpected effective OBO scope rather than accepting wider privilege', () => {
    expect(() =>
      verifyDeployment(
        { ...deployed, effective_user_api_scopes: [...deployed.effective_user_api_scopes, 'iam.users:write'] },
        bundleFacts(resolved)
      )
    ).toThrow(/unexpected effective scope: iam\.users:write/);
  });

  it('checks the permission carried by both bindings as well as their identity', () => {
    const wrongWarehouse = {
      ...deployed,
      resources: deployed.resources.map((resource) =>
        resource.name === 'sql-warehouse'
          ? { ...resource, sql_warehouse: { ...resource.sql_warehouse, permission: 'CAN_VIEW' } }
          : resource
      ),
    };
    const wrongPostgres = {
      ...deployed,
      resources: deployed.resources.map((resource) =>
        resource.name === 'postgres'
          ? { ...resource, postgres: { ...resource.postgres, permission: 'CAN_CONNECT' } }
          : resource
      ),
    };

    expect(() => verifyDeployment(wrongWarehouse, bundleFacts(resolved))).toThrow(/not CAN_USE/);
    expect(() => verifyDeployment(wrongPostgres, bundleFacts(resolved))).toThrow(/not CAN_CONNECT_AND_CREATE/);
  });
});

describe('mutating lifecycle operations', () => {
  it('makes upgrade a dry run until --apply is present', () => {
    const runner = new FakeRunner({
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    });
    const result = runLifecycle(options, runner);
    expect(result.output.join('\n')).toContain('Dry run only');
    expect(runner.calls.map((one) => one.args.join(' ')).join('\n')).not.toMatch(/bundle (deploy|run|destroy)/);
  });

  it('deploys, starts, verifies and proves a second plan is empty', () => {
    const before = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    };
    const runner = new FakeRunner(before);
    const result = runLifecycle({ ...options, apply: true }, runner);
    const commands = runner.calls.map((one) => one.args.join(' '));
    expect(commands).toContain(
      'bundle deploy --auto-approve --fail-on-active-runs --profile customer-profile --target customer'
    );
    expect(commands).toContain('bundle run app --profile customer-profile --target customer');
    expect(result.verified?.deploymentId).toBe('deployment-new');
    expect(commands.filter((one) => one.startsWith('bundle plan'))).toHaveLength(2);
  });

  it('makes an install wait for the first deployment requested by its App run', () => {
    const intermediate = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-from-bundle-deploy', status: { state: 'SUCCEEDED' } },
    };
    const pending = {
      ...intermediate,
      pending_deployment: { deployment_id: 'deployment-from-app-run', status: { state: 'IN_PROGRESS' } },
    };
    const active = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-from-app-run', status: { state: 'SUCCEEDED' } },
      pending_deployment: null,
    };
    const runner = new FakeRunner();
    runner.appReads = [undefined, intermediate, intermediate, pending, active];
    const pauses: number[] = [];

    const result = runLifecycle({ ...options, action: 'install', apply: true }, runner, () => {}, {
      attempts: 6,
      intervalMs: 17,
      pause: (milliseconds: number) => pauses.push(milliseconds),
    });

    expect(result.verified?.deploymentId).toBe('deployment-from-app-run');
    expect(result.output.join('\n')).toContain('Running deployment: deployment-from-app-run');
    expect(pauses).toEqual([17, 17]);
  });

  it('does not let the successful deployment created by bundle deploy satisfy the later App run', () => {
    const old = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    };
    const intermediate = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-intermediate', status: { state: 'SUCCEEDED' } },
      pending_deployment: {
        deployment_id: 'deployment-intermediate-pending',
        status: { state: 'IN_PROGRESS' },
      },
    };
    const intermediateSettled = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-intermediate-pending', status: { state: 'SUCCEEDED' } },
      pending_deployment: null,
    };
    const requested = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-requested', status: { state: 'SUCCEEDED' } },
    };
    const runner = new FakeRunner(old);
    runner.appReads = [old, intermediate, intermediateSettled, requested];

    const result = runLifecycle({ ...options, apply: true }, runner, () => {}, { attempts: 4, pause: () => {} });

    expect(result.verified?.deploymentId).toBe('deployment-requested');
  });

  it('refuses a failed deployment bound to this App run', () => {
    const old = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    };
    const failed = {
      ...old,
      pending_deployment: { deployment_id: 'deployment-failed', status: { state: 'FAILED' } },
    };
    const runner = new FakeRunner(old);
    runner.appReads = [old, old, failed];

    expect(() => runLifecycle({ ...options, apply: true }, runner, () => {}, { attempts: 2, pause: () => {} })).toThrow(
      /deployment-failed failed with state FAILED/
    );
    expect(runner.calls.map((one) => one.args.join(' ')).filter((one) => one.startsWith('bundle plan'))).toHaveLength(
      1
    );
  });

  it('refuses a different deployment that replaces the one bound to this App run', () => {
    const old = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    };
    const pending = {
      ...old,
      pending_deployment: { deployment_id: 'deployment-requested', status: { state: 'IN_PROGRESS' } },
    };
    const replaced = {
      ...old,
      pending_deployment: { deployment_id: 'deployment-concurrent', status: { state: 'IN_PROGRESS' } },
    };
    const runner = new FakeRunner(old);
    runner.appReads = [old, old, pending, replaced];

    expect(() => runLifecycle({ ...options, apply: true }, runner, () => {}, { attempts: 3, pause: () => {} })).toThrow(
      /replaced by deployment-concurrent/
    );
  });

  it('refuses a deployment that replaces the bound id after the initial successful join', () => {
    const old = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-old', status: { state: 'SUCCEEDED' } },
    };
    const requested = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-requested', status: { state: 'SUCCEEDED' } },
    };
    const replacementPending = {
      ...requested,
      pending_deployment: { deployment_id: 'deployment-concurrent', status: { state: 'IN_PROGRESS' } },
    };
    const runner = new FakeRunner(old);
    runner.appReads = [old, old, requested, replacementPending];

    expect(() => runLifecycle({ ...options, apply: true }, runner, () => {}, { attempts: 2, pause: () => {} })).toThrow(
      /deployment-requested did not remain the sole active deployment.*pending=deployment-concurrent:IN_PROGRESS/
    );
  });

  it('reports the pre-run ids and last App state when no requested deployment appears', () => {
    const intermediate = {
      ...deployed,
      active_deployment: { deployment_id: 'deployment-intermediate', status: { state: 'SUCCEEDED' } },
    };
    const runner = new FakeRunner(intermediate);
    runner.appReads = [intermediate, intermediate, intermediate, intermediate];

    expect(() => runLifecycle({ ...options, apply: true }, runner, () => {}, { attempts: 2, pause: () => {} })).toThrow(
      /Pre-run ids: deployment-intermediate.*Bound id: none.*active=deployment-intermediate:SUCCEEDED/
    );
  });

  it('lists exact removals and retained customer data before uninstall', () => {
    const facts = bundleFacts(resolved);
    const inventory = uninstallInventory(
      facts,
      {
        resources: {
          apps: { app: { name: facts.app } },
          jobs: { scheduled_assessment: { id: 'job-1', name: facts.job } },
        },
      },
      deployed,
      'Would revoke scheduled identity access.'
    );
    expect(inventory.removes).toContain('Lakeflow Job Well-Architected assessment (job-1)');
    expect(inventory.retains).toContain('all customer records in the bound Lakebase database');
    const token = uninstallToken(facts, 'customer-profile', inventory);
    expect(token).toMatch(/^destroy:waf-assessment:customer-profile:customer:databricks-waf-assessment:[a-f0-9]{64}$/);
    expect(uninstallToken({ ...facts, host: 'https://other.example.com' }, 'customer-profile', inventory)).not.toBe(
      token
    );
    expect(uninstallToken(facts, 'customer-profile', { ...inventory, deploymentId: 'deployment-other' })).not.toBe(
      token
    );
    expect(
      uninstallToken(facts, 'customer-profile', { ...inventory, scheduledRevocation: 'Would revoke something else.' })
    ).not.toBe(token);
  });

  it('prints the exact uninstall inventory before the first destructive command', () => {
    const facts = bundleFacts(resolved);
    const summary = {
      resources: {
        apps: { app: { name: facts.app } },
        jobs: { scheduled_assessment: { id: 'job-1', name: facts.job } },
      },
    };
    const inventory = uninstallInventory(facts, summary, deployed, 'Would revoke scheduled identity access.');
    const token = uninstallToken(facts, 'customer-profile', inventory);
    const events: string[] = [];
    const runner = new FakeRunner(deployed, events);
    runner.scheduleClient = '5af463d1-8cb9-4417-b2a5-725cea64cce5';

    runLifecycle({ ...options, action: 'uninstall', apply: true, confirm: token }, runner, (lines) =>
      events.push(`report:${lines.join('\n')}`)
    );

    const reportAt = events.findIndex((one) => one.startsWith('report:'));
    const revokeAt = events.findIndex(
      (one) => one.includes('scripts/schedule-principal.mjs') && one.includes('--revoke') && one.includes('--apply')
    );
    const destroyAt = events.findIndex((one) => one.includes('bundle destroy'));
    expect(events[reportAt]).toContain('Will remove:');
    expect(events[reportAt]).toContain('active deployment deployment-new');
    expect(events[reportAt]).toContain('Would revoke scheduled identity access.');
    expect(reportAt).toBeGreaterThanOrEqual(0);
    expect(revokeAt).toBeGreaterThan(reportAt);
    expect(destroyAt).toBeGreaterThan(reportAt);
  });

  it('refuses uninstall when either destructive resource identity is unknown', () => {
    const facts = bundleFacts(resolved);

    expect(() =>
      uninstallInventory(
        facts,
        { resources: { apps: { app: { name: facts.app } }, jobs: { scheduled_assessment: {} } } },
        deployed,
        'Would revoke scheduled identity access.'
      )
    ).toThrow(/inventory is incomplete/);
  });

  it('refuses rollback when app source differs from the named commit', () => {
    const runner = new FakeRunner(deployed);
    runner.changes = ' M server/server.ts';

    expect(() =>
      runLifecycle({ ...options, action: 'rollback', to: 'release-v1', fromDeployment: undefined }, runner)
    ).toThrow(/clean app checkout/);
    expect(runner.calls.map((one) => one.args.join(' ')).join('\n')).not.toContain('bundle deploy');
  });

  it('will not destroy the bundle when the confirmation names anything else', () => {
    const runner = new FakeRunner(deployed);
    expect(() =>
      runLifecycle({ ...options, action: 'uninstall', apply: true, confirm: 'destroy:wrong' }, runner)
    ).toThrow(/Refusing uninstall/);
    expect(runner.calls.map((one) => one.args.join(' ')).join('\n')).not.toContain('bundle destroy');
  });
});
