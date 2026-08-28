import { observed, unmeasurable } from "../signal.js";
import { quoteIdent } from "../../scripts/sql-identifiers.js";
import { rowsOf } from "./collector.js";
//#region server/collect/sql/predictive-optimization.ts
/** The signal naming which catalogs to describe. */
const CATALOGS_SIGNAL = "sql:uc.catalogs";
const PO_SIGNAL = "describe:predictive_optimization.coverage";
const PREDICTIVE_OPTIMIZATION_SIGNALS = [PO_SIGNAL];
/** The label `DESCRIBE CATALOG EXTENDED` gives the setting's row. */
const SETTING_LABEL = "predictive optimization";
var PredictiveOptimizationCollector = class {
	options;
	surface = "describe";
	name = "predictive-optimization";
	signals = PREDICTIVE_OPTIMIZATION_SIGNALS;
	requires = [CATALOGS_SIGNAL];
	catalogLimit;
	calls = 0;
	statementIds = [];
	constructor(options) {
		this.options = options;
		this.catalogLimit = options.catalogLimit ?? 50;
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
		const inventory = context.collected.get(CATALOGS_SIGNAL);
		if (inventory == null || inventory.status !== "observed") return unmeasurable(id, "The catalogue of catalogs was not collected, so there was nothing to describe. It comes from the system-table collector, which must run before this one. " + (inventory?.status === "unmeasurable" ? `It reported: ${inventory.unmeasurableReason ?? "no reason."}` : ""));
		const all = inventory.value.catalogs;
		if (all.length === 0) return unmeasurable(id, "No catalog in this metastore holds a table, so there is nothing for predictive optimization to maintain and no setting worth reading. Reported as unmeasured rather than as coverage of zero, which would read as predictive optimization being switched off.");
		const targets = all.slice(0, this.catalogLimit);
		const started = Date.now();
		const catalogs = [];
		const unreadable = [];
		for (const target of targets) {
			const quoted = quoteIdent(target.catalog);
			if (quoted == null) {
				unreadable.push({
					catalog: target.catalog,
					reason: "The catalog name is empty or contains a line break, so DESCRIBE CATALOG EXTENDED was not issued."
				});
				continue;
			}
			const outcome = await context.scheduler.run({
				surface: this.surface,
				label: `describe-catalog:${target.catalog}`,
				run: async (signal) => {
					const raw = await this.options.executor(`DESCRIBE CATALOG EXTENDED ${quoted}`, {}, signal);
					this.calls += 1;
					const statementId = raw.statementId;
					if (typeof statementId === "string") this.statementIds.push(statementId);
					return rowsOf(raw);
				}
			});
			if (outcome.status === "ok") {
				catalogs.push({
					...settingOf(outcome.value),
					catalog: target.catalog,
					managedTables: target.managedTables
				});
				continue;
			}
			unreadable.push({
				catalog: target.catalog,
				reason: outcome.status === "skipped" ? outcome.detail : outcome.failure.message
			});
			if (outcome.status === "skipped" && (outcome.reason === "budget-exhausted" || outcome.reason === "cancelled")) break;
		}
		if (catalogs.length === 0) return unmeasurable(id, `None of the ${String(targets.length)} catalogs could be described, so predictive-optimization coverage could not be read. First reason: ${unreadable[0]?.reason ?? "unknown."}`);
		const value = coverageOf(catalogs, unreadable);
		const complete = catalogs.length >= all.length;
		const reach = inventory.coverage.reach ?? "metastore";
		return observed(id, value, Date.now() - started, complete ? {
			mode: "complete",
			reach
		} : {
			mode: "sampled",
			reach,
			examined: catalogs.length,
			population: all.length,
			basis: "catalogs holding the most managed tables first, so the largest share of the estate is read"
		});
	}
};
/**
* The setting for one catalog, from the rows `DESCRIBE CATALOG EXTENDED` returns.
*
* The output is a two-column name/value listing rather than a typed row, and the column
* names differ between `DESCRIBE CATALOG` and `DESCRIBE SCHEMA` (`info_name` versus
* `database_description_item`). Matching on the label across whichever columns the row
* has is what lets one parser serve both, and means a third naming does not silently
* yield "unknown".
*
* The value observed live is `ENABLE (inherited from METASTORE metastore_aws_ap_southeast_2)`
* — a setting followed by an optional parenthesised origin.
*/
function settingOf(rows) {
	for (const row of rows) {
		const values = Object.values(row).map((value) => typeof value === "string" ? value : "");
		if (!values.some((value) => value.trim().toLowerCase() === SETTING_LABEL)) continue;
		const stated = values.find((value) => value.trim().toLowerCase() !== SETTING_LABEL && value.trim() !== "");
		if (stated == null) break;
		const setting = settingFrom(stated);
		const origin = /inherited from\s+(.+?)\s*\)/i.exec(stated)?.[1];
		return {
			setting,
			...origin != null ? { inheritedFrom: origin } : {}
		};
	}
	return { setting: "unknown" };
}
function settingFrom(stated) {
	const first = (stated.trim().split(/[\s(]/)[0] ?? "").toUpperCase();
	if (first === "ENABLE") return "enable";
	if (first === "DISABLE") return "disable";
	if (first === "INHERIT") return "inherit";
	return "unknown";
}
/**
* Collapse per-catalog settings into the estate summary a precondition reads.
*
* Weighted by managed tables rather than by catalog, because the share that matters is
* the share of the estate covered. Four of five catalogs enabled is not 80% coverage if
* the fifth holds most of the tables.
*
* `inherit` counts as not enabled. It means the setting was not decided here, and
* `DESCRIBE` reports the effective value with its origin — so a catalog inheriting an
* enabled metastore reads as `ENABLE (inherited from …)`, not as `INHERIT`. A literal
* `INHERIT` therefore means the chain above it did not resolve to enabled either.
*/
function coverageOf(catalogs, unreadable) {
	const managedTables = catalogs.reduce((total, catalog) => total + catalog.managedTables, 0);
	const enabledTables = catalogs.filter((catalog) => catalog.setting === "enable").reduce((total, catalog) => total + catalog.managedTables, 0);
	const state = stateOf(catalogs, managedTables, enabledTables);
	return {
		managedTables,
		enabledTables,
		catalogs,
		unreadable,
		state,
		summary: state
	};
}
function stateOf(catalogs, managedTables, enabledTables) {
	if (catalogs.every((catalog) => catalog.setting === "unknown")) return "unknown";
	if (managedTables === 0) return "disabled";
	if (enabledTables === managedTables) return "enabled";
	if (enabledTables === 0) return "disabled";
	return "partial";
}
//#endregion
export { CATALOGS_SIGNAL, PO_SIGNAL, PREDICTIVE_OPTIMIZATION_SIGNALS, PredictiveOptimizationCollector };
