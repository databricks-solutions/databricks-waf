import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { count, only, said, share } from './measure-job-audit-inputs.mjs';
import type { JobAuditInputs, Probe } from './measure-job-audit-inputs.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

function read(estate: string): JobAuditInputs {
  return JSON.parse(readFileSync(join(BASELINES, `${estate}-job-audit-inputs.json`), 'utf8')) as JobAuditInputs;
}

const recording = read('labs');
const fieldEng = read('large-estate');

/** One probe's row, by the label it was recorded under. */
function rowsOf(where: JobAuditInputs, label: string): readonly Readonly<Record<string, string | null>>[] {
  const found = where.probes.find((one) => one.label === label);
  if (found?.ok !== true) throw new Error(`the recording has no successful probe called ${label}`);
  return found.rows ?? [];
}

function rows(label: string): readonly Readonly<Record<string, string | null>>[] {
  return rowsOf(recording, label);
}

function row(label: string): Readonly<Record<string, string | null>> {
  const [first] = rows(label);
  if (first == null) throw new Error(`the probe called ${label} returned no row`);
  return first;
}

/**
 * A percentile array as the warehouse returns it: a JSON string of decimal strings.
 *
 * Parsed here rather than inline so the `any` a bare `JSON.parse` produces stops at one place, and so a probe
 * that stops returning an array fails as an empty reading rather than as a type error inside an assertion.
 */
function percentiles(value: string | null | undefined): readonly number[] {
  if (value == null) return [];
  const parsed: unknown = JSON.parse(value);
  return Array.isArray(parsed) ? parsed.map((one) => Number(one)) : [];
}

function fieldEngRow(label: string): Readonly<Record<string, string | null>> {
  const [first] = rowsOf(fieldEng, label);
  if (first == null) throw new Error(`the probe called ${label} returned no row`);
  return first;
}

describe('how a reading distinguishes the two ways of having no number', () => {
  // The distinction this row nearly published the wrong side of. The first run printed "unknown — its probe
  // failed" against three readings whose probes had succeeded and found an empty population, which is the
  // opposite claim: one is a fact about the apparatus, the other a fact about the estate.
  it('says the probe returned no counts where a count is missing', () => {
    expect(share(null, 40).unknown).toBe('the probe returned no counts');
    expect(share(4, null).unknown).toBe('the probe returned no counts');
  });

  it('says the estate has none of these where the population is empty, and not that anything failed', () => {
    const reading = share(0, 0);
    expect(reading.share).toBeNull();
    expect(reading.unknown).toBe('the probe ran and this workspace has none of these');
    expect(said(reading)).not.toMatch(/fail/);
  });

  it('reports a share with the population it came out of, because 0 of 3 and 0 of 30000 differ', () => {
    expect(share(3, 7)).toEqual({ share: 0.429, of: 7, unknown: null });
    expect(said(share(3, 7))).toBe('0.429 of 7');
  });

  it('reads a count off a row, and treats an absent or unparseable one as unknown rather than zero', () => {
    expect(count({ jobs: '7' }, 'jobs')).toBe(7);
    expect(count({ jobs: null }, 'jobs')).toBeNull();
    expect(count({ jobs: '' }, 'jobs')).toBeNull();
    expect(count({ jobs: 'lots' }, 'jobs')).toBeNull();
    expect(count(undefined, 'jobs')).toBeNull();
  });

  it('returns nothing for a probe that failed, so a derived count cannot be built out of one', () => {
    const failed: Probe[] = [{ label: 'a', ok: false, error: 'no' }];
    expect(only(failed, 'a')).toBeNull();
    expect(only(failed, 'b')).toBeNull();
    expect(only([{ label: 'a', ok: true, rows: [{ jobs: '2' }] }], 'a')).toEqual({ jobs: '2' });
  });
});

/**
 * The recording held to the sentences the write-up builds on, as `measure-plan-joins.test.ts` does for the query
 * half. Every one of these decides whether a row in H6c is buildable, so a re-run on another estate that moves
 * them should fail here rather than be noticed a phase later — asserted as the shape of each claim, not the
 * exact number, except where the claim *is* the exact number being zero.
 */
