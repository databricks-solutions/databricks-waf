import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  cleanupToken,
  parseDatabaseResource,
  parseRecoveryArgs,
  runRecovery,
  type RecoveryOptions,
} from './recovery.mjs';

const branch = 'projects/waf-assessment/branches/production';
const sourceResource = `${branch}/databases/databricks-postgres`;
const sourceDatabase = {
  name: sourceResource,
  status: { database_id: 'databricks-postgres', postgres_database: 'databricks_postgres' },
};
const endpoint = {
  name: `${branch}/endpoints/primary`,
  status: {
    endpoint_type: 'ENDPOINT_TYPE_READ_WRITE',
    hosts: { host: 'ep-source.database.example.com' },
  },
};
const appClientId = '11111111-2222-3333-4444-555555555555';
const appRole = appClientId;
const appRoleResource = `${branch}/roles/dbrx-apps-${appClientId}`;
const recoveryOwner = `waf_recovery_owner_${createHash('sha256').update('recovery-test').digest('hex').slice(0, 16)}`;
const recoveryOwnerResource = `${branch}/roles/recovery-owner`;
const resolved = {
  bundle: { name: 'waf-assessment', target: 'default' },
  workspace: {
    host: 'https://customer.cloud.databricks.com',
    profile: 'labs',
    root_path: '/Workspace/Users/operator/.bundle/waf-assessment/default',
    current_user: { userName: 'operator@example.com' },
  },
  resources: {
    apps: {
      app: {
        name: 'databricks-waf-assessment',
        user_api_scopes: [],
        resources: [
          { name: 'sql-warehouse', sql_warehouse: { id: 'warehouse-1', permission: 'CAN_USE' } },
          {
            name: 'postgres',
            postgres: {
              branch,
              database: sourceResource,
              permission: 'CAN_CONNECT_AND_CREATE',
            },
          },
        ],
      },
    },
    jobs: { scheduled_assessment: { name: 'Well-Architected assessment', schedule: { pause_status: 'PAUSED' } } },
  },
  variables: { schedule_client_id: { value: '' } },
};
const inspection = {
  version: 1,
  schema: 'waf',
  owner: appRole,
  ownership: { database: appRole, schema: appRole, appCanSetOwner: true, relations: [] },
  schemaDigest: 'schema-digest-1',
  tables: [{ table: 'assessment_results', rows: 1, digest: 'table-digest-1' }],
  records: { intact: true, tables: [{ table: 'assessment_results', total: 1, checked: 1, intact: 1, unstamped: 0 }] },
  relationships: { constraints: [] },
  named: {},
};

class FakeRunner {
  readonly calls: Array<{ command: string; args: string[]; env?: Record<string, string> }> = [];
  readonly inspections: unknown[];
  created = false;
  deleted = false;
  roleCreated = false;
  roleDeleted = false;
  targetDatabase = {
    name: `${branch}/databases/recovery-test`,
    status: {
      database_id: 'recovery-test',
      postgres_database: 'recovery_test',
      role: appRoleResource,
    },
  };

  constructor(inspections: unknown[] = [inspection, inspection]) {
    this.inspections = [...inspections];
  }

  run(command: string, args: string[], options: { env?: Record<string, string> } = {}): unknown {
    this.calls.push({ command, args, ...(options.env == null ? {} : { env: options.env }) });
    const words = args.join(' ');
    if (words.startsWith('auth describe')) {
      return { status: 'success', details: { host: 'https://customer.cloud.databricks.com' } };
    }
    if (words.startsWith('bundle validate')) return structuredClone(resolved);
    if (words.startsWith('apps get')) return { service_principal_client_id: appClientId };
    if (words.startsWith('postgres list-roles')) {
      return [
        { name: appRoleResource, status: { postgres_role: appRole, identity_type: 'SERVICE_PRINCIPAL' } },
        ...(this.roleCreated
          ? [
              {
                name: recoveryOwnerResource,
                status: { postgres_role: recoveryOwner, auth_method: 'NO_LOGIN' },
              },
            ]
          : []),
      ];
    }
    if (words.startsWith('postgres list-endpoints')) return [endpoint];
    if (words.startsWith('postgres list-databases')) {
      return this.created ? [sourceDatabase, this.targetDatabase] : [sourceDatabase];
    }
    if (words.startsWith('current-user me')) return { userName: 'operator@example.com' };
    if (words.startsWith('postgres generate-database-credential')) return { token: 'fake-secret-token' };
    if (command === 'node' && words.includes('recovery-inspect.mts')) return this.inspections.shift() ?? inspection;
    if (command === 'pg_dump') {
      const path = args.find((one) => one.startsWith('--file='))?.slice('--file='.length);
      if (path == null) throw new Error('fake pg_dump received no file');
      writeFileSync(path, 'fake postgres custom archive', { mode: 0o600 });
      return '';
    }
    if (command === 'pg_restore') return '';
    if (command === 'psql' && words.includes('information_schema.tables')) return '0\n';
    if (command === 'psql' && words.includes('create role')) {
      this.roleCreated = true;
      return '';
    }
    if (words.startsWith('postgres create-database')) {
      this.created = true;
      return this.targetDatabase;
    }
    if (words.startsWith('postgres update-database')) {
      this.targetDatabase.status = { ...this.targetDatabase.status, role: recoveryOwnerResource };
      return this.targetDatabase;
    }
    if (words.startsWith('postgres delete-database')) {
      this.deleted = true;
      this.created = false;
      return '';
    }
    if (words.startsWith('postgres delete-role')) {
      this.roleCreated = false;
      this.roleDeleted = true;
      return '';
    }
    throw new Error(`Unexpected fake command: ${command} ${words}`);
  }
}

