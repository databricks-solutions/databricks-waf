// The sentences on the jobs page that a reader would act on, asserted.
//
// The four that carry the risk, and what each one is held to:
//
//   The outcome sentence must be absent where the run timeline said nothing, not a zero. The two Lakeflow
//   timelines are separate tables and a run the task timeline saw may have no run-level row, so "0 of 12
//   runs did not succeed" would be an outcome invented out of a missing join.
//
//   The repeat sentence must stop at "ran again". The measurement behind this page found the audit
//   document's own retry query reporting zero on a workspace where 16 of 44 runs ran a task twice, so the
//   observable thing is a repeated task and the cause of it is not recorded.
//
//   The billed figure must not read as money and must say when it is a total of unlike units.
//
//   No sentence may predict what the platform will do next, and none may claim a job's compute was looked
//   at where it was not. Since `33ce` four rules do read compute, on the jobs that ran on a classic
//   cluster — which is none of them on an all-serverless estate — so every compute sentence is now a
//   function of the reading and the cases below drive all three of its branches.
//
// Two things the first review of this page found that no assertion here would have caught, so they are
// asserted now. The cap disclosure was tested with a payload the server cannot produce — one job and a
// population of nine hundred, where the analysis set both from the same array — so a branch that could
// never run passed. And four sentences restated `job-rules.yaml` as fact: the rule count, the three-run
// floor and the claim that none of them reads compute. The last describe block reads that file, and it
// caught exactly what it was written for: `33ce` added four rules and three of those sentences went false.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  allFilterLabel,
  busiestTaskSentence,
  COMPUTE_ABSENT,
  computeNote,
  computeSentence,
  computeWindowSentence,
  coverageSentence,
  DURATION_NOTE,
  jobsSentence,
  JOB_STATES,
  lastRunSentence,
  leadJobFinding,
  OUTCOME_ABSENT,
  outcomeSentence,
  repeatSentence,
  networkSentence,
  photonNote,
  photonSentence,
  rulesSentence,
  runsLine,
  scheduleSentence,
  spendSentence,
  STATE_DETAIL,
  STATE_LABEL,
  stateFacts,
} from './jobs-language';
import type { ComputeReach, JobCompute, JobFinding, JobHealth, JobState, Jobs } from '../api/types';

function job(overrides: Partial<JobHealth> = {}): JobHealth {
  return {
    workspaceId: 'w1',
    jobId: '42',
    name: 'Nightly load',
    state: 'clean',
    findings: [],
    runs: 12,
    totalMs: 1_200_000,
    meanMs: 100_000,
    medianMs: 90_000,
    p95Ms: 140_000,
    maxMs: 150_000,
    taskMs: 1_100_000,
    tasksMost: 3,
    longestTaskMs: 60_000,
    runsWithARepeatedTask: 0,
    repeatedTaskRuns: 0,
    ...overrides,
  };
}

/** One job's machine reading. The figures are ordinary; a case that means to be extreme sets them. */
function utilisation(overrides: Partial<JobCompute> = {}): JobCompute {
  return {
    runClusterPairs: 8,
    runsWithWorkerSamples: 8,
    clusters: 2,
    pairsBelowThreeSamples: 0,
    avgCpuPercent: 41.2,
    peakCpuPercent: 66,
    avgCpuWaitPercent: 0.04,
    avgMemoryPercent: 52.8,
    peakMemoryPercent: 71,
    avgSwapPercent: 0.05,
    networkBytesPerNodeMinute: 3_145_728,
    pairsWithANetworkRate: 8,
    pairsStatingNoNetwork: 0,
    estateMedianBytesPerNodeMinute: 3_145_728,
    estatePairsWithARate: 10_488,
    pairsWithAnAsOfConfig: 0,
    runsWithNoSetupFigure: 0,
    ...overrides,
  };
}

/** The funnel as `41b` measured it on `large-estate`, so a case reads against real attrition. */
function reach(overrides: Partial<ComputeReach> = {}): ComputeReach {
  return {
    thatRan: 4_876,
    withAComputeId: 4_158,
    onClassicCompute: 1_064,
    withWorkerSamples: 689,
    ...overrides,
  };
}

/**
 * A payload the server could actually have written.
 *
 * `sampled` defaults to the length of `jobs`, because that is the invariant `presentJobs` holds, and the
 * dead cap branch survived review behind a fixture that broke it. A test wanting a capped reading raises
 * `population` above `sampled` and leaves `jobs` short, which is what a capped reading is.
 */
