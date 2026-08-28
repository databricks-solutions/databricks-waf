// Reading the trail, over a real socket.
//
// The filters are the substance here rather than the listing. A trail whose query string is
// half-honoured is worse than one with no filters at all: the reader narrows to "everything Priya was
// refused", gets the whole log back, and reads it as the answer to the question they asked. So most
// of these tests are about a parameter being applied or the request being refused, and the two
// exhaustive ones — every declared action accepted, every outcome accepted — exist because the
// vocabulary is checked against a list and a list is what goes stale.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { AuditTrailPayload, AuditVerificationPayload } from '../../shared/api/contract.js';
import { AUDIT_ACTIONS, type AuditAction, type AuditEvent, type AuditOutcome } from '../audit/event.js';
import { InMemoryAuditLog, MAX_PAGE, type AuditLog } from '../store/audit-log.js';
import { registerAuditRoutes } from './audit-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const AT = new Date('2026-08-04T09:00:00Z');

function act(over: Partial<AuditEvent> & { readonly id: string }): AuditEvent {
  return {
    at: AT,
    actor: 'alice@example.com',
    executionMode: 'on-behalf-of-user',
    action: 'scan.start',
    outcome: 'performed',
    ...over,
  };
}

async function serve(over: { readonly audit?: AuditLog; readonly omitLog?: boolean } = {}): Promise<{
  readonly base: string;
  readonly audit: AuditLog;
}> {
  const app = express();
  const audit = over.audit ?? new InMemoryAuditLog();

  registerAuditRoutes(app, {
    ...(over.omitLog === true ? {} : { audit, durable: audit.durable }),
    respondToFailure: (response, cause) => {
      response.status(500).json({ error: 'unexpected', message: String(cause) });
    },
  });

  const base = await servedAt(app, servers);
  return { base, audit };
}

async function trail(base: string, query = ''): Promise<{ status: number; body: AuditTrailPayload }> {
  const response = await fetch(`${base}/api/audit${query}`);
  return { status: response.status, body: (await response.json()) as AuditTrailPayload };
}

