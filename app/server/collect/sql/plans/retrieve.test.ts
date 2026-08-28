import { describe, expect, it, vi } from 'vitest';
import { retrievePlans, summarise, type PlanRetrieval } from './retrieve.js';
import { PlanFetcher, PlanHttpError } from './fetch.js';
import { PlanBreaker } from './breaker.js';
import { CollectionScheduler } from '../../../scan/scheduler.js';
import type { QueryShapeRow } from '../shapes.js';

/** Only the fields the pre-filter and the loop read; the rest of the row is irrelevant here. */
function shape(overrides: Partial<QueryShapeRow> & { readonly shape: string }): QueryShapeRow {
  return {
    workspaceId: 'ws-1',
    statementId: `stmt-${overrides.shape}`,
    representativeComputeType: 'WAREHOUSE',
    representativeWarehouseId: 'wh-local',
    ...overrides,
  } as QueryShapeRow;
}

function scheduler(): CollectionScheduler {
  return new CollectionScheduler({
    warehouse: 'shared',
    sleep: () => Promise.resolve(),
    random: () => 1,
  });
}

/** A fetcher whose responses are keyed by statement id, so a case reads as a table. */
function fetcherFor(responses: Readonly<Record<string, () => Promise<Response>>>): PlanFetcher {
  return new PlanFetcher({
    host: 'https://h',
    token: () => Promise.resolve('t'),
    // Typed as the real signature rather than narrowed to what `PlanFetcher` happens to pass, so this
    // fake keeps working if the fetcher ever builds a `URL` instead of a string.
    fetch: ((input: string | URL | Request) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const id = decodeURIComponent(/queries\/([^?]+)/.exec(url)?.[1] ?? '');
      const make = responses[id];
      if (make == null) throw new Error(`no response staged for ${id}`);
      return make();
    }),
  });
}

const GRAPH = {
  plans_state: 'EXISTS',
  plans: { '0': { nodes: [{ id: '1', tag: 'SCAN', key_metrics: { duration_ms: 5 } }] } },
};

