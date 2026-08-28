import { TOPOLOGY_KINDS, TOPOLOGY_KIND_LABELS, TOPOLOGY_PAYLOAD_CAP } from "../../shared/api/topology.js";
//#region server/collect/topology/payload.ts
const KINDS = new Set(TOPOLOGY_KINDS);
function kindOf(id) {
	const split = id.indexOf(":");
	if (split <= 0) return void 0;
	const kind = id.slice(0, split);
	return KINDS.has(kind) ? kind : void 0;
}
function technicalIdOf(id) {
	const split = id.indexOf(":");
	return split <= 0 ? id : id.slice(split + 1);
}
function newer(left, right) {
	if (left.lastSeen !== right.lastSeen) return left.lastSeen < right.lastSeen ? 1 : -1;
	if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1;
	if (left.id !== right.id) return left.id < right.id ? -1 : 1;
	return 0;
}
function nodesOf(edges, names) {
	const seen = /* @__PURE__ */ new Map();
	for (const edge of edges) for (const id of [edge.source, edge.target]) {
		if (seen.has(id)) continue;
		const kind = kindOf(id);
		if (kind == null) continue;
		const technicalId = technicalIdOf(id);
		const exactName = names[id];
		seen.set(id, {
			id,
			kind,
			label: exactName ?? (kind === "table" ? technicalId : TOPOLOGY_KIND_LABELS[kind]),
			technicalId
		});
	}
	return [...seen.values()].sort((left, right) => left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind));
}
function topologyPayload(edges, names = {}) {
	const ranked = [...edges].sort(newer);
	const kept = ranked.slice(0, TOPOLOGY_PAYLOAD_CAP);
	return {
		nodes: nodesOf(kept, names),
		edges: kept,
		cap: TOPOLOGY_PAYLOAD_CAP,
		truncated: ranked.length > TOPOLOGY_PAYLOAD_CAP
	};
}
//#endregion
export { topologyPayload };
