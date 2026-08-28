// Asking for a claim to be checked, and taking the question back.
//
// The record, its lifecycle and the freshness rule are tested in `validate/attempt.test.ts`, and the
// store against the fake database in `validate/store.test.ts`. What is worth holding here is what only
// a route can get wrong.
//
// Two of those are why this file exists. Nothing may answer an attempt over HTTP — a run answers one,
// and an endpoint that could would be "somebody marked it verified" one layer down. And `mayRequest`
// has to agree with what a request would actually do, because a surface that offers a button the server
// refuses is worse than one that offers nothing.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { ValidationAttemptPayload, ValidationsPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import type { Measurability } from '../catalogue/catalogue.js';
import { moved, type ImprovementAction } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import { InMemoryImprovementStore, type ImprovementStore } from '../improve/store.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { InMemoryValidationStore, type ValidationStore } from '../validate/store.js';
import { registerValidateRoutes } from './validate-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const OPENED = new Date('2026-08-01T09:00:00.000Z');
const CLAIMED = new Date('2026-08-03T09:00:00.000Z');
const NOW = new Date('2026-08-04T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const MEASURABILITY: Readonly<Record<string, Measurability>> = {
  'DG-01-01': 'system-table',
  'SEC-02-04': 'attestation',
};

const TITLES: Readonly<Record<string, string>> = {
  'DG-01-01': 'Every table has an owner',
  'SEC-02-04': 'Serverless egress is controlled',
};

const IN_MEMORY = 'Validations are being kept in memory on this installation and are lost on a restart.';

class Refused extends Error {}

interface Harness {
  readonly base: string;
  readonly actions: ImprovementStore;
  readonly validations: ValidationStore;
  readonly audit: AuditLog;
}

const PLAN_ID = 'plan-1';
const ACTION_ID = 'action-1';

function plan(): ImprovementPlan {
  return {
    id: PLAN_ID,
    title: 'Q3 governance',
    outcome: 'Every production table has a named owner and an access review behind it.',
    owners: ['priya@example.com'],
    createdBy: 'priya@example.com',
    createdAt: OPENED,
    revision: 0,
  };
}

/** An action in `draft`, walked to wherever a test needs it by `moved`. */
function drafted(controlIds: readonly string[] = ['DG-01-01']): ImprovementAction {
  return {
    id: ACTION_ID,
    planId: PLAN_ID,
    controlIds,
    outcome: 'Ownership is assigned on every production table, so an access review has somebody to ask.',
    definitionOfDone: 'Every table in the prod catalogue has an owner recorded, checked by the ownership query.',
    owner: 'sam@example.com',
    due: new Date('2026-08-14T00:00:00.000Z'),
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: 'draft',
    createdBy: 'priya@example.com',
    createdAt: OPENED,
    history: [],
    revision: 0,
  };
}

/** The action as its owner left it: planned, started, and claimed done at `CLAIMED`. */
function claimed(controlIds?: readonly string[]): ImprovementAction {
  const who = 'sam@example.com';
  let action = moved(drafted(controlIds), { to: 'planned', who, at: OPENED });
  action = moved(action, { to: 'in-progress', who, at: OPENED });
  return moved(action, { to: 'ready-for-validation', who, at: CLAIMED });
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly omitActions?: boolean;
    readonly permit?: boolean;
    /** The action in the store. Absent means the claimed one; null means the store has none. */
    readonly action?: ImprovementAction | null;
    readonly measurabilityOf?: (controlId: string) => Measurability | undefined;
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const actions = new InMemoryImprovementStore();
  const action = over.action === undefined ? claimed() : over.action;
  if (action != null) {
    await actions.addPlan(plan());
    await actions.addAction(action, plan());
  }

  const validations = new InMemoryValidationStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;

  registerValidateRoutes(app, {
    ...(over.omitStore === true ? {} : { validations }),
    ...(over.omitActions === true ? {} : { improvements: actions }),
    validationStorage: IN_MEMORY,
    measurabilityOf: over.measurabilityOf ?? ((controlId) => MEASURABILITY[controlId]),
    titleOf: (controlId) => TITLES[controlId],
    now: () => NOW,
    newId: () => `validation-${String((minted += 1))}`,
    // The real recorder over an in-memory log rather than a stub act, for the reason the sibling route
    // tests give: the routes are the only place the events are composed, so a fake act would leave
    // nothing checking that a request records the action it was about.
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
  return { base, actions, validations, audit };
}

/** The collection, which is addressed under the action rather than on its own. */
const AT = `/api/improvements/${PLAN_ID}/actions/${ACTION_ID}/validations`;

async function send(base: string, path: string, body?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: await parsed(response) };
}

async function read(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await parsed(response) };
}

