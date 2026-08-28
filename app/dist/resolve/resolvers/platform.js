import { share } from "../../collect/sql/rows.js";
import { asWarehouse } from "../locate.js";
import { bandOutcome, bandsOf, detailFrom, enrichedBy, evidenceFrom, fromSignal, fromSignals, notApplicable, offenders, percent, sourcedFrom, threshold, unmeasured, valueOf } from "./helpers.js";
import { VISIBILITY_CROSS_CHECK, unestablishedEmptiness } from "./visibility.js";
import { ESTATE_AVERAGE_CAVEAT, STORAGE_SIGNALS, averageBelowTarget, compactedShare, fragmentationEvidence, readFragmentation, readStorage, storageUnreadable } from "./storage-reading.js";
//#region server/resolve/resolvers/platform.ts
const WAREHOUSES = "sql:compute.warehouses";
const CENSUS = "sql:uc.census";
const JOBS = "sql:jobs.inventory";
const PO = "describe:predictive_optimization.coverage";
const MAINTENANCE = "sql:maintenance.recency";
/** REL-03-02: warehouses should absorb concurrency rather than queue behind a fixed size. */
const warehouseScaling = fromSignal(WAREHOUSES, ["REL-03-02"], (warehouses, context) => {
	if (warehouses.length === 0) return notApplicable("There are no SQL warehouses in this workspace, so there is no warehouse scaling to configure.");
	const elastic = warehouses.filter((warehouse) => warehouse.scalesOut);
	const adopted = share(elastic.length, warehouses.length);
	const fixed = warehouses.filter((warehouse) => !warehouse.scalesOut);
	return {
		outcome: bandOutcome(adopted, bandsOf(context.spec, {
			pass: .8,
			partial: .4
		})),
		evidence: [evidenceFrom(context, WAREHOUSES, `${elastic.length} of ${warehouses.length} warehouses can add clusters under load`, "Warehouses serving concurrent users scale out rather than queueing"), ...offenders(context, WAREHOUSES, "Fixed at one cluster", fixed, asWarehouse)],
		outcomeReason: "A single-cluster warehouse is the right choice for a warehouse with one consumer. This is a finding for warehouses serving concurrent users, which the configuration alone cannot identify."
	};
});
/** PE-03-06: Unity Catalog managed tables, where the platform can optimise the layout. */
const managedTables = enrichedBy([VISIBILITY_CROSS_CHECK], fromSignal(CENSUS, ["PE-03-06"], (census, context) => {
	const population = census.tableCount - census.views;
	if (population <= 0) return (census.tableCount === 0 ? unestablishedEmptiness(context) : void 0) ?? notApplicable(census.tableCount === 0 ? "This metastore contains no tables, so there is no managed or external choice to assess." : "This metastore contains only views, which are neither managed nor external tables.");
	const managed = share(census.managedTables, population);
	return {
		outcome: bandOutcome(managed, bandsOf(context.spec, {
			pass: .8,
			partial: .4
		})),
		evidence: [evidenceFrom(context, CENSUS, `${census.managedTables} of ${population} tables are managed, ${census.externalTables} external (${percent(managed)} managed)`, "Tables are Unity Catalog managed, so the platform can maintain and optimise their layout")],
		outcomeReason: "External tables are the right choice where another engine writes the data or the location is fixed by something outside Databricks. A lower share may be a constraint rather than a gap."
	};
}));
/**
* PE-03-05: predictive optimization.
*
* Reported as a control in its own right as well as feeding the applicability of the
* manual-maintenance controls, so a customer can see the coverage that is excusing
* those controls rather than finding them silently absent.
*/
const predictiveOptimization = fromSignal(PO, ["PE-03-05"], (po, context) => {
	if (po.managedTables === 0) return notApplicable("There are no Unity Catalog managed tables in this metastore. Predictive optimization operates on managed tables, so there is nothing for it to maintain.");
	if (po.state === "unknown") return unmeasured(`None of the ${po.catalogs.length} catalogs reported a predictive optimization setting. The setting is read from DESCRIBE CATALOG EXTENDED, which reports it on current runtimes; an absent setting is reported as unmeasured rather than as predictive optimization being switched off.`);
	const covered = share(po.enabledTables, po.managedTables);
	return {
		outcome: bandOutcome(covered, bandsOf(context.spec, {
			pass: 1,
			partial: .5
		})),
		evidence: [evidenceFrom(context, PO, `${po.enabledTables} of ${po.managedTables} managed tables sit under a catalog with predictive optimization enabled (${percent(covered)}); ${describeSettings(po)}`, "Managed tables are maintained automatically rather than by scheduled manual commands"), detailFrom(context, PO, CATALOG_LEVEL_READING)],
		...covered != null && covered < 1 ? { outcomeReason: CATALOG_LEVEL_READING } : {}
	};
});
/**
* The caveat that belongs on every finding built from catalog-level enablement.
*
* Stated as evidence rather than buried in a comment because it changes what the number
* means. A schema or table can override its catalog, so a full reading here is a
* well-configured default rather than a per-table confirmation — and a partial reading
* may be narrower or wider than it looks.
*/
const CATALOG_LEVEL_READING = "Enablement is read per catalog. A schema or table can override its catalog, and this does not read that level, so the figure describes the estate default rather than a per-table confirmation.";
/** Which catalogs are on, named, so the share is actionable rather than just a fraction. */
function describeSettings(po) {
	const off = po.catalogs.filter((catalog) => catalog.setting !== "enable");
	if (off.length === 0) {
		const inherited = po.catalogs.find((catalog) => catalog.inheritedFrom != null)?.inheritedFrom;
		return `all ${po.catalogs.length} catalogs are enabled` + (inherited != null ? `, inherited from ${inherited}` : "");
	}
	return `not enabled on ${off.map((catalog) => `${catalog.catalog} (${catalog.setting})`).join(", ")}`;
}
const PLATFORM_RESOLVERS = [
	warehouseScaling,
	managedTables,
	predictiveOptimization,
	sourcedFrom(STORAGE_SIGNALS, fromSignals([MAINTENANCE, PO], ["PE-03-11"], (context) => {
		const maintenance = valueOf(context, MAINTENANCE);
		const po = valueOf(context, PO);
		const reading = readStorage(context);
		const optimizeRuns = maintenance.operations.filter((op) => op.source !== "manual_unresolved" && op.operation.toUpperCase().includes("OPTIMIZE"));
		const unresolvedRuns = maintenance.operations.filter((op) => op.source === "manual_unresolved" && op.operation.toUpperCase().includes("OPTIMIZE")).reduce((sum, op) => sum + op.operations, 0);
		const totalRuns = optimizeRuns.reduce((sum, op) => sum + op.operations, 0);
		const minAverage = threshold(context.spec, "min_average_file_bytes", 16 * 1024 * 1024);
		const unattributed = `${unresolvedRuns.toLocaleString("en-US")} OPTIMIZE ${unresolvedRuns === 1 ? "operation" : "operations"} ran that could not be matched to an assessed table`;
		const evidence = [evidenceFrom(context, MAINTENANCE, totalRuns === 0 ? unresolvedRuns === 0 ? "No OPTIMIZE was observed in the window, from predictive optimization or manually" : `No OPTIMIZE in the window was attributable to an assessed table, and ${unattributed}` : `${totalRuns} OPTIMIZE operations in the window (${optimizeRuns.map((op) => op.source === "manual" ? "manual" : "predictive optimization").join(", ")})` + (unresolvedRuns > 0 ? `; a further ${unattributed}` : ""), "Small files are compacted, automatically or on a schedule")];
		const fragmentation = readFragmentation(context, minAverage);
		if (fragmentation == null) return {
			outcome: "unmeasurable",
			evidence,
			outcomeReason: "Whether compaction is keeping up is a question about file sizes, and none could be read. " + storageUnreadable(context) + " Query history also omits commands run in notebooks on classic compute, so scheduled OPTIMIZE from a job cluster would not appear above."
		};
		evidence.push(fragmentationEvidence(context, fragmentation, minAverage));
		if (fragmentation.kind === "no-population") return {
			outcome: "not-applicable",
			evidence,
			outcomeReason: `${fragmentation.reason} Compaction applies once tables are large enough for file size to affect scans.`
		};
		const belowTarget = averageBelowTarget(fragmentation, minAverage);
		const bands = bandsOf(context.spec, {
			pass: .9,
			partial: .6
		});
		const measured = belowTarget ? "fail" : bandOutcome(compactedShare(fragmentation), bands);
		const addressed = totalRuns > 0 || unresolvedRuns > 0 || po.state !== "disabled";
		const outcome = measured === "fail" && addressed ? "partial" : measured;
		if (outcome === "pass") return {
			outcome,
			evidence,
			...reading?.complete === false ? { outcomeReason: "Measured across the tables sampled rather than the whole metastore, so this says the tables read are compacted rather than that all of them are." } : {}
		};
		return {
			outcome,
			evidence,
			outcomeReason: "Files are smaller than the size at which per-file overhead stops dominating scans. " + (po.state === "enabled" ? "Predictive optimization is already enabled, so it has either not reached these tables yet or is not keeping up with how they are written; OPTIMIZE on the tables named above is the direct fix." : po.state === "partial" ? "Predictive optimization covers part of the estate — extending it to the remaining catalogs is the lower-effort fix, and OPTIMIZE on the tables named above is the direct one." : "Enabling predictive optimization is the lower-effort fix; OPTIMIZE on the tables named above is the direct one.") + (totalRuns === 0 && unresolvedRuns > 0 ? ` This is not scored as though nothing ran: ${unattributed}, so a schedule may already cover these tables under a name this reading could not resolve.` : "") + (belowTarget ? ` ${ESTATE_AVERAGE_CAVEAT}` : "")
		};
	})),
	fromSignals([MAINTENANCE, PO], ["PE-03-15"], (context) => {
		const maintenance = valueOf(context, MAINTENANCE);
		const po = valueOf(context, PO);
		const analyze = maintenance.operations.filter((op) => op.source !== "manual_unresolved" && op.operation.toUpperCase().includes("ANALYZE"));
		const unresolvedAnalyze = maintenance.operations.filter((op) => op.source === "manual_unresolved" && op.operation.toUpperCase().includes("ANALYZE"));
		const runs = analyze.reduce((sum, op) => sum + op.operations, 0);
		const unresolvedRuns = unresolvedAnalyze.reduce((sum, op) => sum + op.operations, 0);
		if (po.state === "enabled") return {
			outcome: "satisfied-by-architecture",
			evidence: [evidenceFrom(context, PO, `Predictive optimization is enabled on all ${po.managedTables} managed tables`, "Table statistics are current")],
			outcomeReason: "Predictive optimization maintains statistics on managed tables, so the absence of ANALYZE statements is correct behaviour rather than a gap."
		};
		if (runs > 0) return {
			outcome: "pass",
			evidence: [evidenceFrom(context, MAINTENANCE, `${runs} ANALYZE operations in the window attributable to assessed tables`, "Statistics are collected so the optimiser can plan joins and skipping")]
		};
		if (unresolvedRuns > 0) return {
			outcome: "unmeasurable",
			evidence: [evidenceFrom(context, MAINTENANCE, `${unresolvedRuns} ANALYZE statement${unresolvedRuns === 1 ? "" : "s"} in the window could not be attributed to a table in the assessed population`, "Statistics are collected so the optimiser can plan joins and skipping")],
			outcomeReason: "Query history shows ANALYZE commands whose target could not be resolved into the assessed metastore. Crediting them would pass work done elsewhere; treating the absence of attributable ANALYZE as a gap would invent one. Reported unmeasured."
		};
		return {
			outcome: "unmeasurable",
			evidence: [evidenceFrom(context, MAINTENANCE, "No ANALYZE statements were observed in the window", "Statistics are collected so the optimiser can plan joins and skipping")],
			outcomeReason: "Query history records SQL warehouse and serverless activity but not commands run in notebooks on classic compute, so scheduled ANALYZE would not appear here. Reported as unmeasured rather than as a gap, because the evidence cannot distinguish the two."
		};
	}),
	fromSignal(JOBS, ["REL-01-04"], (jobs, context) => {
		if (jobs.length === 0) return notApplicable("There are no jobs in this workspace, so there is no job configuration to assess.");
		const known = jobs.filter((job) => job.timeoutSeconds != null);
		const bounded = known.filter((job) => (job.timeoutSeconds ?? 0) > 0);
		if (known.length === 0) return {
			outcome: "unmeasurable",
			evidence: [evidenceFrom(context, JOBS, `None of ${jobs.length} jobs have a recorded timeout setting`, "Jobs have a timeout so a hung run cannot bill indefinitely")],
			outcomeReason: "The jobs system table does not record timeouts for rows written before early December 2025, and none of these jobs have been modified since. The setting may well be configured; it is not readable from here."
		};
		return {
			outcome: bandOutcome(share(bounded.length, known.length), bandsOf(context.spec, {
				pass: .8,
				partial: .4
			})),
			evidence: [evidenceFrom(context, JOBS, `${bounded.length} of ${known.length} jobs with a recorded setting have a timeout` + (known.length < jobs.length ? `; ${jobs.length - known.length} jobs have no recorded setting` : ""), "Jobs have a timeout so a hung run cannot bill indefinitely")],
			...known.length < jobs.length ? { outcomeReason: `${jobs.length - known.length} of ${jobs.length} jobs predate the system table column that records timeouts and are excluded from the share rather than counted as failures.` } : {}
		};
	})
];
//#endregion
export { PLATFORM_RESOLVERS };
