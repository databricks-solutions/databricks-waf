// The seven drawn topology collectors. 101c landed the four that terminate in
// a table; 101d lands the three compute-side ones and records the skip.
//
// `pipeline → cluster` is not a missing file. It is one cluster per update —
// 22,061 edges from 69 pipelines — and 101b declined it. A statement here
// would draw an event log.
//
// Not the scan's SqlCollector. No control reads these edges. 101e is the caller.

import { sql } from '@databricks/appkit';
import {
  TOPOLOGY_COLLECTOR_CAP,
  TOPOLOGY_DECLINED,
  type TopologyEdge,
  type TopologyNames,
  type TopologyNode,
  type TopologyRelation,
} from '../../../shared/api/topology.js';
import { type SqlExecutor, type SqlParameters, rowsOf } from '../sql/collector.js';
import { FileQuerySource, type QuerySource } from '../sql/queries.js';
import { shippedConfigDirectory } from '../../shipped-config.js';
import { parseTopologyEdges, type TopologyPairSpec } from './parse.js';
import { TOPOLOGY_NAMES_QUERY, parseTopologyNames, topologyNameParameters } from './names.js';
import { topologyPayload } from './payload.js';

export const TABLE_SIDE_RELATIONS = [
  'table-to-table',
  'job-to-table',
  'pipeline-to-table',
  'warehouse-to-table',
] as const satisfies readonly TopologyRelation[];

export type TableSideRelation = (typeof TABLE_SIDE_RELATIONS)[number];

/**
 * One statement per table-side relation. The query name is the file under
 * `config/topology/`; the spec is what the parser adds that the SQL does not.
 */
export const TABLE_SIDE: Readonly<
  Record<TableSideRelation, { readonly query: string; readonly spec: TopologyPairSpec }>
> = {
  'table-to-table': {
    query: 'topology_table_to_table',
    spec: {
      relation: 'table-to-table',
      sourceKind: 'table',
      targetKind: 'table',
      joinedBy: 'system.access.table_lineage',
    },
  },
  'job-to-table': {
    query: 'topology_job_to_table',
    spec: {
      relation: 'job-to-table',
      sourceKind: 'job',
      targetKind: 'table',
      joinedBy: 'system.access.table_lineage',
    },
  },
  'pipeline-to-table': {
    query: 'topology_pipeline_to_table',
    spec: {
      relation: 'pipeline-to-table',
      sourceKind: 'pipeline',
      targetKind: 'table',
      joinedBy: 'system.access.table_lineage',
    },
  },
  'warehouse-to-table': {
    query: 'topology_warehouse_to_table',
    spec: {
      relation: 'warehouse-to-table',
      sourceKind: 'warehouse',
      targetKind: 'table',
      joinedBy: 'system.access.table_lineage ⋈ system.query.history',
    },
  },
};

export const COMPUTE_SIDE_RELATIONS = [
  'job-to-cluster',
  'job-to-warehouse',
  'job-to-job',
] as const satisfies readonly TopologyRelation[];

export type ComputeSideRelation = (typeof COMPUTE_SIDE_RELATIONS)[number];

/**
 * The fourth compute-side relation 101d was asked for, and the reason it has
 * no statement. Same sentence 101b recorded, so a missing file is not an omission.
 */
export const COMPUTE_SIDE_SKIPPED = {
  'pipeline-to-cluster': TOPOLOGY_DECLINED['pipeline-to-cluster'],
} as const;

export const COMPUTE_SIDE: Readonly<
  Record<ComputeSideRelation, { readonly query: string; readonly spec: TopologyPairSpec }>
