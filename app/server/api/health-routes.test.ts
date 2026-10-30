// Serving what this install can reach.
//
// The model is tested in `health/health.test.ts`; what is worth holding here is the wire shape and the
// two things a route can get wrong that a model cannot. That the sources are composed per request,
// because a reading taken at boot and served an hour later is the overclaim the whole module is
// arranged to avoid. And that a reading nothing could take is still served, rather than omitted from
// the list — a page that renders three of four dependencies tells the reader everything is accounted
// for while saying nothing about the fourth.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { DiagnosticsPayload } from '../../shared/api/contract.js';
import type { HealthSources } from '../health/health.js';
import { registerHealthRoutes } from './health-routes.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog } from '../store/audit-log.js';
import { InMemoryAuditGapLog, type AuditGap, type AuditGapLog } from '../store/audit-gaps.js';

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

/*
 * The gaps the trail is missing, and acknowledging them.
 *
 * Served on the diagnostics read, which is ungated like the rest of it, and acknowledged through a
 * gated act: seeing that an event was lost needs nothing, and saying somebody has dealt with it is a
 * statement the way an answer or a decision is, so it is permitted, recorded and attributed.
 */
const GAP: AuditGap = {
  id: 'event-9',
  at: new Date('2026-08-03T11:30:00.000Z'),
  actor: 'dana@example.com',
  action: 'attestation.record',
  outcome: 'performed',
  target: { kind: 'control', id: 'OE-02-04' },
  cause: 'AuditAppendError',
};

class NotAnAssessor extends Error {
  readonly kind = 'not-a-member';
}

async function serveWithGaps(over: { readonly assessor?: boolean; readonly gaps?: AuditGapLog | null } = {}) {
  const gaps = over.gaps === null ? undefined : (over.gaps ?? new InMemoryAuditGapLog());
  const trail = new InMemoryAuditLog();
  const recorder = new AuditRecorder(trail);
  const WHO = { actor: 'priya@example.com', executionMode: 'on-behalf-of-user' } as const;

  const app = express();
  registerHealthRoutes(app, {
    sourcesFor: async () => {
      const found = gaps == null ? undefined : await gaps.unacknowledged();
      return found == null ? {} : { unrecorded: 0, auditGaps: found };
    },
    ...(gaps != null ? { gaps } : {}),
    // The real recorder over an in-memory log, for the reason the sibling route tests give: the route
    // is the only place the event is composed, so a stub act would leave nothing checking it.
    permitted: async (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) => {
      if (over.assessor === false) {
        await recorder.refused(action, WHO, 'not-a-member', context?.target);
        throw new NotAnAssessor('not an assessor');
      }
      return { actor: WHO.actor, act: closedWhenAnswered(recorder.begin(action, WHO, context ?? {}), response) };
    },
    respondToFailure: (response: Response, cause: unknown) => {
      if (cause instanceof NotAnAssessor) {
        response.status(403).json({ error: cause.kind, message: cause.message });
        return;
      }
      response.status(500).json({ error: 'failed', message: String(cause) });
    },
    now: () => new Date('2026-08-05T10:00:00.000Z'),
  });
  return { base: await servedAt(app, servers), gaps, trail };
}

async function acknowledge(base: string, id: string) {
  const response = await fetch(`${base}/api/diagnostics/audit-gaps/${id}/acknowledge`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the gaps on the diagnostics endpoint', () => {
  it('lists every unacknowledged gap with its act in words, dates as strings and no payload', async () => {
    const { base, gaps } = await serveWithGaps();
    await gaps?.record(GAP);

    const { body } = await read(base);

    expect(body.auditGaps).toEqual({
      gaps: [
        {
          id: 'event-9',
          at: '2026-08-03T11:30:00.000Z',
          actor: 'dana@example.com',
          action: 'attestation.record',
          // The vocabulary is the server's, so the page prints the same sentence the trail does.
          phrase: 'answer a requirement',
          outcome: 'performed',
          target: { kind: 'control', id: 'OE-02-04' },
          cause: 'AuditAppendError',
        },
      ],
      truncated: false,
    });
    expect(body.well).toBe(false);
  });

  it('is the same from whichever instance serves it, because it is read from the shared store', async () => {
    const shared = new InMemoryAuditGapLog();
    const one = await serveWithGaps({ gaps: shared });
    const other = await serveWithGaps({ gaps: shared });

    await shared.record(GAP);

    expect((await read(one.base)).body.auditGaps?.gaps.map((gap) => gap.id)).toEqual(['event-9']);
    expect((await read(other.base)).body.auditGaps?.gaps.map((gap) => gap.id)).toEqual(['event-9']);
  });

  it('carries no gaps field for an install that keeps no markers, rather than an empty list', async () => {
    const { base } = await serveWithGaps({ gaps: null });

    expect((await read(base)).body).not.toHaveProperty('auditGaps');
  });

  it('says the markers could not be read, rather than serving an empty list', async () => {
    const base = await serve(() => ({ unrecorded: 0, auditGapsUnreadable: 'the database did not answer' }));

    const { body } = await read(base);

    expect(body.auditGaps).toEqual({ gaps: [], truncated: false, unreadable: 'the database did not answer' });
    expect(body.well).toBe(false);
  });
});

