// What is happening to a Lakeflow job's runs, and what the app is allowed to conclude from it.
//
// Four conditions over the rows `job_run_health.sql` returns, joined to the job definitions
// `jobs_inventory.sql` already reads. The words, the citations and every threshold are data — see
// `job-rules.yaml` — so what is here is the arithmetic, the join and the guardrail.
//
// # Four more conditions read compute, and they read a second row that is usually absent
//
// The audit document's rules A, B, C and G are about worker utilisation, memory pressure and startup, and
// they read `job_compute_utilisation.sql` rather than the row above. That statement is separate because an
// estate running everything on serverless has no `system.compute.node_timeline` rows at all — labs is one,
// and `33ca` measured the join reaching 0 of its 7 jobs — so a job here can have a health row and no compute
// row, and on labs every job does. **Absent is not clean.** A job with no compute row is not assessed by
// these four, `computeRead` on the analysis is how a surface tells that from an estate with nothing wrong,
// and the funnel beside it says how far the reading got.
//
// # Rules D and E are here too, and neither is the rule the document describes
//
// `50` measured both premises and both came back different. D's five conditions reduce to one — the network
// rate — because low CPU selects 98.4% of pairs, CPU wait's p95 is 1.28%, and the two comparing traffic with
// data processed need a denominator `system.query.history` carries for no classic job cluster. So
// `JOB_NETWORK_HEAVY` fires on a rate relative to the estate's median and **may not be called I/O-bound**:
// the words imply the comparison the two dead conditions would have made.
//
// E reads the billing record rather than the cluster configuration, which is the one structural difference
// in this file: it is the only rule of the six about compute that does not take the compute row at all.
// `system.compute.clusters` carries no Photon column, and the reach through billing usage is 96.6% of the
// rule's clusters against the 8.7% the as-of configuration join resolves.
//
// # Why the guardrail is coverage rather than confidence
//
// Every rule requires three runs, which is rule A's own first condition. Measured, that admits 3 of the 7
// jobs on labs. So the analysis reports `eligible` against `sampled` and the surface has to say what it
// covered: a job that ran once is not a job with weak evidence of being healthy, it is a job this audit
// declined to read. Folding that into a confidence score would have turned "not assessed" into "assessed
// and fine", which is the flattering-lie failure the sizing and workload analyses each warn about.
//
// # Why there are two counts of jobs and not one
//
// The statement returns the top `:job_limit` jobs by total wall clock — `H1` is why the cap exists, a row
// per job being 110% of an inline result at 100,000 jobs — and it returns the count of jobs that ran
// before that cap applied. Both are here, as `sampled` and `population`, because the first review of this
// family found the surface holding one field and disclosing the cap only when `shown < population` with
// the two set from the same array: a branch that could not run, guarding the exact sentence the statement's
// header requires. Two fields, and the difference between them is the disclosure.

import type { JobComputeRow, JobRow, JobRunHealthRow } from '../collect/sql/shapes.js';
import { multipleTriggers, triggerRecorded } from '../resolve/resolvers/helpers.js';
import type { Confidence, Evidence } from './rules.js';
import { jobRules, type JobRuleId, type JobRuleset, type Severity, type WorkloadRule } from './workload-rules.js';

export interface JobFinding {
  readonly rule: JobRuleId;
  readonly jobId: string;
  readonly severity: Severity;
  readonly confidence: Confidence;
  /** Never empty, for the reason rules.ts gives: a finding a reader cannot check is one they must trust. */
  readonly evidence: readonly Evidence[];
}

/**
 * Why a job reads the way it does, as one of three states rather than as an empty finding list.
 *
 * `ineligible` is the one that matters, and it is not a lesser `clean`. A job with fewer than three runs in
 * the window was not assessed — rule A's first condition — and reporting it as a job with nothing wrong is
 * a claim about evidence that does not exist. On the estate measured, four of seven jobs are this.
 */
export type JobState = 'advised' | 'clean' | 'ineligible';

