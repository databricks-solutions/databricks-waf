import { REFUSED_READINGS, effective, newestFirst, standingOf } from "./applicability.js";
//#region server/apply/apply.ts
/**
* The exposure half of an {@link Applied}, for carrying onto a score. Empty means omit it.
*
* `pillarsEmptied` is passed in rather than derived: it is the difference between two scorings, which is
* the caller's to compute. Omitted when zero, so the field is present exactly when there is something to
* say.
*/
function exposureOf(applied, pillarsEmptied = 0) {
	if (applied.excluded.length === 0 && applied.lapsed.length === 0) return void 0;
	return {
		excluded: applied.excluded,
		lapsed: applied.lapsed,
		...pillarsEmptied > 0 ? { pillarsEmptied } : {}
	};
}
/**
* A scan's findings with the decisions in force applied, and the exposure beside them.
*
* `decisionsFor` returns every decision recorded against a requirement, newest first — the store's
* `for`. The one in force by its dates is found here rather than passed in, because whether it applies
* or lapses is a function of this run's reading, which only this pass holds.
*/
function applyDecisions(findings, decisionsFor, now) {
	const excluded = [];
	const lapsed = [];
	return {
		findings: findings.map((finding) => {
			const decision = inForceByDate(decisionsFor(finding.controlId), now);
			if (decision == null) return finding;
			if (REFUSED_READINGS.includes(finding.outcome)) {
				lapsed.push({
					controlId: finding.controlId,
					lever: decision.lever,
					reading: finding.outcome,
					decisionId: decision.id
				});
				return finding;
			}
			excluded.push({
				controlId: finding.controlId,
				lever: decision.lever,
				owner: decision.owner,
				reason: decision.reason,
				decisionId: decision.id
			});
			return rewrite(finding, decision);
		}),
		excluded,
		lapsed
	};
}
/**
* The finding as the lever makes it read.
*
* `not-applicable` and `disabled` both leave the denominator; the kind is what keeps them apart on the
* surfaces that show them, and is why a disabled check is `unmeasurable` with a reason rather than a
* fourth outcome. Coverage and its provenance are left as measured: what the estate showed has not
* changed, only whether the customer is being scored on it.
*
* The `not-applicable` rewrite carries the decision's reason into `outcomeReason`, which the report and
* the export show verbatim for that outcome — so a smaller denominator reads as an explained decision
* rather than a requirement the tool skipped. The `disabled` rewrite has no such field on `unmeasurable`
* and does not need one: the `disabled` kind is the explanation, and the attribution is in the exposure.
*/
function rewrite(finding, decision) {
	if (decision.lever === "not-applicable") return {
		...finding,
		outcome: "not-applicable",
		outcomeReason: decision.reason
	};
	return {
		...finding,
		outcome: "unmeasurable",
		unmeasured: "disabled"
	};
}
/**
* The decision in force by its dates alone — active or expiring, not pending, expired, revoked or
* superseded — ignoring the reading, because the reading decides apply-versus-lapse and is checked by
* the caller against the finding it holds.
*
* Newest first from the store, and `applicabilityFrom` refuses a second effective decision, so in
* practice this finds the only one. Superseding is a fact about the set, handled by taking the newest
* that is effective: an older one a newer replaced is not returned.
*/
function inForceByDate(decisions, now) {
	return newestFirst(decisions).find((decision) => effective(standingOf(decision, { now })));
}
//#endregion
export { applyDecisions, exposureOf };
