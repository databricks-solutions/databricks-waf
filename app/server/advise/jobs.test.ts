// The job analysis.
//
// Most of these cases are the labs estate's own, because the estate is what decided the rules. The four
// worth reading first are all instances of the same discipline: a single-task job holding 1.0 of its task
// time in its one task must not read as a job dominated by a task, a job with one run must not read as a
// clean job, an absent outcome must not read as a job whose runs all succeeded, and a run still in flight
// must not be counted into either side of a success rate.
//
// The numbers in the fixtures are the measured ones. Job 471148922192497 ran 34 times, repeated a task in
// 12 of them, and 25 of its 34 runs did not succeed; the only multi-task job on the estate holds 0.633 of
// its task time in its busiest task, which is below the threshold and therefore fires nothing.

import { describe, expect, it } from 'vitest';
import type { JobComputeRow, JobRow, JobRunHealthRow } from '../collect/sql/shapes.js';
import { analyseJobs } from './jobs.js';
import { JOB_RULE_IDS, loadJobRules, workloadRulesDirectory } from './workload-rules.js';

const ruleset = loadJobRules(workloadRulesDirectory());

function health(overrides: Partial<JobRunHealthRow> = {}): JobRunHealthRow {
  return {
    workspaceId: 'w1',
    jobId: '471148922192497',
    runs: 34,
    wallSecondsTotal: 12_000,
    wallSecondsMean: 353,
    wallSecondsP95: 743.7,
    wallSecondsMedian: 300,
    wallSecondsMax: 2303,
    longestTaskSeconds: 2000,
    taskSecondsTotal: 14_000,
    tasksMost: 2,
    runsWithARepeatedTask: 0,
    repeatedTaskRuns: 0,
    runsWithATerminalPeriod: 34,
    runsSucceeded: 34,
    runsDidNotSucceed: 0,
    runsUnresolved: 0,
    // The statement's pre-limit count of jobs that ran, repeated on every row. One here, so a fixture of one
    // row is an uncapped reading; a test wanting a capped one raises it.
    jobPopulation: 1,
    ...overrides,
  };
}

function definition(overrides: Partial<JobRow> = {}): JobRow {
  return {
    workspaceId: 'w1',
    jobId: '471148922192497',
    name: 'daily_ingest',
    scheduled: true,
    scheduledKnown: true,
    healthRuleCount: 0,
    healthRulesKnown: true,
    hasStreamBacklogRule: false,
    tagCount: 0,
    ...overrides,
  };
}

/**
 * A compute row that fires none of the four utilisation rules.
 *
 * Deliberately busy-but-not-pressured, so a test that means to fire one rule sets the fields that rule
 * reads and nothing else fires by accident. The funnel figures are `41b`'s own on `large-estate`.
 */
function compute(overrides: Partial<JobComputeRow> = {}): JobComputeRow {
  return {
    workspaceId: 'w1',
    jobId: '471148922192497',
    runClusterPairs: 8,
    runsWithWorkerSamples: 8,
    clusters: 2,
    workerSamples: 240,
    pairsBelowThreeSamples: 0,
    avgCpuPercent: 55,
    peakCpuPercent: 70,
    avgCpuWaitPercent: 0.04,
    avgMemoryPercent: 60,
    peakMemoryPercent: 72,
    avgSwapPercent: 0.05,
    // Rule D's inputs, set at the estate's own middle so the network rule is as quiet as the other four
    // unless a case raises the job's rate. The median and the estate pair count are `50`'s on
    // `large-estate`: 3.0 MiB per node-minute over 10,488 pairs.
    networkBytesPerNodeMinute: 3_145_728,
    pairsWithANetworkRate: 8,
    pairsStatingNoNetwork: 0,
    estateMedianBytesPerNodeMinute: 3_145_728,
    estatePairsWithARate: 10_488,
    pairsWithAnAsOfConfig: 0,
    runsWithNoSetupFigure: 0,
    jobsThatRan: 4_876,
    jobsWithAComputeId: 4_158,
    jobsOnClassicCompute: 1_064,
    jobPopulation: 689,
    ...overrides,
  };
}

function rulesOf(rows: readonly JobRunHealthRow[], jobs: readonly JobRow[] = []): readonly string[] {
  const analysis = analyseJobs(rows, jobs, 30, ruleset);
  return (analysis?.jobs ?? []).flatMap((job) => job.findings.map((finding) => finding.rule));
}

