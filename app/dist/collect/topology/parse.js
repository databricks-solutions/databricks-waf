import { text } from "../sql/rows.js";
import { topologyNodeId } from "../../shared/api/topology.js";
//#region server/collect/topology/parse.ts
function parseTopologyEdges(spec, rows) {
	const edges = [];
	for (const row of rows) {
		const rawSource = text(row, "source_id");
		const rawTarget = text(row, "target_id");
		const lastSeen = text(row, "last_seen");
		if (rawSource == null || rawTarget == null || lastSeen == null) continue;
		const source = topologyNodeId(spec.sourceKind, rawSource);
		const target = topologyNodeId(spec.targetKind, rawTarget);
		edges.push({
			id: `${spec.relation}:${source}:${target}`,
			source,
			target,
			relation: spec.relation,
			joinedBy: spec.joinedBy,
			lastSeen
		});
	}
	return edges;
}
//#endregion
export { parseTopologyEdges };
