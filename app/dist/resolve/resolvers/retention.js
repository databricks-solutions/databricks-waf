import { evidenceFrom, fromSignal, threshold } from "./helpers.js";
import { DETAILS, describedNothing, nameOf, someOf } from "./table-details.js";
//#region server/resolve/resolvers/retention.ts
/**
* Delta's own defaults, which apply to every table that sets neither property.
*
* Hard-coded rather than read from the estate because there is nowhere to read them from: an unset
* property is absent from `DESCRIBE DETAIL`, so the default is knowledge this app has to hold. It
* is stated in both findings for that reason — a reader told their window is seven days deserves to
* know that is inherited rather than chosen, and that it moves if Databricks moves it.
*
* https://docs.databricks.com/aws/en/delta/history#configure-data-retention-for-time-travel
*/
const DEFAULT_LOG_DAYS = 30;
const DEFAULT_FILE_DAYS = 7;
const LOG_PROPERTY = "delta.logRetentionDuration";
const FILE_PROPERTY = "delta.deletedFileRetentionDuration";
/**
* A Delta retention interval in days, or undefined where it cannot be read.
*
* Undefined rather than a guess. The property is free text applied by whoever set it, and a value
* this app cannot parse must be reported as unread: converting "interval 3 months" to an assumed
* ninety days would put a number in a recovery finding that the table does not actually guarantee.
*
* Months and years are deliberately not handled for that reason — they have no fixed length, and
* Delta's own documented syntax is in weeks and smaller.
*/
function retentionDays(value) {
	if (value == null) return void 0;
	const match = /^\s*(?:interval\s+)?(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week)s?\s*$/i.exec(value);
	if (match == null) return void 0;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount)) return void 0;
	return amount / {
		second: 86400,
		minute: 1440,
		hour: 24,
		day: 1,
		week: 1 / 7
	}[match[2].toLowerCase()];
}
function retentionOf(table) {
	const rawLog = table.properties[LOG_PROPERTY];
	const rawFile = table.properties[FILE_PROPERTY];
	const logDays = retentionDays(rawLog);
	const fileDays = retentionDays(rawFile);
	const effectiveLogDays = logDays ?? DEFAULT_LOG_DAYS;
	const effectiveFileDays = fileDays ?? DEFAULT_FILE_DAYS;
	const unparsed = [...rawLog != null && logDays == null ? [`${LOG_PROPERTY}="${rawLog}"`] : [], ...rawFile != null && fileDays == null ? [`${FILE_PROPERTY}="${rawFile}"`] : []];
	return {
		table,
		...logDays != null && { logDays },
		...fileDays != null && { fileDays },
		effectiveLogDays,
		effectiveFileDays,
		reachableDays: Math.min(effectiveLogDays, effectiveFileDays),
		setAnything: rawLog != null || rawFile != null,
		unparsed
	};
}
function days(value) {
	if (value >= 1) return plural(Math.round(value * 10) / 10, "day");
	const hours = value * 24;
	return hours >= 1 ? plural(Math.round(hours), "hour") : plural(Math.round(hours * 60), "minute");
}
function plural(amount, unit) {
	return `${String(amount)} ${unit}${amount === 1 ? "" : "s"}`;
}
const RETENTION_RESOLVERS = [fromSignal(DETAILS, ["REL-04-05", "CO-03-07"], (details, context) => {
	const empty = describedNothing(details);
	if (empty != null) return empty;
	const floor = threshold(context.spec, "min_reachable_days", DEFAULT_FILE_DAYS);
	const all = details.tables.map(retentionOf);
	const shortened = all.filter((entry) => entry.reachableDays < floor);
	const overstated = all.filter((entry) => entry.logDays != null && entry.logDays > entry.effectiveFileDays);
	const deliberate = all.filter((entry) => entry.setAnything);
	const unparsed = all.filter((entry) => entry.unparsed.length > 0);
	const covered = `${details.tables.length.toLocaleString("en-US")} Delta tables examined`;
	const shortest = all.reduce((worst, entry) => entry.reachableDays < worst.reachableDays ? entry : worst);
	const vacuumCaveat = "A window is reachable only once VACUUM has removed the older files, which predictive optimization does on managed tables. On a table nobody vacuums, more history remains reachable than the retention guarantees — so this reports the window the settings guarantee, not the one a given table happens to have today.";
	const unparsedEvidence = unparsed.length > 0 ? [evidenceFrom(context, DETAILS, `${unparsed.length.toLocaleString("en-US")} tables set a retention this scan could not read: ` + someOf(unparsed.map((entry) => entry.table), 2, (table) => `${nameOf(table)} (${retentionOf(table).unparsed.join(", ")})`), "Retention is expressed in the interval syntax Delta documents, in weeks or smaller")] : [];
	if (shortened.length > 0) return {
		outcome: "fail",
		evidence: [evidenceFrom(context, DETAILS, `${shortened.length.toLocaleString("en-US")} of the ${covered} can be restored no further back than ${days(floor)}: ` + someOf(shortened.map((entry) => entry.table), 3, (table) => `${nameOf(table)} reaches ${days(retentionOf(table).reachableDays)}`), `Every table can be restored at least ${days(floor)} back, which is what Delta's own defaults give`), ...unparsedEvidence],
		outcomeReason: `Retention has been shortened below the platform default on ${String(shortened.length)} of the tables examined, so an accidental deletion or a bad write on one of them is recoverable for less than ${days(floor)} — ${nameOf(shortest.table)} for ${days(shortest.reachableDays)}. RESTORE and time travel both stop at that point. ${vacuumCaveat} Measured over a sample of the most-read tables, so there may be more.`
	};
	if (overstated.length > 0) return {
		outcome: "partial",
		evidence: [evidenceFrom(context, DETAILS, `${overstated.length.toLocaleString("en-US")} tables keep more log history than they keep data files: ` + someOf(overstated.map((entry) => entry.table), 3, (table) => {
			const entry = retentionOf(table);
			return `${nameOf(table)} retains ${days(entry.effectiveLogDays)} of history against ${days(entry.effectiveFileDays)} of files`;
		}), `${LOG_PROPERTY} and ${FILE_PROPERTY} reach the same point, so the retained history is usable`), ...unparsedEvidence],
		outcomeReason: `Time travel to a version needs both the log entry and the data files for that version, so a table retaining a year of log against a week of files can be restored a week back, not a year. The longer setting reads as the recovery window in every review it appears in, and the shorter one is what will hold on the day it is needed. ${vacuumCaveat}`
	};
	if (deliberate.length === 0) return {
		outcome: "partial",
		evidence: [evidenceFrom(context, DETAILS, `None of the ${covered} set either retention property, so all of them inherit Delta's defaults: ${days(DEFAULT_LOG_DAYS)} of log history and ${days(DEFAULT_FILE_DAYS)} of data files, reachable to ${days(DEFAULT_FILE_DAYS)}`, "Tables whose recovery window matters set it explicitly, rather than inheriting it"), ...unparsedEvidence],
		outcomeReason: `Every table examined can be restored ${days(DEFAULT_FILE_DAYS)} back, which is a defensible window and costs nothing to keep. What is absent is the decision: no table states the window its role needs, so any table needing longer does not have it, and any table needing nothing is paying for seven days of deleted files. This is partial credit rather than a failure — the default is supported and adequate for most tables. ${vacuumCaveat}`
	};
	return {
		outcome: "pass",
		evidence: [evidenceFrom(context, DETAILS, `${deliberate.length.toLocaleString("en-US")} of the ${covered} set retention explicitly, and every table examined can be restored at least ${days(floor)} back — the shortest is ${nameOf(shortest.table)} at ` + days(shortest.reachableDays), `Every table can be restored at least ${days(floor)} back, and its log and file retention reach the same point`), ...unparsedEvidence],
		outcomeReason: vacuumCaveat
	};
})];
//#endregion
export { RETENTION_RESOLVERS, retentionDays };