const COMPUTE_RULES = [
  'JOB_WORKERS_UNDERUSED',
  'JOB_MEMORY_BOUND',
  'JOB_COMPUTE_BOUND',
  'JOB_STARTUP_OVERHEAD',
  'JOB_NETWORK_HEAVY',
];

/**
 * The compute rules a job fires, with a compute reading beside its health row.
 *
 * Filtered to those four rather than reporting all eight, because rule A requires the same p95 the
 * long-running rule fires on — 1,800 seconds, the document's own on both — so any job rule A can read is a
 * job `JOB_LONG_RUNNING` has already named. That is the rules agreeing rather than duplicating, and a case
 * about utilisation should not have to assert it every time.
 */
function computeRulesOf(row: JobRunHealthRow, utilisation: JobComputeRow | undefined): readonly string[] {
  const analysis = analyseJobs([row], [], 30, ruleset, utilisation == null ? [] : [utilisation]);
  return (analysis?.jobs ?? [])
    .flatMap((job) => job.findings.map((finding) => finding.rule))
    .filter((rule) => COMPUTE_RULES.includes(rule));
}

describe('the three-run guardrail', () => {
  // Rule A's own first condition — "at least three completed runs are available" — applied to all four
  // rules rather than to one. Measured, it admits 3 of the 7 jobs on labs, which bounds what this audit
  // covers rather than lowering confidence in what it says.
  it('reads a job with three runs', () => {
    const analysis = analyseJobs([health({ runs: 3, runsWithATerminalPeriod: 3, runsSucceeded: 3 })], [], 30, ruleset);

    expect(analysis?.eligible).toBe(1);
    expect(analysis?.jobs[0]?.state).toBe('clean');
  });

  it('reports a job with two runs as not assessed rather than as a job with nothing wrong', () => {
    const analysis = analyseJobs(
      [health({ runs: 2, runsWithATerminalPeriod: 2, runsSucceeded: 0, runsDidNotSucceed: 2 })],
      [],
      30,
      ruleset
    );

    expect(analysis?.jobs[0]?.state).toBe('ineligible');
    expect(analysis?.eligible).toBe(0);
    expect(analysis?.population).toBe(1);
  });

  it('withholds every finding from an ineligible job, including one whose own threshold it cleared', () => {
    // Two runs, both failed, both repeating, and a p95 well past the threshold. Nothing fires, because the
    // question the guardrail answers is whether there is a pattern to report at all.
    const rules = rulesOf([
      health({
        runs: 2,
        wallSecondsP95: 4000,
        runsWithARepeatedTask: 2,
        repeatedTaskRuns: 2,
        runsWithATerminalPeriod: 2,
        runsSucceeded: 0,
        runsDidNotSucceed: 2,
      }),
    ]);

    expect(rules).toEqual([]);
  });
});

describe('a job whose runs did not succeed', () => {
  const failing = health({ runsWithATerminalPeriod: 34, runsSucceeded: 9, runsDidNotSucceed: 25 });

  it('fires, at the share the platform recorded', () => {
    const analysis = analyseJobs([failing], [], 30, ruleset);
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_RUNS_NOT_SUCCEEDING');

    expect(finding?.confidence).toBe('high');
    expect(finding?.evidence).toContainEqual({ label: 'Runs that did not succeed', value: 25, unit: 'count' });
    expect(finding?.evidence).toContainEqual({ label: 'Share that did not succeed', value: 73.5, unit: 'percent' });
  });

  it('is critical when a job fails more often than it succeeds', () => {
    const analysis = analyseJobs([failing], [], 30, ruleset);

    expect(analysis?.jobs[0]?.findings[0]?.severity).toBe('critical');
  });

  it('is high, not critical, at a share below half', () => {
    const analysis = analyseJobs(
      [health({ runsWithATerminalPeriod: 34, runsSucceeded: 24, runsDidNotSucceed: 10 })],
      [],
      30,
      ruleset
    );

    expect(analysis?.jobs[0]?.findings[0]?.severity).toBe('high');
  });

  it('says nothing where the run timeline had no row, rather than reporting no failures', () => {
    // The outcome fields arrive over a left join that can miss. Absent is unknown, and a rule reading it as
    // zero failures would report a clean job on evidence it never had.
    const { runsWithATerminalPeriod: _terminal, runsSucceeded: _ok, runsDidNotSucceed: _bad, ...rest } = health();
    const analysis = analyseJobs([rest], [], 30, ruleset);

    expect(rulesOf([rest])).toEqual([]);
    expect(analysis?.jobs[0]?.state).toBe('clean');
  });

  it('divides by the runs that stated an outcome, not by every terminal period', () => {
    // Two failures of four resolved runs is 0.5 and fires; two of ten terminal periods, six of which state
    // nothing, is not a job failing a fifth of the time. Counting the unresolved would have reported 0.2 —
    // exactly the threshold — on a job whose finished runs are half failures.
    const analysis = analyseJobs(
      [health({ runs: 10, runsWithATerminalPeriod: 10, runsSucceeded: 2, runsDidNotSucceed: 2, runsUnresolved: 6 })],
      [],
      30,
      ruleset
    );
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_RUNS_NOT_SUCCEEDING');

    expect(finding?.evidence).toContainEqual({ label: 'Runs that stated an outcome', value: 4, unit: 'count' });
    expect(finding?.evidence).toContainEqual({ label: 'Share that did not succeed', value: 50, unit: 'percent' });
    expect(finding?.evidence).toContainEqual({ label: 'Runs with no outcome yet', value: 6, unit: 'count' });
  });
});