const temporary: string[] = [];
afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

function privateDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), 'waf-recovery-test-'));
  chmodSync(path, 0o700);
  temporary.push(path);
  return path;
}

function futureDate(): string {
  return new Date(Date.now() + 86_400_000 * 30).toISOString().slice(0, 10);
}

function backupOptions(archive: string, apply = false): RecoveryOptions {
  return {
    action: 'backup',
    profile: 'labs',
    target: 'default',
    archive,
    apply,
    plaintext: true,
    retainUntil: futureDate(),
    expected: {},
  };
}

function archiveFixture(directory: string, stable = true): string {
  const archive = join(directory, 'backup.dump');
  writeFileSync(archive, 'fake postgres custom archive', { mode: 0o600 });
  const sha256 = createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(
    `${archive}.manifest.json`,
    `${JSON.stringify({
      version: 1,
      retainUntil: futureDate(),
      source: {
        workspaceHost: 'https://customer.cloud.databricks.com',
        bundle: 'waf-assessment',
        target: 'default',
        branch,
        schema: 'waf',
        database: sourceResource,
      },
      expectations: {},
      acceptanceExpectationSetComplete: false,
      consistency: { sourceStableAcrossArchive: stable },
      sourceInspection: stable ? inspection : undefined,
      archive: { sha256, encryption: { kind: 'none' } },
    })}\n`,
    { mode: 0o600 }
  );
  return archive;
}

function restoreOptions(archive: string, apply = false): RecoveryOptions {
  return {
    action: 'restore',
    profile: 'labs',
    target: 'default',
    archive,
    apply,
    plaintext: false,
    databaseId: 'recovery-test',
    expected: {},
  };
}

describe('recovery arguments', () => {
  it('requires an explicit profile, target, archive, retention and encryption decision', () => {
    expect(() => parseRecoveryArgs(['backup'])).toThrow(/--profile is required/);
    expect(() => parseRecoveryArgs(['backup', '--profile', 'labs'])).toThrow(/--target is required/);
    expect(() => parseRecoveryArgs(['backup', '--profile', 'labs', '--target', 'default'])).toThrow(
      /--archive is required/
    );
    expect(() =>
      parseRecoveryArgs(['backup', '--profile', 'labs', '--target', 'default', '--archive', '/tmp/backup'])
    ).toThrow(/--retain-until/);
    expect(() =>
      parseRecoveryArgs([
        'backup',
        '--profile',
        'labs',
        '--target',
        'default',
        '--archive',
        '/tmp/backup',
        '--retain-until',
        futureDate(),
      ])
    ).toThrow(/exactly one/);
  });

  it('records the three fresh-install acceptance ids and an optional publication on the backup', () => {
    const options = parseRecoveryArgs([
      'backup',
      '--profile=labs',
      '--target=default',
      '--archive=/tmp/backup',
      `--retain-until=${futureDate()}`,
      '--gpg-recipient=operator@example.com',
      '--expect-result=result-1',
      '--expect-review=review-1',
      '--expect-action=action-1',
      '--expect-publication=publication-1',
    ]);
    expect(options.expected).toEqual({
      result: 'result-1',
      review: 'review-1',
      action: 'action-1',
      publication: 'publication-1',
    });
  });

  it('does not let restore replace the manifest expectations', () => {
    expect(() =>
      parseRecoveryArgs([
        'restore',
        '--profile',
        'labs',
        '--target',
        'default',
        '--archive',
        '/tmp/backup',
        '--database-id',
        'recovery-test',
        '--expect-result',
        'different',
      ])
    ).toThrow(/cannot be replaced/);
  });

  it('recognises only Autoscaling database resource names', () => {
    expect(parseDatabaseResource(sourceResource)).toEqual({ branch, databaseId: 'databricks-postgres' });
    expect(() => parseDatabaseResource('ep.example.com')).toThrow(/not an Autoscaling database resource/);
  });
});

