import { describe, expect, it } from 'vitest';
import type { TopologyEdge, TopologyNode } from '../../../../shared/api/topology';
import { COLUMN_X, KIND_COLUMN, mostConnectedNode, openingNode, placeNodes, ROW_Y } from './layout';

const node = (id: string, kind: TopologyNode['kind'], label = id): TopologyNode => ({
  id,
  kind,
  label,
  technicalId: id.slice(id.indexOf(':') + 1),
});
const edge = (id: string, source: string, target: string): TopologyEdge => ({
  id,
  source,
  target,
  relation: 'table-to-table',
  joinedBy: 'table_id',
  lastSeen: '2026-08-20T00:00:00.000Z',
});

describe('placeNodes', () => {
  it('puts each kind in a fixed column, cluster beside job and not between warehouse and table', () => {
    const placed = new Map(
      placeNodes([
        node('table:t', 'table'),
        node('warehouse:w', 'warehouse'),
        node('cluster:c', 'cluster'),
        node('job:j', 'job'),
        node('pipeline:p', 'pipeline'),
      ]).map((at) => [at.id, at])
    );

    expect(placed.get('pipeline:p')?.x).toBe(KIND_COLUMN.pipeline * COLUMN_X);
    expect(placed.get('job:j')?.x).toBe(KIND_COLUMN.job * COLUMN_X);
    expect(placed.get('cluster:c')?.x).toBe(KIND_COLUMN.cluster * COLUMN_X);
    expect(placed.get('warehouse:w')?.x).toBe(KIND_COLUMN.warehouse * COLUMN_X);
    expect(placed.get('table:t')?.x).toBe(KIND_COLUMN.table * COLUMN_X);

    expect(KIND_COLUMN.cluster).toBeGreaterThan(KIND_COLUMN.job);
    expect(KIND_COLUMN.cluster).toBeLessThan(KIND_COLUMN.warehouse);
    expect(KIND_COLUMN.warehouse).toBeLessThan(KIND_COLUMN.table);
  });

  it('orders rows in a column by id, and is stable across shuffles', () => {
    const nodes = [node('job:b', 'job'), node('job:a', 'job'), node('job:c', 'job')];
    const first = placeNodes(nodes);
    const second = placeNodes([...nodes].reverse());
    expect(first).toEqual(second);
    expect(first.map((at) => at.id)).toEqual(['job:a', 'job:b', 'job:c']);
    expect(first.map((at) => at.y)).toEqual([0, ROW_Y, ROW_Y * 2]);
  });

  it('opens a large graph on the highest-degree object without calling it causal or important', () => {
    const nodes = [node('table:a', 'table'), node('table:b', 'table'), node('table:c', 'table')];
    expect(
      mostConnectedNode(nodes, [edge('edge:1', 'table:a', 'table:b'), edge('edge:2', 'table:c', 'table:b')])?.id
    ).toBe('table:b');

    expect(mostConnectedNode([...nodes].reverse(), [])?.id).toBe('table:a');
  });

  it('opens on an exact selected resource before the graph hub', () => {
    const nodes = [node('table:a', 'table'), node('table:b', 'table'), node('table:c', 'table')];
    const edges = [edge('edge:1', 'table:a', 'table:b'), edge('edge:2', 'table:c', 'table:b')];

    expect(openingNode(nodes, edges, 'table:c')?.id).toBe('table:c');
    expect(openingNode(nodes, edges, 'table:missing')?.id).toBe('table:b');
  });
});