/** The body where there is one and it is JSON: a route that does not exist answers in HTML. */
async function parsed(response: Response_): Promise<unknown> {
  const text = await response.text();
  if (text === '' || !(response.headers.get('content-type') ?? '').includes('json')) return undefined;
  return JSON.parse(text);
}

type Response_ = Awaited<ReturnType<typeof fetch>>;

/** Every act the routes recorded, oldest first, which is the order they happened in. */
async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id ?? event.reason] as const);
}

describe('asking for a validation', () => {
  it('records the attempt against the claim, with the method taken from the catalogue', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, AT);
    const attempt = body as ValidationAttemptPayload;

    expect(status).toBe(201);
    expect(attempt).toMatchObject({
      id: 'validation-1',
      actionId: ACTION_ID,
      planId: PLAN_ID,
      requestedBy: 'priya@example.com',
      requestedAt: NOW.toISOString(),
      observeDays: 0,
    });
    expect(attempt.checks).toEqual([{ controlId: 'DG-01-01', method: 'measured', title: 'Every table has an owner' }]);
    // From the action's history rather than from the request: the line every date in the attempt is
    // measured against cannot be something the requester chooses.
    expect(attempt.claimedAt).toBe(CLAIMED.toISOString());
    expect(attempt.answer).toBeUndefined();
  });

  it('records the act against the action rather than against the attempt', async () => {
    // The question an auditor asks is what happened to this piece of work, and one search over the
    // action answers it across the raising, the moves and the validations. An attempt id answers a
    // question nobody has.
    const harness = await serve();

    await send(harness.base, AT);

    await expect(acts(harness.audit)).resolves.toEqual([['validation.request', 'performed', ACTION_ID]]);
  });

  it('takes the observation window from the body', async () => {
    const harness = await serve();

    const { body } = await send(harness.base, AT, { observeDays: 3 });

    expect(body).toMatchObject({
      observeDays: 3,
      observeFrom: new Date(NOW.getTime() + 3 * DAY_MS).toISOString(),
    });
  });

  it('refuses a window past the cap the reading advertises', async () => {
    const harness = await serve();
    const { maxObserveDays } = (await read(harness.base, AT)).body as ValidationsPayload;

    const { status, body } = await send(harness.base, AT, { observeDays: maxObserveDays + 1 });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-validation' });
    expect(await harness.validations.outstanding()).toEqual([]);
  });

  it('will not let the request choose how a requirement is answered', async () => {
    // The defect one layer below the one this record closes: a requester who could choose could
    // validate a measurable requirement by attesting to it.
    const harness = await serve();

    const { body } = await send(harness.base, AT, { method: 'attested', checks: [{ controlId: 'DG-01-01' }] });

    expect((body as ValidationAttemptPayload).checks).toEqual([
      { controlId: 'DG-01-01', method: 'measured', title: 'Every table has an owner' },
    ]);
  });

  it('marks a requirement only somebody can answer as attested, from the catalogue', async () => {
    const harness = await serve({ action: claimed(['SEC-02-04']) });

    const { body } = await send(harness.base, AT);

    expect((body as ValidationAttemptPayload).checks).toEqual([
      { controlId: 'SEC-02-04', method: 'attested', title: 'Serverless egress is controlled' },
    ]);
  });

  it('refuses a claim nobody has made, in the domain’s words', async () => {
    const harness = await serve({ action: drafted() });

    const { status, body } = await send(harness.base, AT);

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('has not said it is finished');
  });

  it('refuses a second while one is outstanding, and says what it is waiting for', async () => {
    const harness = await serve();
    await send(harness.base, AT);

    const { status, body } = await send(harness.base, AT);

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('already outstanding');
    expect(await harness.validations.outstanding()).toHaveLength(1);
  });

  it('refuses a requirement this framework no longer has', async () => {
    const harness = await serve({ measurabilityOf: () => undefined });

    const { status, body } = await send(harness.base, AT);

    expect(status).toBe(400);
    expect((body as { message: string }).message).toContain('DG-01-01');
  });

  it('refuses an action it cannot find, and says which one in the event', async () => {
    const harness = await serve({ action: null });

    const { status, body } = await send(harness.base, AT);

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-action' });
    const { events } = await harness.audit.search();
    expect(events).toMatchObject([
      { action: 'validation.request', outcome: 'failed', target: { id: ACTION_ID }, reason: 'unknown-action' },
    ]);
  });

  it('is refused before anything is composed when the caller may not ask', async () => {
    const harness = await serve({ permit: false });

    const { status } = await send(harness.base, AT);

    expect(status).toBe(403);
    expect(await harness.validations.outstanding()).toEqual([]);
  });

  it('says there is nowhere to put one rather than losing it', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body } = await send(harness.base, AT);

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'validations-unavailable' });
  });

  it('says there are no claims to validate when plans are not kept', async () => {
    const harness = await serve({ omitActions: true });

    expect((await send(harness.base, AT)).status).toBe(503);
    expect((await read(harness.base, AT)).status).toBe(404);
  });
});