describe('a job whose tasks ran again', () => {
  it('fires at a quarter of the runs, which is the measured habit rather than a single repeat', () => {
    const rules = rulesOf([health({ runs: 34, runsWithARepeatedTask: 12, repeatedTaskRuns: 18 })]);

    expect(rules).toContain('JOB_TASKS_RUN_AGAIN');
  });

  it('says nothing about one repeat in twelve runs', () => {
    expect(rulesOf([health({ runs: 12, runsWithARepeatedTask: 1, repeatedTaskRuns: 1 })])).toEqual([]);
  });

  it('carries the extra task runs as well as the runs, because they are different numbers', () => {
    const analysis = analyseJobs([health({ runs: 34, runsWithARepeatedTask: 12, repeatedTaskRuns: 18 })], [], 30, ruleset);
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_TASKS_RUN_AGAIN');

    expect(finding?.evidence).toContainEqual({ label: 'Runs in which a task ran again', value: 12, unit: 'count' });
    expect(finding?.evidence).toContainEqual({ label: 'Extra task runs', value: 18, unit: 'count' });
    // Moderate rather than high: the count is certain and its cause is not, because nothing distinguishes
    // an automatic retry from a person repairing the run.
    expect(finding?.confidence).toBe('moderate');
  });
});

describe('a long-running job', () => {
  it('says nothing about the longest job on the measured estate, whose p95 is 12.4 minutes', () => {
    expect(rulesOf([health({ wallSecondsP95: 743.7 })])).toEqual([]);
  });

  it('fires past the document’s own thirty minutes', () => {
    const analysis = analyseJobs([health({ wallSecondsP95: 1900, wallSecondsMax: 2400 })], [], 30, ruleset);
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_LONG_RUNNING');

    expect(finding).toBeDefined();
    expect(finding?.evidence).toContainEqual({ label: 'Slowest 5% of runs took', value: 1_900_000, unit: 'ms' });
  });
});

describe('a job dominated by one task', () => {
  it('says nothing about a single-task job, whose one task holds all of its time as arithmetic', () => {
    // Six of the seven jobs measured are single-task and all six read a share of exactly 1.0. Firing there
    // would report a fact about counting as a finding about the job.
    const rules = rulesOf([
      health({ tasksMost: 1, taskSecondsTotal: 500, busiestTaskSeconds: 500, busiestTaskKey: 'main' }),
    ]);

    expect(rules).toEqual([]);
  });

  it('says nothing at the 0.633 the only multi-task job on the estate reads', () => {
    const rules = rulesOf([
      health({ tasksMost: 2, taskSecondsTotal: 1000, busiestTaskSeconds: 633, busiestTaskKey: 'transform' }),
    ]);

    expect(rules).toEqual([]);
  });

  it('fires above the threshold, and names the task', () => {
    const analysis = analyseJobs(
      [health({ tasksMost: 3, taskSecondsTotal: 1000, busiestTaskSeconds: 800, busiestTaskKey: 'load_silver' })],
      [],
      30,
      ruleset
    );
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_DOMINATED_BY_ONE_TASK');

    expect(finding?.evidence).toContainEqual({ label: 'Time in "load_silver"', value: 800_000, unit: 'ms' });
    expect(finding?.evidence).toContainEqual({ label: 'Share in that one task', value: 80, unit: 'percent' });
  });

  it('says nothing where no task run carried a total, rather than treating absence as no dominance', () => {
    const { busiestTaskSeconds: _seconds, ...rest } = health({ tasksMost: 2, taskSecondsTotal: 1000 });

    expect(rulesOf([rest])).toEqual([]);
  });
});

