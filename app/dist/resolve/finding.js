import { narrowerReach } from "../collect/signal.js";
//#region server/resolve/finding.ts
/**
* One item as prose: the name, then where it is and why it is here, in one parenthesis.
*
* The page renders the parts and reaches these same words, because the two are read side by side —
* a finding on screen and the spreadsheet exported from it. Two parentheses in a row, "etl
* (field-eng) (LEGACY_SINGLE_USER)", reads like a stammer, so there is one.
*/
function describeItem(item) {
	const aside = [item.in, item.note].filter((part) => part != null);
	return aside.length === 0 ? item.label : `${item.label} (${aside.join(", ")})`;
}
/**
* The narrowest of several coverages, for a control resolved from more than one signal.
*
* Mode and reach narrow independently, so both are reduced. A control answered from an
* account-wide table and a metastore-scoped one is a statement about the metastore: the
* narrower input governs, exactly as the sampled fraction does.
*/
function narrowest(coverages) {
	const reach = coverages.reduce((so_far, c) => narrowerReach(so_far, c.reach), void 0);
	const withReach = (coverage) => reach != null ? {
		...coverage,
		reach
	} : coverage;
	const sampled = coverages.filter((c) => c.mode === "sampled");
	if (sampled.length === 0) return withReach({ mode: "complete" });
	return withReach(sampled.reduce((worst, c) => fraction(c) < fraction(worst) ? c : worst));
}
function fraction(coverage) {
	if (coverage.examined == null || coverage.population == null || coverage.population === 0) return 1;
	return coverage.examined / coverage.population;
}
//#endregion
export { describeItem, narrowest };
