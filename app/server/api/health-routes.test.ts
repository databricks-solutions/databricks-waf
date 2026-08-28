// Serving what this install can reach.
//
// The model is tested in `health/health.test.ts`; what is worth holding here is the wire shape and the
// two things a route can get wrong that a model cannot. That the sources are composed per request,
// because a reading taken at boot and served an hour later is the overclaim the whole module is
// arranged to avoid. And that a reading nothing could take is still served, rather than omitted from
// the list — a page that renders three of four dependencies tells the reader everything is accounted
// for while saying nothing about the fourth.

import express, { type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { DiagnosticsPayload } from '../../shared/api/contract.js';
import type { HealthSources } from '../health/health.js';
import { registerHealthRoutes } from './health-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

async function serve(sourcesFor: (request: { readonly headers: NodeJS.Dict<string | string[]> }) => HealthSources) {
  const app = express();
  registerHealthRoutes(app, {
    sourcesFor,
    respondToFailure: (response: Response, cause: unknown) => {
      response.status(500).json({ error: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    },
  });
  const base = await servedAt(app, servers);
  return base;
}

async function read(base: string, headers: Readonly<Record<string, string>> = {}) {
  const response = await fetch(`${base}/api/diagnostics`, { headers });
  return { status: response.status, body: (await response.json()) as DiagnosticsPayload };
}

describe('the diagnostics endpoint', () => {
  it('serves a reading for every dependency, including the ones nothing could establish', async () => {
    const base = await serve(() => ({}));

    const { status, body } = await read(base);

    expect(status).toBe(200);
    expect(body.readings.map((one) => one.dependency)).toEqual(['warehouse', 'database', 'identity', 'audit-log']);
    // A list with three of four in it would read as everything being accounted for.
    expect(body.readings).toHaveLength(4);
  });

  it('sends dates as strings and keeps the observation date on an observed reading', async () => {
    const observed = new Date('2026-08-03T22:00:00.000Z');
    const base = await serve(() => ({
      now: () => new Date('2026-08-04T09:00:00.000Z'),
      warehouseId: 'wh-1',
      lastRun: { at: observed, statements: 4, refused: 0 },
    }));

    const warehouse = (await read(base)).body.readings.find((one) => one.dependency === 'warehouse');

    expect(warehouse?.provenance).toBe('observed');
    expect(warehouse?.at).toBe(observed.toISOString());
  });

  it('serves what could not be recorded as its own number, not only as prose', async () => {
    // The page shows it beside the trail; a caller that had to parse it out of a sentence would be a
    // caller that breaks when the sentence is reworded.
    const base = await serve(() => ({ unrecorded: 4 }));

    const { body } = await read(base);

    expect(body.unrecorded).toBe(4);
    expect(body.well).toBe(false);
  });

  it('composes the sources per request rather than once', async () => {
    // A reading taken at boot and served an hour later is the overclaim this exists to avoid.
    let taken = 0;
    const base = await serve(() => {
      taken += 1;
      return { unrecorded: taken - 1 };
    });

    expect((await read(base)).body.unrecorded).toBe(0);
    expect((await read(base)).body.unrecorded).toBe(1);
    expect(taken).toBe(2);
  });

  it('passes the request to the sources, so the identity probe can use the caller’s token', async () => {
    const seen: (string | string[] | undefined)[] = [];
    const base = await serve((request) => {
      seen.push(request.headers['x-forwarded-access-token']);
      return {};
    });

    await read(base, { 'x-forwarded-access-token': 'a-token' });

    expect(seen).toEqual(['a-token']);
  });

  it('reports rather than fails when a dependency is down', async () => {
    const base = await serve(() => ({
      pingDatabase: () => Promise.reject(new Error('connection refused')),
    }));

    const { status, body } = await read(base);

    expect(status).toBe(200);
    expect(body.well).toBe(false);
    expect(body.readings.find((one) => one.dependency === 'database')?.standing).toBe('silent');
  });

  it('fails loudly when composing the sources breaks, rather than reporting everything unknown', async () => {
    // Every probe is caught into its own reading, so reaching the responder means the composition
    // itself broke. A page of `unknown` would look like a diagnosis and be the absence of one.
    const base = await serve(() => {
      throw new Error('the store could not be read');
    });

    expect((await fetch(`${base}/api/diagnostics`)).status).toBe(500);
  });
});
