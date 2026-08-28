// Taking a requirement out of the customer's own score, and putting it back.
//
// The record and its rules are tested in `apply/applicability.test.ts`, and the store against the fake
// database in `apply/store.test.ts`. What is worth holding here is what only a route can get wrong: the
// decision cannot be attributed to somebody else, the standing is computed on the server, what a renewal
// supersedes comes from the record — and the reading the refusal judges is the latest scan's, resolved
// here because only here can it be read.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import { recorded, applicabilityFrom, type ApplicabilityDecision } from '../apply/applicability.js';
import {
  AlreadyDecidedError,
  DecisionsUnreadableError,
  InMemoryApplicabilityStore,
  type ApplicabilityStore,
} from '../apply/store.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import type { Outcome, Severity } from '../resolve/finding.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { registerApplicabilityRoutes, type ApplicabilityControl } from './applicability-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-04T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const CONTROLS: Readonly<Record<string, ApplicabilityControl>> = {
  'SEC-02-04': { title: 'Serverless egress is controlled', pillarId: 'security', severity: 'high' },
  'DG-01-01': { title: 'Every table has an owner', pillarId: 'data-governance', severity: 'medium' },
};

interface DecisionPayload {
  readonly id: string;
  readonly controlId: string;
  readonly lever: string;
  readonly owner: string;
  readonly recordedBy: string;
  readonly standing: string;
  readonly effective: boolean;
  readonly supersedes?: string;
  readonly title?: string;
  readonly severity?: Severity;
}

interface DecisionsPayload {
  readonly decisions: readonly DecisionPayload[];
  readonly controlId?: string;
  readonly durable: boolean;
  readonly durabilityNote?: string;
}

/** A body the domain accepts, so a test about a route is not also a test about the prose rules. */
function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    controlId: 'SEC-02-04',
    lever: 'not-applicable',
    reason: 'This estate runs no serverless egress, so the requirement is about a thing it does not have.',
    owner: 'sam@example.com',
    expiresAt: new Date(NOW.getTime() + 90 * DAY_MS).toISOString(),
    ...over,
  };
}

class Refused extends Error {}

class Unreadable extends InMemoryApplicabilityStore {
  override for(controlId: string): Promise<readonly ApplicabilityDecision[]> {
    return Promise.reject(new DecisionsUnreadableError(`read applicability decisions for ${controlId}`, new Error('reset')));
  }

  override all(): Promise<readonly ApplicabilityDecision[]> {
    return Promise.reject(new DecisionsUnreadableError('read applicability decisions', new Error('reset')));
  }
}

class Racing extends InMemoryApplicabilityStore {
  override record(decision: ApplicabilityDecision): Promise<void> {
    return Promise.reject(new AlreadyDecidedError(decision.controlId));
  }
}

interface Harness {
  readonly base: string;
  readonly applicability: ApplicabilityStore;
  readonly audit: AuditLog;
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly permit?: boolean;
    readonly existing?: readonly ApplicabilityDecision[];
    readonly unreadable?: boolean;
    readonly raceOnRecord?: boolean;
    /** The reading the requirement reads, which is what the refusal judges. Undefined means unmeasured. */
    readonly reading?: Outcome;
    /** False puts the reading on a run before the most recent one, which has no finding for it. */
    readonly readingIsLatest?: boolean;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const applicability =
    over.unreadable === true ? new Unreadable() : over.raceOnRecord === true ? new Racing() : new InMemoryApplicabilityStore();
  for (const decision of over.existing ?? []) await applicability.record(decision);

  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;

  registerApplicabilityRoutes(app, {
    ...(over.omitStore === true ? {} : { applicability }),
    controlOf: (controlId) => CONTROLS[controlId],
    readingOf: () =>
      Promise.resolve(
        over.reading == null ? undefined : { outcome: over.reading, latest: over.readingIsLatest ?? true }
      ),
    now: () => NOW,
    newId: () => `decision-${String((minted += 1))}`,
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
              recorder.begin(audited, { actor: 'priya@example.com', executionMode: 'on-behalf-of-user' }, context ?? {}),
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
  return { base, applicability, audit };
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

async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id ?? event.reason] as const);
}

function decided(
  over: { readonly controlId?: string; readonly id?: string; readonly recordedMinutesLater?: number; readonly ordinal?: number } = {}
): ApplicabilityDecision {
  const draft = applicabilityFrom(
    body({ ...(over.controlId != null ? { controlId: over.controlId } : {}) }),
    {
      knownControl: (id) => CONTROLS[id] != null,
      severityOf: (id) => CONTROLS[id]?.severity,
      reading: () => undefined,
      now: NOW,
    }
  );
  const at = new Date(NOW.getTime() + (over.recordedMinutesLater ?? 0) * 60 * 1000);
  const one = recorded(draft, 'priya@example.com', over.id ?? 'decision-existing', at);
  return over.ordinal == null ? one : { ...one, ordinal: over.ordinal };
}

