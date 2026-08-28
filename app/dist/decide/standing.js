import "../attest/attestation.js";
//#region server/decide/standing.ts
/** Outcomes that mean the requirement is not currently a problem. */
function met(outcome) {
	return outcome === "pass" || outcome === "satisfied-by-architecture" || outcome === "not-applicable";
}
function unmet(outcome) {
	return outcome === "fail" || outcome === "partial";
}
function standingOf(decision, context = {}) {
	const now = context.now ?? /* @__PURE__ */ new Date();
	const outcome = context.finding?.outcome;
	const since = context.measuredAt != null && context.measuredAt.getTime() > decision.decidedAt.getTime();
	if (decision.disposition === "reopened") return "withdrawn";
	if (decision.disposition === "fixed") {
		if (outcome == null || !since) return "unverified";
		if (unmet(outcome)) return "contradicted";
		return met(outcome) ? "confirmed" : "unverified";
	}
	if (outcome != null && since && met(outcome)) return "settled";
	const remaining = (decision.until?.getTime() ?? now.getTime()) - now.getTime();
	if (remaining <= 0) return "lapsed";
	return remaining <= 30 * 864e5 ? "due" : "current";
}
/**
* Whether the finding may drop out of the work queue.
*
* `unverified` counts as parked, which is a judgement worth stating: the requirement is still
* measured as failing, so hiding it is hiding a failure on somebody's unchecked word. It is parked
* anyway because the alternative — a queue that keeps demanding work that has just been done —
* teaches the reader that the queue is not listening, and because the run that follows will say
* `contradicted` far more loudly than leaving the row in place ever would. The count of parked
* findings is shown wherever the queue is, so nothing disappears silently.
*/
function parked(standing) {
	return standing === "current" || standing === "due" || standing === "unverified";
}
/** The decisions that still bear on a run, judged against it, with the withdrawn ones dropped. */
function standingsFor(decisions, context = {}) {
	const byControl = new Map((context.findings ?? []).map((finding) => [finding.controlId, finding]));
	return decisions.map((decision) => {
		const finding = byControl.get(decision.controlId);
		return {
			decision,
			standing: standingOf(decision, {
				...finding != null ? { finding } : {},
				...context.measuredAt != null ? { measuredAt: context.measuredAt } : {},
				...context.now != null ? { now: context.now } : {}
			}),
			...finding != null ? { outcome: finding.outcome } : {}
		};
	});
}
//#endregion
export { parked, standingOf, standingsFor };
