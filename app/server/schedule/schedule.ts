// What the scheduled assessment is doing, read from the job that does it.
//
// The app has always been able to say what runs happened, because it records them itself. It could
// not say whether anything was going to happen again — whether a schedule exists, whether somebody
// paused it, whether the last three attempts failed at six on Monday morning while nobody watched.
// That gap is the whole of the operating cadence: an unattended assessment nobody is told has stopped
// is a flat trend line a reader takes for good news.
//
// ## The identity here is the app's own, and that is a departure worth stating
//
// Every other outward call in this app is made as the signed-in user, deliberately, so that a finding
// can never describe more of the estate than the reader may see (`collect/rest/client.ts` has the
// argument). This one is not, for two reasons.
//
// The job is not part of the estate. It is this app's own supervisor, deployed with the app, doing
// nothing but calling the app's own scan route. Its schedule and its run history are the app's
// operating record, of exactly the same class as the run history the app keeps in its own store and
// shows to every reader ungated — and the argument for that, in `api/run-routes.ts`, is that
// establishing whether the nightly assessment ran is a question an auditor has without being someone
// who may start one.
//
// And the alternative does not work. The job's owner is whoever deployed the bundle, so a reader who
// has not been granted `CAN_VIEW` on it would be told no schedule is deployed on a workspace where
// one is — the worst answer of the three this module can give, because it is wrong rather than merely
// unhelpful. Reporting a paused schedule as absent is how a customer discovers in month three that
// nothing has run since the pilot.
//
// What the app's identity holds is `CAN_MANAGE_RUN` and nothing else, granted in
// `resources/scheduled-scan.yml` where a reviewer can see it: view the job and start one. It cannot
// change the schedule, the retry policy or the run-as identity, which is the point — that file is
// authoritative about those, and an app that could edit them would make it advisory.
//
// ## Found by name, not by a bound resource
//
// `resources/scheduled-scan.yml` promises that deleting it opts out entirely and nothing else
// references it. Binding the job into the app's own resources would break that promise: the app's
// deploy would then fail on a workspace that had opted out. So the job is found by listing jobs and
// matching the name, which costs one call and keeps the opt-out real — and an install that has opted
// out gets `not-deployed`, which is the truth.

import type {
  ScheduledAssessmentPayload,
  SchedulePayload,
  ScheduleRunPayload,
  ScheduleStatePayload,
  SupervisionPayload,
} from '../../shared/api/contract.js';
import { describeCadence, nextRun, readCadence } from './cron.js';
import type { JobRunTask, JobSettings, Workspace, WorkspaceFactory } from './port.js';

/**
 * The job's name, which is the only handle this module has on it.
 *
 * Must match `resources/scheduled-scan.yml`. A rename there without a change here reports
 * `not-deployed` on an install that has a schedule, so the two are held together by a test that reads
 * the yaml rather than by this comment.
 */
export const JOB_NAME = 'Well-Architected assessment';

/** How many past runs the surface answers with. A cadence is judged on its recent record, not all of it. */
export const RECENT_RUNS = 10;

/**
 * The one question this module asks the definition store, as its own port.
 *
 * A method rather than the store, and narrow for the same reason `port.ts` is narrow: this module reads
 * the app's own supervisor and nothing else, and a `DefinitionStore` here would put `create`, `archive`
 * and `appendVersion` within reach of a read that answers a panel. What it needs is a name and whether
 * the assessment is closed to new runs, which is two fields of one row.
 */
export interface AssessmentNames {
  /** What the assessment calls itself, or undefined where this install keeps none under that id. */
  named(id: string): Promise<{ readonly name: string; readonly archived: boolean } | undefined>;
}

export interface ScheduleOptions {
  /** The app's own client, narrowed to four calls by `port.ts`. Absent where there is no identity. */
  readonly client?: WorkspaceFactory;
  /**
   * How an assessment id becomes a name, where this install keeps definitions.
   *
   * Absent on an install that keeps none, and the panel then reports the id the job carries without
   * claiming anything about whether an assessment answers to it. That is the honest reading: an app with
   * no definition store has not looked.
   */
  readonly assessments?: AssessmentNames;
  readonly now?: () => Date;
}