> = {
  'job-to-cluster': {
    query: 'topology_job_to_cluster',
    spec: {
      relation: 'job-to-cluster',
      sourceKind: 'job',
      targetKind: 'cluster',
      joinedBy: 'system.lakeflow.job_task_run_timeline',
    },
  },
  'job-to-warehouse': {
    query: 'topology_job_to_warehouse',
    spec: {
      relation: 'job-to-warehouse',
      sourceKind: 'job',
      targetKind: 'warehouse',
      joinedBy: 'system.lakeflow.job_task_run_timeline',
    },
  },
  'job-to-job': {
    query: 'topology_job_to_job',
    spec: {
      relation: 'job-to-job',
      sourceKind: 'job',
      targetKind: 'job',
      joinedBy: 'system.lakeflow.job_run_timeline ⋈ system.lakeflow.job_task_run_timeline',
    },
  },
};

export const DRAWN = { ...TABLE_SIDE, ...COMPUTE_SIDE };

export function topologyQueryDirectory(moduleUrl = import.meta.url): string {
  return shippedConfigDirectory('topology', moduleUrl);
}

export interface TopologyCollectorOptions {
  readonly executor: SqlExecutor;
  readonly lookbackDays?: number;
  readonly workspaceId?: string;
  readonly queries?: QuerySource;
  readonly signal?: AbortSignal;
}

export interface CollectedTopology {
  readonly edges: readonly TopologyEdge[];
  readonly names: TopologyNames;
}

export function tableSideQueries(moduleUrl = import.meta.url): FileQuerySource {
  return new FileQuerySource(topologyQueryDirectory(moduleUrl));
}

function parameters(lookbackDays: number, workspaceId: string): SqlParameters {
  return {
    lookback_days: sql.int(lookbackDays),
    workspace_id: sql.string(workspaceId),
    topology_limit: sql.int(TOPOLOGY_COLLECTOR_CAP),
  };
}

/**
 * The four table-side relations, each one statement, concatenated.
 *
 * Sequential for the same reason the scan collector is: four lineage reads at
 * once queue behind each other on a shared warehouse. 101e can ask for one
 * relation if it only needs one.
 */
function collectors<R extends keyof typeof DRAWN>(options: TopologyCollectorOptions, relations: readonly R[]) {
  const queries = options.queries ?? tableSideQueries();
  const lookbackDays = options.lookbackDays ?? 30;
  const workspaceId = options.workspaceId ?? '';
  const bound = parameters(lookbackDays, workspaceId);

  const run = async (relation: R): Promise<TopologyEdge[]> => {
    const entry = DRAWN[relation];
    const rows = rowsOf(await options.executor(queries.text(entry.query), bound, options.signal));
    return parseTopologyEdges(entry.spec, rows);
  };

  return {
    parameters: bound,
    collect: async (relation: R) => run(relation),
    collectAll: async (): Promise<TopologyEdge[]> => {
      const edges: TopologyEdge[] = [];
      for (const relation of relations) {
        edges.push(...(await run(relation)));
      }
      return edges;
    },
  };
}

export function tableSideTopology(options: TopologyCollectorOptions) {
  return collectors(options, TABLE_SIDE_RELATIONS);
}

export function computeSideTopology(options: TopologyCollectorOptions) {
  return collectors(options, COMPUTE_SIDE_RELATIONS);
}

export function drawnTopology(options: TopologyCollectorOptions) {
  return collectors(options, [...TABLE_SIDE_RELATIONS, ...COMPUTE_SIDE_RELATIONS]);
}

export async function collectTopologyNames(
  options: TopologyCollectorOptions,
  nodes: readonly TopologyNode[]
): Promise<TopologyNames> {
  if (nodes.every((node) => node.kind === 'table')) return {};
  const queries = options.queries ?? tableSideQueries();
  const rows = rowsOf(
    await options.executor(
      queries.text(TOPOLOGY_NAMES_QUERY),
      topologyNameParameters(nodes, options.workspaceId ?? ''),
      options.signal
    )
  );
  return parseTopologyNames(rows);
}

/** The seven exact edge reads followed by one name read for nodes inside the response cap. */
export async function collectNamedTopology(options: TopologyCollectorOptions): Promise<CollectedTopology> {
  const edges = await drawnTopology(options).collectAll();
  const nodes = topologyPayload(edges).nodes;
  return { edges, names: await collectTopologyNames(options, nodes) };
}