function analysis(overrides: Partial<Jobs> = {}): Jobs {
  const jobs = overrides.jobs ?? [job()];
  return {
    findingCount: 0,
    eligible: jobs.length,
    population: jobs.length,
    sampled: jobs.length,
    matched: jobs.length,
    windowDays: 30,
    rulesVersion: 1,
    ...overrides,
    jobs,
  };
}

const finding: JobFinding = {
  rule: 'JOB_RUNS_NOT_SUCCEEDING',
  severity: 'high',
  confidence: 'high',
  action: 'Open a failed run and fix its first failing task',
  headline: 'A material share of this job’s runs did not succeed',
  detail: 'Runs of this job reached a terminal state other than success.',
  docUrl: 'https://docs.databricks.com/aws/en/jobs/repair-job-failures',
  evidence: [{ label: 'Runs that did not succeed', value: 7, unit: 'count' }],
};

describe('the states', () => {
  it('has a label, a tone, an icon and a sentence for every one of them', () => {
    // Against a literal list rather than the module's own constant, and asserting the icon: the failure
    // `stateFacts` exists to prevent is an undefined component reaching React, and a loop over the exported
    // array would pass on an empty one.
    const states: readonly JobState[] = ['advised', 'clean', 'ineligible'];
    expect(JOB_STATES).toEqual(states);
    for (const state of states) {
      const facts = stateFacts(state);
      expect(facts.label).not.toBe('');
      expect(facts.Icon).not.toBeUndefined();
      expect(facts.tone).not.toBeUndefined();
      expect(facts.detail.length).toBeGreaterThan(40);
    }
  });

  it('says a job with too few runs was not assessed rather than found clean', () => {
    expect(STATE_LABEL['ineligible']).toBe('Not assessed');
    expect(STATE_DETAIL['ineligible']).toContain('declined to read');
    expect(STATE_DETAIL['ineligible']).not.toMatch(/nothing wrong with/i);
  });

  it('answers with a badge rather than crashing on a state written by another build', () => {
    const facts = stateFacts('what-this-build-calls-nothing' as JobState);
    expect(facts.label).toBe('State not recognised');
    expect(facts.detail).toContain('different version');
  });

  it('keeps clean from claiming the job’s compute was examined, when that depends on the job', () => {
    // Since `33ce` a clean job may or may not have had its compute read, and the state detail is written
    // for both. What it may not do is settle the question either way, because the row does that.
    expect(STATE_DETAIL['clean']).toContain('depends on whether this job ran on a classic cluster');
    expect(STATE_DETAIL['clean']).not.toMatch(/nothing here can see|its compute (is|was) fine/i);
  });
});

describe('the opening line', () => {
  it('names how many jobs ran, how many could be read, and what came out', () => {
    const sentence = jobsSentence(analysis({ population: 7, sampled: 7, eligible: 3, findingCount: 4 }));
    expect(sentence).toContain('7 jobs ran in the last 30 days');
    expect(sentence).toContain('3 of them ran three or more times');
    expect(sentence).toContain('4 findings came out');
  });

  it('counts the eligible jobs out of the sample rather than out of the estate', () => {
    // 900 ran, 200 were read, 180 of those were eligible. "180 of them" over 900 would divide a figure
    // about the sample by a figure about the estate.
    const sentence = jobsSentence(analysis({ population: 900, sampled: 200, eligible: 180 }));
    expect(sentence).toContain('900 jobs ran in the last 30 days');
    expect(sentence).toContain('180 of those read');
    expect(sentence).not.toContain('180 of them');
  });

  it('does not imply a partial read where every job was eligible', () => {
    expect(jobsSentence(analysis({ population: 4, sampled: 4, eligible: 4 }))).toContain(
      'All of them ran often enough'
    );
  });

  it('says nothing fired rather than reporting no findings as a count', () => {
    expect(jobsSentence(analysis({ findingCount: 0 }))).toContain('nothing fired on those');
  });
});

