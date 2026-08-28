import { text } from "../sql/rows.js";
import { TOPOLOGY_KINDS, topologyNodeId } from "../../shared/api/topology.js";
import { sql } from "@databricks/appkit";
//#region server/collect/topology/names.ts
const TOPOLOGY_NAMES_QUERY = "topology_resource_names";
const KIND = new Set(TOPOLOGY_KINDS.filter((kind) => kind !== "table"));
function topologyNameParameters(nodes, workspaceId) {
	const ids = {
		job: [],
		cluster: [],
		warehouse: [],
		pipeline: []
	};
	for (const node of nodes) {
		if (node.kind === "table" || node.technicalId.includes(",")) continue;
		ids[node.kind].push(node.technicalId);
	}
	return {
		workspace_id: sql.string(workspaceId),
		job_ids: sql.string(ids.job.join(",")),
		cluster_ids: sql.string(ids.cluster.join(",")),
		warehouse_ids: sql.string(ids.warehouse.join(",")),
		pipeline_ids: sql.string(ids.pipeline.join(","))
	};
}
function parseTopologyNames(rows) {
	const names = {};
	for (const row of rows) {
		const kind = text(row, "kind");
		const technicalId = text(row, "technical_id");
		const name = text(row, "name")?.trim();
		if (kind == null || !KIND.has(kind) || technicalId == null || name == null || name === "") continue;
		names[topologyNodeId(kind, technicalId)] = name;
	}
	return names;
}
//#endregion
export { TOPOLOGY_NAMES_QUERY, parseTopologyNames, topologyNameParameters };
