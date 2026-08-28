import { cadenceDaysFor } from "../attest/attestation.js";
//#region server/accept/risk.ts
/**
* The scale, most severe first, because the order is what the ceiling below compares.
*
* Written out here rather than imported: the outcome vocabulary has no list of the five, and a
* constant whose order carries a rule is better next to the rule than three modules away where the
* next person to alphabetise it would not know what they had changed.
*/
const RESIDUAL_RISKS = [
	"critical",
	"high",
	"medium",
	"low",
	"informational"
];
/**
* The words that defeat the compensating-control field, refused by name.
*
* A minimum length alone does not catch them: "none that apply here at present" is long enough and
* says nothing. These are the ones worth naming in the refusal, with the sentence the writer should
* write instead, because somebody typing "n/a" is usually not hiding anything — they have read the
* field as paperwork and need telling what it is for.
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
/**
* How long a requirement of this severity may be accepted for at a time.
*
* The parked-decision cap, from the same table, for the reason that table gives: both are answering
* "how long may a statement about this requirement stand unexamined". A record that could be written
* for longer than the same requirement could be deferred for would make this the way around the cap.
*/
function longestAcceptanceDays(severity) {
	return cadenceDaysFor(severity);
}
/** The whole table, so the form can refuse a date before the reader presses the button. */
function acceptanceDays() {
	return {
		critical: longestAcceptanceDays("critical"),
		high: longestAcceptanceDays("high"),
		medium: longestAcceptanceDays("medium"),
		low: longestAcceptanceDays("low"),
		informational: longestAcceptanceDays("informational")
	};
}
function standingOf(risk, context = {}) {
	const now = context.now ?? /* @__PURE__ */ new Date();
	if (risk.revoked != null && risk.revoked.at.getTime() <= now.getTime()) return "revoked";
	if (context.superseded === true) return "superseded";
	if (risk.expiresAt.getTime() <= now.getTime()) return "expired";
	if (risk.effectiveFrom.getTime() > now.getTime()) return "pending";
	return risk.expiresAt.getTime() - now.getTime() <= 30 * 864e5 ? "expiring" : "active";
}
/**
* Whether this acceptance takes the finding off the work queue.
*
* Only while it is effective. `pending` does not park — the whole point of a future effective date is
* that the work is still expected until then — and neither does `expired`, which is what makes expiry
* mean something rather than being a date in a record nobody reads.
*/
function effective(standing) {
	return standing === "active" || standing === "expiring";
}
var InvalidRiskError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidRiskError";
	}
};
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* One requirement per record rather than a list, which is the shape decision on this record worth
* arguing for. An acceptance covering nine requirements has one reason and one compensating control
* for nine different exposures, and it expires for all nine on the same day — so the ninth is reviewed
* on the schedule of the first. Nine records is more typing and it is nine things somebody can review,
* revoke and renew separately, which is what the record is for.
*/
function riskFrom(body, context) {
	const raw = body ?? {};
	const now = context.now ?? /* @__PURE__ */ new Date();
	const controlId = text(raw.controlId);
	if (controlId == null) throw new InvalidRiskError("Name the requirement being accepted, as controlId.");
	if (!context.knownControl(controlId)) throw new InvalidRiskError(`This framework has no requirement with the id ${controlId}.`);
	const standing = alreadyAccepted(context.existing ?? [], now);
	if (standing != null) throw new InvalidRiskError(`This requirement is already accepted until ${dayNamed(standing.expiresAt)}, by ${standing.owner}. Two acceptances of one requirement would expire on different days and neither would be the one in force. Revoke that one, or renew it when it expires.`);
	const reason = text(raw.reason);
	if (reason == null || reason.length < 20) throw new InvalidRiskError(`Say why this requirement is not being met, in at least ${String(20)} characters. Whoever inherits this has to be able to judge whether it still holds.`);
	const compensatingControl = compensatingControlFrom(raw.compensatingControl, reason);
	const severity = context.severityOf(controlId);
	const residual = residualFrom(raw.residual, controlId, severity);
	const owner = text(raw.owner);
	if (owner == null) throw new InvalidRiskError("Name who is answerable while this stands, as owner. An accepted risk with nobody against it is the sentence audit findings die of.");
	const effectiveFrom = effectiveFromFor(raw.effectiveFrom, now);
	return {
		controlId,
		reason,
		compensatingControl,
		residual,
		owner,
		effectiveFrom,
		expiresAt: expiryFor(raw.expiresAt, effectiveFrom, severity, now)
	};
}
/**
* The acceptance as recorded, with who wrote it, when, and where it sits in the requirement's history.
*
* `previous` is every acceptance already recorded against this requirement, and both facts derived from
* it are derived here rather than taken from the request. What this renews is the last of them: a body
* that could name it could point a renewal at somebody else's acceptance, and the chain of how long an
* exposure has been carried would be the requester's to write. The ordinal is their count, which is what
* the database refuses a second write of.
*/
function recorded(draft, by, id, at, previous = []) {
	const supersedes = newestFirst(previous)[0]?.id;
	return {
		id,
		controlId: draft.controlId,
		ordinal: previous.length + 1,
		reason: draft.reason,
		compensatingControl: draft.compensatingControl,
		residual: draft.residual,
		owner: draft.owner,
		effectiveFrom: draft.effectiveFrom,
		expiresAt: draft.expiresAt,
		recordedBy: by,
		recordedAt: at,
		...supersedes != null ? { supersedes } : {}
	};
}
/**
* The acceptance after somebody ended it early.
*
* A second version of the record rather than a new one, unlike a renewal: nothing about the acceptance
* changed, it stopped. Revoking twice is refused rather than ignored, because the second revocation
* would otherwise replace the first one's reason and date with its own — and who ended this, when, is
* the part of a revocation anybody comes back for.
*/
function revoked(risk, by, reason, at) {
	if (risk.revoked != null) throw new InvalidRiskError("This acceptance has already been revoked, and a revocation is not rewritten.");
	const why = text(reason);
	if (why == null || why.length < 20) throw new InvalidRiskError(`Say why this is being revoked, in at least ${String(20)} characters. This puts the requirement back on somebody’s queue before the date they were told to expect, and they are owed the reason.`);
	return {
		...risk,
		revoked: {
			by,
			at,
			reason: why
		}
	};
}
/**
* The one acceptance of a requirement that is in force at an instant, where there is one.
*
* Newest first, so a renewal recorded while the previous one is still running is what a reader sees —
* although `riskFrom` refuses that case, so in practice this finds the only effective one.
*
* `now` is the instant asked about and a past one is a real question: a published month asks which
* acceptances stood when it closed. Every date on the record is read against it, so an acceptance
* revoked or renewed after that instant is the acceptance that stood at it.
*/
function inForce(risks, now = /* @__PURE__ */ new Date()) {
	return newestFirst(risks).find((risk) => effective(standingOf(risk, { now })));
}
/** Acceptances newest first, because the last decision about a requirement is the one being read. */
function newestFirst(risks) {
	return [...risks].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}