describe('reading the attempts against an action', () => {
  it('says a validation may be asked for, with the cap the server enforces', async () => {
    const harness = await serve();

    const { status, body } = await read(harness.base, AT);
    const payload = body as ValidationsPayload;

    expect(status).toBe(200);
    expect(payload).toMatchObject({ actionId: ACTION_ID, attempts: [], mayRequest: true, durable: false });
    expect(payload.maxObserveDays).toBeGreaterThan(0);
    expect(payload.whyNot).toBeUndefined();
    expect(payload.durabilityNote).toBe(IN_MEMORY);
  });

  it('says why not, in the same words a request would be refused with', async () => {
    // The whole reason this is on the wire: a client deciding for itself would be a second copy of the
    // rule, and the copy is what offers a button that 400s.
    const harness = await serve({ action: drafted() });

    const { body } = await read(harness.base, AT);
    const refused = await send(harness.base, AT);

    expect((body as ValidationsPayload).mayRequest).toBe(false);
    expect((body as ValidationsPayload).whyNot).toBe((refused.body as { message: string }).message);
  });

  it('stops offering one while an attempt is outstanding', async () => {
    const harness = await serve();
    await send(harness.base, AT);

    const payload = (await read(harness.base, AT)).body as ValidationsPayload;

    expect(payload.mayRequest).toBe(false);
    expect(payload.whyNot).toContain('already outstanding');
    expect(payload.attempts).toHaveLength(1);
  });

  it('has no endpoint that answers one', async () => {
    // A run answers an attempt, from the resolution path after a scan is saved. An endpoint that took
    // an answer would be the defect ADR 0051 closed, wearing a validation's clothes.
    const harness = await serve();
    await send(harness.base, AT);

    const answered = await send(harness.base, `${AT}/validation-1/answer`, { result: 'passed' });

    expect(answered.status).toBe(404);
    expect((await harness.validations.for(ACTION_ID))[0]?.answer).toBeUndefined();
  });

  it('is 404 for an action this install does not have', async () => {
    const harness = await serve({ action: null });

    const { status, body } = await read(harness.base, AT);

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-action' });
  });

  it('reads as a list nobody can add to when validations are not kept', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body } = await read(harness.base, AT);

    expect(status).toBe(200);
    expect(body).toMatchObject({ attempts: [], mayRequest: false, durable: false });
    expect((body as ValidationsPayload).whyNot).toContain('nowhere to record one');
  });
});

