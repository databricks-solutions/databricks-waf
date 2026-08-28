import { bytes, evidenceFrom, observedValue } from "./helpers.js";
//#region server/resolve/resolvers/storage-reading.ts
const SNAPSHOT = "sql:storage.table_metrics";
const SAMPLE = "describe:storage.table_details";
/** Both sources, for a resolver's `requires`, so whichever answers has been collected. */
const STORAGE_SIGNALS = [SNAPSHOT, SAMPLE];
/**
* The best available reading of stored bytes and file counts, or undefined if neither
* source could be read.
*
* Soft-reads both signals rather than requiring either, so an empty snapshot degrades the
* claim rather than withdrawing the control. Both are still declared in `requires` by the
* resolvers that call this, so "neither could be read" means neither answered, never that
* nobody asked.
*/
function readStorage(context) {
	return fromSnapshot(context) ?? fromSample(context);
}
/**
* Why there is no reading, in the terms of both sources.
*
* Composed from the collectors' own reasons rather than restated here. A control that
* cannot be measured because a permission was denied and one that cannot be measured
* because a preview table is empty need different actions from the reader, and a single
* generic sentence covering both would prompt neither.
*/
function storageUnreadable(context) {
	return `Table sizes and file counts have two possible sources and neither answered. ${STORAGE_SIGNALS.map((signal) => {
		const result = context.signals.get(signal);
		if (result == null) return `${label(signal)} was not collected in this scan`;
		if (result.status === "unmeasurable") return `${label(signal)} could not be read: ${result.unmeasurableReason ?? "no reason was recorded"}`;
		return `${label(signal)} returned no tables`;
	}).join(". ")}.`;
}
function fromSnapshot(context) {
	const metrics = observedValue(context, SNAPSHOT);
	if (metrics == null || !metrics.snapshotAvailable) return void 0;
	const asOf = metrics.snapshotDate?.toISOString().slice(0, 10);
	return {
		signal: SNAPSHOT,
		complete: true,
		totalBytes: metrics.activeBytes,
		files: metrics.activeFiles,
		tables: metrics.tableCount,
		...average(metrics.activeBytes, metrics.activeFiles),
		largest: metrics.largest.map((table) => ({
			name: `${table.catalog}.${table.schema}.${table.table}`,
			sizeBytes: table.activeBytes
		})),
		basis: `Measured across all ${metrics.tableCount.toLocaleString("en-US")} tables in the metastore from the platform's per-table storage snapshot` + (asOf != null ? `, as of ${asOf}` : "")
	};
}
function fromSample(context) {
	const details = observedValue(context, SAMPLE);
	if (details == null || details.tables.length === 0) return void 0;
	const totalBytes = details.tables.reduce((sum, table) => sum + table.sizeBytes, 0);
	const files = details.tables.reduce((sum, table) => sum + table.fileCount, 0);
	const complete = details.tables.length >= details.eligibleTables;
	return {
		signal: SAMPLE,
		complete,
		totalBytes,
		files,
		tables: details.tables.length,
		...average(totalBytes, files),
		largest: [...details.tables].sort((left, right) => right.sizeBytes - left.sizeBytes).slice(0, 3).map((table) => ({
			name: `${table.catalog}.${table.schema}.${table.table}`,
			sizeBytes: table.sizeBytes
		})),
		basis: complete ? `Measured across all ${details.tables.length.toLocaleString("en-US")} eligible tables by reading each table's Delta log` : `Measured across ${details.tables.length.toLocaleString("en-US")} of ${details.eligibleTables.toLocaleString("en-US")} eligible tables by reading each table's Delta log, so the total is a floor for the estate rather than its size. The platform's per-table storage snapshot, which would cover every table, has no rows for this metastore`
	};
}
function readFragmentation(context, minAverage) {
	const details = observedValue(context, SAMPLE);
	if (details != null && details.tables.length > 0) {
		const compactable = details.tables.filter((table) => table.fileCount > 0 && table.sizeBytes >= minAverage);
		if (compactable.length === 0) return {
			kind: "no-population",
			signal: SAMPLE,
			reason: `None of the ${details.tables.length.toLocaleString("en-US")} tables measured holds as much as one ${bytes(minAverage)} file, so none of them can be compacted to that size. File counts at these sizes are not a performance question.`
		};
		return {
			kind: "per-table",
			signal: SAMPLE,
			compactable: compactable.length,
			fragmented: compactable.map((table) => ({
				name: `${table.catalog}.${table.schema}.${table.table}`,
				averageFileBytes: table.sizeBytes / table.fileCount
			})).filter((table) => table.averageFileBytes < minAverage).sort((left, right) => left.averageFileBytes - right.averageFileBytes)
		};
	}
	const reading = fromSnapshot(context);
	if (reading?.averageFileBytes == null) return void 0;
	return {
		kind: "estate-average",
		signal: SNAPSHOT,
		averageFileBytes: reading.averageFileBytes
	};
}
/** The wording every finding built from the estate average has to carry. */
const ESTATE_AVERAGE_CAVEAT = "This is one average across the metastore, so it does not separate tables that are too small to compact from tables that are fragmented, and a few large well-written tables can hide many small ones.";
/**
* The share of compactable tables that are well sized, or undefined if the question does
* not apply.
*
* A share rather than a count because one fragmented table in four hundred and four hundred
* in four hundred are not the same finding, and a control that reported them alike would be
* ignored by the estate that has one.
*/
function compactedShare(fragmentation) {
	if (fragmentation == null || fragmentation.kind === "no-population") return void 0;
	if (fragmentation.kind === "estate-average") return void 0;
	return (fragmentation.compactable - fragmentation.fragmented.length) / fragmentation.compactable;
}
/** Whether the estate average, where that is all there is, sits below the target. */
function averageBelowTarget(fragmentation, minAverage) {
	return fragmentation?.kind === "estate-average" && fragmentation.averageFileBytes < minAverage;
}
function fragmentationEvidence(context, fragmentation, minAverage) {
	const expected = `Tables large enough to compact hold files averaging at least ${bytes(minAverage)}`;
	if (fragmentation.kind === "no-population") return evidenceFrom(context, fragmentation.signal, fragmentation.reason, expected);
	if (fragmentation.kind === "estate-average") return evidenceFrom(context, fragmentation.signal, `Active files average ${bytes(fragmentation.averageFileBytes)} across the metastore`, expected);
	const worst = fragmentation.fragmented.slice(0, 3).map((table) => `${table.name} at ${bytes(table.averageFileBytes)}`).join("; ");
	return evidenceFrom(context, fragmentation.signal, `${fragmentation.compactable - fragmentation.fragmented.length} of ${fragmentation.compactable} tables large enough to compact hold files averaging at least ${bytes(minAverage)}` + (worst === "" ? "" : `; smallest average: ${worst}`), expected);
}
/**
* How the total may be described, given what it covers.
*
* A sampled sum is a floor and a complete sum is a size, and the difference is not
* decoration: "1.2 TiB" from half the tables invites a capacity decision the number does
* not support.
*/
function describeTotal(reading) {
	const total = bytes(reading.totalBytes);
	const tables = `${reading.tables.toLocaleString("en-US")} table${reading.tables === 1 ? "" : "s"}`;
	const files = `${reading.files.toLocaleString("en-US")} file${reading.files === 1 ? "" : "s"}`;
	return reading.complete ? `${total} of active data across ${tables} in ${files}` : `At least ${total} of active data, across the ${tables} measured, in ${files}`;
}
function average(totalBytes, files) {
	return files > 0 ? { averageFileBytes: totalBytes / files } : {};
}
function label(signal) {
	return signal === "sql:storage.table_metrics" ? "the platform's per-table storage snapshot (system.storage.table_metrics_history)" : "the per-table DESCRIBE DETAIL pass";
}
//#endregion
export { ESTATE_AVERAGE_CAVEAT, SAMPLE, SNAPSHOT, STORAGE_SIGNALS, averageBelowTarget, compactedShare, describeTotal, fragmentationEvidence, readFragmentation, readStorage, storageUnreadable };
