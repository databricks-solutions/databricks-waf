//#region server/store/assessment-scope.ts
/**
* Adds a `definition_id` predicate to a where-fragment, leaving `order by` where it was.
*
* The fragment is what the stores already pass: `where id = $1`, `where month = $1 order by
* published_at asc`, or empty. Placeholders already in `values` keep their numbers; a scoped
* equality binds the next one.
*/
function applyScope(fragment, values, scope) {
	if (scope === void 0) return {
		fragment,
		values
	};
	const clause = scope === null ? "definition_id is null" : `definition_id = $${String(values.length + 1)}`;
	const extra = scope === null ? [] : [scope];
	const order = /\border by\b/i.exec(fragment);
	const before = (order == null ? fragment : fragment.slice(0, order.index)).trim();
	const after = order == null ? "" : fragment.slice(order.index);
	const where = before === "" ? `where ${clause}` : `${before} and ${clause}`;
	return {
		fragment: after === "" ? where : `${where} ${after}`,
		values: [...values, ...extra]
	};
}
/** Whether a stored key belongs to this read. Empty-string keys are the drafts' spelling of none. */
function inScope(definitionId, scope) {
	if (scope === void 0) return true;
	if (scope === null) return definitionId == null || definitionId === "";
	return definitionId === scope;
}
/**
* The assessment a write is under, stamped onto the record.
*
* `null` leaves it unnamed — an unstamped run, an answer given the same way. A string is that
* definition. The column is never guessed from another record.
*/
function stamped(record, scope) {
	return scope == null ? record : {
		...record,
		definitionId: scope
	};
}
//#endregion
export { applyScope, inScope, stamped };
