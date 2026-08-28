import { VOLUME_SIGNAL } from "../../collect/cloud/collector.js";
import { bandsOf, bytes, detailFrom, enrichedBy, evidenceFrom, fromSignals, observedValue, sourcedFrom, threshold, unmeasured, valueOf } from "./helpers.js";
import { ESTATE_AVERAGE_CAVEAT, STORAGE_SIGNALS, averageBelowTarget, compactedShare, describeTotal, fragmentationEvidence, readFragmentation, readStorage, storageUnreadable } from "./storage-reading.js";
//#region server/resolve/resolvers/storage.ts
const MAINTENANCE = "sql:maintenance.recency";
const PO = "describe:predictive_optimization.coverage";
const STORAGE_RESOLVERS = [enrichedBy([VOLUME_SIGNAL], sourcedFrom(STORAGE_SIGNALS, fromSignals([], ["CO-03-05"], (context) => {
	const reading = readStorage(context);
	if (reading == null) return unmeasured(storageUnreadable(context));
	const minAverage = threshold(context.spec, "min_average_file_bytes", 16 * 1024 * 1024);
	const fragmentation = readFragmentation(context, minAverage);
	const bill = observedValue(context, VOLUME_SIGNAL);
	const billed = bill == null ? [] : [detailFrom(context, VOLUME_SIGNAL, `${bytes(bill.billedBytes)} billed across ${bill.locations === 1 ? "1 external location" : `${String(bill.locations)} external locations`}`)];
	const evidence = [
		evidenceFrom(context, reading.signal, `${describeTotal(reading)}. ${reading.basis}`, "Storage volume is measured and tracked, so growth is visible before it becomes a surprise"),
		...billed,
		...fragmentation != null ? [fragmentationEvidence(context, fragmentation, minAverage)] : [],
		...reading.largest.length > 0 ? [detailFrom(context, reading.signal, `Largest: ${reading.largest.map((table) => `${table.name} at ${bytes(table.sizeBytes)}`).join("; ")}`)] : []
	];
	const compacted = compactedShare(fragmentation);
	const bands = bandsOf(context.spec, {
		pass: .9,
		partial: .6
	});
	if (averageBelowTarget(fragmentation, minAverage) || compacted != null && compacted < bands.pass) return {
		outcome: "partial",
		evidence,
		outcomeReason: "The volume is measurable, but files are smaller than the size at which per-file overhead stops dominating scans. That costs read performance and metadata overhead rather than storage directly, and is what OPTIMIZE or predictive optimization addresses." + (fragmentation?.kind === "estate-average" ? ` ${ESTATE_AVERAGE_CAVEAT}` : "")
	};
	return {
		outcome: "pass",
		evidence,
		...reading.complete ? {} : { outcomeReason: `Measured across ${reading.tables.toLocaleString("en-US")} tables rather than the whole metastore, so this says the tables read are well sized rather than that every table is. A complete reading needs the platform’s per-table storage snapshot, which has no rows for this metastore.` }
	};
}))), fromSignals([MAINTENANCE, PO], ["CO-03-06"], (context) => {
	const maintenance = valueOf(context, MAINTENANCE);
	const po = valueOf(context, PO);
	const maxDays = threshold(context.spec, "max_days_since_vacuum", 30);
	const automatic = maintenance.operations.find((op) => op.source === "predictive_optimization" && op.operation.toUpperCase().includes("VACUUM"));
	const manual = maintenance.operations.find((op) => op.source === "manual" && op.operation.toUpperCase() === "VACUUM");
	const unresolved = maintenance.operations.find((op) => op.source === "manual_unresolved" && op.operation.toUpperCase() === "VACUUM");
	if (po.state === "enabled") return {
		outcome: "satisfied-by-architecture",
		evidence: [evidenceFrom(context, PO, `Predictive optimization covers all ${po.managedTables} managed tables by their catalog setting`, "Stale files are reclaimed without a scheduled manual command"), evidenceFrom(context, MAINTENANCE, automatic != null ? `It ran VACUUM ${automatic.operations} times, most recently ${describeWhen(automatic.lastRun)}` : "No VACUUM run by predictive optimization appears in the window", "Stale files are reclaimed within the expected interval")],
		outcomeReason: `Every catalog holding managed tables has predictive optimization enabled, covering all ${po.managedTables} of them, so the absence of manual VACUUM is correct behaviour rather than a gap. ` + (automatic != null ? "It has run VACUUM within the window." : "No run appears in the window, which is expected where no files became eligible — predictive optimization acts when there is something to reclaim rather than on a schedule.") + " Enablement is read per catalog, so a schema or table that overrides its catalog would not appear here."
	};
	const observed = [automatic != null ? `predictive optimization ran VACUUM ${describeWhen(automatic.lastRun)}` : void 0, manual != null ? `${manual.operations} manual VACUUM statements, last ${describeWhen(manual.lastRun)}` : void 0].filter((part) => part != null);
	if (observed.length === 0) {
		if (unresolved != null) return {
			outcome: "unmeasurable",
			evidence: [evidenceFrom(context, MAINTENANCE, `${unresolved.operations} manual VACUUM statement${unresolved.operations === 1 ? "" : "s"} in the window could not be attributed to a table in the assessed population`, `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`), evidenceFrom(context, PO, po.state === "unknown" ? "No catalog reported a predictive optimization setting" : `Predictive optimization covers ${po.enabledTables} of ${po.managedTables} managed tables by their catalog setting`, "Tables are either covered by predictive optimization or maintained manually")],
			outcomeReason: "Query history shows VACUUM commands whose target table could not be resolved into the assessed metastore — leading comments are stripped, but a quoted identifier, a two-part name, or a name outside the assessed catalogs still leaves the command unattributed. Crediting those would pass an estate for work done elsewhere; failing them would invent a gap. Reported unmeasured."
		};
		return {
			outcome: po.state === "unknown" ? "unmeasurable" : po.state === "partial" ? "partial" : "fail",
			evidence: [evidenceFrom(context, MAINTENANCE, "No VACUUM was observed in the window, from predictive optimization or manually", `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`), evidenceFrom(context, PO, po.state === "unknown" ? "No catalog reported a predictive optimization setting" : `Predictive optimization covers ${po.enabledTables} of ${po.managedTables} managed tables by their catalog setting`, "Tables are either covered by predictive optimization or maintained manually")],
			outcomeReason: po.state === "unknown" ? "No catalog reported a predictive optimization setting, so whether VACUUM should be running manually cannot be determined — where predictive optimization is on it does this automatically, and where it is off the absence above is a gap." : `${po.managedTables - po.enabledTables} managed tables are not covered by predictive optimization and no VACUUM was seen for them. Query history does not record commands run in notebooks on classic compute, so scheduled maintenance from a job cluster would not appear here — check before treating this as a gap.`
		};
	}
	const last = latest(automatic?.lastRun, manual?.lastRun);
	const days = last == null ? void 0 : Math.floor((Date.now() - last.getTime()) / 864e5);
	const withinWindow = days != null && days <= maxDays;
	return {
		outcome: withinWindow ? "pass" : "partial",
		evidence: [evidenceFrom(context, MAINTENANCE, observed.join("; "), `VACUUM runs at least every ${maxDays} days on tables outside predictive optimization`), evidenceFrom(context, PO, po.state === "unknown" ? "No catalog reported a predictive optimization setting" : `Predictive optimization is ${po.state}, covering ${po.enabledTables} of ${po.managedTables} managed tables by their catalog setting`, "Tables are either covered by predictive optimization or maintained manually")],
		...withinWindow ? {} : { outcomeReason: `The most recent VACUUM was ${String(days ?? "an unknown number of")} days ago, beyond the ${maxDays}-day expectation.` }
	};
})];
function describeWhen(when) {
	if (when == null) return "at an unrecorded time";
	const days = Math.floor((Date.now() - when.getTime()) / 864e5);
	if (days <= 0) return "today";
	return `${days} day${days === 1 ? "" : "s"} ago`;
}
function latest(...dates) {
	const known = dates.filter((d) => d != null);
	if (known.length === 0) return void 0;
	return known.reduce((newest, d) => d > newest ? d : newest);
}
//#endregion
export { STORAGE_RESOLVERS };
