// The advisor's endpoints, against a real server.
//
// Served with `registerAdvisoryRoutes` alone rather than the whole API, for the reason the run routes'
// tests give: the gate and the request resolver are injected, so what is under test is the route's own
// decisions — which status a missing record gets, what a build with no advisor says, and whether an
// unattended caller is told that a run which saw nothing is a failure.

import { afterAll, describe, expect, it } from 'vitest';
import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';

import type { AdvisoryHistoryPayload, AdvisoryPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import type { Act } from '../audit/record.js';
import { accountScope, type EstateScope } from '../collect/estate-scope.js';
import { observed, unmeasurable, type Collector, type SignalResult } from '../collect/signal.js';
import type { CredentialProvider } from '../collect/credentials.js';
import { ADVISORY_SIGNALS, AdvisoryRunner, type AdvisoryRunRequest } from '../advise/runner.js';
import { InMemoryAdvisoryStore } from '../advise/store.js';
import type { Advisory } from '../advise/advisory.js';
import { Runs } from '../run/runs.js';
import { PostgresRunStore } from '../run/run-store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { ScanRunner } from '../scan/runner.js';
import { InMemoryScanStore } from '../scan/store.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { closeServed, servedAt } from './test-servers.js';
import { registerAdvisoryRoutes } from './advisory-routes.js';

const servers: Server[] = [];
afterAll(() => closeServed(servers));

const asUser: CredentialProvider = {
  mode: 'on-behalf-of-user',
  databricks: () =>
    Promise.resolve({
      mode: 'on-behalf-of-user',
      actor: 'priya@example.com',
      host: 'https://example.cloud.databricks.com',
      token: () => Promise.resolve('t'),
    }),
  cloud: () => Promise.resolve(null),
};

const DIRECTORY = {
  workspaces: [
    {
      workspaceId: 'w1',
      name: 'ws-1',
      url: 'https://example.cloud.databricks.com',
      status: 'RUNNING',
    },
  ],
  live: [
    {
      workspaceId: 'w1',
      name: 'ws-1',
      url: 'https://example.cloud.databricks.com',
      status: 'RUNNING',
    },
  ],
  excluded: [],
};

/** A collector that answers every advisory signal, with nothing interesting in the rows. */
function seeing(): Collector {
  return {
    surface: 'sql',
    name: 'sql',
    signals: [...ADVISORY_SIGNALS],
    collect: (ids): Promise<SignalResult[]> =>
      Promise.resolve(ids.map((id) => observed(id, id === 'sql:estate.workspaces' ? DIRECTORY : [], 0))),
  };
}

/*
 * One that answers the two sizing signals with a warehouse that idled.
 *
 * The numbers are the labs reading of the app's own warehouse with the self share removed: up for two days,
 * 5.7% of paid cluster time spent executing. Real numbers rather than round ones, because the encoder's job
 * is to hand the page a warehouse a reader can act on and the thresholds were fitted to this shape.
 */
function idling(): Collector {
  const pressure = {
    workspaceId: 'w1',
    warehouseId: 'wh-1',
    runs: 4896,
    measured: 4526,
    totalMs: 16_600_028,
    busyMs: 10_156_957,
    queueMs: 0,
    selfMs: 0,
    spilledBytes: 0,
    peakUsers: 3,
    daysUsed: 7,
    daysQueued: 0,
    daysSpilled: 0,
    p95Ms: 11_829,
    worstMs: 34_750,
    upMs: 179_076_023,
    clusterMs: 179_110_176,
    starts: 455,
    peakClusters: 2,
    daysSeen: 7,
    executionPercent: 5.7,
    queuePercent: 0,
    warehousePopulation: 5,
  };
  const inventory = {
    workspaceId: 'w1',
    warehouseId: 'wh-1',
    name: 'cost-wh',
    serverless: true,
    size: 'X_SMALL',
    minClusters: 1,
    maxClusters: 1,
    autoStopMinutes: 5,
  };

  return {
    surface: 'sql',
    name: 'sql',
    signals: [...ADVISORY_SIGNALS],
    collect: (ids): Promise<SignalResult[]> =>
      Promise.resolve(
        ids.map((id) => {
          if (id === 'sql:estate.workspaces') return observed(id, DIRECTORY, 0);
          if (id === 'sql:workload.warehouse_pressure') return observed(id, [pressure], 1);
          if (id === 'sql:compute.warehouses') return observed(id, [inventory], 1);
          return observed(id, [], 0);
        })
      ),
  };
}

/** One that can read none of them, which is the case a scheduled caller has to be told about. */
function blind(): Collector {
  return {
    surface: 'sql',
    name: 'sql',
    signals: [...ADVISORY_SIGNALS],
    collect: (ids): Promise<SignalResult[]> =>
      Promise.resolve(ids.map((id) => unmeasurable(id, 'The warehouse refused the statement.'))),
  };
}

interface Recorded {
  readonly action: AuditAction;
  outcome?: 'performed' | 'failed' | 'refused';
  target?: AuditTarget;
}

interface Harness {
  readonly base: string;
  readonly acts: Recorded[];
  readonly advisories: InMemoryAdvisoryStore;
}

async function serve(
  options: {
    /** Set to serve a build with no advisor at all. */
    readonly noAdvisor?: boolean;
    readonly collector?: Collector;
    readonly refuse?: boolean;
    readonly held?: readonly Advisory[];
  } = {}
): Promise<Harness> {
  const acts: Recorded[] = [];
  const advisories = new InMemoryAdvisoryStore();
  for (const one of options.held ?? []) await advisories.save(one);

  const db = new FakePostgres({
    keys: { run_checkpoints: ['run_id', 'signal_id'] },
    unique: { runs: ['idempotency_key'] },
  });
  const advisor = new AdvisoryRunner({ store: advisories });
  const runs = new Runs({
    store: new PostgresRunStore(db),
    runner: new ScanRunner({ catalogue: loadCatalogue(), registry: buildRegistry(), store: new InMemoryScanStore() }),
    advisor,
  });

  const app = express();
  app.use(express.json());
  registerAdvisoryRoutes(app, {
    ...(options.noAdvisor === true ? {} : { advisories, runs }),
    asking: (_request: Request, _actor: string, granted: EstateScope): Promise<AdvisoryRunRequest> =>
      Promise.resolve({
        credentials: asUser,
        scope: granted,
        collectors: [options.collector ?? seeing()],
        lookbackDays: 30,
        warehouse: 'wh-1',
      }),
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
        failed: () => {
          recorded.outcome = 'failed';
          return Promise.resolve();
        },
        settle: () => Promise.resolve(),
      };
      return Promise.resolve({ actor: 'priya@example.com', scope: accountScope(), act });
    },
    respondToFailure: (response: Response, cause: unknown) => {
      if (response.headersSent) return;
      response.status(500).json({ error: 'failed', message: cause instanceof Error ? cause.message : String(cause) });
    },
  });

  const base = await servedAt(app, servers);
  return { base, acts, advisories };
}

