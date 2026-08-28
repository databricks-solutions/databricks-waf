import { describe, expect, it } from 'vitest';
import type { TopologyEdge, TopologyNode } from '../../../../shared/api/topology';
import { ALL_KINDS, ALL_RELATIONS, toggleKind, visibleGraph, visibleRelationships } from './filter';

const nodes: readonly TopologyNode[] = [
  { id: 'job:1', kind: 'job', label: 'nightly', technicalId: '1' },
  { id: 'cluster:9', kind: 'cluster', label: 'shared', technicalId: '9' },
  { id: 'table:t', kind: 'table', label: 't', technicalId: 't' },
];

const edges: readonly TopologyEdge[] = [
  {
    id: 'jc',
    source: 'job:1',
    target: 'cluster:9',
    relation: 'job-to-cluster',
    joinedBy: 'compute',
    lastSeen: '2026-08-18',
  },
  {
    id: 'jt',
    source: 'job:1',
    target: 'table:t',
    relation: 'job-to-table',
    joinedBy: 'system.access.table_lineage',
    lastSeen: '2026-08-18',
  },
];

describe('visibleGraph', () => {
  it('keeps every edge when every kind and relation is on', () => {
    expect(visibleGraph({ nodes, edges }, { kinds: ALL_KINDS, relations: ALL_RELATIONS }).edges).toHaveLength(2);
  });

  it('drops an edge whose relation is off, and the node that then has none', () => {
    const relations = new Set(ALL_RELATIONS);
    relations.delete('job-to-cluster');
    const shown = visibleGraph({ nodes, edges }, { kinds: ALL_KINDS, relations });
    expect(shown.edges.map((edge) => edge.id)).toEqual(['jt']);
    expect(shown.nodes.map((node) => node.id)).toEqual(['job:1', 'table:t']);
  });

  it('drops an edge when either end is an off kind', () => {
    const kinds = toggleKind(ALL_KINDS, 'cluster');
    const shown = visibleGraph({ nodes, edges }, { kinds, relations: ALL_RELATIONS });
    expect(shown.edges.map((edge) => edge.id)).toEqual(['jt']);
    expect(shown.nodes.some((node) => node.kind === 'cluster')).toBe(false);
  });
});

describe('visibleRelationships', () => {
  it('focuses the exact joins that name a selected resource', () => {
    expect(visibleRelationships(edges, nodes, { selectedId: 'cluster:9', query: '' }).map((edge) => edge.id)).toEqual([
      'jc',
    ]);
  });

  it('finds a relationship by human name, technical id and provenance', () => {
    expect(visibleRelationships(edges, nodes, { query: 'nightly' })).toHaveLength(2);
    expect(visibleRelationships(edges, nodes, { query: 'cluster:9' }).map((edge) => edge.id)).toEqual(['jc']);
    expect(visibleRelationships(edges, nodes, { query: 'table_lineage' }).map((edge) => edge.id)).toEqual(['jt']);
  });
});
