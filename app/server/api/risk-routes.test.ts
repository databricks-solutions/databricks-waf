// Accepting a requirement being unmet, and ending that early.
//
// The record and its rules are tested in `accept/risk.test.ts`, and the store against the fake database
// in `accept/store.test.ts`. What is worth holding here is what only a route can get wrong.
//
// Three of those are why this file exists. An acceptance cannot be attributed to somebody else, so
// `recordedBy` comes from the gate and never from the body. The standing is computed on the server, so
// what the browser is told about an expiry does not depend on the browser's clock. And what a new
// acceptance supersedes is read from the record rather than named by the requester, because a chain of
// renewals the requester could write is a chain that can be pointed at somebody else's decision.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { AcceptedRiskPayload, RisksPayload } from '../../shared/api/contract.js';
import { recorded, riskFrom, type AcceptedRisk } from '../accept/risk.js';
import {
  AlreadyAcceptedError,
  InMemoryRiskStore,
  RisksUnreadableError,
  type RiskStore,
} from '../accept/store.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import type { Severity } from '../resolve/finding.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { registerRiskRoutes, type RiskControl } from './risk-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-04T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const CONTROLS: Readonly<Record<string, RiskControl>> = {
  'SEC-02-04': { title: 'Serverless egress is controlled', pillarId: 'security', severity: 'high' },
  'DG-01-01': { title: 'Every table has an owner', pillarId: 'data-governance', severity: 'medium' },
};

const IN_MEMORY = 'Accepted risks are being kept in memory on this installation and are lost on a restart.';

/** A body the domain accepts, so a test about a route is not also a test about the prose rules. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controlId: 'SEC-02-04',
    reason: 'The egress controls break the two vendor integrations finance runs the month end on.',
    compensatingControl:
      'Outbound traffic from the two workspaces is logged and reviewed weekly against an allow list.',
    residual: 'medium',
    owner: 'sam@example.com',
    // Well inside the 180 days a `high` requirement may be accepted for, and well outside the window
    // where the standing turns to `expiring`, so a test about a route is not a test about either edge.
    expiresAt: new Date(NOW.getTime() + 90 * DAY_MS).toISOString(),
    ...over,
  };
}

class Refused extends Error {}

/** A store whose reads fail, as the Postgres one behaves when the database is unreachable. */
class Unreadable extends InMemoryRiskStore {
  override for(controlId: string): Promise<readonly AcceptedRisk[]> {
    return Promise.reject(new RisksUnreadableError(`read accepted risks for ${controlId}`, new Error('reset')));
  }

  override all(): Promise<readonly AcceptedRisk[]> {
    return Promise.reject(new RisksUnreadableError('read accepted risks', new Error('reset')));
  }
}

/** A store that lost the write, as the database reports when another instance inserted first. */
class Racing extends InMemoryRiskStore {
  override record(risk: AcceptedRisk): Promise<void> {
    return Promise.reject(new AlreadyAcceptedError(risk.controlId));
  }
}

interface Harness {
  readonly base: string;
  readonly risks: RiskStore;
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly permit?: boolean;
    readonly existing?: readonly AcceptedRisk[];
    /** The store cannot be read, which is not the same answer as a requirement nobody has accepted. */
    readonly unreadable?: boolean;
    /** Somebody else records the same acceptance between this caller's read and its write. */
    readonly raceOnRecord?: boolean;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const risks = over.unreadable === true ? new Unreadable() : over.raceOnRecord === true ? new Racing() : new InMemoryRiskStore();
  for (const risk of over.existing ?? []) await risks.record(risk);

  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;

  registerRiskRoutes(app, {
    ...(over.omitStore === true ? {} : { risks }),
    riskStorage: IN_MEMORY,
    controlOf: (controlId) => CONTROLS[controlId],
    now: () => NOW,
    newId: () => `risk-${String((minted += 1))}`,
    // The real recorder over an in-memory log rather than a stub act, for the reason the sibling route
    // tests give: the routes are the only place the events are composed, so a fake act would leave
    // nothing checking that an acceptance is recorded against the requirement it is about.
    permitted: (
      _request: Request,
      response: Response,
      audited: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: 'priya@example.com',
            act: closedWhenAnswered(
              recorder.begin(
                audited,
                { actor: 'priya@example.com', executionMode: 'on-behalf-of-user' },
                context ?? {}
              ),
              response
            ),
          }),
    respondToFailure: (response: Response, cause: unknown) => {
      if (cause instanceof Refused) {
        response.status(403).json({ error: 'not-permitted', message: cause.message });
        return;
      }
      response.status(500).json({ error: 'unexpected', message: String(cause) });
    },
  });

  const base = await servedAt(app, servers);
  return { base, risks, audit };
}

