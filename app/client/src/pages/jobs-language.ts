// The words the jobs page uses, and what each one may not say.
//
// The formatting helpers are the workloads page's — `duration`, `evidencePhrase`, the severity and
// confidence labels — imported rather than repeated, so a reader moving between the four Optimisation
// pages does not find a duration rendered at two scales.
//
// This file is written the way `schedule-language.ts` is, and for the same reason: every sentence here
// carries a fact about a Lakeflow job read out of two timelines and a billing table, and a sentence more
// specific than the field under it is a sentence a reader cannot check and will act on anyway. What each
// one may not say is recorded next to it.
//
// The four traps this page is closest to, all of them the ones that cost a day on the schedule panel:
//
//   **A count no field carries.** `runsWithARepeatedTask` is runs in which *a* task ran again. Not which
//   task, not how many tasks, and not why — so "the task that was retried" is two claims the payload does
//   not hold, and "retried" is a third. `REPEAT_NOTE` says what it does hold.
//
//   **A verb about what the platform will do.** Nothing here may say a job will run again, will retry,
//   or will next run at a time. The payload has no schedule and no queue: `scheduled` says a definition
//   carries a quartz expression, which is not a prediction and not this run's history either.
//
//   **A total read.** "This job always fails" and "nothing succeeded" are absolutes over a window and a
//   sample. `runs` is runs the task timeline saw in the last `windowDays` days, and the list is the
//   longest-running `sampled` of `population` jobs rather than the estate.
//
//   **An outcome inferred from a blank.** Every outcome count is optional, because a run the task
//   timeline saw may have no run-level row. Absent is "the run timeline said nothing about this job",
//   which is not "no run failed" — so `outcomeSentence` returns nothing rather than a zero.

import { CircleDashed, HeartPulse, Repeat, ShieldCheck, Timer, type LucideIcon } from 'lucide-react';
import type { JobHealth, JobState, Jobs } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';
import { bytes, duration } from './workload-language';

/** Advised first: the page is ordered by whether there is anything to do about a job. */
export const JOB_STATES: readonly JobState[] = ['advised', 'clean', 'ineligible'];

export const STATE_LABEL: Readonly<Record<JobState, string>> = {
  advised: 'Something to look at',
  clean: 'Nothing fired on it',
  // Not "too few runs", which reads as a fault of the job. The audit declined to read it.
  ineligible: 'Not assessed',
};

/** Only "something to look at" is coloured. The other two are states rather than grades. */
export const STATE_TONE: Readonly<Record<JobState, Tone>> = {
  advised: 'warning',
  clean: 'success',
  ineligible: 'neutral',
};

export const STATE_ICON: Readonly<Record<JobState, LucideIcon>> = {
  advised: HeartPulse,
  clean: ShieldCheck,
  ineligible: CircleDashed,
};

/**
 * What each state means, said in full.
 *
 * `ineligible` is the one this page exists to keep honest, and it is not a quieter `clean`. Every rule
 * requires three runs in the window — the audit document's own first condition — and a job below that got
 * no rule applied to it at all, including one whose threshold it might have cleared. On the estate this
 * was measured against, four of seven jobs are this. Rendering it as an empty finding list would have
 * turned "not assessed" into "assessed and fine".
 */
export const STATE_DETAIL: Readonly<Record<JobState, string>> = {
  advised:
    'At least one rule fired on how this job’s runs went. Each finding carries the figures behind it; the ' +
    'order is what went wrong first and how long it took last.',
  clean:
    'This job had enough runs in the window to be read, and no rule fired on them. That is a statement about ' +
    'how the runs went — how they ended, whether a task ran again, how long the slowest runs took, and where ' +
    'the time went. Whether it also covers the job’s compute depends on whether this job ran on a classic ' +
    'cluster this reading could reach, and whether it covers the engine depends on whether the job billed ' +
    'non-serverless usage. The row says both.',
  ineligible:
    'Fewer than three runs in the window, so no rule was applied to this job. Three is the audit’s own ' +
    'minimum: a threshold over one or two runs describes a night rather than a job. This is not a job with ' +
    'nothing wrong — it is one this analysis declined to read, and its figures below are what the window saw.',
};

