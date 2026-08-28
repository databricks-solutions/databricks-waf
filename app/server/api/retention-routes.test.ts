// Serving the retention position, and acting on it.
//
// The policy and the sweep are tested in `admin/retention.test.ts`, and the store and gateway against
// the fake database in `admin/retention-store.test.ts`. What is worth holding here is what only a route
// can get wrong: that every write is gated and recorded, that a sweep nobody confirmed is refused, and
// that a sweep confirmed against a plan that has since moved removes nothing at all.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { ResetPayload, RetentionPayload, SweepPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import { DEFAULT_PERIOD_DAYS, type Eligibility, type RetentionGateway } from '../admin/retention.js';
import { RESET_TABLES, type ResetGateway, type ResetTables } from '../admin/reset.js';
import { InMemoryRetentionStore } from '../admin/retention-store.js';
import { registerRetentionRoutes } from './retention-routes.js';

const NOW = new Date('2026-08-04T00:00:00.000Z');
const servers: Server[] = [];

afterAll(() => closeServed(servers));

/** Every act the routes opened, with how it ended, so the gating can be asserted on. */
interface Recorded {
  readonly action: AuditAction;
  outcome?: 'performed' | 'failed' | 'refused';
  target?: AuditTarget;
  /** Why, when the route named its own refusal rather than leaving it to the net. */
  reason?: string;
  /** What a reset destroyed, which is the only place that count survives the act. */
  emptied?: { readonly rows: number; readonly tables: number };
}

class Gateway implements RetentionGateway, ResetGateway {
  readonly removed: string[] = [];
  /** Every table `empty` was called on, in order, so the reset's ordering can be asserted. */
  readonly emptied: string[] = [];
  /** How many rows each table holds for a reset, which is not the same question as what is eligible. */
  private readonly rows: Record<string, number>;
  /** Fired once while a plan is being drawn, so a test can move the ground under one. */
  onPlan?: () => Promise<unknown>;

  constructor(
    private readonly eligible: Readonly<Record<string, number>> = {},
    rows: Readonly<Record<string, number>> = {}
  ) {
    this.rows = { ...rows };
  }

  async countRows(table: string): Promise<number> {
    await this.interfere();
    return this.rows[table] ?? 0;
  }

  empty(table: string): Promise<number> {
    this.emptied.push(table);
    const held = this.rows[table] ?? 0;
    this.rows[table] = 0;
    return Promise.resolve(held);
  }

  /**
   * Fired inside the transaction, before anything is emptied.
   *
   * Which is a window the tests cannot otherwise reach: the route reads the holds twice before it gets
   * here, so a test that places one earlier is testing a different check.
   */
  beforeEmptying?: () => Promise<unknown>;

  /** The transaction, with the undo the real one has: a test that asserts nothing was lost needs it. */
  async resetting<T>(run: (within: ResetTables) => Promise<T>): Promise<T> {
    const before = { ...this.rows };
    const arrive = this.beforeEmptying;
    this.beforeEmptying = undefined;
    if (arrive != null) await arrive();
    try {
      return await run(this);
    } catch (cause) {
      Object.assign(this.rows, before);
      this.emptied.length = 0;
      throw cause;
    }
  }

  /** Once, whichever of the two plans asks first, so a test can move the ground under either. */
  private async interfere(): Promise<void> {
    const move = this.onPlan;
    if (move == null) return;
    this.onPlan = undefined;
    await move();
  }

  async count(table: string, _stamp: string, before?: Date): Promise<Eligibility> {
    await this.interfere();
    const eligible = this.eligible[table] ?? 0;
    return { table, total: eligible + 1, eligible: before == null ? 0 : eligible };
  }

  countAuditPrefix(before: Date): Promise<Eligibility> {
    return this.count('audit_events', 'at', before);
  }

  remove(table: string): Promise<number> {
    this.removed.push(table);
    return Promise.resolve(this.eligible[table] ?? 0);
  }

  trimAuditPrefix(): Promise<{ removed: number; floor?: number }> {
    this.removed.push('audit_events');
    const removed = this.eligible.audit_events ?? 0;
    return Promise.resolve(removed === 0 ? { removed } : { removed, floor: removed });
  }
}