describe('the join to the job inventory', () => {
  it('names a job from its definition', () => {
    const analysis = analyseJobs([health()], [definition()], 30, ruleset);

    expect(analysis?.jobs[0]?.name).toBe('daily_ingest');
    expect(analysis?.jobs[0]?.scheduled).toBe(true);
    expect(analysis?.matched).toBe(1);
    expect(analysis?.live).toBe(1);
  });

  it('falls back to the id for a job deleted after it ran', () => {
    const analysis = analyseJobs([health()], [definition({ jobId: '999' })], 30, ruleset);

    expect(analysis?.jobs[0]?.name).toBe('471148922192497');
    expect(analysis?.matched).toBe(0);
  });

  it('reports no live count where the inventory was not read, rather than a denominator of zero', () => {
    const analysis = analyseJobs([health()], [], 30, ruleset);

    expect(analysis).not.toHaveProperty('live');
  });

  it('does not match a job id from another workspace', () => {
    const analysis = analyseJobs([health()], [definition({ workspaceId: 'w2' })], 30, ruleset);

    expect(analysis?.matched).toBe(0);
  });

  it('carries whether the trigger could be read at all, not only the flag', () => {
    // A definition written before the trigger columns existed has a null trigger and reads as unscheduled.
    // The flag alone is what dropped every manually-started job out of OE-02-04's denominator, so a surface
    // gets the predicate that decides whether the flag means anything.
    const before = definition({ scheduled: false, scheduledKnown: false, changeTime: new Date('2025-06-01') });
    const after = definition({ scheduled: false, scheduledKnown: false, changeTime: new Date('2026-06-01') });

    expect(analyseJobs([health()], [before], 30, ruleset)?.jobs[0]?.triggerRecorded).toBe(false);
    expect(analyseJobs([health()], [after], 30, ruleset)?.jobs[0]?.triggerRecorded).toBe(true);
  });

  it('marks a job whose row records several triggers, where the flag names none of them', () => {
    const many = definition({ scheduled: false, scheduledKnown: false, triggerType: 'MULTIPLE' });
    const job = analyseJobs([health()], [many], 30, ruleset)?.jobs[0];

    expect(job?.multipleTriggers).toBe(true);
    expect(job?.triggerRecorded).toBe(true);
    expect(job?.scheduled).toBe(false);
  });
});

describe('the analysis as a whole', () => {
  it('is absent where nothing was read, rather than an estate whose jobs all run cleanly', () => {
    expect(analyseJobs([], [], 30, ruleset)).toBeUndefined();
  });

  it('puts the job with the worst finding first', () => {
    const failing = health({ jobId: '2', runsWithATerminalPeriod: 34, runsSucceeded: 9, runsDidNotSucceed: 25 });
    const repeating = health({ jobId: '3', runs: 34, runsWithARepeatedTask: 12, repeatedTaskRuns: 18 });
    const analysis = analyseJobs([health({ jobId: '1' }), repeating, failing], [], 30, ruleset);

    expect(analysis?.jobs.map((job) => job.jobId)).toEqual(['2', '3', '1']);
  });

  it('counts every finding, not only the ones on the first job', () => {
    const failing = health({ jobId: '2', runsWithATerminalPeriod: 34, runsSucceeded: 9, runsDidNotSucceed: 25 });
    const repeating = health({ jobId: '3', runs: 34, runsWithARepeatedTask: 12, repeatedTaskRuns: 18 });
    const analysis = analyseJobs([failing, repeating], [], 30, ruleset);

    expect(analysis?.findingCount).toBe(2);
  });

  it('records the window and the ruleset version it was computed under', () => {
    const analysis = analyseJobs([health()], [], 30, ruleset);

    expect(analysis?.windowDays).toBe(30);
    expect(analysis?.rulesVersion).toBe(ruleset.version);
  });

  it('reports the jobs that ran and the jobs it read as two numbers', () => {
    // The statement returns the longest-running `job_limit` of them and the count before that limit, so a
    // surface has a denominator to declare its sample against. Collapsed into one field, the disclosure that
    // the list is a sample became a branch that could not run.
    const analysis = analyseJobs([health({ jobPopulation: 9_412 }), health({ jobId: '2', jobPopulation: 9_412 })], [], 30, ruleset);

    expect(analysis?.population).toBe(9_412);
    expect(analysis?.sampled).toBe(2);
  });

  it('does not report a population below the sample it contains', () => {
    // A stored reading from before the column existed parses as zero. Zero jobs ran is not a reading that
    // can hold two of them, so the sample is the floor.
    const analysis = analyseJobs([health({ jobPopulation: 0 }), health({ jobId: '2', jobPopulation: 0 })], [], 30, ruleset);

    expect(analysis?.population).toBe(2);
    expect(analysis?.sampled).toBe(2);
  });
});