/**
 * What the schedule is, or why the app cannot say.
 *
 * Never throws. A schedule panel that fails the request it is part of would take the run history down
 * with it, and the run history is the more important half: this is a reader finding out what happened
 * *and* what will happen, and losing both because the Jobs API was slow is a bad trade.
 */
export async function read(options: ScheduleOptions = {}): Promise<SchedulePayload> {
  const { client } = options;
  const now = options.now ?? (() => new Date());

  if (client == null) {
    return {
      state: 'unreadable',
      triggerable: false,
      runs: [],
      unreadable:
        'This install has no machine identity, so the app cannot look at its own scheduled job. Scans started ' +
        'by hand are unaffected, and the run history below is complete.',
    };
  }

  try {
    const workspace = await client();
    const job = await find(workspace);

    if (job == null) {
      return {
        state: 'not-deployed',
        triggerable: false,
        runs: [],
      };
    }

    const settings = job.settings ?? {};
    const schedule = settings.schedule;
    const cadence = schedule == null ? undefined : readCadence(schedule.quartz_cron_expression);
    // Paused counts as having a schedule, because it is the state a customer is most often in and the
    // one they most need told. A job deployed paused has never run and never will, and reporting that
    // as "no schedule" hides the single action that starts the cadence.
    const paused = schedule == null || schedule.pause_status === 'PAUSED';
    const due = cadence == null || paused ? undefined : nextRun(cadence, schedule.timezone_id, now());
    const supervises = supervision(settings);
    const answers = await answering(settings, options.assessments);

    return {
      state: schedule == null ? 'no-schedule' : paused ? 'paused' : 'live',
      jobId: String(job.job_id ?? ''),
      // A job that is here can be started whatever its schedule says, which is the difference between
      // `no-schedule` and `not-deployed` and the reason a paused install has a button at all.
      triggerable: true,
      ...(schedule != null ? { cron: schedule.quartz_cron_expression, timezone: schedule.timezone_id } : {}),
      ...(cadence != null && schedule != null ? { cadence: describeCadence(cadence, schedule.timezone_id) } : {}),
      ...(due != null ? { dueAt: due.toISOString() } : {}),
      ...(runAs(settings.run_as) != null ? { ranAs: runAs(settings.run_as) as string } : {}),
      ...(assessesAs(settings) != null ? { assessesAs: assessesAs(settings) as string } : {}),
      ...(supervises != null ? { supervision: supervises } : {}),
      ...(answers != null ? { answers: answers } : {}),
      runs: await withReason(workspace, await history(workspace, job.job_id)),
    };
  } catch (cause) {
    // Named, not swallowed. The two reasons this fails in practice are a missing grant and a workspace
    // that is not answering, and a reader can act on the first — so the message says what was tried.
    return {
      state: 'unreadable',
      triggerable: false,
      runs: [],
      unreadable:
        `The app could not read its scheduled job: ${describe(cause)}. It looks for a job named ` +
        `"${JOB_NAME}" and needs CAN_MANAGE_RUN on it, which the bundle grants when the job is deployed.`,
    };
  }
}

/**
 * The job, by name, then in full.
 *
 * Two calls rather than one, and the second is not optional. `list` answers with a reduced settings
 * object — measured against the labs job, its `schedule` arrives and its `run_as` does not — so a reader
 * would be shown a cadence with no identity beside it, and the identity is the half that decides what a
 * scheduled run can actually see. A run-as whose grants have lapsed is one of the two ways this job
 * fails quietly, and it would have been silently unreportable.
 *
 * `name` on the list request is an exact match server-side, so finding the id is one call rather than a
 * page walk. Taking the first of several is deliberate and the alternative is worse: two jobs of this
 * name means somebody deployed the bundle twice, and reporting "ambiguous" would leave a reader with no
 * schedule at all where they have two. Its id is on the page for a reader to see which.
 */
async function find(workspace: Workspace) {
  for await (const found of workspace.jobs.list({ name: JOB_NAME, limit: 1 })) {
    if (found.job_id == null) return found;
    return workspace.jobs.get({ job_id: found.job_id });
  }
  return undefined;
}

