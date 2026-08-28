import { scoreFindings } from "../score/score.js";
//#region server/scan/attribution.ts
/**
* The movement split, or nothing when it cannot be established.
*
* Absent rather than zeroed when either run has no overall score, or when the two catalogues share
* no requirement asked in the same terms. A zero would say the estate did not move, which is a
* claim; absence says nobody can tell, which is the fact.
*/
function attribute(later, earlier, span, aliasGroupOf) {
	const overall = later.score.overall;
	const before = earlier.score.overall;
	if (overall == null || before == null) return void 0;
	const stable = stableControls(later, earlier, span);
	if (stable.size === 0) return void 0;
	const options = aliasGroupOf != null ? { aliasGroupOf } : {};
	const laterCore = scoreFindings(later.findings.filter((finding) => stable.has(finding.controlId)), options);
	const earlierCore = scoreFindings(asLater(earlier.findings, span).filter((finding) => stable.has(finding.controlId)), options);
	if (laterCore.overall == null || earlierCore.overall == null) return void 0;
	const estate = round(laterCore.overall - earlierCore.overall);
	return {
		estate,
		catalogue: round(overall - before - estate),
		stable: scoredUnits(stable, aliasGroupOf),
		added: span.added.length,
		removed: span.removed.length,
		renamed: span.renamed.size,
		reweighted: span.changed.length
	};
}
/** How many things the score is out of, which is one per alias group and one per ungrouped control. */
function scoredUnits(stable, aliasGroupOf) {
	const units = /* @__PURE__ */ new Set();
	for (const id of stable) units.add(aliasGroupOf?.(id) ?? id);
	return units.size;
}
/**
* The requirements both runs asked in the same terms, under the later run's ids.
*
* Three exclusions, and each is a way the arithmetic would otherwise attribute a change of question
* to the estate: a requirement only one catalogue has, a requirement whose scoring shape moved, and
* a requirement only one of the two runs produced a finding for — which is this identity's grants or
* a collector's reach rather than the catalogue, but it is equally not a like-for-like comparison.
*/
function stableControls(later, earlier, span) {
	const moved = new Set(span.changed.map((change) => change.id));
	const arrived = new Set(span.added);
	const inEarlier = new Set(asLater(earlier.findings, span).map((finding) => finding.controlId));
	const stable = /* @__PURE__ */ new Set();
	for (const finding of later.findings) {
		const id = finding.controlId;
		if (arrived.has(id) || moved.has(id) || !inEarlier.has(id)) continue;
		stable.add(id);
	}
	return stable;
}
/**
* The earlier run's findings restated under the ids the later catalogue uses.
*
* Findings for requirements the span records as gone are dropped rather than carried, and that is
* load-bearing beyond tidiness. Positional ids get reused: a requirement can leave and a renumbered
* one can take the number it vacated later in the same span. Carrying both would put two findings on
* one id, and scoring the pair would read the difference between two unrelated requirements as the
* customer's estate moving. Dropped, the vacated id is simply not comparable, which is the truth.
*/
function asLater(findings, span) {
	const gone = new Set(span.removed);
	const restated = [];
	for (const finding of findings) {
		if (gone.has(finding.controlId)) continue;
		const renamed = span.renamed.get(finding.controlId);
		restated.push(renamed == null ? finding : {
			...finding,
			controlId: renamed
		});
	}
	return restated;
}
/** Two places, as scores are reported, so the two halves sum to the total the reader sees. */
function round(value) {
	return Math.round(value * 100) / 100;
}
//#endregion
export { attribute };