describe('the coverage disclosure', () => {
  it('says the list is the longest-running sample where the cap bit', () => {
    const sentence = coverageSentence(analysis({ jobs: [job()], sampled: 1, population: 900 }));
    expect(sentence).toContain('Showing the 1 longest-running of the 900 jobs that ran');
  });

  it('discloses the cap on a payload shaped the way the server writes one', () => {
    // The regression test for the branch that could not run. `sampled` is the array's length here, as
    // `presentJobs` sets it, and the cap still has to be disclosed because `population` is the statement's
    // own pre-limit count.
    const sentence = coverageSentence(analysis({ jobs: [job(), job()], population: 4000 }));
    expect(sentence).toContain('Showing the 2 longest-running of the 4000 jobs that ran');
  });

  it('accounts for the estate’s jobs that did not run, against what ran and not against what was read', () => {
    // 20 live, 5 ran, 2 of them read. The quiet count is 15 — the 3 that ran outside the sample did run.
    const sentence = coverageSentence(analysis({ jobs: [job(), job()], population: 5, matched: 2, live: 20 }));
    expect(sentence).toContain('15 of the estate’s 20 jobs did not run in the window');
    expect(sentence).not.toContain('18 of the estate’s');
  });

  it('claims no quiet jobs where more jobs ran than the inventory lists', () => {
    // A job deleted after it ran is in the window and not in the inventory, so the subtraction goes
    // negative and the clause has to disappear rather than render one.
    expect(coverageSentence(analysis({ population: 4, sampled: 1, live: 2 }))?.includes('did not run')).toBe(false);
  });

  it('is absent where the page is the whole story', () => {
    expect(coverageSentence(analysis({ live: 1, matched: 1, population: 1 }))).toBeUndefined();
  });
});

describe('the filter that clears the others', () => {
  it('names the window where nothing was capped and the sample where something was', () => {
    expect(allFilterLabel(analysis({ population: 3, sampled: 3 }))).toBe('Ran in the window (3)');
    expect(allFilterLabel(analysis({ population: 900, sampled: 200 }))).toBe('Longest-running (200)');
  });
});

describe('the outcome sentence', () => {
  it('is absent where the run timeline recorded nothing for this job', () => {
    expect(outcomeSentence(job())).toBeUndefined();
  });

  it('reports the share over the runs that stated an outcome', () => {
    const sentence = outcomeSentence(job({ runsSucceeded: 5, runsDidNotSucceed: 5, runsWithATerminalPeriod: 10 }));
    expect(sentence).toContain('5 of 10 runs that recorded an outcome did not succeed — 50%');
  });

  it('keeps a run with no outcome yet out of both counts and says so', () => {
    const sentence = outcomeSentence(
      job({ runs: 10, runsSucceeded: 4, runsDidNotSucceed: 4, runsUnresolved: 2, runsWithATerminalPeriod: 10 })
    );
    expect(sentence).toContain('4 of 8 runs');
    expect(sentence).toContain('2 finished a period without an outcome');
    // "N more" claimed to close the arithmetic, which two counts from two timelines cannot.
    expect(sentence).not.toMatch(/\bmore had no outcome\b/);
  });

  it('names the runs the run timeline has no terminal period for rather than leaving them unaccounted', () => {
    // 12 runs in the task timeline, 6 terminal periods in the run timeline. Without this clause the panel
    // reads "1 of 6 did not succeed, 2 unresolved" beside a badge saying 12 runs.
    const sentence = outcomeSentence(
      job({ runs: 12, runsSucceeded: 3, runsDidNotSucceed: 1, runsUnresolved: 2, runsWithATerminalPeriod: 6 })
    );
    expect(sentence).toContain('no terminal period for 6 of this job’s 12 runs');
  });

  it('claims no shortfall where the run timeline is ahead of the task timeline', () => {
    const sentence = outcomeSentence(
      job({ runs: 4, runsSucceeded: 5, runsDidNotSucceed: 1, runsWithATerminalPeriod: 6 })
    );
    expect(sentence).not.toMatch(/no terminal period/);
  });

  it('does not call a run that did not succeed a failure', () => {
    const sentence = outcomeSentence(job({ runsSucceeded: 1, runsDidNotSucceed: 2 }));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('did not succeed');
    expect(sentence).not.toMatch(/failed|failure/i);
  });

  it('says nothing has an outcome yet where every terminal period is blank', () => {
    const sentence = outcomeSentence(job({ runsSucceeded: 0, runsDidNotSucceed: 0, runsUnresolved: 3 }));
    expect(sentence).toContain('None of this job’s runs has a recorded outcome yet');
  });
});