describe('the five rules that read compute', () => {
  // The utilisation half, ledger row `33ce`. Every threshold here is `41b`'s measurement on `large-estate`
  // and every case below is written against the thing that measurement changed: the swap baseline, the
  // sample floor, the as-of node type, and the fact that an absent reading is not a clean one.
  const long = health({ runs: 12, wallSecondsP95: 2400 });

  it('does not fire on a job with no compute reading, which is most of them', () => {
    expect(computeRulesOf(long, undefined)).toEqual([]);
  });

  it('reports the job as clean rather than ineligible when only the compute half is missing', () => {
    // Three states and not four. The four timeline rules did read this job and found nothing; what went
    // unread is the compute half, and `compute` being absent is what says so.
    const analysis = analyseJobs([health()], [], 30, ruleset, []);

    expect(analysis?.jobs[0]?.state).toBe('clean');
    expect(analysis?.jobs[0]).not.toHaveProperty('compute');
  });

  it('names an idle cluster', () => {
    const idle = compute({ avgCpuPercent: 12, avgMemoryPercent: 20 });

    expect(computeRulesOf(long, idle)).toContain('JOB_WORKERS_UNDERUSED');
  });

  it('does not call a short job idle, whatever its workers were doing', () => {
    // The document's own p95 condition, and the largest single piece of rule A's attrition: 75 of the 97
    // jobs that clear the run minimum are removed by it.
    const idle = compute({ avgCpuPercent: 12, avgMemoryPercent: 20 });

    expect(computeRulesOf(health({ runs: 12, wallSecondsP95: 60 }), idle)).toEqual([]);
  });

  it('reads through the swap baseline rather than treating any swap as swapping', () => {
    // `mem_swap_percent > 0` fires on 95% of node-minutes at a median of 0.05%, so the document's "no
    // sustained swap" as written is a condition nothing meets. At the median the rule still fires.
    const idle = compute({ avgCpuPercent: 12, avgMemoryPercent: 20, avgSwapPercent: 0.05 });

    expect(computeRulesOf(long, idle)).toContain('JOB_WORKERS_UNDERUSED');
  });

  it('declines where swap is above the threshold, because something else explains the idleness', () => {
    const swapping = compute({ avgCpuPercent: 12, avgMemoryPercent: 20, avgSwapPercent: 4 });

    expect(computeRulesOf(long, swapping)).not.toContain('JOB_WORKERS_UNDERUSED');
  });

  it('declines a mean taken over fewer than three samples', () => {
    // 48.2% of run-cluster pairs on the measured estate are this. A mean over one observation is not a
    // mean, and the floor is this app's rather than the document's.
    const thin = compute({ avgCpuPercent: 12, avgMemoryPercent: 20, runClusterPairs: 8, pairsBelowThreeSamples: 6 });

    expect(computeRulesOf(long, thin)).toEqual([]);
  });

  it('names a job under memory pressure on its average', () => {
    const pressed = compute({ avgMemoryPercent: 82, peakMemoryPercent: 84 });
    const analysis = analyseJobs([long], [], 30, ruleset, [pressed]);
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_MEMORY_BOUND');

    expect(finding?.confidence).toBe('moderate');
  });

  it('claims less where only the peak crossed', () => {
    // The average clause is the one `41b` measured. What the peak clause adds on top of it is unknown, and
    // a single minute at 90% is not a job short of memory.
    const spiking = compute({ avgMemoryPercent: 40, peakMemoryPercent: 92 });
    const analysis = analyseJobs([long], [], 30, ruleset, [spiking]);
    const finding = analysis?.jobs[0]?.findings.find((one) => one.rule === 'JOB_MEMORY_BOUND');

    expect(finding?.confidence).toBe('low');
  });

  it('names a compute-bound job, which the measured estate had 18 pairs of', () => {
    const busy = compute({ avgCpuPercent: 88, avgMemoryPercent: 30, avgCpuWaitPercent: 0.5 });

    expect(computeRulesOf(long, busy)).toContain('JOB_COMPUTE_BOUND');
  });

  it('names the node type only where the as-of join resolved it', () => {
    const idle = compute({ avgCpuPercent: 12, avgMemoryPercent: 20 });
    const named = compute({ ...idle, nodeType: 'i3.xlarge', pairsWithAnAsOfConfig: 3 });
    const labels = (row: JobComputeRow): readonly string[] =>
      analyseJobs([long], [], 30, ruleset, [row])
        ?.jobs[0]?.findings.find((one) => one.rule === 'JOB_WORKERS_UNDERUSED')
        ?.evidence.map((one) => one.label) ?? [];

    // The count beside the name is the point: relaxing the ordering would name a type for 53.6% of pairs
    // instead of 8.7%, and every pair in the difference is configured after the run it is attributed to.
    expect(labels(named)).toContain('Runs on "i3.xlarge"');
    expect(labels(idle).join(' ')).not.toMatch(/Runs on/);
  });

  it('names a job that spends a quarter of each run starting its cluster', () => {
    const slow = compute({ setupSecondsMean: 120, statedRunSecondsMean: 300 });

    expect(computeRulesOf(long, slow)).toContain('JOB_STARTUP_OVERHEAD');
  });

  it('says nothing about setup where the platform stated the run at zero', () => {
    // `33ca` measured `run_duration_seconds` written as zero on all 44 runs on labs. Dividing by it would
    // report every run as infinitely dominated by its own setup.
    const unstated = compute({ setupSecondsMean: 120, statedRunSecondsMean: 0 });

    expect(computeRulesOf(long, unstated)).not.toContain('JOB_STARTUP_OVERHEAD');
  });

  it('says nothing about setup where no run carried a figure', () => {
    // Absent is not zero — ADR 0074 — and the platform writes a zero on every run measured, so a null here
    // is a field that was not read rather than a run with no setup phase.
    const unread = compute({ statedRunSecondsMean: 300, runsWithNoSetupFigure: 8 });

    expect(computeRulesOf(long, unread)).not.toContain('JOB_STARTUP_OVERHEAD');
  });

  it('names a job moving orders of magnitude more network traffic than the estate', () => {
    // Rule D, as much of it as `50` found answerable. A hundred times the estate's 3.0 MiB per node-minute
    // is inside the 2.1% an absolute cut at 1,000 MiB selected, which is the magnitude that names a
    // population rather than the workspace.
    const chatty = compute({ networkBytesPerNodeMinute: 314_572_800 });

    expect(computeRulesOf(long, chatty)).toContain('JOB_NETWORK_HEAVY');
  });

  it('claims little, because the condition that would justify more is unanswerable', () => {
    // Traffic against data processed needs a denominator `system.query.history` names no classic job
    // cluster on. Without it the rate is a magnitude and not a diagnosis, and `low` is what that gets.
    const chatty = compute({ networkBytesPerNodeMinute: 314_572_800 });
    const finding = analyseJobs([long], [], 30, ruleset, [chatty])?.jobs[0]?.findings.find(
      (one) => one.rule === 'JOB_NETWORK_HEAVY'
    );

    expect(finding?.confidence).toBe('low');
    expect(finding?.evidence.find((one) => one.label === 'Times the median')?.unit).toBe('multiple');
  });

  it('declines a job whose rate is high against a workspace with almost no pairs to have a middle', () => {
    // A median over three pairs is not a workspace's median, and a multiple of it is not a finding.
    const thin = compute({ networkBytesPerNodeMinute: 314_572_800, estatePairsWithARate: 3 });

    expect(computeRulesOf(long, thin)).not.toContain('JOB_NETWORK_HEAVY');
  });

  it('declines a quiet job in a quieter workspace, whatever the multiple says', () => {
    // The floor under the multiple. A workspace whose median is a kilobyte would otherwise make every job
    // a hundred times its middle while none of them moved anything worth naming.
    const quiet = compute({ networkBytesPerNodeMinute: 102_400, estateMedianBytesPerNodeMinute: 512 });

    expect(computeRulesOf(long, quiet)).not.toContain('JOB_NETWORK_HEAVY');
  });

  it('says nothing where no pair ran long enough to have a rate', () => {
    // Absent and not zero: a rate needs node-minutes to divide by, and a zero would be a job that moved
    // no traffic rather than a job nothing was measured over.
    const unrated = compute({ networkBytesPerNodeMinute: undefined, pairsWithANetworkRate: 0 });

    expect(computeRulesOf(long, unrated)).not.toContain('JOB_NETWORK_HEAVY');
  });
});

