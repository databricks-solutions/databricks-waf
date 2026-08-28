import { refreshedIn, selectedPillarsOf } from "./review.js";
//#region server/review/finalisation.ts
/**
* The run's standing with its review, or nothing where there is no review record for it.
*
* `undefined` for a run this app has no record of — a scan finished before reviews existed, or one
* whose review this scope cannot see. That is distinct from a review with nothing recorded, which
* counts zero of seven: the first is an absence of a record and the second is a record of an
* absence, and only the second says a person has not done something.
*/
function finalisationOf(record, known) {
	if (record == null) return void 0;
	const selected = selectedPillarsOf(record.review, known);
	const all = record.result?.pillars ?? record.pillars;
	const named = new Set(selected);
	const pillars = all.filter((one) => named.has(one.pillarId));
	const skipped = pillars.filter((one) => one.kind === "skipped").map((one) => one.pillarId);
	return {
		reviewId: record.review.id,
		...record.result != null ? { resultId: record.result.id } : {},
		finalised: record.result != null,
		recorded: pillars.length,
		expected: selected.length,
		confirmed: pillars.filter((one) => one.kind === "confirmed").length,
		skipped: [...skipped].sort(),
		cited: citedBy(record.result, pillars),
		refreshed: refreshedIn(record.answers, selected).length,
		...record.result != null ? {
			finalisedAt: record.result.finalisedAt,
			finalisedBy: record.result.finalisedBy
		} : {}
	};
}
/**
* How many attestations the confirmed pillars cited.
*
* From the result where there is one, because that is the list publication reads, and from the
* pillar records before then. A skip contributes none — its `attestationIds` is absent rather than
* empty, which is the distinction that stops a skipped pillar counting as confirmed with nothing.
*/
function citedBy(result, pillars) {
	if (result != null) return result.attestationIds.length;
	return pillars.reduce((total, one) => total + (one.attestationIds?.length ?? 0), 0);
}
//#endregion
export { finalisationOf };
