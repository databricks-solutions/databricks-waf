import { sizingRules } from "./workload-rules.js";
//#region server/advise/sizing.ts
/**
* The size ladder, smallest first, as the system table spells it.
*
* Here rather than in configuration because it is not a threshold — it is the platform's own vocabulary,
* and a customer cannot choose a size that is not on it. Two things need it: a headroom finding must not
* fire on a warehouse already at the smallest size, because there is nothing below it, and a surface
* saying "the next size down" should be able to name which.
*
* Matched on the letters and digits alone, because the same size appears as `2X-Small` in the REST API
* and `2X_SMALL` in the system table, and a ladder that recognised one form would silently stop working
* when a reading came from the other.
*/
const SIZE_LADDER = [
	"2X-Small",
	"X-Small",
	"Small",
	"Medium",
	"Large",
	"X-Large",
	"2X-Large",
	"3X-Large",
	"4X-Large"
];
function ladderIndex(size) {
	if (size == null) return -1;
	const key = normalise(size);
	return SIZE_LADDER.findIndex((step) => normalise(step) === key);
}
function normalise(size) {
	return size.replace(/[^a-z0-9]/gi, "").toUpperCase();
}
/**
* The size as the ladder spells it, where the reading is on the ladder.
*
* The system table says `X_SMALL` and the ladder says `X-Small`, and the payload carries both: the size
* comes from the inventory and `nextSizeDown` comes from the ladder. Passing the reading through
* unchanged produced "the next size down from X_SMALL is 2X-Small" on labs — two spellings of one
* vocabulary in one sentence, which reads as a bug in the sentence rather than in the table.
*
* The reading itself where it is not on the ladder, because an unrecognised size is more likely a size
* this ladder has not been told about than a mistake, and showing it is how anybody finds out.
*/
function spell(size) {
	if (size == null) return void 0;
	const index = ladderIndex(size);
	return index < 0 ? size : SIZE_LADDER[index];
}
/**
* The analysis, or `undefined` where there is nothing to analyse.
*
* The same distinction the workload and serverless analyzers draw, and it matters more here: no rows
* means the statement could not be read, and an empty analysis would render as an estate whose
* warehouses are all correctly sized — which is a conclusion, and not one this run reached.
*/
function analyseSizing(pressure, warehouses, lookbackDays, ruleset = sizingRules()) {
	if (pressure.length === 0) return void 0;
	const definitions = new Map(warehouses.map((row) => [`${row.workspaceId}/${row.warehouseId}`, row]));
	const described = pressure.map((row) => describe(row, definitions.get(`${row.workspaceId}/${row.warehouseId}`), ruleset));
	return {
		warehouses: [...described].sort((a, b) => worst(b) - worst(a) || b.pressure.totalMs - a.pressure.totalMs || a.name.localeCompare(b.name)),
		findingCount: described.reduce((total, one) => total + one.findings.length, 0),
		used: described.filter((one) => one.pressure.runs > 0).length,
		population: pressure[0]?.warehousePopulation ?? described.length,
		matched: described.filter((one) => definitions.has(`${one.workspaceId}/${one.warehouseId}`)).length,
		...warehouses.length > 0 ? { live: warehouses.length } : {},
		windowDays: Math.min(lookbackDays, 7),
		rulesVersion: ruleset.version
	};
}
/** The severity of a warehouse's worst finding, as a sort key. Zero where it has none. */
function worst(one) {
	return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}
const RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	info: 3
};
function describe(row, definition, ruleset) {
	const index = ladderIndex(definition?.size);
	const findings = row.runs === 0 || row.measured === 0 ? [] : findingsFor(row, definition, ruleset);
	return {
		workspaceId: row.workspaceId,
		warehouseId: row.warehouseId,
		name: definition?.name ?? row.warehouseId,
		...definition != null && { serverless: definition.serverless },
		...spell(definition?.size) != null && { size: spell(definition?.size) },
		...index > 0 && { nextSizeDown: SIZE_LADDER[index - 1] },
		...definition?.minClusters != null && { minClusters: definition.minClusters },
		...definition?.maxClusters != null && { maxClusters: definition.maxClusters },
		...definition?.autoStopMinutes != null && { autoStopMinutes: definition.autoStopMinutes },
		pressure: row,
		state: row.runs === 0 ? row.ranAssessment ? "assessment-only" : "unused" : row.measured === 0 ? "unmeasured" : findings.length > 0 ? "advised" : "clean",
		findings
	};
}
function findingsFor(row, definition, ruleset) {
	return [...CONDITIONS.flatMap((condition) => {
		const rule = ruleset.rules.get(condition.id);
		if (rule == null) return [];
		const hit = condition.test(row, rule, definition);
		return hit == null ? [] : [{
			rule: condition.id,
			warehouseId: row.warehouseId,
			...hit
		}];
	})].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}
