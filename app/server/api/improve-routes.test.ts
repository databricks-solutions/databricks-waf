// Serving plans, and acting on them.
//
// The lifecycle, the dependency rules and the derived reading are tested in `improve/*.test.ts`, and the
// versioned store against the fake database in `improve/store.test.ts`. What is worth holding here is
// what only a route can get wrong.
//
// Two of those are the reason this file exists at all. Nothing may reach `verified` through HTTP, which
// is the central rule of the lifecycle and is invisible from the domain tests — those check that `moved`
// refuses it, not that no endpoint calls `verifiedBy`. And the agreement on every response has to be
// computed against the run being read, because a payload that reported `awaiting` for ever would look
// exactly like a working feature.

import express, { type Request, type Response } from 'express';
import { createHash } from 'node:crypto';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type {
  ImprovementActionPayload,
  ImprovementPlanDetailPayload,
  ImprovementPlanPayload,
  ImprovementsPayload,
  PlanExportsPayload,
} from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { InMemoryImprovementStore, type ImprovementStore } from '../improve/store.js';
import type { ImprovementAction } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import { InMemoryScanStore, type ScanStore } from '../scan/store.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Scan } from '../scan/scan.js';
import type { Finding, Outcome } from '../resolve/finding.js';
import { COMPLETE } from '../collect/signal.js';
import { registerImproveRoutes } from './improve-routes.js';
import { InMemoryAdvisoryStore } from '../advise/store.js';
import { adviceFrom, type AdviceReference } from '../improve/advice.js';
import type { Advisory } from '../advise/advisory.js';
import { accountScope } from '../collect/estate-scope.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-04T09:00:00.000Z');
const MEASURED = new Date('2026-08-03T00:01:00.000Z');
const DUE = '2026-09-30T00:00:00.000Z';

/** The requirements this build pretends to have, so an action can name one and be refused another. */
const TITLES: Readonly<Record<string, string>> = {
  'DG-01-01': 'Every table has an owner',
  'SEC-02-04': 'Serverless egress is controlled',
};

/**
 * One stored advisory with one warehouse finding on it.
 *
 * Partial, like the advisory store's own fixtures: what is here is what the reference walks through,
 * and filling in the rest would be forty lines saying nothing about this file's subject.
 */
const ADVISORY: Advisory = {
  id: 'adv-1',
  runId: 'run-1',
  startedAt: MEASURED,
  finishedAt: MEASURED,
  state: 'complete',
  scope: accountScope(),
  lookbackDays: 30,
  stamp: { actor: 'priya@example.com', executionMode: 'on-behalf-of-user', warehouse: 'wh-0' },
  readings: [],
  sizing: {
    warehouses: [
      {
        workspaceId: 'w1',
        warehouseId: 'wh-1',
        name: 'finance-bi',
        findings: [
          {
            rule: 'WAREHOUSE_QUEUEING',
            severity: 'high',
            evidence: [{ label: 'Queued', value: 0.4, unit: 'ratio' }],
          },
        ],
      },
    ],
    rulesVersion: 1,
  } as never,
};

/** What a page sends when a reader raises an action from that finding: four ids, and no prose. */
const ADVICE: AdviceReference = {
  advisoryId: 'adv-1',
  advisor: 'sizing',
  resource: 'wh-1',
  rule: 'WAREHOUSE_QUEUEING',
};

/**
 * A later advisory that read the same warehouse and reported nothing on it.
 *
 * After the clock the routes run on, not merely after the first advisory: an advisory between the
 * work starting and the owner claiming it done measured a half-finished change, and `progress.ts`
 * reads that as `awaiting` rather than as an answer.
 */
function cleared(): Advisory {
  const at = new Date(NOW.getTime() + 60 * 60 * 1000);
  return {
    ...ADVISORY,
    id: 'adv-2',
    runId: 'run-2',
    startedAt: at,
    finishedAt: at,
    sizing: {
      warehouses: [{ workspaceId: 'w1', warehouseId: 'wh-1', name: 'finance-bi', findings: [] }],
      rulesVersion: 1,
    } as never,
  };
}

const PLAN = {
  title: 'Q3 governance',
  outcome: 'Every production table has a named owner and an access review behind it.',
  owners: ['priya@example.com'],
};

const ACTION = {
  controlIds: ['DG-01-01'],
  outcome: 'Ownership is assigned on every production table, so an access review has somebody to ask.',
  definitionOfDone: 'Every table in the prod catalogue has an owner recorded, checked by the ownership query.',
  owner: 'sam@example.com',
  priority: 'now',
  effort: 'medium',
  due: DUE,
};

class Refused extends Error {}

/**
 * A store where somebody else got there first, once.
 *
 * Delegates everything, and on the first `changeAction` writes its own transition at the same revision
 * before passing the caller's through — which is exactly what a second app instance does, and is the
 * only way to see the conflict from a route: within one process express serves requests one at a time,
 * so two callers never hold the same revision.
 */
class Racing implements ImprovementStore {
  private raced = false;

  constructor(private readonly inner: ImprovementStore) {}

  get durable(): boolean {
    return this.inner.durable;
  }

  plans(): Promise<readonly ImprovementPlan[]> {
    return this.inner.plans();
  }

  plan(id: string): Promise<ImprovementPlan | undefined> {
    return this.inner.plan(id);
  }

  addPlan(plan: ImprovementPlan): Promise<void> {
    return this.inner.addPlan(plan);
  }

  changePlan(plan: ImprovementPlan): Promise<void> {
    return this.inner.changePlan(plan);
  }

  actions(planId: string): Promise<readonly ImprovementAction[]> {
    return this.inner.actions(planId);
  }

  action(id: string): Promise<ImprovementAction | undefined> {
    return this.inner.action(id);
  }

  actionsFor(controlId: string): Promise<readonly ImprovementAction[]> {
    return this.inner.actionsFor(controlId);
  }

