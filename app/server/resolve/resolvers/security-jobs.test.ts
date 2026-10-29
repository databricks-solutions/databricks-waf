// Security controls answered by system-table job and Unity Catalog storage signals.
//
// SCP-04-22: jobs run as service principal. The main invariant is that the run-as name decides:
// an email address is a user and fails, a UUID is a service principal and passes, and anything
// else (a group name, a missing name) is unknown and stays out of the denominator. The numeric
// `run_as` ID says nothing about which kind of identity it is. A missing name must not be read as
// a user account, because the column is unpopulated on older rows and that is not a configuration
// choice.
//
// SCP-04-05: managed tables in DBFS root. The main invariant is that zero DBFS
// tables is a clean pass and any non-zero count is a fail. An empty metastore is
// not-applicable, not a pass.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { DbfsTableAudit, JobRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const JOBS: SignalId = 'sql:jobs.inventory';
const DBFS_TABLES: SignalId = 'sql:security.dbfs_tables';

const catalogue = loadCatalogue();
const registry = buildRegistry();

function job(overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: '1',
    jobId: 'j-1',
    name: 'nightly-load',
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 0,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 1,
    ...overrides,
  };
}

function dbfsAudit(overrides: Partial<DbfsTableAudit> = {}): DbfsTableAudit {
  return {
    totalManagedTables: 100,
    dbfsRootTables: 0,
    ...overrides,
  };
}

function signalsOf(entries: readonly [SignalId, unknown][]): Map<SignalId, SignalResult> {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, { mode: 'complete' })]));
}

function findingFor(controlId: string, signals: Map<SignalId, SignalResult>) {
  const spec = catalogue.controls.find((c) => c.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, registry.get(controlId));
}

// ─── SCP-04-22 ───────────────────────────────────────────────────────────────

const SP_APPLICATION_ID = '3f2b8c1e-9d4a-4e6b-8a57-1c0d2e9f7a64';
const OTHER_SP_APPLICATION_ID = 'A1B2C3D4-0000-4111-8222-333344445555';

describe('SCP-04-22, jobs run as service principal', () => {
  it('passes when every job runs as a service principal named by its application ID', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'load', runAs: '504969272498578', runAsName: SP_APPLICATION_ID }),
      job({ jobId: 'j-2', name: 'score', runAs: '77228083933694', runAsName: OTHER_SP_APPLICATION_ID }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('2 of 2');
    expect(finding.evidence[0]?.observed).toContain('100%');
  });

  it('fails when a job runs as a user, which the name carries as an email while run_as holds a numeric ID', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'user-job', runAs: '8800112233', runAsName: 'alice@example.com' }),
      job({ jobId: 'j-2', name: 'sp-job', runAs: '504969272498578', runAsName: SP_APPLICATION_ID }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('fail');
    // Evidence names the user-account job, and the account it runs as is the name, not the numeric ID.
    const offenderEvidence = finding.evidence.find((e) => e.observed?.includes('user-job'));
    expect(offenderEvidence).toBeDefined();
    expect(offenderEvidence?.observed).toContain('alice@example.com');
    expect(offenderEvidence?.observed).not.toContain('8800112233');
  });

  it('does not read a numeric run_as as a service principal when the name says user', () => {
    const jobs = [job({ jobId: 'j-1', name: 'user-job', runAs: '504969272498578', runAsName: 'bob@example.com' })];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('0 of 1');
  });

  it('reports partial when most but not all jobs run as SP', () => {
    // 8 SPs, 1 user → 88.9% SP, above the 80% partial threshold but below 100%
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) =>
        job({ jobId: `j-sp-${i}`, name: `sp-job-${i}`, runAs: `${100000000 + i}`, runAsName: SP_APPLICATION_ID })
      ),
      job({ jobId: 'j-user', name: 'user-job', runAs: '999', runAsName: 'bob@example.com' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('partial');
  });

  it('is not-applicable when there are no jobs', () => {
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, []]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no jobs');
  });

  it('is not-applicable when no job has a name recorded (rows written before early December 2025)', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'old-job', runAs: '504969272498578', runAsName: undefined }),
      job({ jobId: 'j-2', name: 'another-old-job', runAs: '77228083933694', runAsName: '' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no run-as name');
  });

  it('counts a job with no recorded name as unknown, outside the share denominator', () => {
    // 1 SP job, 1 unknown → share over classified jobs only = 100%, but the unknown count is reported
    const jobs = [
      job({ jobId: 'j-sp', name: 'sp-job', runAs: '504969272498578', runAsName: SP_APPLICATION_ID }),
      job({ jobId: 'j-old', name: 'old-job', runAs: '77228083933694', runAsName: undefined }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 of 1');
    expect(finding.evidence[0]?.observed).toContain('1 job');
    expect(finding.evidence[0]?.observed).toContain('cannot be classified');
  });

  it('counts a group name as unknown, outside the share denominator', () => {
    const jobs = [
      job({ jobId: 'j-sp', name: 'sp-job', runAs: '504969272498578', runAsName: SP_APPLICATION_ID }),
      job({ jobId: 'j-group', name: 'group-job', runAs: '123', runAsName: 'data-engineers' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 of 1');
    expect(finding.evidence[0]?.observed).toContain('1 job');
    expect(finding.evidence[0]?.observed).toContain('cannot be classified');
    // A group name is not an account to remediate, so it is not listed as a user-run job.
    expect(finding.evidence.find((e) => e.observed?.includes('group-job'))).toBeUndefined();
  });

  it('counts a value that is neither an email nor a UUID as unknown', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'odd-job', runAs: '123', runAsName: '504969272498578' }),
      job({ jobId: 'j-2', name: 'user-job', runAs: '124', runAsName: 'carol@example.com' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('0 of 1');
    expect(finding.evidence[0]?.observed).toContain('1 job');
  });

  it('is not-applicable when every name is a group name', () => {
    const jobs = [job({ jobId: 'j-1', name: 'group-job', runAs: '123', runAsName: 'data-engineers' })];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('not-applicable');
  });
});

// ─── SCP-04-05 ───────────────────────────────────────────────────────────────

describe('SCP-04-05, managed tables in DBFS root', () => {
  it('passes when no managed tables are on DBFS root', () => {
    const finding = findingFor('SCP-04-05', signalsOf([[DBFS_TABLES, dbfsAudit({ totalManagedTables: 374, dbfsRootTables: 0 })]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('374 managed tables');
    expect(finding.evidence[0]?.observed).toContain('none stored on DBFS root');
  });

  it('fails when any managed table has a DBFS root storage path', () => {
    const finding = findingFor('SCP-04-05', signalsOf([[DBFS_TABLES, dbfsAudit({ totalManagedTables: 50, dbfsRootTables: 3 })]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('3 of 50');
    expect(finding.outcomeReason).toContain('Unity Catalog alone');
  });

  it('is not-applicable when the metastore has no managed tables', () => {
    const finding = findingFor('SCP-04-05', signalsOf([[DBFS_TABLES, dbfsAudit({ totalManagedTables: 0, dbfsRootTables: 0 })]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no Unity Catalog managed tables');
  });

  it('fails for a single DBFS-root table', () => {
    const finding = findingFor('SCP-04-05', signalsOf([[DBFS_TABLES, dbfsAudit({ totalManagedTables: 1, dbfsRootTables: 1 })]]));
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('1 of 1');
  });
});
