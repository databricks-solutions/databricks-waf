import { cadenceDaysFor } from "../attest/attestation.js";
//#region server/decide/decision.ts
const DISPOSITIONS = [
	"accepted",
	"deferred",
	"fixed",
	"reopened"
];
/** The two that park a finding until a date, and therefore the two that need one. */
function needsDate(disposition) {
	return disposition === "accepted" || disposition === "deferred";
}
/**
* How long a finding of this severity may be parked before somebody has to look again.
*
* The same intervals the attested answers renew on, and deliberately the same source rather than a
* second copy of the numbers: both are answering "how long may a statement about this requirement
* stand unexamined", and two tables that were meant to agree and drifted would be worse than one
* that is occasionally the wrong shape for one of them.
*/
function longestParkDays(severity) {
	return cadenceDaysFor(severity);
}
/**
* The whole table, for the form to read.
*
* Sent to the client rather than restated there: the form has to be able to refuse a date before the
* reader presses the button, and the only way to do that without a second copy of the rule is for
* the rule to travel.
*/
function parkDays() {
	return {
		critical: longestParkDays("critical"),
		high: longestParkDays("high"),
		medium: longestParkDays("medium"),
		low: longestParkDays("low"),
		informational: longestParkDays("informational")
	};
}
var InvalidDecisionError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidDecisionError";
	}
};
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* Validated here rather than at the route so the same rules apply to any caller, and so the
* messages can be written once. Every message says what to do, because the person who sees it is
* filling in a form and "invalid request" tells them nothing about which part of it.
*/
function draftFrom(body, context) {
	const raw = body ?? {};
	const now = context.now ?? /* @__PURE__ */ new Date();
	const controlId = text(raw.controlId);
	if (controlId == null) throw new InvalidDecisionError("Name the requirement being decided, as controlId.");
	if (!context.knownControl(controlId)) throw new InvalidDecisionError(`This framework has no requirement with the id ${controlId}.`);
	const disposition = text(raw.disposition);
	if (disposition == null || !DISPOSITIONS.includes(disposition)) throw new InvalidDecisionError(`The decision must be one of ${DISPOSITIONS.join(", ")}.`);
	const settled = disposition;
	const reason = text(raw.reason);
	if (reason == null || reason.length < 20) throw new InvalidDecisionError(`Say why, in at least ${String(20)} characters. A decision with no reason behind it cannot be reviewed by whoever inherits it.`);
	const owner = text(raw.owner);
	if (owner == null && settled !== "reopened") throw new InvalidDecisionError("Name who is answerable for this decision, as owner.");
	return {
		controlId,
		disposition: settled,
		reason,
		...owner != null ? { owner } : {},
		...untilFor(settled, raw.until, controlId, context, now)
	};
}
/**
* The date part, which is the only field whose rules differ per disposition.
*
* A date on a `fixed` claim is refused rather than ignored, because the two mean different things
* and silently dropping it would let a reader believe they had set a reminder. What settles a fix
* claim is the next run, not a date.
*/
function untilFor(disposition, raw, controlId, context, now) {
	const supplied = text(raw);
	if (!needsDate(disposition)) {
		if (supplied != null) throw new InvalidDecisionError(disposition === "fixed" ? "A fix claim takes no date: the next run is what confirms or contradicts it." : "Putting a requirement back on the list takes no date.");
		return {};
	}
	if (supplied == null) throw new InvalidDecisionError(disposition === "accepted" ? "Give the date this acceptance is to be reviewed, as until. An acceptance with no review date becomes policy." : "Give the date the fix is due, as until. A deferral with no date is a decision not to decide.");
	const until = new Date(supplied);
	if (Number.isNaN(until.getTime())) throw new InvalidDecisionError("The date must be an ISO date, such as 2026-09-30.");
	if (until.getTime() <= now.getTime()) throw new InvalidDecisionError("The date has to be in the future, or the decision is already lapsed.");
	const severity = context.severityOf(controlId);
	const cap = severity == null ? void 0 : longestParkDays(severity);
	if (cap != null && until.getTime() - now.getTime() > cap * 864e5) throw new InvalidDecisionError(`A ${severity ?? ""} requirement can be parked for at most ${String(cap)} days at a time, so this date is too far away. Choose a nearer one and decide again when it arrives — the point is that somebody looks, not that the fix lands by then.`);
	return { until };
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
//#endregion
export { DISPOSITIONS, InvalidDecisionError, draftFrom, longestParkDays, needsDate, parkDays };