export interface JobHealth {
  readonly workspaceId: string;
  readonly jobId: string;
  /** From the inventory. The id itself where no definition could be matched — see `describe`. */
  readonly name: string;
  /** Exact Databricks job page, when the workspace directory could resolve it. */
  readonly link?: string;
  /**
   * Whether the definition carries a quartz schedule, where a definition was matched.
   *
   * Only readable alongside the two fields below. `false` here is three states at once — a job nobody gave
   * a trigger, a definition written before the column existed, and a job with several triggers whose set
   * this app does not read — and resting on it alone is the defect that dropped every manually-started job
   * out of OE-02-04's denominator. `JobRow.scheduledKnown` records the same warning at the source.
   */
  readonly scheduled?: boolean;
  /**
   * Whether the trigger could be read at all: `triggerRecorded` in `resolvers/helpers.ts`, not the raw flag.
   *
   * False on a pre-rollout row, where `scheduled: false` says nothing about the job. A surface has to
   * render nothing there rather than the absence of a schedule.
   */
  readonly triggerRecorded?: boolean;
  /** Whether the row records several triggers, so `scheduled` cannot name any of them. */
  readonly multipleTriggers?: boolean;
  readonly paused?: boolean;
  readonly timeoutSeconds?: number;
  readonly health: JobRunHealthRow;
  /**
   * What the job's classic-cluster workers were doing, where the node join reached it.
   *
   * Absent on every job of an all-serverless estate and on most jobs of a mixed one — 689 of 4,158 on the
   * estate `41b` read. A surface may render its figures where it is here and may not render a zero or a
   * dash where it is not: the four rules over it did not assess the job, which is not the same as assessing
   * it and finding nothing.
   */
  readonly compute?: JobComputeRow;
  readonly state: JobState;
  readonly findings: readonly JobFinding[];
}

export interface JobAnalysis {
  /** The jobs the statement returned, worst finding first, then by how long they ran in total. */
  readonly jobs: readonly JobHealth[];
  readonly findingCount: number;
  /** Jobs with enough runs in the window for any rule to read them, out of `sampled` and not `population`. */
  readonly eligible: number;
  /**
   * Jobs that ran in the window, which is what `sampled` is a sample of.
   *
   * From the statement's own pre-limit count rather than from the rows it returned, and the distinction is
   * the whole reason it is read: with the two collapsed, a surface has no figure the cap can be declared
   * against and reports the longest-running two hundred jobs as the estate's jobs. Falls back to `sampled`
   * where a stored reading predates the column, which understates it and cannot overstate it.
   */
  readonly population: number;
  /** Jobs the statement returned: the longest-running `population` of them, by total wall clock. */
  readonly sampled: number;
  /**
   * How many of those were found in the job inventory.
   *
   * Not a defensive count. A job deleted after it ran leaves its runs in the timeline and no definition to
   * name it, so this is the difference between a name and an id on the surface — the same relation
   * `SizingAnalysis.matched` records for a warehouse, and for the same reason.
   *
   * Out of `sampled`. It is not a coverage figure against `live`: the unmatched share of a capped sample
   * says nothing about the jobs the cap excluded.
   */
  readonly matched: number;
  /** Live jobs the inventory lists, where it was read. Absent rather than zero — see `analyseJobs`. */
  readonly live?: number;
  /**
   * How far the compute reading got, or absent where the statement was not on the plan.
   *
   * Absent and empty are different facts and the surface has to tell them apart: absent is a run that did
   * not ask, and a `computeReach` whose `withWorkerSamples` is zero is a run that asked and found an estate
   * with no classic job compute. Neither is an estate whose clusters are the right size.
   */
  readonly computeRead?: ComputeReach;
  readonly windowDays: number;
  readonly rulesVersion: number;
}

/**
 * The four steps between the estate's jobs and the jobs rules A, B, C and G could read.
 *
 * On the page rather than derivable from the rows, because every step of it is attrition a reader would
 * otherwise attribute to the rules: 4,876 jobs ran on the estate `41b` measured, 4,158 carried a compute id,
 * 689 were reachable by the worker join, and rule A named nine. Quoting the nine against the 4,876 divides a
 * figure about the sample by a figure about the estate, which is the division `jobs-language.test.ts`
 * already forbids this page from making.
 */