interface Harness {
  readonly base: string;
  readonly acts: Recorded[];
  readonly store: InMemoryRetentionStore;
  readonly gateway: Gateway;
}

async function serve(
  options: {
    readonly eligible?: Readonly<Record<string, number>>;
    /** What each table holds, for the reset. Absent tables hold nothing. */
    readonly rows?: Readonly<Record<string, number>>;
    /** Set to refuse every mutation, as the gate does for somebody outside the assessor group. */
    readonly refuse?: boolean;
    readonly nothingRetained?: boolean;
  } = {}
): Promise<Harness> {
  const acts: Recorded[] = [];
  const store = new InMemoryRetentionStore();
  const gateway = new Gateway(options.eligible, options.rows);

  const app = express();
  app.use(express.json());
  registerRetentionRoutes(app, {
    ...(options.nothingRetained === true ? {} : { retention: { store, gateway } }),
    now: () => NOW,
    newId: () => 'hold-1',
    permitted: (_request: Request, response: Response, action: AuditAction, context) => {
      const recorded: Recorded = { action, ...(context?.target != null ? { target: context.target } : {}) };
      acts.push(recorded);
      if (options.refuse === true) {
        recorded.outcome = 'refused';
        response.status(403).json({ error: 'permission', message: 'Not a member of the assessor group.' });
        throw new Error('refused');
      }
      const act: Act = {
        performed: (target, emptied) => {
          recorded.outcome = 'performed';
          if (target != null) recorded.target = target;
          if (emptied != null) recorded.emptied = emptied;
          return Promise.resolve();
        },
        failed: (cause) => {
          recorded.outcome = 'failed';
          if (typeof cause === 'string') recorded.reason = cause;
          return Promise.resolve();
        },
        settle: () => Promise.resolve(),
      };
      return Promise.resolve({ actor: 'priya@example.com', act });
    },
    respondToFailure: (response: Response, cause: unknown) => {
      if (response.headersSent) return;
      response.status(500).json({ error: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    },
  });

  const base = await servedAt(app, servers);
  return { base, acts, store, gateway };
}

async function get(base: string): Promise<{ status: number; body: RetentionPayload }> {
  const response = await fetch(`${base}/api/retention`);
  return { status: response.status, body: (await response.json()) as RetentionPayload };
}

async function send(
  base: string,
  path: string,
  body: unknown,
  method = 'POST'
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

describe('reading the position', () => {
  it('answers the periods, what they make eligible, and what is exempt in one request', async () => {
    const { base } = await serve({ eligible: { scans: 4 } });

    const { status, body } = await get(base);

    expect(status).toBe(200);
    expect(body.durable).toBe(true);
    expect(body.classes.map((one) => one.retentionClass)).toEqual([
      'temporary',
      'assessment',
      'governance',
      'advisory',
    ]);
    expect(body.wouldRemove).toBe(4);
    expect(body.exempt.length).toBeGreaterThan(0);
    expect(body.bounds).toEqual({ least: 1, most: 36_500 });
  });

  it('reports the default beside each period, so a changed one shows what it was changed from', async () => {
    const { base, store } = await serve();
    await store.setPeriods({ temporary: 7 }, 'sam@example.com', NOW);

    const { body } = await get(base);
    const temporary = body.classes.find((one) => one.retentionClass === 'temporary');

    expect(temporary).toMatchObject({ periodDays: 7, defaultDays: DEFAULT_PERIOD_DAYS.temporary });
    expect(body.setBy).toBe('sam@example.com');
  });

  it('is not gated, since a privacy review is a read', async () => {
    const { base, acts } = await serve({ refuse: true });

    const { status } = await get(base);

    expect(status).toBe(200);
    expect(acts).toEqual([]);
  });

  it('says why nothing will ever age past a period on an install that keeps nothing', async () => {
    const { base } = await serve({ nothingRetained: true });

    const { status, body } = await get(base);

    expect(status).toBe(200);
    expect(body.durable).toBe(false);
    expect(body.unavailable).toContain('Bind a Lakebase instance');
    expect(body.wouldRemove).toBe(0);
  });
});

describe('setting a period', () => {
  it('records the change and keeps the classes nobody named', async () => {
    const { base, acts, store } = await serve();

    const { status } = await send(base, '/api/retention/periods', { periods: { assessment: 365 } }, 'PUT');

    expect(status).toBe(204);
    expect(acts).toEqual([{ action: 'retention.configure', outcome: 'performed' }]);
    const policy = await store.policy();
    expect(policy.periods).toEqual({ ...DEFAULT_PERIOD_DAYS, assessment: 365 });
  });

  it('refuses a period outside the bounds, naming the bound', async () => {
    const { base, acts, store } = await serve();

    const { status, body } = await send(base, '/api/retention/periods', { periods: { assessment: 0 } }, 'PUT');

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'bad-period' });
    // Named in the trail rather than left to the net, so a reader gets the refusal and not `http-400`.
    expect(acts).toEqual([{ action: 'retention.configure', outcome: 'failed', reason: 'bad-period' }]);
    await expect(store.policy()).resolves.toMatchObject({ periods: DEFAULT_PERIOD_DAYS });
  });

  it('refuses a class it does not retain rather than ignoring it', async () => {
    const { base } = await serve();

    const { status, body } = await send(base, '/api/retention/periods', { periods: { everything: 30 } }, 'PUT');

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('temporary, assessment, governance');
  });

  it('refuses a body that asks for nothing, which would otherwise record a change nobody made', async () => {
    const { base } = await serve();

    const { status } = await send(base, '/api/retention/periods', { periods: {} }, 'PUT');

    expect(status).toBe(400);
  });

  it('is gated, and the refusal is recorded', async () => {
    const { base, acts } = await serve({ refuse: true });

    const { status } = await send(base, '/api/retention/periods', { periods: { assessment: 365 } }, 'PUT');

    expect(status).toBe(403);
    expect(acts).toEqual([{ action: 'retention.configure', outcome: 'refused' }]);
  });
});

describe('placing and lifting a hold', () => {
  it('places one against the person who asked, and names it in the trail', async () => {
    const { base, acts, store } = await serve();

    const { status, body } = await send(base, '/api/retention/holds', {
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 'hold-1', placedBy: 'priya@example.com', covers: ['assessment'] });
    expect(acts).toEqual([
      { action: 'retention.hold', outcome: 'performed', target: { kind: 'legal-hold', id: 'hold-1' } },
    ]);
    expect(await store.holds()).toHaveLength(1);
  });

  it('stops the class it covers from being swept', async () => {
    const { base, gateway } = await serve({ eligible: { scans: 4, imported_evidence: 2 } });
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });

    const { body } = await get(base);
    expect(body.wouldRemove).toBe(0);

    const swept = await send(base, '/api/retention/sweep', { expect: 0 });
    expect(swept.status).toBe(200);
    expect(gateway.removed).not.toContain('scans');
    expect((swept.body as SweepPayload).held).toEqual([{ retentionClass: 'assessment', holds: ['hold-1'] }]);
  });

  it('refuses a hold with no reason, because whoever lifts it will not be whoever placed it', async () => {
    const { base, acts, store } = await serve();

    const { status, body } = await send(base, '/api/retention/holds', { reason: 'audit', covers: ['assessment'] });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'bad-hold' });
    expect(acts).toEqual([{ action: 'retention.hold', outcome: 'failed', reason: 'bad-hold' }]);
    expect(await store.holds()).toHaveLength(0);
  });

  it('lifts one by recording who lifted it rather than by deleting the row', async () => {
    const { base, acts, store } = await serve();
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });

    const { status } = await send(base, '/api/retention/holds/hold-1/release', {});

    expect(status).toBe(204);
    const holds = await store.holds();
    expect(holds).toHaveLength(1);
    expect(holds[0]?.releasedBy).toBe('priya@example.com');
    expect(acts.at(-1)).toMatchObject({ action: 'retention.release', target: { kind: 'legal-hold', id: 'hold-1' } });
  });

  it('reports a hold that is no longer in force as a conflict rather than as one that never existed', async () => {
    const { base, acts } = await serve();
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });
    await send(base, '/api/retention/holds/hold-1/release', {});

    const { status, body } = await send(base, '/api/retention/holds/hold-1/release', {});

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not-in-force' });
    // The second attempt is recorded as an attempt, against the hold it named.
    expect(acts.at(-1)).toEqual({
      action: 'retention.release',
      outcome: 'failed',
      reason: 'not-in-force',
      target: { kind: 'legal-hold', id: 'hold-1' },
    });
  });

  it('keeps a released hold out of the way of the next sweep', async () => {
    const { base, gateway } = await serve({ eligible: { scans: 4 } });
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });
    await send(base, '/api/retention/holds/hold-1/release', {});

    const { status } = await send(base, '/api/retention/sweep', { expect: 4 });

    expect(status).toBe(200);
    expect(gateway.removed).toContain('scans');
  });
});

