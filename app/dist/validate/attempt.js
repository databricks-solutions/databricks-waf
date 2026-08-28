//#region server/validate/attempt.ts
/** Which method answers a requirement, from what the catalogue says about it. */
function methodFor(measurability) {
	return measurability === "attestation" ? "attested" : "measured";
}
var InvalidAttemptError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidAttemptError";
	}
};
const DAY_MS = 1440 * 60 * 1e3;
/**
* Why a validation of this action cannot be asked for, or undefined while it can be.
*
* The same four checks `draftFrom` refuses on, in one function that returns prose rather than throwing,
* because both callers want the same sentences and only one of them wants an exception. A surface
* showing an action needs to know whether to offer the button and what to say instead — and a second
* copy of these rules in the client would be a button that offers what the server refuses.
*/
function whyNotRequestable(action, context) {
	if (action.state !== "ready-for-validation") return `Validation checks a claim that the work is done, and this action is ${action.state}. ` + (action.state === "verified" ? "It has already been verified by a run." : "Its owner has not said it is finished yet.");
	if (claimedAtOf(action) == null) return "This action is ready for validation but its history does not record when that was claimed, so there is no date for the evidence to be newer than. Move it back to in progress and offer it again.";
	const outstanding = outstandingIn(context.existing);
	if (outstanding != null) return `A validation of this action is already outstanding, waiting for a run after ${outstanding.observeFrom.toISOString()}. Two would be answered by the same run and neither would be the claim. Wait for it, or withdraw the claim and offer the work again.`;
	if (action.controlIds.length === 0) return "This action names no requirement — it was raised from an advisor finding, and the framework has no requirement that a run could answer for it. A later advisory is what says whether the advice still fires. Name a requirement this work also answers if there is one, and offer it again.";
	const unknown = action.controlIds.filter((id) => context.measurabilityOf(id) == null);
	if (unknown.length > 0) return `This framework no longer has ${unknown.join(", ")}, which this action names, so a run cannot answer for it. The requirement was withdrawn from the catalogue: cancel the action with that as the reason.`;
}
/**
* A draft from an action and an untrusted body, or an error naming what is wrong.
*
* The action rather than an id, because every field but the window comes from it and a request that
* could name its own requirements would be a request to validate something else. What the body
* supplies is one number.
*/
function draftFrom(action, body, context) {
	const refusal = whyNotRequestable(action, context);
	if (refusal != null) throw new InvalidAttemptError(refusal);
	const claimedAt = claimedAtOf(action);
	return {
		planId: action.planId,
		actionId: action.id,
		checks: action.controlIds.map((controlId) => ({
			controlId,
			method: methodFor(context.measurabilityOf(controlId))
		})),
		claimedAt,
		observeDays: observeDaysFrom(body)
	};
}
/** The attempt as requested, with who asked and when. */
function requested(draft, by, id, at) {
	return {
		id,
		planId: draft.planId,
		actionId: draft.actionId,
		checks: draft.checks,
		claimedAt: draft.claimedAt,
		requestedBy: by,
		requestedAt: at,
		observeFrom: new Date(at.getTime() + draft.observeDays * DAY_MS),
		observeDays: draft.observeDays
	};
}
/** The one attempt still waiting for an answer, where there is one. */
function outstandingIn(attempts) {
	return attempts.find((attempt) => attempt.answer == null);
}
/** The attempts against one action, newest first, because the last one is the one being read. */
function newestFirst(attempts) {
	return [...attempts].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
}
/**
* When the owner last said the work was done.
*
* The last such transition rather than the first, for the reason `improve/progress.ts` gives: an
* action sent back for more work and offered again is making a new claim, and the run that
* contradicted the first one has already had its say.
*/
function claimedAtOf(action) {
	const claims = action.history.filter((entry) => entry.to === "ready-for-validation");
	return claims.length === 0 ? void 0 : claims[claims.length - 1]?.at;
}
/**
* Whether this run is allowed to answer this attempt.
*
* Two conditions and they are not the same one: after the claim, because a run before it measured a
* half-finished change, and after the window, because that is the delay somebody asked for on the
* grounds that the estate would not show the change yet. A run in between is a real measurement of an
* estate that has not caught up, and reading it as a failed validation is how a correct fix gets
* reported as one that did not take.
*/
function answerable(attempt, run) {
	if (attempt.answer != null) return false;
	return run.measuredAt.getTime() >= attempt.observeFrom.getTime() && run.measuredAt.getTime() > attempt.claimedAt.getTime();
}
/**
* The attempt after a run answered it.
*
* The order of the three results is the argument. Unmet first, because a requirement the run says is
* still failing is the answer whatever else is true of the others — an attempt that reported
* `incomplete` while one of its requirements was measured as failing would be hiding the news behind
* the bookkeeping. Then unreadable, which includes human evidence that was not refreshed. A pass is
* what is left, and it is the only result that has nothing to explain.
*/
function answeredBy(attempt, run) {
	if (attempt.answer != null) throw new InvalidAttemptError("This validation has already been answered, and an answer is not rewritten.");
	if (!answerable(attempt, run)) throw new InvalidAttemptError(`This run finished at ${run.measuredAt.toISOString()}, which is before this validation can be answered: the claim was made at ${attempt.claimedAt.toISOString()} and the observation window runs to ${attempt.observeFrom.toISOString()}.`);
	if (attempt.checks.length === 0) throw new InvalidAttemptError("This validation checks no requirement, so no run can answer it. An attempt with nothing to measure would read as passed while measuring nothing.");
	const seen = new Map(run.observations.map((observation) => [observation.controlId, observation]));
	const unmet = [];
	const unreadable = [];
	const stale = [];
	for (const check of attempt.checks) {
		const observation = seen.get(check.controlId);
		const outcome = observation?.outcome;
		if (outcome === "fail" || outcome === "partial") {
			unmet.push(check.controlId);
			continue;
		}
		if (outcome == null || outcome === "unmeasurable") {
			unreadable.push(check.controlId);
			continue;
		}
		if (check.method === "attested" && !refreshed(observation, attempt.claimedAt)) {
			stale.push(check.controlId);
			unreadable.push(check.controlId);
		}
	}
	return {
		...attempt,
		answer: {
			result: unmet.length > 0 ? "failed" : unreadable.length > 0 ? "incomplete" : "passed",
			scanId: run.scanId,
			at: run.measuredAt,
			unmet,
			unreadable,
			...unmet.length === 0 && unreadable.length > 0 ? { why: whyIncomplete(unreadable, stale) } : {}
		}
	};
}
/**
* Whether the human evidence behind a met requirement was given after the claim.
*
* An absent date is not stale — see `Observation.attestedAt`. It means nothing about this outcome
* rested on somebody's word, which for a requirement the catalogue marks as attestation-only happens
* when the app measured it after all, or when the answer is recorded beside a measurement rather than
* carrying it. Both are stronger evidence than an attestation, so refusing them would be refusing the
* better answer.
*/
function refreshed(observation, claimedAt) {
	const at = observation?.attestedAt;
	return at == null || at.getTime() >= claimedAt.getTime();
}
/**
* Why an attempt could not be finished, naming the two kinds separately.
*
* They read the same in a list of ids and they are different problems with different next steps: one
* is the app not being able to see something, the other is a colleague needing to answer again. A
* single sentence about "requirements that could not be read" would send somebody to check a
* permission that is not the issue.
*/
function whyIncomplete(unreadable, stale) {
	const unread = unreadable.filter((id) => !stale.includes(id));
	const parts = [];
	if (unread.length > 0) parts.push(`this run could not read ${unread.join(", ")}, so it cannot say whether the work landed`);
	if (stale.length > 0) parts.push(`${stale.join(", ")} ${stale.length === 1 ? "is answered" : "are answered"} by somebody's word, and the answer on record was given before this work was claimed — it says what was true beforehand. Somebody has to attest to it again`);
	return `${parts.join("; and ")}.`;
}
/**
* The attempt after the claim it was testing went away.
*
* An owner who withdraws a claim — realising they tested the wrong workspace, say — leaves an attempt
* waiting for a run to answer a question nobody is asking. It is closed as `incomplete` with no run,
* rather than deleted, because the fact that somebody offered work for validation and took it back is
* part of the story of the action, and a board that showed nothing would show four attempts where
* there had been five.
*/
function abandoned(attempt, why, at) {
	if (attempt.answer != null) throw new InvalidAttemptError("This validation has already been answered, and an answer is not rewritten.");
	return {
		...attempt,
		answer: {
			result: "incomplete",
			at,
			unmet: [],
			unreadable: attempt.checks.map((check) => check.controlId),
			why
		}
	};
}
/** Whether this attempt is what permits an action to become verified. Nothing else does. */
function verifies(attempt) {
	return attempt.answer?.result === "passed";
}
/**
* The window from an untrusted body: a whole number of days, none by default.
*
* Zero by default rather than a guess at a propagation delay, and that is a decision worth naming
* because it is the weaker half of this module. The right default would come from how each signal is
* computed — a setting read straight from an API is true the moment it is changed, while a rate
* computed over a thirty-day lookback still contains a month of the old behaviour and cannot support
* a fix claim for a month. This app does not record which of its signals are windowed, so the choice
* is between a default that is wrong for one kind and a default of nothing plus a field the requester
* can set. Nothing is the honest one: a validation answered too early reports `failed`, which sends
* somebody to look, and a window invented on their behalf would report `passed` late without anybody
* knowing why they waited.
*/
function observeDaysFrom(body) {
	const raw = body ?? {};
	if (raw.observeDays == null) return 0;
	const days = typeof raw.observeDays === "number" ? raw.observeDays : Number(raw.observeDays);
	if (!Number.isFinite(days) || !Number.isInteger(days)) throw new InvalidAttemptError("The observation window has to be a whole number of days, as observeDays.");
	if (days < 0) throw new InvalidAttemptError("An observation window cannot be negative. Leave it out to accept the next run.");
	if (days > 90) throw new InvalidAttemptError(`The longest observation window is ${String(90)} days. A claim waiting longer than that is work in hand that nothing is measuring — withdraw it and offer it again when the estate will show the change.`);
	return days;
}
//#endregion
export { InvalidAttemptError, abandoned, answerable, answeredBy, claimedAtOf, draftFrom, methodFor, newestFirst, outstandingIn, requested, verifies, whyNotRequestable };