/**
 * The four facts a badge needs about a state, resolved through a function rather than four lookups.
 *
 * The same reason `warehouse-language.ts` does it: an advisory is stored, a stored one outlives the build
 * that wrote it, and indexing straight into an icon record handed React `undefined` where a component goes
 * and turned a page into an error boundary. An unrecognised state gets a badge and a sentence saying the
 * record was written by another build, which is the honest rendering — the app cannot say what a word it
 * does not know means.
 */
export interface StateFacts {
  readonly label: string;
  readonly tone: Tone;
  readonly Icon: LucideIcon;
  readonly detail: string;
}

export function stateFacts(state: JobState): StateFacts {
  const label = STATE_LABEL[state] as string | undefined;
  if (label != null) {
    return { label, tone: STATE_TONE[state], Icon: STATE_ICON[state], detail: STATE_DETAIL[state] };
  }
  return {
    label: 'State not recognised',
    tone: 'neutral',
    Icon: CircleDashed,
    detail:
      'This analysis records a state this build of the app has no name for, so it was produced by a ' +
      'different version. The job and its figures are shown as they were recorded; the verdict is not, ' +
      'because translating one would mean guessing what it meant. Run the advisor again for a reading this ' +
      'build can describe.',
  };
}

export const NOT_SCORED = 'Not scored';

export const JOBS_ICON = Timer;
export const REPEAT_ICON = Repeat;

/**
 * Where the estate's jobs stand, for the page's opening line.
 *
 * Three numbers rather than one, because the reader would otherwise reconcile them wrongly: how many jobs
 * the window saw, how many of those had enough runs to be read, and how many findings came out. The middle
 * one is the coverage figure and it is deliberately not a confidence score — see `STATE_DETAIL`.
 */
export function jobsSentence(analysis: Jobs): string {
  const window = `${String(analysis.windowDays)} days`;
  const jobs = `${String(analysis.population)} job${analysis.population === 1 ? '' : 's'} ran in the last ${window}`;
  // Out of what was read, which is not out of what ran. The eligible count is over the sample, so on a
  // capped reading the subject has to change with it or the sentence divides the estate by the sample.
  const those = analysis.sampled < analysis.population ? 'of those read' : 'of them';
  const read =
    analysis.eligible === analysis.sampled
      ? `All ${those === 'of them' ? 'of them' : 'of the ones read'} ran often enough to be read`
      : `${String(analysis.eligible)} ${those} ran three or more times, which is what these rules need to read a job`;
  const found =
    analysis.findingCount === 0
      ? 'nothing fired on those'
      : `${String(analysis.findingCount)} finding${analysis.findingCount === 1 ? '' : 's'} came out`;
  return `${jobs}. ${read}, and ${found}.`;
}

/**
 * What the list is a sample of, and what it is not.
 *
 * Two disclosures, both required by a field, and both were wrong in the first version of this page for the
 * same reason: they were phrased over `population` when that field held the sample's own length. The cap
 * clause could not run — the comparison was an array against its own length — and the quiet clause read
 * `live` minus `matched`, so every job that ran outside the top `job_limit` was reported as a job that
 * never ran. On a ten-thousand-job estate the page said nine thousand eight hundred jobs did not run.
 *
 * So: `population` is what the statement counted before its limit, `sampled` is what it returned, and the
 * gap between them is the first clause. `live` minus `population` is the second — jobs the inventory lists
 * that the window recorded no run of, which is ordinary and reads as a missing page until it is said. It is
 * clamped at zero because a job that ran and was then deleted is in one count and not the other.
 *
 * Absent where neither applies, because a disclosure about a limit that did not bite is noise.
 */
export function coverageSentence(analysis: Jobs): string | undefined {
  const capped =
    analysis.sampled < analysis.population
      ? `Showing the ${String(analysis.sampled)} longest-running of the ${String(analysis.population)} jobs that ran — the rest ran for less time in total than any of these.`
      : undefined;
  const live = analysis.live;
  const quiet = live == null ? 0 : Math.max(live - analysis.population, 0);
  const rest =
    quiet > 0
      ? `${String(quiet)} of the estate’s ${String(live ?? 0)} jobs did not run in the window, so there is nothing recorded to read them from.`
      : undefined;
  return [capped, rest].filter((part): part is string => part != null).join(' ') || undefined;
}

