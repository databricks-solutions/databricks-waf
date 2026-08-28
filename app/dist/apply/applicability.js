import "../attest/attestation.js";
import { longestAcceptanceDays } from "../accept/risk.js";
//#region server/apply/applicability.ts
/**
* The levers, written out here because the outcome vocabulary has no list of them and a constant a rule
* reads is better next to the rule.
*/
const LEVERS = ["not-applicable", "disabled"];
/**
* The readings that refuse either lever.
*
* `fail` and `partial` are the two where the app measured the requirement and found the estate wanting.
* `unmeasurable` is not here on purpose: marking a requirement inapplicable when nothing measured it is
* what the lever is for, and a customer with no streaming workloads should be able to exclude the
* streaming requirements. See ADR 0059.
*/
const REFUSED_READINGS = ["fail", "partial"];
/**
* The words that defeat the reason field, refused by name.
*
* A minimum length alone does not catch them: "none that apply here at present" is long enough and says
* nothing. Naming them lets the refusal tell somebody who wrote "n/a" what the field is for, rather than
* advising a longer non-answer.
*/
const EMPTY_ANSWERS = [
	"none",
	"n/a",
	"na",
	"nothing",
	"no",
	"not applicable",
	"tbc",
	"tbd"
];
function standingOf(decision, context = {}) {
	const now = context.now ?? /* @__PURE__ */ new Date();
	if (decision.revoked != null) return "revoked";
	if (context.superseded === true) return "superseded";
	if (decision.expiresAt.getTime() <= now.getTime()) return "expired";
	if (decision.effectiveFrom.getTime() > now.getTime()) return "pending";
	if (context.reading != null && REFUSED_READINGS.includes(context.reading)) return "lapsed";
	return decision.expiresAt.getTime() - now.getTime() <= 30 * 864e5 ? "expiring" : "active";
}
/**
* Whether this decision takes the requirement out of the denominator.
*
* Only `active` and `expiring`. `pending` does not — the requirement is still scored until the effective
* date. `expired` does not — that is what makes expiry mean something. `lapsed` does not — that is the
* whole point of the lapse.
*/
function effective(standing) {
	return standing === "active" || standing === "expiring";
}
var InvalidApplicabilityError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidApplicabilityError";
	}
};
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* One requirement per record rather than a list, the shape decision `accept/risk.ts` argues for: a
* decision covering nine requirements has one reason for nine different exclusions and expires for all
* nine on one day, so the ninth is reviewed on the schedule of the first.
*/
function applicabilityFrom(body, context) {
	const raw = body ?? {};
	const now = context.now ?? /* @__PURE__ */ new Date();
	const controlId = text(raw.controlId);
	if (controlId == null) throw new InvalidApplicabilityError("Name the requirement, as controlId.");
	if (!context.knownControl(controlId)) throw new InvalidApplicabilityError(`This framework has no requirement with the id ${controlId}.`);
	const lever = leverFrom(raw.lever);
	const reading = context.reading(controlId);
	const already = alreadyDecided(context.existing ?? [], now, reading?.outcome);
	if (already != null) throw new InvalidApplicabilityError(`${controlId} ${situation(already)}, recorded by ${already.decision.recordedBy} with ${already.decision.owner} answerable. Two decisions on one requirement would expire on different days and neither would be the one in force. Revoke that one, or renew it when it expires.`);
	if (reading != null && REFUSED_READINGS.includes(reading.outcome)) throw new InvalidApplicabilityError(`${controlId} ${reading.latest ? `is reading ${reading.outcome}` : `was read as ${reading.outcome} by a run before the most recent one, which has no reading for it`}: the requirement has been judged unmet, which is evidence it applies rather than that it does not. If you know and are living with it, accept the risk instead — with a compensating control, an owner and an expiry — so the failure stays in the score where a reader can see it.`);
	const reason = reasonFrom(raw.reason);
	const owner = text(raw.owner);
	if (owner == null) throw new InvalidApplicabilityError("Name who is answerable while this stands, as owner. A requirement taken out of the score with nobody against it is the sentence audit findings die of.");
	const effectiveFrom = effectiveFromFor(raw.effectiveFrom, now);
	return {
		controlId,
		lever,
		reason,
		owner,
		effectiveFrom,
		expiresAt: expiryFor(raw.expiresAt, effectiveFrom, now, context.severityOf(controlId))
	};
}
/**
* The decision as recorded, with who wrote it, when, and where it sits in the requirement's history.
*
* `previous` is every decision already recorded against this requirement. What this renews is the last
* of them, derived here rather than taken from the request: a body that could name it could point a
* renewal at somebody else's decision. The ordinal is their count, which is what the database refuses a
* second write of.
*/
function recorded(draft, by, id, at, previous = []) {
	const supersedes = newestFirst(previous)[0]?.id;
	return {
		id,
		controlId: draft.controlId,
		lever: draft.lever,
		ordinal: previous.length + 1,
		reason: draft.reason,
		owner: draft.owner,
		effectiveFrom: draft.effectiveFrom,
		expiresAt: draft.expiresAt,
		recordedBy: by,
		recordedAt: at,
		...supersedes != null ? { supersedes } : {}
	};
}
/**
* The decision after somebody ended it early.
*
* A second version of the record rather than a new one, unlike a renewal: nothing about the decision
* changed, it stopped. Revoking twice is refused rather than ignored, because the second revocation
* would replace the first one's reason and date with its own.
*/
function revoked(decision, by, reason, at) {
	if (decision.revoked != null) throw new InvalidApplicabilityError("This decision has already been revoked, and a revocation is not rewritten.");
	const why = text(reason);
	if (why == null || why.length < 20) throw new InvalidApplicabilityError(`Say why this is being revoked, in at least ${String(20)} characters. This puts the requirement back into the score, and whoever reads the change is owed the reason.`);
	return {
		...decision,
		revoked: {
			by,
			at,
			reason: why
		}
	};
}
/** Decisions newest first, because the last one about a requirement is the one being read. */
function newestFirst(decisions) {
	return [...decisions].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}