describe('what the committed recording says about the audit’s inputs', () => {
  it('ran every probe, so no reading here is silence from a failure', () => {
    expect(recording.probes.filter((one) => !one.ok)).toEqual([]);
    expect(recording.probes.length).toBeGreaterThan(10);
  });

  it('found every job run on serverless compute, which is why four rules have no input', () => {
    const kinds = rows('what kind of compute the job runs used');
    expect(kinds).toHaveLength(1);
    expect(kinds[0].kind).toBe('SERVERLESS_COMPUTE');
    // And the ids the struct carries are null on all of them, which is what made the first version of the
    // reach query explode an array of nulls and report a reach of zero for the wrong reason.
    expect(count(kinds[0], 'with_a_cluster_id')).toBe(0);
    expect(count(kinds[0], 'with_a_warehouse_id')).toBe(0);
  });

  it('found the node timeline readable and empty, not unreadable', () => {
    // Two different findings. `node_utilization.sql` already records the emptiness; this says it is not a
    // permission problem, which is what would make it a defect rather than an estate property.
    const relations = rows('whether the compute relations hold anything at all');
    const nodeTimeline = relations.find((one) => one.relation === 'node_timeline');
    const clusters = relations.find((one) => one.relation === 'clusters');
    expect(count(nodeTimeline, 'rows_in_first_thousand')).toBe(0);
    expect(count(clusters, 'rows_in_first_thousand')).toBeGreaterThan(0);
  });

  it('found the run-window worker join reaching no job, at every grain a rule fires at', () => {
    const reach = row('how far the run-window worker join reaches');
    expect(count(reach, 'jobs')).toBeGreaterThan(0);
    expect(count(reach, 'run_cluster_pairs')).toBeGreaterThan(0);
    expect(count(reach, 'jobs_with_worker_samples')).toBe(0);
    expect(count(reach, 'runs_with_worker_samples')).toBe(0);
    expect(count(reach, 'worker_samples')).toBe(0);
  });

  it('found no as-of cluster configuration for any run, though clusters exist', () => {
    const asOf = row('whether the as-of cluster configuration join finds a row');
    expect(count(asOf, 'run_cluster_pairs')).toBeGreaterThan(0);
    expect(count(asOf, 'pairs_with_any_config')).toBe(0);
  });

  it('found the stated per-run durations written as zero rather than left null', () => {
    // The document says job-level duration "can be zero or incomplete". It is worse than that here: the columns
    // are present and zero, which a collector would divide by or report as an instant run.
    const stated = row('whether the stated per-run durations are populated');
    const runs = count(stated, 'runs');
    expect(runs).toBeGreaterThan(0);
    expect(count(stated, 'runs_with_a_total')).toBe(0);
    expect(count(stated, 'runs_with_a_setup')).toBe(0);
    expect(count(stated, 'runs_with_zero_total')).toBe(runs);
    expect(count(stated, 'runs_with_null_total')).toBe(0);
  });

  it('found the period columns give a wall clock, and both timelines agree on it', () => {
    // Which is what makes query 1 buildable at all once the stated duration is unusable.
    const periods = row('whether the run timeline’s periods agree with the task timeline’s');
    expect(count(periods, 'runs_absent_from_the_run_timeline')).toBe(0);
    expect(count(periods, 'runs_over_a_minute_apart')).toBe(0);
    expect(count(periods, 'multi_task_runs')).toBeGreaterThan(0);
  });

  it('found cost and outcome readable, which is the difference between five rules blocked and all of them', () => {
    const cost = row('whether job cost is readable');
    expect(count(cost, 'usage_records')).toBeGreaterThan(0);
    expect(count(cost, 'records_naming_a_run')).toBe(count(cost, 'usage_records'));
    // Numerator and denominator from the one join, so the share cannot exceed 1 by construction.
    expect(count(cost, 'jobs_with_usage')).toBeLessThanOrEqual(count(cost, 'jobs_that_ran') ?? 0);
    const outcomes = rows('whether retry and repair overhead is readable');
    expect(outcomes.length).toBeGreaterThan(0);
    expect(outcomes.some((one) => (count(one, 'did_not_succeed') ?? 0) > 0)).toBe(true);
  });

  it('counts runs and not the state periods they are made of', () => {
    // The review finding, as an assertion. `job_run_timeline` is period-grained, so counting its rows overstates
    // runs — it read 46 before the terminal period per run was taken. The cross-check that catches it is the task
    // timeline, which counts the same runs independently: the two must agree, and every run must have resolved to
    // one row with a stated outcome.
    const outcomes = rows('whether retry and repair overhead is readable');
    const runs = outcomes.reduce((total, one) => total + (count(one, 'runs') ?? 0), 0);
    const fromTheTaskTimeline = count(row('whether the stated per-run durations are populated'), 'runs');
    expect(runs).toBe(fromTheTaskTimeline);
    for (const one of outcomes) {
      expect(count(one, 'result_unstated')).toBe(0);
      expect((count(one, 'succeeded') ?? 0) + (count(one, 'did_not_succeed') ?? 0)).toBe(count(one, 'runs'));
    }
  });

  it('found under half the jobs clearing the three-run guardrail, so it bounds coverage', () => {
    const guardrail = row('how many jobs clear the three-run guardrail');
    const jobs = count(guardrail, 'jobs') ?? 0;
    const clearing = count(guardrail, 'jobs_with_three_runs') ?? 0;
    expect(jobs).toBeGreaterThan(0);
    expect(clearing).toBeLessThan(jobs);
    expect(recording.readings.jobsClearingTheGuardrail.of).toBe(jobs);
  });

  it('reports the utilisation readings as having no population rather than as failures', () => {
    for (const name of ['nodeSamplesBelow10PercentCpu', 'runsBelow30PercentCpu', 'runsRuleAWouldConsider']) {
      const reading = recording.readings[name];
      expect(reading.share).toBeNull();
      expect(reading.unknown).toBe('the probe ran and this workspace has none of these');
    }
  });
});

