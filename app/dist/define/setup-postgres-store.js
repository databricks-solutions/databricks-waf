import { newestFirst, targetOf } from "./setup-store.js";
//#region server/define/setup-postgres-store.ts
var PostgresSetupDraftStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async get(author, definitionId) {
		const { db } = this.options;
		try {
			const row = (await db.query(`select author, definition_id, body from ${db.schema}.assessment_setup_drafts
          where author = $1 and definition_id = $2`, [author, targetOf(definitionId)])).rows[0];
			return row == null ? void 0 : revive(row);
		} catch (error) {
			this.options.onError?.("read an unfinished assessment", error);
			throw error;
		}
	}
	async mine(author) {
		const { db } = this.options;
		try {
			const rows = await db.query(`select author, definition_id, body from ${db.schema}.assessment_setup_drafts where author = $1`, [author]);
			const drafts = [];
			for (const row of rows.rows) {
				const draft = revive(row);
				if (draft != null) drafts.push(draft);
			}
			return newestFirst(drafts);
		} catch (error) {
			this.options.onError?.("read every unfinished assessment", error);
			throw error;
		}
	}
	async save(draft) {
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.assessment_setup_drafts (author, definition_id, saved_at, body)
           values ($1, $2, $3, $4::jsonb)
         on conflict (author, definition_id)
           do update set saved_at = excluded.saved_at, body = excluded.body`, [
				draft.author,
				targetOf(draft.definitionId),
				draft.savedAt,
				JSON.stringify(draft)
			]);
		} catch (error) {
			this.options.onError?.("keep an unfinished assessment", error);
			throw error;
		}
	}
	async discard(author, definitionId) {
		const { db } = this.options;
		try {
			await db.query(`delete from ${db.schema}.assessment_setup_drafts where author = $1 and definition_id = $2`, [author, targetOf(definitionId)]);
		} catch (error) {
			this.options.onError?.("discard an unfinished assessment", error);
			throw error;
		}
	}
};
/**
* A stored row back into a draft.
*
* The author and the target come from the key columns rather than from the body, so a body edited in
* `psql` to name somebody else cannot hand one author's draft to another. Everything else is
* optional on the way in because it is optional in the type, and a field of the wrong shape is
* dropped rather than carried: a `lookbackDays` of `"thirty"` would otherwise reach `troubles`,
* which asks whether it is an integer and would report the answer as a lookback nobody typed.
*/
function revive(row) {
	const raw = row.body;
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	const savedAt = new Date(candidate.savedAt);
	if (Number.isNaN(savedAt.getTime())) return void 0;
	const { name, purpose, owners, lookbackDays, pillars, note, fromVersion } = candidate;
	const scope = scopeOf(candidate.scope);
	const targets = targetsOf(candidate.targets);
	return {
		author: row.author,
		...row.definition_id !== "" ? { definitionId: row.definition_id } : {},
		...typeof fromVersion === "number" && Number.isInteger(fromVersion) ? { fromVersion } : {},
		...typeof name === "string" ? { name } : {},
		...typeof purpose === "string" ? { purpose } : {},
		...isStrings(owners) ? { owners } : {},
		...scope != null ? { scope } : {},
		...typeof lookbackDays === "number" ? { lookbackDays } : {},
		...isStrings(pillars) ? { pillars } : {},
		...targets != null ? { targets } : {},
		...typeof note === "string" ? { note } : {},
		savedAt
	};
}
/**
* The stored targets, keeping the half-written ones.
*
* A row missing its score or its date is kept, because that is the state this table exists to hold —
* dropping it here would lose exactly the work a draft is for. A row of the wrong *shape* is dropped
* field by field for the reason `lookbackDays` is: a score of `"eighty"` reaching `troubles` would be
* reported to the author as a complaint about a number they never typed.
*
* A row with no pillar at all is dropped whole, since there is nothing for the wizard to show it
* against.
*/
function targetsOf(raw) {
	if (!Array.isArray(raw)) return void 0;
	return raw.flatMap((entry) => {
		if (entry == null || typeof entry !== "object") return [];
		const { pillar, atLeast, by } = entry;
		if (typeof pillar !== "string") return [];
		return [{
			pillar,
			...typeof atLeast === "number" ? { atLeast } : {},
			...typeof by === "string" ? { by } : {}
		}];
	});
}
function scopeOf(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const { kind, workspaceIds } = raw;
	if (kind !== "account" && kind !== "selected") return void 0;
	return {
		kind,
		...isStrings(workspaceIds) ? { workspaceIds } : {}
	};
}
function isStrings(value) {
	return Array.isArray(value) && value.every((one) => typeof one === "string");
}
//#endregion
export { PostgresSetupDraftStore };