describe('the repeat sentence', () => {
  it('counts the runs and the extra task runs', () => {
    const sentence = repeatSentence(job({ runs: 20, runsWithARepeatedTask: 6, repeatedTaskRuns: 9 }));
    expect(sentence).toContain('In 6 of 20 runs, a task ran more than once');
    expect(sentence).toContain('9 extra task runs');
  });

  it('does not call it a retry, name the task, or predict another attempt', () => {
    const sentence = repeatSentence(job({ runsWithARepeatedTask: 2, repeatedTaskRuns: 2 })) ?? '';
    // "not a retry rate" is the disclaimer and is allowed; asserting the retry is not.
    expect(sentence).not.toMatch(/\bretried\b|\bretries\b|will (try|run) again/i);
    expect(sentence).toContain('not a retry rate');
    expect(sentence).toContain('not recorded');
  });

  it('is absent where no task ran twice', () => {
    expect(repeatSentence(job())).toBeUndefined();
  });
});

describe('the busiest task sentence', () => {
  it('names the task and its share of summed task time', () => {
    const sentence = busiestTaskSentence(job({ busiestTaskKey: 'load', busiestTaskMs: 880_000, taskMs: 1_100_000 }));
    expect(sentence).toContain('The task “load”');
    expect(sentence).toContain('80%');
    expect(sentence).toContain('can exceed the elapsed time');
  });

  it('is absent on a single-task job, where the share is arithmetic', () => {
    expect(busiestTaskSentence(job({ tasksMost: 1, busiestTaskMs: 1_100_000 }))).toBeUndefined();
  });

  it('does not claim the named task is the job’s critical path', () => {
    const sentence = busiestTaskSentence(job({ busiestTaskKey: 'load', busiestTaskMs: 900_000 }));
    expect(sentence).toBeDefined();
    expect(sentence).not.toMatch(/critical path/i);
  });
});

describe('the billed quantity', () => {
  it('is a quantity and says no price was read', () => {
    const sentence = spendSentence(job({ usageQuantity: 12.5, usageSkus: 1 }));
    expect(sentence).toContain('12.5 units of usage');
    expect(sentence).toContain('not an amount of money');
    expect(sentence).not.toMatch(/\$|USD|cost per run/i);
  });

  it('says the total is of unlike units where it spans SKUs', () => {
    const sentence = spendSentence(job({ usageQuantity: 40, usageSkus: 3 }));
    expect(sentence).toContain('summed across 3 SKUs');
  });

  it('names a retraction without saying the total is still being corrected', () => {
    const sentence = spendSentence(job({ usageQuantity: 9, usageRetractions: 2 }));
    expect(sentence).toContain('2 of its usage records are a retraction');
    expect(sentence).toContain('nets those out');
    // A retraction is a correction that was recorded, not one in progress.
    expect(sentence).not.toMatch(/still being corrected|will be corrected/i);
  });

  it('treats an unread SKU count as unknown rather than as one SKU', () => {
    const sentence = spendSentence(job({ usageQuantity: 40 }));
    expect(sentence).toContain('however many SKUs it billed, which was not read');
    expect(sentence).toContain('not a figure to compare between jobs');
  });

  it('is absent where no usage record named the job', () => {
    expect(spendSentence(job())).toBeUndefined();
  });
});

describe('the schedule sentence', () => {
  it('is absent where no definition was matched', () => {
    expect(scheduleSentence(job())).toBeUndefined();
  });

  it('speaks of the definition as it stands now and predicts no next run', () => {
    const sentence = scheduleSentence(job({ scheduled: true, triggerRecorded: true }));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('as it stands now');
    expect(sentence).toContain('when it next fires, is not read here');
    expect(sentence).not.toMatch(/will run|next run at|every (day|hour|week)/i);
  });

  it('says a paused schedule is paused now rather than during the window', () => {
    const sentence = scheduleSentence(job({ scheduled: true, triggerRecorded: true, paused: true }));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('paused as it stands now');
    expect(sentence).toContain('whenever they were started');
  });

  it('says nothing where the trigger could not be read, because a false flag is three states there', () => {
    // A definition written before the trigger columns existed carries a null trigger and reads as
    // unscheduled. Resting on the flag alone is what dropped every manually-started job out of OE-02-04's
    // denominator, and saying "it carries no schedule" here would be the same error in prose.
    expect(scheduleSentence(job({ scheduled: false, triggerRecorded: false }))).toBeUndefined();
    expect(scheduleSentence(job({ scheduled: false }))).toBeUndefined();
  });

  it('says several triggers rather than none where the row records more than one', () => {
    const sentence = scheduleSentence(job({ scheduled: false, triggerRecorded: true, multipleTriggers: true }));
    expect(sentence).toContain('more than one trigger');
    expect(sentence).not.toMatch(/carries no schedule/);
  });

  it('does not say what started the window’s runs, which no field joins to the definition', () => {
    const sentence = scheduleSentence(job({ scheduled: false, triggerRecorded: true }));
    expect(sentence).toBe('Its definition carries no schedule as it stands now.');
    expect(sentence).not.toMatch(/started by|a person|an API call/i);
  });
});

