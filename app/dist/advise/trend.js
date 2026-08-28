//#region server/advise/trend.ts
/**
* How much the mean has to move to count as a change.
*
* Twenty-five per cent, and generous on purpose. The comparison is a fortnight of a production estate
* against the fortnight before it, where the data volume, the concurrent load and the warehouse's own
* scaling all move underneath the query — so a ten per cent difference between two windows is the normal
* state of a healthy shape, and a rule that called it a regression would classify most of the estate as
* regressing every time anybody looked.
*/
const CHANGE = .25;
/**
* How unstable the shape has to be, run to run, before a single comparison stops describing it.
*
* The worst run over the median, within the current window. A shape whose slowest execution is eight
* times its typical one is not usefully described by "its mean went up 30%": the mean moved because the
* spread is enormous, and the reader should be told that rather than given a direction.
*
* Checked before the direction, which is the ordering that matters. Classifying first and testing
* stability second would report a confident regression on a shape whose two windows differ by less than
* its own runs differ from each other.
*/
const SPREAD = 8;
function classify(row) {
	const counts = {
		runsNow: row.runsNow,
		runsBefore: row.runsBefore
	};
	if (row.measuredNow === 0) return {
		kind: "unmeasured",
		...counts
	};
	if (row.runsBefore === 0 || row.measuredBefore === 0) return {
		kind: "new",
		...counts
	};
	const now = row.meanMsNow;
	const before = row.meanMsBefore;
	if (now == null || before == null || before <= 0) return {
		kind: "new",
		...counts
	};
	const ratio = now / before;
	const measured = {
		ratio: round(ratio),
		meanMsNow: now,
		meanMsBefore: before,
		...counts
	};
	if (unstable(row)) return {
		kind: "volatile",
		...measured
	};
	if (ratio >= 1.25) return {
		kind: "regression",
		...measured
	};
	if (ratio <= 1 - CHANGE) return {
		kind: "improving",
		...measured
	};
	return {
		kind: "chronic",
		...measured
	};
}
/**
* Whether the shape's own runs vary more than its windows do.
*
* Needs both the median and the worst, and both are absent on a shape with no measured run — which
* `classify` has already returned for by the time this is called, so the guard here is for a shape the
* platform recorded a count for and no timings, rather than dead code.
*/
function unstable(row) {
	const median = row.medianMs;
	const worst = row.worstMs;
	if (median == null || worst == null || median <= 0) return false;
	return worst / median >= SPREAD;
}
function round(value) {
	return Math.round(value * 100) / 100;
}
//#endregion
export { classify };
