import { observed, unmeasurable } from "../signal.js";
import { quoteIdent } from "../../scripts/sql-identifiers.js";
import { count, text } from "./rows.js";
import { jsonArray, jsonMap } from "./shapes.js";
import { rowsOf } from "./collector.js";
//#region server/collect/sql/describe.ts
/** The signal this collector needs another collector to have produced first. */
const SAMPLE_SIGNAL = "sql:storage.sample_selection";
/** Named as well as listed, so anything describing this signal cannot depend on array order. */
const TABLE_DETAILS_SIGNAL = "describe:storage.table_details";
const DESCRIBE_SIGNALS = [TABLE_DETAILS_SIGNAL];
var DescribeCollector = class {
	options;
	surface = "describe";
	name = "table-detail";
	signals = DESCRIBE_SIGNALS;
	requires = [SAMPLE_SIGNAL];
	sampleLimit;
	calls = 0;
	statementIds = [];
	constructor(options) {
		this.options = options;
		this.sampleLimit = options.sampleLimit ?? 50;
	}
	spent() {
		return {
			surface: this.surface,
			name: this.name,
			calls: this.calls,
			...this.statementIds.length > 0 ? { statementIds: [...this.statementIds] } : {}
		};
	}
	async collect(ids, context) {
		const results = [];
		for (const id of ids) results.push(await this.collectOne(id, context));
		return results;
	}
	async collectOne(id, context) {
		const sample = context.collected.get(SAMPLE_SIGNAL);
		if (sample == null || sample.status !== "observed") return unmeasurable(id, "The table sample was not collected, so there was nothing to describe. The sample comes from the system-table collector, which must run before this one. " + (sample?.status === "unmeasurable" ? `The sample reported: ${sample.unmeasurableReason ?? "no reason."}` : ""));
		const selection = sample.value;
		const candidates = selection.candidates.slice(0, this.sampleLimit);
		if (candidates.length === 0) return unmeasurable(id, "No Delta tables were eligible to describe. Either the metastore holds none, or the scanning identity cannot see them. This is reported as unmeasured rather than as an estate with no layout problems.");
		const started = Date.now();
		const tables = [];
		const undescribed = [];
		for (const candidate of candidates) {
			const name = `${candidate.catalog}.${candidate.schema}.${candidate.table}`;
			const quoted = quoteName(candidate);
			if (quoted == null) {
				undescribed.push({
					table: name,
					reason: "A part of the table name is empty or contains a line break, so DESCRIBE DETAIL was not issued."
				});
				continue;
			}
			const outcome = await context.scheduler.run({
				surface: "describe",
				label: `describe:${name}`,
				run: async (signal) => {
					const raw = await this.options.executor(`DESCRIBE DETAIL ${quoted}`, {}, signal);
					this.calls += 1;
					const statementId = raw.statementId;
					if (typeof statementId === "string") this.statementIds.push(statementId);
					return rowsOf(raw);
				}
			});
			if (outcome.status === "ok") {
				const row = outcome.value[0];
				if (row != null) tables.push(detailOf(row, candidate));
				else undescribed.push({
					table: name,
					reason: "DESCRIBE DETAIL returned no rows."
				});
				continue;
			}
			undescribed.push({
				table: name,
				reason: outcome.status === "skipped" ? outcome.detail : outcome.failure.message
			});
			if (outcome.status === "skipped" && (outcome.reason === "budget-exhausted" || outcome.reason === "cancelled")) break;
		}
		if (tables.length === 0) return unmeasurable(id, `None of the ${String(candidates.length)} sampled tables could be described. First reason: ${undescribed[0]?.reason ?? "unknown."}`);
		const value = {
			tables,
			eligibleTables: selection.eligibleTables,
			undescribed
		};
		const complete = tables.length >= selection.eligibleTables;
		const reach = sample.coverage.reach ?? "metastore";
		return observed(id, value, Date.now() - started, complete ? {
			mode: "complete",
			reach
		} : {
			mode: "sampled",
			reach,
			examined: tables.length,
			population: selection.eligibleTables,
			basis: "the most-read tables first, by read events recorded in table lineage over the scan window, with a stable tiebreak by name so the same tables are covered on the next scan"
		});
	}
};
function detailOf(row, candidate) {
	return {
		catalog: candidate.catalog,
		schema: candidate.schema,
		table: candidate.table,
		sizeBytes: count(row, "sizeInBytes"),
		fileCount: count(row, "numFiles"),
		partitionColumns: jsonArray(row, "partitionColumns"),
		clusteringColumns: jsonArray(row, "clusteringColumns"),
		features: jsonArray(row, "tableFeatures"),
		automaticClustering: (text(row, "clusterByAuto") ?? "").toLowerCase() === "true",
		properties: jsonMap(row, "properties"),
		readEvents: candidate.readEvents
	};
}
/**
* A three-part name, each part quoted through the shared identifier rule.
*
* The parts come from `system.information_schema.tables` rather than from a request, so
* this is not the last line of defence against injection — but it is not free of risk
* either, because a table name may legitimately contain characters that break an
* unquoted identifier. Backticks are doubled by `quoteIdent`, which is the escape
* Databricks SQL uses, so a name containing one cannot terminate the quoting early.
* Undefined when any part cannot be quoted, so the caller skips rather than emitting SQL.
*/
function quoteName(candidate) {
	const parts = [
		candidate.catalog,
		candidate.schema,
		candidate.table
	].map((part) => quoteIdent(part));
	if (parts.some((part) => part == null)) return void 0;
	return parts.join(".");
}
//#endregion
export { DESCRIBE_SIGNALS, DescribeCollector, SAMPLE_SIGNAL, TABLE_DETAILS_SIGNAL };