describe('the rest of the page’s words', () => {
  it('calls the last timestamp a task start, because that is the field', () => {
    const sentence = lastRunSentence(job({ lastRun: '2026-08-10T01:02:03.000Z' }));
    expect(sentence).toBeDefined();
    expect(sentence).toContain('The latest task start the window recorded for it');
    // `max(last_task_start)` is a max over runs of a max over their tasks, so it is neither the most recent
    // run nor that run's start.
    expect(sentence).not.toMatch(/most recent run|its run started|finished|succeeded/i);
  });

  it('declines an unparseable date rather than rendering an epoch', () => {
    expect(lastRunSentence(job({ lastRun: 'not a date' }))).toBeUndefined();
  });

  it('carries the run count and the total on the row', () => {
    expect(runsLine(job({ runs: 1 }))).toContain('1 run ·');
  });

  it('leads a row with the worst finding’s headline', () => {
    expect(leadJobFinding(job({ findings: [finding] }))).toBe(finding.headline);
    expect(leadJobFinding(job())).toBeUndefined();
  });

  it('names the ruleset and says what the compute rules reached', () => {
    expect(rulesSentence(analysis())).toContain('job rule set 1 over 30 days');
    // No reading taken. The sentence may not imply the compute rules ran and found nothing.
    expect(rulesSentence(analysis())).toContain('Nothing was read about the machines');
  });

  it('does not count eight rules on a run where four of them had no input', () => {
    // Eight loaded is not eight applied. An all-serverless estate has no machine telemetry, so the four
    // utilisation rules applied to nothing and a sentence saying "eight rules" is the flattering count.
    const serverless = rulesSentence(analysis({ computeRead: reach({ withWorkerSamples: 0 }) }));

    expect(serverless).toContain('no job here ran on one');
    expect(serverless).not.toMatch(/eight rules/i);
  });

  it('names the jobs the compute rules could read, where any could be', () => {
    expect(rulesSentence(analysis({ computeRead: reach({ withWorkerSamples: 3 }) }))).toContain(
      'on the 3 jobs that ran on a classic cluster'
    );
  });

  it('describes a caption that holds for all six duration figures, not four of them', () => {
    expect(DURATION_NOTE).toContain('the total sums those');
    expect(DURATION_NOTE).toContain('longest single task is one task run’s own period');
    // The zero reading is a 44-run sample on one workspace, so it is attributed rather than absolute.
    expect(DURATION_NOTE).toContain('all 44 runs measured on labs');
    expect(DURATION_NOTE).not.toMatch(/every run this app has measured|every figure here is/i);
  });

  it('blames our own read for a missing outcome rather than the task timeline', () => {
    // `system.lakeflow.job_task_run_timeline` does carry `result_state` and `termination_code`; the design
    // document's query 2 selects both. What is true is that `job_run_health.sql` reads the outcome from the
    // run-level timeline only, and that is a bound of this app.
    expect(OUTCOME_ABSENT).toContain('the only timeline this page reads an outcome from');
    expect(OUTCOME_ABSENT).toContain('not the same as runs that ended cleanly');
    expect(OUTCOME_ABSENT).not.toMatch(/carries no result state/i);
  });
});