export interface ComputeReach {
  readonly thatRan: number;
  readonly withAComputeId: number;
  readonly onClassicCompute: number;
  readonly withWorkerSamples: number;
  /**
   * The window the samples span, where any were read.
   *
   * Here because it is not the window everything else on the page is measured over: `node_timeline` held 94
   * days of rows against the task timeline's 370 on the estate measured, so a utilisation figure beside a
   * duration trend is two windows on one page and the surface has to say so.
   */
  readonly earliestSample?: Date;
  readonly latestSample?: Date;
}

/**
 * The analysis, or `undefined` where there is nothing to analyse.
 *
 * The same distinction the workload, sizing and serverless analyses draw. Here the empty case would render
 * as an estate whose jobs all run cleanly, and a run whose `job_task_run_timeline` read was refused would
 * be indistinguishable from a workspace with no jobs. The readings on the record are what tell those apart.
 */
export function analyseJobs(
  health: readonly JobRunHealthRow[],
  jobs: readonly JobRow[],
  lookbackDays: number,
  ruleset: JobRuleset = jobRules(),
  // Defaulted rather than required, and undefined rather than empty by default, because the two mean
  // different things downstream: a caller with no compute signal on its plan has not measured the estate's
  // classic compute, and a caller that measured it and got nothing has. `computeRead` carries the second.
  compute?: readonly JobComputeRow[]
): JobAnalysis | undefined {
  if (health.length === 0) return undefined;

  const definitions = new Map(jobs.map((row) => [`${row.workspaceId}/${row.jobId}`, row] as const));
  const utilisation = new Map((compute ?? []).map((row) => [`${row.workspaceId}/${row.jobId}`, row] as const));
  const described = health.map((row) =>
    describe(
      row,
      definitions.get(`${row.workspaceId}/${row.jobId}`),
      ruleset,
      utilisation.get(`${row.workspaceId}/${row.jobId}`)
    )
  );

  return {
    jobs: [...described].sort(
      (a, b) =>
        worst(b) - worst(a) || b.health.wallSecondsTotal - a.health.wallSecondsTotal || a.name.localeCompare(b.name)
    ),
    findingCount: described.reduce((total, one) => total + one.findings.length, 0),
    eligible: described.filter((one) => one.state !== 'ineligible').length,
    // The statement's own count of jobs that ran, which every row repeats. A stored reading from before
    // that column existed parses as zero, and a population below the sample it contains is not a
    // population — so the sample's length is the floor rather than a default.
    population: Math.max(health[0]?.jobPopulation ?? 0, described.length),
    sampled: described.length,
    matched: described.filter((one) => definitions.has(`${one.workspaceId}/${one.jobId}`)).length,
    // Absent rather than zero where the inventory was not read, for the reason `SizingAnalysis.live` is:
    // a denominator of nothing makes a surface report that every job in the estate was measured.
    ...(jobs.length > 0 ? { live: jobs.length } : {}),
    ...(compute != null ? { computeRead: reachOf(compute, utilisation.size) } : {}),
    windowDays: lookbackDays,
    rulesVersion: ruleset.version,
  };
}

/**
 * The funnel, from whichever row carries it, and zeros where the statement returned nothing.
 *
 * The first three figures are the statement's own counts over the window and every row repeats them, so any
 * row will do. The fourth is the rows themselves. An all-serverless estate returns no rows, and then all
 * four are zero — which is a reading and not a missing one, because the caller passed an array.
 */
function reachOf(compute: readonly JobComputeRow[], reached: number): ComputeReach {
  const first = compute[0];
  const earliest = compute.map((row) => row.earliestSample).filter((at): at is Date => at != null);
  const latest = compute.map((row) => row.latestSample).filter((at): at is Date => at != null);

  return {
    thatRan: first?.jobsThatRan ?? 0,
    withAComputeId: first?.jobsWithAComputeId ?? 0,
    onClassicCompute: first?.jobsOnClassicCompute ?? 0,
    withWorkerSamples: reached,
    ...(earliest.length > 0 ? { earliestSample: new Date(Math.min(...earliest.map((at) => at.getTime()))) } : {}),
    ...(latest.length > 0 ? { latestSample: new Date(Math.max(...latest.map((at) => at.getTime()))) } : {}),
  };
}

/** The severity of a job's worst finding, as a sort key. Zero where it has none. */
function worst(one: JobHealth): number {
  return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}

const RANK: Readonly<Record<Severity, number>> = { critical: 0, high: 1, medium: 2, info: 3 };

