//#region server/advise/stats-index.ts
const EMPTY = {
	for: () => void 0,
	size: 0
};
/**
* Indexes this run's table statistics.
*
* A table with two rows keeps the first, which the statement's `GROUP BY` makes unreachable — it aggregates
* to one row per table — so this is a tie-break nothing exercises rather than a choice. Overwriting instead
* would make which reading a rule saw depend on array order.
*/
function statsIndex(rows) {
	if (rows == null || rows.length === 0) return EMPTY;
	const byTable = /* @__PURE__ */ new Map();
	for (const row of rows) {
		const key = row.table.toLowerCase();
		if (!byTable.has(key)) byTable.set(key, row);
	}
	return {
		for: (table) => byTable.get(table.toLowerCase()),
		size: byTable.size
	};
}
/** The empty index, for a run whose statistics statement was unreadable and for every caller with none. */
function noStats() {
	return EMPTY;
}
//#endregion
export { noStats, statsIndex };
