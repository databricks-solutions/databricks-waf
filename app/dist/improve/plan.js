//#region server/improve/plan.ts
var InvalidPlanError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidPlanError";
	}
};
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* The identity and the timestamp are absent on purpose, as they are on a decision draft: a client
* that could send `createdBy` could attribute a plan to a colleague.
*/
function draftFrom(body, context = {}) {
	const raw = body ?? {};
	const title = text(raw.title);
	if (title == null) throw new InvalidPlanError("Give the plan a title, as title.");
	const outcome = text(raw.outcome);
	if (outcome == null || outcome.length < 20) throw new InvalidPlanError(`Say what is different when this plan is finished, as outcome, in at least ${String(20)} characters. A plan with a title and no outcome is a folder.`);
	const owners = [...new Set(list(raw.owners, "owners"))];
	if (owners.length === 0) throw new InvalidPlanError("Name who is answerable for this plan, as owners. A plan nobody owns is a list somebody wrote once.");
	const raisedFrom = text(raw.raisedFrom);
	return {
		title,
		outcome,
		owners,
		...assessmentFrom(raw.assessment, context),
		...raisedFrom != null ? { raisedFrom } : {}
	};
}
/**
* The assessment reference, refused rather than dropped when it names nothing.
*
* A plan citing an assessment that does not exist is worse than one citing none: the citation is what
* a reader uses to decide whether the plan is about the estate they are looking at, so a dangling one
* answers that question wrongly rather than leaving it open.
*/
function assessmentFrom(raw, context) {
	if (raw == null) return {};
	const supplied = raw;
	const definitionId = text(supplied.definitionId);
	const version = typeof supplied.version === "number" ? supplied.version : NaN;
	if (definitionId == null || !Number.isInteger(version) || version < 1) throw new InvalidPlanError("An assessment reference needs both a definitionId and a whole version number. Leave it out entirely if this plan is not written against an assessment.");
	if (context.knownAssessment != null && !context.knownAssessment(definitionId, version)) throw new InvalidPlanError(`There is no version ${String(version)} of the assessment ${definitionId}.`);
	return { assessment: {
		definitionId,
		version
	} };
}
/**
* The plan after somebody closed it, or an error saying why it cannot be closed yet.
*
* Closing is refused while any action is still live, and that refusal is the only rule a plan has of
* its own. A closed plan whose actions are still in progress is the state a programme review is
* misled by: the plan reads finished, the work is not, and the actions are the ones that were
* forgotten. Cancelling the actions is the honest way to close a plan whose work is not going to
* happen, and it leaves a record of that decision on each of them.
*/
function closed(plan, actions, closure) {
	if (plan.closed != null) throw new InvalidPlanError("This plan is already closed.");
	const reason = closure.reason.trim();
	if (reason.length < 20) throw new InvalidPlanError(`Say why the plan is being closed, in at least ${String(20)} characters. Whoever reads this next is deciding whether the work it described still needs doing.`);
	const live = actions.filter((action) => action.planId === plan.id && action.state !== "verified" && action.state !== "cancelled");
	if (live.length > 0) throw new InvalidPlanError(`${String(live.length)} action${live.length === 1 ? "" : "s"} in this plan ${live.length === 1 ? "is" : "are"} still live. Verify or cancel each of them first — a closed plan with live actions under it reads as finished work in every rollup that counts plans.`);
	return {
		...plan,
		revision: plan.revision + 1,
		closed: {
			at: closure.at ?? /* @__PURE__ */ new Date(),
			by: closure.by,
			reason
		}
	};
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Strings from an untrusted array. A blank is dropped; anything that is not a string is refused.
*
* Same rule and same reasoning as `action.ts`: a blank row is somebody who has not typed yet, and a
* value of the wrong type is a caller that is wrong about the shape. Dropping the second silently
* would store a plan owned by fewer people than whoever created it believes, which is the field this
* record exists to make answerable.
*/
function list(value, field) {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new InvalidPlanError(`${field} has to be a list of text values.`);
	const entries = [];
	for (const entry of value) {
		if (typeof entry !== "string") throw new InvalidPlanError(`Every entry in ${field} has to be text, and one of them is not.`);
		const trimmed = text(entry);
		if (trimmed != null) entries.push(trimmed);
	}
	return entries;
}
//#endregion
export { InvalidPlanError, closed, draftFrom };