function ok(body: unknown): () => Promise<Response> {
  return () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

const LOCAL = new Set(['wh-local']);

describe('retrievePlans', () => {
  it('fetches a plan for each shape the pre-filter passed, and extracts the graph', async () => {
    const shapes = [shape({ shape: 'a' }), shape({ shape: 'b' })];
    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-a': ok(GRAPH), 'stmt-b': ok(GRAPH) }),
      scheduler: scheduler(),
    });

    expect(retrieval.plans.map((plan) => plan.shape)).toEqual(['a', 'b']);
    expect(retrieval.plans[0]?.statementId).toBe('stmt-a');
    expect(retrieval.plans[0]?.extract.operatorCount).toBe(1);
  });

  it('records one outcome per shape, in the order the shapes arrived', async () => {
    const shapes = [
      shape({ shape: 'foreign', representativeWarehouseId: 'wh-elsewhere' }),
      shape({ shape: 'fetched' }),
      shape({ shape: 'serverless-job', representativeComputeType: 'JOB' }),
    ];
    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-fetched': ok(GRAPH) }),
      scheduler: scheduler(),
    });

    expect(retrieval.attempts.map((attempt) => [attempt.shape, attempt.kind])).toEqual([
      ['foreign', 'skipped'],
      ['fetched', 'parsed'],
      ['serverless-job', 'skipped'],
    ]);
  });

  // `workload_query_shapes.sql` groups by `workspace_id, shape`, so one shape string can arrive twice.
  // The two rows can end differently, and this is the case that does: only one of the two warehouses is
  // in this workspace, so the local row is fetched and the sibling is skipped. Keyed on the shape alone,
  // the second row overwrote the first and one outcome was reported twice.
  it('keeps the two outcomes apart when one shape ran in two workspaces', async () => {
    const shapes = [
      shape({ shape: 'shared', workspaceId: 'ws-1', statementId: 'stmt-here' }),
      shape({ shape: 'shared', workspaceId: 'ws-2', representativeWarehouseId: 'wh-elsewhere' }),
    ];
    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-here': ok(GRAPH) }),
      scheduler: scheduler(),
    });

    expect(retrieval.attempts.map((attempt) => [attempt.workspaceId, attempt.kind])).toEqual([
      ['ws-1', 'parsed'],
      ['ws-2', 'skipped'],
    ]);
    expect(retrieval.plans.map((plan) => [plan.workspaceId, plan.shape])).toEqual([['ws-1', 'shared']]);
    expect(summarise(retrieval).available).toBe(1);
    expect(summarise(retrieval).skipped).toEqual({ 'warehouse-outside-workspace': 1 });
  });

  /*
   * The breaker's whole purpose, stated as the thing it prevents.
   *
   * Without it all 40 shapes are fetched and each is retried to `maxAttempts`, which `breaker.ts` measured
   * at 160 requests and between 33 and 70 seconds depending on how the status classifies. The assertion is
   * on requests rather than on time, because the time is the scheduler's backoff and asserting it would be
   * a slow test measuring someone else's constant.
   */
  it('stops fetching once the endpoint has failed enough times in a row', async () => {
    const shapes = Array.from({ length: 40 }, (_, i) => shape({ shape: `s${String(i)}` }));
    let requests = 0;
    const fetcher = new PlanFetcher({
      host: 'https://h',
      token: () => Promise.resolve('t'),
      fetch: () => {
        requests += 1;
        return Promise.resolve(new Response('unwell', { status: 500 }));
      },
    });

    const runner = scheduler();
    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher,
      scheduler: runner,
      breaker: new PlanBreaker(5),
    });

    // The footprint has to agree, because `callsMade` is served to a reader as calls that reached a surface.
    // An abandoned shape returning a value from inside `run` counted as `ok`, so a dead endpoint reported
    // about 40 calls where six had been made.
    const counters = runner.footprint().tasks.plans;
    expect(counters.ok).toBe(0);
    expect(counters.skipped).toBe(summarise(retrieval).abandoned);

    const summary = summarise(retrieval);
    expect(summary.available).toBe(0);
    // Every shape still accounted for, which is the invariant the breaker must not break.
    expect(summary.failed + summary.abandoned).toBe(40);
    expect(summary.abandoned).toBeGreaterThan(30);
    // A ceiling rather than an equality: concurrency is 2, so the task that was already in flight when the
    // fifth failure landed still finishes its own retries.
    expect(requests).toBeLessThanOrEqual(6 * 4);
  });

  /*
   * A cancelled scan is not an endpoint that stopped answering.
   *
   * Both arrive as a scheduler outcome that is not `ok`, and folding them together is what made a cancelled
   * run report reach as lost: `plan-capability.ts` reads `failed` as shapes that were asked about, so 40
   * cancellations read as 40 unanswered requests against a baseline that had plans.
   */
  it('separates shapes the scheduler never ran from fetches that came back empty-handed', async () => {
    const shapes = [shape({ shape: 'a' }), shape({ shape: 'b' })];
    const plan = vi.fn();
    const cancelled = scheduler();
    cancelled.cancel();

    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: { plan },
      scheduler: cancelled,
    });

    expect(plan).not.toHaveBeenCalled();
    const summary = summarise(retrieval);
    expect(summary.notRun).toBe(2);
    expect(summary.failed).toBe(0);
    expect(summary.abandoned).toBe(0);
  });

  it('does not open the breaker on an endpoint that answers, however unhelpfully', async () => {
    const shapes = Array.from({ length: 12 }, (_, i) => shape({ shape: `s${String(i)}` }));
    const responses: Record<string, () => Promise<Response>> = {};
    for (const one of shapes) {
      responses[`stmt-${one.shape}`] = () => Promise.resolve(new Response(null, { status: 404 }));
    }

    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor(responses),
      scheduler: scheduler(),
      breaker: new PlanBreaker(5),
    });

    expect(summarise(retrieval).abandoned).toBe(0);
    expect(summarise(retrieval).withoutPlan).toBe(12);
  });

  it('reads a 404 as an outcome of the call rather than a failure of it', async () => {
    const retrieval = await retrievePlans({
      shapes: [shape({ shape: 'a' })],
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-a': () => Promise.resolve(new Response('', { status: 404 })) }),
      scheduler: scheduler(),
    });

    const attempt = retrieval.attempts[0];
    expect(attempt?.kind).toBe('parsed');
    expect(attempt?.kind === 'parsed' && attempt.parsed.outcome).toBe('not-retrievable');
    expect(retrieval.plans).toEqual([]);
  });

  it('separates a cache hit from a 404, because only one says a plan was absent', async () => {
    const retrieval = await retrievePlans({
      shapes: [shape({ shape: 'cached' })],
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-cached': ok({ plans_state: 'EMPTY' }) }),
      scheduler: scheduler(),
    });
    const attempt = retrieval.attempts[0];
    expect(attempt?.kind === 'parsed' && attempt.parsed.outcome).toBe('no-plan');
  });

  it('records a failed fetch as failed, keeping it apart from a skip', async () => {
    const retrieval = await retrievePlans({
      shapes: [shape({ shape: 'a' })],
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({
        'stmt-a': () => Promise.reject(new PlanHttpError(500, 'the service fell over')),
      }),
      scheduler: scheduler(),
    });

    const attempt = retrieval.attempts[0];
    expect(attempt?.kind).toBe('failed');
    expect(attempt?.kind === 'failed' && attempt.detail).toContain('fell over');
  });

  it('spends no call at all when the warehouse list came back empty', async () => {
    const doFetch = vi.fn();
    const retrieval = await retrievePlans({
      shapes: [shape({ shape: 'a' })],
      localWarehouseIds: new Set(),
      warehousesKnown: false,
      fetcher: new PlanFetcher({
        host: 'https://h',
        token: () => Promise.resolve('t'),
        fetch: doFetch,
      }),
      scheduler: scheduler(),
    });

    expect(doFetch).not.toHaveBeenCalled();
    expect(retrieval.warehousesKnown).toBe(false);
    // Never asked about, not "ran on a warehouse this workspace cannot see". Every id is missing from an
    // empty set, so recording the pre-filter's reason here would put a claim about where these shapes ran
    // into a record that had established nothing about where they ran.
    const attempt = retrieval.attempts[0];
    expect(attempt?.kind).toBe('not-run');
    expect(attempt?.kind === 'not-run' && attempt.detail).toContain('warehouse list was not read');
    expect(summarise(retrieval)).toMatchObject({ notRun: 1, skipped: {} });
  });

  it('keeps a skip the shape itself explains, whatever the warehouse list did', async () => {
    // The control for the test above: three of the four skip reasons are read off the shape and hold
    // however the listing went, so an unread list must not swallow them into "never asked about".
    const retrieval = await retrievePlans({
      shapes: [shape({ shape: 'a', representativeComputeType: 'JOB' })],
      localWarehouseIds: new Set(),
      warehousesKnown: false,
      fetcher: new PlanFetcher({ host: 'https://h', token: () => Promise.resolve('t'), fetch: vi.fn() }),
      scheduler: scheduler(),
    });

    expect(summarise(retrieval)).toMatchObject({ notRun: 0, skipped: { 'not-warehouse-compute': 1 } });
  });

  it('goes through the scheduler, so the surface bound and the budget apply', async () => {
    // Observed rather than asserted on the limiter: the scheduler's footprint is what records that a
    // task ran on a surface, and a fetch made around it would leave this at zero.
    const subject = scheduler();
    await retrievePlans({
      shapes: [shape({ shape: 'a' }), shape({ shape: 'b' })],
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({ 'stmt-a': ok(GRAPH), 'stmt-b': ok(GRAPH) }),
      scheduler: subject,
    });
    expect(subject.footprint().tasks.plans).toMatchObject({ ok: 2 });
  });

  it('holds concurrency to the surface ceiling of two', async () => {
    let inFlight = 0;
    let peak = 0;
    const hold = () =>
      new Promise<Response>((resolve) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        setTimeout(() => {
          inFlight -= 1;
          resolve(new Response(JSON.stringify(GRAPH), { status: 200 }));
        }, 1);
      });

    const shapes = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => shape({ shape: name }));
    await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor(Object.fromEntries(shapes.map((row) => [row.statementId as string, hold]))),
      scheduler: scheduler(),
    });

    expect(peak).toBeLessThanOrEqual(2);
    expect(peak).toBeGreaterThan(1);
  });

  it('returns nothing to fetch for no shapes, without touching the fetcher', async () => {
    const doFetch = vi.fn();
    const retrieval = await retrievePlans({
      shapes: [],
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: new PlanFetcher({
        host: 'https://h',
        token: () => Promise.resolve('t'),
        fetch: doFetch,
      }),
      scheduler: scheduler(),
    });
    expect(retrieval).toMatchObject({ plans: [], attempts: [] });
    expect(doFetch).not.toHaveBeenCalled();
  });
});