describe('acknowledging a gap', () => {
  it('is recorded against the gap, by the person who acknowledged it', async () => {
    const { base, gaps, trail } = await serveWithGaps();
    await gaps?.record(GAP);

    const { status, body } = await acknowledge(base, 'event-9');

    expect(status).toBe(200);
    expect(body).toEqual({
      id: 'event-9',
      acknowledgedBy: 'priya@example.com',
      acknowledgedAt: '2026-08-05T10:00:00.000Z',
      already: false,
    });
    expect((await gaps?.unacknowledged())?.gaps).toEqual([]);
    // An audited act, so who dealt with a lost event is itself in the trail.
    expect((await trail.search()).events).toMatchObject([
      {
        action: 'gap.acknowledge',
        outcome: 'performed',
        actor: 'priya@example.com',
        target: { kind: 'audit-gap', id: 'event-9' },
      },
    ]);
  });

  it('clears the diagnostics once the last gap is acknowledged', async () => {
    const { base, gaps } = await serveWithGaps();
    await gaps?.record(GAP);
    await acknowledge(base, 'event-9');

    const { body } = await read(base);

    expect(body.auditGaps).toEqual({ gaps: [], truncated: false });
    expect(body.well).toBe(true);
  });

  it('is refused for somebody who may not change an assessment, and the gap stays', async () => {
    const { base, gaps, trail } = await serveWithGaps({ assessor: false });
    await gaps?.record(GAP);

    const { status, body } = await acknowledge(base, 'event-9');

    expect(status).toBe(403);
    expect(body.error).toBe('not-a-member');
    expect((await gaps?.unacknowledged())?.gaps).toHaveLength(1);
    // The refusal is recorded against the gap it was about, which is the event the gate exists to keep.
    expect((await trail.search()).events).toMatchObject([
      { action: 'gap.acknowledge', outcome: 'refused', reason: 'not-a-member', target: { kind: 'audit-gap', id: 'event-9' } },
    ]);
  });

  it('answers a gap nobody recorded as unknown, and records the attempt as failed', async () => {
    const { base, trail } = await serveWithGaps();

    const { status, body } = await acknowledge(base, 'no-such-gap');

    expect(status).toBe(404);
    expect(body.error).toBe('unknown-gap');
    expect((await trail.search()).events).toMatchObject([
      { action: 'gap.acknowledge', outcome: 'failed', reason: 'unknown-gap', target: { kind: 'audit-gap', id: 'no-such-gap' } },
    ]);
  });

  it('answers a second acknowledgement with the first, and does not claim to have done it again', async () => {
    const { base, gaps } = await serveWithGaps();
    await gaps?.record(GAP);
    await acknowledge(base, 'event-9');

    const { status, body } = await acknowledge(base, 'event-9');

    expect(status).toBe(200);
    expect(body).toMatchObject({ id: 'event-9', acknowledgedBy: 'priya@example.com', already: true });
  });

  it('writes one acknowledgement event for a gap acknowledged twice', async () => {
    const { base, gaps, trail } = await serveWithGaps();
    await gaps?.record(GAP);
    await acknowledge(base, 'event-9');
    await acknowledge(base, 'event-9');
    // The event for the second request, if there were one, is written when its response closes.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect((await trail.search()).events).toMatchObject([
      { action: 'gap.acknowledge', outcome: 'performed', target: { kind: 'audit-gap', id: 'event-9' } },
    ]);
  });

  it('says there is nowhere to acknowledge on an install that keeps no markers', async () => {
    const { base } = await serveWithGaps({ gaps: null });

    const { status, body } = await acknowledge(base, 'event-9');

    expect(status).toBe(503);
    expect(body.error).toBe('audit-gaps-unavailable');
  });
});
