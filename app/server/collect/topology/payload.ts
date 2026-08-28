// One topology response from the collected edges.
//
// 101b set the cap at 2,000 and left which 2,000 to this row. Newest
// `lastSeen` is the field the collectors already order by; "most connected"
// is a second pass nobody measured; "one relation first" would hide the
// smaller relations on the estate that set the cap. A sentence on the canvas
// may restate this field. It may not say the 2,000 are the most important.

import {
  TOPOLOGY_KINDS,
  TOPOLOGY_KIND_LABELS,
  TOPOLOGY_PAYLOAD_CAP,
  type TopologyEdge,
  type TopologyKind,
  type TopologyNames,
  type TopologyNode,
  type TopologyPayload,
} from '../../../shared/api/topology.js';

const KINDS = new Set<string>(TOPOLOGY_KINDS);

function kindOf(id: string): TopologyKind | undefined {
  const split = id.indexOf(':');
  if (split <= 0) return undefined;
  const kind = id.slice(0, split);
  return KINDS.has(kind) ? (kind as TopologyKind) : undefined;
}

function technicalIdOf(id: string): string {
  const split = id.indexOf(':');
  return split <= 0 ? id : id.slice(split + 1);
}

function newer(left: TopologyEdge, right: TopologyEdge): number {
  if (left.lastSeen !== right.lastSeen) return left.lastSeen < right.lastSeen ? 1 : -1;
  if (left.relation !== right.relation) return left.relation < right.relation ? -1 : 1;
  if (left.id !== right.id) return left.id < right.id ? -1 : 1;
  return 0;
}

function nodesOf(edges: readonly TopologyEdge[], names: TopologyNames): TopologyNode[] {
  const seen = new Map<string, TopologyNode>();
  for (const edge of edges) {
    for (const id of [edge.source, edge.target]) {
      if (seen.has(id)) continue;
      const kind = kindOf(id);
      if (kind == null) continue;
      const technicalId = technicalIdOf(id);
      const exactName = names[id];
      seen.set(id, {
        id,
        kind,
        label: exactName ?? (kind === 'table' ? technicalId : TOPOLOGY_KIND_LABELS[kind]),
        technicalId,
      });
    }
  }
  return [...seen.values()].sort((left, right) =>
    left.kind === right.kind ? left.id.localeCompare(right.id) : left.kind.localeCompare(right.kind)
  );
}

export function topologyPayload(edges: readonly TopologyEdge[], names: TopologyNames = {}): TopologyPayload {
  const ranked = [...edges].sort(newer);
  const kept = ranked.slice(0, TOPOLOGY_PAYLOAD_CAP);
  return {
    nodes: nodesOf(kept, names),
    edges: kept,
    cap: TOPOLOGY_PAYLOAD_CAP,
    truncated: ranked.length > TOPOLOGY_PAYLOAD_CAP,
  };
}