/**
 * The label on the filter that clears the others, which is a count and therefore a claim.
 *
 * "Ran in the window (200)" is true only where nothing was capped. On a capped reading the chip counts the
 * sample, so it names the sample — a chip is the shortest thing on the page and the easiest to read as the
 * estate.
 */
export function allFilterLabel(analysis: Jobs): string {
  const shown = String(analysis.sampled);
  return analysis.sampled < analysis.population ? `Longest-running (${shown})` : `Ran in the window (${shown})`;
}

/**
 * Which ruleset produced this, and over what window.
 *
 * The rule count changes with the reading and not with the ruleset, which is the trap here: ten rules
 * loaded is not ten rules applied. Four read the two Lakeflow timelines and apply to every job; five read
 * machine telemetry that exists only for classic compute, so on an all-serverless estate they applied to
 * nothing. Saying "ten rules" over a run where five of them had no input is the flattering count.
 *
 * The tenth is neither, and that is why it has its own clause rather than being counted with the five it
 * resembles. `JOB_PHOTON_OFF` reads the billing record, which exists wherever the job billed classic usage
 * — `50` measured that at 96.6% of the clusters against the worker join's reach — so it applies on a run
 * where the machine telemetry was empty and it applies to nothing on a wholly serverless estate. The
 * payload cannot tell those apart at the estate level, so the clause says what the rule reads rather than
 * how far it got.
 */
export function rulesSentence(analysis: Jobs): string {
  const preamble =
    `Assessed against job rule set ${String(analysis.rulesVersion)} over ${String(analysis.windowDays)} days of ` +
    'run history. Four rules over how the runs went — how they ended, whether a task ran again, how long the ' +
    'slowest runs took, and whether one task holds the job’s time. One more reads whether the job’s ' +
    'non-serverless usage billed with Photon on.';
  const reach = analysis.computeRead;
  if (reach == null) {
    return `${preamble} Nothing was read about the machines those runs ran on.`;
  }
  return reach.withWorkerSamples === 0
    ? `${preamble} Five more read worker CPU, memory, startup and network on classic clusters, and no job here ran on one.`
    : `${preamble} Five more read worker CPU, memory, startup and network, on the ${String(reach.withWorkerSamples)} job${reach.withWorkerSamples === 1 ? '' : 's'} that ran on a classic cluster this could reach.`;
}

/**
 * How the job ran, as the row's second line.
 *
 * Runs and total wall clock, which are the two figures the ordering is by. Nothing about outcomes here: an
 * outcome is optional and a row that silently omitted it on the jobs whose run timeline was blank would
 * read as a job whose runs were fine.
 */
export function runsLine(job: JobHealth): string {
  const runs = `${job.runs.toLocaleString()} run${job.runs === 1 ? '' : 's'}`;
  return `${runs} · ${duration(job.totalMs)} in total · ${duration(job.medianMs)} median`;
}

/**
 * How the runs ended, where the run timeline said.
 *
 * Absent rather than zeroed where it did not, which is the trap this function exists for: the two
 * timelines are different tables, and a run the task timeline saw may have no run-level row at all. A
 * sentence reading "0 of 12 runs did not succeed" over that blank would be an outcome invented from a
 * missing join.
 *
 * The unresolved count is named rather than folded in. A run whose terminal period states no result is in
 * flight or is one the table has not finished writing, and both are unknown — so the share below is over
 * the runs that stated an outcome and the sentence says which denominator it used.
 *
 * What the unresolved clause may not do is imply it closes the arithmetic. It said "N more" once, and the
 * word made a promise the fields cannot keep: `runs` comes from the task timeline and `runsWithATerminalPeriod`
 * from the run timeline, so twelve runs can carry six terminal periods and "1 of 6 did not succeed, 2 more
 * had no outcome" leaves four runs unaccounted for while reading as a complete division. The shortfall
 * between the two timelines is now its own clause, named for what it is.
 */