async function history(workspace: Workspace, jobId: number | undefined): Promise<readonly ScheduleRunPayload[]> {
  if (jobId == null) return [];

  const runs: ScheduleRunPayload[] = [];
  for await (const run of workspace.jobs.listRuns({ job_id: jobId, limit: RECENT_RUNS, expand_tasks: false })) {
    runs.push({
      runId: String(run.run_id ?? ''),
      state: stateOf(run.state),
      ...(run.start_time != null && run.start_time > 0
        ? { startedAt: new Date(run.start_time).toISOString() }
        : {}),
      ...(run.end_time != null && run.end_time > 0 ? { finishedAt: new Date(run.end_time).toISOString() } : {}),
      // The platform's own figure rather than end minus start. They differ on a queued run, and the
      // difference is the queue — which is not time the assessment took.
      //
      // Only once the run has ended, which a fixture will not teach you: measured against a real run in
      // flight, the API answers `run_duration` with the elapsed time so far, and 15,225 on a run that
      // had been going fifteen seconds would have the surface report that it took fifteen seconds. A
      // duration is a fact about a finished thing.
      ...(run.run_duration != null && run.run_duration > 0 && ended(stateOf(run.state))
        ? { durationMs: run.run_duration }
        : {}),
      trigger: triggerOf(run.trigger),
      // Only where the run has something to say. A state message on a success is the platform
      // narrating itself, and a page listing ten of those buries the one failure that matters.
      ...(run.state?.state_message != null && stateOf(run.state) === 'failed'
        ? { message: run.state.state_message }
        : {}),
      ...(run.run_page_url != null ? { url: run.run_page_url } : {}),
      // Job-level attempts only, which on this job means never above one. See `ScheduleRunPayload.attempt`
      // for why, and for the rule that nothing may derive a retry claim from it.
      ...(run.attempt_number != null && run.attempt_number > 0 ? { attempt: run.attempt_number + 1 } : {}),
    });

    if (runs.length >= RECENT_RUNS) break;
  }

  return runs;
}

/** Whether a run has stopped, so that a figure about a finished run is only reported for one. */
function ended(state: ScheduleRunPayload['state']): boolean {
  return state !== 'running' && state !== 'waiting';
}

/**
 * The platform's two-part state as the one word a reader needs.
 *
 * `life_cycle_state` says where the run is and `result_state` says how it ended, and only the pair
 * distinguishes the cases: a `TERMINATED` run is a success or a failure depending on the second, and a
 * `SKIPPED` one never started. Collapsed here rather than on the page, because the surface should not
 * be the place this product decides what "failed" means.
 */
function stateOf(state: { life_cycle_state?: string; result_state?: string } | undefined): ScheduleRunPayload['state'] {
  const life = state?.life_cycle_state;
  if (life === 'PENDING' || life === 'QUEUED' || life === 'BLOCKED') return 'waiting';
  if (life === 'RUNNING' || life === 'TERMINATING') return 'running';

  switch (state?.result_state) {
    case 'SUCCESS':
      return 'succeeded';
    case 'CANCELED':
      return 'cancelled';
    /*
     * Everything else that reached a result is a failure, and they are not distinguished here. FAILED,
     * TIMEDOUT, MAXIMUM_CONCURRENT_RUNS_REACHED, EXCLUDED, UPSTREAM_FAILED, UPSTREAM_CANCELED and DISABLED
     * all mean the assessment did not run, and the state message says which.
     *
     * SUCCESS_WITH_FAILURES is the one that does not fit the sentence: the SDK defines it as a run that
     * "completed successfully with some failures; leaf tasks were successful". It lands here and reads as
     * failed, which is the safe direction for a two-task job whose second task is the assessment — a run
     * that got a scan out would report SUCCESS — but it is a judgement rather than an obvious mapping, and
     * it has not been observed on this job.
     */
    case undefined:
      return life === 'SKIPPED' || life === 'INTERNAL_ERROR' ? 'failed' : 'unknown';
    default:
      return 'failed';
  }
}

/** Whether a run happened because of the schedule, because somebody asked, or because of a retry. */
function triggerOf(trigger: string | undefined): ScheduleRunPayload['trigger'] {
  switch (trigger) {
    case 'PERIODIC':
      return 'schedule';
    case 'ONE_TIME':
      return 'hand';
    case 'RETRY':
      return 'retry';
    default:
      return 'unknown';
  }
}

