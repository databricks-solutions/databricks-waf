// The estate graph 101b decided, in one shape the collectors, the endpoint and the canvas share.
//
// A node exists only where a row exists and an edge only where one field joins two rows — never
// from a shared name, tag, workspace or bill. That is 32i's rule and 32h's measurement of it.
// The three probes 32h could read and this file does not export are declined in
// `TOPOLOGY_DECLINED`, with the reason, so a missing relation is not an omission.

export const TOPOLOGY_KINDS = ['job', 'cluster', 'warehouse', 'pipeline', 'table'] as const;

export type TopologyKind = (typeof TOPOLOGY_KINDS)[number];

/** Human type labels shared by the payload fallback, canvas and inspector. */
export const TOPOLOGY_KIND_LABELS: Readonly<Record<TopologyKind, string>> = {
  job: 'Job',
  cluster: 'Cluster',
  warehouse: 'SQL warehouse',
  pipeline: 'Pipeline',
  table: 'Table',
};

export const TOPOLOGY_RELATIONS = [
  'table-to-table',
  'job-to-table',
  'pipeline-to-table',
  'job-to-cluster',
  'job-to-warehouse',
  'warehouse-to-table',
  'job-to-job',
] as const;

export type TopologyRelation = (typeof TOPOLOGY_RELATIONS)[number];

/**
 * Why a 32h probe is not a drawn relation.
 *
 * `pipeline-to-cluster` is one cluster per update. `cluster-to-table` is zero on both
 * estates because the lineage-to-query-history join does not name a cluster.
 * `bill-derived-pairs` is the same job→cluster pair read from a bill, which 32i's rule
 * refuses.
 */
export const TOPOLOGY_DECLINED = {
  'pipeline-to-cluster': 'one cluster per update — an event log, not a relation',
  'cluster-to-table': 'zero edges on both estates; the join does not carry cluster',
  'bill-derived-pairs': "32i's rule declines an edge drawn from a bill",
} as const;

/**
 * Per-relation collector ceiling. The largest drawn relation on large-estate in seven
 * days is job→table at 8,510 edges; 10,000 is that reading with headroom. Each
 * collector declares `at most :parameter` rather than joining the uncapped pair
 * manifest H1a closed.
 */
export const TOPOLOGY_COLLECTOR_CAP = 10_000;

/**
 * Edges one topology response may carry. Measured at 428 KiB / 2,001 nodes in the
 * worst case (every edge a unique pair). labs' whole graph is 306 edges / 80 KiB
 * and is not truncated. The uncapped drawn graph on large-estate is 4.70 MiB.
 */
export const TOPOLOGY_PAYLOAD_CAP = 2_000;

export interface TopologyNode {
  readonly id: string;
  readonly kind: TopologyKind;
  /** Exact platform name when readable; otherwise the resource kind. */
  readonly label: string;
  /** The platform id without the kind prefix used to keep graph ids distinct. */
  readonly technicalId: string;
}

/** Exact names keyed by the kind-qualified graph node id. */
export type TopologyNames = Readonly<Record<string, string>>;

export interface TopologyEdge {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly relation: TopologyRelation;
  /** The table or join that produced the pair — the row, not a shared name. */
  readonly joinedBy: string;
  readonly lastSeen: string;
}

export interface TopologyPayload {
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly cap: typeof TOPOLOGY_PAYLOAD_CAP;
  readonly truncated: boolean;
}

export function topologyNodeId(kind: TopologyKind, raw: string): string {
  return `${kind}:${raw}`;
}