/**
 * What the second estate answered, and it is not what the plan assumed. Held to the same standard as the labs
 * block: the shape of each claim, and the exact number only where the claim *is* the number.
 *
 * These assertions are the write-up's evidence. `33ce` is scoped off them, so a re-run that moves one should
 * fail here rather than leave a row built on a number nothing holds any more.
 */
describe('what the field-eng recording says, on the estate that has the compute labs lacks', () => {
  it('ran every probe', () => {
    expect(fieldEng.probes.filter((one) => !one.ok)).toEqual([]);
    expect(fieldEng.probes.length).toBe(recording.probes.length);
  });

  it('found classic compute, which is the condition 33ce said it needed', () => {
    const kinds = rowsOf(fieldEng, 'what kind of compute the job runs used');
    const classic = kinds.find((one) => one.kind === 'CLASSIC_COMPUTE');
    expect(count(classic, 'runs')).toBeGreaterThan(0);
    // And its ids are cluster ids, unlike labs' serverless rows where both id fields were null on all of them.
    expect(count(classic, 'with_a_cluster_id')).toBe(count(classic, 'task_computes'));
  });

  it('found the worker join reaching a minority of jobs, which is the ceiling on rules A to D', () => {
    const reach = fieldEngRow('how far the run-window worker join reaches');
    const jobs = count(reach, 'jobs') ?? 0;
    const reached = count(reach, 'jobs_with_worker_samples') ?? 0;
    expect(reached).toBeGreaterThan(0);
    expect(reached / jobs).toBeLessThan(0.25);
    // Runs are reached less often than jobs, so the two grains cannot be quoted interchangeably.
    expect(fieldEng.readings.runsTheWorkerJoinReaches.share).toBeLessThan(
      fieldEng.readings.jobsTheWorkerJoinReaches.share ?? 1
    );
  });

  it("re-reads the calibration's 44% at the grain the calibration read it", () => {
    // Not a confirmation: `h6-calibration.md` read this on the same estate over two days, so a thirty-day re-read
    // is the same workspace agreeing with itself. What it establishes is that the figure was not a two-day fluke.
    expect(fieldEng.readings.nodeSamplesBelow10PercentCpu.share).toBeCloseTo(0.44, 2);
  });

  it('finds the low-CPU share higher among workers, so it is not a driver artefact', () => {
    // The first pass of this row put the total driver count beside the low-CPU count and called it "of which
    // drivers", which no probe had asked. The intersection says the opposite of what that implied.
    const split = fieldEngRow('how many of the low-CPU samples are drivers');
    const lowCpu = count(split, 'below_10_percent') ?? 0;
    const drivers = count(split, 'drivers_below_10_percent') ?? 0;
    const workerShare = (count(split, 'workers_below_10_percent') ?? 0) / (count(split, 'worker_samples') ?? 1);
    expect(drivers / lowCpu).toBeLessThan(0.4);
    expect(workerShare).toBeGreaterThan(
      lowCpu / (count(split, 'node_samples') ?? 1)
    );
    expect(workerShare).toBeCloseTo(0.526, 2);
  });

  it("finds rule A's guardrails doing the filtering its thresholds were blamed for", () => {
    // The finding that decides `33ce`, and the one the first pass got backwards by applying two of the rule's
    // five conditions. In order: reachable, three runs, p95 over the threshold, CPU, memory, no swap or wait.
    const a = fieldEngRow('how many jobs rule A’s documented conditions actually select');
    const reachable = count(a, 'jobs_with_worker_samples') ?? 0;
    const threeRuns = count(a, 'and_three_runs') ?? 0;
    const overP95 = count(a, 'and_p95_over_the_threshold') ?? 0;
    const all = count(a, 'and_no_meaningful_swap_or_wait') ?? 0;
    // The two guardrails remove more than nine in ten of the jobs the rule could reach.
    expect((reachable - overP95) / reachable).toBeGreaterThan(0.9);
    expect(threeRuns).toBeLessThan(reachable * 0.2);
    // The thresholds, on what survives them, remove less than half.
    expect(all).toBeGreaterThan(overP95 * 0.4);
    // And in isolation they are permissive, not tight — which is the opposite of the first pass's conclusion.
    expect((count(a, 'the_two_thresholds_alone') ?? 0) / reachable).toBeGreaterThan(0.7);
    // The whole conjunction speaks about a fraction of a percent of the estate's jobs.
    const jobs = count(fieldEngRow('how many jobs clear the three-run guardrail'), 'jobs') ?? 0;
    expect(all / jobs).toBeLessThan(0.01);
    // A sample floor costs some of the few that survive, so it is a decision and not free.
    expect(count(a, 'and_three_samples_a_run') ?? 0).toBeLessThan(all);
  });

  it('holds the percentiles the threshold argument rests on', () => {
    // Unasserted in the first pass, which the review caught: a re-run moving p95 CPU above 40% would have left
    // the write-up's central sentence false with every test still green.
    const grain = fieldEngRow('the four utilisation distributions at the rules’ own grain');
    const cpu = percentiles(grain.avg_cpu_percentiles);
    const memory = percentiles(grain.avg_memory_percentiles);
    expect(cpu).toHaveLength(6);
    expect(cpu[2]).toBeCloseTo(4.1, 1);
    expect(cpu[5]).toBeCloseTo(30.4, 1);
    expect(memory[2]).toBeCloseTo(26.0, 1);
    expect(memory[5]).toBeCloseTo(79.0, 1);
    const pairs = count(grain, 'run_cluster_pairs') ?? 0;
    expect((count(grain, 'pairs_rule_b_would_consider') ?? 0) / pairs).toBeCloseTo(0.116, 2);
    expect((count(grain, 'pairs_rule_c_would_consider') ?? 0) / pairs).toBeLessThan(0.01);
    // Half the population is averaged over fewer than three one-minute samples.
    expect((count(grain, 'pairs_with_under_three_samples') ?? 0) / pairs).toBeCloseTo(0.482, 2);
    // Swap's nonzero baseline, at run grain, on the same estate the node-minute figure came from.
    expect((count(grain, 'pairs_with_any_swap') ?? 0) / pairs).toBeCloseTo(0.861, 2);
  });

  it("finds rule G's node type readable for about half of the pairs it applies to", () => {
    // Scoped to classic compute. The first pass divided by every run-cluster pair, 85% of which are serverless or
    // warehouse and cannot have a cluster configuration at all, and reported 1.0%.
    const g = fieldEngRow('whether rule G’s inputs exist for classic job clusters');
    const pairs = count(g, 'classic_run_cluster_pairs') ?? 0;
    expect(pairs).toBeGreaterThan(0);
    expect((count(g, 'pairs_with_any_config') ?? 0) / pairs).toBeGreaterThan(0.4);
    // The as-of ordering is what fails, and it fails because an ephemeral cluster's record postdates the run.
    expect((count(g, 'pairs_with_an_as_of_config') ?? 0) / pairs).toBeLessThan(0.15);
    expect(count(g, 'pairs_whose_only_config_postdates_the_run') ?? 0).toBeGreaterThan(
      (count(g, 'pairs_with_any_config') ?? 0) * 0.5
    );
  });

  it("finds rule G's setup overhead absent on the compute it applies to, and null on none of it", () => {
    const g = fieldEngRow('whether rule G’s inputs exist for classic job clusters');
    const pairs = count(g, 'classic_run_cluster_pairs') ?? 0;
    expect((count(g, 'pairs_with_a_setup_figure') ?? 0) / pairs).toBeLessThan(0.01);
    // Zero rather than null, which is the shape a collector divides by. Read at run grain over every run.
    expect(count(fieldEngRow('whether the timing rule G needs is populated'), 'runs_with_no_setup_figure')).toBe(0);
  });

  it('corroborates that absence against a neighbour, as ADR 0074 requires', () => {
    // Without this the reading cannot distinguish "the column is empty" from "this identity cannot see these
    // rows", and the previous row in this family shipped exactly that widening.
    const seen = rowsOf(fieldEng, 'whether the cluster configuration table sees what the node timeline sees');
    const clusters = seen.find((one) => one.relation === 'clusters');
    const timeline = seen.find((one) => one.relation === 'node_timeline');
    expect(count(clusters, 'clusters') ?? 0).toBeGreaterThan(count(timeline, 'clusters') ?? 0);
    expect(count(clusters, 'workspace_ids')).toBe(count(timeline, 'workspace_ids'));
  });

  it('confirms the stated per-run total is unusable, and the derived wall clock is not', () => {
    // At run grain, from the probe that reduces with max() per run. The sibling probe counts distinct run ids per
    // branch over period rows, so a run carrying 0 on one period and a total on another lands in both — which is
    // why the write-up quotes this one.
    const timing = fieldEngRow('whether the timing rule G needs is populated');
    const runs = count(timing, 'runs') ?? 0;
    expect((count(timing, 'runs_with_no_total') ?? 0) / runs).toBeCloseTo(0.792, 2);
    const periods = fieldEngRow('whether the run timeline’s periods agree with the task timeline’s');
    expect(count(periods, 'mean_absolute_difference_seconds')).toBeLessThan(2);
    expect(count(periods, 'runs_absent_from_the_run_timeline')).toBe(0);
  });

  it('finds the three-run guardrail excluding four jobs in five, so it bounds coverage', () => {
    const guardrail = fieldEngRow('how many jobs clear the three-run guardrail');
    const jobs = count(guardrail, 'jobs') ?? 0;
    expect((count(guardrail, 'jobs_with_three_runs') ?? 0) / jobs).toBeCloseTo(0.196, 2);
    expect((count(guardrail, 'jobs_run_once') ?? 0) / jobs).toBeGreaterThan(0.5);
  });

  it('finds cost readable on two jobs in three, with every record naming a run', () => {
    const cost = fieldEngRow('whether job cost is readable');
    expect(fieldEng.readings.jobsWithCostRecords.share).toBeCloseTo(0.675, 2);
    expect(count(cost, 'records_naming_a_run')).toBe(count(cost, 'usage_records'));
    expect(count(cost, 'retraction_records')).toBe(0);
  });

  it('does not claim every run states an outcome, because two do not', () => {
    // The absolute the review caught: a termination code on every `JOB_RUN` is not a termination code on every
    // run, and `SUBMIT_RUN` is where the exceptions are.
    const outcomes = rowsOf(fieldEng, 'whether retry and repair overhead is readable');
    expect(outcomes.some((one) => (count(one, 'result_unstated') ?? 0) > 0)).toBe(true);
  });

  it('finds a minority of task-timeline rows carrying no compute id at all', () => {
    // A ceiling on rules A to D independent of compute kind, and absent from the first pass's table.
    const spellings = fieldEngRow('which spelling of the compute column is populated');
    const share = (count(spellings, 'rows_with_neither') ?? 0) / (count(spellings, 'timeline_rows') ?? 1);
    expect(share).toBeCloseTo(0.289, 2);
  });

  it('finds the utilisation window shorter than the trend beside it, which the report has to say', () => {
    // A span, not a policy: both are bounded by the 400-day probe window, so this cannot distinguish retention
    // from the table's own age. Asserted as the comparison the report has to make, not as a retention figure.
    const held = rowsOf(fieldEng, 'how far back each table goes');
    const nodes = held.find((one) => one.relation === 'node_timeline');
    const tasks = held.find((one) => one.relation === 'job_task_run_timeline');
    expect(count(nodes, 'days_held')).toBeLessThan(count(tasks, 'days_held') ?? 0);
    expect(count(nodes, 'days_held')).toBeLessThan(200);
  });
});