function runAs(identity: { user_name?: string; service_principal_name?: string } | undefined): string | undefined {
  return identity?.user_name ?? identity?.service_principal_name;
}

/**
 * The identity the assessment authenticates as, taken from the parameter that carries it.
 *
 * Read from the job rather than from this app's own configuration, because the job is authoritative
 * about it: `resources/scheduled-scan.yml` passes `var.schedule_client_id` to both tasks, and the app is
 * deliberately never given that credential (ADR 0021). Reading the parameter is how the app can name
 * the identity without holding it.
 *
 * Any task will do and the first that has one is taken. The two tasks are given the same value by the
 * one variable, and a workspace where somebody has edited them apart has a job this app does not own.
 */
function assessesAs(settings: JobSettings): string | undefined {
  for (const task of settings.tasks ?? []) {
    const client = task.notebook_task?.base_parameters?.['client_id'];
    // Unsubstituted variables and a deliberately empty value both mean "no separate identity": the
    // notebook falls back to the runtime's own credentials, which are `run_as`.
    if (client != null && client !== '' && !client.startsWith('${')) return client;
  }
  return undefined;
}

/**
 * The assessment the job's runs answer to, taken from the parameter that carries it.
 *
 * By task key, like `retriesOf` and unlike `assessesAs`, and the difference is which tasks the value is
 * true of. The identity is passed to both tasks by one variable, so any task's copy answers for the job;
 * this parameter is the assessment the *assessment* posts, and the readiness task does not post one. A
 * fallback to whichever task set something would report a value from a task that does not use it.
 *
 * Undefined where the task sets no such parameter, which is two real states with one reading: a job
 * deployed before the parameter existed, and one where somebody set the bundle variable to nothing on
 * purpose. Both mean no unattended run answers to an assessment, which is what the panel says.
 *
 * The name is resolved here rather than on the client because the client has neither the store nor the
 * id-to-name relationship, and a second request from the panel to find out would double the page's cost
 * for one word. Failure to resolve leaves the id and says nothing more: `ScheduledAssessmentPayload.missing`
 * means the store answered, so a store that threw must not set it.
 */
async function answering(
  settings: JobSettings,
  assessments: AssessmentNames | undefined
): Promise<ScheduledAssessmentPayload | undefined> {
  const task = (settings.tasks ?? []).find((one) => one.task_key === ASSESS_TASK);
  const parameter = task?.notebook_task?.base_parameters?.[ASSESSMENT_PARAMETER];
  if (parameter == null) return undefined;

  const id = parameter.trim();
  // Empty is the bundle's default and means the same as unset, so it reads as the job naming none.
  if (id === '') return undefined;
  // An unsubstituted variable is its own state rather than an id, for the reason `supervision` gives
  // about a recipient: printing the template to a reader dresses a bug up as a target.
  if (id.startsWith('${')) return { unresolved: true };
  if (assessments == null) return { id };

  try {
    const found = await assessments.named(id);
    if (found == null) return { id, missing: true };
    return { id, name: found.name, ...(found.archived ? { archived: true } : {}) };
  } catch {
    // The id, and no claim about what it names. Swallowed for the same reason the whole read is: a
    // definition store that is not answering must not take the panel's schedule and run history with it.
    return { id };
  }
}

/**
 * The parameter the job carries its assessment in.
 *
 * Must match `resources/scheduled-scan.yml` and the widget `schedule/trigger.py` reads, and is held to
 * both by `check:supervision` rather than by this comment — a rename in one place leaves the panel
 * reporting a job that names no assessment while the job names one, or the other way about.
 */
const ASSESSMENT_PARAMETER = 'assessment_id';

/**
 * What the job does about a failure: whether it tries again, and who hears about it.
 *
 * The other two things the bundle is authoritative for (AUD-DEC-108). The panel has always shown the
 * schedule and the identity, and cited a retry policy — `TRIGGER_EXPLANATION` and `WHY_NOT_A_SCAN` both
 * promise "its retry policy" — that no surface named. A reader looking at a failed run could not tell a
 * final failure from the first of four attempts, and could not tell whether the alert went anywhere.
 *
 * Undefined where the job configures neither, so the surface distinguishes "fails once and tells nobody"
 * from "the app has not looked". Both are real; only one is a problem, and they are not the same
 * sentence.
 */