describe('backup', () => {
  it('previews the resolved DAB source without running pg_dump', () => {
    const directory = privateDirectory();
    const runner = new FakeRunner([inspection]);
    const result = runRecovery(backupOptions(join(directory, 'backup.dump')), runner);

    expect(result.output.join('\n')).toContain(sourceResource);
    expect(result.output.join('\n')).toContain('Dry run only');
    expect(runner.calls.some((one) => one.command === 'pg_dump')).toBe(false);
  });

  it('writes a private immutable archive and stable manifest', () => {
    const directory = privateDirectory();
    const archive = join(directory, 'backup.dump');
    const runner = new FakeRunner([inspection, inspection]);
    const result = runRecovery(backupOptions(archive, true), runner);

    expect(readFileSync(archive, 'utf8')).toBe('fake postgres custom archive');
    expect(statSync(archive).mode & 0o777).toBe(0o600);
    const manifest = JSON.parse(readFileSync(`${archive}.manifest.json`, 'utf8')) as {
      consistency: { sourceStableAcrossArchive: boolean };
      sourceInspection: { schemaDigest: string };
      durableUnityCatalogArtifacts: unknown[];
    };
    expect(manifest.consistency.sourceStableAcrossArchive).toBe(true);
    expect(manifest.sourceInspection.schemaDigest).toBe(inspection.schemaDigest);
    expect(manifest.durableUnityCatalogArtifacts).toEqual([]);
    expect(result.output.join('\n')).toContain('operational backup, not complete 108b rehearsal evidence');
    expect(runner.calls.find((one) => one.command === 'pg_dump')?.args).toEqual(
      expect.arrayContaining(['--format=custom', '--no-owner', '--no-privileges', '--serializable-deferrable'])
    );
    expect(runner.calls.find((one) => one.command === 'pg_dump')?.env?.PGPASSWORD).toBe('fake-secret-token');
  });

  it('recognises a final assessment, review and action as complete fresh-install evidence', () => {
    const directory = privateDirectory();
    const archive = join(directory, 'backup.dump');
    const options: RecoveryOptions = {
      ...backupOptions(archive, true),
      expected: { result: 'result-1', review: 'review-1', action: 'action-1' },
    };
    const runner = new FakeRunner([inspection, inspection]);
    const result = runRecovery(options, runner);
    const manifest = JSON.parse(readFileSync(`${archive}.manifest.json`, 'utf8')) as {
      acceptanceExpectationSetComplete: boolean;
    };

    expect(manifest.acceptanceExpectationSetComplete).toBe(true);
    expect(result.output.join('\n')).toContain('No closed-month publication was available on this fresh installation');
  });

  it('refuses a repository path and a shared archive directory', () => {
    expect(() => runRecovery(backupOptions(join(process.cwd(), 'backup.dump')), new FakeRunner())).toThrow(
      /may not be written inside/
    );
    expect(() => runRecovery(backupOptions('/tmp/backup.dump'), new FakeRunner())).toThrow(
      /must not grant group or other access/
    );
  });
});