export function outcomeSentence(job: JobHealth): string | undefined {
  const succeeded = job.runsSucceeded;
  const failed = job.runsDidNotSucceed;
  if (succeeded == null || failed == null) return undefined;
  const resolved = succeeded + failed;
  const unresolved = job.runsUnresolved ?? 0;
  const pending =
    unresolved > 0
      ? ` ${String(unresolved)} finished a period without an outcome, so ${unresolved === 1 ? 'it is' : 'they are'} in neither count.`
      : '';
  // Runs the task timeline saw that the run timeline has written no terminal period for. Clamped at zero:
  // the run timeline can be ahead as well as behind, and a negative here is a fact about write order.
  const missing = job.runsWithATerminalPeriod == null ? 0 : Math.max(job.runs - job.runsWithATerminalPeriod, 0);
  const absent =
    missing > 0
      ? ` The run timeline has no terminal period for ${String(missing)} of this job’s ${job.runs.toLocaleString()} runs, so ${missing === 1 ? 'that one is' : 'those are'} outside every count here.`
      : '';

  if (resolved === 0) {
    return unresolved > 0
      ? `None of this job’s runs has a recorded outcome yet — ${String(unresolved)} finished a period without one.${absent}`
      : undefined;
  }
  const share = Math.round((failed / resolved) * 1000) / 10;
  // "Did not succeed" throughout, because that is what the platform's terminal state says. A cancelled run
  // is in this count and is not a failure, and the app cannot tell them apart.
  return (
    `${String(failed)} of ${String(resolved)} runs that recorded an outcome did not succeed — ${String(share)}%.${pending}${absent}`
  );
}

/**
 * That a task ran more than once, said at the grain the platform records it.
 *
 * The name of this function is the point. `33ca` measured the audit document's own retry query returning
 * zero on a workspace where 16 of 44 runs ran a task twice, because a retry adds a task run and not a
 * run-level period — so the observable thing is a repeated `task_key` inside one run. What is *not*
 * observable is who asked for it: an automatic retry and a person repairing the run arrive here
 * identically, so this sentence stops at "ran again" and says why it stops.
 */
export function repeatSentence(job: JobHealth): string | undefined {
  if (job.runsWithARepeatedTask === 0) return undefined;
  const runs = `${String(job.runsWithARepeatedTask)} of ${job.runs.toLocaleString()} runs`;
  const extra = `${String(job.repeatedTaskRuns)} extra task run${job.repeatedTaskRuns === 1 ? '' : 's'}`;
  return (
    `In ${runs}, a task ran more than once inside the same run — ${extra} in all. Whether that was an ` +
    'automatic retry or somebody repairing the run is not recorded, so this is the count and not a retry rate.'
  );
}

/**
 * What the duration figures beside it are, and are not, all of.
 *
 * It read "every figure here is the elapsed time between a run's first and last task period" while sitting
 * under six figures, two of which are not that: the total is a sum of those elapsed times, and the longest
 * single task is one task run's own period endpoints — a figure that need not come from the longest run.
 * A caption under a list has to hold for every row of it.
 *
 * The zero claim is attributed rather than absolute. "Every run this app has measured" was a total read over
 * a 44-run sample on one workspace, which is the shape of claim this repository requires a source for.
 */
export const DURATION_NOTE =
  'The four run figures are elapsed time between a run’s first and last task period; the total sums those ' +
  'across the window, and the longest single task is one task run’s own period rather than a run’s. The ' +
  'platform’s own duration columns were not used: they read zero on all 44 runs measured on labs.';

/**
 * Why there is no outcome, said about our own read rather than about the platform.
 *
 * It said the task timeline "carries no result state", which is false — `system.lakeflow.job_task_run_timeline`
 * has `result_state` and `termination_code`, and the audit document's query 2 selects both. What is true is
 * narrower and is about this app: `job_run_health.sql` reads the outcome from the run-level timeline only. A
 * bound of our own statement rendered as a bound of the platform sends a reader off to stop looking for a
 * thing that is there.
 */
export const OUTCOME_ABSENT =
  'The run-level timeline recorded no outcome for this job, and that is the only timeline this page reads an ' +
  'outcome from, so it cannot say how these runs ended — which is not the same as runs that ended cleanly.';

/** The standing note about the repeat figures, for the panel that shows them without a finding. */
export const REPEAT_NOTE =
  'A repeat is a second run of the same task inside one job run. The platform does not record which of the ' +
  'job’s tasks it was, or whether the scheduler or a person asked for it.';

/**
 * What the job spends its time in, where one task can be named.
 *
 * The share is over summed task time and not over the wall clock, and the difference matters on a job
 * whose tasks run in parallel: the totals can exceed the elapsed time, so a share of the wall clock would
 * exceed 100 and read as an error. What the sentence may not add is that the named task is the job's
 * critical path — that holds only where the tasks run in parallel, and nothing here says whether they do.
 */
