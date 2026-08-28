// Reading a run over HTTP, and stopping one by name.
//
// The lease, the checkpoints and the idempotency are tested in `run/`, against the store and against a
// real runner. What is left for a route to get wrong is narrower and worth holding separately: that a
// reader can see a run without holding the group that starts one, that a cancel is gated and recorded
// as something a named person did, and that an install with nothing durable bound says so rather than
// answering with an empty list — because an empty list and "no history is kept" look identical to a
// reader and mean opposite things.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';

import type { RunPayload, RunsPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { accountScope } from '../collect/estate-scope.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import type { Checkpoint, Run, RunAttempt, RunRequest } from '../run/run.js';
import type { Ending, Opened, Opening, RunStore } from '../run/run-store.js';
import { Runs } from '../run/runs.js';
import { ScanRunner } from '../scan/runner.js';
import { InMemoryScanStore } from '../scan/store.js';
import { closeServed, servedAt } from './test-servers.js';
import { registerRunRoutes } from './run-routes.js';

const NOW = new Date('2026-08-06T00:00:00.000Z');
const servers: Server[] = [];

afterAll(() => closeServed(servers));

const ASKED: RunRequest = { scope: accountScope(), lookbackDays: 30 };

function run(overrides: Partial<Run> = {}): Run {
  return {
    id: 'run-1',
    kind: 'assessment',
    requestedAt: NOW,
    actor: 'ada@example.com',
    trigger: 'scheduled',
    request: ASKED,
    state: 'running',
    attempts: 1,
    ...overrides,
  };
}

/**
 * The store, with only the three reads and the one write these routes make.
 *
 * A stub rather than the Postgres store over the fake database, which the store's own tests already do
 * against the real SQL. What a route needs from it is that `cancel` was called with the id from the
 * path — and a stub is the only version of it that can be asserted on.
 */
class Store implements RunStore {
  readonly durable = true;
  readonly cancelled: string[] = [];
  /** How each run ended, for the cancel that concludes a run nothing is working on. */
  readonly ended = new Map<string, Ending>();
  private held: readonly Run[];

  constructor(held: readonly Run[] = []) {
    this.held = held;
  }

  open(_opening: Opening): Promise<Opened> {
    throw new Error('these routes never open a run');
  }

  byKey(key: string): Promise<Run | undefined> {
    return Promise.resolve(this.held.find((one) => one.idempotencyKey === key));
  }

  unfinished(): Promise<readonly Run[]> {
    return Promise.resolve(this.held.filter((one) => one.state === 'running'));
  }

  claim(runId: string, holder: string, at: Date): Promise<RunAttempt | undefined> {
    return Promise.resolve({ id: `${runId}-1`, runId, number: 1, holder, startedAt: at, heartbeatAt: at });
  }

  renew(): Promise<boolean> {
    throw new Error('these routes never renew a claim');
  }

  cancel(runId: string, at: Date): Promise<void> {
    this.cancelled.push(runId);
    this.held = this.held.map((one) => (one.id === runId ? { ...one, cancelRequestedAt: at } : one));
    return Promise.resolve();
  }

  cancelRequested(): Promise<boolean> {
    return Promise.resolve(false);
  }

  checkpoint(): Promise<void> {
    throw new Error('these routes never checkpoint');
  }

  checkpoints(): Promise<readonly Checkpoint[]> {
    return Promise.resolve([]);
  }

  finish(attempt: RunAttempt, ending: Ending): Promise<boolean> {
    this.ended.set(attempt.runId, ending);
    this.held = this.held.map((one) =>
      one.id === attempt.runId
        ? { ...one, state: ending.state, finishedAt: ending.at, ...(ending.why != null ? { why: ending.why } : {}) }
        : one
    );
    return Promise.resolve(true);
  }

  release(): Promise<void> {
    throw new Error('these routes never release a claim');
  }

  get(runId: string): Promise<Run | undefined> {
    return Promise.resolve(this.held.find((one) => one.id === runId));
  }

  recent(limit: number): Promise<readonly Run[]> {
    return Promise.resolve(this.held.slice(0, limit));
  }

  attempts(): Promise<readonly RunAttempt[]> {
    return Promise.resolve([]);
  }
}

interface Recorded {
  readonly action: AuditAction;
  outcome?: 'performed' | 'failed' | 'refused';
  target?: AuditTarget;
  reason?: string;
}

interface Harness {
  readonly base: string;
  readonly acts: Recorded[];
  readonly store: Store;
}

async function serve(
  options: {
    readonly held?: readonly Run[];
    /** Set to refuse every mutation, as the gate does for somebody outside the assessor group. */
    readonly refuse?: boolean;
    readonly nothingRecorded?: boolean;
  } = {}
): Promise<Harness> {
  const acts: Recorded[] = [];
  const store = new Store(options.held ?? []);
  // Not started here: the routes read and cancel, and a cancel of a run this process does not hold never
  // reaches the runner. A throw from `cancel` is the assertion that none of these fixtures hold one.
  const runner = new ScanRunner({
    catalogue: loadCatalogue(),
    registry: buildRegistry(),
    store: new InMemoryScanStore(),
  });

  const app = express();
  app.use(express.json());
  registerRunRoutes(app, {
    ...(options.nothingRecorded === true ? {} : { runs: new Runs({ store, runner, now: () => NOW }) }),
    now: () => NOW,
    permitted: (_request: Request, response: Response, action: AuditAction, context) => {
      const recorded: Recorded = { action, ...(context?.target != null ? { target: context.target } : {}) };
      acts.push(recorded);
      if (options.refuse === true) {
        recorded.outcome = 'refused';
        response.status(403).json({ error: 'permission', message: 'Not a member of the assessor group.' });
        throw new Error('refused');
      }
      const act: Act = {
        performed: (target) => {
          recorded.outcome = 'performed';
          if (target != null) recorded.target = target;
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
  return { base, acts, store };
}

describe('listing the runs', () => {
  it('answers with them newest first, as the store holds them', async () => {
    const { base } = await serve({
      held: [run({ id: 'run-2' }), run({ id: 'run-1', state: 'complete', scanId: 'scan-1' })],
    });

    const response = await fetch(`${base}/api/runs`);
    const payload = (await response.json()) as RunsPayload;

    expect(response.status).toBe(200);
    expect(payload.durable).toBe(true);
    expect(payload.runs.map((one) => one.id)).toEqual(['run-2', 'run-1']);
    expect(payload.unavailable).toBeUndefined();
  });

  it('answers by key, for a supervisor whose trigger never came back with an id', async () => {
    const { base } = await serve({
      held: [run({ id: 'run-2' }), run({ id: 'run-1', idempotencyKey: 'nightly-2026-08-06' })],
    });

    const found = (await (await fetch(`${base}/api/runs?key=nightly-2026-08-06`)).json()) as RunsPayload;
    const missing = (await (await fetch(`${base}/api/runs?key=nothing-asked-this`)).json()) as RunsPayload;

    expect(found.runs.map((one) => one.id)).toEqual(['run-1']);
    // Empty rather than a 404: the question is "what does this key name", and "nothing" is an answer to
    // it. A supervisor retrying a key it has not used yet is not making a mistake.
    expect(missing.runs).toEqual([]);
    expect(missing.durable).toBe(true);
  });

  it('answers with what is still going anywhere, which is not what this process is doing', async () => {
    const { base } = await serve({
      held: [run({ id: 'run-2' }), run({ id: 'run-1', state: 'complete', scanId: 'scan-1' })],
    });

    const going = (await (await fetch(`${base}/api/runs?unfinished=true`)).json()) as RunsPayload;

    expect(going.runs.map((one) => one.id)).toEqual(['run-2']);
  });

  it('is readable without the group that starts a scan, because reading whether one happened is not starting one', async () => {
    const { base, acts } = await serve({ held: [run()], refuse: true });

    const response = await fetch(`${base}/api/runs`);

    expect(response.status).toBe(200);
    expect(acts).toEqual([]);
  });

  it('says nothing is kept rather than reporting no runs, where the install records none', async () => {
    const { base } = await serve({ nothingRecorded: true });

    const response = await fetch(`${base}/api/runs`);
    const payload = (await response.json()) as RunsPayload;

    // 200 rather than an error: "nothing is recorded" is a complete answer to the question asked.
    expect(response.status).toBe(200);
    expect(payload.durable).toBe(false);
    expect(payload.runs).toEqual([]);
    expect(payload.unavailable).toContain('keeps no run records');
  });
});

describe('reading one run', () => {
  it('reports what became of it, and the scan it produced', async () => {
    const finishedAt = new Date('2026-08-06T00:12:00.000Z');
    const { base } = await serve({
      held: [run({ state: 'partial', attempts: 2, scanId: 'scan-9', finishedAt, why: 'The warehouse was asleep.' })],
    });

    const payload = (await (await fetch(`${base}/api/runs/run-1`)).json()) as RunPayload;

    expect(payload).toMatchObject({
      id: 'run-1',
      state: 'partial',
      attempts: 2,
      scanId: 'scan-9',
      finishedAt: finishedAt.toISOString(),
      why: 'The warehouse was asleep.',
      lookbackDays: 30,
    });
    expect(payload.heldUntil).toBeUndefined();
  });

  it('reports a lapsed lease as nothing holding the run, because that is what it means', async () => {
    const lapsed = new Date(NOW.getTime() - 60_000);
    const { base } = await serve({ held: [run({ lease: { holder: 'gone', until: lapsed } })] });

    const payload = (await (await fetch(`${base}/api/runs/run-1`)).json()) as RunPayload;

    expect(payload.state).toBe('running');
    expect(payload.heldUntil).toBeUndefined();
  });

  it('reports a live lease, so a supervisor knows to wait rather than retry', async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const { base } = await serve({ held: [run({ lease: { holder: 'someone', until } })] });

    const payload = (await (await fetch(`${base}/api/runs/run-1`)).json()) as RunPayload;

    expect(payload.heldUntil).toBe(until.toISOString());
  });

  it('is a 404 for an id nothing knows, which is not the same answer as an install that records nothing', async () => {
    const { base } = await serve({ held: [run()] });

    const missing = await fetch(`${base}/api/runs/run-404`);
    const nothing = await serve({ nothingRecorded: true });
    const unrecorded = await fetch(`${nothing.base}/api/runs/run-1`);

    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { error: string }).error).toBe('no-such-run');
    // A supervisor polling an id it was given has to tell "your run is gone" from "this app never keeps
    // runs", because the first is a fault and the second is a configuration.
    expect(unrecorded.status).toBe(409);
    expect(((await unrecorded.json()) as { error: string }).error).toBe('nothing-recorded');
  });
});

describe('cancelling a run by name', () => {
  it('records the request against the run it names, and says so as a named act', async () => {
    const { base, acts, store } = await serve({ held: [run()] });

    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });
    const payload = (await response.json()) as RunPayload;

    expect(response.status).toBe(200);
    expect(store.cancelled).toEqual(['run-1']);
    expect(acts).toEqual([{ action: 'scan.cancel', target: { kind: 'run', id: 'run-1' }, outcome: 'performed' }]);
    // Read back rather than echoed, so a run nothing was working on comes back ended rather than
    // looking like one that has been asked and might still be going.
    expect(payload.state).toBe('cancelled');
    expect(store.ended.get('run-1')?.why).toContain('no process was working on it');
  });

  it('names the advisor when the run it stopped was an advisory one', async () => {
    const { base, acts } = await serve({ held: [run({ kind: 'advisory' })] });

    await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });

    // Not `scan.cancel`. A trail where both kinds read as a cancelled scan would put an assessment
    // ending at a time when none did, which is the one question an auditor asks this table.
    expect(acts).toEqual([{ action: 'advisory.cancel', target: { kind: 'run', id: 'run-1' }, outcome: 'performed' }]);
  });

  it('leaves a run another process is working on for that process to stop', async () => {
    const until = new Date(NOW.getTime() + 60_000);
    const { base, store } = await serve({ held: [run({ lease: { holder: 'somewhere-else', until } })] });

    const payload = (await (await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' })).json()) as RunPayload;

    // The flag is the whole mechanism here: concluding it from this process would end a run while
    // another one is still collecting for it, and the scan it saves would land on a finished record.
    expect(store.cancelled).toEqual(['run-1']);
    expect(store.ended.has('run-1')).toBe(false);
    expect(payload.state).toBe('running');
    expect(payload.heldUntil).toBe(until.toISOString());
  });

  it('is refused for somebody outside the assessor group, and nothing is written', async () => {
    const { base, acts, store } = await serve({ held: [run()], refuse: true });

    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });

    expect(response.status).toBe(403);
    expect(store.cancelled).toEqual([]);
    expect(acts[0]?.outcome).toBe('refused');
  });

  it('is recorded as failed where the run does not exist, so the trail never claims a run ended', async () => {
    const { base, acts, store } = await serve({ held: [] });

    const response = await fetch(`${base}/api/runs/run-404/cancel`, { method: 'POST' });

    expect(response.status).toBe(404);
    expect(store.cancelled).toEqual([]);
    // What an auditor takes from "somebody cancelled at 14:02" is that a run ended there. Recording a
    // cancellation that stopped nothing would make that reading false.
    expect(acts[0]).toMatchObject({ outcome: 'failed', reason: 'no-such-run' });
  });

  it('is refused for a run that already finished, and the trail does not say a run ended there', async () => {
    const finishedAt = new Date(NOW.getTime() - 3_600_000);
    const { base, acts, store } = await serve({ held: [run({ state: 'complete', scanId: 'scan-9', finishedAt })] });

    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });
    const payload = (await response.json()) as { error: string; message: string; run?: RunPayload };

    // 409 rather than 404, because the run is here and readable and what it says is why this arrived too
    // late. A 200 would tell a supervisor its retry was called off when nothing was called off.
    expect(response.status).toBe(409);
    expect(payload.error).toBe('already-ended');
    expect(payload.message).toContain('complete');
    expect(payload.run?.scanId).toBe('scan-9');
    // And no cancel date is written onto a finished run for a later reader to explain away.
    expect(store.cancelled).toEqual([]);
    expect(acts[0]).toMatchObject({ outcome: 'failed', reason: 'already-ended' });
  });

  it('is refused where nothing is recorded, because there is no run to name', async () => {
    const { base, acts } = await serve({ nothingRecorded: true });

    const response = await fetch(`${base}/api/runs/run-1/cancel`, { method: 'POST' });

    expect(response.status).toBe(409);
    expect(acts[0]).toMatchObject({ outcome: 'failed', reason: 'nothing-recorded' });
  });
});
