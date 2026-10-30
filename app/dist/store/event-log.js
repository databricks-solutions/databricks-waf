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
	* Postgres narrows to each requirement's newest stamp and to every record tied with it, and what is
	* left is settled here. "Newest" is not only the timestamp: two records can carry the same
	* millisecond, and then the one that supersedes the other is the newer, which is what
	* `newestFirstBy` knows and SQL does not. Doing the whole choice in SQL would give a subtly different
	* answer from the in-memory store for the same data, and two implementations of one interface
	* disagreeing is worse than a query that reads a little more than it strictly needs.
	*
	* A requirement is settled from the narrowed rows alone when exactly one row is left and it reads.
	* Otherwise its whole history is read and reduced the way it always was: a tie is ordered by how much
	* each record supersedes, a count that runs through records older than the tie, and a newest record
	* that does not read hands the requirement to the newest one that does. Both are the exception, so
	* what a read costs is the requirements and not the statements recorded about them.
	*/
	async current(scope) {
		const { db, table, stampColumn, stampOf, revive } = this.options;
		const operation = `read every ${this.options.noun}`;
		try {
			const scoped = applyScope("", [], scope);
			const inner = scoped.fragment === "" ? "" : ` ${scoped.fragment}`;
			const outer = scoped.fragment === "" ? "" : ` and ${scoped.fragment.replace(/^where /, "")}`;
			const { rows } = await db.query(`select control_id, body from ${db.schema}.${table}
           where (control_id, ${stampColumn}) in
             (select control_id, max(${stampColumn}) from ${db.schema}.${table}${inner} group by control_id)${outer}`, scoped.values);
			const narrowed = /* @__PURE__ */ new Map();
			for (const row of rows) narrowed.set(row.control_id, [...narrowed.get(row.control_id) ?? [], row.body]);
			const newest = [];
			const undecided = [];
			for (const [controlId, bodies] of narrowed) {
				const only = bodies.length === 1 ? revive(bodies[0]) : void 0;
				if (only != null) newest.push(only);
				else undecided.push(controlId);
			}
			let unreadable = 0;
			if (undecided.length > 0) {
				const history = applyScope("where control_id = any($1::text[])", [undecided], scope);
				const fetched = await this.fetch(history.fragment, history.values);
				unreadable = fetched.unreadable;
				const chosen = /* @__PURE__ */ new Map();
				for (const record of newestFirstBy(fetched.records, stampOf)) if (!chosen.has(record.controlId)) chosen.set(record.controlId, record);
				newest.push(...chosen.values());
			}
			this.reportUnreadable(operation, unreadable);
			return newestFirstBy(newest, stampOf);
		} catch (error) {
			this.report(operation, error);
			return [];
		}
	}
	async get(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		return (await this.read(`read ${this.options.noun} ${id}`, scoped.fragment, scoped.values))[0];
	}
	async historyFor(controlId, scope) {
		const scoped = applyScope("where control_id = $1", [controlId], scope);
		return newestFirstBy(await this.read(`read ${this.options.noun} history for ${controlId}`, scoped.fragment, scoped.values), this.options.stampOf);
	}
	async read(operation, where, values) {
		try {
			const { records, unreadable } = await this.fetch(where, values);
			this.reportUnreadable(operation, unreadable);
			return records;
		} catch (error) {
			this.report(operation, error);
			return [];
		}
	}
	/** The records a `where` selects, newest stamp first, and how many rows would not read. */
	async fetch(where, values) {
		const { db, table, stampColumn, revive } = this.options;
		const { rows } = await db.query(`select body from ${db.schema}.${table} ${where} order by ${stampColumn} desc`, values);
		const records = rows.map((row) => revive(row.body));
		return {
			records: records.filter((record) => record != null),
			unreadable: records.filter((record) => record == null).length
		};
	}
	/**
	* Reported once with a count rather than once per row: a schema change that makes every row
	* unreadable would otherwise emit one line per record, and the number is the useful part.
	*/
	reportUnreadable(operation, unreadable) {
		if (unreadable > 0) this.report(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored ${this.options.noun} record(s) could not be read`));
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
