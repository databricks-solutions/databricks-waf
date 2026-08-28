import { describe, expect, it } from 'vitest';

import { TOPOLOGY_PAYLOAD_CAP, type TopologyEdge } from '../../../shared/api/topology.js';
import { topologyPayload } from './payload.js';

function edge(relation: TopologyEdge['relation'], source: string, target: string, lastSeen: string): TopologyEdge {
  return {
    id: `${relation}:${source}:${target}`,
    source,
    target,
    relation,
    joinedBy: 'test',
    lastSeen,
  };
}

describe('topologyPayload', () => {
  it('keeps every edge when the graph is under the cap, which is labs', () => {
    const edges = [
      edge('job-to-table', 'job:1', 'table:t', '2026-08-18T00:00:00.000Z'),
      edge('table-to-table', 'table:a', 'table:b', '2026-08-17T00:00:00.000Z'),
    ];
    const payload = topologyPayload(edges);

    expect(payload.truncated).toBe(false);
    expect(payload.edges).toHaveLength(2);
    expect(payload.cap).toBe(TOPOLOGY_PAYLOAD_CAP);
    expect(payload.nodes.map((node) => node.id)).toEqual(['job:1', 'table:a', 'table:b', 'table:t']);
  });

  it('keeps the newest lastSeen and says it truncated', () => {
    const edges = Array.from({ length: TOPOLOGY_PAYLOAD_CAP + 1 }, (_, index) =>
      edge(
        'job-to-table',
        `job:${String(index)}`,
        'table:t',
        new Date(Date.UTC(2026, 0, 1, 0, 0, 0, index)).toISOString()
      )
    );

    const payload = topologyPayload(edges);

    expect(payload.edges).toHaveLength(TOPOLOGY_PAYLOAD_CAP);
    expect(payload.truncated).toBe(true);
    expect(payload.edges[0]?.lastSeen >= (payload.edges.at(-1)?.lastSeen ?? '')).toBe(true);
    expect(payload.nodes.some((node) => node.id === `job:${String(TOPOLOGY_PAYLOAD_CAP)}`)).toBe(true);
    expect(payload.nodes.some((node) => node.id === 'job:0')).toBe(false);
  });

  it('uses an exact platform name first and retains the technical id separately', () => {
    const payload = topologyPayload(
      [edge('warehouse-to-table', 'warehouse:abc', 'table:main.default.t', '2026-08-18T00:00:00.000Z')],
      { 'warehouse:abc': 'Finance SQL' }
    );

    expect(payload.nodes).toEqual([
      { id: 'table:main.default.t', kind: 'table', label: 'main.default.t', technicalId: 'main.default.t' },
      { id: 'warehouse:abc', kind: 'warehouse', label: 'Finance SQL', technicalId: 'abc' },
    ]);
  });

  it('falls back to the resource kind rather than promoting an opaque id', () => {
    const payload = topologyPayload([
      edge('job-to-table', 'job:435343286234006', 'table:main.default.t', '2026-08-18T00:00:00.000Z'),
    ]);

    expect(payload.nodes.find((node) => node.kind === 'job')).toEqual({
      id: 'job:435343286234006',
      kind: 'job',
      label: 'Job',
      technicalId: '435343286234006',
    });
  });
});