function supervision(settings: JobSettings): SupervisionPayload | undefined {
  const retries = retriesOf(settings);
  // `on_failure` only. A success notification is a preference, and listing recipients who hear about
  // runs that worked would put the reassuring address next to the question "does anybody know when this
  // breaks" — which is the question the panel is answering.
  //
  /*
   * An unsubstituted bundle variable is its own answer, not an absent one.
   *
   * `${workspace.current_user.userName}` is what the bundle file holds before a deploy resolves it, and
   * printing it to a reader as an email address would be showing them a bug dressed as a recipient — which
   * is why `assessesAs` drops the same shape thirty lines above. But dropping it here silently is worse
   * than printing it: with no recipients left the panel says "No email address is set on the job for
   * failures", and an address *is* set. So it is carried as a third state instead.
   *
   * Assume this is reachable only for a job created outside the bundle, or by an older deploy: a
   * `databricks bundle deploy` resolves `${...}` or fails, so it should not write a literal template. That
   * is an assumption and not a measurement — nobody has produced the state from a deploy. It is kept
   * because the app reads whatever job carries the bundle's name, including one somebody made by hand, and
   * because the cost of being wrong is one branch rather than a false sentence.
   *
   * Counted rather than flagged. A boolean here meant "one or more", and the sentence built on it in
   * `notifyClause` rendered "one further recipient" and "the job's only failure recipient" — two derived
   * counts from a field that carried none, which is the fourth round of the same mistake on this panel.
   */
  const on = settings.email_notifications?.on_failure?.filter((who) => who.trim() !== '') ?? [];
  const notifies = on.filter((who) => !who.startsWith('${'));
  const unresolved = on.length - notifies.length;

  if (retries == null && on.length === 0) return undefined;

  return {
    ...(retries != null ? { retries } : {}),
    ...(notifies.length > 0 ? { notifies } : {}),
    ...(unresolved > 0 ? { unresolved } : {}),
  };
}

/**
 * The assessment task's retry policy, which is the one a reader is asking about.
 *
 * By task key, and by nothing else. The two tasks have deliberately different policies — the readiness
 * task does not retry a settled permission refusal, the assessment retries because its failures are
 * transient bursts — so taking the first task's policy would report a retrying job as one that gives up
 * immediately.
 *
 * # No fallback, deliberately
 *
 * An earlier version fell back to whichever task retried at all when the key did not match. That was
 * wrong in a way the payload could not express: `SupervisionPayload.retries` is documented as *the
 * assessment's* policy, and a job whose readiness task had been edited to retry would have had that
 * number carried under it and read out as the assessment's. A number attributed to the wrong task is
 * worse than no number, because a reader cannot tell it is wrong.
 *
 * The app reads whatever job carries the bundle's name in the customer's workspace, and a customer can
 * edit that job, so this is not a hypothetical. Undefined when the key is absent is the honest answer:
 * "the app could not find the task it reports on", which the panel renders as nothing rather than as a
 * guess.
 *
 * # What each value means
 *
 * `max_retries: 0` is a policy rather than an absence, and is reported as one: a job somebody has edited
 * down to no retries is exactly what a reader chasing a single silent failure needs told. Undefined means
 * the job did not say, which the Jobs API does for a task that never set the field.
 *
 * A negative value means retry indefinitely, per the Jobs API — `-1` is its documented spelling. It is
 * not carried, because every consumer of `times` treats it as a count: the prose read "retries itself -1
 * times", and the attempts arithmetic turned a job that never gives up into one that had "stopped
 * retrying". Undefined is not ideal here — there is a true thing to say and the panel stays quiet — but
 * it is silence rather than the opposite of the truth, and this bundle does not set it.
 */
function retriesOf(settings: JobSettings): SupervisionPayload['retries'] {
  const task = (settings.tasks ?? []).find((one) => one.task_key === ASSESS_TASK);
  if (task?.max_retries == null || task.max_retries < 0) return undefined;

  return {
    times: task.max_retries,
    ...(task.min_retry_interval_millis != null && task.min_retry_interval_millis > 0
      ? { waitMs: task.min_retry_interval_millis }
      : {}),
    ...(task.retry_on_timeout != null ? { onTimeout: task.retry_on_timeout } : {}),
  };
}

