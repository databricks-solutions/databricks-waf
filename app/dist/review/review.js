import { stateOf } from "../attest/attestation.js";
//#region server/review/review.ts
var InvalidReviewError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidReviewError";
	}
};
/** A review of this scan, stamped with the scan's actor, time and assessment. */
function openedFor(scan, draft) {
	return opened({
		id: draft.id,
		runId: scan.id,
		openedBy: scan.stamp.actor,
		openedAt: draft.openedAt ?? scan.finishedAt,
		...scan.stamp.definition != null ? { definitionId: scan.stamp.definition.id } : {},
		...scan.stamp.definition != null ? { definitionVersion: scan.stamp.definition.version } : {},
		...scan.stamp.definition != null ? { definitionFingerprint: scan.stamp.definition.fingerprint } : {},
		...scan.requestedPillars != null ? { selectedPillars: scan.requestedPillars } : {}
	});
}
function opened(draft) {
	if (draft.runId.trim() === "") throw new InvalidReviewError("A review has to name the scan it is of.");
	return {
		id: draft.id,
		runId: draft.runId,
		openedBy: draft.openedBy,
		openedAt: draft.openedAt,
		...draft.definitionId != null && draft.definitionId !== "" ? { definitionId: draft.definitionId } : {},
		...draft.definitionVersion != null ? { definitionVersion: draft.definitionVersion } : {},
		...draft.definitionFingerprint != null && draft.definitionFingerprint !== "" ? { definitionFingerprint: draft.definitionFingerprint } : {},
		...draft.selectedPillars != null ? { selectedPillars: [...draft.selectedPillars] } : {}
	};
}
/**
* The pillars this review is allowed to decide, in catalogue order.
*
* A missing set is the explicit compatibility rule for runs written before requested scope was
* stored. An empty, duplicate or unknown set is not widened to the catalogue: that would turn a
* malformed narrow assessment into a valid full-estate report.
*/
function selectedPillarsOf(record, known) {
	const selected = record.selectedPillars;
	if (selected == null) return [...known];
	if (selected.length === 0) throw new InvalidReviewError("This review records an empty selected pillar set, so it cannot accept a decision.");
	const wanted = new Set(selected);
	if (wanted.size !== selected.length || selected.some((id) => id.trim() === "" || !known.includes(id))) throw new InvalidReviewError("This review records a duplicate, blank or unknown selected pillar, so it cannot accept a decision.");
	return known.filter((id) => wanted.has(id));
}
/** Store-level defence that no decision can escape the review's immutable selected scope. */
function assertReviewAccepts(review, pillarId, known) {
	const selected = selectedPillarsOf(review, known);
	if (!selected.includes(pillarId)) throw new InvalidReviewError(`${pillarId} was not selected for this assessment, so Review cannot record a decision against it.`);
	return selected;
}
/**
* Confirm-current: this pillar's answers on the run still stand.
*
* The attestation ids are the ones the caller copied off the scan. This function does not look
* them up, so a test can pass a synthetic list and a route can pass what the findings held.
*/
function confirmed(draft, known) {
	return recorded({
		...draft,
		kind: "confirmed",
		attestationIds: draft.attestationIds ?? []
	}, known);
}
/** An attributed skip. Actor, time, run and pillar — the four things an absence cannot carry. */
function skipped(draft, known) {
	return recorded({
		...draft,
		kind: "skipped"
	}, known);
}
function recorded(draft, known) {
	if (!known.includes(draft.pillarId)) throw new InvalidReviewError(`This installation has no pillar called ${draft.pillarId}, so a record about it is a record nothing can place.`);
	if (draft.reviewId.trim() === "" || draft.runId.trim() === "") throw new InvalidReviewError("A pillar record has to name the review and the scan it belongs to.");
	return {
		id: draft.id,
		reviewId: draft.reviewId,
		runId: draft.runId,
		pillarId: draft.pillarId,
		kind: draft.kind,
		by: draft.by,
		at: draft.at,
		...draft.kind === "confirmed" ? { attestationIds: [...draft.attestationIds ?? []] } : {},
		...draft.kind === "skipped" ? { unresolvedControlIds: [...draft.unresolvedControlIds ?? []] } : {}
	};
}
/**
* An answer this review produced, against a pillar the catalogue names.
*
* The same pillar check `recorded` makes, for the same reason: a record about a pillar this
* installation does not have is a record nothing can place, and `finalisationOf` filters to the
* catalogue anyway — so an unplaceable record would be written, stored and then counted by nothing.
*/
function answered(draft, known) {
	if (!known.includes(draft.pillarId)) throw new InvalidReviewError(`This installation has no pillar called ${draft.pillarId}, so a record about it is a record nothing can place.`);
	if (draft.reviewId.trim() === "" || draft.runId.trim() === "") throw new InvalidReviewError("An answer record has to name the review and the scan it belongs to.");
	if (draft.controlId.trim() === "" || draft.attestationId.trim() === "") throw new InvalidReviewError("An answer record has to name the requirement and the attestation it produced.");
	return {
		id: draft.id,
		reviewId: draft.reviewId,
		runId: draft.runId,
		pillarId: draft.pillarId,
		controlId: draft.controlId,
		attestationId: draft.attestationId,
		by: draft.by,
		at: draft.at
	};
}
/**
* Attestations this review wrote, against pillars the catalogue names, deduplicated.
*
* Deduplicated on the attestation rather than counted as records, because the two differ and the
* word is about the answers. Answering the same requirement twice inside one review supersedes the
* first answer — the second attestation is a new id, so both are counted; re-recording the *same*
* attestation cannot happen through the route and is filtered here rather than trusted not to.
*/
function refreshedIn(answers, known) {
	const named = new Set(known);
	const seen = /* @__PURE__ */ new Set();
	for (const one of answers) if (named.has(one.pillarId)) seen.add(one.attestationId);
	return [...seen];
}
/** Whether every selected pillar has a record. */
function complete(known, recorded) {
	if (known.length === 0) return false;
	const have = new Set(recorded.map((one) => one.pillarId));
	return known.every((pillar) => have.has(pillar));
}
/**
* The result of a completed review.
*
* Pillars are stored in catalogue order, so two results of the same catalogue compare without
* depending on the order somebody clicked. Attestation ids follow that order, then the order
* they were copied off the findings.
*/
function finalised(draft, known) {
	if (!complete(known, draft.pillars)) throw new InvalidReviewError("A report is published when every selected pillar has been confirmed or skipped, and this review is still short of that.");
	const byPillar = new Map(draft.pillars.map((one) => [one.pillarId, one]));
	const pillars = known.map((id) => {
		const one = byPillar.get(id);
		if (one == null) throw new InvalidReviewError(`A result is missing a record for ${id}.`);
		return one;
	});
	return {
		id: draft.id,
		reviewId: draft.review.id,
		runId: draft.review.runId,
		finalisedBy: draft.finalisedBy,
		finalisedAt: draft.finalisedAt,
		pillars,
		attestationIds: pillars.flatMap((one) => one.attestationIds ?? []),
		...draft.review.definitionId != null ? { definitionId: draft.review.definitionId } : {},
		...draft.review.definitionVersion != null ? { definitionVersion: draft.review.definitionVersion } : {},
		...draft.review.definitionFingerprint != null ? { definitionFingerprint: draft.review.definitionFingerprint } : {},
		...draft.review.selectedPillars != null ? { selectedPillars: [...draft.review.selectedPillars] } : {}
	};
}
/** The exact human-evidence decision visible for one reviewed-run pillar at one instant. */
function pillarEvidenceManifest(controls, attestations, pillarId, now = /* @__PURE__ */ new Date()) {
	const current = new Map(attestations.map((one) => [one.controlId, one]));
	const manual = controls.filter((one) => one.pillarId === pillarId);
	const accepted = [];
	const attention = [];
	for (const control of manual) {
		const answer = current.get(control.id);
		if (answer != null && stateOf(answer, now) === "current") accepted.push(answer.id);
		else attention.push(control.id);
	}
	return {
		attestationIds: accepted,
		attentionControlIds: attention,
		unresolvedControlIds: manual.map((one) => one.id)
	};
}
//#endregion
export { InvalidReviewError, answered, assertReviewAccepts, complete, confirmed, finalised, opened, openedFor, pillarEvidenceManifest, refreshedIn, selectedPillarsOf, skipped };
