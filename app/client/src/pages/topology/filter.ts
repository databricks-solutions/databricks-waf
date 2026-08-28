// What the canvas and the table show after the kind and relation toggles.
//
// An edge is kept when its relation is on and both ends' kinds are on. Nodes that then have
// no remaining edge drop out: 101e only emits a node that an edge named, so an isolated node
// here would be a filter artefact, not an estate object.

import type {
  TopologyEdge,
  TopologyKind,
  TopologyNode,
  TopologyPayload,
  TopologyRelation,
} from '../../../../shared/api/topology';
import { TOPOLOGY_KINDS, TOPOLOGY_RELATIONS } from '../../../../shared/api/topology';

export interface TopologyFilter {
  readonly kinds: ReadonlySet<TopologyKind>;
  readonly relations: ReadonlySet<TopologyRelation>;
}

export const ALL_KINDS: ReadonlySet<TopologyKind> = new Set(TOPOLOGY_KINDS);
export const ALL_RELATIONS: ReadonlySet<TopologyRelation> = new Set(TOPOLOGY_RELATIONS);

export function visibleGraph(
  graph: Pick<TopologyPayload, 'nodes' | 'edges'>,
  filter: TopologyFilter
): { readonly nodes: readonly TopologyNode[]; readonly edges: readonly TopologyEdge[] } {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter((edge) => {
    if (!filter.relations.has(edge.relation)) return false;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return source != null && target != null && filter.kinds.has(source.kind) && filter.kinds.has(target.kind);
  });
  const named = new Set(edges.flatMap((edge) => [edge.source, edge.target]));
  return {
    nodes: graph.nodes.filter((node) => named.has(node.id)),
    edges,
  };
}

export interface RelationshipFilter {
  /** When present, keep only exact joins that name this node. */
  readonly selectedId?: string;
  /** Matches resource names, kinds, technical ids, relation names and provenance. */
  readonly query: string;
}

/** The bounded list alternative may focus one resource without changing what the canvas draws. */
export function visibleRelationships(
  edges: readonly TopologyEdge[],
  nodes: readonly TopologyNode[],
  filter: RelationshipFilter
): readonly TopologyEdge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const query = filter.query.trim().toLocaleLowerCase();
  return edges.filter((edge) => {
    if (filter.selectedId != null && edge.source !== filter.selectedId && edge.target !== filter.selectedId) {
      return false;
    }
    if (query === '') return true;
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    return [
      edge.relation,
      edge.joinedBy,
      edge.source,
      edge.target,
      source?.kind,
      source?.label,
      source?.technicalId,
      target?.kind,
      target?.label,
      target?.technicalId,
    ].some((value) => value?.toLocaleLowerCase().includes(query) === true);
  });
}

export function toggleKind(kinds: ReadonlySet<TopologyKind>, kind: TopologyKind): ReadonlySet<TopologyKind> {
  return toggle(kinds, kind);
}

export function toggleRelation(
  relations: ReadonlySet<TopologyRelation>,
  relation: TopologyRelation
): ReadonlySet<TopologyRelation> {
  return toggle(relations, relation);
}

function toggle<T>(set: ReadonlySet<T>, value: T): ReadonlySet<T> {
  const next = new Set(set);
  if (next.has(value)) next.delete(value);
  else next.add(value);
  return next;
}