async function send(base: string, path: string, sent?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(sent === undefined ? {} : { body: JSON.stringify(sent) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function read(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

/** Every act the routes recorded, oldest first, which is the order they happened in. */
async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id ?? event.reason] as const);
}

/**
 * An acceptance already on the record, dated relative to `NOW`.
 *
 * Composed through `riskFrom` rather than written as a literal, so a fixture cannot be a record the
 * routes would have refused — which is how a route test ends up proving something about data no caller
 * can produce.
 */
function accepted(
  over: {
    readonly days?: number;
    readonly controlId?: string;
    readonly id?: string;
    /** Minutes after `NOW`, for the tests that need two acceptances in a known order. */
    readonly recordedMinutesLater?: number;
    /** Which acceptance of the requirement this is, for the tests that record a renewal directly. */
    readonly ordinal?: number;
  } = {}
): AcceptedRisk {
  const draft = riskFrom(
    body({
      ...(over.controlId != null ? { controlId: over.controlId } : {}),
      expiresAt: new Date(NOW.getTime() + (over.days ?? 90) * DAY_MS).toISOString(),
    }),
    {
      knownControl: (id) => CONTROLS[id] != null,
      severityOf: (id) => CONTROLS[id]?.severity,
      now: NOW,
    }
  );
  const at = new Date(NOW.getTime() + (over.recordedMinutesLater ?? 0) * 60 * 1000);
  const one = recorded(draft, 'priya@example.com', over.id ?? 'risk-existing', at);
  return over.ordinal == null ? one : { ...one, ordinal: over.ordinal };
}

/** The same acceptance, with its expiry moved into the past. What a renewal follows. */
function lapsed(id: string): AcceptedRisk {
  return { ...accepted({ id }), expiresAt: new Date(NOW.getTime() - DAY_MS) };
}

describe('accepting a risk', () => {
  it('records it against the requirement, with the accepter taken from the gate', async () => {
    const harness = await serve();

    const { status, body: written } = await send(harness.base, '/api/risks', body({ recordedBy: 'someone@else.com' }));
    const risk = written as AcceptedRiskPayload;

    expect(status).toBe(201);
    expect(risk).toMatchObject({
      id: 'risk-1',
      controlId: 'SEC-02-04',
      owner: 'sam@example.com',
      residual: 'medium',
      // From the forwarded identity, never from the body: an acceptance attributable to a colleague is
      // the one thing this record could be used to manufacture.
      recordedBy: 'priya@example.com',
      recordedAt: NOW.toISOString(),
      standing: 'active',
      effective: true,
    });
    expect(risk.title).toBe('Serverless egress is controlled');
    expect(risk.severity).toBe('high');
  });

  it('records the act against the requirement, so one search answers what was accepted about it', async () => {
    const harness = await serve();

    await send(harness.base, '/api/risks', body());

    await expect(acts(harness.audit)).resolves.toEqual([['risk.accept', 'performed', 'SEC-02-04']]);
  });

  it('refuses one with no compensating control, and says what the field is for', async () => {
    const harness = await serve();

    const { status, body: refusal } = await send(harness.base, '/api/risks', body({ compensatingControl: 'n/a' }));

    expect(status).toBe(400);
    expect(refusal).toMatchObject({ error: 'invalid-risk' });
    expect((refusal as { message: string }).message).toContain('holding the line');
    await expect(harness.risks.all()).resolves.toEqual([]);
  });

  it('refuses an expiry further away than the requirement’s severity allows', async () => {
    const harness = await serve();
    const { acceptanceDays } = (await read(harness.base, '/api/risks')).body as RisksPayload;
    const beyond = new Date(NOW.getTime() + (acceptanceDays.high + 1) * DAY_MS);

    const { status, body: refusal } = await send(harness.base, '/api/risks', body({ expiresAt: beyond.toISOString() }));

    // The cap the payload advertises is the cap the route enforces, which is the whole point of sending
    // it: a form built from that table cannot offer a date this refuses.
    expect(status).toBe(400);
    expect(refusal).toMatchObject({ error: 'invalid-risk' });
  });

  it('refuses a second acceptance while one is in force, naming who owns the one that is', async () => {
    const harness = await serve({ existing: [accepted()] });

    const { status, body: refusal } = await send(harness.base, '/api/risks', body());

    expect(status).toBe(400);
    expect((refusal as { message: string }).message).toContain('sam@example.com');
    await expect(harness.risks.all()).resolves.toHaveLength(1);
  });

  it('names the acceptance it renews from the record, ignoring one the request names', async () => {
    // The previous one has expired, so a renewal is allowed. What it supersedes is not the requester's
    // to choose: a body naming somebody else's acceptance would write itself into their chain, and how
    // long an exposure has been carried is the one thing that chain is for.
    const harness = await serve({ existing: [lapsed('risk-old')] });

    const { status, body: written } = await send(
      harness.base,
      '/api/risks',
      body({ supersedes: 'somebody-elses-risk' })
    );

    expect(status).toBe(201);
    expect((written as AcceptedRiskPayload).supersedes).toBe('risk-old');
  });

  it('refuses to record one at all where nothing is keeping them', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body: refusal } = await send(harness.base, '/api/risks', body());

    expect(status).toBe(503);
    expect(refusal).toMatchObject({ error: 'risks-unavailable' });
  });

  it('refuses to write anything where the acceptances could not be read', async () => {
    // The failure this endpoint must not treat as an answer. "Nothing is accepted" is what an unreadable
    // read looks like, and acting on it writes a second acceptance over one that is standing.
    const harness = await serve({ unreadable: true });

    const { status, body: refusal } = await send(harness.base, '/api/risks', body());

    expect(status).toBe(503);
    expect(refusal).toMatchObject({ error: 'risks-unreadable' });
    await expect(acts(harness.audit)).resolves.toEqual([['risk.accept', 'failed', 'RisksUnreadableError']]);
  });

  it('says somebody else got there first rather than reporting a fault', async () => {
    // The window between the read and the write. Both callers see nothing standing and both compose the
    // first acceptance of the requirement; the store refuses the second, and this is the sentence the one
    // that lost is owed.
    const harness = await serve({ raceOnRecord: true });

    const { status, body: refusal } = await send(harness.base, '/api/risks', body());

    expect(status).toBe(409);
    expect(refusal).toMatchObject({ error: 'already-accepted' });
  });

  it('records the refusal when the gate turns the caller away', async () => {
    const harness = await serve({ permit: false });

    const { status } = await send(harness.base, '/api/risks', body());

    expect(status).toBe(403);
    await expect(harness.risks.all()).resolves.toEqual([]);
  });
});