export function busiestTaskSentence(job: JobHealth): string | undefined {
  const busiest = job.busiestTaskMs;
  if (busiest == null || job.taskMs <= 0 || job.tasksMost < 2) return undefined;
  const share = Math.round((busiest / job.taskMs) * 1000) / 10;
  const named = job.busiestTaskKey == null ? 'One task' : `The task “${job.busiestTaskKey}”`;
  return (
    `${named} accounts for ${duration(busiest)} of the ${duration(job.taskMs)} of task time this job’s runs ` +
    `spent in total — ${String(share)}%, across at most ${String(job.tasksMost)} tasks in a run. Task time sums ` +
    'across tasks that may have run at once, so it can exceed the elapsed time above.'
  );
}

/**
 * What the job billed, as a quantity and never as money.
 *
 * Three things this may not say, each of which was available to say wrongly:
 *
 *   It is not a currency amount. `system.billing.usage` carries `usage_quantity`, and the list price it
 *   would be multiplied by is not read here.
 *
 *   It is not comparable between two jobs unless both billed one SKU and the same one. The sum runs across
 *   every SKU the job billed and a DBU of one SKU is not a DBU of another, so the SKU count is printed
 *   beside the figure rather than left out.
 *
 *   It is not a cost per run, and no rule divides it by one. Cost per successful run differs from cost per
 *   run by exactly runs over successes, which makes it the failure rate with a unit on it.
 */
export function spendSentence(job: JobHealth): string | undefined {
  const quantity = job.usageQuantity;
  if (quantity == null) return undefined;
  // Absent is unknown, not one. Defaulting to 1 suppressed the caveat on exactly the readings that could
  // not support it, so a figure summed across who-knows-how-many SKUs read as one comparable between jobs.
  const skus = job.usageSkus;
  const across =
    skus == null
      ? ' summed across however many SKUs it billed, which was not read, so it is not a figure to compare between jobs'
      : skus > 1
        ? ` summed across ${String(skus)} SKUs, so it is a total of unlike units rather than one figure to compare between jobs`
        : '';
  const retracted =
    job.usageRetractions != null && job.usageRetractions > 0
      ? ` ${String(job.usageRetractions)} of its usage records ${job.usageRetractions === 1 ? 'is' : 'are'} a retraction offsetting an earlier one, and the total nets those out.`
      : '';
  return (
    `Billing attributes ${quantity.toLocaleString(undefined, { maximumFractionDigits: 2 })} units of usage to ` +
    `this job over the window${across}. That is a quantity and not an amount of money — no price is read ` +
    `here.${retracted}`
  );
}

/**
 * The latest task start the window recorded, which is the field and is not a run's start.
 *
 * It read "its most recent run started" for one review round, and that was wrong twice over. The column is
 * `max(last_task_start)`, a max over runs of a max over their tasks: on a multi-task job the value is when
 * that run's final task began, hours after the run itself started, and being a max across runs it need not
 * belong to the most recent run at all — a long run started yesterday whose last task began this evening
 * outranks a short one started this afternoon. So no definite article and no "run".
 *
 * Nor "last finished" or "last succeeded": the wall clock and the outcome are different columns, and
 * neither is joined to this one. Invalid dates return nothing rather than render as an epoch.
 */
export function lastRunSentence(job: JobHealth): string | undefined {
  if (job.lastRun == null) return undefined;
  const at = new Date(job.lastRun);
  if (Number.isNaN(at.getTime())) return undefined;
  return `The latest task start the window recorded for it was ${at.toLocaleString()}.`;
}

/**
 * What the definition says about scheduling, where the definition's trigger could be read at all.
 *
 * Present tense about the job as it stands now, and that is one of two constraints: the definition is read
 * at the end of the window and the runs happened across it, so this may not be phrased as the schedule
 * those runs came from. It also may not predict a next run — a quartz expression is in the definition and
 * this payload does not carry it.
 *
 * The second constraint is why `scheduled` is not read alone, and this sentence got it wrong first time by
 * doing so. A false there is three states: a job nobody gave a trigger, a definition written before the
 * column existed, and a job with several triggers whose set lives in an array this app does not project. So
 * an unreadable trigger renders nothing, several triggers say so, and neither says the job has no schedule.
 * `triggerRecorded` in `resolvers/helpers.ts` is the predicate, and it exists because resting on the raw
 * flag once dropped every manually-started job out of a control's denominator.
 *
 * The clause that used to follow — "so its runs were started by something else, a person, an API call, or
 * another job" — is gone for the reason the docblock above already gave and the sentence broke anyway: no
 * field joins the definition as it stands now to how the window's runs were started.
 */