/**
 * The task that performs the assessment, whose retry policy is the one worth reporting.
 *
 * Must match `resources/scheduled-scan.yml`, and is held to it by `check:supervision` rather than by this
 * comment: a rename there without one here means `retriesOf` finds no task, and the panel silently stops
 * saying anything about retries at all.
 */
const ASSESS_TASK = 'assess';

/**
 * The newest failure's own words, added to the run that failed.
 *
 * Only the newest, and only when it failed. The reason costs two calls — the run to find which task
 * failed, then that task's output — and a page that spent twenty on ten historical failures would be
 * paying to tell a reader the same thing ten times. What a reader needs is why the cadence is not
 * working *now*.
 *
 * Failure here is not failure of the page. A reason that cannot be read leaves the run exactly as it
 * was, with the platform's message and a link, which is what this surface did before it could read one.
 */
async function withReason(
  workspace: Workspace,
  runs: readonly ScheduleRunPayload[]
): Promise<readonly ScheduleRunPayload[]> {
  const newest = runs.find((run) => run.state !== 'running' && run.state !== 'waiting');
  if (newest == null || newest.state !== 'failed') return runs;

  const failure = await reasonFor(workspace, Number(newest.runId));
  if (failure == null) return runs;

  return runs.map((run) => (run.runId === newest.runId ? { ...run, ...failure } : run));
}

/**
 * What the run's failed task says about itself: its error, and whether the retry policy covered it.
 *
 * The second half is the same call's second return, and it used to be read and thrown away. `covered` is
 * what a reader in front of a red row actually needs, and the page could not previously tell them: a
 * readiness failure sends them to a grant, and an assessment failure to a traceback. Same row, same
 * colour, opposite next actions.
 *
 * Deliberately no count and no tense. "Retried three times" was this comment's previous claim and it is
 * not knowable here: under a job-level policy the platform creates a new run per attempt and leaves the
 * original failed, which the app cannot see, and `scheduled-scan.yml` records the platform retrying an
 * internal error whatever the policy says. The field answers which step, not how many times.
 *
 * Decided here rather than on the client because the answer is "is this the task whose policy
 * `supervision` reports", and `ASSESS_TASK` is the only place that knows which task that is. Sending the
 * key instead would put a bundle string in a sentence and give the client a decision it cannot check.
 */
async function reasonFor(
  workspace: Workspace,
  runId: number
): Promise<Pick<ScheduleRunPayload, 'reason' | 'covered' | 'broke'> | undefined> {
  if (!Number.isFinite(runId)) return undefined;

  try {
    const run = await workspace.jobs.getRun({ run_id: runId });
    const tasks = run.tasks ?? [];
    /*
     * Two questions from one read, and deliberately not from the same task.
     *
     * `covered` is asked of the tasks that *broke*, because it is the answer to "is the step that failed the
     * one whose policy the panel quotes". An earlier version asked it of whichever task the reason came
     * from, which fell back to any non-success task — so a run skipped for concurrency, whose tasks are all
     * `SKIPPED` and nothing ran at all, was reported as a readiness refusal and sent a reader auditing
     * grants on an identity that never started.
     *
     * The reason may still come from a task that did not break, because a `SKIPPED` task's output is better
     * than nothing when there is nothing else to show.
     */
    const covered = coveredBy(tasks);
    const failed = blamed(tasks);

    // `covered` survives whatever happens to the second read, which is why that read has its own `try`. The
    // two facts cost different grants: which steps broke is on the run the app has already read, and the
    // error needs a second call and `CAN_VIEW` on that task's output. A reader refused the second still
    // learns which step failed, which is the half that decides what they do about the row.
    if (failed?.run_id == null) return covered;

    return { ...covered, ...(await reasonOf(workspace, failed.run_id)) };
  } catch {
    // Swallowed on purpose. This is an extra detail on a failure the reader can already see and act on; a
    // job run the app may not read must not turn a panel that says "failing, here is the run" into one
    // that says nothing.
    return undefined;
  }
}

