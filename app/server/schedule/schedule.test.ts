import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { JobRun, Workspace } from './port';
import { healthy, JOB_NAME, read, RECENT_RUNS } from './schedule';

const NOW = new Date('2026-08-07T03:00:00Z');

type Job = Awaited<ReturnType<Workspace['jobs']['get']>>;

/**
 * A client that answers with what is given and records what was asked.
 *
 * Types as `Workspace` with no assertion, which is the payoff of `port.ts` being four methods wide
 * rather than the SDK's whole client: a fake of this is checked against the thing the module actually
 * depends on, so a call the module grows cannot be faked into existence here.
 */
function client(answers: {
  readonly jobs?: readonly Job[];
  readonly runs?: readonly JobRun[];
  readonly throws?: Error;
  /** The tasks of a run, by run id, for the two calls that read the newest failure's reason. */
  readonly tasks?: Readonly<
    Record<string, readonly { run_id?: number; task_key: string; state?: { result_state?: string } }[]>
  >;
  /** What a task run's output says, by task run id. */
  readonly output?: Readonly<Record<string, { error?: string }>>;
  /** Thrown by the reason reads only, to prove a reason the app may not read costs the page nothing. */
  readonly reasonThrows?: Error;
  /**
   * Thrown by the task output read alone, leaving the run itself readable.
   *
   * Its own knob because the two reads need different grants and now carry different facts: which task
   * failed is on the run, and the error needs `CAN_VIEW` on that task's output. A fake that failed both
   * together could not express the case the app is built for.
   */
  readonly outputThrows?: Error;
}) {
  const asked: Record<string, unknown>[] = [];

  const workspace: Workspace = {
    jobs: {
      // eslint-disable-next-line @typescript-eslint/require-await -- an async generator, which the SDK returns.
      list: async function* (request) {
        asked.push({ call: 'list', ...request });
        if (answers.throws != null) throw answers.throws;
        // Only the id, matching what the API actually answers a list with: a reduced settings object
        // with no `run_as`. A fake that returned full settings here would hide the reason `find` makes
        // a second call, and this test file is where that reason has to stay visible.
        yield* (answers.jobs ?? []).map((job) => ({ job_id: job.job_id, settings: { name: job.settings?.name } }));
      },
      get: (request) => {
        asked.push({ call: 'get', ...request });
        return Promise.resolve((answers.jobs ?? []).find((job) => job.job_id === request.job_id) ?? {});
      },
      // eslint-disable-next-line @typescript-eslint/require-await
      listRuns: async function* (request) {
        asked.push({ call: 'listRuns', ...request });
        yield* answers.runs ?? [];
      },
      runNow: () => Promise.resolve({}),
      getRun: (request) => {
        asked.push({ call: 'getRun', ...request });
        if (answers.reasonThrows != null) return Promise.reject(answers.reasonThrows);
        return Promise.resolve({ tasks: answers.tasks?.[String(request.run_id)] ?? [] });
      },
      getRunOutput: (request) => {
        asked.push({ call: 'getRunOutput', ...request });
        const refused = answers.outputThrows ?? answers.reasonThrows;
        if (refused != null) return Promise.reject(refused);
        return Promise.resolve(answers.output?.[String(request.run_id)] ?? {});
      },
    },
  };

  return { asked, client: () => Promise.resolve(workspace) };
}

const SCHEDULED = {
  job_id: 471148922192497,
  settings: {
    name: JOB_NAME,
    schedule: { quartz_cron_expression: '0 0 6 ? * MON', timezone_id: 'UTC', pause_status: 'UNPAUSED' },
    run_as: { service_principal_name: 'a-service-principal' },
  },
} satisfies Job;