  actionsRaised(): Promise<readonly ImprovementAction[]> {
    return this.inner.actionsRaised();
  }

  addAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    return this.inner.addAction(action, plan);
  }

  async changeAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    if (!this.raced) {
      this.raced = true;
      // A different move, at the revision this one is about to take, from the state the caller read.
      const first = action.history[0]?.from ?? 'draft';
      await this.inner.changeAction(
        {
          ...action,
          state: 'cancelled',
          history: [
            {
              from: first,
              to: 'cancelled',
              at: NOW,
              by: 'person',
              who: 'sam@example.com',
              reason: 'Cancelled by somebody else while this move was in flight, which is the race being modelled.',
            },
          ],
        },
        plan
      );
    }
    return this.inner.changeAction(action, plan);
  }
}

interface Harness {
  readonly base: string;
  readonly store: ImprovementStore;
  readonly scans: ScanStore;
  /** So a case can put a second advisory on the record, which is what reads an action's advice again. */
  readonly advisories: InMemoryAdvisoryStore;
  readonly audit: AuditLog;
  /** Moves the clock the routes read, for the cases where the point is that a date has passed. */
  readonly travel: (to: Date) => void;
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly permit?: boolean;
    readonly actor?: string;
    /** What the last run measured each requirement as. Absent means no run has happened. */
    readonly outcomes?: Readonly<Record<string, Outcome>>;
    /** Which requirements the run reports met on somebody's word, and when they said it. */
    readonly attested?: Readonly<Record<string, Date>>;
    /** Writes a competing revision under the next move, as another instance of the app would. */
    readonly raceOnMove?: boolean;
    /** An install with no trail bound, where an export still serves and nothing records who took it. */
    readonly omitTrail?: boolean;
    /** An install keeping no advisories, where an action cannot be raised from advice at all. */
    readonly omitAdvisories?: boolean;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const store =
    over.raceOnMove === true ? new Racing(new InMemoryImprovementStore()) : new InMemoryImprovementStore();
  const scans = new InMemoryScanStore();
  if (over.outcomes != null) await scans.save(scanWith(over.outcomes, over.attested));
  const advisories = new InMemoryAdvisoryStore();
  await advisories.save(ADVISORY);
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;
  let at = NOW;