export function scheduleSentence(job: JobHealth): string | undefined {
  if (job.scheduled == null || job.triggerRecorded !== true) return undefined;
  if (job.multipleTriggers === true) {
    return 'Its definition records more than one trigger, and which they are is not read here.';
  }
  if (!job.scheduled) {
    return 'Its definition carries no schedule as it stands now.';
  }
  return job.paused === true
    ? 'Its definition carries a schedule and that schedule is paused as it stands now. The runs below are what the window recorded, whenever they were started.'
    : 'Its definition carries a schedule as it stands now. What that schedule is, and when it next fires, is not read here.';
}

/** The single worst thing found, for the row that has one line to say it in. */
export function leadJobFinding(job: JobHealth): string | undefined {
  return job.findings[0]?.headline;
}

/**
 * The standing caveat, and the one sentence this page most needs.
 *
 * It used to say the page read no compute at all, which was true of the run it was written for and is not
 * true of every run: since `33ce` four rules read worker CPU, memory and startup where a job ran on a
 * classic cluster. So the sentence is a function of the reading rather than a constant, and each of its
 * three branches says a different thing:
 *
 *   No reading taken. This run did not ask, so the page can say nothing either way.
 *
 *   Taken and empty. The estate runs its jobs on serverless, and `system.compute.node_timeline` holds no
 *   row for that. **This is a fact about the workspace and not about the platform** — ADR 0074 — and it
 *   may not be phrased as an estate whose clusters are sized correctly.
 *
 *   Taken and partial, which is the ordinary case: 689 of 4,158 jobs on the estate measured. The funnel
 *   is what stops a finding about nine jobs being read against four thousand.
 *
 * Photon is in none of the three and stays out of all three, for a reason that changed with `51` rather
 * than going away. It used to be that the premise had never been read; it is now that the rule reading it
 * does not read this funnel at all — the billing record reaches jobs the worker join misses, so a note
 * whose three branches are about machine telemetry may not speak for it. `photonNote` is where it is said.
 */
export function computeNote(analysis: Jobs): string {
  const reach = analysis.computeRead;
  if (reach == null) {
    return (
      'This reading did not look at the machines these jobs ran on. Nothing here is about worker size, node ' +
      'type or startup time, and the absence of a finding about those is the absence of a reading.'
    );
  }
  if (reach.withWorkerSamples === 0) {
    return (
      'No job here ran on a classic cluster this reading could reach, so nothing on this page is about ' +
      'worker size, node type or startup time. Serverless compute records no machine telemetry, so that is ' +
      'what these jobs run on rather than a verdict on how they are sized.'
    );
  }
  return (
    `Of the ${reach.thatRan.toLocaleString()} jobs that ran, ${reach.withAComputeId.toLocaleString()} recorded ` +
    `the compute they used, ${reach.onClassicCompute.toLocaleString()} used a classic cluster, and ` +
    `${String(reach.withWorkerSamples)} had machine telemetry this could read. The four utilisation rules ` +
    'apply to that last group and to no other, so a count of what they found is a count out of it.'
  );
}

/**
 * The two dates the machine telemetry spans, where they differ from the rest of the page's window.
 *
 * `system.compute.node_timeline` held 94 days of rows against the task timeline's 370 on the estate
 * measured, so a utilisation figure sitting beside a duration trend is two windows on one page. The
 * sentence states both dates and does not compute a day count from them: the span of the samples read is
 * not the retention of the table, and only the first is a fact this payload holds.
 */
export function computeWindowSentence(analysis: Jobs): string | undefined {
  const from = analysis.computeRead?.earliestSample;
  const to = analysis.computeRead?.latestSample;
  if (from == null || to == null) return undefined;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return undefined;
  return (
    `The machine figures come from samples between ${start.toLocaleDateString()} and ${end.toLocaleDateString()}, ` +
    `which is a shorter span than the ${String(analysis.windowDays)} days of run history everything else here ` +
    'is measured over.'
  );
}

