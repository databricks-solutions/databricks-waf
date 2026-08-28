/**
* Newest first, then by statement id.
*
* The second key is not decoration: two executions of one shape can carry the same `start_time` to the
* millisecond, and an order that stopped at the timestamp would decide which of the three to drop
* differently on each read. A trim has to be repeatable or it removes a different row every run.
*/
function newestFirst(left, right) {
	const byTime = right.observedAt.getTime() - left.observedAt.getTime();
	return byTime !== 0 ? byTime : right.statementId.localeCompare(left.statementId);
}
/**
* The two fields together, as a map key.
*
* One-way: what a caller needs the shape back for is grouping, and a map that holds the shape beside
* its plans has it already. Splitting the string again would need the separator to be a character
* neither field can hold — true of an id in every estate anyone has looked at, and worth nothing here,
* since a wrong split would trim a shape that was never written and leave the real one growing.
*/
function shapeKey(key) {
	return `${key.workspaceId}\u0000${key.shape}`;
}
/**
* This run's plans, grouped by the shape they belong to, so each shape is written and trimmed once.
*
* The shape is carried beside its plans rather than recovered from the map key: a group always has a plan
* to read it from, and reading it from there is one fewer thing that can be parsed wrongly.
*/
function byShape(plans) {
	const grouped = /* @__PURE__ */ new Map();
	for (const plan of plans) {
		const group = grouped.get(shapeKey(plan));
		if (group == null) grouped.set(shapeKey(plan), {
			key: plan,
			plans: [plan]
		});
		else group.plans.push(plan);
	}
	return grouped;
}
/**
* Either form of a timestamp, as a `Date`.
*
* Refuses one it cannot read rather than returning an invalid `Date`, because the ordering these feed is
* arithmetic on `getTime`: `NaN` compares as neither before nor after, so a single unparseable row would
* make `newestFirst` return 0 against everything and the trim would drop whichever row the sort happened
* to leave fourth.
*/
function when(value, column) {
	const at = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(at.getTime())) throw new Error(`plan_extracts.${column} is not a time this store can read: ${String(value)}`);
	return at;
}
var PostgresPlanExtractStore = class {
	db;
	durable = true;
	constructor(db) {
		this.db = db;
	}
	/**
	* Writes each shape's plans, cutting that shape back to three before moving to the next.
	*
	* Not in a transaction, which is a decision and the opposite of the one `resetting` makes in
	* `retention-store.ts`. That one refuses a handle without a session, because sixteen deletes half done
	* is lost data. Here the worst an interruption leaves is a shape holding a surplus row until the next
	* run, and the trim is idempotent — so requiring a session would mean declining to keep plans at all on
	* a handle that cannot open one, in exchange for a guarantee about an outcome that corrects itself.
	*
	* A shape at a time rather than every insert and then every trim, so that the surplus an interruption
	* can leave is bounded by the shape it stopped inside. Writing all of them first would mean a failure
	* anywhere left *every* shape untrimmed, since the trims had not started — and "until the next run"
	* only holds for the shapes that run again.
	*/
	async keep(plans) {
		for (const group of byShape(plans).values()) {
			for (const plan of group.plans) await this.db.query(`insert into ${this.db.schema}.plan_extracts
             (workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version, extract)
             values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
             on conflict (workspace_id, shape, statement_id) do update
               set advisory_id = $4, advisory_at = $5, observed_at = $6, shape_version = $7,
                   extract = $8::jsonb`, [
				plan.workspaceId,
				plan.shape,
				plan.statementId,
				plan.advisoryId,
				plan.advisoryAt.toISOString(),
				plan.observedAt.toISOString(),
				plan.shapeVersion,
				JSON.stringify(plan.extract)
			]);
			await this.trim(group.key);
		}
	}
	/**
	* Removes the surplus by reading the shape's rows and deleting the ones past the third.
	*
	* A window function would do this in one statement, and the reason it is two is that the surplus is
	* normally a single row — a run adds one execution of a shape and displaces one — so ranking a table to
	* delete a row whose key the previous statement already returned would be the more clever of the two
	* and not the cheaper one. The loop is a loop because that "normally" is not a guarantee: a caller can
	* hand over several executions of one shape, and an interrupted earlier run can leave one behind.
	*
	* Ordered here rather than in the `select`, so the row this drops is the row `forShape` would call
	* fourth. Two orderings over the same rows are two answers wherever they tie, and these tie whenever
	* two executions of a shape share a millisecond.
	*/
	async trim(key) {
		const { rows } = await this.db.query(`select statement_id, observed_at from ${this.db.schema}.plan_extracts
         where workspace_id = $1 and shape = $2`, [key.workspaceId, key.shape]);
		const ordered = rows.map((row) => ({
			statementId: row.statement_id,
			observedAt: when(row.observed_at, "observed_at")
		})).sort(newestFirst);
		for (const row of ordered.slice(3)) await this.db.query(`delete from ${this.db.schema}.plan_extracts
           where workspace_id = $1 and shape = $2 and statement_id = $3`, [
			key.workspaceId,
			key.shape,
			row.statementId
		]);
	}
	async forShape(key) {
		const { rows } = await this.db.query(`select workspace_id, shape, statement_id, advisory_id, advisory_at, observed_at, shape_version,
              extract
         from ${this.db.schema}.plan_extracts
         where workspace_id = $1 and shape = $2`, [key.workspaceId, key.shape]);
		return rows.map(revive).sort(newestFirst).slice(0, 3);
	}
};
function revive(row) {
	return {
		workspaceId: row.workspace_id,
		shape: row.shape,
		statementId: row.statement_id,
		advisoryId: row.advisory_id,
		advisoryAt: when(row.advisory_at, "advisory_at"),
		observedAt: when(row.observed_at, "observed_at"),
		shapeVersion: row.shape_version,
		extract: row.extract
	};
}
//#endregion
export { PostgresPlanExtractStore };