describe('reading what has been accepted', () => {
  it('keeps a lapsed acceptance in the list rather than reading as a requirement never accepted', async () => {
    // The renewal is recorded a minute later, which is what makes the older one superseded rather than
    // merely expired — and both are on the wire, because an exposure carried for a second quarter is
    // not a fresh decision.
    const harness = await serve({ existing: [lapsed('risk-old')] });
    await harness.risks.record(accepted({ id: 'risk-new', ordinal: 2, recordedMinutesLater: 1 }));

    const { risks } = (await read(harness.base, '/api/risks')).body as RisksPayload;

    expect(risks.map((risk) => risk.id)).toEqual(['risk-new', 'risk-old']);
    expect(risks.map((risk) => risk.standing)).toEqual(['active', 'superseded']);
    expect(risks.map((risk) => risk.effective)).toEqual([true, false]);
  });

  it('reports an acceptance whose date has passed as expired, without anything having swept it', async () => {
    // Derived from the dates rather than stored, so an exposure does not stay off the queue because a
    // sweep did not run.
    const harness = await serve({ existing: [lapsed('risk-old')] });

    const { risks } = (await read(harness.base, '/api/risks')).body as RisksPayload;

    expect(risks[0]).toMatchObject({ standing: 'expired', effective: false });
  });

  it('reads the history of one requirement without the others in it', async () => {
    const harness = await serve({
      existing: [accepted({ id: 'risk-sec' }), accepted({ id: 'risk-dg', controlId: 'DG-01-01' })],
    });

    const { body: read_ } = await read(harness.base, '/api/risks/DG-01-01');
    const payload = read_ as RisksPayload;

    expect(payload.controlId).toBe('DG-01-01');
    expect(payload.risks.map((risk) => risk.id)).toEqual(['risk-dg']);
  });

  it('says the acceptances are not being kept rather than reading as an estate with none', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body: payload } = await read(harness.base, '/api/risks');

    expect(status).toBe(200);
    expect(payload).toMatchObject({ durable: false, durabilityNote: IN_MEMORY, risks: [] });
  });

  it('sends the cap per severity, so a form need not learn it one rejection at a time', async () => {
    const harness = await serve();

    const { acceptanceDays } = (await read(harness.base, '/api/risks')).body as RisksPayload;

    const severities: readonly Severity[] = ['critical', 'high', 'medium', 'low', 'informational'];
    for (const severity of severities) expect(acceptanceDays[severity]).toBeGreaterThan(0);
    expect(acceptanceDays.critical).toBeLessThanOrEqual(acceptanceDays.low);
  });
});