/**
 * Rule E, which is the one rule about compute that takes no compute row.
 *
 * The input is `product_features.is_photon` on the billing record, so it fires on jobs the worker join
 * never reached — 96.6% of the rule's clusters against that join's much narrower reach. Every case below
 * is one of the three ways a reader would collapse three counts into a wrong two.
 */
describe('the rule that reads whether Photon was on', () => {
  const photonRulesOf = (row: JobRunHealthRow): readonly string[] =>
    (analyseJobs([row], [], 30, ruleset)?.jobs ?? [])
      .flatMap((one) => one.findings.map((finding) => finding.rule))
      .filter((rule) => rule === 'JOB_PHOTON_OFF');

  it('fires on a job whose classic usage mostly billed without it', () => {
    const off = health({ classicUsageRecords: 20, classicRecordsStatingPhoton: 20, classicRecordsWithPhotonOff: 18 });

    expect(photonRulesOf(off)).toEqual(['JOB_PHOTON_OFF']);
  });

  it('fires without a compute row, which is the whole reason it reads the bill', () => {
    // `system.compute.clusters` carries no Photon column and the as-of join resolves 8.7% of pairs. A rule
    // routed through either would miss the jobs this one is about.
    const off = health({ classicUsageRecords: 20, classicRecordsStatingPhoton: 20, classicRecordsWithPhotonOff: 18 });
    const analysis = analyseJobs([off], [], 30, ruleset, []);

    expect(analysis?.jobs[0]).not.toHaveProperty('compute');
    expect(analysis?.jobs[0]?.findings.map((one) => one.rule)).toContain('JOB_PHOTON_OFF');
  });

  it('does not read the records that state nothing as records that state on', () => {
    // Eighteen of twenty stated, all eighteen off. The share is over what was stated, and the two silent
    // records are named in the evidence rather than counted either way.
    const partial = health({
      classicUsageRecords: 20,
      classicRecordsStatingPhoton: 18,
      classicRecordsWithPhotonOff: 18,
    });
    const finding = analyseJobs([partial], [], 30, ruleset)?.jobs[0]?.findings.find(
      (one) => one.rule === 'JOB_PHOTON_OFF'
    );

    expect(finding?.evidence.find((one) => one.label === 'Non-serverless records that state nothing')?.value).toBe(2);
    expect(finding?.confidence).toBe('high');
  });

  it('says nothing about a job with no classic usage, which is a serverless job', () => {
    // Zero stated is not Photon on. Photon is not a setting on serverless at all.
    const serverless = health({
      classicUsageRecords: 0,
      classicRecordsStatingPhoton: 0,
      classicRecordsWithPhotonOff: 0,
    });

    expect(photonRulesOf(serverless)).toEqual([]);
  });

  it('says nothing where the reading predates the columns', () => {
    expect(photonRulesOf(health())).toEqual([]);
  });

  it('declines a job whose classic usage mostly billed with it on', () => {
    const on = health({ classicUsageRecords: 20, classicRecordsStatingPhoton: 20, classicRecordsWithPhotonOff: 4 });

    expect(photonRulesOf(on)).toEqual([]);
  });

  it('declines a job with one stated record, because a floor sits under the share', () => {
    const one = health({ classicUsageRecords: 1, classicRecordsStatingPhoton: 1, classicRecordsWithPhotonOff: 1 });

    expect(photonRulesOf(one)).toEqual([]);
  });
});