describe('summarise', () => {
  it('counts each outcome under its own heading and names the skip reasons', async () => {
    const shapes = [
      shape({ shape: 'graph' }),
      shape({ shape: 'cached' }),
      shape({ shape: 'broken' }),
      shape({ shape: 'foreign', representativeWarehouseId: 'wh-elsewhere' }),
      shape({ shape: 'also-foreign', representativeWarehouseId: 'wh-elsewhere' }),
      shape({ shape: 'not-a-warehouse', representativeComputeType: 'JOB' }),
    ];
    const retrieval = await retrievePlans({
      shapes,
      localWarehouseIds: LOCAL,
      warehousesKnown: true,
      fetcher: fetcherFor({
        'stmt-graph': ok(GRAPH),
        'stmt-cached': ok({ plans_state: 'EMPTY' }),
        'stmt-broken': () => Promise.reject(new PlanHttpError(500, 'down')),
      }),
      scheduler: scheduler(),
    });

    expect(summarise(retrieval)).toEqual({
      available: 1,
      withoutPlan: 1,
      failed: 1,
      abandoned: 0,
      notRun: 0,
      skipped: { 'warehouse-outside-workspace': 2, 'not-warehouse-compute': 1 },
      warehousesKnown: true,
    });
  });

  it('leaves a reason out rather than reporting it as zero', () => {
    const empty: PlanRetrieval = { plans: [], attempts: [], warehousesKnown: true };
    expect(summarise(empty).skipped).toEqual({});
  });
});
