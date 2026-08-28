//#region server/attest/attestation.ts
const ANSWERS = [
	"met",
	"partially-met",
	"not-met",
	"not-applicable"
];
/**
* How long an answer stands before it has to be given again, by how much it matters.
*
* A single interval for everything would be wrong in both directions: asking annually
* whether encryption keys are rotated is too slow for a critical practice, and asking
* quarterly whether documentation conventions are agreed is how a review process gets
* abandoned. The catalogue may override per control; these are what it falls back to.
*/
const CADENCE_DAYS = {
	critical: 90,
	high: 180,
	medium: 365,
	low: 365,
	informational: 365
};
function cadenceDaysFor(severity, catalogueOverride) {
	return catalogueOverride ?? CADENCE_DAYS[severity];
}
const DAY_MS = 1440 * 60 * 1e3;
function stateOf(attestation, now = /* @__PURE__ */ new Date()) {
	const remaining = attestation.reviewBy.getTime() - now.getTime();
	if (remaining <= 0) return "expired";
	const validity = Math.max(0, attestation.reviewBy.getTime() - attestation.attestedAt.getTime());
	return remaining <= Math.min(30 * 864e5, validity / 3) ? "due" : "current";
}
/** Whether it still counts as evidence. Due is still current; expired is not. */
function counts(attestation, now = /* @__PURE__ */ new Date()) {
	return stateOf(attestation, now) !== "expired";
}
function reviewDateFrom(attestedAt, cadenceDays) {
	return new Date(attestedAt.getTime() + cadenceDays * DAY_MS);
}
var InvalidAttestationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidAttestationError";
	}
};
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* Validated here rather than at the route so the same rules apply to any caller, and so
* the messages can be written once. Every message names what to do, because the person who
* sees it is filling in a form and "invalid request" tells them nothing about which part.
*/
function draftFrom(body, knownControl) {
	const raw = body ?? {};
	const controlId = text(raw.controlId);
	if (controlId == null) throw new InvalidAttestationError("Name the requirement being attested, as controlId.");
	if (!knownControl(controlId)) throw new InvalidAttestationError(`This framework has no requirement with the id ${controlId}.`);
	const answer = text(raw.answer);
	if (answer == null || !ANSWERS.includes(answer)) throw new InvalidAttestationError(`The answer must be one of ${ANSWERS.join(", ")}.`);
	const statement = text(raw.statement);
	if (statement == null || statement.length < 20) throw new InvalidAttestationError(`Say what the answer rests on, in at least ${String(20)} characters. An answer with no statement behind it cannot be reviewed later.`);
	const owner = text(raw.owner);
	if (owner == null) throw new InvalidAttestationError("Name who is accountable for this practice, as owner.");
	const evidenceUrl = text(raw.evidenceUrl);
	if (evidenceUrl != null && !/^https?:\/\//i.test(evidenceUrl)) throw new InvalidAttestationError("The evidence link must be an http or https URL.");
	return {
		controlId,
		answer,
		statement,
		owner,
		...evidenceUrl != null ? { evidenceUrl } : {}
	};
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
//#endregion
export { ANSWERS, DAY_MS, InvalidAttestationError, cadenceDaysFor, counts, draftFrom, reviewDateFrom, stateOf };