describe('what the page says about compute', () => {
  it('says nothing either way where no reading was taken', () => {
    // Absent is a run that did not ask. The sentence may not read as an estate with nothing wrong.
    expect(computeNote(analysis())).toContain('did not look at the machines');
    expect(computeNote(analysis())).toContain('absence of a reading');
  });

  it('reports an empty reading as a fact about the workspace, not about the platform', () => {
    // Labs. `system.compute.node_timeline` is readable and holds no row for serverless compute, and ADR
    // 0074 is why that may not be rendered as clusters that are sized correctly.
    const note = computeNote(analysis({ computeRead: reach({ withWorkerSamples: 0 }) }));

    expect(note).toContain('Serverless compute records no machine telemetry');
    expect(note).not.toMatch(/sized (correctly|well)|no problems|efficient/i);
  });

  it('states the funnel rather than the answer', () => {
    // Four steps, because a finding naming nine jobs is nine of 689 and not of 4,876. Quoting it against
    // the estate divides a figure about the sample by a figure about the estate.
    const note = computeNote(analysis({ computeRead: reach() }));

    expect(note).toContain('4,876 jobs that ran');
    expect(note).toContain('4,158 recorded');
    expect(note).toContain('1,064 used a classic cluster');
    expect(note).toContain('689 had machine telemetry');
  });

  it('states the second window where the samples span one', () => {
    // 94 days against the task timeline's 370 on the estate measured, so a utilisation figure beside a
    // duration trend is two windows on one page.
    const spanned = analysis({
      computeRead: reach({ earliestSample: '2026-05-14T00:00:00Z', latestSample: '2026-08-12T00:00:00Z' }),
    });

    expect(computeWindowSentence(spanned)).toContain('shorter span than the 30 days');
    // Absent where no sample dates came back, because a disclosure about a window nothing was read in is
    // noise — and absent entirely where no reading was taken.
    expect(computeWindowSentence(analysis({ computeRead: reach() }))).toBeUndefined();
    expect(computeWindowSentence(analysis())).toBeUndefined();
  });

  it('says a job with no reading was not assessed rather than showing nothing', () => {
    expect(computeSentence(job())).toBeUndefined();
    expect(COMPUTE_ABSENT).toContain('did not assess it');
    // It may not name the reason. Serverless is the usual one and no field on the payload says it is this
    // job's — a cluster outside the telemetry's window and an id that did not join arrive identically.
    expect(COMPUTE_ABSENT).toContain('cannot say it is the reason here');
  });

  it('states the pair count rather than the job’s runs, and excludes the driver out loud', () => {
    const said = computeSentence(job({ runs: 40, compute: utilisation({ runClusterPairs: 8, clusters: 2 }) }));

    expect(said).toContain('Across 8 runs on 2 classic clusters');
    expect(said).toContain('Drivers are not counted');
    expect(said).not.toContain('40');
  });

  it('names the node type only with the count of pairs it was read from', () => {
    // Relaxing the as-of ordering would name a type on 53.6% of pairs instead of 8.7%, every one of the
    // difference configured after the run. So the count travels with the name or the name does not appear.
    const named = computeSentence(job({ compute: utilisation({ nodeType: 'i3.xlarge', pairsWithAnAsOfConfig: 3 }) }));

    expect(named).toContain('configured as i3.xlarge on 3 of them');
    expect(named).toContain('the configuration in force at the time was not recorded');
    expect(computeSentence(job({ compute: utilisation() }))).not.toMatch(/configured as/);
  });

  it('says how many pairs were too thinly sampled to average', () => {
    // 48.2% of pairs on the estate measured. A reader who does not know some were excluded reads the
    // averages as covering everything.
    const thin = computeSentence(job({ compute: utilisation({ pairsBelowThreeSamples: 3 }) }));

    expect(thin).toContain('3 of them had fewer than three one-minute samples');
    expect(computeSentence(job({ compute: utilisation() }))).not.toMatch(/one-minute samples/);
  });

  it('reports the figures and reaches no verdict on them', () => {
    // The four rules carry the thresholds. This sentence carries the fields, and a word like "oversized"
    // in it would be a threshold nobody could see or version.
    const said = computeSentence(job({ compute: utilisation({ avgCpuPercent: 4.1 }) })) ?? '';

    expect(said).toContain('4.1% CPU');
    expect(said).not.toMatch(/oversized|too (large|big|small)|wasted|idle|inefficient|should/i);
  });
});

/**
 * The network rate, whose obvious reading is the forbidden one.
 *
 * `50` measured both conditions that would compare this traffic with the data the run processed and found
 * them unanswerable: `system.query.history` names a cluster on 0 of the 4,106,493 rows in the window. So
 * every word implying that comparison is out, and the block below asserts their absence rather than trusting
 * the sentence to stay careful.
 */