function order(id) {
	return CONDITIONS.findIndex((condition) => condition.id === id);
}
/**
* The conditions, in reading order: what went wrong first, what could be cheaper last.
*
* The order is also the order they should be acted on. Queueing and spill are things that happened to
* somebody, idle uptime is money, and headroom is an experiment. A page that led with the saving would be
* inviting a reader to shrink a warehouse whose statements are already queueing.
*/
const CONDITIONS = [
	{
		id: "WAREHOUSE_QUEUEING",
		test: (row, rule) => {
			const share = row.queuePercent;
			if (share == null || row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.daysQueued < rule.thresholds["days_queued"]) return void 0;
			if (share < rule.thresholds["queue_percent"]) return void 0;
			return {
				severity: share >= rule.thresholds["critical_queue_percent"] ? "critical" : rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Share of elapsed time queued",
						value: share,
						unit: "percent"
					},
					{
						label: "Days it queued on",
						value: row.daysQueued,
						unit: "count"
					},
					{
						label: "Most any one statement waited",
						value: row.worstQueueMs ?? 0,
						unit: "ms"
					},
					{
						label: "Clusters it reached",
						value: row.peakClusters,
						unit: "count"
					}
				]
			};
		}
	},
	{
		id: "WAREHOUSE_SPILL",
		test: (row, rule) => {
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.daysSpilled < rule.thresholds["days_spilled"]) return void 0;
			if (row.spilledBytes < rule.thresholds["spill_bytes"]) return void 0;
			return {
				severity: row.spilledBytes >= rule.thresholds["critical_spill_bytes"] ? "critical" : rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Spilled to disk",
						value: row.spilledBytes,
						unit: "bytes"
					},
					{
						label: "Days it spilled on",
						value: row.daysSpilled,
						unit: "count"
					},
					{
						label: "Statements in the window",
						value: row.runs,
						unit: "count"
					}
				]
			};
		}
	},
	{
		id: "WAREHOUSE_IDLE_UPTIME",
		test: (row, rule, definition) => {
			const share = row.executionPercent;
			if (share == null || row.upMs < rule.thresholds["min_up_ms"]) return void 0;
			if (row.daysUsed < rule.thresholds["min_days"]) return void 0;
			if (share >= rule.thresholds["execution_percent"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Paid cluster time spent executing",
						value: share,
						unit: "percent"
					},
					{
						label: "Time up",
						value: row.upMs,
						unit: "ms"
					},
					{
						label: "Time executing statements",
						value: row.busyMs,
						unit: "ms"
					},
					...definition?.autoStopMinutes != null ? [{
						label: "Auto-stop",
						value: definition.autoStopMinutes,
						unit: "count"
					}] : []
				]
			};
		}
	},
	{
		id: "WAREHOUSE_COLD_STARTS",
		test: (row, rule, definition) => {
			if (definition == null || definition.serverless) return void 0;
			if (row.starts < rule.thresholds["min_starts"] || row.daysSeen < rule.thresholds["min_days"]) return void 0;
			const perDay = row.starts / row.daysSeen;
			if (perDay < rule.thresholds["starts_per_day"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Times it started",
						value: row.starts,
						unit: "count"
					},
					{
						label: "Starts a day",
						value: Math.round(perDay * 10) / 10,
						unit: "ratio"
					},
					...definition.autoStopMinutes != null ? [{
						label: "Auto-stop",
						value: definition.autoStopMinutes,
						unit: "count"
					}] : []
				]
			};
		}
	},
	{
		id: "WAREHOUSE_HEADROOM",
		test: (row, rule, definition) => {
			const p95 = row.p95Ms;
			if (p95 == null || row.measured < rule.thresholds["min_runs"]) return void 0;
			if (row.daysUsed < rule.thresholds["min_days"]) return void 0;
			if (p95 >= rule.thresholds["p95_ms"]) return void 0;
			if (row.queueMs > 0 || row.spilledBytes > 0) return void 0;
			if (ladderIndex(definition?.size) < 1) return void 0;
			return {
				severity: rule.severity,
				confidence: "low",
				evidence: [
					{
						label: "Slowest 5% of statements finished within",
						value: p95,
						unit: "ms"
					},
					{
						label: "Statements measured",
						value: row.measured,
						unit: "count"
					},
					{
						label: "Days it ran on",
						value: row.daysUsed,
						unit: "count"
					}
				]
			};
		}
	}
];
//#endregion
export { SIZE_LADDER, analyseSizing };
