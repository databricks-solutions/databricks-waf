// The serverless verdicts, and the arithmetic under the cost range.
//
// Two things here are worth more than the rest. The first is precedence: a job with a GPU
// cluster and an init script has to read as blocked, and a job with an init script and one
// unreadable cluster has to read as rework rather than as undeterminable, because burying
// the actionable half under the unreadable one is the failure this analysis exists to avoid.
//
// The second is the estimate. It is a number a customer may take to a budget conversation,
// and the ways it could be wrong are all quiet: an absent serverless rate becoming a
// forecast of zero, a hard blocker's migration being priced into the total as though it
// were available, a start-up share of zero collapsing the range to a point without saying
// so. Each of those has a test.

import { describe, expect, it } from 'vitest';
import { analyse, analyseServerless, JOB_INVENTORY, JOB_SPEND, READINESS } from './serverless.js';
import { RULE_IDS, serverlessRules } from './serverless-rules.js';
import { observed, unmeasurable } from '../collect/signal.js';
import type { SignalId, SignalResult } from '../collect/signal.js';
import type { JobReadinessRow, JobRow, JobSpendRow, WorkspaceDirectory, WorkspaceRow } from '../collect/sql/shapes.js';

const HOME: WorkspaceRow = {
  workspaceId: 'w1',
  name: 'production',
  url: 'https://home.cloud.databricks.com',
  status: 'RUNNING',
  live: true,
};

const OTHER: WorkspaceRow = {
  workspaceId: 'w2',
  name: 'analytics',
  url: 'https://other.cloud.databricks.com',
  status: 'RUNNING',
  live: true,
};

function readiness(overrides: Partial<JobReadinessRow> = {}): JobReadinessRow {
  return {
    workspaceId: 'w1',
    jobId: '100',
    runs: 30,
    taskRuns: 30,
    taskRunsUntimed: 0,
    longestTaskSeconds: 600,
    setupSeconds: 0,
    executionSeconds: 3000,
    computeUses: 30,
    serverlessUses: 0,
    warehouseUses: 0,
    classicUses: 30,
    unclassifiedUses: 0,
    classicClusters: 1,
    unreadClusters: 0,
    allPurposeClusters: 0,
    initScriptClusters: 0,
    unknownInitScriptClusters: 0,
    gpuClusters: 0,
    pooledClusters: 0,
    cloudIdentityClusters: 0,
    policyClusters: 0,
    mlRuntimeClusters: 0,
    legacyAccessModeClusters: 0,
    unknownAccessModeClusters: 0,
    clusterNames: ['nightly-etl'],
    runtimes: ['15.4.x-scala2.12'],
    ...overrides,
  };
}

function spend(overrides: Partial<JobSpendRow> = {}): JobSpendRow {
  return {
    workspaceId: 'w1',
    jobId: '100',
    cost: 100,
    serverlessCost: 0,
    classicCost: 100,
    classicDbus: 200,
    unpricedRecords: 0,
    currency: 'USD',
    serverlessRate: 0.4,
    serverlessRegion: 'US_EAST_N_VIRGINIA',
    // No region in a classic SKU name — that is the whole reason the region is established
    // from the workspace instead, and a fixture that invented one would hide it.
    classicSkus: ['PREMIUM_JOBS_COMPUTE'],
    ...overrides,
  };
}

function definition(overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: 'w1',
    jobId: '100',
    name: 'Nightly ETL',
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 0,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 0,
    ...overrides,
  };
}

function analyseOne(row: Partial<JobReadinessRow>, extra: { spend?: JobSpendRow; job?: JobRow } = {}) {
  const result = analyse({
    readiness: [readiness(row)],
    spend: extra.spend == null ? [] : [extra.spend],
    jobs: extra.job == null ? [] : [extra.job],
    lookbackDays: 30,
  });
  const only = result.jobs[0];
  if (only == null) throw new Error('The job under test was not returned.');
  return { result, job: only };
}

function reasonIds(job: { reasons: readonly { ruleId: string }[] }): string[] {
  return job.reasons.map((reason) => reason.ruleId);
}