describe('what the workers sent over the network', () => {
  it('says the rate and the estate’s middle, with the count behind each', () => {
    const said = networkSentence(
      job({
        compute: utilisation({
          networkBytesPerNodeMinute: 314_572_800,
          pairsWithANetworkRate: 6,
          estateMedianBytesPerNodeMinute: 3_145_728,
          estatePairsWithARate: 10_488,
        }),
      })
    );

    expect(said).toContain('Across 6 runs on a cluster');
    expect(said).toContain('300 MiB per minute of worker time');
    expect(said).toContain('middle of this workspace is 3 MiB per node-minute');
    expect(said).toContain('10,488 runs on a cluster');
  });

  it('never says I/O-bound, and says why the comparison is missing', () => {
    // The words imply traffic measured against work. That denominator is the one `50` found unanswerable
    // for classic job compute, so the sentence has to state the rate as a rate and say what it lacks.
    const said = networkSentence(job({ compute: utilisation() })) ?? '';

    expect(said).toMatch(/not traffic measured against the work/);
    expect(said).not.toMatch(/i\/o.bound|io.bound|storage.bound|disproportionate|too much|excessive/i);
  });

  it('drops the comparison rather than the sentence where the estate has no middle', () => {
    const said = networkSentence(
      job({ compute: utilisation({ estateMedianBytesPerNodeMinute: undefined, estatePairsWithARate: 0 }) })
    );

    expect(said).toContain('per minute of worker time');
    expect(said).not.toMatch(/middle of this workspace/);
  });

  it('is absent where no pair ran long enough to have a rate', () => {
    // A rate needs node-minutes to divide by, and a zero there would read as a job that moved no traffic.
    expect(networkSentence(job({ compute: utilisation({ networkBytesPerNodeMinute: undefined }) }))).toBeUndefined();
    expect(networkSentence(job())).toBeUndefined();
  });

  it('counts the pairs that stated no figure apart from the ones that stated zero', () => {
    const said = networkSentence(job({ compute: utilisation({ pairsStatingNoNetwork: 2 }) }));

    expect(said).toContain('2 of them recorded no network figure at all');
    expect(said).toContain('rather than as zero traffic');
    expect(networkSentence(job({ compute: utilisation() }))).not.toMatch(/no network figure/);
  });
});

/**
 * Photon, whose three counts a reader would collapse into two wrong ones.
 *
 * `stated` minus `off` is not `on` — a record with no `is_photon` is unread — and zero classic records is a
 * serverless job rather than a job with Photon on. Both are asserted here because both are the shape of
 * blank this page has already shipped once as a verdict.
 */
describe('whether the job ran with Photon', () => {
  it('says the split where the records state one', () => {
    const said = photonSentence(
      job({ classicUsageRecords: 20, classicRecordsStatingPhoton: 20, classicRecordsWithPhotonOff: 14 })
    );

    expect(said).toContain('14 of the 20');
    expect(said).toContain('6 with it on');
  });

  it('does not read the records that state nothing as records that state on', () => {
    const said = photonSentence(
      job({ classicUsageRecords: 20, classicRecordsStatingPhoton: 12, classicRecordsWithPhotonOff: 12 })
    );

    expect(said).toContain('All 12');
    expect(said).toContain('8 further records say nothing about it');
    expect(said).toContain('not the same as saying it was on');
  });

  it('says a serverless job has no setting rather than saying Photon is on', () => {
    const said = photonSentence(
      job({ classicUsageRecords: 0, classicRecordsStatingPhoton: 0, classicRecordsWithPhotonOff: 0 })
    );

    expect(said).toContain('not a setting on serverless compute');
    expect(said).not.toMatch(/with Photon on/);
  });

  it('says nothing at all where the reading predates the columns', () => {
    // Absent is a stored analysis from before `51`, and a sentence rendered over it would be a claim about
    // a field the payload does not carry.
    expect(photonSentence(job())).toBeUndefined();
  });

  it('reports the Photon reach over the jobs shown and says that is what it is', () => {
    const said = photonNote(
      analysis({
        jobs: [
          job({ jobId: '1', classicUsageRecords: 20, classicRecordsStatingPhoton: 20, classicRecordsWithPhotonOff: 0 }),
          job({ jobId: '2', classicUsageRecords: 0, classicRecordsStatingPhoton: 0, classicRecordsWithPhotonOff: 0 }),
        ],
      })
    );

    expect(said).toContain('1 of the 2 jobs shown');
    expect(said).toContain('The cluster’s own configuration does not carry it');
  });

  it('tells an estate with no classic usage from a run that did not read it', () => {
    const unread = photonNote(analysis({ jobs: [job()] }));
    const serverless = photonNote(
      analysis({
        jobs: [job({ classicUsageRecords: 0, classicRecordsStatingPhoton: 0, classicRecordsWithPhotonOff: 0 })],
      })
    );

    expect(unread).toContain('was not read');
    expect(serverless).toContain('None of the jobs shown billed any non-serverless usage');
    // Neither may read as an estate whose jobs are configured correctly.
    for (const said of [unread, serverless]) expect(said).not.toMatch(/all .*(on|correct|fine)\b/i);
  });
});