describe('revoking an acceptance', () => {
  it('keeps the record and marks it revoked, with the reason and who ended it', async () => {
    const harness = await serve({ existing: [accepted()] });

    const { status, body: written } = await send(harness.base, '/api/risks/risk-existing/revoke', {
      reason: 'The vendor integration was retired, so the egress exception buys nothing now.',
    });
    const risk = written as AcceptedRiskPayload;

    expect(status).toBe(200);
    expect(risk.standing).toBe('revoked');
    expect(risk.effective).toBe(false);
    expect(risk.revoked).toMatchObject({ by: 'priya@example.com', at: NOW.toISOString() });
    await expect(harness.risks.all()).resolves.toHaveLength(1);
  });

  it('refuses a revocation with no reason, because the requirement is back ahead of its date', async () => {
    const harness = await serve({ existing: [accepted()] });

    const { status, body: refusal } = await send(harness.base, '/api/risks/risk-existing/revoke', {});

    expect(status).toBe(400);
    expect(refusal).toMatchObject({ error: 'invalid-risk' });
    // Still standing: a refused revocation leaves the acceptance in force rather than half-ended.
    const { risks } = (await read(harness.base, '/api/risks')).body as RisksPayload;
    expect(risks[0]?.standing).toBe('active');
  });

  it('says which id it could not find rather than reporting a fault', async () => {
    const harness = await serve();

    const { status, body: refusal } = await send(harness.base, '/api/risks/nothing-like-it/revoke', {
      reason: 'The exposure was closed by the platform change that landed last week.',
    });

    expect(status).toBe(404);
    expect(refusal).toMatchObject({ error: 'unknown-risk' });
    await expect(acts(harness.audit)).resolves.toEqual([['risk.revoke', 'failed', 'unknown-risk']]);
  });

  it('refuses to rewrite a revocation that has already happened', async () => {
    const harness = await serve({ existing: [accepted()] });
    const why = 'The vendor integration was retired, so the egress exception buys nothing now.';
    await send(harness.base, '/api/risks/risk-existing/revoke', { reason: why });

    const { status, body: refusal } = await send(harness.base, '/api/risks/risk-existing/revoke', {
      reason: 'Revoking it again for a different stated reason.',
    });

    expect(status).toBe(400);
    expect((refusal as { message: string }).message).toContain('already been revoked');
  });

  it('does not return another assessment\'s acceptances', async () => {
    const harness = await serve({
      existing: [
        { ...accepted({ id: 'under-a' }), definitionId: 'def-a' },
        { ...accepted({ id: 'under-b' }), definitionId: 'def-b' },
      ],
    });

    const a = (await read(harness.base, '/api/risks?definitionId=def-a')).body as RisksPayload;
    const b = (await read(harness.base, '/api/risks?definitionId=def-b')).body as RisksPayload;
    const none = (await read(harness.base, '/api/risks')).body as RisksPayload;

    expect(a.risks.map((risk) => risk.id)).toEqual(['under-a']);
    expect(b.risks.map((risk) => risk.id)).toEqual(['under-b']);
    expect(none.risks).toEqual([]);
  });
});