describe('the coverage funnel', () => {
  it('is absent where the compute statement was not read', () => {
    // Absent and empty are different facts: this run did not ask.
    expect(analyseJobs([health()], [], 30, ruleset)).not.toHaveProperty('computeRead');
  });

  it('states four steps and zero reached where the estate runs everything on serverless', () => {
    // Labs. The statement ran and returned nothing, which is a reading about the workspace and not about
    // the platform, and the surface has to be able to tell it from an estate with nothing wrong.
    expect(analyseJobs([health()], [], 30, ruleset, [])?.computeRead).toEqual({
      thatRan: 0,
      withAComputeId: 0,
      onClassicCompute: 0,
      withWorkerSamples: 0,
    });
  });

  it('carries the estate figures and the window the samples span', () => {
    const early = new Date('2026-05-14T00:00:00Z');
    const late = new Date('2026-08-12T00:00:00Z');
    const reach = analyseJobs([health()], [], 30, ruleset, [
      compute({ earliestSample: early, latestSample: late }),
    ])?.computeRead;

    // 4,876 jobs ran and 689 were reachable, so a rule naming nine jobs is nine of 689 and not of 4,876.
    expect(reach?.thatRan).toBe(4_876);
    expect(reach?.withWorkerSamples).toBe(1);
    // 94 days against the task timeline's 370, which is why the window is on the analysis at all.
    expect(reach?.earliestSample).toEqual(early);
    expect(reach?.latestSample).toEqual(late);
  });
});