describe('a live schedule', () => {
  it('says the cadence in words and when the next one falls', async () => {
    const { client: withJob } = client({ jobs: [SCHEDULED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.state).toBe('live');
    expect(schedule.cadence).toBe('Every Monday at 06:00 UTC');
    expect(schedule.dueAt).toBe('2026-08-10T06:00:00.000Z');
    expect(schedule.jobId).toBe('471148922192497');
    expect(schedule.ranAs).toBe('a-service-principal');
  });

  it('carries the raw expression as well, so a reader can check the words against it', async () => {
    const { client: withJob } = client({ jobs: [SCHEDULED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.cron).toBe('0 0 6 ? * MON');
    expect(schedule.timezone).toBe('UTC');
  });

  it('names no cadence and no next run for an expression it will not claim to have read', async () => {
    const stepped = {
      ...SCHEDULED,
      settings: { ...SCHEDULED.settings, schedule: { quartz_cron_expression: '0 0/15 * * * ?', timezone_id: 'UTC' } },
    };
    const { client: withJob } = client({ jobs: [stepped] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // Still live, and still says what the expression is. What it refuses is the derived sentence.
    expect(schedule.state).toBe('live');
    expect(schedule.cadence).toBeUndefined();
    expect(schedule.dueAt).toBeUndefined();
    expect(schedule.cron).toBe('0 0/15 * * * ?');
  });
});

describe('the identity a reader is sent to look at', () => {
  /**
   * The defect this fixes was measured on labs and it was a wrong answer, not a missing one. The job's
   * `run_as` was the bundle's deployer and every run was being refused for a service principal passed to
   * the notebook as `client_id`, so a reader told "runs as operator@example.com" went and
   * checked the grants of an identity that was not involved in the failure.
   */
  const WITH_CLIENT = {
    ...SCHEDULED,
    settings: {
      ...SCHEDULED.settings,
      run_as: { user_name: 'deployer@example.com' },
      tasks: [
        { task_key: 'readiness', notebook_task: { base_parameters: { phase: 'readiness', client_id: 'probe-sp' } } },
        { task_key: 'assess', notebook_task: { base_parameters: { phase: 'assess', client_id: 'probe-sp' } } },
      ],
    },
  } satisfies Job;

  it('names the identity the assessment authenticates as, separately from the one the notebook runs as', async () => {
    const { client: withJob } = client({ jobs: [WITH_CLIENT] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.assessesAs).toBe('probe-sp');
    expect(schedule.ranAs).toBe('deployer@example.com');
  });

  it('names no assessing identity where the parameter was never substituted', async () => {
    const unsubstituted = {
      ...WITH_CLIENT,
      settings: {
        ...WITH_CLIENT.settings,
        tasks: [{ task_key: 'readiness', notebook_task: { base_parameters: { client_id: '${var.schedule_client_id}' } } }],
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [unsubstituted] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // A literal `${...}` is a deploy that did not resolve the variable, and repeating it at a reader
    // would be the panel showing them a bug in the bundle dressed as an identity.
    expect(schedule.assessesAs).toBeUndefined();
    expect(schedule.ranAs).toBe('deployer@example.com');
  });
});

describe('the assessment a scheduled run answers to', () => {
  /**
   * The parameter is what makes the target immutable, which is the whole of `GAP-036`: a job that asked
   * the app for the newest definition when it fired would answer to a different assessment the moment
   * somebody added one. Measured while scoping row 55, the job named none at all — so these cases are
   * about a reading that had no field to read.
   */
  /** Annotated so the two tasks share one type; inferred, they union into keys the port will not take. */
  const params = (values: Record<string, string>): Record<string, string> => values;

  function withAssessment(value: string | undefined): Job {
    return {
      ...SCHEDULED,
      settings: {
        ...SCHEDULED.settings,
        tasks: [
          { task_key: 'readiness', notebook_task: { base_parameters: params({ phase: 'readiness' }) } },
          {
            task_key: 'assess',
            notebook_task: {
              base_parameters: params({ phase: 'assess', ...(value != null ? { assessment_id: value } : {}) }),
            },
          },
        ],
      },
    } satisfies Job;
  }

  const KEPT = { named: (id: string) => Promise.resolve({ name: `Assessment ${id}`, archived: false }) };

  it('names the assessment the job carries, with what this install calls it', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('q3-review')] });
    const schedule = await read({ client: withJob, now: () => NOW, assessments: KEPT });

    expect(schedule.answers).toEqual({ id: 'q3-review', name: 'Assessment q3-review' });
  });

  it('says nothing about a name on an install that keeps no definitions', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('q3-review')] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // The id and no more. An app with no definition store has not looked, which is a different answer
    // from having looked and found nothing — and `missing` is what says the lookup happened.
    expect(schedule.answers).toEqual({ id: 'q3-review' });
  });

  it('reports an id that names no assessment here, because that job fails every week', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('deleted')] });
    const schedule = await read({
      client: withJob,
      now: () => NOW,
      assessments: { named: () => Promise.resolve(undefined) },
    });

    expect(schedule.answers).toEqual({ id: 'deleted', missing: true });
  });

  it('reports an archived one, which the scan route also refuses', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('last-quarter')] });
    const schedule = await read({
      client: withJob,
      now: () => NOW,
      assessments: { named: () => Promise.resolve({ name: 'Last quarter', archived: true }) },
    });

    expect(schedule.answers).toEqual({ id: 'last-quarter', name: 'Last quarter', archived: true });
  });

  it('reads an empty parameter as the job naming none, because that is what the bundle ships', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('  ')] });
    const schedule = await read({ client: withJob, now: () => NOW, assessments: KEPT });

    expect(schedule.answers).toBeUndefined();
  });

  it('names none where the job predates the parameter', async () => {
    const { client: withJob } = client({ jobs: [withAssessment(undefined)] });
    const schedule = await read({ client: withJob, now: () => NOW, assessments: KEPT });

    expect(schedule.answers).toBeUndefined();
  });

  it('carries an unsubstituted variable as its own state rather than as an id', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('${var.schedule_assessment_id}')] });
    const schedule = await read({ client: withJob, now: () => NOW, assessments: KEPT });

    // The same third state `supervision` keeps for a recipient: printing the template to a reader shows
    // them a bug dressed as a target, and dropping it silently reports a job that names nothing.
    expect(schedule.answers).toEqual({ unresolved: true });
  });

  it('takes it from the assessment task only, since the readiness task posts no assessment', async () => {
    const readinessOnly = {
      ...SCHEDULED,
      settings: {
        ...SCHEDULED.settings,
        tasks: [
          { task_key: 'readiness', notebook_task: { base_parameters: params({ assessment_id: 'not-the-assessment' }) } },
          { task_key: 'assess', notebook_task: { base_parameters: params({ phase: 'assess' }) } },
        ],
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [readinessOnly] });
    const schedule = await read({ client: withJob, now: () => NOW, assessments: KEPT });

    expect(schedule.answers).toBeUndefined();
  });

  it('keeps the id and claims nothing where the definition store would not answer', async () => {
    const { client: withJob } = client({ jobs: [withAssessment('q3-review')] });
    const schedule = await read({
      client: withJob,
      now: () => NOW,
      assessments: { named: () => Promise.reject(new Error('the store is not answering')) },
    });

    // Not `missing`, which would report a store that failed as a definition that is gone — and send a
    // reader to fix a parameter that is correct.
    expect(schedule.answers).toEqual({ id: 'q3-review' });
    expect(schedule.state).toBe('live');
  });
});