describe('starting an advisory run', () => {
  it('answers the interactive caller with the analysis, and records the act against the run', async () => {
    const { base, acts, advisories } = await serve();

    const response = await fetch(`${base}/api/advisory`, { method: 'POST' });
    const payload = (await response.json()) as AdvisoryPayload;

    expect(response.status).toBe(200);
    expect(payload.state).toBe('complete');
    expect(payload.sighted).toBe(true);
    expect(payload.actor).toBe('priya@example.com');
    expect(payload.lookbackDays).toBe(30);
    // The requirements the analysis elaborates travel with it, so the page reads one payload whether it
    // came from here or, before row 33d moved it, from a scan.
    expect(payload.serverless?.explains).toBeDefined();

    expect(acts).toHaveLength(1);
    expect(acts[0]?.action).toBe('advisory.start');
    expect(acts[0]?.outcome).toBe('performed');
    // Against the run rather than the advisory, because the run is what somebody asked for and the
    // advisory is what it happened to produce. A trail keyed on the output has nothing to say about a
    // run that failed.
    expect(acts[0]?.target).toEqual({ kind: 'run', id: payload.runId });
    // On the record, not just in the response: the whole point of the store is that somebody can come
    // back to the advice next week.
    expect(await advisories.get(payload.id)).toBeDefined();
  });

  /*
   * The sizing payload, end to end through the encoder.
   *
   * Asserted here rather than only in the analyzer's own tests because the encoder is where the rule's words
   * are attached: the analysis carries a rule id and a severity, and everything a reader acts on — the
   * headline, what to do about it, the documentation link — is looked up from the ruleset on the way out. A
   * finding that arrives with an id and no sentence is a badge nobody can act on.
   */
  it('hands the page a sized warehouse with the rule words attached', async () => {
    const { base } = await serve({ collector: idling() });

    const response = await fetch(`${base}/api/advisory`, { method: 'POST' });
    const payload = (await response.json()) as AdvisoryPayload;
    const sizing = payload.sizing;
    const warehouse = sizing?.warehouses[0];

    expect(sizing?.windowDays).toBe(7);
    expect(sizing?.used).toBe(1);
    expect(sizing?.population).toBe(5);
    expect(sizing?.matched).toBe(1);
    expect(sizing?.live).toBe(1);
    expect(sizing?.findingCount).toBe(1);

    expect(warehouse?.name).toBe('cost-wh');
    expect(warehouse?.link).toBe('https://example.cloud.databricks.com/sql/warehouses/wh-1?o=w1');
    expect(warehouse?.state).toBe('advised');
    // The ladder's spelling on both, so "the next size down from X-Small" reads as one vocabulary.
    expect(warehouse?.size).toBe('X-Small');
    expect(warehouse?.nextSizeDown).toBe('2X-Small');
    expect(warehouse?.executionPercent).toBe(5.7);

    const finding = warehouse?.findings[0];
    expect(finding?.rule).toBe('WAREHOUSE_IDLE_UPTIME');
    expect(finding?.confidence).toBe('moderate');
    expect(finding?.action).toBe("Consolidate this warehouse's work into fewer active windows");
    expect(finding?.headline).toBeTruthy();
    expect(finding?.detail).toContain('auto-stop');
    expect(finding?.docUrl).toContain('docs.databricks.com');
    // An extension, so it has to say why it exists where no design document names it.
    expect(finding?.rationale).toBeTruthy();
    // Never empty: a finding a reader cannot check is one they have to trust.
    expect(finding?.evidence.length).toBeGreaterThan(0);
  });

  it('says nothing about sizing where the pressure statement could not be read', async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/api/advisory`, { method: 'POST' });
    const payload = (await response.json()) as AdvisoryPayload;

    // Absent rather than an empty analysis, which would render as an estate whose warehouses are all the
    // right size — a conclusion this run did not reach.
    expect(payload.sizing).toBeUndefined();
  });

  it('tells a scheduled caller the ids and the counts, and nothing else', async () => {
    const { base } = await serve();

    const response = await fetch(`${base}/api/advisory/scheduled`, { method: 'POST' });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(Object.keys(payload).sort()).toEqual(['advisory', 'considered', 'run', 'state']);
  });

  it('fails a scheduled run that could read nothing, rather than reporting it green', async () => {
    const { base } = await serve({ collector: blind() });

    const response = await fetch(`${base}/api/advisory/scheduled`, { method: 'POST' });
    const payload = (await response.json()) as Record<string, unknown>;

    // 422 rather than 200, because a task that succeeds having seen nothing is a task nobody looks at,
    // and the estate being invisible is exactly the thing somebody has to act on.
    expect(response.status).toBe(422);
    expect(payload.error).toBe('nothing-readable');
    // The ids are still there, because the run happened and its readings name which grant was missing.
    expect(typeof payload.advisory).toBe('string');
  });

  it('records the refusal and starts nothing when the caller may not', async () => {
    const { base, acts, advisories } = await serve({ refuse: true });

    const response = await fetch(`${base}/api/advisory`, { method: 'POST' });

    expect(response.status).toBe(403);
    expect(acts).toEqual([{ action: 'advisory.start', outcome: 'refused' }]);
    expect(await advisories.latest()).toBeUndefined();
  });

  it('refuses where the build has no advisor', async () => {
    const { base, acts } = await serve({ noAdvisor: true });

    const response = await fetch(`${base}/api/advisory`, { method: 'POST' });
    const payload = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(409);
    expect(payload.error).toBe('no-advisor');
    // Refused before the gate, so nothing is recorded: there was no act to permit or refuse, and a
    // trail line saying somebody was allowed to do a thing this build cannot do is noise.
    expect(acts).toEqual([]);
  });
});

describe('reading what the advisor concluded', () => {
  it('answers the latest run, and 404s before anything has run', async () => {
    const { base } = await serve();

    const before = await fetch(`${base}/api/advisory/latest`);
    expect(before.status).toBe(404);
    expect(((await before.json()) as Record<string, unknown>).error).toBe('nothing-yet');

    await fetch(`${base}/api/advisory`, { method: 'POST' });

    const after = await fetch(`${base}/api/advisory/latest`);
    expect(after.status).toBe(200);
    expect(((await after.json()) as AdvisoryPayload).sighted).toBe(true);
  });

  it('answers one by id, and names retention when the id is not here', async () => {
    const { base } = await serve();
    const started = (await (await fetch(`${base}/api/advisory`, { method: 'POST' })).json()) as AdvisoryPayload;

    const found = await fetch(`${base}/api/advisory/${started.id}`);
    expect(((await found.json()) as AdvisoryPayload).id).toBe(started.id);

    const missing = await fetch(`${base}/api/advisory/does-not-exist`);
    expect(missing.status).toBe(404);
    // The likeliest reason an id that once worked stops working, so the message says so rather than
    // implying the caller made it up.
    expect(((await missing.json()) as Record<string, unknown>).message).toContain('retention');
  });

  it('reads history rather than an advisory when the path is /history', async () => {
    const { base } = await serve();
    await fetch(`${base}/api/advisory`, { method: 'POST' });

    const response = await fetch(`${base}/api/advisory/history`);
    const payload = (await response.json()) as AdvisoryHistoryPayload;

    // The whole reason the history route is registered before the id one. Matched the other way round,
    // this is a 404 that reads as a missing record rather than as a routing mistake.
    expect(response.status).toBe(200);
    expect(payload.available).toBe(true);
    expect(payload.runs).toHaveLength(1);
    expect(payload.runs[0]?.lookbackDays).toBe(30);
  });

  it('says there is no advisor rather than answering with an empty history', async () => {
    const { base } = await serve({ noAdvisor: true });

    const payload = (await (await fetch(`${base}/api/advisory/history`)).json()) as AdvisoryHistoryPayload;

    // `available: false` rather than `runs: []`, because an install with no advisor and one that has
    // never run it look identical in a list and mean opposite things.
    expect(payload.available).toBe(false);
    expect(payload.unavailable).toContain('no workload advisor');
  });
});
