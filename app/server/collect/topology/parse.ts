// Rows from a table-side topology statement, as TopologyEdge.
//
// The SQL returns source_id, target_id and last_seen. Kind, relation, joinedBy
// and the qualified node ids are this file's: a statement that named them would
// repeat four constants the TypeScript already owns, and a mismatch would draw
// a job as a table.

import type { TopologyEdge, TopologyKind, TopologyRelation } from '../../../shared/api/topology.js';
import { topologyNodeId } from '../../../shared/api/topology.js';
import { text, type Row } from '../sql/rows.js';

export interface TopologyPairSpec {
  readonly relation: TopologyRelation;
  readonly sourceKind: TopologyKind;
  readonly targetKind: TopologyKind;
  /** The table or join that produced the pair — the row, not a shared name. */
  readonly joinedBy: string;
}

export function parseTopologyEdges(spec: TopologyPairSpec, rows: readonly Row[]): TopologyEdge[] {
  const edges: TopologyEdge[] = [];
  for (const row of rows) {
    const rawSource = text(row, 'source_id');
    const rawTarget = text(row, 'target_id');
    const lastSeen = text(row, 'last_seen');
    if (rawSource == null || rawTarget == null || lastSeen == null) continue;

    const source = topologyNodeId(spec.sourceKind, rawSource);
    const target = topologyNodeId(spec.targetKind, rawTarget);
    edges.push({
      id: `${spec.relation}:${source}:${target}`,
      source,
      target,
      relation: spec.relation,
      joinedBy: spec.joinedBy,
      lastSeen,
    });
  }
  return edges;
}
