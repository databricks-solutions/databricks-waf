import express, { type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';

import type { TopologyEdge, TopologyPayload } from '../../shared/api/topology.js';
import { closeServed, servedAt } from './test-servers.js';
import { registerTopologyRoutes } from './topology-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const EDGE: TopologyEdge = {
  id: 'job-to-table:job:1:table:t',
  source: 'job:1',
  target: 'table:t',
  relation: 'job-to-table',
  joinedBy: 'system.access.table_lineage',
  lastSeen: '2026-08-18T00:00:00.000Z',
};

async function listen(collect?: Parameters<typeof registerTopologyRoutes>[1]['collect']): Promise<string> {
  const app = express();
  registerTopologyRoutes(app, {
    ...(collect == null ? {} : { collect }),
    respondToFailure: (response: Response, cause: unknown) => {
      response.status(500).json({ error: 'failed', message: cause instanceof Error ? cause.message : 'failed' });
    },
  });
  return servedAt(app, servers);
}

describe('GET /api/topology', () => {
  it('returns the capped payload from the collected edges', async () => {
    const base = await listen(() => Promise.resolve({ edges: [EDGE], names: { 'job:1': 'Nightly finance' } }));
    const response = await fetch(`${base}/api/topology`);
    const body = (await response.json()) as TopologyPayload;

    expect(response.status).toBe(200);
    expect(body.truncated).toBe(false);
    expect(body.edges).toEqual([EDGE]);
    expect(body.nodes).toEqual([
      { id: 'job:1', kind: 'job', label: 'Nightly finance', technicalId: '1' },
      { id: 'table:t', kind: 'table', label: 't', technicalId: 't' },
    ]);
  });

  it('says the warehouse is missing rather than drawing an empty estate', async () => {
    const base = await listen();
    const response = await fetch(`${base}/api/topology`);
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe('topology-unavailable');
    expect(body.message).toMatch(/warehouse/i);
  });

  it('abandons the collector when the reader leaves the route', async () => {
    let started!: () => void;
    const collecting = new Promise<void>((resolve) => {
      started = resolve;
    });
    let abandoned!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      abandoned = resolve;
    });
    const base = await listen(
      (_request, signal) =>
        new Promise((_, reject) => {
          started();
          signal.addEventListener(
            'abort',
            () => {
              abandoned();
              reject(new Error('collection cancelled'));
            },
            { once: true }
          );
        })
    );
    const controller = new AbortController();
    const response = fetch(`${base}/api/topology`, { signal: controller.signal }).catch(() => undefined);

    await collecting;
    controller.abort();

    await expect(cancelled).resolves.toBeUndefined();
    await response;
  });
});