/**
 * Whether the step that broke is the one whose retry policy the panel reports.
 *
 * Asked of every task that broke rather than of one chosen task, which is what makes it independent of the
 * order the Jobs API happens to list them in. An earlier version used `find`, and its own comment claimed
 * "order decides nothing" while two genuinely failed tasks left the answer to array position — reporting an
 * assessment that had broken and been retried three times as a step the policy never covered.
 *
 * Undefined where nothing broke. That is a real state: a run cancelled for concurrency, or one whose tasks
 * were all skipped or excluded, reaches a result without any step having run. The panel renders it as
 * silence, because "which step failed" has no answer when none did.
 */
function coveredBy(tasks: readonly JobRunTask[]): Pick<ScheduleRunPayload, 'covered' | 'broke'> {
  const broke = brokenIn(tasks);
  if (broke.length === 0) return {};

  return { covered: broke.some((task) => task.task_key === ASSESS_TASK), broke: broke.length };
}

/**
 * The steps that broke, in the order the platform listed them.
 *
 * Extracted because both callers need the same set, and the fourth round of review on this panel was caused
 * by them disagreeing about it: `covered` asked every broken task whether one was the assessment, and
 * `blamed` took the first, so a run with two broken steps could report one step's error under a sentence
 * about the other.
 */
function brokenIn(tasks: readonly JobRunTask[]): readonly JobRunTask[] {
  return tasks.filter((task) => task.state?.result_state != null && BROKE.has(task.state.result_state));
}

/**
 * The results that mean a step itself broke, as against being taken down with one that did.
 *
 * `TIMEDOUT` belongs with `FAILED` and was once missing, so the run a reader opens *because* it ran out of
 * time was the one the app said least about. `UPSTREAM_FAILED`, `SKIPPED` and `EXCLUDED` deliberately do
 * not belong: a dependent task's error is "An upstream task failed", which is the run's own message again.
 */
const BROKE: ReadonlySet<string> = new Set(['FAILED', 'TIMEDOUT']);

/**
 * The task whose own words are worth reading, which is the one that broke where there is one.
 *
 * Falls back to any task that did not succeed, because a run with only skipped tasks still has an output
 * worth a look.
 *
 * The assessment is preferred where several broke, and that is not a judgement about which failure
 * matters more — it is what stops the panel contradicting itself. `covered` says whether the assessment
 * was among the broken steps, and the sentence built on it renders directly above this task's error. An
 * earlier version took the first broken task in the platform's order, so a run where readiness and the
 * assessment both failed showed readiness's traceback under a sentence about the assessment. Whichever
 * step the reader is told about, the words underneath are now that step's.
 */
function blamed(tasks: readonly JobRunTask[]): JobRunTask | undefined {
  const broke = brokenIn(tasks);
  const covered = broke.find((task) => task.task_key === ASSESS_TASK);

  return (
    covered ??
    broke[0] ??
    tasks.find((task) => task.state?.result_state != null && task.state.result_state !== 'SUCCESS')
  );
}

/** The failed task's own words, where the reader's grants reach them. */
async function reasonOf(workspace: Workspace, runId: number): Promise<Pick<ScheduleRunPayload, 'reason'>> {
  try {
    const output = await workspace.jobs.getRunOutput({ run_id: runId });
    const reason = tidy(output.error);
    return reason != null ? { reason } : {};
  } catch {
    return {};
  }
}

/**
 * The task's error as one paragraph.
 *
 * Notebook errors arrive with the app's own sentence first and a Python traceback under it, and the
 * traceback is for whoever opens the run. Kept to what the app itself said, which was written to be
 * read by the person who has to act on it.
 */
function tidy(error: string | undefined): string | undefined {
  if (error == null || error.trim() === '') return undefined;

  const first = error
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line !== '');
  if (first == null) return undefined;

  // The exception's own class name is noise on a surface that has already said the run failed.
  const said = first.replace(/^[A-Za-z_][\w.]*(Error|Exception|Failed):\s*/u, '');
  return said.length > 400 ? `${said.slice(0, 399)}…` : said;
}

function describe(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** What a state means for whether the cadence is working. Used by the surface and by the tests. */
export function healthy(schedule: SchedulePayload): boolean {
  if (schedule.state !== 'live') return false;
  const last = schedule.runs.find((run) => run.state !== 'running' && run.state !== 'waiting');
  return last == null || last.state === 'succeeded';
}

export type { ScheduleStatePayload };