  registerImproveRoutes(app, {
    ...(over.omitStore === true ? {} : { improvements: store }),
    ...(over.omitAdvisories === true ? {} : { advisories }),
    improvementStorage: 'Kept in the waf schema of the bound database.',
    store: scans,
    knownControl: (id) => id in TITLES,
    titleOf: (id) => TITLES[id],
    now: () => at,
    newId: () => `id-${String((minted += 1))}`,
    // The real recorder over an in-memory log rather than a stub act, for the reason
    // `definition-routes.test.ts` gives: the routes are the only place the events are composed, so a
    // fake act would leave nothing checking that a move records the action it moved.
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: over.actor ?? 'priya@example.com',
            act: closedWhenAnswered(
              recorder.begin(
                action,
                { actor: over.actor ?? 'priya@example.com', executionMode: 'on-behalf-of-user' },
                context ?? {}
              ),
              response
            ),
          }),
    // An export is a read, so it opens an act without a gate. The real recorder again, because the thing
    // worth checking is that a download writes the filename and the digest it actually served.
    ...(over.omitTrail === true
      ? {}
      : {
          recordRead: (
            _request: Request,
            response: Response,
            action: AuditAction,
            context?: { readonly correlation?: string }
          ) =>
            closedWhenAnswered(
              recorder.begin(
                action,
                { actor: over.actor ?? 'priya@example.com', executionMode: 'on-behalf-of-user' },
                context ?? {}
              ),
              response
            ),
          takenFrom: async (action: AuditAction, correlation: string, current: ReadonlyMap<string, string>) => {
            const page = await audit.search({ action, correlation, outcome: 'performed' });
            return page.events.flatMap((event) => {
              const target = event.target;
              if (target?.kind !== 'artefact' || target.digest == null) return [];
              const now = current.get(target.id);
              return [
                {
                  name: target.id,
                  digest: target.digest,
                  at: event.at.toISOString(),
                  by: event.actor,
                  ...(now == null ? {} : { current: now === target.digest }),
                },
              ];
            });
          },
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
  return {
    base,
    store,
    scans,
    advisories,
    audit,
    travel: (to: Date) => {
      at = to;
    },
  };
}

function scanWith(
  outcomes: Readonly<Record<string, Outcome>>,
  /** When somebody attested each requirement, for the run that reports it met on their word. */
  attested: Readonly<Record<string, Date>> = {}
): Scan {
  const findings: Finding[] = Object.entries(outcomes).map(([controlId, outcome]) => ({
    controlId,
    pillarId: 'data-and-ai-governance',
    principleId: 'unify',
    title: TITLES[controlId] ?? controlId,
    outcome,
    severity: 'high',
    coverage: COMPLETE,
    evidence: [],
    ...(attested[controlId] != null
      ? {
          attested: {
            bearing: 'outcome' as const,
            by: 'priya@example.com',
            at: attested[controlId],
            statement: 'We review access quarterly.',
            owner: 'platform-team',
            reviewBy: new Date('2027-01-01T00:00:00Z'),
          },
        }
      : {}),
  }));

  return {
    id: 'run-1',
    startedAt: new Date(MEASURED.getTime() - 60_000),
    finishedAt: MEASURED,
    state: 'complete',
    stamp: {
      catalogueVersion: '10',
      catalogueFingerprint: 'sha256:abc',
      executionMode: 'on-behalf-of-user',
      actor: 'priya@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
      overall: 0,
    },
    findings,
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

async function send(
  base: string,
  path: string,
  body?: unknown,
  method = 'POST'
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function read<T>(base: string, path: string): Promise<T> {
  return (await (await fetch(`${base}${path}`)).json()) as T;
}

/** A minute later, which is enough to make a run later than a claim without inviting a magic number. */
function after(at: Date): Date {
  return new Date(at.getTime() + 60_000);
}

/** Every act the routes recorded, oldest first, which is the order they happened in. */
async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id ?? event.reason] as const);
}

/** A plan and one action in it, through the routes, so every test starts from records the API made. */
async function planned(
  base: string,
  over: Readonly<Record<string, unknown>> = {}
): Promise<{ planId: string; actionId: string }> {
  const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
  const action = (await send(base, `/api/improvements/${plan.id}/actions`, { ...ACTION, ...over }))
    .body as ImprovementActionPayload;
  return { planId: plan.id, actionId: action.id };
}

/** Walks an action to `ready-for-validation`, which is as far as anybody is allowed to take it. */
async function claimed(base: string, planId: string, actionId: string): Promise<ImprovementActionPayload> {
  const at = `/api/improvements/${planId}/actions/${actionId}/move`;
  await send(base, at, { to: 'planned' });
  await send(base, at, { to: 'in-progress' });
  return (await send(base, at, { to: 'ready-for-validation' })).body as ImprovementActionPayload;
}

describe('opening a plan', () => {
  it('records the act against the plan it minted, and returns it with an empty rollup', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/improvements', PLAN);
    const plan = body as ImprovementPlanPayload;

    expect(status).toBe(201);
    expect(plan).toMatchObject({ id: 'id-1', title: 'Q3 governance', createdBy: 'priya@example.com' });
    expect(plan.progress.settled).toBe(true);
    expect(plan.progress.states.draft).toBe(0);
    await expect(acts(audit)).resolves.toEqual([['plan.open', 'performed', 'id-1']]);
  });

  it('stamps a plan from the assessment the request is in, so it does not vanish from the list that created it', async () => {
    const { base } = await serve();

    const { status, body } = await send(base, '/api/improvements?definitionId=def-a', PLAN);
    const plan = body as ImprovementPlanPayload;

    expect(status).toBe(201);
    expect(plan.assessment).toEqual({ definitionId: 'def-a', version: 1 });
    const listed = await read<ImprovementsPayload>(base, '/api/improvements?definitionId=def-a');
    expect(listed.plans.map((one) => one.id)).toEqual([plan.id]);
    expect((await read<ImprovementsPayload>(base, '/api/improvements?definitionId=def-b')).plans).toEqual([]);
  });

  it('refuses a plan with no outcome, and the trail says the attempt failed', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/improvements', { ...PLAN, outcome: 'later' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-plan' });
    expect((body as { message: string }).message).toContain('a folder');
    await expect(acts(audit)).resolves.toEqual([['plan.open', 'failed', 'InvalidPlanError']]);
  });

  it('refuses a citation of an assessment version that does not exist', async () => {
    const { base } = await serve();

    // No definition store is bound in this harness, so the citation is accepted unchecked. What is held
    // here is the shape rather than the lookup: a reference missing its version is refused by the
    // domain either way, and a build with definitions bound refuses a dangling one as well.
    const { status, body } = await send(base, '/api/improvements', {
      ...PLAN,
      assessment: { definitionId: 'def-1' },
    });

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('whole version number');
  });

  it('will not keep a plan on an install with nowhere to put one', async () => {
    const { base } = await serve({ omitStore: true });

    const { status, body } = await send(base, '/api/improvements', PLAN);

    expect(status).toBe(503);
    expect((body as { message: string }).message).toContain('Bind a database');
  });

  it('lists plans without their actions, since a list page shows counts', async () => {
    const { base } = await serve();
    await planned(base);

    const payload = await read<ImprovementsPayload>(base, '/api/improvements');

    expect(payload.plans).toHaveLength(1);
    expect(payload.plans[0]?.progress.states.draft).toBe(1);
    expect(payload.minProse).toBe(20);
    // The actions themselves are not in the list payload. Sending every action of every plan would grow
    // with the programme rather than with the page.
    expect(JSON.stringify(payload)).not.toContain('definitionOfDone');
  });
});

