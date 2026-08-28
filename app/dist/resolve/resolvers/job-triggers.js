import { share } from "../../collect/sql/rows.js";
import { asJob } from "../locate.js";
import { bandOutcome, bandsOf, evidenceFrom, fromSignal, notApplicable, offenders, percent, triggerMechanismRecorded, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/job-triggers.ts
const JOBS = "sql:jobs.inventory";
const JOB_TRIGGERS_RESOLVERS = [fromSignal(JOBS, ["OE-02-05"], (jobs, context) => {
	if (jobs.length === 0) return notApplicable("This estate has no job definitions, so there is no scheduled ingestion here to react to a file or to poll for one. Work running only in interactive notebooks would not appear here.");
	const readable = jobs.filter((job) => triggerMechanismRecorded(job));
	const unreadable = jobs.length - readable.length;
	const fileArrival = readable.filter((job) => job.triggerType === "FILE_ARRIVAL");
	const polling = readable.filter((job) => job.triggerType === "PERIODIC" || job.triggerType === "CRON");
	const unreadableNoun = `${unreadable.toLocaleString("en-US")} job${unreadable === 1 ? "" : "s"}`;
	const unreadableVerb = unreadable === 1 ? "has" : "have";
	const unnamed = "no trigger this reading can name — either the definition records none, or it records more than one";
	if (fileArrival.length > 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, JOBS, `${fileArrival.length.toLocaleString("en-US")} job${fileArrival.length === 1 ? "" : "s"} triggered by file arrival` + (polling.length > 0 ? `, against ${polling.length.toLocaleString("en-US")} on a periodic or cron schedule` : "") + (unreadable > 0 ? `; ${unreadableNoun} ${unreadableVerb} ${unnamed}` : ""), "File ingestion reacts to a file arriving rather than polling a schedule to check")]
	};
	if (polling.length > 0) return unmeasured(`${polling.length.toLocaleString("en-US")} job${polling.length === 1 ? "" : "s"} run on a periodic or cron schedule and no job whose trigger this reading can name is triggered by file arrival. \`trigger_type\` records the mechanism a job uses to start, not what the job does once it runs, so this cannot say whether any of those jobs is polling for a file that may or may not have landed, or doing something with no file in it at all. A file-arrival trigger anywhere in the estate would settle this measure toward a pass; none existing does not settle it toward a fail.` + (unreadable > 0 ? ` A further ${unreadableNoun} ${unreadableVerb} ${unnamed}.` : ""), "attestation");
	if (unreadable > 0) return unmeasured(`${unreadableNoun} of ${jobs.length.toLocaleString("en-US")} ${unreadableVerb} ${unnamed}, and no job that records one is on a file-arrival, periodic or cron trigger. So whether anything here reacts to a file arriving is unknown rather than absent.`, "attestation");
	return notApplicable("Every job in this estate records a single trigger, and none of those is a file arrival or a periodic or cron schedule, so the choice between reacting to a file and polling for one does not arise here. A job on some other trigger — continuous, a table update, another job — is answering a different question than this one.");
}), fromSignal(JOBS, ["PE-05-03"], (jobs, context) => {
	if (jobs.length === 0) return notApplicable("This estate has no job definitions, so nothing here runs continuously for a backlog alert to watch. A streaming query in an interactive notebook would not appear here.");
	const continuous = jobs.filter((job) => job.continuous === true);
	if (continuous.length === 0) {
		const unreadable = jobs.filter((job) => !triggerMechanismRecorded(job)).length;
		if (unreadable > 0) return unmeasured(`No job here records a continuous trigger, and ${unreadable.toLocaleString("en-US")} of ${jobs.length.toLocaleString("en-US")} ${unreadable === 1 ? "records" : "record"} no trigger this reading can name — either the definition records none, or it records more than one and the set is not in this reading. Whether this estate runs a streaming job is unknown rather than settled, so whether one needs a backlog alert is unread.`, "attestation");
		return notApplicable("Every job in this estate records a single trigger and none of them is continuous, which is the mechanism a streaming job stays running under. There is no streaming workload here for a backlog alert to watch.");
	}
	const known = continuous.filter((job) => job.healthRulesKnown);
	if (known.length === 0) return unmeasured(`${continuous.length.toLocaleString("en-US")} continuous job${continuous.length === 1 ? "" : "s"} found, but none carries a readable health-rules list — the column is unpopulated for definitions not edited since early December 2025. Whether any of them alerts on backlog is unknown rather than absent.`, "attestation");
	const monitored = known.filter((job) => job.hasStreamBacklogRule);
	const unmonitored = known.filter((job) => !job.hasStreamBacklogRule);
	const adopted = share(monitored.length, known.length);
	const unknown = continuous.length - known.length;
	return {
		outcome: bandOutcome(adopted, bandsOf(context.spec, {
			pass: .8,
			partial: .3
		})),
		evidence: [evidenceFrom(context, JOBS, `${monitored.length} of ${known.length} continuous jobs with a readable health-rules list carry a streaming-backlog rule (${percent(adopted)})` + (unknown > 0 ? `; ${unknown.toLocaleString("en-US")} more have no readable health-rules list and are left out of the share` : ""), "Every continuous job carries a health rule watching streaming backlog"), ...offenders(context, JOBS, "Running without a backlog alert", unmonitored, asJob)],
		outcomeReason: "A backlog rule (`STREAMING_BACKLOG_BYTES`, `_RECORDS`, `_SECONDS` or `_FILES`) is the platform’s own mechanism for surfacing growing lag before a deadline is missed; a duration or failure rule alone does not watch for it. Measured only over continuous jobs whose health rules the system table records." + (unknown > 0 ? ` ${unknown.toLocaleString("en-US")} continuous job${unknown === 1 ? "" : "s"} predate the health-rules column and are excluded from the ratio rather than assumed either way.` : "")
	};
})];
//#endregion
export { JOB_TRIGGERS_RESOLVERS };
