//#region server/collect/sql/plans/retrievable.ts
/**
* Whether to call the plan endpoint for this execution, and why not where the answer is no.
*
* `null` means call. The order of the checks is the order of the questions: is there something to
* fetch, did it run somewhere with a plan, and is that somewhere one this workspace can ask about.
*
* `localWarehouseIds` is the workspace's own warehouse list. Empty is not "no restriction" — it skips
* everything, which is the safe direction: a caller that could not read the warehouse list has not
* established that any id is local, and spending the whole fetch to be told `404` is worse than
* spending none. Row 33m is where that set comes from and where a scan says so when it is empty.
*/
function skipReason(execution, localWarehouseIds) {
	if (execution.statementId == null || execution.statementId === "") return "no-statement";
	if ((execution.representativeComputeType ?? "").toUpperCase() !== "WAREHOUSE") return "not-warehouse-compute";
	const warehouseId = execution.representativeWarehouseId;
	if (warehouseId == null || warehouseId === "") return "no-warehouse-id";
	if (!localWarehouseIds.has(warehouseId)) return "warehouse-outside-workspace";
	return null;
}
/**
* Split nominated executions into the ones worth a call and the ones already answered.
*
* Generic over the row so this holds `QueryShapeRow`s and hands them back whole: the caller needs the
* shape it skipped, not a statement id it would then have to look back up.
*/
function planCandidates(executions, localWarehouseIds) {
	const fetch = [];
	const skipped = [];
	for (const shape of executions) {
		const reason = skipReason(shape, localWarehouseIds);
		if (reason == null) fetch.push(shape);
		else skipped.push({
			shape,
			reason
		});
	}
	return {
		fetch,
		skipped
	};
}
//#endregion
export { planCandidates, skipReason };