describe('what the job does about a failure', () => {
  /** The labs job, as the bundle deploys it: three retries on the assessment, none on the readiness check. */
  const SUPERVISED = {
    ...SCHEDULED,
    settings: {
      ...SCHEDULED.settings,
      email_notifications: { on_failure: ['deployer@example.com'] },
      tasks: [
        { task_key: 'readiness', max_retries: 0 },
        { task_key: 'assess', max_retries: 3, min_retry_interval_millis: 120_000, retry_on_timeout: true },
      ],
    },
  } satisfies Job;

  it('reports the assessment task’s retry policy, not the readiness check’s', async () => {
    const { client: withJob } = client({ jobs: [SUPERVISED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // The readiness task is deliberately `0` — its answer will not change by being asked again — and it
    // is listed first. Taking the first task's policy would report a job that retries three times as one
    // that gives up immediately, which is the opposite of what a reader needs on a Monday.
    expect(schedule.supervision?.retries).toEqual({ times: 3, waitMs: 120_000, onTimeout: true });
  });

  it('names who is emailed, because the common defect is a recipient who has left', async () => {
    const { client: withJob } = client({ jobs: [SUPERVISED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // Named rather than counted. The bundle's default substitutes at deploy time to whoever deployed, so
    // a reader can only notice the address is wrong if they are shown it.
    expect(schedule.supervision?.notifies).toEqual(['deployer@example.com']);
  });

  it('reports a job edited down to no retries as a policy rather than as silence', async () => {
    const once = {
      ...SUPERVISED,
      settings: { ...SUPERVISED.settings, tasks: [{ task_key: 'assess', max_retries: 0 }] },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [once] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // Zero is an answer. It is the configuration behind a single silent failure, and a surface that
    // reported it as "not set" would leave the reader thinking the app had not looked.
    expect(schedule.supervision?.retries).toEqual({ times: 0 });
  });

  it('says nothing at all where the job configures neither, rather than inventing a default', async () => {
    const { client: withJob } = client({ jobs: [SCHEDULED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // `SCHEDULED` has no notifications and no tasks. Absent, so the surface can tell "fails once and
    // tells nobody" from "the app has not looked" — both real, and not the same sentence.
    expect(schedule.supervision).toBeUndefined();
  });

  it('reports a recipient even where no task declares a retry policy', async () => {
    const emailOnly = {
      ...SCHEDULED,
      settings: { ...SCHEDULED.settings, email_notifications: { on_failure: ['ops@example.com'] } },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [emailOnly] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.supervision).toEqual({ notifies: ['ops@example.com'] });
  });

  it('ignores a success-only notification, which is not who hears when it breaks', async () => {
    /*
     * `on_success` is not declared on the port, so the fixture asserts past it.
     *
     * That is the point rather than a workaround: `port.ts` says its shapes are "deliberately the subsets
     * that are used", and a field declared solely to let its own test compile is not one of them. The API
     * does return it, and the app must go on ignoring it — which this proves without widening the port.
     */
    const successOnly = {
      ...SCHEDULED,
      settings: { ...SCHEDULED.settings, email_notifications: { on_success: ['ops@example.com'] } as never },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [successOnly] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // Listing a success recipient beside "does anybody know when this breaks" would answer the question
    // with the wrong address, which is worse than not answering it.
    expect(schedule.supervision).toBeUndefined();
  });

  it('reports no retry policy at all where the assessment task is not there to have one', async () => {
    const renamed = {
      ...SUPERVISED,
      settings: {
        ...SUPERVISED.settings,
        tasks: [
          { task_key: 'readiness', max_retries: 2 },
          { task_key: 'measure', max_retries: 3 },
        ],
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [renamed] });
    const schedule = await read({ client: withJob, now: () => NOW });

    /*
     * The branch that used to fall back to whichever task retried at all, which was wrong in a way the
     * payload could not express: `retries` is documented as the *assessment's* policy, so a readiness task
     * somebody had edited to retry twice was carried under it and read out as the assessment's. A number
     * attributed to the wrong task is worse than no number, because a reader cannot tell it is wrong.
     *
     * The app reads whatever job carries the bundle's name in a customer's workspace, and a customer can
     * edit that job, so this is reachable in production rather than only under a rename here.
     */
    expect(schedule.supervision?.retries).toBeUndefined();
    expect(schedule.supervision?.notifies).toEqual(['deployer@example.com']);
  });

  it('says nothing about a policy of retrying forever, rather than "-1 times"', async () => {
    const forever = {
      ...SUPERVISED,
      settings: { ...SUPERVISED.settings, tasks: [{ task_key: 'assess', max_retries: -1 }] },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [forever] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // `-1` is the Jobs API's spelling of "retry indefinitely". Carried as a count it produced "retries
    // itself -1 times" and an attempts reading of "1 of 0 — it has stopped retrying", which is the
    // opposite of the truth on the one job that never gives up.
    expect(schedule.supervision?.retries).toBeUndefined();
  });

  it('reports an unsubstituted bundle variable as a state, not as a missing recipient', async () => {
    const unresolved = {
      ...SUPERVISED,
      settings: {
        ...SUPERVISED.settings,
        email_notifications: { on_failure: ['${workspace.current_user.userName}'] },
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [unresolved] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // The same guard `assessesAs` applies thirty lines above: a literal `${...}` is a bundle that was not
    // substituted, and the panel would have printed it to a reader as an address.
    expect(schedule.supervision?.notifies).toBeUndefined();

    // The half that was missing. Without it, deleting `unresolved` from `supervision` left the whole suite
    // green while the panel went back to saying no address is set on a job that has one.
    expect(schedule.supervision?.unresolved).toBe(1);
  });

  it('counts the unsubstituted addresses rather than flagging that there was one', async () => {
    const two = {
      ...SUPERVISED,
      settings: {
        ...SUPERVISED.settings,
        email_notifications: { on_failure: ['${workspace.current_user.userName}', '${var.oncall}'] },
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [two] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // As a boolean this meant "one or more", and the panel rendered "The job's only failure recipient" out
    // of it — a count nothing had read, on a job with two.
    expect(schedule.supervision?.unresolved).toBe(2);
  });

  it('leaves the unresolved flag off a job whose recipients did substitute', async () => {
    const { client: withJob } = client({ jobs: [SUPERVISED] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // The pair to the above: a flag that is always true is the same defect as one that is never read.
    expect(schedule.supervision?.notifies).toEqual(['deployer@example.com']);
    expect(schedule.supervision?.unresolved).toBeUndefined();
  });

  it('keeps the recipients that did substitute when one did not', async () => {
    const partly = {
      ...SUPERVISED,
      settings: {
        ...SUPERVISED.settings,
        email_notifications: { on_failure: ['deployer@example.com', '${workspace.current_user.userName}'] },
      },
    } satisfies Job;
    const { client: withJob } = client({ jobs: [partly] });
    const schedule = await read({ client: withJob, now: () => NOW });

    // Both halves, because the panel's sentence differs by whether anybody resolved: "nothing is emailed"
    // is true for none of them and false for this one.
    expect(schedule.supervision?.notifies).toEqual(['deployer@example.com']);
    expect(schedule.supervision?.unresolved).toBe(1);
  });
});

describe('why the newest failure failed', () => {
  const FAILED: JobRun = {
    run_id: 533795292185972,
    state: { life_cycle_state: 'INTERNAL_ERROR', result_state: 'FAILED', state_message: 'Task readiness failed with message: Workload failed, see run output for details.' },
    trigger: 'ONE_TIME',
    start_time: 1_000,
    end_time: 20_000,
    run_duration: 19_000,
  };

  const REFUSAL =
    'TaskFailed: Changing an assessment is restricted to members of the admins group, and probe-sp is not one.';

  function withReason(runs: readonly JobRun[]) {
    return client({
      jobs: [SCHEDULED],
      runs,
      tasks: {
        '533795292185972': [
          { run_id: 106032815374171, task_key: 'assess', state: { result_state: 'UPSTREAM_FAILED' } },
          { run_id: 721792952178252, task_key: 'readiness', state: { result_state: 'FAILED' } },
        ],
      },
      output: { '721792952178252': { error: `${REFUSAL}\n---------------\nTraceback (most recent call last)` } },
    });
  }

  it('reads the failing task and reports what it said, without its exception class or traceback', async () => {
    const { client: workspace } = withReason([FAILED]);
    const schedule = await read({ client: workspace, now: () => NOW });

    expect(schedule.runs[0]?.reason).toBe(
      'Changing an assessment is restricted to members of the admins group, and probe-sp is not one.'
    );
    // The platform's own message is kept beside it rather than replaced. It says which task failed,
    // which the reason does not, and the surface decides which to show.
    expect(schedule.runs[0]?.message).toContain('Task readiness failed');
  });

  it('asks the failed task rather than the one it took down with it, whatever order they arrive in', async () => {
    const { client: workspace, asked } = withReason([FAILED]);
    await read({ client: workspace, now: () => NOW });

    /*
     * 106032815374171 is UPSTREAM_FAILED, and its output says "An upstream task failed" — the run's own
     * message again. Asking it would spend a call to learn nothing, and its key is also the wrong answer
     * to whether the retry policy covered this failure.
     *
     * It is listed **first** in the fixture on purpose. This test previously listed the real failure first
     * and so passed against a `find` that simply took the first task that had not succeeded — which is
     * what the code briefly did, and nothing in the Jobs API promises the helpful order.
     */
    expect(asked).toContainEqual({ call: 'getRunOutput', run_id: 721792952178252 });
    expect(asked).not.toContainEqual({ call: 'getRunOutput', run_id: 106032815374171 });
  });

  it('blames the task that timed out over one that was merely skipped behind it', async () => {
    const { client: workspace } = client({
      jobs: [SCHEDULED],
      runs: [FAILED],
      tasks: {
        '533795292185972': [
          { run_id: 106032815374171, task_key: 'readiness', state: { result_state: 'SKIPPED' } },
          { run_id: 721792952178252, task_key: 'assess', state: { result_state: 'TIMEDOUT' } },
        ],
      },
      output: { '721792952178252': { error: REFUSAL } },
    });
    const schedule = await read({ client: workspace, now: () => NOW });

    // Both are non-success, and only one of them broke. Picking the skipped one would report the failure
    // as outside the retry policy when the assessment is exactly what ran out of time.
    expect(schedule.runs[0]?.covered).toBe(true);
  });

  it('spends nothing on the runs under the newest, however many failed', async () => {
    const older: JobRun[] = [FAILED, { ...FAILED, run_id: 732976500494015 }, { ...FAILED, run_id: 388033977977179 }];
    const { client: workspace, asked } = withReason(older);
    await read({ client: workspace, now: () => NOW });

    expect(asked.filter((call) => call['call'] === 'getRun')).toHaveLength(1);
    expect(asked.filter((call) => call['call'] === 'getRunOutput')).toHaveLength(1);
  });

  it('asks nothing where the newest run succeeded', async () => {
    const succeeded: JobRun = { ...FAILED, run_id: 887749221069714, state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' } };
    const { client: workspace, asked } = withReason([succeeded, FAILED]);
    await read({ client: workspace, now: () => NOW });

    // A reader looking at a working schedule is not owed an explanation of last week's failure, and
    // two calls per page load to provide one is two calls for a line nobody reads.
    expect(asked.filter((call) => call['call'] === 'getRun')).toHaveLength(0);
  });

  it('leaves the run exactly as it was where the reason cannot be read', async () => {
    const { client: workspace } = client({
      jobs: [SCHEDULED],
      runs: [FAILED],
      reasonThrows: new Error('User does not have permission to view this run output'),
    });
    const schedule = await read({ client: workspace, now: () => NOW });

    // The panel still says failing, still says which task, still links to the run. An extra detail the
    // app may not read must not cost a reader the answer it already had.
    expect(schedule.state).toBe('live');
    expect(schedule.runs[0]?.reason).toBeUndefined();
    expect(schedule.runs[0]?.message).toContain('Task readiness failed');
  });

  /*
   * Which task failed decides what the reader does, and the app read it and threw it away.
   *
   * A readiness failure is a settled permission refusal the bundle never retries — the fix is a grant. An
   * assessment failure has already been retried three times and is a fault to read. Same red row, opposite
   * next actions, and the panel previously told both readers the same thing: that it would try again by
   * itself, which was untrue of either.
   */
  function failedIn(taskKey: string, resultState = 'FAILED') {
    return client({
      jobs: [SCHEDULED],
      runs: [FAILED],
      tasks: { '533795292185972': [{ run_id: 721792952178252, task_key: taskKey, state: { result_state: resultState } }] },
      output: { '721792952178252': { error: REFUSAL } },
    });
  }

  it('says the failure was outside the retry policy where the readiness check is what failed', async () => {
    const { client: workspace } = failedIn('readiness');
    const schedule = await read({ client: workspace, now: () => NOW });

    expect(schedule.runs[0]?.covered).toBe(false);
  });

  it('says the failure was inside it where the assessment is what failed', async () => {
    const { client: workspace } = failedIn('assess');
    const schedule = await read({ client: workspace, now: () => NOW });

    expect(schedule.runs[0]?.covered).toBe(true);
  });

  it('reads a task that ran out of time, which the old predicate skipped', async () => {
    const { client: workspace } = failedIn('assess', 'TIMEDOUT');
    const schedule = await read({ client: workspace, now: () => NOW });

    // Only `FAILED` was matched, so the run a reader opens *because* it timed out was the one the app said
    // least about: no reason, and no reading of whether anything retried. `stateOf` already folds the two
    // together, and this now agrees with it.
    expect(schedule.runs[0]?.covered).toBe(true);
    expect(schedule.runs[0]?.reason).toContain('restricted to members of the admins group');
  });

  it('keeps which task failed even where it may not read what the task said', async () => {
    const { client: workspace } = client({
      jobs: [SCHEDULED],
      runs: [FAILED],
      tasks: { '533795292185972': [{ run_id: 721792952178252, task_key: 'readiness', state: { result_state: 'FAILED' } }] },
      outputThrows: new Error('User does not have permission to view this run output'),
    });
    const schedule = await read({ client: workspace, now: () => NOW });

    // The two facts cost different grants: which task failed is on the run, the error needs `CAN_VIEW` on
    // the task output. A reader without the second still gets the half that decides what they do.
    expect(schedule.runs[0]?.reason).toBeUndefined();
    expect(schedule.runs[0]?.covered).toBe(false);
  });

  it('says nothing about which step failed where no step ran, rather than blaming the first one', async () => {
    const skipped = {
      ...FAILED,
      state: { life_cycle_state: 'TERMINATED', result_state: 'MAXIMUM_CONCURRENT_RUNS_REACHED', state_message: 'Run skipped.' },
    } satisfies JobRun;
    const { client: workspace } = client({
      jobs: [SCHEDULED],
      runs: [skipped],
      tasks: {
        '533795292185972': [
          { run_id: 721792952178252, task_key: 'readiness', state: { result_state: 'SKIPPED' } },
          { run_id: 106032815374171, task_key: 'assess', state: { result_state: 'SKIPPED' } },
        ],
      },
    });
    const schedule = await read({ client: workspace, now: () => NOW });

    /*
     * `stateOf` calls this run failed, and nothing in it broke. Reading the answer off the first non-success
     * task made it the readiness step, so the panel told a reader the retry policy did not cover a failure
     * that was a concurrency skip — sending them to audit grants on an identity that never started.
     *
     * Absent is a real state, not a gap, and the panel renders it as silence.
     */
    expect(schedule.state).toBe('live');
    expect(schedule.runs[0]?.covered).toBeUndefined();
  });

  it('reports the assessment as covered whichever order two broken steps arrive in', async () => {
    const both = (order: readonly string[]) =>
      client({
        jobs: [SCHEDULED],
        runs: [FAILED],
        tasks: {
          '533795292185972': order.map((task_key, index) => ({
            run_id: index === 0 ? 721792952178252 : 106032815374171,
            task_key,
            state: { result_state: 'FAILED' },
          })),
        },
        output: { '721792952178252': { error: REFUSAL }, '106032815374171': { error: REFUSAL } },
      });

    // Answered from every broken task rather than from one chosen by `find`, which left this to array
    // position: an assessment that had broken and been retried read as a step the policy never covered.
    for (const order of [['readiness', 'assess'], ['assess', 'readiness']]) {
      const schedule = await read({ client: both(order).client, now: () => NOW });

      expect(schedule.runs[0]?.covered).toBe(true);
      // Sent alongside, because `covered` is a disjunction and the sentence built on it was a definite
      // singular: "the step that failed is the assessment", on a run where two did.
      expect(schedule.runs[0]?.broke).toBe(2);
    }
  });

  it('quotes the assessment when it is one of several broken steps, so the error matches the sentence', async () => {
    const both = (order: readonly string[]) =>
      client({
        jobs: [SCHEDULED],
        runs: [FAILED],
        tasks: {
          '533795292185972': order.map((task_key) => ({
            run_id: task_key === 'assess' ? 106032815374171 : 721792952178252,
            task_key,
            state: { result_state: 'FAILED' },
          })),
        },
        output: { '721792952178252': { error: 'Readiness could not read the metastore' }, '106032815374171': { error: REFUSAL } },
      });

    /*
     * The round-four defect, and the reason `blamed` prefers the assessment. `covered` is answered from
     * every broken step, so it says "assessment" whichever order they arrive in; `blamed` took the first,
     * so on `['readiness', 'assess']` the panel showed readiness's error immediately under a sentence about
     * the assessment. Whichever step the reader is told about, the words underneath are now that step's.
     */
    for (const order of [['readiness', 'assess'], ['assess', 'readiness']]) {
      const schedule = await read({ client: both(order).client, now: () => NOW });

      expect(schedule.runs[0]?.covered).toBe(true);
      // The assessment's words, not readiness's. `tidy` drops the platform's `TaskFailed:` prefix, so this
      // is asserted on the tail rather than the whole string.
      expect(schedule.runs[0]?.reason).toContain('restricted to members of the admins group');
      expect(schedule.runs[0]?.reason).not.toContain('metastore');
    }
  });

  it('counts only the steps that broke, not the ones taken down with them', async () => {
    const { client: mixed } = client({
      jobs: [SCHEDULED],
      runs: [FAILED],
      tasks: {
        '533795292185972': [
          { run_id: 721792952178252, task_key: 'readiness', state: { result_state: 'FAILED' } },
          { run_id: 106032815374171, task_key: 'assess', state: { result_state: 'UPSTREAM_FAILED' } },
        ],
      },
      output: { '721792952178252': { error: REFUSAL } },
    });
    const schedule = await read({ client: mixed, now: () => NOW });

    // One broke; the other was taken down with it. Counting both would make the sentence plural about a
    // run with a single fault in it, and would claim the assessment failed when it never ran.
    expect(schedule.runs[0]?.broke).toBe(1);
    expect(schedule.runs[0]?.covered).toBe(false);
  });
});

describe('the states a reader is told apart', () => {
  it('reports a job that is not there as not deployed', async () => {
    const { client: none } = client({ jobs: [] });
    const schedule = await read({ client: none, now: () => NOW });

    expect(schedule.state).toBe('not-deployed');
    // Nothing here to start, which is the fact the surface needs. Whether a reader may start it is
    // settled by the gate when they try, as everywhere else in the app.
    expect(schedule.triggerable).toBe(false);
  });

  it('reports a paused schedule as paused rather than as absent', async () => {
    const paused = {
      ...SCHEDULED,
      settings: {
        ...SCHEDULED.settings,
        schedule: { quartz_cron_expression: '0 0 6 ? * MON', timezone_id: 'UTC', pause_status: 'PAUSED' },
      },
    };
    const { client: withJob } = client({ jobs: [paused] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.state).toBe('paused');
    // The cadence still reads, because it is what unpausing would start.
    expect(schedule.cadence).toBe('Every Monday at 06:00 UTC');
    // And nothing is due, because nothing is.
    expect(schedule.dueAt).toBeUndefined();
  });

  it('reports a job whose schedule was removed as no-schedule, not as paused', async () => {
    const { client: withJob } = client({ jobs: [{ job_id: 1, settings: { name: JOB_NAME } }] });
    const schedule = await read({ client: withJob, now: () => NOW });

    expect(schedule.state).toBe('no-schedule');
    expect(schedule.cadence).toBeUndefined();
    // A job with no schedule can still be run by hand, which is the difference from not-deployed.
    expect(schedule.triggerable).toBe(true);
  });

  it('reports a refusal as unreadable, saying what it tried', async () => {
    const { client: refused } = client({ throws: new Error('PERMISSION_DENIED: does not have CAN_VIEW') });
    const schedule = await read({ client: refused, now: () => NOW });

    expect(schedule.state).toBe('unreadable');
    expect(schedule.unreadable).toContain('CAN_MANAGE_RUN');
    expect(schedule.unreadable).toContain('PERMISSION_DENIED');
    expect(schedule.runs).toEqual([]);
  });

  it('reports an install with no machine identity without pretending it looked', async () => {
    const schedule = await read({ now: () => NOW });

    expect(schedule.state).toBe('unreadable');
    expect(schedule.unreadable).toContain('no machine identity');
    // And says the half that is unaffected, because losing the run history is the reader's fear here.
    expect(schedule.unreadable).toContain('run history below is complete');
  });

  it('never throws, because the run history beside it is the more important half', async () => {
    const { client: broken } = client({ throws: new Error('ECONNRESET') });
    await expect(read({ client: broken, now: () => NOW })).resolves.toBeDefined();
  });
});

describe('the run history', () => {
  const RUNS = [
    {
      run_id: 900,
      state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS', state_message: 'the platform narrating itself' },
      trigger: 'PERIODIC',
      start_time: Date.parse('2026-08-03T06:00:00Z'),
      end_time: Date.parse('2026-08-03T06:12:00Z'),
      run_duration: 700_000,
      run_page_url: 'https://example.invalid/run/900',
      attempt_number: 0,
    },
    {
      run_id: 901,
      state: { life_cycle_state: 'TERMINATED', result_state: 'FAILED', state_message: 'the run measured nothing' },
      trigger: 'RETRY',
      start_time: Date.parse('2026-07-27T06:00:00Z'),
      end_time: Date.parse('2026-07-27T06:03:00Z'),
      run_duration: 180_000,
      attempt_number: 2,
    },
    {
      run_id: 902,
      state: { life_cycle_state: 'RUNNING' },
      trigger: 'ONE_TIME',
      start_time: Date.parse('2026-08-07T02:59:00Z'),
      // The API really does answer with a duration on a run still going — measured against a live run,
      // 15,225 fifteen seconds in. A fixture that omitted this hid the bug, so it is here.
      run_duration: 15_225,
    },
  ];

  it('reads state, trigger, duration and attempt', async () => {
    const { client: withRuns } = client({ jobs: [SCHEDULED], runs: RUNS });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    expect(runs).toHaveLength(3);
    expect(runs[0]).toMatchObject({
      runId: '900',
      state: 'succeeded',
      trigger: 'schedule',
      durationMs: 700_000,
      startedAt: '2026-08-03T06:00:00.000Z',
      url: 'https://example.invalid/run/900',
    });
    expect(runs[1]).toMatchObject({ state: 'failed', trigger: 'retry', attempt: 3 });
    expect(runs[2]).toMatchObject({ state: 'running', trigger: 'hand' });
  });

  it('keeps the message on a failure and drops it on a success', async () => {
    const { client: withRuns } = client({ jobs: [SCHEDULED], runs: RUNS });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    // A page listing ten successes each narrating itself buries the one failure that matters.
    expect(runs[0]?.message).toBeUndefined();
    expect(runs[1]?.message).toBe('the run measured nothing');
  });

  it('reports no duration for a run still going, whatever the platform says the elapsed time is', async () => {
    const { client: withRuns } = client({ jobs: [SCHEDULED], runs: RUNS });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    // A duration is a fact about a finished thing. The platform answers with elapsed-so-far, and
    // showing that would tell a reader a run took fifteen seconds while it was still working.
    expect(runs[2]?.durationMs).toBeUndefined();
    expect(runs[2]?.finishedAt).toBeUndefined();
  });

  it('reports no duration for a queued run either', async () => {
    const { client: withRuns } = client({
      jobs: [SCHEDULED],
      runs: [{ run_id: 1, state: { life_cycle_state: 'QUEUED' }, trigger: 'PERIODIC', run_duration: 4000 }],
    });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    expect(runs[0]?.durationMs).toBeUndefined();
  });

  it('stops at the recent window rather than walking the whole history', async () => {
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      run_id: index,
      state: { life_cycle_state: 'TERMINATED', result_state: 'SUCCESS' },
      trigger: 'PERIODIC',
    }));
    const { client: withRuns, asked } = client({ jobs: [SCHEDULED], runs: many });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    expect(runs).toHaveLength(RECENT_RUNS);
    expect(asked.find((call) => call.call === 'listRuns')).toMatchObject({ limit: RECENT_RUNS, job_id: 471148922192497 });
  });

  it.each([
    ['a skipped run', { life_cycle_state: 'SKIPPED' }, 'failed'],
    ['an internal error', { life_cycle_state: 'INTERNAL_ERROR' }, 'failed'],
    ['a timeout', { life_cycle_state: 'TERMINATED', result_state: 'TIMEDOUT' }, 'failed'],
    ['a cancellation', { life_cycle_state: 'TERMINATED', result_state: 'CANCELED' }, 'cancelled'],
    ['a queued run', { life_cycle_state: 'QUEUED' }, 'waiting'],
    ['a blocked run', { life_cycle_state: 'BLOCKED' }, 'waiting'],
    ['a state the platform has not documented here', { life_cycle_state: 'WHAT' }, 'unknown'],
  ])('reads %s as %s', async (_what, state, expected) => {
    const { client: withRuns } = client({ jobs: [SCHEDULED], runs: [{ run_id: 1, state, trigger: 'PERIODIC' }] });
    const { runs } = await read({ client: withRuns, now: () => NOW });

    expect(runs[0]?.state).toBe(expected);
  });
});

describe('whether the cadence is working', () => {
  const of = (state: 'live' | 'paused', ...states: readonly string[]) =>
    ({
      state,
      triggerable: true,
      runs: states.map((run, index) => ({ runId: String(index), state: run, trigger: 'schedule' })),
    }) as Parameters<typeof healthy>[0];

  it('is working where it is live and the last finished run succeeded', () => {
    expect(healthy(of('live', 'succeeded'))).toBe(true);
  });

  it('is working where it is live and has not run yet, because nothing has failed', () => {
    expect(healthy(of('live'))).toBe(true);
  });

  it('is not working where the last finished run failed', () => {
    expect(healthy(of('live', 'failed', 'succeeded'))).toBe(false);
  });

  it('looks past a run still going to the last one that finished', () => {
    // A running run says nothing about whether the cadence is holding, and treating it as good news
    // would report a schedule as healthy for as long as its failing run takes to fail.
    expect(healthy(of('live', 'running', 'failed'))).toBe(false);
    expect(healthy(of('live', 'running', 'succeeded'))).toBe(true);
  });

  it('is not working where it is paused, whatever its history says', () => {
    expect(healthy(of('paused', 'succeeded'))).toBe(false);
  });
});

describe('the job name this module looks for', () => {
  it('is the name the bundle deploys, held here rather than in a comment', () => {
    // A rename in the yaml without one here reports "not deployed" on an install that has a schedule,
    // and nothing else in the app would notice.
    const yaml = readFileSync(join(import.meta.dirname, '..', '..', 'resources', 'scheduled-scan.yml'), 'utf8');
    expect(yaml).toContain(`name: '${JOB_NAME}'`);
  });
});
