// What the job run health reading may and may not be turned into.
//
// The statement is four of the eight things `33ca` measured, and two of its columns are the reason
// this file exists. `repeated_task_runs` is not a retry count, and an absent `usage_quantity` is not
// a job that cost nothing. Both are joins that can miss, and a rule that reads the second from the
// first is the class of claim ADR 0027's lineage keeps paying for — so the drop and the absence are
// asserted here rather than left to whoever writes the rules.

import { describe, expect, it } from 'vitest';
import { parse } from './shapes.js';

/** A row in the stringified shape the statement API returns. */
function row(fields: Record<string, string>): Record<string, string> {
  return fields;
}

const complete = row({
  workspace_id: '7000000000000023',
  job_id: '431982647981311',
  runs: '12',
  wall_seconds_total: '4320',
  wall_seconds_mean: '360.0',
  wall_seconds_p95: '910.5',
  wall_seconds_median: '300.0',
  wall_seconds_max: '1020',
  longest_task_seconds: '880',
  task_seconds_total: '5100',
  tasks_most: '3',
  runs_with_a_repeated_task: '4',
  repeated_task_runs: '6',
  last_run: '2026-08-10T22:15:00.000Z',
  busiest_task_key: 'load_silver',
  busiest_task_seconds: '2400',
  runs_with_a_terminal_period: '12',
  runs_succeeded: '8',
  runs_did_not_succeed: '3',
  runs_unresolved: '1',
  runs_with_a_termination_code: '3',
  usage_quantity: '18.5',
  usage_records: '24',
  usage_retractions: '2',
  usage_skus: '1',
  job_population: '9412',
});

describe('a job the statement read in full', () => {
  it('reads every duration back as the seconds the statement derived', () => {
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.runs).toBe(12);
    expect(job?.wallSecondsTotal).toBe(4320);
    expect(job?.wallSecondsMean).toBe(360);
    expect(job?.wallSecondsP95).toBe(910.5);
    expect(job?.wallSecondsMedian).toBe(300);
    expect(job?.wallSecondsMax).toBe(1020);
    expect(job?.longestTaskSeconds).toBe(880);
    expect(job?.taskSecondsTotal).toBe(5100);
  });

  it('reads the pre-limit count of jobs that ran, which is what the sample is declared against', () => {
    // Repeated on every row by a window function, and it is not the row count: the statement returns the
    // longest-running `job_limit` jobs, so without this a reader has the cap and no population to state it
    // against — which is the bound the statement's own header sets.
    expect(parse.jobRunHealth([complete]).jobs[0]?.jobPopulation).toBe(9412);
  });

  it('reads a missing population as zero rather than inventing one, for a reading written before it existed', () => {
    const { job_population: _population, ...withoutIt } = complete;

    expect(parse.jobRunHealth([withoutIt]).jobs[0]?.jobPopulation).toBe(0);
  });

  it('keeps the repeat counts apart, because four runs repeating a task is not six task runs', () => {
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.runsWithARepeatedTask).toBe(4);
    expect(job?.repeatedTaskRuns).toBe(6);
  });

  it('reads the outcome split and the retractions, so a settled cost is distinguishable', () => {
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.runsSucceeded).toBe(8);
    expect(job?.runsDidNotSucceed).toBe(3);
    expect(job?.runsUnresolved).toBe(1);
    expect(job?.usageQuantity).toBe(18.5);
    expect(job?.usageRetractions).toBe(2);
  });

  it('keeps the unknown outcome out of the two that are known, so a success rate can decline to divide', () => {
    // The terminal-period count is a count of periods, not of outcomes — the failing reading this replaces
    // called it `runsResolved` and counted every terminal period into it, so a run still in flight arrived as
    // one that had finished and a success rate over it understated the failures.
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.runsWithATerminalPeriod).toBe(12);
    expect((job?.runsSucceeded ?? 0) + (job?.runsDidNotSucceed ?? 0) + (job?.runsUnresolved ?? 0)).toBe(12);
  });

  it('reads the busiest task, which is the only task-level fact the payload carries', () => {
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.busiestTaskKey).toBe('load_silver');
    expect(job?.busiestTaskSeconds).toBe(2400);
    expect(job?.tasksMost).toBe(3);
  });

  it('reads the last run as a date, so a stale reading is visible as one', () => {
    const [job] = parse.jobRunHealth([complete]).jobs;

    expect(job?.lastRun?.toISOString()).toBe('2026-08-10T22:15:00.000Z');
  });
});

describe('a job no usage record named', () => {
  // The statement's spend join is a LEFT JOIN on `usage_metadata.job_id`, which misses for a job
  // whose records carry no job id and for one billed under a product the filter excludes. Absent has
  // to stay absent: a zero here reads as a job that ran for free, and the first rule to divide by it
  // would report an infinite cost per run rather than declining to answer.
  const unbilled = row({ workspace_id: '7000000000000023', job_id: '92', runs: '3', wall_seconds_total: '90' });

  it('reports no usage rather than a cost of zero', () => {
    const [job] = parse.jobRunHealth([unbilled]).jobs;

    expect(job).toBeDefined();
    expect(job).not.toHaveProperty('usageQuantity');
    expect(job).not.toHaveProperty('usageRecords');
    expect(job).not.toHaveProperty('usageRetractions');
  });

  it('reports no outcome rather than a run that failed, when the run timeline had no row for it', () => {
    const [job] = parse.jobRunHealth([unbilled]).jobs;

    expect(job).not.toHaveProperty('runsWithATerminalPeriod');
    expect(job).not.toHaveProperty('runsSucceeded');
    expect(job).not.toHaveProperty('runsDidNotSucceed');
  });

  it('still reports the durations, which come from the task timeline it was read from', () => {
    const [job] = parse.jobRunHealth([unbilled]).jobs;

    expect(job?.runs).toBe(3);
    expect(job?.wallSecondsTotal).toBe(90);
  });
});

describe('a row whose identity could not be read', () => {
  // A finding about a job nobody can name is not a weaker reading, it is not a reading — and the
  // analysis joins the job's name on this pair, so a row missing either half would be presented
  // under whatever name the join happened to find.
  it('drops a row with no workspace id', () => {
    const rows = parse.jobRunHealth([row({ job_id: '92', runs: '3' })]).jobs;

    expect(rows).toHaveLength(0);
  });

  it('drops a row with no job id', () => {
    const rows = parse.jobRunHealth([row({ workspace_id: '7000000000000023', runs: '3' })]).jobs;

    expect(rows).toHaveLength(0);
  });

  it('drops a row whose job id came back empty rather than absent', () => {
    const rows = parse.jobRunHealth([row({ workspace_id: '7000000000000023', job_id: '', runs: '3' })]).jobs;

    expect(rows).toHaveLength(0);
  });

  it('keeps the rows either side of a dropped one', () => {
    const rows = parse.jobRunHealth([complete, row({ job_id: '92' }), { ...complete, job_id: '93' }]).jobs;

    expect(rows.map((job) => job.jobId)).toEqual(['431982647981311', '93']);
  });
});

describe('an empty answer', () => {
  it('is a job estate with no runs in the window rather than an unreadable one', () => {
    expect(parse.jobRunHealth([]).jobs).toEqual([]);
  });
});
