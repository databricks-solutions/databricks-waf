import { share } from "../../collect/sql/rows.js";
import { asJob } from "../locate.js";
import { bandOutcome, bandsOf, evidenceFrom, fromSignal, notApplicable, offenders, percent } from "./helpers.js";
//#region server/resolve/resolvers/security-jobs.ts
const JOBS = "sql:jobs.inventory";
const DBFS_TABLES = "sql:security.dbfs_tables";
const SECURITY_JOBS_RESOLVERS = [fromSignal(JOBS, ["SCP-04-22"], (jobs, context) => {
	if (jobs.length === 0) return notApplicable("There are no jobs in this estate, so there is no run-as identity to assess.");
	const known = jobs.filter((job) => job.runAs != null && job.runAs !== "");
	const unknown = jobs.length - known.length;
	if (known.length === 0) return notApplicable(`All ${jobs.length.toLocaleString("en-US")} job${jobs.length === 1 ? "" : "s"} in this estate have no run_as identity recorded. This column is not populated for job definitions written before early December 2025; once those jobs are edited or replaced the identity will appear.`);
	const userRunJobs = known.filter((job) => job.runAs.includes("@"));
	const spCount = known.length - userRunJobs.length;
	const spShare = share(spCount, known.length);
	const evidenceSentence = `${spCount.toLocaleString("en-US")} of ${known.length.toLocaleString("en-US")} jobs with a recorded identity run as a service principal (${percent(spShare)})` + (unknown > 0 ? `; ${unknown.toLocaleString("en-US")} job${unknown === 1 ? "" : "s"} have no identity recorded yet` : "");
	return {
		outcome: bandOutcome(spShare, bandsOf(context.spec, {
			pass: 1,
			partial: .8
		})),
		evidence: [evidenceFrom(context, JOBS, evidenceSentence, "Every job runs as a service principal, so its permissions are scoped to the workload"), ...offenders(context, JOBS, "Running as a user account", userRunJobs, asJob, { note: (job) => job.runAs })],
		outcomeReason: spShare === 1 ? void 0 : userRunJobs.length === 1 ? "One job runs as a user account. That job inherits its owner’s access, which expands and contracts as their grants change, and becomes a dangling credential if they leave." : `${userRunJobs.length.toLocaleString("en-US")} jobs run as user accounts. Each one inherits its owner’s access, which expands and contracts as their grants change, and becomes a dangling credential if they leave.`
	};
}), fromSignal(DBFS_TABLES, ["SCP-04-05"], (audit, context) => {
	if (audit.totalManagedTables === 0) return notApplicable("This metastore contains no Unity Catalog managed tables (as seen by `system.information_schema`), so there are no storage paths to assess. Legacy Hive Metastore tables are outside the scope of this signal and require migration to Unity Catalog.");
	if (audit.dbfsRootTables === 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, DBFS_TABLES, `${audit.totalManagedTables.toLocaleString("en-US")} managed table${audit.totalManagedTables === 1 ? "" : "s"} assessed, none stored on DBFS root`, "Every Unity Catalog managed table has its data in a governed cloud location, not on DBFS root")]
	};
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, DBFS_TABLES, `${audit.dbfsRootTables.toLocaleString("en-US")} of ${audit.totalManagedTables.toLocaleString("en-US")} Unity Catalog managed table${audit.dbfsRootTables === 1 ? " has its" : "s have their"} data on DBFS root`, "Every Unity Catalog managed table has its data in a governed cloud location, not on DBFS root")],
		outcomeReason: "Data on DBFS root is not governed by Unity Catalog at the file level. Any cluster with access to the workspace DBFS root can read or overwrite this data regardless of catalogue grants, which makes it impossible to enforce least privilege through Unity Catalog alone. Move these tables to a managed storage location or an external location backed by a storage credential."
	};
})];
//#endregion
export { SECURITY_JOBS_RESOLVERS };