/**
 * What the workers were doing, for a job that has a reading.
 *
 * Every clause is a field. What it may not do is turn any of them into a verdict — "oversized",
 * "efficient", "wasted" — because that is what the four rules are for and they carry thresholds this
 * sentence does not. It also names the pair count rather than the job's runs: the join reaches a subset,
 * and 48.2% of the pairs it reaches are averaged over fewer than three one-minute samples.
 */
export function computeSentence(job: JobHealth): string | undefined {
  const compute = job.compute;
  if (compute == null) return undefined;
  const pairs = `${String(compute.runClusterPairs)} run${compute.runClusterPairs === 1 ? '' : 's'} on ${String(compute.clusters)} classic cluster${compute.clusters === 1 ? '' : 's'}`;
  // Named only where the as-of join resolved it, and with the count it was resolved from. A type read off
  // one pair of forty is not the job's compute, and the count is what stops the sentence saying it is.
  const named =
    compute.nodeType == null
      ? ''
      : ` The cluster was configured as ${compute.nodeType} on ${String(compute.pairsWithAnAsOfConfig)} of them; on the rest, the configuration in force at the time was not recorded.`;
  // Kept apart from the figures rather than folded into them: a mean over one sample is not a mean, and a
  // reader who does not know some were excluded reads the averages as covering everything.
  const thin =
    compute.pairsBelowThreeSamples > 0
      ? ` ${String(compute.pairsBelowThreeSamples)} of them had fewer than three one-minute samples, so the rules did not read an average from ${compute.pairsBelowThreeSamples === 1 ? 'it' : 'those'}.`
      : '';
  return (
    `Across ${pairs}, workers averaged ${String(compute.avgCpuPercent)}% CPU and ` +
    `${String(compute.avgMemoryPercent)}% memory, peaking at ${String(compute.peakCpuPercent)}% and ` +
    `${String(compute.peakMemoryPercent)}%. Drivers are not counted.${named}${thin}`
  );
}

/**
 * Why a job has no machine figures, said about this job rather than about the estate.
 *
 * The distinction the whole compute half turns on: the four utilisation rules did not assess this job, and
 * a row that simply showed nothing would read as a job they assessed and cleared. What it may not say is
 * *why* — serverless, a cluster outside the telemetry's window, or an id that did not join — because no
 * field on this payload distinguishes them.
 */
export const COMPUTE_ABSENT =
  'No machine telemetry was read for this job, so the five rules about worker size, startup and network ' +
  'traffic did not assess it. Runs on serverless compute record none, and that is the usual reason, but ' +
  'this reading cannot say it is the reason here.';

/**
 * What the job's workers moved over the network, per minute of worker time.
 *
 * Its own sentence rather than a clause in `computeSentence`, because it is the one figure on this page
 * whose obvious reading is forbidden. `50` measured the two conditions that would compare this traffic
 * with the data the run processed and found both unanswerable — `system.query.history` names a cluster on
 * 0 of the 4,106,493 rows in the window — so **this may not say I/O-bound, storage-bound, or that the
 * traffic is disproportionate to the work.** All three claim the comparison that could not be made.
 *
 * What it may say is the magnitude against the workspace, because that is arithmetic over two figures the
 * payload holds. The estate's median is quoted with the pair count behind it: a middle taken over three
 * pairs is not a workspace's middle, and a multiple of it is not a finding.
 */
export function networkSentence(job: JobHealth): string | undefined {
  const compute = job.compute;
  const rate = compute?.networkBytesPerNodeMinute;
  const median = compute?.estateMedianBytesPerNodeMinute;
  if (compute == null || rate == null) return undefined;
  const pairs = `${String(compute.pairsWithANetworkRate)} run${compute.pairsWithANetworkRate === 1 ? '' : 's'} on a cluster`;
  // Only where the estate has a middle to compare against. Without it the rate is still a fact and the
  // comparison is not, so the sentence drops the second half rather than the whole thing.
  const against =
    median == null || median <= 0
      ? ''
      : ` The middle of this workspace is ${bytes(median)} per node-minute, across ${compute.estatePairsWithARate.toLocaleString()} runs on a cluster.`;
  // A pair whose every sample stated no figure sums to zero, which is not a pair that moved nothing.
  const silent =
    compute.pairsStatingNoNetwork > 0
      ? ` ${String(compute.pairsStatingNoNetwork)} of them recorded no network figure at all, so ${compute.pairsStatingNoNetwork === 1 ? 'it counts' : 'they count'} as nothing in the average rather than as zero traffic.`
      : '';
  return (
    `Across ${pairs}, workers sent and received ${bytes(rate)} per minute of worker time.${against}${silent} ` +
    'How much data the runs processed is not recorded for job clusters, so this is traffic on its own and ' +
    'not traffic measured against the work.'
  );
}

