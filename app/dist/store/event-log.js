import { digestOf } from "../records/digest.js";
import { applyScope } from "./assessment-scope.js";
import { newestFirstBy } from "./ordering.js";
//#region server/store/event-log.ts
var PostgresEventLog = class {
	options;
	constructor(options) {
		this.options = options;
	}
	async append(record) {
		const { db, table, stampColumn, stampOf } = this.options;
		await db.query(`insert into ${db.schema}.${table} (id, control_id, ${stampColumn}, body, digest, definition_id)
         values ($1, $2, $3, $4::jsonb, $5, $6)
       on conflict (id) do nothing`, [
			record.id,
			record.controlId,
			stampOf(record),
			JSON.stringify(record),
			digestOf(record),
			definitionIdOf(record)
		]);
	}
	/**
	* The newest record for each requirement.
	*
	* Every row is read and the newest picked in TypeScript, rather than `distinct on (control_id)`
	* picking it in Postgres. The reason is that "newest" is not only the timestamp: two records can
	* carry the same millisecond, and then the one that supersedes the other is the newer, which is
	* what `newestFirstBy` knows and SQL does not. Doing it in SQL would give a subtly different
	* answer from the in-memory store for the same data, and two implementations of one interface
	* disagreeing is worse than a query that reads more than it strictly needs.
	*
	* What it costs: one row per recorded statement, not per scan. That is bounded by the number of
	* requirements a customer has answered, times how often they have revised an answer — hundreds,
	* growing slowly. If it ever reaches the tens of thousands, the fix is a `distinct on` narrowing
	* followed by the same projection over the survivors, which keeps the tie-break.
	*/
	async current(scope) {
		const records = await this.all(scope);
		const newest = /* @__PURE__ */ new Map();
		for (const record of newestFirstBy(records, this.options.stampOf)) if (!newest.has(record.controlId)) newest.set(record.controlId, record);
		return [...newest.values()];
	}
	async get(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		return (await this.read(`read ${this.options.noun} ${id}`, scoped.fragment, scoped.values))[0];
	}
	async historyFor(controlId, scope) {
		const scoped = applyScope("where control_id = $1", [controlId], scope);
		return newestFirstBy(await this.read(`read ${this.options.noun} history for ${controlId}`, scoped.fragment, scoped.values), this.options.stampOf);
	}
	async all(scope) {
		const scoped = applyScope("", [], scope);
		return this.read(`read every ${this.options.noun}`, scoped.fragment, scoped.values);
	}
	async read(operation, where, values) {
		const { db, table, stampColumn, noun, revive } = this.options;
		try {
			const { rows } = await db.query(`select body from ${db.schema}.${table} ${where} order by ${stampColumn} desc`, values);
			const records = rows.map((row) => revive(row.body));
			const unreadable = records.filter((record) => record == null).length;
			if (unreadable > 0) this.report(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored ${noun} record(s) could not be read`));
			return records.filter((record) => record != null);
		} catch (error) {
			this.report(operation, error);
			return [];
		}
	}
	report(operation, error) {
		this.options.onError?.(operation, error);
	}
};
function definitionIdOf(record) {
	if (!("definitionId" in record)) return null;
	const value = record.definitionId;
	return typeof value === "string" ? value : null;
}
//#endregion
export { PostgresEventLog, newestFirstBy };