/**
 * The four sentences that restate `job-rules.yaml`, held against it.
 *
 * Every one of these read as a fact about the app and was configuration: the rule count in `rulesSentence`
 * and `STATE_DETAIL.clean`, the three-run floor in `jobsSentence` and `STATE_DETAIL.ineligible`, and the
 * "none of them reads compute" claim in both plus `NO_COMPUTE_NOTE`. The ledger row after this one adds the
 * audit's six compute rules, at which point three of those become false — and before this block, every
 * assertion in this file still passed. So the file is the source and this is where the disagreement surfaces.
 */
describe('the page’s claims about the ruleset', () => {
  const yaml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '../../../config/analyze/job-rules.yaml'),
    'utf8'
  );
  const ids = [...yaml.matchAll(/^\s+- id: (\w+)$/gm)].map((match) => match[1]);
  const floors = [...yaml.matchAll(/^\s+min_runs: (\d+)$/gm)].map((match) => Number(match[1]));

  it('found the ruleset, so the assertions below are reading something', () => {
    expect(ids.length).toBeGreaterThan(0);
    expect(floors.length).toBeGreaterThan(0);
  });

  it('says four rules over the runs because four of the ten read the timelines', () => {
    // Named rather than counted, so a rule replaced as well as a rule added fails here. The split matters
    // as much as the total: the page's "four rules" is about the first group, the second group's sentence
    // is conditional on a reading, and the tenth reads neither timeline nor telemetry — so a rule moving
    // between the three groups has to fail here.
    expect(ids).toEqual([
      'JOB_LONG_RUNNING',
      'JOB_DOMINATED_BY_ONE_TASK',
      'JOB_RUNS_NOT_SUCCEEDING',
      'JOB_TASKS_RUN_AGAIN',
      'JOB_WORKERS_UNDERUSED',
      'JOB_MEMORY_BOUND',
      'JOB_COMPUTE_BOUND',
      'JOB_STARTUP_OVERHEAD',
      'JOB_NETWORK_HEAVY',
      'JOB_PHOTON_OFF',
    ]);
    expect(rulesSentence(analysis())).toContain('Four rules over how the runs went');
    expect(rulesSentence(analysis({ computeRead: reach() }))).toContain('Five more read worker CPU');
  });

  it('says three runs because every rule requires three', () => {
    expect(new Set(floors)).toEqual(new Set([3]));
    expect(jobsSentence(analysis({ population: 9, sampled: 9, eligible: 4 }))).toContain('ran three or more times');
    expect(STATE_DETAIL['ineligible']).toContain('Fewer than three runs');
  });

  it('no longer claims the page reads no compute, because four of the rules do', () => {
    // This is the assertion the block was written to force. `33ce` added the four utilisation rules and
    // three sentences went false at once; what replaces them is conditional on the reading rather than on
    // the ruleset, so the check is that no sentence states the absolute any more.
    const sentences = [
      rulesSentence(analysis({ computeRead: reach() })),
      STATE_DETAIL['clean'],
      computeNote(analysis({ computeRead: reach() })),
    ];
    for (const sentence of sentences) {
      expect(sentence).not.toMatch(/none of them reads compute|Nothing on this page reads compute/i);
    }
  });

  it('keeps Photon out of every sentence about machine telemetry, because it is not read from there', () => {
    // Rule E ships in `51` and the constraint changed rather than lifted. The setting is on the billing
    // record; `system.compute.clusters` carries no Photon column at all. So a sentence about what the node
    // telemetry covered may not speak for it — the two reach different jobs, and `photonNote` is where the
    // Photon reach is said.
    const sentences = [
      computeNote(analysis({ computeRead: reach() })),
      computeNote(analysis()),
      COMPUTE_ABSENT,
      computeSentence(job({ compute: utilisation() })) ?? '',
      networkSentence(job({ compute: utilisation() })) ?? '',
    ];
    for (const sentence of sentences) expect(sentence).not.toMatch(/photon/i);
  });
});
