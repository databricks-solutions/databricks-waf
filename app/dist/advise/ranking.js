//#region server/advise/ranking.ts
/**
* The weights, and the version they are known by.
*
* The numbers are the advisor document's at line 594, unchanged. What is added here is the version,
* because a coefficient set that cannot be named cannot be compared: two rankings a month apart under
* different weights are two different questions, and a page that presented them as a trend would be
* reporting the tuning as a change in the estate.
*
* Bumped when any weight changes. A new set is a new version even if the ordering it produces happens to
* be the same on today's estate.
*/
const WEIGHTS_VERSION = "advisor-1";
const WEIGHTS = {
	duration: .3,
	volume: .2,
	frequency: .15,
	shuffleRatio: .15,
	spillRatio: .1,
	pruning: .05,
	skew: .05
};
/**
* Every shape, ranked, highest first.
*
* The caps are computed over the set passed in, which means the ranking is relative to the window and
* to the rows the statement returned. That is the document's design and it has a consequence worth
* stating: a score is not comparable across runs. Two shapes in one run are comparable; the same shape's
* score this week and last week is not, because the 99th percentile it was scaled against moved.
*/
function rank(rows, weights = WEIGHTS) {
	const featured = rows.map((row) => ({
		row,
		raw: featuresOf(row)
	}));
	const caps = {
		duration: percentile(featured.map((one) => one.raw.duration)),
		volume: percentile(featured.map((one) => one.raw.volume)),
		frequency: percentile(featured.map((one) => one.raw.frequency)),
		shuffleRatio: percentile(featured.map((one) => one.raw.shuffleRatio)),
		spillRatio: percentile(featured.map((one) => one.raw.spillRatio)),
		pruning: percentile(featured.map((one) => one.raw.pruning)),
		skew: percentile(featured.map((one) => one.raw.skew))
	};
	return featured.map(({ row, raw }) => {
		const features = {
			duration: scaled(raw.duration, caps.duration),
			volume: scaled(raw.volume, caps.volume),
			frequency: scaled(raw.frequency, caps.frequency),
			shuffleRatio: scaled(raw.shuffleRatio, caps.shuffleRatio),
			spillRatio: scaled(raw.spillRatio, caps.spillRatio),
			pruning: scaled(raw.pruning, caps.pruning),
			skew: scaled(raw.skew, caps.skew)
		};
		return {
			row,
			features,
			score: combined(features, weights)
		};
	}).sort((a, b) => b.score - a.score || a.row.shape.localeCompare(b.row.shape));
}
/**
* The shapes that failed, worst rate first.
*
* Its own ordering over the same rows, for the reason at the top of this file. Shapes with no failures
* are left out rather than sorted to the bottom: the answer to "what is failing" is a list of things
* that are failing, and padding it with healthy shapes would make an estate with nothing wrong look the
* same as one nobody had checked.
*
* Rate rather than count, then count as the tie-break. A shape failing 3 of 4 runs is a broken shape; one
* failing 300 of 300,000 is a flaky one, and the first is what somebody should look at even though the
* second has a hundred times the failures.
*/
function byFailure(rows) {
	return rows.filter((row) => row.failures > 0).sort((a, b) => failureRate(b) - failureRate(a) || b.failures - a.failures || a.shape.localeCompare(b.shape));
}
/** What fraction of a shape's terminal runs did not finish. Zero where it never ran. */
function failureRate(row) {
	return row.runsNow === 0 ? 0 : row.failures / row.runsNow;
}
/**
* The raw features, before capping.
*
* Each `??` and each `nullif`-shaped guard here is a case the platform records as absent, and the
* choice is always to contribute nothing rather than to assume. See the note at the top.
*/
function featuresOf(row) {
	const volume = row.readBytes + row.shuffleBytes + row.spilledBytes;
	return {
		duration: Math.log1p(row.msNow),
		volume: Math.log1p(volume),
		frequency: Math.log1p(row.measuredNow),
		shuffleRatio: row.readBytes > 0 ? row.shuffleBytes / row.readBytes : 0,
		spillRatio: row.readBytes > 0 ? row.spilledBytes / row.readBytes : 0,
		pruning: row.prunedPercent == null ? 0 : 1 - row.prunedPercent / 100,
		skew: 0
	};
}
function combined(features, weights) {
	return weights.duration * features.duration + weights.volume * features.volume + weights.frequency * features.frequency + weights.shuffleRatio * features.shuffleRatio + weights.spillRatio * features.spillRatio + weights.pruning * features.pruning + weights.skew * features.skew;
}
/**
* The 99th percentile of a set of values, by nearest rank.
*
* Nearest rank rather than interpolated, because interpolation between the top two values of a small set
* is a number neither of them has — and at forty rows the 99th percentile *is* the largest value, which
* is the honest answer for a window with too few shapes to have a tail.
*/
function percentile(values, at = .99) {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const index = Math.min(sorted.length - 1, Math.ceil(at * sorted.length) - 1);
	return sorted[Math.max(0, index)] ?? 0;
}
/**
* One feature as a fraction of its cap, clamped.
*
* A cap of zero means no shape in the window had any of this feature, and the answer is zero rather than
* a division. Values above the cap clamp to 1, which is the capping.
*/
function scaled(value, cap) {
	if (cap <= 0) return 0;
	return Math.min(1, value / cap);
}
//#endregion
export { WEIGHTS, WEIGHTS_VERSION, byFailure, failureRate, rank };
