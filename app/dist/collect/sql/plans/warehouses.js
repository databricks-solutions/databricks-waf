//#region server/collect/sql/plans/warehouses.ts
/**
* Every warehouse id in the workspace the app runs in.
*
* Throws rather than returning an empty set when the list cannot be read. The two are not the same fact
* and the caller has to tell them apart: a workspace with no warehouses cannot have run any of the
* statements being nominated, whereas a workspace whose list was refused may have run all of them. Both
* end in fetching no plans, and only the second is worth telling the reader about.
*
* Still a throw now that the caller schedules it, and that is the point: the scheduler is what turns a
* raised error into a classified outcome, and a function that swallowed its own refusal would hand it an
* empty set indistinguishable from a workspace with no warehouses.
*/
async function localWarehouseIds(client) {
	const workspace = await client();
	const ids = /* @__PURE__ */ new Set();
	for await (const warehouse of workspace.warehouses.list({})) if (warehouse.id != null && warehouse.id !== "") ids.add(warehouse.id);
	return ids;
}
//#endregion
export { localWarehouseIds };