/**
* An acceptance already standing, counting one that has not started yet.
*
* `pending` counts, and that is the answer to a real question: somebody accepting the same requirement
* twice, once from today and once from next month, has written two records where the second silently
* takes over from the first with a different owner and a different reason. One at a time, and a renewal
* when the first ends.
*/
function alreadyAccepted(existing, now) {
	return newestFirst(existing).find((risk) => {
		const standing = standingOf(risk, { now });
		return effective(standing) || standing === "pending";
	});
}
/**
* A date in a sentence a person reads, rather than the timestamp it is stored as.
*
* The refusal above quoted `2026-10-03T23:59:59.999Z` at somebody being told why their acceptance was
* declined. It is the correct instant and it reads as a fault in the app: the milliseconds and the zone
* are the record's business, and the reader's question is which day the requirement comes back.
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
function compensatingControlFrom(raw, reason) {
	const control = text(raw);
	if (control != null && EMPTY_ANSWERS.includes(control.toLowerCase().replace(/[.\s]+$/, ""))) throw new InvalidRiskError(`A compensating control of “${control}” says nothing a reviewer can check. If nothing is holding the line, write that in a sentence with the reason the exposure is tolerable anyway.`);
	if (control == null || control.length < 20) throw new InvalidRiskError(`Say what is holding the line while this requirement is unmet, as compensatingControl, in at least ${String(20)} characters. If nothing is, write that and say why the exposure is tolerable — that sentence is the one a reviewer needs.`);
	if (control.toLowerCase() === reason.toLowerCase()) throw new InvalidRiskError("The compensating control is the reason repeated. They are different things: the reason is why the requirement is not met, and the compensating control is what is in place instead.");
	return control;
}
/**
* The residual risk, refused above the severity of the requirement it is left over from.
*
* A compensating control cannot leave more risk than the unmet requirement carried, so a record
* claiming it does is either a mistake about which requirement is being accepted or a different kind
* of record — an escalation, which this app does not have and should not have under this name.
*/
function residualFrom(raw, controlId, severity) {
	const supplied = text(raw);
	if (supplied == null || !RESIDUAL_RISKS.includes(supplied)) throw new InvalidRiskError(`Say what risk is left after the compensating control, as residual, one of ${RESIDUAL_RISKS.join(", ")}.`);
	const residual = supplied;
	if (severity != null && RESIDUAL_RISKS.indexOf(residual) < RESIDUAL_RISKS.indexOf(severity)) throw new InvalidRiskError(`${controlId} is a ${severity} requirement, so the risk left after a compensating control cannot be ${residual}. Either the compensating control is not the one being described, or this is not the requirement being accepted.`);
	return residual;
}
function effectiveFromFor(raw, now) {
	const supplied = text(raw);
	if (supplied == null) return now;
	const from = new Date(supplied);
	if (Number.isNaN(from.getTime())) throw new InvalidRiskError("The effective date must be an ISO date, such as 2026-09-30.");
	if (from.getTime() < now.getTime() - 864e5) throw new InvalidRiskError("An acceptance cannot be backdated: a record effective from before today would claim the exposure was covered during a period when nothing was recorded. Leave the date out to accept it from now.");
	return from;
}
function expiryFor(raw, effectiveFrom, severity, now) {
	const supplied = text(raw);
	if (supplied == null) throw new InvalidRiskError("Give the date this acceptance ends, as expiresAt. An acceptance with no end date is a decision that becomes policy without anybody deciding it should.");
	const expiresAt = new Date(supplied);
	if (Number.isNaN(expiresAt.getTime())) throw new InvalidRiskError("The expiry must be an ISO date, such as 2026-09-30.");
	if (expiresAt.getTime() <= now.getTime()) throw new InvalidRiskError("The expiry has to be in the future, or the acceptance has ended before it began.");
	if (expiresAt.getTime() <= effectiveFrom.getTime()) throw new InvalidRiskError("The expiry has to be after the date this becomes effective.");
	const cap = severity == null ? void 0 : longestAcceptanceDays(severity);
	if (cap != null && expiresAt.getTime() - now.getTime() > cap * 864e5) throw new InvalidRiskError(`A ${String(severity)} requirement can be accepted for at most ${String(cap)} days at a time, so this expiry is too far away. Choose a nearer one and renew it when it arrives — the point is that somebody looks again, not that the acceptance is short.`);
	return expiresAt;
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
//#endregion
export { InvalidRiskError, RESIDUAL_RISKS, acceptanceDays, effective, inForce, longestAcceptanceDays, newestFirst, recorded, revoked, riskFrom, standingOf };