describe('raising an action', () => {
  it('takes the plan from the path rather than the body, so the two cannot disagree', async () => {
    const { base, store } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, {
      ...ACTION,
      planId: 'somewhere-else',
    });
    const action = body as ImprovementActionPayload;

    expect(status).toBe(201);
    expect(action.planId).toBe(plan.id);
    await expect(store.actions(plan.id)).resolves.toHaveLength(1);
  });

  it('names the requirement it is about, so a board need not join against the catalogue', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const payload = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`);

    expect(payload.actions[0]?.titles).toEqual({ 'DG-01-01': 'Every table has an owner' });
  });

  it('refuses a requirement this framework does not have', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, {
      ...ACTION,
      controlIds: ['DG-01-01', 'NOPE-99'],
    });

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('NOPE-99');
  });

  it('refuses work raised against a closed plan, rather than making its rollup wrong', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    await send(base, `/api/improvements/${plan.id}/close`, {
      reason: 'The governance programme was folded into the platform migration plan.',
    });

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, ACTION);

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-closed' });
  });

  it('answers 404 for a plan that does not exist, and records the attempt against it', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/improvements/ghost/actions', ACTION);

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-plan' });
    // The route's own word rather than `http-404` from the net, so the trail says what was refused. The
    // target is the plan that was asked for, which is what makes the row worth reading.
    const { events } = await audit.search();
    expect(events.map((event) => [event.action, event.outcome, event.reason, event.target?.id])).toEqual([
      ['action.raise', 'failed', 'unknown-plan', 'ghost'],
    ]);
  });
});

describe('raising an action from an advisor finding', () => {
  /** The action body without requirements, which is what an advisor finding raises. */
  const FROM_ADVICE = { ...ACTION, controlIds: [], advice: ADVICE };

  it('reads the provenance out of the stored advisory rather than out of the request', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, {
      ...FROM_ADVICE,
      // A body doing what a compromised or merely stale page would do. None of it is stored: the
      // three lines below come from the record, which is what makes them worth reading later.
      advice: { ...ADVICE, headline: 'Nothing is wrong', baseline: [] },
    });
    const action = body as ImprovementActionPayload;

    expect(status).toBe(201);
    expect(action.advice?.headline).not.toBe('Nothing is wrong');
    expect(action.advice?.baseline).toEqual([{ label: 'Queued', value: 0.4, unit: 'ratio' }]);
    expect(action.advice?.resource).toEqual({ kind: 'warehouse', id: 'wh-1', workspaceId: 'w1', name: 'finance-bi' });
    expect(action.advice?.rule).toBe('WAREHOUSE_QUEUEING');
    expect(action.controlIds).toEqual([]);
  });

  it('refuses a reference that names no finding in that advisory', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, {
      ...FROM_ADVICE,
      advice: { ...ADVICE, resource: 'wh-nothing' },
    });

    expect(status).toBe(400);
    expect((body as { error: string }).error).toBe('unknown-advice');
  });

  it('refuses a reference to an advisory nobody kept', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status } = await send(base, `/api/improvements/${plan.id}/actions`, {
      ...FROM_ADVICE,
      advice: { ...ADVICE, advisoryId: 'adv-nothing' },
    });

    expect(status).toBe(400);
  });

  it('refuses it on an install that keeps no advisories at all', async () => {
    // Rather than storing the action with the reference and no provenance, which would read as
    // checkable and be nothing of the kind.
    const { base } = await serve({ omitAdvisories: true });
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE);

    expect(status).toBe(400);
    expect((body as { message: string }).message).toMatch(/not keeping advisories/);
  });

  it('keeps the provenance through a revision that does not resend it', async () => {
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    const raised = (await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE))
      .body as ImprovementActionPayload;

    const { status, body } = await send(
      base,
      `/api/improvements/${plan.id}/actions/${raised.id}`,
      { ...FROM_ADVICE, advice: undefined, owner: 'ada@example.com' },
      'PUT'
    );

    expect(status).toBe(200);
    expect((body as ImprovementActionPayload).owner).toBe('ada@example.com');
    expect((body as ImprovementActionPayload).advice?.rule).toBe('WAREHOUSE_QUEUEING');
  });

  it('is not judged by a scan, however many requirements that scan measured', async () => {
    // The defect this exists for: every branch of the agreement below `awaiting` decides on the set of
    // requirements the action names, and the last of them answers `agreed` for an empty one.
    const { base } = await serve({ outcomes: { 'DG-01-01': 'pass' } });
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    const raised = (await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE))
      .body as ImprovementActionPayload;
    await claimed(base, plan.id, raised.id);

    const detail = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${plan.id}`);

    // Waiting on the next advisory rather than agreed: the only advisory on the record is the one it
    // was raised from, which finished before the work was claimed done.
    expect(detail.actions.find((one) => one.id === raised.id)?.agreement).toBe('awaiting');
  });

  it('is unjudged on an install keeping no advisories, because nothing there can answer it', async () => {
    // The state exists for exactly this install. An action raised from advice before the operator
    // unbound the advisory store has nothing entitled to speak to it, and `awaiting` would say a
    // reading is coming.
    const { base, store } = await serve({ omitAdvisories: true, outcomes: { 'DG-01-01': 'pass' } });
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    const raised = (await send(base, `/api/improvements/${plan.id}/actions`, ACTION))
      .body as ImprovementActionPayload;
    // Straight into the store, since the route refuses to raise one from advice at all here.
    const kept = await store.action(raised.id);
    const held = await store.plan(plan.id);
    if (kept == null || held == null) throw new Error('the harness did not keep what it wrote');
    await store.changeAction(
      { ...kept, controlIds: [], advice: adviceFrom(ADVISORY, ADVICE), revision: kept.revision + 1 },
      held
    );
    await claimed(base, plan.id, raised.id);

    const detail = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${plan.id}`);

    expect(detail.actions.find((one) => one.id === raised.id)?.agreement).toBe('unjudged');
  });

  it('reads it against the latest advisory rather than against the one it was raised from', async () => {
    // The advisory an action came from is the latest one until the next run, and it agrees with
    // itself by construction. A second run is what turns `unjudged` into an answer.
    const { base, advisories } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    const raised = (await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE))
      .body as ImprovementActionPayload;
    await claimed(base, plan.id, raised.id);
    await advisories.save(cleared());

    const detail = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${plan.id}`);
    const action = detail.actions.find((one) => one.id === raised.id);

    expect(action?.adviceReading?.standing).toBe('cleared');
    expect(action?.agreement).toBe('agreed');
  });
});

describe('the four value figures', () => {
  const FROM_ADVICE = { ...ACTION, controlIds: [], advice: ADVICE };

  it('are absent on an install that has run no advisory, rather than reported as zeroes', async () => {
    // Three of the four are the advisors', and a posture beside three zeroes would say the estate has
    // nothing to gain — which is a claim about advisors nobody has run.
    const { base } = await serve({ omitAdvisories: true, outcomes: { 'DG-01-01': 'pass' } });

    expect((await read<ImprovementsPayload>(base, '/api/improvements')).value).toBeUndefined();
  });

  it('restate the assessment score rather than deriving one from the advisors', async () => {
    const { base } = await serve({ outcomes: { 'DG-01-01': 'pass' } });

    const value = (await read<ImprovementsPayload>(base, '/api/improvements')).value;

    // The run's own figures, named as the run's. Nothing below is computed from them and they are not
    // computed from anything below: ADR 0083's prohibition, and this route is where both are in scope.
    expect(value?.posture).toMatchObject({ runId: 'run-1', overall: 0, scoredControls: 0, totalControls: 0 });
  });

  it('count every advice-raised action by what the estate says, and no others', async () => {
    const { base, advisories } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    const raised = (await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE))
      .body as ImprovementActionPayload;
    // A second action naming a requirement, which belongs to the assessment's arithmetic and not to
    // this one.
    await send(base, `/api/improvements/${plan.id}/actions`, ACTION);
    await claimed(base, plan.id, raised.id);
    await advisories.save(cleared());

    const value = (await read<ImprovementsPayload>(base, '/api/improvements')).value;

    expect(value?.outcomes).toMatchObject({ agreed: 1, contradicted: 0, unjudged: 0 });
    expect(value?.cleared).toEqual({ actions: 1, resources: 1 });
  });

  it('report no money where the advisor behind the work prices nothing', async () => {
    // The sizing advisor computes no estimate, and an empty entry for it would be a zero that reads
    // as nothing to gain rather than as nothing measured.
    const { base } = await serve();
    const plan = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    await send(base, `/api/improvements/${plan.id}/actions`, FROM_ADVICE);

    const value = (await read<ImprovementsPayload>(base, '/api/improvements')).value;

    expect(value?.opportunity).toEqual([]);
    expect(value?.committed).toEqual([]);
  });
});