/**
 * The eligibility floor, read from whichever rule declares it.
 *
 * Every rule requires three runs and they all mean the same three, so the state is decided once rather
 * than by whether any rule happened to fire. A job below the floor is `ineligible` and gets no findings at
 * all, including from the rule whose own threshold it might have cleared.
 */
function floorOf(ruleset: JobRuleset): number {
  return ruleset.rules.get('JOB_LONG_RUNNING')?.thresholds['min_runs'] ?? 3;
}

function describe(
  row: JobRunHealthRow,
  definition: JobRow | undefined,
  ruleset: JobRuleset,
  compute: JobComputeRow | undefined
): JobHealth {
  const eligible = row.runs >= floorOf(ruleset);
  const findings = eligible ? findingsFor(row, ruleset, compute) : [];

  return {
    workspaceId: row.workspaceId,
    jobId: row.jobId,
    // The id rather than a placeholder, and a real case rather than a defensive one: a job deleted after
    // it ran leaves its runs in the timeline and no live definition to name it.
    name: definition?.name ?? row.jobId,
    // All three together or none of them. `scheduled` on its own is a flag whose false is undecidable, so
    // it travels with the predicate that decides whether it can be read and with the marker that says it
    // names nothing — the pair `resolvers/helpers.ts` exists to keep callers from reimplementing wrongly.
    ...(definition != null && {
      scheduled: definition.scheduled,
      triggerRecorded: triggerRecorded(definition),
      multipleTriggers: multipleTriggers(definition),
    }),
    ...(definition?.paused != null && { paused: definition.paused }),
    ...(definition?.timeoutSeconds != null && { timeoutSeconds: definition.timeoutSeconds }),
    health: row,
    ...(compute != null && { compute }),
    // Still three states and not four. A job with no compute row is not `ineligible`: the four timeline
    // rules did read it, and calling the whole job unassessed because half the inputs are missing would be
    // the same overstatement in the other direction. What says the compute half went unread is `compute`
    // being absent, which is a fact about that half and about nothing else.
    state: !eligible ? 'ineligible' : findings.length > 0 ? 'advised' : 'clean',
    findings,
  };
}

function findingsFor(
  row: JobRunHealthRow,
  ruleset: JobRuleset,
  compute: JobComputeRow | undefined
): readonly JobFinding[] {
  const found = CONDITIONS.flatMap((condition) => {
    const rule = ruleset.rules.get(condition.id);
    if (rule == null) return [];
    const hit = condition.test(row, rule, compute);
    return hit == null ? [] : [{ rule: condition.id, jobId: row.jobId, ...hit }];
  });

  return [...found].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}

function order(id: JobRuleId): number {
  return CONDITIONS.findIndex((condition) => condition.id === id);
}

/** Seconds as milliseconds, which is the unit `Evidence` carries a duration in. */
function ms(seconds: number): number {
  return Math.round(seconds * 1000);
}

type Hit = Pick<JobFinding, 'severity' | 'confidence' | 'evidence'>;

interface Condition {
  readonly id: JobRuleId;
  readonly test: (row: JobRunHealthRow, rule: WorkloadRule, compute: JobComputeRow | undefined) => Hit | undefined;
}

/**
 * A percentage rounded the way every one of these rules reports one, to a tenth.
 *
 * The statement already rounds to two decimals; this is so a finding's evidence reads the same as the rest
 * of the page rather than at a precision the samples behind it do not support.
 */
