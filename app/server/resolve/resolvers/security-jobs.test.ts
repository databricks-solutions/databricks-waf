// Security controls answered by system-table job and Unity Catalog storage signals.
//
// SCP-04-22: jobs run as service principal. The main invariant is that a numeric
// run_as identity passes and an email address fails. The absent-column case (run_as
// undefined or empty string) must not be read as a user account, because absence
// in the system table predates the column and is not a configuration choice.
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

describe('SCP-04-22, jobs run as service principal', () => {
  it('passes when every job has a numeric (SP) run_as identity', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'load', runAs: '504969272498578' }),
      job({ jobId: 'j-2', name: 'score', runAs: '77228083933694' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('2 of 2');
    expect(finding.evidence[0]?.observed).toContain('100%');
  });

  it('fails when a job runs as a user account (email address)', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'user-job', runAs: 'alice@example.com' }),
      job({ jobId: 'j-2', name: 'sp-job', runAs: '504969272498578' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('fail');
    // Evidence names the user-account job
    const offenderEvidence = finding.evidence.find((e) => e.observed?.includes('user-job'));
    expect(offenderEvidence).toBeDefined();
  });

  it('reports partial when most but not all jobs run as SP', () => {
    // 8 SPs, 1 user → 88.9% SP, above the 80% partial threshold but below 100%
    const jobs = [
      ...Array.from({ length: 8 }, (_, i) => job({ jobId: `j-sp-${i}`, name: `sp-job-${i}`, runAs: `${100000000 + i}` })),
      job({ jobId: 'j-user', name: 'user-job', runAs: 'bob@example.com' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('partial');
  });

  it('is not-applicable when there are no jobs', () => {
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, []]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no jobs');
  });

  it('is not-applicable when all jobs have unknown run_as (pre-December 2025 rows)', () => {
    const jobs = [
      job({ jobId: 'j-1', name: 'old-job', runAs: undefined }),
      job({ jobId: 'j-2', name: 'another-old-job', runAs: '' }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no run_as identity recorded');
  });

  it('excludes jobs with no run_as from the share denominator', () => {
    // 1 SP job, 1 unknown → share over known only = 100%, but unknown count is reported
    const jobs = [
      job({ jobId: 'j-sp', name: 'sp-job', runAs: '504969272498578' }),
      job({ jobId: 'j-old', name: 'old-job', runAs: undefined }),
    ];
    const finding = findingFor('SCP-04-22', signalsOf([[JOBS, jobs]]));
    expect(finding.outcome).toBe('pass');
    // Evidence should note the 1 unrecorded job
    expect(finding.evidence[0]?.observed).toContain('1 job');
    expect(finding.evidence[0]?.observed).toContain('no identity recorded');
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
