import { CanonicalisationError } from "./canonical.js";
import { digestOf, fromBytes, sameDigest } from "./digest.js";
//#region server/records/verify.ts
/**
* The tables that hold records, and the column each one is ordered by when only some are read.
*
* `versioned` marks the two whose primary key is a pair. A plan and an action are stored as one row
* per revision, so `id` alone names three rows and an altered one reported as "action-7" would leave
* whoever has to look at it reading every revision to find which. Those rows are named `action-7@2`.
*
* `bytes` marks the one table whose digest does not cover a canonicalised `body`. A published month
* stores its document as text and its digest over those bytes exactly as a recipient holds them, so it
* is verified by hashing the column named here rather than by canonicalising a document. It belongs in
* this list for the reason it is the odd one out: the whole value of that record is that its bytes have
* not moved, and it was the one table this check did not look at while the report said all stored
* records were checked.
*/
const TABLES = [
	{
		table: "scans",
		newest: "started_at",
		versioned: false
	},
	{
		table: "attestations",
		newest: "attested_at",
		versioned: false
	},
	{
		table: "decisions",
		newest: "decided_at",
		versioned: false
	},
	{
		table: "improvement_plans",
		newest: "changed_at",
		versioned: true
	},
	{
		table: "improvement_actions",
		newest: "changed_at",
		versioned: true
	},
	{
		table: "validation_attempts",
		newest: "requested_at",
		versioned: true
	},
	{
		table: "accepted_risks",
		newest: "recorded_at",
		versioned: true
	},
	{
		table: "applicability_decisions",
		newest: "recorded_at",
		versioned: true
	},
	{
		table: "notes",
		newest: "noted_at",
		versioned: false
	},
	{
		table: "assessment_reviews",
		newest: "opened_at",
		versioned: false
	},
	{
		table: "pillar_reviews",
		newest: "recorded_at",
		versioned: false
	},
	{
		table: "assessment_results",
		newest: "finalised_at",
		versioned: false
	},
	{
		table: "month_publications",
		newest: "published_at",
		versioned: false,
		bytes: "json"
	}
];
TABLES.map((one) => one.table);
const MEANS = "Every record here was hashed when it was written, and the hash was recomputed just now from what is stored. A record reported as altered is not what this app wrote. A record reported as intact has not been changed by anything that did not also update its digest — which a person with write access to the database could do, so this establishes that the records are internally consistent, not that they are authentic.";
/** Reads back and checks every table, newest rows first. */
async function verifyRecords(options) {
	const limit = options.limit ?? 200;
	const tables = [];
	for (const entry of TABLES) {
		const bytes = "bytes" in entry ? entry.bytes : void 0;
		tables.push(await verifyTable(options.db, entry.table, entry.newest, entry.versioned, limit, bytes));
	}
	return {
		checkedAt: (options.now ?? (() => /* @__PURE__ */ new Date()))(),
		intact: tables.every((one) => one.altered.length === 0 && one.unreadable.length === 0),
		tables,
		means: MEANS
	};
}
async function verifyTable(db, table, newest, versioned, limit, bytes) {
	const counted = await db.query(`select count(*) as total from ${db.schema}.${table}`);
	const total = Number(counted.rows[0]?.total ?? 0);
	const stored = bytes ?? "body";
	const { rows } = await db.query(`select id, ${versioned ? "revision, " : ""}${stored} as body, digest from ${db.schema}.${table} order by ${newest} desc limit $1`, [limit]);
	let intact = 0;
	let unstamped = 0;
	const altered = [];
	const unreadable = [];
	for (const row of rows) {
		if (row.digest == null || row.digest === "") {
			unstamped += 1;
			continue;
		}
		const named = row.revision == null ? row.id : `${row.id}@${String(row.revision)}`;
		try {
			if (sameDigest(digestFor(row.body, bytes), row.digest)) intact += 1;
			else altered.push(named);
		} catch (error) {
			if (error instanceof CanonicalisationError) unreadable.push(named);
			else throw error;
		}
	}
	return {
		table,
		total,
		checked: rows.length,
		intact,
		unstamped,
		altered,
		unreadable
	};
}
/**
* The digest of one stored record, computed the way that record's digest was written.
*
* A `body` is a document, so it is canonicalised first and the digest covers the canonical bytes. A
* frozen text column is already the bytes, and canonicalising it would compare a digest over a JSON
* string against one over the document that string contains — a mismatch on every row, reported as a
* table full of altered records.
*
* A text column read back as anything but a string is not text this app wrote, which is the same fault a
* body that cannot be canonicalised is, and is reported the same way.
*/
function digestFor(stored, bytes) {
	if (bytes == null) return digestOf(stored);
	if (typeof stored !== "string") throw new CanonicalisationError(`a ${bytes} column that is not text`);
	return fromBytes(Buffer.from(stored, "utf8"));
}
/**
* The report as one sentence.
*
* Here rather than in the UI because the numbers and the words about them have to agree, and an
* endpoint that returned only the numbers would leave every consumer to invent the sentence — which
* is how "verified" ends up on a screen above a table containing an unstamped row.
*/
function describeVerification(report) {
	const checked = report.tables.reduce((sum, one) => sum + one.checked, 0);
	const total = report.tables.reduce((sum, one) => sum + one.total, 0);
	const altered = report.tables.flatMap((one) => one.altered);
	const unreadable = report.tables.flatMap((one) => one.unreadable);
	const unstamped = report.tables.reduce((sum, one) => sum + one.unstamped, 0);
	const scope = checked === total ? `All ${String(total)} stored records were checked` : `The newest ${String(checked)} of ${String(total)} stored records were checked`;
	if (altered.length > 0 || unreadable.length > 0) {
		const named = [...altered, ...unreadable].slice(0, 5).join(", ");
		const rest = altered.length + unreadable.length - Math.min(5, altered.length + unreadable.length);
		return `${scope}, and ${String(altered.length + unreadable.length)} no longer match the digest written with them: ${named}${rest > 0 ? ` and ${String(rest)} more` : ""}. Those records are not what this app wrote.`;
	}
	if (checked > 0 && unstamped === checked) return `${scope}, and none of them carry a digest: all ${String(checked)} were written before this app recorded them, so nothing here is verified. Records written from now on are.`;
	return `${scope} and each one still matches the digest written with it.${unstamped === 0 ? "" : ` ${String(unstamped)} of them were written before this app recorded digests and carry none, so they are unstamped rather than verified.`}`;
}
//#endregion
export { MEANS, describeVerification, verifyRecords };