/**
 * Whether the job's non-serverless usage billed with Photon on, where billing says.
 *
 * Three counts and three sentences, because two of the pairings a reader would make are wrong. Stated
 * minus off is *not* on: a record with no `is_photon` is unread. And zero classic records is a job that
 * ran on serverless, where Photon is not a setting at all — rendering that as "Photon on" would be the
 * flattering blank this page keeps having to close.
 *
 * The route matters enough to say: this is the billing record and not the cluster's configuration. `50`
 * found `system.compute.clusters` carries no Photon column, and the runtime version names it as a
 * positive-only signal — a version spelling Photon says it is on, and one not spelling it is every other
 * runtime, so the negative this rule fires on cannot be read there at all.
 */
export function photonSentence(job: JobHealth): string | undefined {
  const stated = job.classicRecordsStatingPhoton;
  const records = job.classicUsageRecords;
  const off = job.classicRecordsWithPhotonOff;
  if (stated == null || off == null || records == null) return undefined;
  if (records === 0) {
    return 'None of this job’s usage was billed as non-serverless, so there is no Photon setting to read: it is not a setting on serverless compute.';
  }
  if (stated === 0) {
    return `None of the ${records.toLocaleString()} non-serverless usage records for this job says whether Photon was on, so this reading cannot say either way.`;
  }
  const silent =
    records > stated
      ? ` ${(records - stated).toLocaleString()} further record${records - stated === 1 ? '' : 's'} say nothing about it, which is not the same as saying it was on.`
      : '';
  const on = stated - off;
  const shape =
    off === 0
      ? `All ${stated.toLocaleString()} of this job’s non-serverless usage records that state it billed with Photon on.`
      : on === 0
        ? `All ${stated.toLocaleString()} of this job’s non-serverless usage records that state it billed with Photon off.`
        : `${off.toLocaleString()} of the ${stated.toLocaleString()} non-serverless usage records that state it billed with Photon off, and ${on.toLocaleString()} with it on.`;
  return `${shape}${silent}`;
}

/**
 * What the Photon reading covered, for the page's standing notes.
 *
 * Separate from `computeNote` and not a fourth branch of it, because the two funnels are different: the
 * machine telemetry reaches the jobs whose classic clusters wrote node samples, and the billing record
 * reaches every job that billed non-serverless usage — 96.6% of the rule's clusters against the worker
 * join's much narrower reach. A note that spoke for both would understate one of them.
 *
 * The count is over the jobs on the page rather than over the estate, and the sentence says so. There is
 * no pre-limit count of this the way there is for the compute funnel: it would be a fifth figure on a
 * statement that already returns four, and a share over the returned jobs is honest as long as it is
 * named as one.
 */
export function photonNote(analysis: Jobs): string {
  const read = analysis.jobs.filter((one) => one.classicUsageRecords != null);
  if (read.length === 0) {
    return (
      'Whether these jobs ran with Photon was not read. Nothing here is about it, and the absence of a ' +
      'finding about it is the absence of a reading.'
    );
  }
  const classic = read.filter((one) => (one.classicUsageRecords ?? 0) > 0);
  if (classic.length === 0) {
    return (
      'None of the jobs shown billed any non-serverless usage, so Photon is not a setting any of them ' +
      'has. That is what these jobs run on rather than a verdict on how they are configured.'
    );
  }
  return (
    `${String(classic.length)} of the ${String(analysis.jobs.length)} jobs shown billed non-serverless ` +
    'usage, which is where whether Photon was on is recorded. The cluster’s own configuration does not ' +
    'carry it, so a job whose usage says nothing is one this cannot speak about either way.'
  );
}