describe('verdicts', () => {
  it('reads a clean classic job as ready', () => {
    const { job } = analyseOne({});
    expect(job.verdict).toBe('ready');
    expect(job.reasons).toEqual([]);
  });

  it('reads a GPU cluster as a hard blocker', () => {
    const { job } = analyseOne({ gpuClusters: 1 });
    expect(job.verdict).toBe('blocked');
    expect(reasonIds(job)).toContain('gpu-cluster');
  });

  it('reads a run past seven days as a hard blocker', () => {
    const { job } = analyseOne({ longestTaskSeconds: 8 * 24 * 60 * 60 });
    expect(job.verdict).toBe('blocked');
    const reason = job.reasons.find((r) => r.ruleId === 'run-exceeds-seven-days');
    expect(reason?.observed).toContain('8.0 days');
  });

  it('leaves a run just inside seven days alone', () => {
    const { job } = analyseOne({ longestTaskSeconds: 7 * 24 * 60 * 60 - 1 });
    expect(job.verdict).toBe('ready');
  });

  it('reads an init script as rework rather than a blocker', () => {
    const { job } = analyseOne({ initScriptClusters: 2 });
    expect(job.verdict).toBe('rework');
    const reason = job.reasons.find((r) => r.ruleId === 'init-script');
    expect(reason?.observed).toContain('2 clusters');
  });

  it('says one cluster rather than 1 clusters', () => {
    const { job } = analyseOne({ initScriptClusters: 1 });
    expect(job.reasons[0]?.observed).toMatch(/^One cluster /);
  });

  // Precedence, which is the judgement this analysis makes and the one most easily broken by
  // a later edit that reorders the checks.
  it('prefers a blocker over rework found on the same job', () => {
    const { job } = analyseOne({ gpuClusters: 1, initScriptClusters: 1, pooledClusters: 1 });
    expect(job.verdict).toBe('blocked');
    expect(reasonIds(job)).toEqual(expect.arrayContaining(['gpu-cluster', 'init-script', 'instance-pool']));
  });

  it('prefers rework over an unknown found on the same job, and keeps both reasons', () => {
    const { job } = analyseOne({ initScriptClusters: 1, unreadClusters: 1 });
    expect(job.verdict).toBe('rework');
    expect(reasonIds(job)).toEqual(expect.arrayContaining(['init-script', 'cluster-unreadable']));
  });

  it('reads unclassifiable compute as undeterminable, not as clean', () => {
    const { job } = analyseOne({ classicUses: 0, unclassifiedUses: 4, computeUses: 4, classicClusters: 0 });
    expect(job.verdict).toBe('unknown');
    const reason = job.reasons.find((r) => r.ruleId === 'compute-unclassified');
    expect(reason?.observed).toContain('4 of its 4');
  });

  it('reads an unwritten init-script column as undeterminable rather than as no init script', () => {
    const { job } = analyseOne({ unknownInitScriptClusters: 1 });
    expect(job.verdict).toBe('unknown');
    expect(job.reasons.find((r) => r.ruleId === 'configuration-unwritten')?.observed).toContain('Init scripts');
  });

  it('names both columns when both were unwritten', () => {
    const { job } = analyseOne({ unknownInitScriptClusters: 1, unknownAccessModeClusters: 1 });
    expect(job.reasons.find((r) => r.ruleId === 'configuration-unwritten')?.observed).toContain('access mode');
  });

  it('treats a note as no obstacle to a ready verdict', () => {
    const { job } = analyseOne({ allPurposeClusters: 1, policyClusters: 1 });
    expect(job.verdict).toBe('ready');
    expect(reasonIds(job)).toEqual(['all-purpose-cluster', 'policy-governed']);
  });

  it('reads a runtime older than any serverless environment as rework', () => {
    const { job } = analyseOne({ oldestRuntimeMajor: 11, runtimes: ['11.3.x-scala2.12'] });
    expect(job.verdict).toBe('rework');
    expect(job.reasons[0]?.observed).toContain('version 11');
    expect(job.reasons[0]?.observed).toContain('11.3.x-scala2.12');
  });

  it('leaves a current runtime alone', () => {
    const { job } = analyseOne({ oldestRuntimeMajor: 15 });
    expect(job.verdict).toBe('ready');
  });

  it('reads a continuous job as rework, from the job definition', () => {
    const { job } = analyseOne({}, { job: definition({ continuous: true }) });
    expect(job.verdict).toBe('rework');
    expect(reasonIds(job)).toContain('continuous-trigger');
  });

  it('carries the rule text and its citation into the reason', () => {
    const { job } = analyseOne({ cloudIdentityClusters: 1 });
    const reason = job.reasons[0];
    expect(reason?.headline).toBe('The cluster carries its own cloud identity');
    expect(reason?.docUrl).toMatch(/^https:\/\/docs\.databricks\.com\//);
    expect(reason?.detail.length).toBeGreaterThan(40);
  });
});

describe('the numbers behind the sentence', () => {
  /*
   * `observed` is prose, and an action raised from a reason carrying only prose can hold an estimate
   * and can never report a realised value — the difference between two sentences is not a number.
   * `44b` gave the reasons that fire on a quantity the quantity as well. These tests are about the
   * ones that do not: a rule firing on a setting carries nothing rather than a number with an
   * invented unit, and a sentence that disagrees with the number beside it is the fault worth having
   * a test for at all.
   */
  it('reports the count the sentence quotes, with a unit', () => {
    const { job } = analyseOne({ initScriptClusters: 2 });

    expect(job.reasons[0]?.evidence).toEqual([{ label: 'Clusters running an init script', value: 2, unit: 'count' }]);
  });

  it('reports a duration in milliseconds, which is what every other advisor measures one in', () => {
    const { job } = analyseOne({ longestTaskSeconds: 8 * 24 * 60 * 60 });
    const reason = job.reasons.find((one) => one.ruleId === 'run-exceeds-seven-days');

    expect(reason?.evidence).toEqual([{ label: 'Longest task run', value: 8 * 24 * 60 * 60 * 1000, unit: 'ms' }]);
  });

  it('reports both halves of a share, so the number is readable without the sentence', () => {
    const { job } = analyseOne({ classicUses: 0, unclassifiedUses: 4, computeUses: 6, classicClusters: 0 });
    const reason = job.reasons.find((one) => one.ruleId === 'compute-unclassified');

    expect(reason?.evidence).toEqual([
      { label: 'Compute uses not classified', value: 4, unit: 'count' },
      { label: 'Compute uses recorded', value: 6, unit: 'count' },
    ]);
  });

  it('counts both unwritten columns once, rather than the one the sentence happens to name', () => {
    const { job } = analyseOne({ unknownInitScriptClusters: 1, unknownAccessModeClusters: 2 });
    const reason = job.reasons.find((one) => one.ruleId === 'configuration-unwritten');

    expect(reason?.evidence).toEqual([{ label: 'Clusters with unrecorded configuration', value: 3, unit: 'count' }]);
  });

  it('gives a setting no number, because a continuous trigger is not a quantity', () => {
    const { job } = analyseOne({}, { job: definition({ continuous: true }) });

    expect(job.reasons.find((one) => one.ruleId === 'continuous-trigger')?.evidence).toEqual([]);
  });

  it('gives a runtime version no number, because a version counted is a unit this app invented', () => {
    const { job } = analyseOne({ oldestRuntimeMajor: 11, runtimes: ['11.3.x-scala2.12'] });

    expect(job.reasons[0]?.evidence).toEqual([]);
  });

  it('gives the standing caveat none either, since it is not a measurement of anything', () => {
    const result = analyse({ readiness: [readiness({})], spend: [], jobs: [], lookbackDays: 30 });

    expect(result.caveat.evidence).toEqual([]);
  });
});

describe('what is not listed', () => {
  it('counts an already-serverless job instead of listing it', () => {
    const result = analyse({
      readiness: [readiness({ classicUses: 0, serverlessUses: 30, classicClusters: 0 })],
      spend: [],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.jobs).toEqual([]);
    expect(result.alreadyServerless).toBe(1);
    expect(result.jobsRan).toBe(1);
  });

  it('counts a warehouse-only job separately, since its question is the warehouse’s', () => {
    const result = analyse({
      readiness: [readiness({ classicUses: 0, warehouseUses: 12, classicClusters: 0 })],
      spend: [],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.jobs).toEqual([]);
    expect(result.onWarehouse).toBe(1);
  });

  it('lists a mostly-serverless job that still has classic runs', () => {
    const result = analyse({
      readiness: [readiness({ serverlessUses: 29, classicUses: 1 })],
      spend: [],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.jobs).toHaveLength(1);
    expect(result.alreadyServerless).toBe(0);
  });

  it('caps the list and says how many it found', () => {
    const rows = Array.from({ length: 45 }, (_, index) => readiness({ jobId: String(index) }));
    const result = analyse({ readiness: rows, spend: [], jobs: [], lookbackDays: 30 });
    expect(result.jobs).toHaveLength(40);
    expect(result.truncated).toEqual({ listed: 40, found: 45 });
    expect(result.counts.ready).toBe(45);
  });

  it('does not claim truncation when everything is listed', () => {
    const result = analyse({ readiness: [readiness({})], spend: [], jobs: [], lookbackDays: 30 });
    expect(result.truncated).toBeUndefined();
  });

  it('orders the list by what the migration is worth', () => {
    const result = analyse({
      readiness: [readiness({ jobId: '1' }), readiness({ jobId: '2' }), readiness({ jobId: '3' })],
      spend: [spend({ jobId: '1', classicCost: 10 }), spend({ jobId: '2', classicCost: 900 })],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.jobs.map((entry) => entry.jobId)).toEqual(['2', '1', '3']);
  });

  it('falls back to the job id when the definition is gone', () => {
    const { job } = analyseOne({ jobId: '77' });
    expect(job.name).toBe('Job 77');
  });

  it('uses the job name when the inventory has it', () => {
    const { job } = analyseOne({}, { job: definition({ name: 'Nightly ETL' }) });
    expect(job.name).toBe('Nightly ETL');
  });
});

describe('the cost range', () => {
  it('prices the migration from observed DBUs and the serverless rate', () => {
    // 200 classic DBUs at 0.4, with no start-up time to remove, so the range is a point.
    const { job } = analyseOne({ setupSeconds: 0 }, { spend: spend() });
    expect(job.cost).toBe(100);
    expect(job.estimate).toEqual({ low: 80, high: 80, currency: 'USD', region: 'US_EAST_N_VIRGINIA' });
  });

  it('takes the start-up time this job measured off the bottom of the range', () => {
    // A quarter of the job's measured time was cluster start-up, which serverless does not
    // bill, so the low end is three quarters of the high end.
    const { job } = analyseOne({ setupSeconds: 1000, executionSeconds: 3000 }, { spend: spend() });
    expect(job.estimate).toEqual({ low: 60, high: 80, currency: 'USD', region: 'US_EAST_N_VIRGINIA' });
    expect(job.startupShare).toBeCloseTo(0.25);
  });

  // Which region the rate was read at is the only thing making the figure checkable against a
  // published price, so it travels with the range rather than being dropped after the sum.
  it('names the region the rate came from', () => {
    const { job } = analyseOne({}, { spend: spend({ serverlessRegion: 'AP_SYDNEY', serverlessRate: 0.5 }) });
    expect(job.estimate?.region).toBe('AP_SYDNEY');
    expect(job.estimate?.high).toBe(100);
  });

  it('refuses an estimate rather than forecasting zero when the price list has no rate', () => {
    const { job } = analyseOne({}, { spend: spend({ serverlessRate: undefined }) });
    expect(job.estimate).toBeUndefined();
    expect(job.cost).toBe(100);
    expect(job.noEstimate).toContain('no serverless jobs rate');
    // Names the region it looked in, because that is what makes the absence checkable.
    expect(job.noEstimate).toContain('US_EAST_N_VIRGINIA');
  });

  // The two absences are different and only one is actionable. A workspace with no serverless
  // usage has no region for the rate to be read at; the reader can fix that, and a message
  // blaming the price list would send them to look at the wrong thing.
  it('distinguishes an unestablished region from a region with no published rate', () => {
    const { job } = analyseOne({}, { spend: spend({ serverlessRate: undefined, serverlessRegion: undefined }) });
    expect(job.noEstimate).toContain('no serverless usage of any kind');
    expect(job.noEstimate).not.toContain('price list holds no');
  });

  it('leaves cost and estimate absent for a job with no classic DBUs', () => {
    const { job } = analyseOne({}, { spend: spend({ classicDbus: 0 }) });
    expect(job.cost).toBeUndefined();
    expect(job.estimate).toBeUndefined();
  });

  it('keeps a hard blocker out of the estate total, since its migration cannot happen', () => {
    const result = analyse({
      readiness: [readiness({ jobId: '1' }), readiness({ jobId: '2', gpuClusters: 1 })],
      spend: [spend({ jobId: '1' }), spend({ jobId: '2' })],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.estimate).toEqual({ low: 80, high: 80, currency: 'USD', jobs: 1, region: 'US_EAST_N_VIRGINIA' });
    // But its present cost is still counted, because the estate does pay it.
    expect(result.cost).toBe(200);
  });

  // An estate total spanning two price lists is not a figure from either of them, and naming
  // one would say the whole number came from there.
  it('names no region on an estate total priced across two of them', () => {
    const result = analyse({
      readiness: [readiness({ jobId: '1' }), readiness({ jobId: '2' })],
      spend: [spend({ jobId: '1', serverlessRegion: 'AP_SYDNEY' }), spend({ jobId: '2', serverlessRegion: 'EUROPE_IRELAND' })],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.estimate?.jobs).toBe(2);
    expect(result.estimate?.region).toBeUndefined();
  });

  it('includes a rework job in the total, priced as though the rework changed nothing', () => {
    const result = analyse({
      readiness: [readiness({ jobId: '1' }), readiness({ jobId: '2', initScriptClusters: 1 })],
      spend: [spend({ jobId: '1' }), spend({ jobId: '2' })],
      jobs: [],
      lookbackDays: 30,
    });
    expect(result.estimate?.jobs).toBe(2);
    expect(result.estimate?.high).toBe(160);
  });

  it('publishes the assumptions with the estimate', () => {
    const result = analyse({ readiness: [readiness({})], spend: [spend()], jobs: [], lookbackDays: 30 });
    expect(result.assumptions.length).toBeGreaterThan(3);
    expect(result.assumptions.map((assumption) => assumption.id)).toContain('dbu-parity');
    for (const assumption of result.assumptions) expect(assumption.statement.length).toBeGreaterThan(40);
  });

  it('always carries the caveat that this reads compute and not code', () => {
    const result = analyse({ readiness: [], spend: [], jobs: [], lookbackDays: 30 });
    expect(result.caveat.ruleId).toBe('outside-metadata');
    expect(result.caveat.detail).toContain('system tables');
  });
});

describe('reading the signals', () => {
  // The collectors' own constructors rather than hand-built objects, so a change to what a
  // result carries reaches these tests instead of passing against a shape nothing produces.
  function signals(entries: readonly [SignalId, SignalResult][]): Map<SignalId, SignalResult> {
    return new Map(entries);
  }

  const saw = <T,>(id: SignalId, value: T): [SignalId, SignalResult] => [id, observed(id, value, 0)];
  const missed = (id: SignalId, reason: string): [SignalId, SignalResult] => [id, unmeasurable(id, reason)];

  it('returns nothing at all when the readiness signal was never collected', () => {
    expect(analyseServerless(signals([]), 30)).toBeUndefined();
  });

  it('carries the collector’s own reason when the readiness signal could not be read', () => {
    const result = analyseServerless(signals([missed(READINESS, 'No access to system.lakeflow.')]), 30);
    expect(result?.unmeasured).toBe('No access to system.lakeflow.');
    expect(result?.jobs).toEqual([]);
  });

  it('reads an estate that ran nothing as a measurement rather than a failure', () => {
    const result = analyseServerless(signals([saw(READINESS, [])]), 30);
    expect(result?.unmeasured).toBeUndefined();
    expect(result?.jobsRan).toBe(0);
  });

  it('keeps every verdict when billing could not be read, and says the costs are missing', () => {
    const result = analyseServerless(
      signals([
        saw(READINESS, [readiness({ initScriptClusters: 1 })]),
        missed(JOB_SPEND, 'No access to system.billing.'),
      ]),
      30
    );
    expect(result?.jobs[0]?.verdict).toBe('rework');
    expect(result?.jobs[0]?.cost).toBeUndefined();
    expect(result?.unmeasured).toBe('No access to system.billing.');
  });

  it('joins the three signals on workspace and job', () => {
    const result = analyseServerless(
      signals([
        saw(READINESS, [readiness({ workspaceId: 'w2', jobId: '9' })]),
        saw(JOB_SPEND, [spend({ workspaceId: 'w2', jobId: '9' })]),
        saw(JOB_INVENTORY, [definition({ workspaceId: 'w2', jobId: '9', name: 'Reconciliation' })]),
      ]),
      30
    );
    expect(result?.jobs[0]?.name).toBe('Reconciliation');
    expect(result?.jobs[0]?.estimate?.high).toBe(80);
  });

  it('does not join a job id from another workspace onto this one', () => {
    const result = analyseServerless(
      signals([
        saw(READINESS, [readiness({ workspaceId: 'w2', jobId: '100' })]),
        saw(JOB_SPEND, [spend({ workspaceId: 'w1', jobId: '100', classicCost: 5000 })]),
      ]),
      30
    );
    expect(result?.jobs[0]?.cost).toBeUndefined();
  });

  it('reports the lookback it was given, since every count here is per window', () => {
    expect(analyseServerless(signals([saw(READINESS, [])]), 90)?.lookbackDays).toBe(90);
  });
});

describe('linking a job to its own page', () => {
  const directory = (rows: readonly WorkspaceRow[] = [HOME, OTHER]): WorkspaceDirectory => ({
    workspaces: rows,
    live: rows.filter((row) => row.live),
    excluded: [],
    regionUnverified: [],
    outOfScope: [],
  });

  it('links a job into the workspace it actually runs in', () => {
    const result = analyse({
      readiness: [readiness({ workspaceId: OTHER.workspaceId })],
      spend: [],
      jobs: [],
      lookbackDays: 30,
      directory: directory(),
    });
    expect(result.jobs[0]?.link).toBe('https://other.cloud.databricks.com/?o=w2#job/100');
  });

  it('names the workspace when the account has more than one', () => {
    const result = analyse({
      readiness: [readiness({ workspaceId: OTHER.workspaceId })],
      spend: [],
      jobs: [],
      lookbackDays: 30,
      directory: directory(),
    });
    expect(result.jobs[0]?.workspace).toBe('analytics');
  });

  it('says nothing about the workspace in a single-workspace account', () => {
    const result = analyse({
      readiness: [readiness({})],
      spend: [],
      jobs: [],
      lookbackDays: 30,
      directory: directory([HOME]),
    });
    expect(result.jobs[0]?.workspace).toBeUndefined();
    expect(result.jobs[0]?.link).toBe('https://home.cloud.databricks.com/?o=w1#job/100');
  });

  it('still produces every verdict when the directory could not be read', () => {
    const result = analyse({ readiness: [readiness({ gpuClusters: 1 })], spend: [], jobs: [], lookbackDays: 30 });
    expect(result.jobs[0]?.verdict).toBe('blocked');
    expect(result.jobs[0]?.link).toBeUndefined();
  });
});

describe('the ruleset behind it', () => {
  it('declares every rule the analyzer fires, and nothing it does not', () => {
    const declared = [...serverlessRules().rules.keys()].sort();
    expect(declared).toEqual([...RULE_IDS].sort());
  });

  // Every rule but the caveat has to be reachable from some estate, or it is a sentence
  // nobody will ever be shown. This asserts the ones that fire from readiness facts do.
  it('can fire every rule that reads a fact about the estate', () => {
    const fired = new Set<string>();
    const cases: Partial<JobReadinessRow>[] = [
      { gpuClusters: 1 },
      { longestTaskSeconds: 8 * 86400 },
      { initScriptClusters: 1 },
      { pooledClusters: 1 },
      { cloudIdentityClusters: 1 },
      { legacyAccessModeClusters: 1 },
      { mlRuntimeClusters: 1 },
      { oldestRuntimeMajor: 11 },
      { unclassifiedUses: 1 },
      { unreadClusters: 1 },
      { unknownAccessModeClusters: 1 },
      { allPurposeClusters: 1 },
      { policyClusters: 1 },
    ];
    for (const row of cases) for (const id of reasonIds(analyseOne(row).job)) fired.add(id);
    for (const id of reasonIds(analyseOne({}, { job: definition({ continuous: true }) }).job)) fired.add(id);
    fired.add('outside-metadata');
    expect([...fired].sort()).toEqual([...RULE_IDS].sort());
  });
});