/**
* A decision already standing, counting one that has not started yet and one the reading has set aside.
*
* `pending` counts, so a decision from today and one from next month are not both writable. `lapsed`
* counts too, deliberately: a decision the reading has set aside is still on the record for this
* requirement, and the way back is to revoke it and record afresh, not to write a second one beside it.
*/
function alreadyDecided(existing, now, reading) {
	for (const decision of newestFirst(existing)) {
		const standing = standingOf(decision, {
			now,
			...reading != null ? { reading } : {}
		});
		if (standing === "active" || standing === "expiring" || standing === "pending" || standing === "lapsed") return {
			decision,
			standing
		};
	}
}
/**
* What the decision in the way is doing, in the refusal's own words.
*
* Per standing, because "is already excluded until X" was true of one of the three this refuses on. A
* pending decision excludes nothing yet — the module says so itself, two hundred lines up — and a lapsed
* one has stopped excluding, which is the state a reader is most likely to be trying to replace.
*/
function situation(already) {
	const until = dayNamed(already.decision.expiresAt);
	if (already.standing === "pending") return `already has a decision recorded, taking effect ${dayNamed(already.decision.effectiveFrom)} and running to ${until}`;
	if (already.standing === "lapsed") return `already has a decision recorded to ${until}, which this reading has set aside`;
	return `is already excluded until ${until}`;
}
function leverFrom(raw) {
	const supplied = text(raw);
	if (supplied == null || !LEVERS.includes(supplied)) throw new InvalidApplicabilityError(`Say which lever, as lever, one of ${LEVERS.join(", ")}.`);
	return supplied;
}
function reasonFrom(raw) {
	const reason = text(raw);
	if (reason != null && EMPTY_ANSWERS.includes(reason.toLowerCase().replace(/[.\s]+$/, ""))) throw new InvalidApplicabilityError(`A reason of “${reason}” says nothing a reviewer can check. Say why the requirement does not apply, or why its check is off, in a sentence somebody else can weigh months from now.`);
	if (reason == null || reason.length < 20) throw new InvalidApplicabilityError(`Say why this requirement is being taken out of the score, as reason, in at least ${String(20)} characters. Whoever inherits this has to be able to judge whether it still holds.`);
	return reason;
}
function effectiveFromFor(raw, now) {
	const supplied = text(raw);
	if (supplied == null) return now;
	const from = new Date(supplied);
	if (Number.isNaN(from.getTime())) throw new InvalidApplicabilityError("The effective date must be an ISO date, such as 2026-09-30.");
	if (from.getTime() < now.getTime() - 864e5) throw new InvalidApplicabilityError("A decision cannot be backdated: a record effective from before today would claim the requirement was excluded during a period nothing recorded it. Leave the date out to start it from now.");
	return from;
}
/**
* The expiry, capped by the requirement's severity.
*
* The cap is `longestAcceptanceDays`, the same table an acceptance is held to, because both answer "how
* long may a statement about this requirement stand unexamined" — and this lever does strictly more to a
* score than an acceptance does: an acceptance leaves the failure visible, and this takes the
* requirement out of the denominator. Without the cap, a decision could be written until 2199, and
* marking a critical requirement not applicable for a century is the way around the cap that the cap
* exists for.
*/
function expiryFor(raw, effectiveFrom, now, severity) {
	const supplied = text(raw);
	if (supplied == null) throw new InvalidApplicabilityError("Give the date this decision ends, as expiresAt. A requirement excluded with no end date is a decision that becomes policy without anybody deciding it should.");
	const expiresAt = new Date(supplied);
	if (Number.isNaN(expiresAt.getTime())) throw new InvalidApplicabilityError("The expiry must be an ISO date, such as 2026-09-30.");
	if (expiresAt.getTime() <= now.getTime()) throw new InvalidApplicabilityError("The expiry has to be in the future, or the decision has ended before it began.");
	if (expiresAt.getTime() <= effectiveFrom.getTime()) throw new InvalidApplicabilityError("The expiry has to be after the date this becomes effective.");
	const cap = severity == null ? void 0 : longestAcceptanceDays(severity);
	if (cap != null && expiresAt.getTime() - now.getTime() > cap * 864e5) throw new InvalidApplicabilityError(`A ${severity} requirement can be taken out of the score for at most ${String(cap)} days at a time, so this expiry is too far away. Choose a nearer one and renew it when it arrives — the point is that somebody looks again at whether it still does not apply.`);
	return expiresAt;
}
/**
* A date in a sentence a person reads, rather than the timestamp it is stored as.
*
* UTC, because the stored expiry is the end of a day in UTC and rendering it in the server's zone would
* name the day after it west of Greenwich.
*/
function dayNamed(when) {
	return when.toLocaleDateString("en-GB", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC"
	});
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
//#endregion
export { InvalidApplicabilityError, LEVERS, REFUSED_READINGS, applicabilityFrom, effective, newestFirst, recorded, revoked, standingOf };
