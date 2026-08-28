// Column layout for the seven drawn relations. Deterministic: same ids, same coordinates.
//
// Columns are kind, left to right: pipeline, job, cluster, warehouse, table. Cluster sits
// next to job — that is the pair `job-to-cluster` names — and not between warehouse and
// table, so the drawing does not put a cluster on a data path the payload does not carry.
// Rows inside a column are sorted by id. No physics, no stored coordinates: 101e does not
// send them.

import type { TopologyEdge, TopologyKind, TopologyNode } from '../../../../shared/api/topology';

export const KIND_COLUMN: Readonly<Record<TopologyKind, number>> = {
  pipeline: 0,
  job: 1,
  cluster: 2,
  warehouse: 3,
  table: 4,
};

export const COLUMN_X = 320;
export const ROW_Y = 112;
export const NODE_WIDTH = 256;
export const NODE_HEIGHT = 88;

export interface PlacedNode {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The readable opening point for a graph too large to fit as labels.
 *
 * Fitting every node makes a large estate technically complete and visually useless: the labels
 * collapse to marks. The highest-degree object is a deterministic place to start because the
 * payload itself establishes those exact relationships. It does not claim that the object caused
 * a finding or that it is the most important object in the estate.
 */
export function mostConnectedNode(
  nodes: readonly TopologyNode[],
  edges: readonly TopologyEdge[]
): TopologyNode | undefined {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    if (degree.has(edge.source)) degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    if (degree.has(edge.target)) degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }

  return [...nodes].sort(
    (left, right) => (degree.get(right.id) ?? 0) - (degree.get(left.id) ?? 0) || left.id.localeCompare(right.id)
  )[0];
}

/** A deep-linked resource is the opening point; otherwise use the graph's deterministic hub. */
export function openingNode(
  nodes: readonly TopologyNode[],
  edges: readonly TopologyEdge[],
  selectedId?: string
): TopologyNode | undefined {
  if (selectedId != null) {
    const selected = nodes.find((node) => node.id === selectedId);
    if (selected != null) return selected;
  }
  return mostConnectedNode(nodes, edges);
}

export function placeNodes(nodes: readonly TopologyNode[]): readonly PlacedNode[] {
  const byKind = new Map<TopologyKind, TopologyNode[]>();
  for (const node of nodes) {
    const bucket = byKind.get(node.kind) ?? [];
    bucket.push(node);
    byKind.set(node.kind, bucket);
  }

  const placed: PlacedNode[] = [];
  for (const [kind, column] of byKind) {
    const ordered = [...column].sort((left, right) => left.id.localeCompare(right.id));
    ordered.forEach((node, index) => {
      placed.push({
        id: node.id,
        x: KIND_COLUMN[kind] * COLUMN_X,
        y: index * ROW_Y,
      });
    });
  }
  return placed.sort((left, right) => left.id.localeCompare(right.id));
}