describe('sweeping', () => {
  it('removes what the plan showed and answers what it removed', async () => {
    const { base, acts, gateway } = await serve({ eligible: { scans: 4, decisions: 1 } });

    const { status, body } = await send(base, '/api/retention/sweep', { expect: 5 });

    expect(status).toBe(200);
    expect(body).toMatchObject({ removed: 5, by: 'priya@example.com' });
    expect(gateway.removed).toContain('scans');
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'performed' }]);
  });

  it('refuses a sweep nobody confirmed, and removes nothing', async () => {
    const { base, acts, gateway } = await serve({ eligible: { scans: 4 } });

    const { status, body } = await send(base, '/api/retention/sweep', {});

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'unconfirmed' });
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'failed', reason: 'unconfirmed' }]);
    expect(gateway.removed).toEqual([]);
  });

  it('refuses a confirmation the plan no longer agrees with, and removes nothing', async () => {
    const { base, acts, gateway } = await serve({ eligible: { scans: 4 } });

    const { status, body } = await send(base, '/api/retention/sweep', { expect: 40 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-moved', wouldRemove: 4 });
    expect((body as { message: string }).message).toContain('Nothing was removed');
    // The trail says which refusal this was: somebody acted on a page the estate had moved under,
    // which is a different event from a malformed request even though both answer with a 4xx.
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'failed', reason: 'plan-moved' }]);
    expect(gateway.removed).toEqual([]);
  });

  it('refuses when a hold is placed while the sweep is being prepared, and removes nothing', async () => {
    const { base, acts, gateway, store } = await serve({ eligible: { scans: 4 } });
    // Placed after the plan the caller confirmed against was drawn, which is the window a hold is
    // most likely to arrive in: somebody has just been told to preserve this.
    gateway.onPlan = () =>
      store.place({
        id: 'hold-late',
        reason: 'Litigation over the 2025 audit',
        covers: ['assessment'],
        placedBy: 'legal@example.com',
        placedAt: NOW,
      });

    const { status, body } = await send(base, '/api/retention/sweep', { expect: 4 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-moved' });
    expect((body as { message: string }).message).toContain('legal hold');
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'failed', reason: 'holds-moved' }]);
    expect(gateway.removed).toEqual([]);
  });

  it('carries the audit floor out, so a verifier knows where the chain now starts', async () => {
    const { base } = await serve({ eligible: { audit_events: 12 } });

    const { body } = await send(base, '/api/retention/sweep', { expect: 12 });

    expect(body).toMatchObject({ auditFloor: 12 });
  });

  it('is gated, and the refusal is recorded against the act that was refused', async () => {
    const { base, acts, gateway } = await serve({ eligible: { scans: 4 }, refuse: true });

    const { status } = await send(base, '/api/retention/sweep', { expect: 4 });

    expect(status).toBe(403);
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'refused' }]);
    expect(gateway.removed).toEqual([]);
  });

  it('refuses on an install that keeps nothing rather than reporting a sweep of nothing', async () => {
    const { base, acts } = await serve({ nothingRetained: true });

    const { status, body } = await send(base, '/api/retention/sweep', { expect: 0 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'nothing-retained' });
    expect(acts).toEqual([{ action: 'retention.sweep', outcome: 'failed', reason: 'nothing-retained' }]);
  });
});