describe('the ruleset', () => {
  it('declares the ten rules the analysis fires and no others', () => {
    expect([...ruleset.rules.keys()].sort()).toEqual([...JOB_RULE_IDS].sort());
  });

  it('cites documentation on every rule, because a recommendation has to be checkable', () => {
    for (const rule of ruleset.rules.values()) expect(rule.docUrl).toMatch(/^https:\/\//);
  });

  it('carries a rationale on the one rule no design document names', () => {
    expect(ruleset.rules.get('JOB_RUNS_NOT_SUCCEEDING')?.provenance).toBe('extension');
    expect(ruleset.rules.get('JOB_RUNS_NOT_SUCCEEDING')?.rationale?.length ?? 0).toBeGreaterThan(80);
  });

  it('keeps compute out of the words of every rule that does not read compute', () => {
    // The four timeline rules read the two Lakeflow timelines and nothing else, so a sentence in one of
    // them recommending a node type would be advice from an input it never opened — the failure `33ca`
    // exists to have caught. The four that do read compute are exempt because they read it.
    const timeline = ['JOB_LONG_RUNNING', 'JOB_DOMINATED_BY_ONE_TASK', 'JOB_RUNS_NOT_SUCCEEDING', 'JOB_TASKS_RUN_AGAIN'];
    for (const id of timeline) {
      const rule = ruleset.rules.get(id);
      expect(`${rule?.headline ?? ''} ${rule?.detail ?? ''}`).not.toMatch(/worker count|node type|Photon|autoscal/i);
    }
  });

  it('says of the compute rules only what their own statement returns', () => {
    // Photon is the one word that matters here, and what it may say changed with `51` rather than opening
    // up. It is readable — from the billing record, not from the node timeline these four read — so rule C
    // may point at the separate finding and may not claim to have seen the setting itself. The other three
    // read neither, so the word stays out of them entirely.
    const bound = ruleset.rules.get('JOB_COMPUTE_BOUND');

    expect(bound?.detail).toMatch(/separate finding read from the billing record/);
    expect(bound?.detail).not.toMatch(/Photon is (on|off)\b/i);
    for (const id of ['JOB_WORKERS_UNDERUSED', 'JOB_MEMORY_BOUND', 'JOB_STARTUP_OVERHEAD', 'JOB_NETWORK_HEAVY']) {
      expect(`${ruleset.rules.get(id)?.headline ?? ''} ${ruleset.rules.get(id)?.detail ?? ''}`).not.toMatch(/Photon/i);
    }
  });

  it('keeps rule D from being called what the document called it', () => {
    // `50` measured the two conditions that would justify "I/O-bound" and found the denominator missing
    // for every classic job cluster. The rule fires on the rate alone, so the words have to be about the
    // rate — and it has to say what it cannot compare against rather than leaving the reader to assume.
    const rule = ruleset.rules.get('JOB_NETWORK_HEAVY');

    expect(`${rule?.headline ?? ''} ${rule?.detail ?? ''}`).not.toMatch(/i\/o.bound|io.bound|storage.bound/i);
    expect(rule?.detail).toMatch(/whether the traffic is proportionate to the work/);
  });

  it('keeps rule E from promising Photon would help', () => {
    // The setting is measured and the benefit is not. Photon bills at a higher rate, so a rule that said
    // "turn it on to save" would be a cost claim from a payload with no price in it — the same line
    // `job_run_health.sql` draws around its usage quantity.
    const rule = ruleset.rules.get('JOB_PHOTON_OFF');

    expect(rule?.detail).toMatch(/bills at a higher rate/);
    expect(rule?.detail).not.toMatch(/will (be faster|save|reduce)/i);
  });
});