describe('revising an action', () => {
  it('replaces the revisable fields and records the act, without touching the lifecycle', async () => {
    const { base, audit } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, { to: 'planned' });

    const { status, body } = await send(
      base,
      `/api/improvements/${planId}/actions/${actionId}`,
      { ...ACTION, owner: 'raj@example.com', priority: 'next', effort: 'large', steps: ['Agree the owner list'] },
      'PUT'
    );
    const action = body as ImprovementActionPayload;

    expect(status).toBe(200);
    expect(action).toMatchObject({ owner: 'raj@example.com', priority: 'next', effort: 'large', state: 'planned' });
    expect(action.steps).toEqual(['Agree the owner list']);
    // A revision is not a transition, so the history is the one move that happened.
    expect(action.history).toHaveLength(1);
    await expect(acts(audit)).resolves.toEqual([
      ['plan.open', 'performed', planId],
      ['action.raise', 'performed', actionId],
      ['action.move', 'performed', actionId],
      ['action.revise', 'performed', actionId],
    ]);
  });

  it('lets a draft be rewritten entirely, since nothing about it has been agreed', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);

    const { status, body } = await send(
      base,
      `/api/improvements/${planId}/actions/${actionId}`,
      {
        ...ACTION,
        controlIds: ['SEC-02-04'],
        outcome: 'Serverless workloads reach only the endpoints somebody signed off, and the list is reviewed.',
      },
      'PUT'
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ controlIds: ['SEC-02-04'], state: 'draft' });
  });

  it('refuses to change what agreed work is about, and says which route out of that there is', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, { to: 'planned' });

    const { status, body } = await send(
      base,
      `/api/improvements/${planId}/actions/${actionId}`,
      { ...ACTION, definitionOfDone: 'Somebody has had a look at the tables and is broadly happy with them.' },
      'PUT'
    );

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('definitionOfDone');
    expect((body as { message: string }).message).toContain('back to draft');
  });

  it('keeps a date that has since passed, so an overdue action can still change hands', async () => {
    // The due date is in the past by the time this revision is made, and the revision does not touch it.
    // A rule that refused this would make an overdue action the one thing nobody can reassign.
    const { base, travel } = await serve();
    const { planId, actionId } = await planned(base);
    travel(new Date('2026-10-01T09:00:00.000Z'));

    const { status, body } = await send(
      base,
      `/api/improvements/${planId}/actions/${actionId}`,
      { ...ACTION, owner: 'raj@example.com' },
      'PUT'
    );

    expect(status).toBe(200);
    expect(body).toMatchObject({ owner: 'raj@example.com', due: DUE, lateness: 'overdue' });
  });

  it('refuses to edit a plan that is closed', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'cancelled',
      reason: 'Folded into the platform migration, which answers the same requirement.',
    });
    await send(base, `/api/improvements/${planId}/close`, {
      reason: 'Everything in it was either done or folded into the migration plan.',
    });

    const { status, body } = await send(
      base,
      `/api/improvements/${planId}/actions/${actionId}`,
      { ...ACTION, owner: 'raj@example.com' },
      'PUT'
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-closed' });
  });
});

describe('moving an action', () => {
  it('refuses a move inside a closed plan, which would put live work under a finished one', async () => {
    // The gap the pages could not have found: they treat a closed plan as frozen and never offer a
    // move, so the rule held everywhere except over HTTP, where a cancelled action could be walked
    // back to `draft` under a plan whose whole claim is that nothing in it is live.
    const { base } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'cancelled',
      reason: 'Folded into the platform migration, which answers the same requirement.',
    });
    await send(base, `/api/improvements/${planId}/close`, {
      reason: 'Everything in it was either done or folded into the migration plan.',
    });

    const { status, body } = await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'draft',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'plan-closed' });
  });

  it('records each move and offers only the moves a person may make next', async () => {
    const { base, audit } = await serve();
    const { planId, actionId } = await planned(base);

    const { status, body } = await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'planned',
    });
    const action = body as ImprovementActionPayload;

    expect(status).toBe(200);
    expect(action.state).toBe('planned');
    expect(action.history).toHaveLength(1);
    expect(action.history[0]).toMatchObject({ from: 'draft', to: 'planned', by: 'person', who: 'priya@example.com' });
    expect(action.moves).toEqual(['in-progress', 'blocked', 'draft', 'cancelled']);
    await expect(acts(audit)).resolves.toEqual([
      ['plan.open', 'performed', planId],
      ['action.raise', 'performed', actionId],
      ['action.move', 'performed', actionId],
    ]);
  });

  /*
   * The rule the whole lifecycle is built on. `moved` refuses the transition and this route never calls
   * `verifiedBy`, so there is no way to reach `verified` through HTTP at all — and the sentence the
   * caller gets says why rather than claiming the state does not exist.
   */
  it('refuses to let anybody mark their own work verified', async () => {
    const { base } = await serve({ outcomes: { 'DG-01-01': 'pass' } });
    const { planId, actionId } = await planned(base);
    await claimed(base, planId, actionId);

    const { status, body } = await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'verified',
    });

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('Nobody can mark their own work verified');
  });

  it('never offers verified among the moves, even from the state it is reachable from', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);

    const action = await claimed(base, planId, actionId);

    expect(action.state).toBe('ready-for-validation');
    expect(action.moves).not.toContain('verified');
  });

  it('refuses a blocking move with no reason, since a blocker nobody named cannot be cleared', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, { to: 'planned' });

    const { status, body } = await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'blocked',
    });

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('what it is blocked on');
  });

  it('answers 404 for an action in another plan, rather than moving it', async () => {
    const { base } = await serve();
    const { actionId } = await planned(base);
    const other = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;

    const { status, body } = await send(base, `/api/improvements/${other.id}/actions/${actionId}/move`, {
      to: 'planned',
    });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-action' });
  });

  /*
   * Not two parallel requests, which is what this started as and which never conflicted: express serves
   * them one at a time, so the second read the first's result and made a legitimate second move. The
   * race being modelled is the one that happens across two app instances, and the store is where it is
   * visible — so the harness writes the competing revision from underneath and the route meets the
   * refusal the database would give it.
   */
  it('reports a lost race as a conflict to re-read rather than as a failure', async () => {
    const { base, store } = await serve({ raceOnMove: true });
    const { planId, actionId } = await planned(base);

    const { status, body } = await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'planned',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'concurrent-change' });
    expect((body as { message: string }).message).toContain('Re-read it and try again');
    // The other writer's transition stands, and this one landed nowhere.
    await expect(store.action(actionId)).resolves.toMatchObject({ state: 'cancelled' });
  });
});

