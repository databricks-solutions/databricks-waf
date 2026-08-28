import { rowsOf } from "../collect/sql/shapes.js";
//#region server/resolve/locate.ts
const asJob = (row) => ({
	kind: "job",
	id: row.jobId,
	workspaceId: row.workspaceId
});
const asCluster = (row) => ({
	kind: "cluster",
	id: row.clusterId,
	workspaceId: row.workspaceId
});
const asWarehouse = (row) => ({
	kind: "warehouse",
	id: row.warehouseId,
	workspaceId: row.workspaceId
});
/**
* Resolve estate objects to URLs, against the workspaces an account actually has.
*
* Returns undefined per object rather than throwing, and for every object when the directory
* is unreadable. A finding must still be produced when only its links are unavailable: an
* account that cannot read `workspaces_latest` gets prose instead of links, not an
* unmeasurable control.
*/
function linksIn(directory) {
	const listed = rowsOf(directory?.live);
	if (listed.length === 0) return () => void 0;
	const hosts = new Map(listed.map((workspace) => [workspace.workspaceId, workspace]));
	return (object) => {
		if (object.workspaceId == null || object.workspaceId === "") return void 0;
		const workspace = hosts.get(object.workspaceId);
		if (workspace == null) return void 0;
		return urlTo(object, workspace);
	};
}
function urlTo(object, workspace) {
	const base = (workspace.url ?? "").replace(/\/+$/, "");
	if (base === "") return void 0;
	const o = `o=${encodeURIComponent(workspace.workspaceId)}`;
	switch (object.kind) {
		case "job": return `${base}/?${o}#job/${encodeURIComponent(object.id)}`;
		case "cluster": return `${base}/compute/clusters/${encodeURIComponent(object.id)}?${o}`;
		case "warehouse": return `${base}/sql/warehouses/${encodeURIComponent(object.id)}?${o}`;
		case "pipeline": return `${base}/pipelines/${encodeURIComponent(object.id)}?${o}`;
		case "table": return tableUrl(base, object.id, o);
	}
}
/**
* Catalog Explorer addresses a table by its three parts.
*
* A name that does not split into exactly three gets no link: a two-part name is a Hive
* metastore table addressed differently, and a name containing a quoted dot cannot be split
* safely at all. Both are rare, and guessing at either would produce a link to the wrong table
* — worse than the prose the reader already has.
*/
function tableUrl(base, name, query) {
	const parts = name.split(".");
	if (parts.length !== 3 || parts.some((part) => part === "")) return void 0;
	return `${base}/explore/data/${parts.map((part) => encodeURIComponent(part)).join("/")}?${query}`;
}
//#endregion
export { asCluster, asJob, asWarehouse, linksIn };
