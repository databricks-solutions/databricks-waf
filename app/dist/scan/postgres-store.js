import { digestOf } from "../records/digest.js";
import { UnreadableScanError, decodeScan, encodeScan } from "./codec.js";
import { applyScope } from "../store/assessment-scope.js";
import { summarise } from "./store.js";
//#region server/scan/postgres-store.ts
var PostgresScanStore = class {
	options;
	durable = true;
	/** Set when a history read failed, cleared when one succeeds. Read by `/api/scans`. */
	lastFailure;
	constructor(options) {
		this.options = options;
	}
	unreadable() {
		return this.lastFailure;
	}
	async save(scan) {
		const { db } = this.options;
		const body = encodeScan(scan);
		await db.query(`insert into ${db.schema}.scans (id, started_at, summary, body, digest, definition_id)
         values ($1, $2, $3::jsonb, $4::jsonb, $5, $6)
       on conflict (id) do update
         set started_at    = excluded.started_at,
             summary       = excluded.summary,
             body          = excluded.body,
             digest        = excluded.digest,
             definition_id = excluded.definition_id,
             written_at    = now()`, [
			scan.id,
			scan.startedAt,
			JSON.stringify(summarise(scan)),
			body,
			digestOf(JSON.parse(body)),
			scan.stamp.definition?.id ?? null
		]);
	}
	async get(id, scope) {
		const { db } = this.options;
		const scoped = applyScope("where id = $1", [id], scope);
		const { rows } = await db.query(`select body from ${db.schema}.scans ${scoped.fragment}`, scoped.values);
		const body = rows[0]?.body;
		if (body == null) return void 0;
		try {
			return decodeScan(id, JSON.stringify(body));
		} catch (error) {
			this.report(`read scan ${id}`, error);
			if (error instanceof UnreadableScanError) return void 0;
			throw error;
		}
	}
	/**
	* The newest scan, in one query rather than a summary read followed by a body read.
	*
	* Not `history(1)` then `get()`, for two reasons beyond the round trip. A scan whose summary
	* column is unreadable would drop out of the history and take the newest scan with it, leaving a
	* dashboard that says no scan has ever run while the scan itself sits in the table readable by
	* id. And the two-step version can disagree with itself: a scan written between the two queries
	* makes `history` name one row and `get` fetch a different one.
	*/
	async latest(scope) {
		const { db } = this.options;
		try {
			const scoped = applyScope("order by started_at desc limit 1", [], scope);
			const { rows } = await db.query(`select id, body from ${db.schema}.scans ${scoped.fragment}`, scoped.values);
			const newest = rows[0];
			if (newest == null) return void 0;
			return decodeScan(newest.id, JSON.stringify(newest.body));
		} catch (error) {
			this.report("read the newest scan", error);
			if (error instanceof UnreadableScanError) return void 0;
			throw error;
		}
	}
	async history(limit = 20, scope) {
		const { db } = this.options;
		try {
			const scoped = applyScope("order by started_at desc", [], scope);
			const { rows } = await db.query(`select summary from ${db.schema}.scans ${scoped.fragment} limit $${String(scoped.values.length + 1)}`, [...scoped.values, limit]);
			this.lastFailure = void 0;
			return rows.map((row) => revive(row.summary)).filter((summary) => summary != null);
		} catch (error) {
			this.report("read scan history", error);
			this.lastFailure = error instanceof Error ? error.message : String(error);
			return [];
		}
	}
	report(operation, error) {
		this.options.onError?.(operation, error);
	}
};
/**
* A stored summary with its two dates restored.
*
* There is no version check here, unlike the volume index this replaces. That check existed
* because a summary written by an earlier build lacked fields the page shows, and the recovery
* was to open the whole scan and re-summarise it. This schema started empty — ADR 0031 — so there
* was no earlier shape to meet, and inventing the upgrade path before there was anything to upgrade
* would have been guessing at which field gets added.
*
* A field has since been added: `range`, by row 40h. The spread below is what carries its absence —
* a row written before it comes back without the key rather than with a zero-width range — and an
* absent `range` is read as "this run's width was never recorded", which the history page renders
* as a score with no verdict word beside it. That is the whole upgrade path, and it holds for an
* optional field a reader can distinguish from a recorded value. A field that could not be
* distinguished that way would need the re-summarise this paragraph declined to write.
*
* A row whose dates do not parse is dropped rather than shown, because a history row rendering
* "Invalid Date" is worse than a history with one fewer row in it, and the scan is still readable
* by id.
*/
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const summary = raw;
	const startedAt = new Date(summary.startedAt);
	const finishedAt = new Date(summary.finishedAt);
	if (Number.isNaN(startedAt.getTime()) || Number.isNaN(finishedAt.getTime())) return void 0;
	if (typeof summary.id !== "string" || summary.id === "") return void 0;
	return {
		...summary,
		startedAt,
		finishedAt
	};
}
//#endregion
export { PostgresScanStore };