/*
 * Nothing about an agreement is stored, so every read of a plan joins its actions to the latest run. A
 * payload that always said `awaiting` would look exactly like a working feature, which is why these
 * assert against a run rather than against the record.
 */
describe('what the estate says about an action', () => {
  it('agrees once a later run measures every requirement it names as met', async () => {
    const { base, scans } = await serve({ outcomes: { 'DG-01-01': 'pass' } });
    const { planId, actionId } = await planned(base);
    // The only run so far is dated before the claim, so it cannot speak to it — a run taken while the
    // work was half done is evidence about a half-done change and reading it either way would be wrong.
    expect((await claimed(base, planId, actionId)).agreement).toBe('awaiting');
    expect(await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`)).toMatchObject({
      measuredAt: MEASURED.toISOString(),
    });

    await scans.save({ ...scanWith({ 'DG-01-01': 'pass' }), id: 'run-2', finishedAt: after(NOW) });
    const payload = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`);

    expect(payload.measuredAt).toBe(after(NOW).toISOString());
    expect(payload.actions[0]?.agreement).toBe('agreed');
    expect(payload.actions[0]?.unmet).toEqual([]);
    // Still `ready-for-validation`. A run agreeing is what makes the transition legitimate; nothing here
    // makes it, because no route may.
    expect(payload.actions[0]?.state).toBe('ready-for-validation');
    expect(actionId).toBe(payload.actions[0]?.id);
  });

  it('contradicts a claim the run disagrees with, and names the requirement', async () => {
    const { base, scans } = await serve({ outcomes: { 'DG-01-01': 'fail' } });
    const { planId, actionId } = await planned(base);
    await claimed(base, planId, actionId);
    // A run *after* the claim, which is what makes it evidence about it.
    await scans.save({ ...scanWith({ 'DG-01-01': 'fail' }), id: 'run-2', finishedAt: new Date(NOW.getTime() + 60_000) });

    const payload = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`);

    expect(payload.actions[0]?.agreement).toBe('contradicted');
    expect(payload.actions[0]?.unmet).toEqual(['DG-01-01']);
    expect(payload.plan.progress.contradicted).toEqual([actionId]);
  });

  it('reads a requirement nothing could measure as unmeasured rather than as agreement', async () => {
    const { base, scans } = await serve({ outcomes: { 'DG-01-01': 'unmeasurable' } });
    const { planId, actionId } = await planned(base);
    await claimed(base, planId, actionId);
    await scans.save({
      ...scanWith({ 'DG-01-01': 'unmeasurable' }),
      id: 'run-2',
      finishedAt: new Date(NOW.getTime() + 60_000),
    });

    const payload = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`);

    expect(payload.actions[0]?.agreement).toBe('unmeasured');
    expect(payload.actions[0]?.unreadable).toEqual(['DG-01-01']);
  });

  it('says nothing has been measured when no run has happened, rather than reporting agreement', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const payload = await read<ImprovementPlanDetailPayload>(base, `/api/improvements/${planId}`);

    expect(payload.measuredAt).toBeUndefined();
    expect(payload.actions[0]?.agreement).toBe('unclaimed');
  });
});

describe('closing a plan', () => {
  it('refuses while any action in it is still live', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const { status, body } = await send(base, `/api/improvements/${planId}/close`, {
      reason: 'The work moved into the platform migration programme and is tracked there instead.',
    });

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('still live');
  });

  it('closes once every action is verified or cancelled, and keeps the plan', async () => {
    const { base } = await serve();
    const { planId, actionId } = await planned(base);
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, {
      to: 'cancelled',
      reason: 'The table ownership work was done by the migration instead, so this duplicates it.',
    });

    const { status, body } = await send(base, `/api/improvements/${planId}/close`, {
      reason: 'Everything in it was either done elsewhere or cancelled with a reason.',
    });
    const plan = body as ImprovementPlanPayload;

    expect(status).toBe(200);
    expect(plan.closed).toMatchObject({ by: 'priya@example.com' });
    // Closed rather than deleted: the list still has it, which is what makes it the record of a period.
    const payload = await read<ImprovementsPayload>(base, '/api/improvements');
    expect(payload.plans.map((one) => one.id)).toEqual([planId]);
  });

  it('refuses a closing reason too short to tell the next reader anything', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const { status } = await send(base, `/api/improvements/${planId}/close`, { reason: 'done' });

    expect(status).toBe(400);
  });
});