/** The same decision, with its expiry moved into the past. What a renewal follows. */
function lapsed(id: string): ApplicabilityDecision {
  return { ...decided({ id }), expiresAt: new Date(NOW.getTime() - DAY_MS) };
}

describe('recording an applicability decision', () => {
  it('records it against the requirement, with the decider taken from the gate', async () => {
    const harness = await serve();

    const { status, body: written } = await send(harness.base, '/api/applicability', body({ recordedBy: 'someone@else.com' }));
    const decision = written as DecisionPayload;

    expect(status).toBe(201);
    expect(decision).toMatchObject({
      id: 'decision-1',
      controlId: 'SEC-02-04',
      lever: 'not-applicable',
      owner: 'sam@example.com',
      recordedBy: 'priya@example.com',
      standing: 'active',
      effective: true,
    });
    expect(decision.title).toBe('Serverless egress is controlled');
  });

  it('records the act against the requirement, so one search answers what was excluded about it', async () => {
    const harness = await serve();

    await send(harness.base, '/api/applicability', body());

    await expect(acts(harness.audit)).resolves.toEqual([['applicability.record', 'performed', 'SEC-02-04']]);
  });

  it('refuses either lever against a failing reading, and keeps nothing', async () => {
    for (const lever of ['not-applicable', 'disabled']) {
      const harness = await serve({ reading: 'fail' });

      const { status, body: refusal } = await send(harness.base, '/api/applicability', body({ lever }));

      expect(status).toBe(400);
      expect(refusal).toMatchObject({ error: 'invalid-applicability' });
      expect((refusal as { message: string }).message).toContain('has been judged unmet');
      await expect(harness.applicability.all()).resolves.toEqual([]);
    }
  });

  it('refuses a term past what the same requirement could be accepted for, and keeps nothing', async () => {
    const harness = await serve({ reading: undefined });
    const beyond = new Date(NOW.getTime() + 400 * DAY_MS).toISOString();

    const { status, body: refusal } = await send(harness.base, '/api/applicability', body({ expiresAt: beyond }));

    expect(status).toBe(400);
    // SEC-02-04 is high, so 180 days. The severity reaches the rule through the route's catalogue read.
    expect((refusal as { message: string }).message).toContain('at most 180 days');
    await expect(harness.applicability.all()).resolves.toEqual([]);
  });

  it('refuses either lever against a partial reading', async () => {
    const harness = await serve({ reading: 'partial' });

    const { status } = await send(harness.base, '/api/applicability', body({ lever: 'disabled' }));

    expect(status).toBe(400);
  });

  it('allows a decision where the requirement was not measured — the case the lever is for', async () => {
    // No reading (undefined): a customer with no serverless egress excluding the requirement.
    const harness = await serve({ reading: undefined });

    const { status } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(201);
  });

  it('allows a decision against a passing reading', async () => {
    const harness = await serve({ reading: 'pass' });

    const { status } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(201);
  });

  it('refuses a second decision while one is in force, naming who owns the one that is', async () => {
    const harness = await serve({ existing: [decided()] });

    const { status, body: refusal } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(400);
    expect((refusal as { message: string }).message).toContain('sam@example.com');
    await expect(harness.applicability.all()).resolves.toHaveLength(1);
  });

  it('names the decision it renews from the record, ignoring one the request names', async () => {
    const harness = await serve({ existing: [lapsed('decision-old')] });

    const { status, body: written } = await send(
      harness.base,
      '/api/applicability',
      body({ supersedes: 'somebody-elses-decision' })
    );

    expect(status).toBe(201);
    expect((written as DecisionPayload).supersedes).toBe('decision-old');
  });

  it('refuses to record one at all where nothing is keeping them', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body: refusal } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(503);
    expect(refusal).toMatchObject({ error: 'applicability-unavailable' });
  });

  it('refuses to write anything where the decisions could not be read', async () => {
    const harness = await serve({ unreadable: true });

    const { status, body: refusal } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(503);
    expect(refusal).toMatchObject({ error: 'applicability-unreadable' });
    await expect(acts(harness.audit)).resolves.toEqual([['applicability.record', 'failed', 'DecisionsUnreadableError']]);
  });

  it('says somebody else got there first rather than reporting a fault', async () => {
    const harness = await serve({ raceOnRecord: true });

    const { status, body: refusal } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(409);
    expect(refusal).toMatchObject({ error: 'already-decided' });
  });

  it('records the refusal when the gate turns the caller away', async () => {
    const harness = await serve({ permit: false });

    const { status } = await send(harness.base, '/api/applicability', body());

    expect(status).toBe(403);
    await expect(harness.applicability.all()).resolves.toEqual([]);
  });
});