describe('restore and cleanup', () => {
  it('creates an empty target, restores transactionally, assigns App ownership and verifies it', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const runner = new FakeRunner([inspection]);
    const result = runRecovery(restoreOptions(archive, true), runner);

    const commands = runner.calls.map((one) => `${one.command} ${one.args.join(' ')}`);
    expect(commands.findIndex((one) => one.includes('create-database'))).toBeLessThan(
      commands.findIndex((one) => one.startsWith('pg_restore --single-transaction'))
    );
    const create = runner.calls.find((one) => one.args[1] === 'create-database');
    expect(JSON.parse(create?.args[create.args.indexOf('--json') + 1] ?? '')).toEqual({
      spec: {
        postgres_database: 'recovery_test',
        role: appRoleResource,
      },
    });
    expect(create?.args.slice(create.args.indexOf('--database-id'), create.args.indexOf('--database-id') + 2)).toEqual([
      '--database-id',
      'recovery-test',
    ]);
    expect(commands).toContainEqual(expect.stringContaining(`create role "${recoveryOwner}" nologin`));
    expect(commands).toContainEqual(expect.stringContaining(`grant "${recoveryOwner}" to "${appRole}"`));
    expect(commands).toContainEqual(
      expect.stringContaining(`update-database ${branch}/databases/recovery-test spec.role`)
    );
    expect(
      runner.calls.find((one) => one.command === 'pg_restore' && one.args.includes('--single-transaction'))?.args
    ).toEqual(expect.arrayContaining(['--single-transaction', '--role', recoveryOwner]));
    expect(result.output.join('\n')).toContain('The original database was not changed');
    expect(result.receiptPath).toBe(`${archive}.restore-recovery-test.json`);
    expect(statSync(result.receiptPath as string).mode & 0o777).toBe(0o600);
  });

  it('retains a failed recovery database for inspection instead of deleting evidence', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const runner = new FakeRunner([{ ...inspection, schemaDigest: 'different' }]);

    expect(() => runRecovery(restoreOptions(archive, true), runner)).toThrow(/retained for inspection/);
    expect(runner.created).toBe(true);
    expect(runner.deleted).toBe(false);
  });

  it('refuses to restore over an existing database', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const runner = new FakeRunner();
    runner.created = true;

    expect(() => runRecovery(restoreOptions(archive, true), runner)).toThrow(/already exists/);
    expect(runner.calls.some((one) => one.args.join(' ').includes('create-database'))).toBe(false);
  });

  it('refuses an archive from a different DAB source', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const manifestPath = `${archive}.manifest.json`;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { source: { database: string } };
    manifest.source.database = `${branch}/databases/other-source`;
    writeFileSync(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
    const runner = new FakeRunner();

    expect(() => runRecovery(restoreOptions(archive, true), runner)).toThrow(/manifest source database/);
    expect(runner.created).toBe(false);
  });

  it('refuses to overwrite an existing restore receipt before creating a database', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    writeFileSync(`${archive}.restore-recovery-test.json`, '{}\n', { mode: 0o600 });
    const runner = new FakeRunner();

    expect(() => runRecovery(restoreOptions(archive, true), runner)).toThrow(/receipt .* already exists/);
    expect(runner.created).toBe(false);
  });

  it('binds cleanup confirmation to workspace, source, target and archive', () => {
    const context = {
      bundle: 'waf-assessment',
      target: 'default',
      profile: 'labs',
      host: 'https://customer.cloud.databricks.com',
      actor: 'operator@example.com',
      app: 'databricks-waf-assessment',
      appClientId,
      expectedRole: appRole,
      appRoleResource,
      branch,
      database: sourceResource,
    };
    const manifest = { archive: { sha256: 'archive-digest' } };
    const token = cleanupToken(context, manifest, `${branch}/databases/recovery-test`);
    expect(
      cleanupToken({ ...context, host: 'https://other.example.com' }, manifest, `${branch}/databases/recovery-test`)
    ).not.toBe(token);
    expect(cleanupToken(context, { archive: { sha256: 'other' } }, `${branch}/databases/recovery-test`)).not.toBe(
      token
    );
    expect(cleanupToken(context, manifest, `${branch}/databases/recovery-test`, recoveryOwnerResource)).not.toBe(token);
  });

  it('previews cleanup and deletes only with the exact token', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const previewRunner = new FakeRunner();
    previewRunner.created = true;
    previewRunner.roleCreated = true;
    const options: RecoveryOptions = {
      ...restoreOptions(archive),
      action: 'cleanup',
    };
    const preview = runRecovery(options, previewRunner);
    expect(previewRunner.deleted).toBe(false);

    const applyRunner = new FakeRunner();
    applyRunner.created = true;
    applyRunner.roleCreated = true;
    runRecovery({ ...options, apply: true, confirm: preview.token }, applyRunner);
    expect(applyRunner.deleted).toBe(true);
    expect(applyRunner.roleDeleted).toBe(true);
  });

  it('finishes cleanup when the database was deleted but its owner role remains', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const previewRunner = new FakeRunner();
    previewRunner.roleCreated = true;
    const options: RecoveryOptions = { ...restoreOptions(archive), action: 'cleanup' };
    const preview = runRecovery(options, previewRunner);

    const applyRunner = new FakeRunner();
    applyRunner.roleCreated = true;
    runRecovery({ ...options, apply: true, confirm: preview.token }, applyRunner);
    expect(applyRunner.deleted).toBe(false);
    expect(applyRunner.roleDeleted).toBe(true);
  });

  it('never permits cleanup of the current DAB database', () => {
    const directory = privateDirectory();
    const archive = archiveFixture(directory);
    const runner = new FakeRunner();
    expect(() =>
      runRecovery(
        {
          ...restoreOptions(archive),
          action: 'cleanup',
          databaseId: 'databricks-postgres',
        },
        runner
      )
    ).toThrow(/currently bound source database/);
  });
});