describe('finding every action currently raised', () => {
  it('answers across every plan in one read, and is not a plan id', async () => {
    const { base } = await serve();
    const first = await planned(base);
    const second = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    await send(base, `/api/improvements/${second.id}/actions`, { ...ACTION, controlIds: ['DG-01-01', 'SEC-02-04'] });

    const payload = await read<{ actions: readonly ImprovementActionPayload[] }>(base, '/api/improvements/raised');

    expect(payload.actions).toHaveLength(2);
    expect(payload.actions.map((one) => one.planId).sort()).toEqual([first.planId, second.id].sort());
  });

  it('answers empty rather than failing on an install that keeps nothing', async () => {
    const { base } = await serve({ omitStore: true });

    const payload = await read<{ actions: readonly ImprovementActionPayload[]; durable: boolean }>(
      base,
      '/api/improvements/raised'
    );

    expect(payload).toMatchObject({ actions: [], durable: false });
  });
});

describe('finding the work already raised against a requirement', () => {
  it('answers across every plan, since the action is rarely in the plan being read', async () => {
    const { base } = await serve();
    const first = await planned(base);
    const second = (await send(base, '/api/improvements', PLAN)).body as ImprovementPlanPayload;
    await send(base, `/api/improvements/${second.id}/actions`, { ...ACTION, controlIds: ['DG-01-01', 'SEC-02-04'] });

    const payload = await read<{ actions: readonly ImprovementActionPayload[] }>(
      base,
      '/api/improvements/for/DG-01-01'
    );

    expect(payload.actions).toHaveLength(2);
    expect(payload.actions.map((one) => one.planId).sort()).toEqual([first.planId, second.id].sort());
  });

  it('answers empty rather than failing on an install that keeps nothing', async () => {
    const { base } = await serve({ omitStore: true });

    const payload = await read<{ actions: readonly ImprovementActionPayload[]; durable: boolean }>(
      base,
      '/api/improvements/for/DG-01-01'
    );

    expect(payload).toMatchObject({ actions: [], durable: false });
  });
});

describe('the gate', () => {
  it('refuses every mutation to somebody outside the assessor group', async () => {
    const { base, store } = await serve({ permit: false });

    const attempts = await Promise.all([
      send(base, '/api/improvements', PLAN),
      send(base, '/api/improvements/id-1/actions', ACTION),
      send(base, '/api/improvements/id-1/actions/id-2/move', { to: 'planned' }),
      send(base, '/api/improvements/id-1/close', { reason: 'A reason long enough to be accepted otherwise.' }),
    ]);

    expect(attempts.map((one) => one.status)).toEqual([403, 403, 403, 403]);
    await expect(store.plans()).resolves.toEqual([]);
  });

  it('leaves the reads open, since reading a plan is not changing one', async () => {
    const { base } = await serve({ permit: false });

    const payload = await read<ImprovementsPayload>(base, '/api/improvements');

    expect(payload.plans).toEqual([]);
  });
});