describe('withdrawing a claim', () => {
  it('closes the attempt as unfinished, naming who took it back and why', async () => {
    const harness = await serve();
    await send(harness.base, AT);

    const { status, body } = await send(harness.base, `${AT}/validation-1/withdraw`, {
      reason: 'we tested the wrong workspace',
    });
    const attempt = body as ValidationAttemptPayload;

    expect(status).toBe(200);
    expect(attempt.answer).toMatchObject({ result: 'incomplete', unmet: [], at: NOW.toISOString() });
    // No run, because nothing measured anything: an answer with a result and no scan is a withdrawal.
    expect(attempt.answer?.scanId).toBeUndefined();
    expect(attempt.answer?.why).toContain('priya@example.com withdrew the claim');
    expect(attempt.answer?.why).toContain('wrong workspace');
  });

  it('stands without a reason, since the question was taken back before anything answered it', async () => {
    const harness = await serve();
    await send(harness.base, AT);

    const { status, body } = await send(harness.base, `${AT}/validation-1/withdraw`);

    expect(status).toBe(200);
    expect((body as ValidationAttemptPayload).answer?.why).toContain('withdrew the claim');
  });

  it('permits another once the question has been taken back', async () => {
    const harness = await serve();
    await send(harness.base, AT);
    await send(harness.base, `${AT}/validation-1/withdraw`);

    expect((await read(harness.base, AT)).body).toMatchObject({ mayRequest: true });
    expect((await send(harness.base, AT)).status).toBe(201);
  });

  it('keeps the withdrawn attempt on the record rather than removing it', async () => {
    const harness = await serve();
    await send(harness.base, AT);
    await send(harness.base, `${AT}/validation-1/withdraw`);
    await send(harness.base, AT);

    const payload = (await read(harness.base, AT)).body as ValidationsPayload;

    // By id rather than by position: both were requested in the same frozen instant, so the order
    // between them is not something the reading promises.
    expect(payload.attempts.find((one) => one.id === 'validation-1')?.answer?.result).toBe('incomplete');
    expect(payload.attempts.find((one) => one.id === 'validation-2')?.answer).toBeUndefined();
  });

  it('does not move the action, which is a separate act with its own event', async () => {
    const harness = await serve();
    await send(harness.base, AT);
    await send(harness.base, `${AT}/validation-1/withdraw`);

    expect((await harness.actions.action(ACTION_ID))?.state).toBe('ready-for-validation');
    await expect(acts(harness.audit)).resolves.toEqual([
      ['validation.request', 'performed', ACTION_ID],
      ['validation.withdraw', 'performed', ACTION_ID],
    ]);
  });

  it('refuses to unsay an answer a run has already given', async () => {
    const harness = await serve();
    await send(harness.base, AT);
    // Answered the way the resolution path does it, because there is no route that answers one.
    const [outstanding] = await harness.validations.outstanding();
    await harness.validations.answer({
      ...outstanding,
      answer: { result: 'failed', scanId: 'run-9', at: NOW, unmet: ['DG-01-01'], unreadable: [] },
    });

    const { status, body } = await send(harness.base, `${AT}/validation-1/withdraw`);

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already-answered' });
    expect((await harness.validations.for(ACTION_ID))[0]?.answer?.scanId).toBe('run-9');
  });

  it('is 404 for a validation that is not against this action', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, `${AT}/validation-9/withdraw`);

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-validation' });
  });
});
