// The part of the estate graph one framework finding can honestly put in front of a customer.
//
// Findings name resources through their evidence. Topology is collected independently, so a matching
// graph node adds relationship context but never turns a neighbour into an affected resource. This
// module keeps those two sets distinct: `resources` is what the finding named; `nodes` and `edges` are
// the exact one-hop topology around graph nodes that can be joined back to those resources.

import type { TopologyEdge, TopologyNode, TopologyPayload } from '../../../shared/api/topology';
import type { Finding, LocatedItem } from '../api/types';

export interface InvestigationFocus {
  readonly resources: readonly LocatedItem[];
  readonly nodes: readonly TopologyNode[];
  readonly edges: readonly TopologyEdge[];
  readonly selectedNodeIds: ReadonlySet<string>;
}

export function hasRelationshipContext(focus: InvestigationFocus): boolean {
  return focus.nodes.length > 0;
}

/** Resources the finding names, deduplicated without treating two resource kinds as one object. */
export function findingResources(finding: Finding): readonly LocatedItem[] {
  const resources = new Map<string, LocatedItem>();
  for (const evidence of finding.evidence) {
    for (const item of evidence.at?.items ?? []) {
      const key = [item.kind ?? '', item.url ?? '', item.in ?? '', item.label].join('\u0000');
      if (!resources.has(key)) resources.set(key, item);
    }
  }
  return [...resources.values()];
}

/**
 * The exact resource nodes plus their immediate relationship context.
 *
 * A platform id in a trusted Databricks URL is the strongest join. A human name is used only when it
 * identifies one node of that kind in this response; four warehouses called "Serverless Starter
 * Warehouse" are not silently collapsed into the one the finding meant.
 */
export function investigationFocus(
  finding: Finding,
  topology: TopologyPayload | undefined,
  canJoin: (resource: LocatedItem) => boolean
): InvestigationFocus {
  const resources = findingResources(finding);
  if (topology == null || resources.length === 0) {
    return { resources, nodes: [], edges: [], selectedNodeIds: new Set() };
  }

  const selectedNodeIds = new Set<string>();
  for (const item of resources) {
    if (item.url != null && !canJoin(item)) continue;
    const candidates = topology.nodes.filter((node) => item.kind == null || item.kind === node.kind);
    const byId = item.url == null ? [] : candidates.filter((node) => urlNames(item.url!, node.technicalId));
    if (byId.length === 1) {
      selectedNodeIds.add(byId[0].id);
      continue;
    }

    // A unique name can recover context only when the evidence had no exact destination. If a
    // recorded URL's platform id no longer matches, falling back to the name could attach a
    // same-named replacement and make the historical resource look current.
    const byName = item.url == null ? candidates.filter((node) => node.label === item.label) : [];
    if (byName.length === 1) {
      selectedNodeIds.add(byName[0].id);
    }
  }

  const edges = topology.edges.filter((edge) => selectedNodeIds.has(edge.source) || selectedNodeIds.has(edge.target));
  const contextNodeIds = new Set(selectedNodeIds);
  for (const edge of edges) {
    contextNodeIds.add(edge.source);
    contextNodeIds.add(edge.target);
  }
  const nodes = topology.nodes.filter((node) => contextNodeIds.has(node.id));

  return { resources, nodes, edges, selectedNodeIds };
}

function urlNames(url: string, technicalId: string): boolean {
  try {
    const parsed = new URL(url);
    const pathAndHash = `${parsed.pathname}/${parsed.hash.slice(1)}`;
    const segments = pathAndHash
      .split(/[/?#&=]/)
      .filter(Boolean)
      .map((segment) => decodeURIComponent(segment));
    const pathMatches = segments.some(
      (_, index) => segments.slice(index, index + technicalId.split('.').length).join('.') === technicalId
    );
    return pathMatches || [...parsed.searchParams.values()].includes(technicalId);
  } catch {
    return false;
  }
}
