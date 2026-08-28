import { writeRules } from "./workload-rules.js";
//#region server/advise/writes.ts
/**
* The analysis, or `undefined` where there is nothing to analyse.
*
* The same distinction the other three analyzers draw, and here the empty case is the most flattering
* absence in the app: an estate whose query history could not be read would render as an estate that
* writes nothing at all, which on a lakehouse is not a conclusion anybody should reach from a failed read.
*/
function analyseWrites(patterns, lookbackDays, ruleset = writeRules()) {
	if (patterns.length === 0) return void 0;
	const described = patterns.map((row) => describe(row, ruleset));
	const first = patterns[0];
	return {
		shapes: [...described].sort((a, b) => worst(b) - worst(a) || b.pattern.writtenBytes - a.pattern.writtenBytes || a.shape.localeCompare(b.shape)),
		findingCount: described.reduce((total, one) => total + one.findings.length, 0),
		undeterminable: described.filter((one) => one.state === "undeterminable").length,
		writeStatements: first?.writeStatements ?? described.length,
		writesStatingBytes: first?.writesStatingBytes ?? 0,
		estateWrittenBytes: first?.estateWrittenBytes ?? 0,
		otherStatements: first?.otherStatements ?? 0,
		windowDays: Math.min(lookbackDays, 30),
		rulesVersion: ruleset.version
	};
}
/** The severity of a shape's worst finding, as a sort key. Zero where it has none. */
function worst(one) {
	return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}
const RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	info: 3
};
function describe(row, ruleset) {
	const judgeable = row.runsStatingBytes > 0 && row.medianWriteBytes != null;
	const findings = judgeable ? findingsFor(row, ruleset) : [];
	return {
		workspaceId: row.workspaceId,
		shape: row.shape,
		statementType: row.statementType,
		pattern: row,
		state: !judgeable ? "undeterminable" : findings.length > 0 ? "advised" : "clean",
		findings
	};
}
function findingsFor(row, ruleset) {
	return [...CONDITIONS.flatMap((condition) => {
		const rule = ruleset.rules.get(condition.id);
		if (rule == null) return [];
		const hit = condition.test(row, rule);
		return hit == null ? [] : [{
			rule: condition.id,
			shape: row.shape,
			...hit
		}];
	})].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}
function order(id) {
	return CONDITIONS.findIndex((condition) => condition.id === id);
}
/**
* The two conditions, largest first.
*
* They cannot both fire on one shape — one requires a median write above a gibibyte and the other one
* below 128 mebibytes — but the order is declared anyway, because a threshold moved in the YAML could make
* the windows overlap and a finding list whose order depends on which condition ran first is one that
* changes under a configuration edit nobody connected to it.
*/
const CONDITIONS = [{
	id: "TABLE_REWRITTEN_WHOLE",
	test: (row, rule) => {
		if (row.statementType !== "REPLACE") return void 0;
		const median = row.medianWriteBytes;
		if (median == null) return void 0;
		if (row.runs < rule.thresholds["min_runs"] || row.daysRun < rule.thresholds["min_days"]) return void 0;
		if (median < rule.thresholds["median_write_bytes"]) return void 0;
		return {
			severity: row.writtenBytes >= rule.thresholds["critical_written_bytes"] ? "critical" : rule.severity,
			confidence: "moderate",
			evidence: [
				{
					label: "Written across the window",
					value: row.writtenBytes,
					unit: "bytes"
				},
				{
					label: "The middle run wrote",
					value: median,
					unit: "bytes"
				},
				{
					label: "Times it ran",
					value: row.runs,
					unit: "count"
				},
				{
					label: "Days it ran on",
					value: row.daysRun,
					unit: "count"
				},
				...unstated(row)
			]
		};
	}
}, {
	id: "INGEST_IN_SMALL_PIECES",
	test: (row, rule) => {
		if (row.statementType !== "INSERT" && row.statementType !== "COPY") return void 0;
		const median = row.medianWriteBytes;
		if (median == null) return void 0;
		if (row.runs < rule.thresholds["min_runs"] || row.daysRun < rule.thresholds["min_days"]) return void 0;
		if (median > rule.thresholds["max_median_write_bytes"]) return void 0;
		const perDay = row.runs / row.daysRun;
		if (perDay < rule.thresholds["min_runs_per_day"]) return void 0;
		return {
			severity: rule.severity,
			confidence: "moderate",
			evidence: [
				{
					label: "The middle run wrote",
					value: median,
					unit: "bytes"
				},
				{
					label: "Times it ran",
					value: row.runs,
					unit: "count"
				},
				{
					label: "Runs a day",
					value: Math.round(perDay * 10) / 10,
					unit: "ratio"
				},
				{
					label: "Days it ran on",
					value: row.daysRun,
					unit: "count"
				},
				...unstated(row)
			]
		};
	}
}];
/**
* The runs the byte figures above are not over, where there are any.
*
* Present only when some run stated nothing, because a zero here would read as a caveat on every finding
* on every estate. A shape whose runs *all* stated nothing never reaches a condition — see `describe`.
*/
function unstated(row) {
	const missing = row.runs - row.runsStatingBytes;
	return missing > 0 ? [{
		label: "Runs that stated no written figure",
		value: missing,
		unit: "count"
	}] : [];
}
//#endregion
export { analyseWrites };
