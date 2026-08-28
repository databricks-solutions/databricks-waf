import { describe, expect, it } from 'vitest';
import type { TopologyPayload } from '../../../shared/api/topology';
import type { Finding } from '../api/types';
import { findingResources, hasRelationshipContext, investigationFocus } from './investigation-focus';

const topology: TopologyPayload = {
  cap: 2_000,
  truncated: false,
  nodes: [
    { id: 'warehouse:wh-1', kind: 'warehouse', label: 'Shared name', technicalId: 'wh-1' },
    { id: 'warehouse:wh-2', kind: 'warehouse', label: 'Shared name', technicalId: 'wh-2' },
    { id: 'job:job-1', kind: 'job', label: 'Daily refresh', technicalId: 'job-1' },
    { id: 'table:table-1', kind: 'table', label: 'main.sales.orders', technicalId: 'main.sales.orders' },
    { id: 'job:unrelated', kind: 'job', label: 'Unrelated', technicalId: 'unrelated' },
  ],
  edges: [
    {
      id: 'uses-warehouse',
      source: 'job:job-1',
      target: 'warehouse:wh-2',
      relation: 'job-to-warehouse',
      joinedBy: 'system.compute.warehouse_events',
      lastSeen: '2026-08-21T00:00:00Z',
    },
    {
      id: 'unrelated-edge',
      source: 'job:unrelated',
      target: 'table:table-1',
      relation: 'job-to-table',
      joinedBy: 'system.access.table_lineage',
      lastSeen: '2026-08-21T00:00:00Z',
    },
  ],
};

function finding(items: NonNullable<Finding['evidence'][number]['at']>['items']): Finding {
  return {
    controlId: 'REL-03-02',
    pillarId: 'reliability',
    principleId: 'REL-03',
    title: 'Enable autoscaling for SQL warehouse',
    outcome: 'fail',
    severity: 'medium',
    coverage: { mode: 'complete', examined: 1, population: 1 },
    evidence: [
      {
        signal: 'sql:compute.warehouses',
        observed: 'One warehouse is fixed at one cluster',
        coverage: { mode: 'complete', examined: 1, population: 1 },
        collectedAt: '2026-08-21T00:00:00Z',
        at: { lead: 'Fixed at one cluster', items },
      },
    ],
  };
}

describe('a finding-led estate view', () => {
  it('uses the platform id in the Databricks deep link and keeps only one-hop relationship context', () => {
    const focus = investigationFocus(
      finding([
        {
          kind: 'warehouse',
          label: 'Shared name',
          url: 'https://dbc.example/sql/warehouses/wh-2?o=123',
        },
      ]),
      topology,
      () => true
    );

    expect([...focus.selectedNodeIds]).toEqual(['warehouse:wh-2']);
    expect(focus.nodes.map((node) => node.id)).toEqual(['warehouse:wh-2', 'job:job-1']);
    expect(focus.edges.map((edge) => edge.id)).toEqual(['uses-warehouse']);
    expect(hasRelationshipContext(focus)).toBe(true);
  });

  it('does not guess between duplicate names when no exact platform id is available', () => {
    const focus = investigationFocus(finding([{ kind: 'warehouse', label: 'Shared name' }]), topology, () => true);

    expect([...focus.selectedNodeIds]).toEqual([]);
    expect(focus.nodes).toEqual([]);
    expect(focus.edges).toEqual([]);
    expect(hasRelationshipContext(focus)).toBe(false);
  });

  it('does not treat a platform id that is only a substring of the URL as an exact match', () => {
    const focus = investigationFocus(
      finding([{ kind: 'warehouse', label: 'Shared name', url: 'https://dbc.example/sql/warehouses/wh-10' }]),
      topology,
      () => true
    );

    expect([...focus.selectedNodeIds]).toEqual([]);
  });

  it('does not attach an unavailable recorded URL to a same-named replacement', () => {
    const focus = investigationFocus(
      finding([{ kind: 'job', label: 'Daily refresh', url: 'https://dbc.example/jobs/job-old' }]),
      topology,
      () => false
    );

    expect([...focus.selectedNodeIds]).toEqual([]);
  });

  it('joins a Catalog Explorer path to the dotted table topology id', () => {
    const focus = investigationFocus(
      finding([
        {
          kind: 'table',
          label: 'main.sales.orders',
          url: 'https://dbc.example/explore/data/main/sales/orders?o=w1',
        },
      ]),
      topology,
      () => true
    );

    expect([...focus.selectedNodeIds]).toEqual(['table:table-1']);
  });

  it('deduplicates the exact resources the finding named', () => {
    const resource = { kind: 'job' as const, label: 'Daily refresh', url: 'https://dbc.example/jobs/job-1' };

    expect(findingResources(finding([resource, resource]))).toEqual([resource]);
  });
});
