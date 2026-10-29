import { share } from "../../collect/sql/rows.js";
import { asJob } from "../locate.js";
import { bandOutcome, bandsOf, evidenceFrom, fromSignal, notApplicable, offenders, percent } from "./helpers.js";
//#region server/resolve/resolvers/security-jobs.ts
/**
* The job inventory. The detail evidence that lists the jobs running as a user account carries that
* account beside each, so `share/projection.ts` knows this id and `RUN_AS_USER_LEAD` and withholds that
* evidence from readers outside the assessor group.
*/
const JOBS = "sql:jobs.inventory";
/** The lead of the detail evidence naming the jobs that run as a user account. */
const RUN_AS_USER_LEAD = "Running as a user account";
const DBFS_TABLES = "sql:security.dbfs_tables";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
* Classify a run-as name (decision A7 in docs/decisions.md).
*
* `run_as_user_name` is the email of a user, the application ID of a service principal, or a group name.
* An email is a user, and a UUID is a service principal. Anything else, a group name included, cannot be
* told apart from the others by its shape and is unknown; so is a name that was never recorded. No
* directory lookup is made to resolve them, because that would add a call and a dependency on an API
* that not every reader of the estate can use.
*/
function runAsKind(name) {
	const value = name?.trim() ?? "";
	if (value === "") return "unknown";
	if (/^[^@\s]+@[^@\s]+$/.test(value)) return "user";
	if (UUID.test(value)) return "service-principal";
	return "unknown";
}
const SECURITY_JOBS_RESOLVERS = [fromSignal(JOBS, ["SCP-04-22"], (jobs, context) => {
	if (jobs.length === 0) return notApplicable("There are no jobs in this estate, so there is no run-as identity to assess.");
	const userRunJobs = jobs.filter((job) => runAsKind(job.runAsName) === "user");
	const spCount = jobs.filter((job) => runAsKind(job.runAsName) === "service-principal").length;
	const classified = userRunJobs.length + spCount;
	const unknown = jobs.length - classified;
	if (classified === 0) return notApplicable(`None of the ${jobs.length.toLocaleString("en-US")} job${jobs.length === 1 ? "" : "s"} in this estate has a run-as name that can be classified. This column is not populated for job definitions written before early December 2025, so these jobs have no run-as name recorded or one that is not an email address or a service principal ID, such as a group name; once the jobs are edited or replaced the name will appear.`);
	const spShare = share(spCount, classified);
	const evidenceSentence = `${spCount.toLocaleString("en-US")} of ${classified.toLocaleString("en-US")} jobs with a recognised identity run as a service principal (${percent(spShare)})` + (unknown > 0 ? `; ${unknown.toLocaleString("en-US")} job${unknown === 1 ? "" : "s"} cannot be classified, with no run-as name recorded or one that is neither an email address nor a service principal ID` : "");
	return {
		outcome: bandOutcome(spShare, bandsOf(context.spec, {
			pass: 1,
			partial: .8
		})),
		evidence: [evidenceFrom(context, JOBS, evidenceSentence, "Every job runs as a service principal, so its permissions are scoped to the workload"), ...offenders(context, JOBS, RUN_AS_USER_LEAD, userRunJobs, asJob, { note: (job) => job.runAsName })],
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
export { JOBS, RUN_AS_USER_LEAD, SECURITY_JOBS_RESOLVERS, runAsKind };
