// Sentences the estate graph may print. Each restates a field; none predicts the estate.
//
// The payload is seven relations and a cap. A sentence that said the graph was lineage, that a
// cluster sat on a data path, or that the unread edges "are" the rest of the estate would be
// answering a question no field carries. 101b declined those three probes; the canvas does not
// put them back in prose.

import {
  TOPOLOGY_KIND_LABELS,
  type TopologyKind,
  type TopologyNode,
  type TopologyPayload,
  type TopologyRelation,
} from '../../../shared/api/topology';

export const KIND_LABEL: Readonly<Record<TopologyKind, string>> = TOPOLOGY_KIND_LABELS;

export const RELATION_LABEL: Readonly<Record<TopologyRelation, string>> = {
  'table-to-table': 'table → table',
  'job-to-table': 'job → table',
  'pipeline-to-table': 'pipeline → table',
  'job-to-cluster': 'job → cluster',
  'job-to-warehouse': 'job → warehouse',
  'warehouse-to-table': 'warehouse → table',
  'job-to-job': 'job → job',
};

/** Relations that join a job to the compute it ran on, not to a table. */
export const COMPUTE_RELATIONS = ['job-to-cluster', 'job-to-warehouse'] as const;

export function graphSentence(graph: Pick<TopologyPayload, 'nodes' | 'edges' | 'cap' | 'truncated'>): string {
  if (graph.edges.length === 0) {
    return 'The seven statements returned no edges in the last 30 days.';
  }
  const edges = countPhrase(graph.edges.length, 'edge', 'edges');
  const nodes = countPhrase(graph.nodes.length, 'node', 'nodes');
  const counted = `${edges} across ${nodes}.`;
  return graph.truncated ? `${counted} The response stopped at ${String(graph.cap)} edges.` : counted;
}

export function selectedSentence(label: string, kind: TopologyKind, edgeCount: number): string {
  return `${label} (${KIND_LABEL[kind]}). ${countPhrase(edgeCount, 'edge', 'edges')} in this response name it.`;
}

export function missingSelectionSentence(id: string): string {
  return `${id} is not in this response.`;
}

export function filteredSentence(): string {
  return 'No edge remains for the kinds and relations that are on.';
}

export function resourceAccessibleName(node: TopologyNode): string {
  return `${TOPOLOGY_KIND_LABELS[node.kind]}: ${node.label}. Databricks id ${node.technicalId}`;
}

function countPhrase(count: number, one: string, many: string): string {
  return `${String(count)} ${count === 1 ? one : many}`;
}
