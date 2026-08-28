//#region server/authorize/group.ts
/** The group whose members may change an assessment. Set by `databricks.yml`, from `var.assessor_group`. */
const GROUP_ENV = "WAF_ASSESSOR_GROUP";
/**
* Thrown at startup when the group is unset, so the app serves the explanation and does not run.
*
* Deliberately not a warning. A missing group name has one safe reading and one convenient one,
* and the convenient reading — allow everybody until somebody configures it — is the exposure this
* exists to close. Refusing to start is also the only failure an installer cannot miss.
*/
var UnconfiguredGroupError = class extends Error {
	constructor() {
		super(`${GROUP_ENV} is unset, so this app has no way to tell who is allowed to change an assessment and will not start rather than letting anyone who can open it start scans, answer requirements or accept risk. Set \`assessor_group\` in databricks.yml to the name of a Databricks group in this workspace — the group has to hold its members directly, because a group nested inside another is not reported as a membership — and redeploy.`);
	}
};
/**
* The configured group, or a thrown error naming what to set.
*
* Read once at startup rather than per request, unlike the warehouse binding, because the two fail
* differently. Rebinding a warehouse is a fix an admin makes while the app runs and wants to take
* effect on the next scan; changing this value means a redeploy, which restarts the app anyway.
* Reading it per request would only add a way for the gate to be open in one process and closed in
* another.
*/
function configuredGroup(env = process.env) {
	const name = (env["WAF_ASSESSOR_GROUP"] ?? "").trim();
	if (name === "") throw new UnconfiguredGroupError();
	return name;
}
/**
* Thrown when a caller may not make the change they asked for. Carries the sentence they see.
*
* `kind` exists so the refusal reads as one of two distinct events in a log and in a test: a
* stranger was turned away, or this app could not tell whether they were one. The second is a
* fault to investigate and the first is the gate working.
*/
var NotPermittedError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.kind = kind;
	}
};
/**
* Refuses a caller outside the group, and says which of the two refusals it is.
*
* Deny by default in the literal sense: every path that is not a proven membership throws. That
* includes the path where SCIM did not answer, which is the one worth arguing about — an app that
* fell open when it could not check would be an app whose authorization is contingent on an
* endpoint staying up.
*
* Names are compared case-insensitively and trimmed. Databricks group names are unique within a
* workspace and are what an admin configures, so a configured `Admins` matching `admins` in SCIM is
* the intent rather than a leniency.
*/
function requirePermission(group, caller) {
	const wanted = group.trim().toLowerCase();
	if (caller.groups == null) throw new NotPermittedError("membership-unknown", `This app could not establish which groups ${caller.actor} belongs to, so it cannot confirm membership of the ${group} group and refuses the change rather than allowing it. Reading the assessment is unaffected. This is a fault rather than a permission problem: the identity endpoint the app asks did not answer, or answered without listing groups.`);
	if (!caller.groups.some((held) => held.trim().toLowerCase() === wanted)) throw new NotPermittedError("not-a-member", `Changing an assessment is restricted to members of the ${group} group, and ${caller.actor} is not one. That covers starting and cancelling scans, answering the requirements only a person can answer, and accepting or deferring a risk. Reading the assessment, its history and the exports is unaffected. Ask a workspace admin to add you to that group directly — a group nested inside it does not count as a membership.`);
}
/**
* Says on the console that a refusal happened.
*
* No longer the record. The refusal is written to the audit log by the caller of this — see
* `permitted` in routes.ts, which awaits the append before the response goes out — and this is the
* operator's copy: visible in `databricks apps logs` while somebody is on the phone, where a query
* against a table is not.
*
* Kept rather than removed, because the two are read at different moments by different people, and
* the one that survives a deploy is not the one that is in front of you during an incident.
*
* The actor and the action are stamped, and the reason is not: the message is a paragraph written
* for the person who was refused, and a log line is for the operator asking who tried what.
*/
function recordRefusal(action, caller, error) {
	console.warn(`[authorize] refused ${action} to ${caller.actor}: ${error.kind}`);
}
//#endregion
export { GROUP_ENV, NotPermittedError, UnconfiguredGroupError, configuredGroup, recordRefusal, requirePermission };