describe('reading what has been excluded', () => {
  it('keeps a superseded decision in the list rather than reading as never excluded', async () => {
    const harness = await serve({ existing: [lapsed('decision-old')] });
    await harness.applicability.record(decided({ id: 'decision-new', ordinal: 2, recordedMinutesLater: 1 }));

    const { decisions } = (await read(harness.base, '/api/applicability')).body as DecisionsPayload;

    expect(decisions.map((one) => one.id)).toEqual(['decision-new', 'decision-old']);
    expect(decisions.map((one) => one.standing)).toEqual(['active', 'superseded']);
  });

  it('reports a decision whose date has passed as expired, without anything having swept it', async () => {
    const harness = await serve({ existing: [lapsed('decision-old')] });

    const { decisions } = (await read(harness.base, '/api/applicability')).body as DecisionsPayload;

    expect(decisions[0]).toMatchObject({ standing: 'expired', effective: false });
  });

  it('reports a decision the reading has set aside as lapsed rather than as holding', async () => {
    // The register's one job is to say what is in force. Computed from the dates alone it said a
    // decision was active and effective while the score it is read beside had already put the
    // requirement back — the two disagreeing about exactly the thing the register is for.
    const harness = await serve({ existing: [decided()], reading: 'fail' });

    const { decisions } = (await read(harness.base, '/api/applicability')).body as DecisionsPayload;

    expect(decisions[0]).toMatchObject({ standing: 'lapsed', effective: false });
  });

  it('still reads a decision by its dates where nothing has measured the requirement', async () => {
    const harness = await serve({ existing: [decided()], reading: undefined });

    const { decisions } = (await read(harness.base, '/api/applicability')).body as DecisionsPayload;

    expect(decisions[0]).toMatchObject({ standing: 'active', effective: true });
  });

  it('reads the history of one requirement without the others in it', async () => {
    const harness = await serve({
      existing: [decided({ id: 'decision-sec' }), decided({ id: 'decision-dg', controlId: 'DG-01-01' })],
    });

    const payload = (await read(harness.base, '/api/applicability/DG-01-01')).body as DecisionsPayload;

    expect(payload.controlId).toBe('DG-01-01');
    expect(payload.decisions.map((one) => one.id)).toEqual(['decision-dg']);
  });

  it('says the decisions are not being kept rather than reading as an estate with none', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body: payload } = await read(harness.base, '/api/applicability');

    expect(status).toBe(200);
    expect(payload).toMatchObject({ durable: false, decisions: [] });
  });
});

describe('revoking a decision', () => {
  it('keeps the record and marks it revoked, with the reason and who ended it', async () => {
    const harness = await serve({ existing: [decided()] });

    const { status, body: written } = await send(harness.base, '/api/applicability/decision-existing/revoke', {
      reason: 'The estate took on serverless egress, so the requirement applies again now.',
    });
    const decision = written as DecisionPayload & { revoked?: { by: string } };

    expect(status).toBe(200);
    expect(decision.standing).toBe('revoked');
    expect(decision.effective).toBe(false);
    expect(decision.revoked).toMatchObject({ by: 'priya@example.com' });
    await expect(harness.applicability.all()).resolves.toHaveLength(1);
  });

  it('refuses a revocation with no reason, because the requirement returns to the score', async () => {
    const harness = await serve({ existing: [decided()] });

    const { status, body: refusal } = await send(harness.base, '/api/applicability/decision-existing/revoke', {});

    expect(status).toBe(400);
    expect(refusal).toMatchObject({ error: 'invalid-applicability' });
    const { decisions } = (await read(harness.base, '/api/applicability')).body as DecisionsPayload;
    expect(decisions[0]?.standing).toBe('active');
  });

  it('says which id it could not find rather than reporting a fault', async () => {
    const harness = await serve();

    const { status, body: refusal } = await send(harness.base, '/api/applicability/nothing-like-it/revoke', {
      reason: 'The requirement started applying after the platform change last week.',
    });

    expect(status).toBe(404);
    expect(refusal).toMatchObject({ error: 'unknown-decision' });
    await expect(acts(harness.audit)).resolves.toEqual([['applicability.revoke', 'failed', 'unknown-decision']]);
  });

  it('refuses to rewrite a revocation that has already happened', async () => {
    const harness = await serve({ existing: [decided()] });
    const why = 'The estate took on serverless egress, so the requirement applies again now.';
    await send(harness.base, '/api/applicability/decision-existing/revoke', { reason: why });

    const { status, body: refusal } = await send(harness.base, '/api/applicability/decision-existing/revoke', {
      reason: 'Revoking it again for a different stated reason entirely.',
    });

    expect(status).toBe(400);
    expect((refusal as { message: string }).message).toContain('already been revoked');
  });
});