/*
 * The reset. What the arithmetic and the ordering do is `admin/reset.test.ts`; what only the route can
 * get wrong is the pair of gates in front of it and the shape of the one event that survives it.
 *
 * The confirmation is against `records` rather than every row, and the tests below lean on that
 * distinction hard enough to catch it being widened back. `events` moves whenever anybody does
 * anything, including a refused reset, so a count that included the trail would be stale by the time
 * somebody read it and stale again after each attempt to act on it — a confirmation nobody can ever
 * satisfy. The genesis event still records the true total.
 */
describe('resetting the install', () => {
  it('empties everything and answers what it destroyed', async () => {
    const { base, gateway } = await serve({ rows: { scans: 4, decisions: 2, audit_events: 9 } });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 6 });

    expect(status).toBe(200);
    expect(body).toMatchObject({ rows: 15, tables: 3, by: 'priya@example.com' });
    // Every table, not merely the ones holding something: an empty table is emptied for the same reason
    // a table this build forgot about would be a hole in the promise.
    expect(gateway.emptied).toEqual(RESET_TABLES.map((one) => one.table));
    expect((body as ResetPayload).emptied.find((one) => one.table === 'scans')).toEqual({
      table: 'scans',
      removed: 4,
    });
  });

  /*
   * The count in the event, which is the assertion this whole feature turns on. Everything else the
   * reset did is unreadable afterwards by construction; if the number is missing or wrong here, the
   * trail says an install was emptied and cannot say of what.
   */
  it('records the true total in the event, trail included, not the count that was confirmed', async () => {
    const { base, acts } = await serve({ rows: { scans: 4, audit_events: 9 } });

    await send(base, '/api/retention/reset', { expect: 4 });

    // Two tables rather than sixteen: the count is of tables that held something, so a reset of an
    // install nobody had used says it removed nothing rather than claiming sixteen empty victories.
    expect(acts).toEqual([{ action: 'retention.reset', outcome: 'performed', emptied: { rows: 13, tables: 2 } }]);
  });

  it('confirms against the records, so the moving size of the trail cannot make the number unsatisfiable', async () => {
    const { base, gateway } = await serve({ rows: { scans: 4, audit_events: 9 } });

    // 13 is every row. It is also what a caller would confirm with if the count included the trail,
    // and the point of refusing it is that the trail's size is not something a caller can know.
    const { status, body } = await send(base, '/api/retention/reset', { expect: 13 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-moved', records: 4 });
    expect(gateway.emptied).toEqual([]);
  });

  it('refuses a reset nobody confirmed, and empties nothing', async () => {
    const { base, acts, gateway } = await serve({ rows: { scans: 4 } });

    const { status, body } = await send(base, '/api/retention/reset', {});

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'unconfirmed' });
    expect(acts).toEqual([{ action: 'retention.reset', outcome: 'failed', reason: 'unconfirmed' }]);
    expect(gateway.emptied).toEqual([]);
  });

  it('refuses a held install, naming the holds rather than the count', async () => {
    const { base, acts, gateway } = await serve({ rows: { scans: 4 } });
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'held', heldBy: ['hold-1'] });
    expect(acts.at(-1)).toEqual({ action: 'retention.reset', outcome: 'failed', reason: 'held' });
    expect(gateway.emptied).toEqual([]);
  });

  /*
   * A hold arriving mid-flight. The sweep has the same window and the same answer, and a reset is the
   * one act where getting it wrong is unrecoverable: there is no second copy of a legally-held record
   * once every table is empty.
   */
  it('refuses a hold placed while the reset was being prepared, and empties nothing', async () => {
    const { base, acts, gateway, store } = await serve({ rows: { scans: 4 } });
    gateway.onPlan = () =>
      store.place({
        id: 'hold-late',
        reason: 'Litigation over the 2025 audit',
        covers: ['assessment'],
        placedBy: 'legal@example.com',
        placedAt: NOW,
      });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'held', heldBy: ['hold-late'] });
    expect((body as { message: string }).message).toContain('was placed');
    expect(acts.at(-1)).toEqual({ action: 'retention.reset', outcome: 'failed', reason: 'held' });
    expect(gateway.emptied).toEqual([]);
  });

  /*
   * A hold that was already in force is refused by the first check, not the mid-flight one — which is
   * what makes the mid-flight refusal safe to word as a placement. Pinned as a test because it is the
   * argument, and an argument that stops being true silently is how the wrong sentence gets shipped.
   */
  it('refuses a hold that was already standing before the request, and says which', async () => {
    const { base, gateway, store } = await serve({ rows: { scans: 4 } });
    await store.place({
      id: 'hold-standing',
      reason: 'Litigation over the 2025 audit',
      covers: ['assessment'],
      placedBy: 'legal@example.com',
      placedAt: NOW,
    });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'held', heldBy: ['hold-standing'] });
    expect((body as { message: string }).message).toContain('somebody decided this had to be preserved');
    expect(gateway.emptied).toEqual([]);
  });

  /*
   * The window only the transaction can see: a hold that commits after the route's own check and before
   * the holds table is locked. `resetInstall` refuses on its own read, and the point of this test is the
   * answer that reaches the caller — a refusal, not a fault. Left to the generic handler it would be a
   * 500 saying something went wrong, over an install that is intact and deliberately protected.
   */
  it('answers a hold that arrives inside the transaction as a refusal rather than a fault', async () => {
    const { base, acts, gateway, store } = await serve({ rows: { scans: 4 } });
    // Placed at the last possible moment: the plan has been drawn and the mid-flight check has passed,
    // so this is the read inside `resetInstall` and nothing else.
    gateway.beforeEmptying = () =>
      store.place({
        id: 'hold-latest',
        reason: 'Litigation over the 2025 audit',
        covers: ['governance'],
        placedBy: 'legal@example.com',
        placedAt: NOW,
      });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'held', heldBy: ['hold-latest'] });
    expect((body as { message: string }).message).toContain('while this reset was running');
    expect(acts.at(-1)).toEqual({ action: 'retention.reset', outcome: 'failed', reason: 'held' });
    expect(gateway.emptied).toEqual([]);
  });

  it('lets a reset through once the hold that stopped it has been lifted', async () => {
    const { base, gateway } = await serve({ rows: { scans: 4 } });
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });
    await send(base, '/api/retention/holds/hold-1/release', {});

    const { status } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(200);
    expect(gateway.emptied).toContain('scans');
  });

  it('is gated, and the refusal is recorded against the act that was refused', async () => {
    const { base, acts, gateway } = await serve({ rows: { scans: 4 }, refuse: true });

    const { status } = await send(base, '/api/retention/reset', { expect: 4 });

    expect(status).toBe(403);
    expect(acts).toEqual([{ action: 'retention.reset', outcome: 'refused' }]);
    expect(gateway.emptied).toEqual([]);
  });

  it('refuses on an install with nothing to empty rather than reporting a reset of nothing', async () => {
    const { base, acts } = await serve({ nothingRetained: true });

    const { status, body } = await send(base, '/api/retention/reset', { expect: 0 });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'nothing-retained' });
    expect(acts).toEqual([{ action: 'retention.reset', outcome: 'failed', reason: 'nothing-retained' }]);
  });

  it('carries the plan on the position, so the confirmation can be read off the page', async () => {
    const { base } = await serve({ rows: { scans: 4, audit_events: 9 } });

    const { body } = await get(base);

    expect(body.reset).toMatchObject({ records: 4, events: 9, heldBy: [] });
    expect(body.reset?.tables).toHaveLength(RESET_TABLES.length);
  });

  it('names the holds on the position, so the button can say why it is closed before it is pressed', async () => {
    const { base } = await serve({ rows: { scans: 4 } });
    await send(base, '/api/retention/holds', { reason: 'Litigation over the 2025 audit', covers: ['assessment'] });

    const { body } = await get(base);

    expect(body.reset?.heldBy).toEqual(['hold-1']);
  });
});
