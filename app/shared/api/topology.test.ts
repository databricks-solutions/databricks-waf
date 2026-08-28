import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  TOPOLOGY_COLLECTOR_CAP,
  TOPOLOGY_DECLINED,
  TOPOLOGY_PAYLOAD_CAP,
  TOPOLOGY_RELATIONS,
  topologyNodeId,
} from './topology.js';

const recording = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../../scripts/recordings/topology-payload.json'), 'utf8'),
) as {
  fieldeng: {
    drawnEdges: number;
    largestRelation: { id: string; edges: number };
    byRelation: Record<string, { edges: number }>;
    declined: readonly { id: string }[];
    payload: { at: Record<string, { bytes: number }>; uncapped: { bytes: number } };
  };
  labs: { drawnEdges: number; payload: { uncapped: { bytes: number } } };
};

describe('the relations 101b draws', () => {
  it('are the relations the recording measured as drawn', () => {
    expect(Object.keys(recording.fieldeng.byRelation).sort()).toEqual([...TOPOLOGY_RELATIONS].sort());
  });

  it('declines the three 32h probes the recording kept out of that list', () => {
    expect(Object.keys(TOPOLOGY_DECLINED).sort()).toEqual(
      recording.fieldeng.declined.map((row: { id: string }) => row.id).sort(),
    );
  });
});

describe('the two caps', () => {
  it('holds the largest drawn relation on the extreme estate', () => {
    expect(recording.fieldeng.largestRelation).toEqual({ id: 'job-to-table', edges: 8510 });
    expect(TOPOLOGY_COLLECTOR_CAP).toBeGreaterThan(recording.fieldeng.largestRelation.edges);
  });

  it('keeps one response under 500 KiB on that estate', () => {
    expect(recording.fieldeng.payload.at['2000'].bytes).toBeLessThan(500 * 1024);
    expect(TOPOLOGY_PAYLOAD_CAP).toBe(2000);
  });

  it('does not truncate labs', () => {
    expect(recording.labs.drawnEdges).toBeLessThan(TOPOLOGY_PAYLOAD_CAP);
  });

  it('is why the uncapped drawn graph is not handed to a browser', () => {
    expect(recording.fieldeng.payload.uncapped.bytes).toBeGreaterThan(4 * 1024 * 1024);
  });
});

describe('node ids', () => {
  it('qualify the platform id with the kind, so a job 1 and a cluster 1 are not one node', () => {
    expect(topologyNodeId('job', '1')).toBe('job:1');
    expect(topologyNodeId('cluster', '1')).toBe('cluster:1');
  });
});