describe('exporting a plan', () => {
  it('serves a file a browser will save, named for the plan and deliberately not for a version', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const response = await fetch(`${base}/api/improvements/${planId}/export.csv`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/csv; charset=utf-8');
    expect(response.headers.get('content-disposition')).toContain('attachment; filename="improvement-plan-');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const text = await response.text();
    expect(text).toContain('definition_of_done');
    expect(text).toContain(ACTION.definitionOfDone);
  });

  it('records the download with the digest of the bytes it actually served', async () => {
    // The property the whole artefact module exists for: a route cannot record a digest of something
    // other than what it sent. Hashed here rather than read off the header, so the header is checked too.
    const { base, audit } = await serve();
    const { planId } = await planned(base);

    const response = await fetch(`${base}/api/improvements/${planId}/export.json`);
    const served = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');

    const [exported] = (await audit.search({ action: 'export.plan' })).events;
    expect(exported).toMatchObject({
      outcome: 'performed',
      target: { kind: 'artefact', digest: `sha256:${served}` },
    });
    expect(response.headers.get('x-export-digest')).toBe(`sha256:${served}`);
    // Correlated to the plan, which is what makes "what has this plan told people" a question with an answer.
    expect(exported?.correlation).toBe(planId);
  });

  it('serves the variant asked for, and refuses a word it does not produce', async () => {
    const { base } = await serve();
    const { planId } = await planned(base);

    const executive = await fetch(`${base}/api/improvements/${planId}/export.csv?variant=executive`);
    expect(await executive.text()).not.toContain('depends_on');

    const delivery = await fetch(`${base}/api/improvements/${planId}/export.csv`);
    expect(await delivery.text()).toContain('depends_on');

    const refused = await fetch(`${base}/api/improvements/${planId}/export.csv?variant=summary`);
    expect(refused.status).toBe(400);
    // Refused rather than defaulted: a caller handed the complete file would describe it to somebody
    // else as a summary, and the mistake surfaces in the meeting where the two do not match.
    expect(((await refused.json()) as { error: string }).error).toBe('unknown-variant');
  });

  it('publishes what each file should hash to without recording anything', async () => {
    // Measured, so the payload has a run to name. On an install with none it says so instead, which the
    // test below about naming the run covers.
    const { base, audit } = await serve({ outcomes: { 'DG-01-01': 'fail' } });
    const { planId } = await planned(base);

    const payload = await read<PlanExportsPayload>(base, `/api/improvements/${planId}/exports`);

    expect(payload.planId).toBe(planId);
    // Which run these digests were judged against, said here rather than in the filenames — see
    // `planExportName` for why a version in the name would break the comparison below, and the payload's
    // own comment for why this is the run and not the plan's revision.
    expect(payload.judgedAgainst?.run).toBe('run-1');
    expect(payload.variants.map((one) => one.variant)).toEqual(['executive', 'delivery', 'audit']);
    expect(payload.variants.flatMap((one) => one.files)).toHaveLength(6);
    // Nothing left the app, so nothing is recorded. A row saying somebody looked at a checksum is the
    // kind of entry that makes an auditor scroll past the rows that matter.
    expect((await audit.search({ action: 'export.plan' })).events).toEqual([]);

    const published = payload.variants.flatMap((one) => one.files);
    for (const file of published) {
      const served = await fetch(`${base}${file.href}`);
      const digest = createHash('sha256').update(Buffer.from(await served.arrayBuffer())).digest('hex');
      // The published digest is the served one, for every variant and both formats. This is the
      // failure that would be read as tampering, so it is asserted over all six rather than a sample.
      expect(`sha256:${digest}`).toBe(file.digest);
    }
  });

  it('says which copies already sent no longer match, which is the point of publishing digests at all', async () => {
    const { base } = await serve({ outcomes: { 'DG-01-01': 'fail' } });
    const { planId, actionId } = await planned(base);

    await fetch(`${base}/api/improvements/${planId}/export.csv`);
    const before = await read<PlanExportsPayload>(base, `/api/improvements/${planId}/exports`);
    expect(before.taken).toEqual([expect.objectContaining({ current: true })]);

    // The plan moves, which is what a plan does daily and what makes its digests go stale faster than a
    // run's. A recipient who checks the copy they were sent gets a mismatch, and this is the answer to
    // give them: their file predates a move, rather than having been altered.
    await send(base, `/api/improvements/${planId}/actions/${actionId}/move`, { to: 'planned' });

    const after = await read<PlanExportsPayload>(base, `/api/improvements/${planId}/exports`);
    expect(after.taken).toEqual([expect.objectContaining({ current: false })]);
  });

  it('names the run every agreement was judged against, and says so when there is none', async () => {
    const measured = await serve({ outcomes: { 'DG-01-01': 'fail' } });
    const first = await planned(measured.base);
    const judged = await (await fetch(`${measured.base}/api/improvements/${first.planId}/export.json`)).json();
    expect(judged).toMatchObject({ judgedAgainst: { run: 'run-1', at: MEASURED.toISOString() } });

    // A plan written from a workshop on an install that has never run a scan. Every agreement in it
    // reads unclaimed, and a reader who can see there was no run to judge against knows why.
    const unmeasured = await serve();
    const second = await planned(unmeasured.base);
    const text = await (await fetch(`${unmeasured.base}/api/improvements/${second.planId}/export.csv`)).text();
    expect(text).toContain('no run has measured this estate');
  });

  it('reads a claim a run agreed with on older human evidence as unmeasured rather than agreed', async () => {
    // AUD-DEC-107, and it was silently switched off. Fifty-five requirements in this catalogue are
    // answered by somebody's word, and a run reports those met because the answer says so — so an action
    // claiming the work is done, "verified" by a run that agreed on the strength of an attestation
    // recorded before the work started, rests on evidence that predates the claim. `refreshed` decides
    // that from the finding's `attested`, and `judgedAgainst` used to narrow findings to id and outcome,
    // dropping it. An absent `attested` means the app measured the requirement itself, so the rule read
    // every one of those actions as agreed and never fired.
    //
    // It reads `unmeasured` rather than `contradicted`, which is the important half: nobody has been
    // asked since, and the estate is not disagreeing. This is the distinction the `audit` variant exists
    // to carry.
    const claim = new Date('2026-08-02T00:00:00Z');
    const exported = async (attestedAt: Date): Promise<{ agreement: string; unreadable?: string[] }> => {
      const harness = await serve({
        outcomes: { 'DG-01-01': 'pass' },
        attested: { 'DG-01-01': attestedAt },
      });
      // Claimed before the run finished, so the run can speak to the claim at all — otherwise every
      // reading here is `awaiting` and the test would pass without exercising the rule.
      harness.travel(claim);
      const { planId, actionId } = await planned(harness.base);
      await claimed(harness.base, planId, actionId);

      const body = (await (await fetch(`${harness.base}/api/improvements/${planId}/export.json`)).json()) as {
        actions: readonly { agreement: string; unreadable?: string[] }[];
      };
      return body.actions[0] ?? { agreement: 'no action' };
    };

    const before = await exported(new Date('2026-08-01T00:00:00Z'));
    expect(before.agreement).toBe('unmeasured');
    // Named, not just counted, so a reader knows which requirement the hole is in.
    expect(before.unreadable).toEqual(['DG-01-01']);

    // The same run, the same outcome, attested after the claim instead. This half is what proves the
    // first is about the dates rather than about attested evidence being distrusted in general.
    const after = await exported(new Date('2026-08-02T12:00:00Z'));
    expect(after.agreement).toBe('agreed');
    expect(after.unreadable).toEqual([]);
  });

  it('serves on an install with no trail, and publishes digests with nothing taken', async () => {
    const { base } = await serve({ omitTrail: true });
    const { planId } = await planned(base);

    expect((await fetch(`${base}/api/improvements/${planId}/export.csv`)).status).toBe(200);
    const payload = await read<PlanExportsPayload>(base, `/api/improvements/${planId}/exports`);
    // The digests are still worth publishing when nothing recorded who took them.
    expect(payload.variants.flatMap((one) => one.files)).toHaveLength(6);
    expect(payload.taken).toEqual([]);
  });

  it('refuses a plan that does not exist, and one on an install keeping no plans', async () => {
    const { base } = await serve();
    expect((await fetch(`${base}/api/improvements/nobody/export.csv`)).status).toBe(404);
    expect((await fetch(`${base}/api/improvements/nobody/exports`)).status).toBe(404);

    const { base: storeless } = await serve({ omitStore: true });
    expect((await fetch(`${storeless}/api/improvements/anything/export.json`)).status).toBe(404);
  });
});
