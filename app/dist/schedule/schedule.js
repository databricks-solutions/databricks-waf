import { describeCadence, nextRun, readCadence } from "./cron.js";
//#region server/schedule/schedule.ts
/**
* The job's name, which is the only handle this module has on it.
*
* Must match `resources/scheduled-scan.yml`. A rename there without a change here reports
* `not-deployed` on an install that has a schedule, so the two are held together by a test that reads
* the yaml rather than by this comment.
*/
const JOB_NAME = "Well-Architected assessment";
/**
* What the schedule is, or why the app cannot say.
*
* Never throws. A schedule panel that fails the request it is part of would take the run history down
* with it, and the run history is the more important half: this is a reader finding out what happened
* *and* what will happen, and losing both because the Jobs API was slow is a bad trade.
*/
async function read(options = {}) {
	const { client } = options;
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	if (client == null) return {
		state: "unreadable",
		triggerable: false,
		runs: [],
		unreadable: "This install has no machine identity, so the app cannot look at its own scheduled job. Scans started by hand are unaffected, and the run history below is complete."
	};
	try {
		const workspace = await client();
		const job = await find(workspace);
		if (job == null) return {
			state: "not-deployed",
			triggerable: false,
			runs: []
		};
		const settings = job.settings ?? {};
		const schedule = settings.schedule;
		const cadence = schedule == null ? void 0 : readCadence(schedule.quartz_cron_expression);
		const paused = schedule == null || schedule.pause_status === "PAUSED";
		const due = cadence == null || paused ? void 0 : nextRun(cadence, schedule.timezone_id, now());
		const supervises = supervision(settings);
		const answers = await answering(settings, options.assessments);
		return {
			state: schedule == null ? "no-schedule" : paused ? "paused" : "live",
			jobId: String(job.job_id ?? ""),
			triggerable: true,
			...schedule != null ? {
				cron: schedule.quartz_cron_expression,
				timezone: schedule.timezone_id
			} : {},
			...cadence != null && schedule != null ? { cadence: describeCadence(cadence, schedule.timezone_id) } : {},
			...due != null ? { dueAt: due.toISOString() } : {},
			...runAs(settings.run_as) != null ? { ranAs: runAs(settings.run_as) } : {},
			...assessesAs(settings) != null ? { assessesAs: assessesAs(settings) } : {},
			...supervises != null ? { supervision: supervises } : {},
			...answers != null ? { answers } : {},
			runs: await withReason(workspace, await history(workspace, job.job_id))
		};
	} catch (cause) {
		return {
			state: "unreadable",
			triggerable: false,
			runs: [],
			unreadable: `The app could not read its scheduled job: ${describe(cause)}. It looks for a job named "${JOB_NAME}" and needs CAN_MANAGE_RUN on it, which the bundle grants when the job is deployed.`
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
async function find(workspace) {
	for await (const found of workspace.jobs.list({
		name: JOB_NAME,
		limit: 1
	})) {
		if (found.job_id == null) return found;
		return workspace.jobs.get({ job_id: found.job_id });
	}
}
async function history(workspace, jobId) {
	if (jobId == null) return [];
	const runs = [];
	for await (const run of workspace.jobs.listRuns({
		job_id: jobId,
		limit: 10,
		expand_tasks: false
	})) {
		runs.push({
			runId: String(run.run_id ?? ""),
			state: stateOf(run.state),
			...run.start_time != null && run.start_time > 0 ? { startedAt: new Date(run.start_time).toISOString() } : {},
			...run.end_time != null && run.end_time > 0 ? { finishedAt: new Date(run.end_time).toISOString() } : {},
			...run.run_duration != null && run.run_duration > 0 && ended(stateOf(run.state)) ? { durationMs: run.run_duration } : {},
			trigger: triggerOf(run.trigger),
			...run.state?.state_message != null && stateOf(run.state) === "failed" ? { message: run.state.state_message } : {},
			...run.run_page_url != null ? { url: run.run_page_url } : {},
			...run.attempt_number != null && run.attempt_number > 0 ? { attempt: run.attempt_number + 1 } : {}
		});
		if (runs.length >= 10) break;
	}
	return runs;
}
/** Whether a run has stopped, so that a figure about a finished run is only reported for one. */
function ended(state) {
	return state !== "running" && state !== "waiting";
}
/**
* The platform's two-part state as the one word a reader needs.
*
* `life_cycle_state` says where the run is and `result_state` says how it ended, and only the pair
* distinguishes the cases: a `TERMINATED` run is a success or a failure depending on the second, and a
* `SKIPPED` one never started. Collapsed here rather than on the page, because the surface should not
* be the place this product decides what "failed" means.
*/
function stateOf(state) {
	const life = state?.life_cycle_state;
	if (life === "PENDING" || life === "QUEUED" || life === "BLOCKED") return "waiting";
	if (life === "RUNNING" || life === "TERMINATING") return "running";
	switch (state?.result_state) {
		case "SUCCESS": return "succeeded";
		case "CANCELED": return "cancelled";
		case void 0: return life === "SKIPPED" || life === "INTERNAL_ERROR" ? "failed" : "unknown";
		default: return "failed";
	}
}
/** Whether a run happened because of the schedule, because somebody asked, or because of a retry. */
function triggerOf(trigger) {
	switch (trigger) {
		case "PERIODIC": return "schedule";
		case "ONE_TIME": return "hand";
		case "RETRY": return "retry";
		default: return "unknown";
	}
}
function runAs(identity) {
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
function assessesAs(settings) {
	for (const task of settings.tasks ?? []) {
		const client = task.notebook_task?.base_parameters?.["client_id"];
		if (client != null && client !== "" && !client.startsWith("${")) return client;
	}
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
async function answering(settings, assessments) {
	const parameter = (settings.tasks ?? []).find((one) => one.task_key === ASSESS_TASK)?.notebook_task?.base_parameters?.[ASSESSMENT_PARAMETER];
	if (parameter == null) return void 0;
	const id = parameter.trim();
	if (id === "") return void 0;
	if (id.startsWith("${")) return { unresolved: true };
	if (assessments == null) return { id };
	try {
		const found = await assessments.named(id);
		if (found == null) return {
			id,
			missing: true
		};
		return {
			id,
			name: found.name,
			...found.archived ? { archived: true } : {}
		};
	} catch {
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
const ASSESSMENT_PARAMETER = "assessment_id";
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
function supervision(settings) {
	const retries = retriesOf(settings);
	const on = settings.email_notifications?.on_failure?.filter((who) => who.trim() !== "") ?? [];
	const notifies = on.filter((who) => !who.startsWith("${"));
	const unresolved = on.length - notifies.length;
	if (retries == null && on.length === 0) return void 0;
	return {
		...retries != null ? { retries } : {},
		...notifies.length > 0 ? { notifies } : {},
		...unresolved > 0 ? { unresolved } : {}
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
function retriesOf(settings) {
	const task = (settings.tasks ?? []).find((one) => one.task_key === ASSESS_TASK);
	if (task?.max_retries == null || task.max_retries < 0) return void 0;
	return {
		times: task.max_retries,
		...task.min_retry_interval_millis != null && task.min_retry_interval_millis > 0 ? { waitMs: task.min_retry_interval_millis } : {},
		...task.retry_on_timeout != null ? { onTimeout: task.retry_on_timeout } : {}
	};
}
/**
* The task that performs the assessment, whose retry policy is the one worth reporting.
*
* Must match `resources/scheduled-scan.yml`, and is held to it by `check:supervision` rather than by this
* comment: a rename there without one here means `retriesOf` finds no task, and the panel silently stops
* saying anything about retries at all.
*/
const ASSESS_TASK = "assess";
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
async function withReason(workspace, runs) {
	const newest = runs.find((run) => run.state !== "running" && run.state !== "waiting");
	if (newest == null || newest.state !== "failed") return runs;
	const failure = await reasonFor(workspace, Number(newest.runId));
	if (failure == null) return runs;
	return runs.map((run) => run.runId === newest.runId ? {
		...run,
		...failure
	} : run);
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
async function reasonFor(workspace, runId) {
	if (!Number.isFinite(runId)) return void 0;
	try {
		const tasks = (await workspace.jobs.getRun({ run_id: runId })).tasks ?? [];
		const covered = coveredBy(tasks);
		const failed = blamed(tasks);
		if (failed?.run_id == null) return covered;
		return {
			...covered,
			...await reasonOf(workspace, failed.run_id)
		};
	} catch {
		return;
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
function coveredBy(tasks) {
	const broke = brokenIn(tasks);
	if (broke.length === 0) return {};
	return {
		covered: broke.some((task) => task.task_key === ASSESS_TASK),
		broke: broke.length
	};
}
/**
* The steps that broke, in the order the platform listed them.
*
* Extracted because both callers need the same set, and the fourth round of review on this panel was caused
* by them disagreeing about it: `covered` asked every broken task whether one was the assessment, and
* `blamed` took the first, so a run with two broken steps could report one step's error under a sentence
* about the other.
*/
function brokenIn(tasks) {
	return tasks.filter((task) => task.state?.result_state != null && BROKE.has(task.state.result_state));
}
/**
* The results that mean a step itself broke, as against being taken down with one that did.
*
* `TIMEDOUT` belongs with `FAILED` and was once missing, so the run a reader opens *because* it ran out of
* time was the one the app said least about. `UPSTREAM_FAILED`, `SKIPPED` and `EXCLUDED` deliberately do
* not belong: a dependent task's error is "An upstream task failed", which is the run's own message again.
*/
const BROKE = /* @__PURE__ */ new Set(["FAILED", "TIMEDOUT"]);
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
function blamed(tasks) {
	const broke = brokenIn(tasks);
	return broke.find((task) => task.task_key === ASSESS_TASK) ?? broke[0] ?? tasks.find((task) => task.state?.result_state != null && task.state.result_state !== "SUCCESS");
}
/** The failed task's own words, where the reader's grants reach them. */
async function reasonOf(workspace, runId) {
	try {
		const reason = tidy((await workspace.jobs.getRunOutput({ run_id: runId })).error);
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
function tidy(error) {
	if (error == null || error.trim() === "") return void 0;
	const first = error.split("\n").map((line) => line.trim()).find((line) => line !== "");
	if (first == null) return void 0;
	const said = first.replace(/^[A-Za-z_][\w.]*(Error|Exception|Failed):\s*/u, "");
	return said.length > 400 ? `${said.slice(0, 399)}…` : said;
}
function describe(cause) {
	return cause instanceof Error ? cause.message : String(cause);
}
//#endregion
export { JOB_NAME, read };
