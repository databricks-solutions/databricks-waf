/** The two kinds of row, and the only two the table's check constraint admits. */
const GAP = "gap";
const ACKNOWLEDGEMENT = "acknowledgement";
const COLUMNS = "id, at, actor, action, outcome, target_kind, target_id, cause";
var PostgresAuditGapLog = class {
	db;
	durable = true;
	limit;
	constructor(db, options = {}) {
		this.db = db;
		this.limit = options.limit ?? 100;
	}
	async record(gap) {
		try {
			await this.db.query(`insert into ${this.db.schema}.audit_gaps (id, kind, at, actor, action, outcome, target_kind, target_id, cause, gap_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
				gap.id,
				GAP,
				gap.at,
				gap.actor,
				gap.action,
				gap.outcome,
				gap.target?.kind ?? null,
				gap.target?.id ?? null,
				gap.cause,
				null
			]);
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
	}
	async unacknowledged() {
		const { rows } = await this.db.query(`select a.id, a.at, a.actor, a.action, a.outcome, a.target_kind, a.target_id, a.cause
         from ${this.db.schema}.audit_gaps a
        where a.kind = $1
          and not exists (
                select 1
                  from ${this.db.schema}.audit_gaps b
                 where b.gap_id = a.id
                   and b.kind = $2
              )
        order by a.at desc
        limit $3`, [
			GAP,
			ACKNOWLEDGEMENT,
			this.limit + 1
		]);
		return {
			gaps: rows.slice(0, this.limit).map(revive),
			truncated: rows.length > this.limit
		};
	}
	async acknowledge(id, by, at) {
		const gap = await this.find(id);
		if (gap == null) return void 0;
		try {
			await this.db.query(`insert into ${this.db.schema}.audit_gaps (id, kind, at, actor, action, outcome, target_kind, target_id, cause, gap_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`, [
				acknowledgementId(id),
				ACKNOWLEDGEMENT,
				at,
				by,
				null,
				null,
				null,
				null,
				null,
				id
			]);
			return {
				gap,
				by,
				at,
				already: false
			};
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
		const first = await this.acknowledgement(id);
		return first == null ? void 0 : {
			gap,
			by: first.by,
			at: first.at,
			already: true
		};
	}
	async find(id) {
		const { rows } = await this.db.query(`select ${COLUMNS} from ${this.db.schema}.audit_gaps where id = $1 and kind = $2`, [id, GAP]);
		const row = rows[0];
		return row == null ? void 0 : revive(row);
	}
	async acknowledgement(id) {
		const { rows } = await this.db.query(`select actor, at from ${this.db.schema}.audit_gaps where gap_id = $1 and kind = $2`, [id, ACKNOWLEDGEMENT]);
		const row = rows[0];
		return row == null ? void 0 : {
			by: row.actor,
			at: new Date(row.at)
		};
	}
};
/**
* The gap log for a build with nothing to persist to.
*
* Kept for `WAF_DEMO_NO_PERSISTENCE=1`, with the same behaviour as the durable one so the tests that
* matter run against the same rules, and with `durable` false so a page can say the markers go with
* the process.
*/
var InMemoryAuditGapLog = class {
	durable = false;
	gaps = /* @__PURE__ */ new Map();
	acknowledged = /* @__PURE__ */ new Map();
	record(gap) {
		if (!this.gaps.has(gap.id)) this.gaps.set(gap.id, gap);
		return Promise.resolve();
	}
	unacknowledged() {
		const open = [...this.gaps.values()].filter((gap) => !this.acknowledged.has(gap.id)).sort((left, right) => right.at.getTime() - left.at.getTime());
		return Promise.resolve({
			gaps: open.slice(0, 100),
			truncated: open.length > 100
		});
	}
	acknowledge(id, by, at) {
		const gap = this.gaps.get(id);
		if (gap == null) return Promise.resolve(void 0);
		const first = this.acknowledged.get(id);
		if (first != null) return Promise.resolve({
			gap,
			by: first.by,
			at: first.at,
			already: true
		});
		this.acknowledged.set(id, {
			by,
			at
		});
		return Promise.resolve({
			gap,
			by,
			at,
			already: false
		});
	}
};
/** The id an acknowledgement row is written under, derived so it is one per marker by construction. */
function acknowledgementId(gapId) {
	return `${gapId}.acknowledged`;
}
function revive(row) {
	return {
		id: row.id,
		at: new Date(row.at),
		actor: row.actor,
		action: row.action,
		outcome: row.outcome,
		...row.target_kind != null && row.target_id != null ? { target: {
			kind: row.target_kind,
			id: row.target_id
		} } : {},
		cause: row.cause
	};
}
/** Postgres's duplicate-key code, which is what a repeated id or a second acknowledgement arrives as. */
function isDuplicate(error) {
	return typeof error === "object" && error != null && error.code === "23505";
}
//#endregion
export { InMemoryAuditGapLog, PostgresAuditGapLog };
