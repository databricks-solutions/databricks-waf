import { digestOf } from "../records/digest.js";
import { applyScope } from "../store/assessment-scope.js";
import { threaded } from "./note.js";
//#region server/note/postgres-store.ts
var PostgresNoteStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async add(note) {
		const { db } = this.options;
		await db.query(`insert into ${db.schema}.notes (id, subject_kind, subject_id, noted_at, body, digest, definition_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (id) do nothing`, [
			note.id,
			note.subject.kind,
			note.subject.id,
			note.at,
			JSON.stringify(note),
			digestOf(note),
			note.definitionId ?? null
		]);
	}
	async for(subject, scope) {
		const operation = `read notes about ${subject.kind} ${subject.id}`;
		const scoped = applyScope("where subject_kind = $1 and subject_id = $2", [subject.kind, subject.id], scope);
		const rows = await this.read(operation, scoped.fragment, scoped.values);
		return threaded(this.revived(rows, operation));
	}
	async counts(kind, scope) {
		const { db } = this.options;
		const operation = `count notes about each ${kind}`;
		try {
			const scoped = applyScope("where subject_kind = $1", [kind], scope);
			const { rows } = await db.query(`select subject_id, count(*)::text as tally from ${db.schema}.notes ${scoped.fragment} group by subject_id`, scoped.values);
			const tally = {};
			for (const row of rows) tally[row.subject_id] = Number(row.tally);
			return tally;
		} catch (error) {
			this.options.onError?.(operation, error);
			return {};
		}
	}
	async ofKind(kind, scope) {
		const operation = `read notes about each ${kind}`;
		const scoped = applyScope("where subject_kind = $1", [kind], scope);
		const rows = await this.read(operation, scoped.fragment, scoped.values);
		return threaded(this.revived(rows, operation));
	}
	async read(operation, where, values) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select body from ${db.schema}.notes ${where} order by noted_at asc`, values);
			return rows.map((row) => row.body);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	revived(rows, operation) {
		const notes = rows.map(revive);
		const unreadable = notes.filter((note) => note == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored note row(s) could not be read`));
		return notes.filter((note) => note != null);
	}
};
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.body !== "string") return void 0;
	if (typeof candidate.by !== "string") return void 0;
	const subject = candidate.subject;
	if (subject == null || typeof subject !== "object") return void 0;
	if (typeof subject.kind !== "string" || typeof subject.id !== "string") return void 0;
	const at = new Date(candidate.at);
	if (Number.isNaN(at.getTime())) return void 0;
	return {
		...candidate,
		subject: {
			kind: subject.kind,
			id: subject.id
		},
		at
	};
}
//#endregion
export { PostgresNoteStore };