describe('the trail', () => {
  let base: string;
  let audit: AuditLog;

  beforeEach(async () => {
    ({ base, audit } = await serve());
    await audit.append(act({ id: 'e1', actor: 'alice@example.com', action: 'scan.start' }));
    await audit.append(
      act({
        id: 'e2',
        actor: 'priya@example.com',
        action: 'decision.record',
        outcome: 'refused',
        reason: 'not-a-member',
        target: { kind: 'control', id: 'REL-01-01' },
      })
    );
    await audit.append(
      act({ id: 'e3', actor: 'alice@example.com', action: 'evidence.import', outcome: 'failed', reason: 'replayed' })
    );
  });

  it('answers newest first, since a trail is read from what just happened', async () => {
    const { body } = await trail(base);

    expect(body.events.map((event) => event.sequence)).toEqual([3, 2, 1]);
  });

  it('carries the reason on a refusal, because that is the row an auditor came for', async () => {
    const { body } = await trail(base);

    expect(body.events[1]).toMatchObject({
      actor: 'priya@example.com',
      action: 'decision.record',
      outcome: 'refused',
      reason: 'not-a-member',
      target: { kind: 'control', id: 'REL-01-01' },
    });
  });

  it('says nothing about a reason on an act that worked', async () => {
    const { body } = await trail(base);

    expect(body.events[2]).not.toHaveProperty('reason');
  });

  it('reports where the chain ends, which is the value a customer records elsewhere', async () => {
    const { body } = await trail(base);

    expect(body.head?.sequence).toBe(3);
    expect(body.head?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('reports the head as it is now rather than where the page stopped', async () => {
    const { body } = await trail(base, '?limit=1');

    // A reader pinning the trail needs the end of the chain. A reader paging needs `next`, and
    // conflating the two would have every page claim the log ends where that page does.
    expect(body.head?.sequence).toBe(3);
    expect(body.next).toBe(3);
  });

  it('narrows by actor', async () => {
    const { body } = await trail(base, '?actor=alice%40example.com');

    expect(body.events.map((event) => event.sequence)).toEqual([3, 1]);
  });

  it('narrows by outcome, so "who was turned away" is one question', async () => {
    const { body } = await trail(base, '?outcome=refused');

    expect(body.events.map((event) => event.actor)).toEqual(['priya@example.com']);
  });

  it('narrows by target, so a control carries its own history', async () => {
    const { body } = await trail(base, '?target=REL-01-01');

    expect(body.events.map((event) => event.sequence)).toEqual([2]);
  });

  it('offers the whole vocabulary rather than the values it happens to hold', async () => {
    const { body } = await trail(base);

    // "Nobody has ever been refused a definition change" is a result worth being able to ask for,
    // and a filter built from the distinct values present cannot express the question.
    expect(body.actions.map((one) => one.id)).toEqual([...AUDIT_ACTIONS]);
    expect(body.actions).toContainEqual({ id: 'definition.archive', phrase: 'archive an assessment' });
  });

  it('carries a phrase with each act, so no page has to keep its own copy of the vocabulary', async () => {
    const { body } = await trail(base);

    // The identifiers are what the app calls them. An auditor reading "scan.start" is reading source
    // code, so the words come from the one place that defines them and travel with the list.
    expect(body.actions.every((one) => one.phrase.length > 0)).toBe(true);
    expect(body.actions.find((one) => one.id === 'retention.sweep')?.phrase).toContain('retention period');
  });

  it('accepts every action it declares', async () => {
    for (const action of AUDIT_ACTIONS satisfies readonly AuditAction[]) {
      const { status } = await trail(base, `?action=${action}`);
      expect(status, action).toBe(200);
    }
  });

  it('accepts every outcome an act can have', async () => {
    for (const outcome of ['performed', 'refused', 'failed'] satisfies readonly AuditOutcome[]) {
      const { status } = await trail(base, `?outcome=${outcome}`);
      expect(status, outcome).toBe(200);
    }
  });

  it('pages backwards from a sequence rather than by offset', async () => {
    const { body } = await trail(base, '?before=3');

    expect(body.events.map((event) => event.sequence)).toEqual([2, 1]);
    expect(body).not.toHaveProperty('next');
  });

  it('clamps a limit past the cap rather than refusing it', async () => {
    // Asking for more than a page is asking for everything, and the answer to that is the largest
    // page and a cursor. A 400 here would make a caller guess the cap.
    const { status, body } = await trail(base, `?limit=${String(MAX_PAGE + 500)}`);

    expect(status).toBe(200);
    expect(body.events).toHaveLength(3);
  });
});

describe('a filter the trail cannot honour', () => {
  let base: string;

  beforeEach(async () => {
    ({ base } = await serve());
  });

  it('refuses an action it does not record, rather than serving the whole log', async () => {
    const { status, body } = await trail(base, '?action=scan.started');

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'bad-filter', parameter: 'action' });
    // Names the vocabulary, so the caller's next request is the right one.
    expect(JSON.stringify(body)).toContain('scan.start');
  });

  it('refuses an outcome that is not one', async () => {
    const { status, body } = await trail(base, '?outcome=denied');

    expect(status).toBe(400);
    expect(body).toMatchObject({ parameter: 'outcome' });
  });

  it('refuses a limit that is not a number, which would otherwise reach the store as NaN', async () => {
    const { status, body } = await trail(base, '?limit=lots');

    expect(status).toBe(400);
    expect(body).toMatchObject({ parameter: 'limit' });
  });

  it('refuses a cursor below the first sequence', async () => {
    const { status, body } = await trail(base, '?before=0');

    expect(status).toBe(400);
    expect(body).toMatchObject({ parameter: 'before' });
  });

  it('refuses a date it cannot read', async () => {
    const { status, body } = await trail(base, '?since=last%20tuesday');

    expect(status).toBe(400);
    expect(body).toMatchObject({ parameter: 'since' });
  });

  it('refuses a range that runs backwards rather than quietly swapping it', async () => {
    const { status, body } = await trail(base, '?since=2026-08-04T00:00:00Z&until=2026-08-01T00:00:00Z');

    expect(status).toBe(400);
    expect(body).toMatchObject({ parameter: 'since' });
  });

  it('treats an empty parameter as absent, since a cleared filter is what a form sends', async () => {
    const { status } = await trail(base, '?actor=&action=');

    expect(status).toBe(200);
  });
});

describe('when this install records nothing', () => {
  it('says so rather than serving an empty list', async () => {
    const { base } = await serve({ omitLog: true });

    const { status, body } = await trail(base);

    // An empty trail and no trail send a reader to opposite conclusions, and only one of them is
    // "nothing has happened here".
    expect(status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.durable).toBe(false);
    expect(body.unavailable).toContain('records no events');
  });

  it('still offers the vocabulary, so the page renders its filters', async () => {
    const { base } = await serve({ omitLog: true });

    const { body } = await trail(base);

    expect(body.actions.map((one) => one.id)).toEqual([...AUDIT_ACTIONS]);
  });

  it('verifies nothing rather than claiming an intact chain', async () => {
    const { base } = await serve({ omitLog: true });

    const response = await fetch(`${base}/api/audit/verification`);
    const body = (await response.json()) as AuditVerificationPayload;

    expect(body.checked).toBe(0);
    expect(body.means).toContain('no chain to verify');
  });
});

describe('verifying the trail', () => {
  it('reports what the result establishes rather than a boolean', async () => {
    const { base, audit } = await serve();
    await audit.append(act({ id: 'e1' }));

    const response = await fetch(`${base}/api/audit/verification`);
    const body = (await response.json()) as AuditVerificationPayload;

    expect(body).toMatchObject({ checked: 1, breaks: [] });
    expect(body.head?.sequence).toBe(1);
    // The sentence has to keep saying what the chain does *not* prove, since it is the one that ends
    // up quoted in a report.
    expect(body.means).toContain('does not establish');
  });

  it('fails loudly when the trail cannot be read, rather than reporting zero events', async () => {
    const unreadable: AuditLog = {
      durable: true,
      append: () => Promise.reject(new Error('the database is unreachable')),
      head: () => Promise.reject(new Error('the database is unreachable')),
      floor: () => Promise.resolve(undefined),
      search: () => Promise.reject(new Error('the database is unreachable')),
      verify: () => Promise.reject(new Error('the database is unreachable')),
    };
    const { base } = await serve({ audit: unreadable });

    const response = await fetch(`${base}/api/audit/verification`);

    expect(response.status).toBe(503);
    expect((await response.json()) as { message: string }).toMatchObject({
      error: 'verification-unavailable',
    });
  });

  it('reports a search failure rather than an empty trail', async () => {
    const unreadable: AuditLog = {
      durable: true,
      append: () => Promise.reject(new Error('the database is unreachable')),
      head: () => Promise.reject(new Error('the database is unreachable')),
      floor: () => Promise.resolve(undefined),
      search: () => Promise.reject(new Error('the database is unreachable')),
      verify: () => Promise.reject(new Error('the database is unreachable')),
    };
    const { base } = await serve({ audit: unreadable });

    const { status } = await trail(base);

    expect(status).toBe(500);
  });
});
