import { JOB_NAME } from "./schedule.js";
//#region server/schedule/trigger.ts
async function trigger(options) {
	const workspace = await options.client();
	let jobId;
	for await (const job of workspace.jobs.list({
		name: JOB_NAME,
		limit: 1
	})) jobId = job.job_id;
	if (jobId == null) return {
		error: "no-such-job",
		status: 409,
		message: `No job named "${JOB_NAME}" is deployed in this workspace, so there is no scheduled assessment to start. It is the optional half of the bundle; deploying it adds the schedule, and until then assessments are the ones somebody runs.`
	};
	for await (const _active of workspace.jobs.listRuns({
		job_id: jobId,
		active_only: true,
		limit: 1
	})) return {
		error: "already-running",
		status: 409,
		message: "The scheduled assessment is already running, so a second one was not started — the job takes one at a time. It is the newest run listed here, and the completed scan appears there when it finishes."
	};
	const started = await workspace.jobs.runNow({ job_id: jobId });
	return { run: {
		runId: String(started.run_id ?? ""),
		state: "waiting",
		trigger: "hand"
	} };
}
//#endregion
export { trigger };
