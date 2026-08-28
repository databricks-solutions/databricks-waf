// Optional platform names for nodes that survived the response cap.
//
// The graph id remains the platform id qualified by kind. A name is display metadata, not identity:
// two latest rows with different names for the same kind/id are therefore omitted rather than one
// being selected arbitrarily. Tables need no resolver because their exact qualified name is the id.

import { sql } from '@databricks/appkit';

import {
  TOPOLOGY_KINDS,
  topologyNodeId,
  type TopologyKind,
  type TopologyNames,
  type TopologyNode,
} from '../../../shared/api/topology.js';
import { text, type Row } from '../sql/rows.js';

export const TOPOLOGY_NAMES_QUERY = 'topology_resource_names';

const KIND = new Set<string>(TOPOLOGY_KINDS.filter((kind) => kind !== 'table'));

export function topologyNameParameters(nodes: readonly TopologyNode[], workspaceId: string) {
  const ids: Record<Exclude<TopologyKind, 'table'>, string[]> = {
    job: [],
    cluster: [],
    warehouse: [],
    pipeline: [],
  };

  for (const node of nodes) {
    if (node.kind === 'table' || node.technicalId.includes(',')) continue;
    ids[node.kind].push(node.technicalId);
  }

  return {
    workspace_id: sql.string(workspaceId),
    job_ids: sql.string(ids.job.join(',')),
    cluster_ids: sql.string(ids.cluster.join(',')),
    warehouse_ids: sql.string(ids.warehouse.join(',')),
    pipeline_ids: sql.string(ids.pipeline.join(',')),
  };
}

export function parseTopologyNames(rows: readonly Row[]): TopologyNames {
  const names: Record<string, string> = {};
  for (const row of rows) {
    const kind = text(row, 'kind');
    const technicalId = text(row, 'technical_id');
    const name = text(row, 'name')?.trim();
    if (kind == null || !KIND.has(kind) || technicalId == null || name == null || name === '') continue;
    names[topologyNodeId(kind as Exclude<TopologyKind, 'table'>, technicalId)] = name;
  }
  return names;
}
