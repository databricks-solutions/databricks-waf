import { CHAINED_TABLE, DEFAULT_PERIOD_DAYS, RETENTION_CLASSES } from "./retention.js";
//#region server/admin/retention-store.ts
var PostgresRetentionStore = class {
	db;
	durable = true;
	constructor(db) {
		this.db = db;
	}
	/**
	* The configured periods, with the defaults standing in for any class nobody has set.
	*
	* Merged over the defaults rather than requiring the rows to exist, so a database that has never
	* had a period set reports the approved defaults instead of nothing — and the first boot after this
	* lands does not need a seeding step that a second replica could race.
	*/
	async policy() {
		const { rows } = await this.db.query(`select retention_class, days, set_by, set_at from ${this.db.schema}.retention_periods`);
		const periods = { ...DEFAULT_PERIOD_DAYS };
		let setBy;
		let setAt;
		for (const row of rows) {
			const retentionClass = RETENTION_CLASSES.find((one) => one === row.retention_class);
			if (retentionClass == null) continue;
			periods[retentionClass] = Number(row.days);
			const at = row.set_at == null ? void 0 : new Date(row.set_at);
			if (at != null && (setAt == null || at > setAt)) {
				setAt = at;
				setBy = row.set_by ?? void 0;
			}
		}
		return {
			periods,
			...setBy != null ? { setBy } : {},
			...setAt != null ? { setAt } : {}
		};
	}
	async setPeriods(periods, by, at) {
		for (const [retentionClass, days] of Object.entries(periods)) {
			if (days == null) continue;
			await this.db.query(`insert into ${this.db.schema}.retention_periods (retention_class, days, set_by, set_at)
           values ($1, $2, $3, $4)
           on conflict (retention_class) do update set days = $2, set_by = $3, set_at = $4`, [
				retentionClass,
				days,
				by,
				at
			]);
		}
	}
	async holds() {
		const { rows } = await this.db.query(`select id, reason, covers, placed_by, placed_at, released_by, released_at
         from ${this.db.schema}.legal_holds order by placed_at desc`);
		return rows.map(reviveHold);
	}
	async place(hold) {
		await this.db.query(`insert into ${this.db.schema}.legal_holds (id, reason, covers, placed_by, placed_at)
         values ($1, $2, $3::jsonb, $4, $5)`, [
			hold.id,
			hold.reason,
			JSON.stringify(hold.covers),
			hold.placedBy,
			hold.placedAt
		]);
	}
	/**
	* Lifts a hold, and only one that is still in force.
	*
	* `released_at is null` in the predicate rather than checked after reading, so two people lifting
	* the same hold at once cannot both record themselves as the one who did it. The second is told
	* there was nothing to lift, which is true.
	*
	* Whether *this* call lifted it is decided by `RETURNING`, not by a follow-up read of
	* `released_by`. A second lift by the same actor would still see itself as `released_by` on a
	* re-read and would report `true` twice — which is how a release that did nothing looked like one
	* that did.
	*/
	async release(id, by, at) {
		const { rows } = await this.db.query(`update ${this.db.schema}.legal_holds set released_by = $2, released_at = $3
         where id = $1 and released_at is null
         returning id`, [
			id,
			by,
			at
		]);
		return rows.length > 0;
	}
};
function reviveHold(row) {
	const covers = Array.isArray(row.covers) ? row.covers.filter((one) => RETENTION_CLASSES.includes(one)) : [];
	return {
		id: row.id,
		reason: row.reason,
		covers,
		placedBy: row.placed_by,
		placedAt: new Date(row.placed_at),
		...row.released_by != null ? { releasedBy: row.released_by } : {},
		...row.released_at != null ? { releasedAt: new Date(row.released_at) } : {}
	};
}
/**
* A `where` clause for a row predicate, or nothing at all.
*
* Parenthesised, and that is the whole reason these are two functions rather than string
* concatenation at four call sites. A predicate with an `or` in it — `kind = 'assessment' or kind is
* null`, which is one of the two that exist — appended bare to `where started_at < $1 and …` binds as
* `(… and kind = 'assessment') or (kind is null)`, and the sweep deletes every row whose kind is null
* regardless of its age. That is the entire assessment run history of an install that predates the
* column, removed by a period nobody changed.
*
* Exported for its own test, which is unusual here and is because of where this can be checked. The
* fake refuses a predicate it cannot parse rather than matching everything — the right behaviour, and
* it means a subquery predicate cannot reach these two functions through the fake at all. So the
* composition is tested directly and the sweep it feeds is tested live.
*/
function where(only) {
	return only == null ? "" : ` where (${only})`;
}
function and(only) {
	return only == null ? "" : ` and (${only})`;
}
/**
* Counting and removing, over the real schema.
*
* The only place in retention that composes a table name into SQL. The names come from `RETAINED` and
* `RESET_TABLES` and from nowhere else — never from a request — which is what makes the concatenation
* safe; a checked lookup here as well would be a second copy of a list whose whole purpose is to be
* the only one.
*
* Both gateways, on one class. They are separate interfaces because the planning either side of them
* is separate — a sweep is about age and a reset is not — but there is one set of tables and one
* connection, and a second class would be a second place to get the schema name from.
*/
var PostgresRetentionGateway = class PostgresRetentionGateway {
	db;
	constructor(db) {
		this.db = db;
	}
	/**
	* One transaction, with `legal_holds` locked against writers before anything is read from it.
	*
	* `share row exclusive` rather than `access exclusive`: it conflicts with the `row exclusive` an
	* insert takes, so placing a hold waits, while a *reader* of the holds — the retention page somebody
	* has open — is not blocked. Refusing to serve that page for the duration of a reset would be a
	* stall in the surface whose job is to explain what is happening.
	*
	* Refuses outright when the handle cannot give it a session. That is a decision about which failure
	* is worse: running the sixteen deletes unprotected would work every time nothing else was happening
	* and lose data the one time something was, and a guarantee that holds until it matters is not one.
	*/
	async resetting(run) {
		if (this.db.session == null) throw new Error("This database handle cannot open a transaction, and a reset that is not one can stop half way through an install with no record of where it stopped. Nothing was removed.");
		return this.db.session(async (sql) => {
			await sql.query(`lock table ${this.db.schema}.legal_holds in share row exclusive mode`);
			return run(new PostgresRetentionGateway({
				...sql,
				schema: this.db.schema,
				query: sql.query.bind(sql)
			}));
		});
	}
	async count(table, stamp, before, only) {
		const clause = only?.(this.db.schema);
		const { rows } = await this.db.query(`select count(*) as total from ${this.db.schema}.${table}${where(clause)}`);
		const total = Number(rows[0]?.total ?? 0);
		const oldest = await this.oldest(table, stamp, clause);
		if (before == null) return {
			table,
			total,
			eligible: 0,
			...oldest != null ? { oldest } : {}
		};
		const { rows: aged } = await this.db.query(`select count(*) as total from ${this.db.schema}.${table} where ${stamp} < $1${and(clause)}`, [before]);
		return {
			table,
			total,
			eligible: Number(aged[0]?.total ?? 0),
			...oldest != null ? { oldest } : {}
		};
	}
	/**
	* The age of the oldest row, or nothing when the table is empty.
	*
	* Read even when no cutoff was asked for, because it is what makes a period judgeable: "40 scans,
	* none eligible" leaves an administrator no way to tell a period that is about to start removing
	* things from one that never will.
	*/
	async oldest(table, stamp, only) {
		const { rows } = await this.db.query(`select ${stamp} as oldest from ${this.db.schema}.${table}${where(only)} order by ${stamp} asc limit 1`);
		const row = rows[0];
		return row?.oldest == null ? void 0 : new Date(row.oldest);
	}
	/**
	* How many rows a table holds, with no cutoff and no oldest.
	*
	* Its own method rather than `count(table, stamp)` with the stamp ignored, because half the tables a
	* reset covers have no stamp a period is measured from — `retention_periods` is keyed on a class,
	* `audit_floor` is one row — and passing a column name that is never read would be a parameter whose
	* only purpose is to be wrong eventually.
	*/
	async countRows(table) {
		const { rows } = await this.db.query(`select count(*) as total from ${this.db.schema}.${table}`);
		return Number(rows[0]?.total ?? 0);
	}
	/**
	* Empties a table, and answers how many rows it held.
	*
	* Counted first for the reason `remove` gives: the `Sql` interface carries no row count, and the
	* disagreement a separate count can produce is in the safe direction here too — a row written
	* between the two is one the reset then removes and does not report, which understates by one and
	* loses nothing.
	*
	* `delete` rather than `truncate`. Truncate would be faster and takes an exclusive lock on the table
	* for the duration, which on an install somebody is still using is a stall rather than a refusal;
	* it also cannot be rolled back by the surrounding transaction on some configurations. A reset of a
	* demonstration install is at most tens of thousands of rows and this is not the place to buy speed.
	*/
	async empty(table) {
		const held = await this.countRows(table);
		if (held === 0) return 0;
		await this.db.query(`delete from ${this.db.schema}.${table}`);
		return held;
	}
	async remove(table, stamp, before, only) {
		const { eligible } = await this.count(table, stamp, before, only);
		if (eligible === 0) return 0;
		await this.db.query(`delete from ${this.db.schema}.${table} where ${stamp} < $1${and(only?.(this.db.schema))}`, [before]);
		return eligible;
	}
	/**
	* Trims the audit log to a contiguous prefix and records where it now starts.
	*
	* The prefix is decided by *sequence*, not by age, and the difference is the whole point. Deleting
	* every row with `at < cutoff` would leave a gap wherever one event's clock ran behind the event
	* after it, and a gap in a chained log is indistinguishable from an event somebody removed to hide
	* it. So this finds the earliest event that must be kept and removes everything below it — which
	* keeps a handful of events past their period rather than making the log unverifiable.
	*
	* The floor is written before the delete. If the delete then fails, the floor names a digest that
	* is still present, and verification starts at the event after it and passes: a floor that is too
	* low is harmless. The other order — delete, then fail to record the floor — leaves a log whose
	* first surviving event names a predecessor nothing can produce, which reads as tampering forever.
	*/
	/**
	* The last sequence a trim would take, or zero when it would take nothing.
	*
	* Shared with `countAuditPrefix` rather than written twice, so what the page reports and what the
	* sweep removes are the same rule by construction. Two copies of this would be two chances for the
	* page to promise a number the sweep does not deliver, which is exactly what the confirmation on
	* the sweep route exists to prevent.
	*/
	async prefixEnd(before) {
		const { rows: keep } = await this.db.query(`select sequence from ${this.db.schema}.${CHAINED_TABLE} where at >= $1 order by sequence asc limit 1`, [before]);
		const first = keep[0];
		if (first != null) return Number(first.sequence) - 1;
		const { rows: last } = await this.db.query(`select sequence from ${this.db.schema}.${CHAINED_TABLE} order by sequence desc limit 1`);
		return Number(last[0]?.sequence ?? 0);
	}
	async countAuditPrefix(before) {
		const table = CHAINED_TABLE;
		const { rows } = await this.db.query(`select count(*) as total from ${this.db.schema}.${table}`);
		const total = Number(rows[0]?.total ?? 0);
		const oldest = await this.oldest(table, "at");
		const cut = await this.prefixEnd(before);
		if (cut <= 0) return {
			table,
			total,
			eligible: 0,
			...oldest != null ? { oldest } : {}
		};
		const { rows: within } = await this.db.query(`select count(*) as total from ${this.db.schema}.${table} where sequence <= $1`, [cut]);
		return {
			table,
			total,
			eligible: Number(within[0]?.total ?? 0),
			...oldest != null ? { oldest } : {}
		};
	}
	async trimAuditPrefix(before, by) {
		const cut = await this.prefixEnd(before);
		if (cut <= 0) return { removed: 0 };
		const { rows: floorRows } = await this.db.query(`select sequence, digest from ${this.db.schema}.${CHAINED_TABLE} where sequence = $1`, [cut]);
		const floor = floorRows[0];
		if (floor == null) return { removed: 0 };
		await this.db.query(`insert into ${this.db.schema}.audit_floor (id, sequence, digest, trimmed_at, trimmed_by)
         values ($1, $2, $3, $4, $5)
         on conflict (id) do update set sequence = $2, digest = $3, trimmed_at = $4, trimmed_by = $5`, [
			1,
			Number(floor.sequence),
			floor.digest,
			/* @__PURE__ */ new Date(),
			by
		]);
		const { rows: counted } = await this.db.query(`select count(*) as total from ${this.db.schema}.${CHAINED_TABLE}`);
		const before_ = Number(counted[0]?.total ?? 0);
		await this.db.query(`delete from ${this.db.schema}.${CHAINED_TABLE} where sequence <= $1`, [cut]);
		const { rows: after } = await this.db.query(`select count(*) as total from ${this.db.schema}.${CHAINED_TABLE}`);
		return {
			removed: before_ - Number(after[0]?.total ?? 0),
			floor: Number(floor.sequence)
		};
	}
};
//#endregion
export { PostgresRetentionGateway, PostgresRetentionStore, and, where };
