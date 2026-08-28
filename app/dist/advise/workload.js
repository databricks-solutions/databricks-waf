import { workloadRules } from "./workload-rules.js";
import { noPlans, readingFor } from "./plan-index.js";
import { noStats } from "./stats-index.js";
import { WEIGHTS_VERSION, byFailure, rank } from "./ranking.js";
import { findingsFor } from "./rules.js";
import { classify } from "./trend.js";
/**
* The analysis, or `undefined` where there is nothing to analyse.
*
* `undefined` rather than an empty analysis, and the distinction is the same one the serverless analyzer
* draws: no rows means the statement could not be read or the window held no queries, and an empty
* analysis would render as an estate with no expensive queries — which is a finding, and not one this
* run made. The caller reports it as unread; a run whose statement genuinely returned zero shapes over a
* live window is indistinguishable from an unreadable one here, and the readings on the record are what
* tell those apart.
*/
function analyseWorkload(rows, lookbackDays, ruleset = workloadRules(), plans = noPlans(), stats = noStats()) {
	if (rows.length === 0) return void 0;
	const ranked = rank(rows);
	const described = new Map(ranked.map((one) => [one.row.shape, describe(one, ruleset, plans, stats)]));
	const failing = byFailure(rows).flatMap((row) => {
		const found = described.get(row.shape);
		return found == null ? [] : [found];
	});
	return {
		top: ranked.slice(0, 12).flatMap((one) => {
			const found = described.get(one.row.shape);
			return found == null ? [] : [found];
		}),
		failing,
		coverage: coverageOf(rows),
		considered: rows.length,
		findingCount: [...described.values()].reduce((total, shape) => total + shape.findings.length, 0),
		rankingVersion: WEIGHTS_VERSION,
		rulesVersion: ruleset.version,
		windowDays: Math.min(lookbackDays, 15)
	};
}
function describe(one, ruleset, plans, stats) {
	return {
		shape: one.row.shape,
		workspaceId: one.row.workspaceId,
		statementType: one.row.statementType,
		score: Math.round(one.score * 1e3) / 1e3,
		features: one.features,
		trend: classify(one.row),
		findings: findingsFor(one.row, ruleset, readingFor(plans, one.row), stats),
		row: one.row
	};
}
/**
* The coverage figures, read off any row.
*
* The statement cross-joins one row of them onto every result row, so every row carries the same pair and
* the first is as good as any. Taken from the first rather than summed, which would multiply the estate's
* query time by the number of shapes returned.
*/
function coverageOf(rows) {
	const first = rows[0];
	const covered = first?.coveredMs ?? 0;
	const excluded = first?.excludedMs ?? 0;
	const self = first?.selfMs ?? 0;
	const total = covered + excluded + self;
	const ambiguous = first?.ambiguousMs ?? 0;
	const described = Math.max(0, covered - ambiguous);
	return {
		coveredMs: covered,
		excludedMs: excluded,
		selfMs: self,
		coveredRuns: first?.coveredRuns ?? 0,
		excludedRuns: first?.excludedRuns ?? 0,
		selfRuns: first?.selfRuns ?? 0,
		ambiguousMs: ambiguous,
		ambiguousRuns: first?.ambiguousRuns ?? 0,
		ambiguousShapes: first?.ambiguousShapes ?? 0,
		...total > 0 ? { percent: Math.round(1e3 * described / total) / 10 } : {}
	};
}
//#endregion
export { analyseWorkload };