function pct(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * The pairs a utilisation rule may read a mean from, or `undefined` where the job has too few.
 *
 * Two conditions in one place because the four rules apply the same two, and because getting either wrong
 * is silent: a job with no compute row would otherwise read as one whose workers were idle, and a job whose
 * every pair holds one sample would read as one whose mean was measured. 48.2% of pairs on the estate `41b`
 * measured are the second.
 */
function sampled(compute: JobComputeRow | undefined, rule: WorkloadRule): number | undefined {
  if (compute == null) return undefined;
  const usable = compute.runClusterPairs - compute.pairsBelowThreeSamples;
  return usable >= rule.thresholds['min_sampled_pairs'] ? usable : undefined;
}

/**
 * The two lines every utilisation finding ends with.
 *
 * The pair count and the node type, and the node type only where the as-of configuration join resolved it.
 * `47` decided that: relaxing the ordering would name a type for 53.6% of pairs instead of 8.7%, and every
 * pair in the difference has its only configuration record written *after* the run it would be attributed
 * to. So the finding recommends the direction without the name rather than naming the wrong cluster.
 */
function computeEvidence(compute: JobComputeRow, usable: number): readonly Evidence[] {
  return [
    { label: 'Runs and clusters read', value: usable, unit: 'count' },
    // The name goes in the label and the count in the value, the way the busiest-task finding carries its
    // task key. The count is the point: it is how many of the job's pairs that name was read from, so a
    // type resolved on one pair of forty cannot be rendered as the job's compute.
    ...(compute.nodeType != null
      ? [{ label: `Runs on "${compute.nodeType}"`, value: compute.pairsWithAnAsOfConfig, unit: 'count' as const }]
      : []),
  ];
}

/**
 * The conditions, in the order they should be read: what went wrong, then what it costs.
 *
 * Failure first and duration second, which is the opposite of the audit document's query order and
 * deliberate. A job whose runs do not succeed is not a job to resize, and a page led by "this job is slow"
 * invites a reader to make it faster at failing.
 */
const CONDITIONS: readonly Condition[] = [
  {
    id: 'JOB_RUNS_NOT_SUCCEEDING',
    test: (row, rule) => {
      // Both counts from the run timeline, and the share is over the runs that stated an outcome rather
      // than over every terminal period: `runsUnresolved` is a run in flight or one the table has not
      // finished writing, and counting it as a success or a failure would be a claim about a run that has
      // not finished. Absent where the run timeline had no row for this job, which is not zero failures.
      const succeeded = row.runsSucceeded;
      const failed = row.runsDidNotSucceed;
      if (succeeded == null || failed == null) return undefined;
      const resolved = succeeded + failed;
      if (resolved < rule.thresholds['min_resolved_runs']) return undefined;
      const share = failed / resolved;
      if (share < rule.thresholds['unsuccessful_share']) return undefined;
      return {
        severity: share >= rule.thresholds['critical_unsuccessful_share'] ? 'critical' : rule.severity,
        // The platform records the terminal state. There is no inference between "did not succeed" and
        // "failed", which is why the rule's words say the first — a cancelled run is in this count and is
        // not a failure.
        confidence: 'high',
        evidence: [
          { label: 'Runs that did not succeed', value: failed, unit: 'count' },
          { label: 'Runs that stated an outcome', value: resolved, unit: 'count' },
          { label: 'Share that did not succeed', value: Math.round(share * 1000) / 10, unit: 'percent' },
          // Only where there is one. A zero here would read as a job whose runs all ended cleanly, which
          // is the opposite of what this finding is about.
          ...(row.runsUnresolved != null && row.runsUnresolved > 0
            ? [{ label: 'Runs with no outcome yet', value: row.runsUnresolved, unit: 'count' as const }]
            : []),
        ],
      };
    },
  },
  {
    id: 'JOB_TASKS_RUN_AGAIN',
    test: (row, rule) => {
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      const share = row.runsWithARepeatedTask / row.runs;
      if (share < rule.thresholds['repeating_share']) return undefined;
      return {
        severity: rule.severity,
        // The extra task runs are counted. What is inferred is nothing: the rule's words stop at "ran
        // again" because the platform does not record whether a person or the scheduler asked for it, and
        // `moderate` is what a finding whose cause is genuinely unknown gets.
        confidence: 'moderate',
        evidence: [
          { label: 'Runs in which a task ran again', value: row.runsWithARepeatedTask, unit: 'count' },
          { label: 'Runs in the window', value: row.runs, unit: 'count' },
          { label: 'Extra task runs', value: row.repeatedTaskRuns, unit: 'count' },
        ],
      };
    },
  },
  {
    id: 'JOB_LONG_RUNNING',
    test: (row, rule) => {
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      if (row.wallSecondsP95 < rule.thresholds['p95_seconds']) return undefined;
      return {
        severity: rule.severity,
        // The wall clock is derived from the timeline's period endpoints, which `33ca` measured against the
        // run timeline's own to a mean of half a second. What is not known is why it is slow, and the
        // rule's words say so — so `moderate` rather than `high`, on a measurement that is solid.
        confidence: 'moderate',
        evidence: [
          // Milliseconds, because that is the unit `Evidence` has for a duration and the surface already
          // formats it. The statement derives seconds, so these are exact rather than rescaled estimates.
          { label: 'Slowest 5% of runs took', value: ms(row.wallSecondsP95), unit: 'ms' },
          { label: 'Median run', value: ms(row.wallSecondsMedian), unit: 'ms' },
          { label: 'Longest run', value: ms(row.wallSecondsMax), unit: 'ms' },
          { label: 'Runs in the window', value: row.runs, unit: 'count' },
        ],
      };
    },
  },
  {
    id: 'JOB_DOMINATED_BY_ONE_TASK',
    test: (row, rule) => {
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      // Two tasks at least, and this is the measured part of the rule rather than a guard: a single-task
      // job holds all of its task time in its one task as arithmetic, and six of the seven jobs measured
      // read exactly 1.0. Firing there would report a fact about counting as a finding about the job.
      if (row.tasksMost < rule.thresholds['min_tasks']) return undefined;
      const busiest = row.busiestTaskSeconds;
      if (busiest == null || row.taskSecondsTotal <= 0) return undefined;
      const share = busiest / row.taskSecondsTotal;
      if (share < rule.thresholds['busiest_share']) return undefined;
      return {
        severity: rule.severity,
        // Both figures are sums of measured task time and the share is arithmetic over them. That the task
        // is therefore the thing to change is the inference, and it holds only while the job's tasks run in
        // parallel — a job whose tasks are a chain has a critical path this cannot see.
        confidence: 'moderate',
        evidence: [
          ...(row.busiestTaskKey != null
            ? [{ label: `Time in "${row.busiestTaskKey}"`, value: ms(busiest), unit: 'ms' as const }]
            : [{ label: 'Time in the busiest task', value: ms(busiest), unit: 'ms' as const }]),
          { label: 'Task time across the job', value: ms(row.taskSecondsTotal), unit: 'ms' },
          { label: 'Share in that one task', value: Math.round(share * 1000) / 10, unit: 'percent' },
          { label: 'Tasks at most', value: row.tasksMost, unit: 'count' },
        ],
      };
    },
  },
  {
    id: 'JOB_WORKERS_UNDERUSED',
    test: (row, rule, compute) => {
      const usable = sampled(compute, rule);
      if (compute == null || usable == null) return undefined;
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      // The document's own runtime condition, and the single largest piece of this rule's attrition: 75 of
      // the 97 jobs that clear the run minimum are removed here. It stays because it is the difference
      // between an idle cluster worth resizing and one that was idle for ninety seconds.
      if (row.wallSecondsP95 < rule.thresholds['p95_seconds']) return undefined;
      if (compute.avgCpuPercent >= rule.thresholds['cpu_percent']) return undefined;
      if (compute.avgMemoryPercent >= rule.thresholds['memory_percent']) return undefined;
      // The two conditions that say the idleness is not explained by something else. Swap is tested above a
      // threshold rather than at zero because `mem_swap_percent > 0` fires on 95% of node-minutes at a
      // median of 0.05% — the document's "no swap" as written is a condition nothing meets.
      if (compute.avgSwapPercent >= rule.thresholds['swap_percent']) return undefined;
      if (compute.avgCpuWaitPercent >= rule.thresholds['cpu_wait_percent']) return undefined;
      return {
        severity: rule.severity,
        // The utilisation is measured and that the cluster is therefore too large is inferred. It holds
        // only while the run's work is spread over the run: a burst inside a long window averages the same
        // as a job that never got busy, and nothing here separates them.
        confidence: 'moderate',
        evidence: [
          { label: 'Average worker CPU', value: pct(compute.avgCpuPercent), unit: 'percent' },
          { label: 'Average worker memory', value: pct(compute.avgMemoryPercent), unit: 'percent' },
          { label: 'Slowest 5% of runs took', value: ms(row.wallSecondsP95), unit: 'ms' },
          ...computeEvidence(compute, usable),
        ],
      };
    },
  },
  {
    id: 'JOB_MEMORY_BOUND',
    test: (row, rule, compute) => {
      const usable = sampled(compute, rule);
      if (compute == null || usable == null) return undefined;
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      // The document writes this as a disjunction and both halves are here. The average clause is the one
      // `41b` measured — 11.6% of pairs — so what the peak clause adds on top of it is not known, which
      // makes the measured selection a lower bound rather than the rule's population.
      const onAverage = compute.avgMemoryPercent >= rule.thresholds['memory_percent'];
      const atPeak = compute.peakMemoryPercent >= rule.thresholds['peak_memory_percent'];
      if (!onAverage && !atPeak) return undefined;
      return {
        severity: rule.severity,
        // Memory near a ceiling is measured; that it is the job's limit is inferred, and the peak clause
        // infers more than the average one does — a single minute at 90% is not a job short of memory.
        confidence: onAverage ? 'moderate' : 'low',
        evidence: [
          { label: 'Average worker memory', value: pct(compute.avgMemoryPercent), unit: 'percent' },
          { label: 'Peak worker memory', value: pct(compute.peakMemoryPercent), unit: 'percent' },
          ...computeEvidence(compute, usable),
        ],
      };
    },
  },
  {
    id: 'JOB_COMPUTE_BOUND',
    test: (row, rule, compute) => {
      const usable = sampled(compute, rule);
      if (compute == null || usable == null) return undefined;
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      if (compute.avgCpuPercent < rule.thresholds['cpu_percent']) return undefined;
      if (compute.avgMemoryPercent >= rule.thresholds['memory_percent']) return undefined;
      if (compute.avgCpuWaitPercent >= rule.thresholds['cpu_wait_percent']) return undefined;
      return {
        severity: rule.severity,
        // The same standing as rule A and the mirror image of it. What is not readable at all is whether
        // Photon is on, which the document names as the other lever — that is rule E and ledger row `51`.
        confidence: 'moderate',
        evidence: [
          { label: 'Average worker CPU', value: pct(compute.avgCpuPercent), unit: 'percent' },
          { label: 'Average worker memory', value: pct(compute.avgMemoryPercent), unit: 'percent' },
          { label: 'Time waiting on storage', value: pct(compute.avgCpuWaitPercent), unit: 'percent' },
          ...computeEvidence(compute, usable),
        ],
      };
    },
  },
  {
    id: 'JOB_STARTUP_OVERHEAD',
    test: (row, rule, compute) => {
      if (compute == null) return undefined;
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      // No sample floor: setup is a run-level figure the platform states rather than a mean over
      // node-minutes. What is required instead is that the figure was read at all. A null is unread and a
      // zero is a measured absence of a setup phase — ADR 0074 — and this rule may only speak about the
      // second, so a job whose runs all carried a null says nothing here rather than saying zero.
      const setup = compute.setupSecondsMean;
      const stated = compute.statedRunSecondsMean;
      if (setup == null || setup < rule.thresholds['setup_seconds']) return undefined;
      // `33ca` measured `run_duration_seconds` written as zero on all 44 runs on labs, so the denominator
      // has to be checked rather than assumed. Dividing by it where it is zero would report every run as
      // infinitely dominated by its own setup.
      if (stated == null || stated <= 0) return undefined;
      const share = setup / stated;
      if (share < rule.thresholds['setup_share']) return undefined;
      return {
        severity: rule.severity,
        // Both figures are the platform's own and the share is arithmetic over them. What is inferred is
        // that a pool would remove it, and that depends on how often the job runs — which the finding's
        // words say rather than assume.
        confidence: 'moderate',
        evidence: [
          { label: 'Average setup per run', value: ms(setup), unit: 'ms' },
          { label: 'Average run as the platform states it', value: ms(stated), unit: 'ms' },
          { label: 'Share spent starting the cluster', value: pct(share * 100), unit: 'percent' },
          // Only where some run carried no figure at all. A zero here would read as a job whose runs were
          // all measured, which is the distinction this line exists to make.
          ...(compute.runsWithNoSetupFigure > 0
            ? [{ label: 'Runs with no setup figure', value: compute.runsWithNoSetupFigure, unit: 'count' as const }]
            : []),
        ],
      };
    },
  },
  {
    id: 'JOB_NETWORK_HEAVY',
    test: (row, rule, compute) => {
      if (compute == null) return undefined;
      if (row.runs < rule.thresholds['min_runs']) return undefined;
      // The pair floor is over the pairs that have a rate rather than over the pairs with three samples,
      // because a rate needs node-minutes and a mean needs samples and they are different denominators.
      if (compute.pairsWithANetworkRate < rule.thresholds['min_sampled_pairs']) return undefined;
      const rate = compute.networkBytesPerNodeMinute;
      const median = compute.estateMedianBytesPerNodeMinute;
      // Both absent on an estate no pair of which ran long enough to have a rate, and the estate's own
      // median is the comparison — so a workspace with too few pairs for a middle gets no finding rather
      // than a finding against a middle of one.
      if (rate == null || median == null || median <= 0) return undefined;
      if (compute.estatePairsWithARate < rule.thresholds['min_estate_pairs']) return undefined;
      if (rate < rule.thresholds['min_bytes_per_node_minute']) return undefined;
      if (rate / median < rule.thresholds['median_multiple']) return undefined;
      return {
        severity: rule.severity,
        // The rate is measured and the comparison is arithmetic. What is inferred is that the traffic is
        // worth acting on, and `low` rather than `moderate` because the condition that would have said so
        // — traffic against data processed — is the one `50` found unanswerable. This names a magnitude.
        confidence: 'low',
        evidence: [
          { label: 'Network per minute of worker time', value: Math.round(rate), unit: 'bytes' },
          { label: 'This workspace’s median, over every pair with a rate', value: Math.round(median), unit: 'bytes' },
          // `multiple` and not `ratio`: the contract renders a ratio as a percentage, and fifty times the
          // median rendered as 5,000% is the same number saying something else.
          { label: 'Times the median', value: Math.round((rate / median) * 10) / 10, unit: 'multiple' },
          { label: 'Runs and clusters with a rate', value: compute.pairsWithANetworkRate, unit: 'count' },
          // Only where some pair was silent. A zero would read as a reading that covered everything, and
          // a pair whose every sample stated no figure sums to zero rather than to nothing.
          ...(compute.pairsStatingNoNetwork > 0
            ? [
                {
                  label: 'Runs and clusters that stated no figure',
                  value: compute.pairsStatingNoNetwork,
                  unit: 'count' as const,
                },
              ]
            : []),
        ],
      };
    },
  },
  {
    id: 'JOB_PHOTON_OFF',
    test: (row, rule) => {
      // No compute row and no `min_runs`. Both are the shape of this rule rather than an oversight: the
      // input is a count of billing records, which exists wherever the job billed classic usage, and a job
      // billing a hundred records over two runs is as readable as one billing them over ten.
      const stated = row.classicRecordsStatingPhoton;
      const off = row.classicRecordsWithPhotonOff;
      // Absent is a reading that did not return the column — a stored analysis from before `51` — and it
      // is not a job with Photon on. Zero stated is a job with no classic usage, or one whose records say
      // nothing, and neither of those is Photon off either.
      if (stated == null || off == null) return undefined;
      if (stated < rule.thresholds['min_photon_records']) return undefined;
      const share = off / stated;
      if (share < rule.thresholds['photon_off_share']) return undefined;
      return {
        severity: rule.severity,
        // The field is the platform's own and states the setting rather than implying it — which is the
        // whole reason this reads billing usage and not `dbr_version`, where Photon is a substring that
        // says yes and never says no. What is inferred is that turning it on would help, and that depends
        // on the work: the rule's words say so rather than assuming it.
        confidence: 'high',
        evidence: [
          { label: 'Usage records with Photon off', value: off, unit: 'count' },
          { label: 'Non-serverless usage records that state it', value: stated, unit: 'count' },
          { label: 'Share with it off', value: Math.round(share * 1000) / 10, unit: 'percent' },
          // Only where some record said nothing. Stated minus off is not "on": a record with no
          // `is_photon` is unread, and this is the line that keeps the two apart.
          ...(row.classicUsageRecords != null && row.classicUsageRecords > stated
            ? [
                {
                  label: 'Non-serverless records that state nothing',
                  value: row.classicUsageRecords - stated,
                  unit: 'count' as const,
                },
              ]
            : []),
        ],
      };
    },
  },
];
