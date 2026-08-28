// What an advisory run is for, and the four things about it that are not obvious from the type.
//
// Against a real `analyseServerless` and real collectors, because the interesting properties are about
// the seam between collection and analysis — that the analysis sees what was collected, that a run
// which read nothing says so rather than reporting an estate with no work to do, and that the rows the
// analysis was derived from are not kept afterwards. A stubbed analyzer demonstrates none of those.

import { describe, expect, it, vi } from 'vitest';

import { accountScope } from '../collect/estate-scope.js';
import type { CredentialProvider } from '../collect/credentials.js';
import type { Collector, SignalId, SignalResult } from '../collect/signal.js';
import { observed, unmeasurable } from '../collect/signal.js';
import { JOB_INVENTORY, JOB_SPEND, READINESS } from '../analyze/serverless.js';
import { sighted } from './advisory.js';
import {
  AdvisoryRunner,
  ADVISORY_SIGNALS,
  AdvisoryInProgressError,
  QUERY_SHAPES,
  type PlanAccessFactory,
} from './runner.js';
import type { PlanSource } from '../collect/sql/plans/fetch.js';
import { InMemoryAdvisoryStore } from './store.js';
import { InMemoryPlanExtractStore, type PlanExtractStore } from './plan-store.js';
import { StaticQuerySource } from '../collect/sql/queries.js';
import { SHAPE_STATEMENT, shapeFingerprintVersion } from '../collect/sql/shape-version.js';

const asUser: CredentialProvider = {
  mode: 'on-behalf-of-user',
  databricks: () =>
    Promise.resolve({
      mode: 'on-behalf-of-user',
      actor: 'ada@example.com',
      host: 'https://example.cloud.databricks.com',
      token: () => Promise.resolve('t'),
    }),
  cloud: () => Promise.resolve(null),
};

/**
 * A collector that answers with what it is given, so the analysis has something to analyse.
 *
 * Every signal the advisor asks for, not only the ones a test names, because `analyseServerless` reads
 * the workspace directory to turn an id into a link and a directory shaped like anything else takes it
 * down. A collector that answered only the named signals would leave that one absent, which is a state
 * the analyzer handles, and would therefore test the wrong path.
 */
function answering(name: string, rows: Readonly<Partial<Record<string, unknown>>>): Collector {
  const directory = { workspaces: [{ workspaceId: 'w1', name: 'ws-1', status: 'RUNNING' }], live: [], excluded: [] };
  const values: Record<string, unknown> = { 'sql:estate.workspaces': directory, ...rows };
  return {
    surface: 'sql',
    name,
    signals: [...ADVISORY_SIGNALS],
    collect: (ids): Promise<SignalResult[]> =>
      Promise.resolve(ids.map((id) => observed(id, values[id] ?? [], 0))),
  };
}

/** A collector that is refused, which is what an estate the app cannot read looks like. */
function refusing(name: string, signals: readonly SignalId[]): Collector {
  return {
    surface: 'sql',
    name,
    signals: [...signals],
    collect: (ids): Promise<SignalResult[]> =>
      Promise.resolve(ids.map((id) => unmeasurable(id, `The ${name} collector is refused here.`))),
  };
}

/** A job that ran on classic compute, which is the case the analysis has something to say about. */
function readiness(over: Readonly<Record<string, unknown>> = {}) {
  return {
    workspaceId: 'w1',
    jobId: '11',
    runs: 40,
    taskRuns: 40,
    taskRunsUntimed: 0,
    longestTaskSeconds: 600,
    setupSeconds: 200,
    executionSeconds: 3000,
    computeUses: 40,
    serverlessUses: 0,
    warehouseUses: 0,
    classicUses: 40,
    unclassifiedUses: 0,
    classicClusters: 1,
    unreadClusters: 0,
    allPurposeClusters: 0,
    initScriptClusters: 0,
    unknownInitScriptClusters: 0,
    gpuClusters: 0,
    ...over,
  };
}

/**
 * A plan port that answers without a workspace.
 *
 * Injected by default rather than in the tests that need it, because the alternative is a suite that
 * reaches for `example.cloud.databricks.com` on every run that collects a query shape — passing, because
 * the refusal is caught and recorded as `warehousesKnown: false`, and passing for the wrong reason.
 */
function fakePlanAccess(
  warehouses: readonly string[] = [],
  plan: PlanSource['plan'] = () => Promise.reject(new Error('no plan fetch was expected here'))
): PlanAccessFactory {
  return () => ({
    warehouseIds: () => Promise.resolve(new Set(warehouses)),
    fetcher: { plan },
  });
}

/**
 * One query shape with a nominated execution the pre-filter will pass.
 *
 * Deliberately minimal: `retrievePlans` reads three fields off a row and `analyseWorkload` reads the
 * rest, so a fixture carrying only what the plan path needs would fail the analysis for an unrelated
 * reason. This is the analysed shape above, plus the nomination.
 */
function nominated(over: Readonly<Record<string, unknown>> = {}) {
  return {
    workspaceId: 'w1',
    shape: 'abc0000000000000',
    statementType: 'SELECT',
    kinds: 1,
    runsNow: 500,
    runsBefore: 500,
    measuredNow: 500,
    measuredBefore: 500,
    msNow: 3_600_000,
    msBefore: 1_000_000,
    meanMsNow: 7200,
    meanMsBefore: 2000,
    medianMs: 7200,
    worstMs: 7400,
    spilledBytes: 0,
    shuffleBytes: 0,
    readBytes: 1_000_000,
    writtenBytes: 0,
    readFiles: 10,
    prunedFiles: 90,
    parallelism: 4,
    compilationPercent: 80,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    coveredMs: 3_000_000,
    excludedMs: 7_000_000,
    coveredRuns: 500,
    excludedRuns: 900,
    statementText: 'select * from sales where day = 3',
    statementId: 'stmt-1',
    // Present because the statement cannot return one without the other: both come off the representative
    // CTE's joined row. A retained plan is filed under this date, so a fixture that left it out would test
    // the persistence path against a row shape `workload_query_shapes.sql` does not produce.
    representativeAt: new Date('2026-08-01T00:00:00.000Z'),
    representativeComputeType: 'WAREHOUSE',
    representativeWarehouseId: 'wh-1',
    ...over,
  };
}

/** A stand-in for the shape statement, so the version a plan is filed under can be asserted. */
const SHAPES_SQL = 'select substr(sha2(lower(trim(statement_text)), 256), 1, 16) as shape from windows';

function harness(planAccess: PlanAccessFactory = fakePlanAccess()) {
  const store = new InMemoryAdvisoryStore();
  const planExtracts = new InMemoryPlanExtractStore();
  const advisor = new AdvisoryRunner({
    store,
    planAccess,
    planExtracts,
    queries: new StaticQuerySource({ [SHAPE_STATEMENT]: SHAPES_SQL }),
  });
  return { store, advisor, planExtracts };
}

function request(collectors: readonly Collector[]) {
  return { credentials: asUser, scope: accountScope(), collectors, lookbackDays: 30 };
}

describe('running the advisor', () => {
  it('asks for the signals its analyses need, and no others', async () => {
    const asked: SignalId[] = [];
    const { advisor } = harness();
    await advisor.start(
      request([
        {
          surface: 'sql',
          name: 'watching',
          // Offers more than the advisor needs, so a run that over-collected would show up here. An
          // advisory run is account-wide and repeated weekly; collecting a signal nothing reads is load
          // somebody pays for to produce nothing.
          signals: [...ADVISORY_SIGNALS, 'sql:security.tokens'],
          collect: (ids): Promise<SignalResult[]> => {
            asked.push(...ids);
            return Promise.resolve(ids.map((id) => observed(id, [], 0)));
          },
        },
      ])
    );

    expect(new Set(asked)).toEqual(new Set(ADVISORY_SIGNALS));
  });

  it('analyses what it collected, so a page can name the job to move next', async () => {
    const { advisor } = harness();
    const advisory = await advisor.start(
      request([
        answering('jobs', {
          [READINESS]: [readiness()],
          [JOB_SPEND]: [{ workspaceId: 'w1', jobId: '11', cost: 900, serverlessCost: 0, classicCost: 900 }],
          [JOB_INVENTORY]: [{ workspaceId: 'w1', jobId: '11', name: 'nightly load' }],
        }),
      ])
    );

    // The analysis reached a verdict about the job, which is what distinguishes this from a run that
    // collected and concluded nothing. Which verdict is `serverless.test.ts`'s business.
    expect(advisory.serverless?.jobs.map((job) => job.jobId)).toEqual(['11']);
    expect(advisory.state).toBe('complete');
  });

  it('analyses the query shapes it collected, and reports how much of the estate that covers', async () => {
    const { advisor } = harness();
    const advisory = await advisor.start(
      request([
        answering('shapes', {
          [QUERY_SHAPES]: [
            {
              workspaceId: 'w1',
              shape: 'abc0000000000000',
              statementType: 'SELECT',
              kinds: 1,
              runsNow: 500,
              runsBefore: 500,
              measuredNow: 500,
              measuredBefore: 500,
              msNow: 3_600_000,
              msBefore: 1_000_000,
              meanMsNow: 7200,
              meanMsBefore: 2000,
              medianMs: 7200,
              worstMs: 7400,
              spilledBytes: 0,
              shuffleBytes: 0,
              readBytes: 1_000_000,
              writtenBytes: 0,
              readFiles: 10,
              prunedFiles: 90,
              parallelism: 4,
              compilationPercent: 80,
              queueMs: 0,
              cacheHits: 0,
              failures: 0,
              warehouses: 1,
              jobs: 0,
              pipelines: 0,
              coveredMs: 3_000_000,
              excludedMs: 7_000_000,
              coveredRuns: 500,
              excludedRuns: 900,
              statementText: 'select * from sales where day = 3',
            },
          ],
        }),
      ])
    );

    expect(advisory.workload?.top.map((shape) => shape.shape)).toEqual(['abc0000000000000']);
    // The planner finding, which is what calibration says the top of a real page is made of.
    expect(advisory.workload?.top[0]?.findings.map((one) => one.rule)).toEqual(['COMPILATION_DOMINATED']);
    expect(advisory.workload?.top[0]?.trend.kind).toBe('regression');
    // And the disclosure, which is the whole reason excluding REFRESH is defensible.
    expect(advisory.workload?.coverage.percent).toBe(30);
  });

  it('fetches a plan for a nominated shape and records what came of it', async () => {
    const plan = vi.fn().mockResolvedValue({
      status: 200,
      body: { plans_state: 'EXISTS', plans: { '0': { nodes: [{ id: '1', tag: 'SCAN' }] } } },
    });
    const { advisor } = harness(fakePlanAccess(['wh-1'], plan));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(plan).toHaveBeenCalledWith('stmt-1', expect.anything());
    expect(advisory.plans).toEqual({
      available: 1,
      withoutPlan: 0,
      failed: 0,
      abandoned: 0,
      notRun: 0,
      skipped: {},
      warehousesKnown: true,
    });
  });

  it('keeps the extract, filed under the shape version and the run that fetched it', async () => {
    const plan = () =>
      Promise.resolve({
        status: 200,
        body: { plans_state: 'EXISTS', plans: { '0': { nodes: [{ id: '1', tag: 'SCAN' }] } } },
      });
    const { advisor, planExtracts } = harness(fakePlanAccess(['wh-1'], plan));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    const kept = await planExtracts.forShape({ workspaceId: 'w1', shape: 'abc0000000000000' });

    expect(advisory.retainedPlans).toBe(1);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({
      statementId: 'stmt-1',
      advisoryId: advisory.id,
      shapeVersion: shapeFingerprintVersion(SHAPES_SQL),
    });
    // Two dates, doing two jobs. `observedAt` is the execution's: a plan filed under when the app looked
    // could not be ordered against the two executions it is kept to be compared with. `advisoryAt` is the
    // run's, and is the advisory's own `finishedAt` rather than a second reading of the clock, so the row
    // and the record it names are aged from the same instant.
    expect(kept[0]?.observedAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(kept[0]?.advisoryAt.toISOString()).toBe(advisory.finishedAt.toISOString());
    expect(kept[0]?.extract.operators).toEqual([{ id: '1', tag: 'SCAN' }]);
  });

  it('keeps nothing, and says nothing, where no plan came back', async () => {
    const { advisor, planExtracts } = harness(
      fakePlanAccess(['wh-1'], () => Promise.resolve({ status: 404, body: null }))
    );
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(advisory.retainedPlans).toBeUndefined();
    expect(await planExtracts.forShape({ workspaceId: 'w1', shape: 'abc0000000000000' })).toEqual([]);
  });

  it('does not keep a plan whose execution carried no start time', async () => {
    // A row the statement cannot produce and the row type allows. Kept, it would be an execution with no
    // place in an ordering of three — so it is left out, and the count on the record says one fewer.
    const plan = () =>
      Promise.resolve({
        status: 200,
        body: { plans_state: 'EXISTS', plans: { '0': { nodes: [{ id: '1', tag: 'SCAN' }] } } },
      });
    const { advisor, planExtracts } = harness(fakePlanAccess(['wh-1'], plan));
    const shapes = [nominated({ representativeAt: undefined })];
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: shapes })]));

    expect(advisory.plans?.available).toBe(1);
    expect(advisory.retainedPlans).toBe(0);
    expect(await planExtracts.forShape({ workspaceId: 'w1', shape: 'abc0000000000000' })).toEqual([]);
  });

  it('saves the advisory even where the plans could not be filed, and leaves the count off', async () => {
    // The trade this makes on purpose: an advisory that produced a workload analysis is worth keeping, and
    // what stops the failure from being silent is the missing count beside a non-zero `available`.
    const refusing: PlanExtractStore = {
      durable: true,
      keep: () => Promise.reject(new Error('relation "plan_extracts" does not exist')),
      forShape: () => Promise.resolve([]),
    };
    const advisor = new AdvisoryRunner({
      store: new InMemoryAdvisoryStore(),
      planAccess: fakePlanAccess(['wh-1'], () =>
        Promise.resolve({
          status: 200,
          body: { plans_state: 'EXISTS', plans: { '0': { nodes: [{ id: '1', tag: 'SCAN' }] } } },
        })
      ),
      planExtracts: refusing,
      queries: new StaticQuerySource({ [SHAPE_STATEMENT]: SHAPES_SQL }),
    });

    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(advisory.plans?.available).toBe(1);
    expect(advisory.retainedPlans).toBeUndefined();
    expect(advisory.workload?.top).toHaveLength(1);
  });

  it('spends no plan call on a shape that ran on a warehouse this workspace cannot see', async () => {
    const plan = vi.fn();
    const { advisor } = harness(fakePlanAccess(['wh-somewhere-else'], plan));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(plan).not.toHaveBeenCalled();
    expect(advisory.plans?.skipped).toEqual({ 'warehouse-outside-workspace': 1 });
  });

  it('finishes the run when the warehouse list is refused, and says the list was not read', async () => {
    // The distinction the record has to carry: no plans because the estate had none to fetch, against no
    // plans because this app could not establish which warehouses are local. Only the second is about us.
    const refusing: PlanAccessFactory = () => ({
      warehouseIds: () => Promise.reject(new Error('permission denied')),
      fetcher: { plan: () => Promise.reject(new Error('unreachable')) },
    });
    const { advisor } = harness(refusing);
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(advisory.plans?.warehousesKnown).toBe(false);
    // And the run still produced the analysis it was asked for.
    expect(advisory.workload?.top).toHaveLength(1);
  });

  it('submits the warehouse listing to the scheduler, so a run in flight reports having made it', async () => {
    // `callsMade` and not the surface, which is as specific as this seam gets: the runner builds its own
    // scheduler and exposes one number summed across all six surfaces, so this holds that the listing is
    // scheduled and not that it is scheduled on `rest`. The test below pins the half of `rest` that shows
    // from out here, and the surface itself is held by review.
    //
    // Read while the run is still going, because that is the only place this is exposed — and it is where
    // an operator reads it, from a run they are deciding whether to stop.
    //
    // One, not two: the plan fetch is held open, and the scheduler counts a task when it settles. So this
    // is the warehouse listing on its own, which spent nothing at all before `41c` and appeared nowhere.
    let release = (): void => undefined;
    const arrived = { at: false };
    const held = new Promise<void>((resolve) => (release = resolve));
    const plan: PlanSource['plan'] = async () => {
      arrived.at = true;
      await held;
      return { status: 404, body: null };
    };

    const { advisor } = harness(fakePlanAccess(['wh-1'], plan));
    const running = advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    while (!arrived.at) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(advisor.running()?.callsMade).toBe(1);

    release();
    await running;
  });

  it('asks for the warehouse list once, letting the SDK do the retrying it already does', async () => {
    // `rest` sets `clientRetries: true`, so the scheduler allows one attempt and the SDK's own retries are
    // not multiplied by four. Submitted on `plans` or `ai` — the two surfaces where that is false — a
    // listing failing this way would be attempted four times, which is the load-discipline half of picking
    // a surface and the only half visible from outside the runner.
    // A status the classifier reads as rate-limited, so the failure is one the scheduler would retry if
    // the surface let it. A bare message would classify as fatal, which nothing retries, and the test
    // would pass on every surface.
    const busy = Object.assign(new Error('the endpoint is busy'), { status: 503 });
    const warehouseIds = vi.fn().mockRejectedValue(busy);
    const { advisor } = harness(() => ({ warehouseIds, fetcher: { plan: vi.fn() } }));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(warehouseIds).toHaveBeenCalledTimes(1);
    expect(advisory.plans?.warehousesKnown).toBe(false);
  });

  it('does not list warehouses at all on a run cancelled during collection', async () => {
    // The third consequence of calling it directly, and the one no other test would catch: `plans` runs
    // unconditionally after collection, so a cancelled run still issued the whole paginated listing and
    // only then discovered there was nothing to fetch plans for. The scheduler refuses it at admission.
    //
    // One collector, not two. The advisory runner passes no `stopping` to `collectSignals`, so `cancel`
    // reaches this run through `scheduler.run` and nowhere else, and a second collector added to look like
    // a cancelled collection loop would be skipped for having nothing left to read.
    const warehouseIds = vi.fn().mockResolvedValue(new Set(['wh-1']));
    const plan = vi.fn();
    let release = (): void => undefined;
    const arrived = { at: false };
    const held = new Promise<void>((resolve) => (release = resolve));

    const { advisor } = harness(() => ({ warehouseIds, fetcher: { plan } }));
    const running = advisor.start(
      request([
        {
          surface: 'sql',
          name: 'first',
          signals: [...ADVISORY_SIGNALS],
          collect: async (ids): Promise<SignalResult[]> => {
            arrived.at = true;
            await held;
            return ids.map((id) => observed(id, id === QUERY_SHAPES ? [nominated()] : [], 0));
          },
        },
      ])
    );

    while (!arrived.at) await new Promise((resolve) => setTimeout(resolve, 1));
    advisor.cancel();
    release();
    const advisory = await running;

    expect(warehouseIds).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    // Recorded as a list that was not read rather than as a workspace with no warehouses, which is the
    // distinction `warehousesKnown` carries and would have been lost by reading a cancellation as empty.
    expect(advisory.plans?.warehousesKnown).toBe(false);
    expect(advisory.state).toBe('partial');
  });

  it('hands the plan it fetched to the rules, so a plan-read finding reaches the record', async () => {
    // The wiring `33ib` exists for, asserted at the seam it was missing from rather than on the index in
    // isolation. Before this row the runner fetched a plan, summarised it as counts, and analysed the shapes
    // without it — so the whole of the difference is visible here: the same shape, the same window, and a
    // finding that can only come from an operator.
    const plan = () =>
      Promise.resolve({
        status: 200,
        body: {
          plans_state: 'EXISTS',
          plans: {
            '0': {
              nodes: [
                { id: '1', tag: 'SCAN' },
                { id: '2', tag: 'UNKNOWN.PhotonScalarUDF', key_metrics: { duration_ms: 111_499, rows_num: 4935 } },
              ],
            },
          },
        },
      });
    const { advisor } = harness(fakePlanAccess(['wh-1'], plan));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    const found = advisory.workload?.top[0]?.findings ?? [];
    expect(found.map((one) => one.rule)).toContain('UDF_OR_PYTHON_BOUNDARY');
    // And the number came off the operator, not off the shape row — 111,499 ms is the UDF step's, while the
    // row's own window total is 3,600,000.
    const udf = found.find((one) => one.rule === 'UDF_OR_PYTHON_BOUNDARY');
    expect(udf?.evidence.map((one) => one.value)).toContain(111_499);
  });

  it('reaches no plan-read finding on the same shape when no plan came back', async () => {
    // The control for the test above. Without it, a rule firing off the shape row alone would pass it.
    const { advisor } = harness(fakePlanAccess(['wh-1'], () => Promise.resolve({ status: 404, body: null })));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    const rules = (advisory.workload?.top[0]?.findings ?? []).map((one) => one.rule);
    expect(rules).not.toContain('UDF_OR_PYTHON_BOUNDARY');
    // And the analysis still happened, so this is not a run that concluded nothing for another reason.
    expect(rules.length).toBeGreaterThan(0);
  });

  it('says nothing about capability on a first run, having nothing to compare against', async () => {
    const { advisor } = harness(fakePlanAccess(['wh-1'], () => Promise.resolve({ status: 404, body: null })));
    const advisory = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(advisory.plans?.withoutPlan).toBe(1);
    expect(advisory.planCapability).toBeUndefined();
  });

  it('compares plan reach against an earlier run, and takes the baseline from the store', async () => {
    // Two runs against the same port: the first reads a plan, the second is answered without one. The
    // second is the only one that can say reach was lost, because the first is what established it.
    const graph = {
      plans_state: 'EXISTS',
      plans: { '0': { nodes: [{ id: '1', tag: 'SCAN', key_metrics: { duration_ms: 5 } }] } },
    };
    let reply: { status: number; body: unknown } = { status: 200, body: graph };
    const { advisor } = harness(fakePlanAccess(['wh-1'], () => Promise.resolve(reply as never)));

    const first = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));
    expect(first.plans?.available).toBe(1);
    expect(first.planCapability).toBeUndefined();

    reply = { status: 404, body: null };
    const second = await advisor.start(request([answering('shapes', { [QUERY_SHAPES]: [nominated()] })]));

    expect(second.planCapability).toEqual({
      kind: 'lost-reach',
      baselineAdvisoryId: first.id,
      baselineAvailable: 1,
    });
  });

  it('does not take a run that could not list warehouses as the baseline', async () => {
    // The floor this row was split out to avoid setting: a refused warehouse list reads as zero reach, and
    // a later run comparing against it would find nothing had changed.
    const refusing: PlanAccessFactory = () => ({
      warehouseIds: () => Promise.reject(new Error('permission denied')),
      fetcher: { plan: () => Promise.reject(new Error('unreachable')) },
    });
    const store = new InMemoryAdvisoryStore();
    const shapes = [answering('shapes', { [QUERY_SHAPES]: [nominated()] })];

    const refused = await new AdvisoryRunner({ store, planAccess: refusing }).start(request(shapes));
    expect(refused.planCapability).toEqual({ kind: 'cannot-tell' });

    const reading = fakePlanAccess(['wh-1'], () => Promise.resolve({ status: 404, body: null }));
    const after = await new AdvisoryRunner({ store, planAccess: reading }).start(request(shapes));

    // Nothing to compare against, because the only earlier run was not a baseline.
    expect(after.planCapability).toBeUndefined();
  });

  it('does not reach for plans at all when the shapes could not be read', async () => {
    const plan = vi.fn();
    const warehouseIds = vi.fn();
    const { advisor } = harness(() => ({
      warehouseIds: warehouseIds.mockResolvedValue(new Set<string>()),
      fetcher: { plan },
    }));
    const advisory = await advisor.start(request([refusing('shapes', [QUERY_SHAPES])]));

    expect(warehouseIds).not.toHaveBeenCalled();
    expect(plan).not.toHaveBeenCalled();
    expect(advisory.plans).toBeUndefined();
  });

  it('reports no workload analysis where the query history could not be read', async () => {
    // Not an empty one. An estate with no expensive queries is a real finding; a window whose history was
    // refused is not, and the two are indistinguishable once an empty analysis has been rendered.
    const { advisor } = harness();
    const advisory = await advisor.start(request([refusing('shapes', ADVISORY_SIGNALS)]));

    expect(advisory.workload).toBeUndefined();
    expect(sighted(advisory)).toBe(false);
  });

  it('keeps the readings without their rows, so the record does not grow with the estate', async () => {
    const { advisor } = harness();
    const advisory = await advisor.start(
      request([answering('jobs', { [READINESS]: [{ job_id: '11', workspace_id: 'w1', runs: 1 }] })])
    );

    const reading = advisory.readings.find((one) => one.id === READINESS);
    expect(reading?.status).toBe('observed');
    // The rows are gone, and the fact that the signal was readable is not. Both halves matter: a page
    // has to be able to say "this part of the estate could not be read" and name the reason.
    expect(reading).not.toHaveProperty('value');
  });

  it('says it saw nothing rather than reporting an estate with no work in it', async () => {
    const { advisor } = harness();
    const advisory = await advisor.start(request([refusing('jobs', ADVISORY_SIGNALS)]));

    // The distinction the page turns on. An estate where every signal was refused and one where every
    // job is already serverless both produce an empty analysis, and telling a customer they have
    // nothing to optimise when the truth is that the app cannot see their estate is the worse of the
    // two wrong answers.
    expect(sighted(advisory)).toBe(false);
    expect(advisory.readings.every((reading) => reading.status === 'unmeasurable')).toBe(true);
  });

  it('records who ran it and what it ran against', async () => {
    const { advisor } = harness();
    const advisory = await advisor.start({
      ...request([refusing('jobs', ADVISORY_SIGNALS)]),
      warehouse: 'wh-1',
      runId: 'run-9',
    });

    expect(advisory.stamp).toEqual({
      actor: 'ada@example.com',
      executionMode: 'on-behalf-of-user',
      warehouse: 'wh-1',
    });
    expect(advisory.runId).toBe('run-9');
    expect(advisory.lookbackDays).toBe(30);
  });

  it('saves what it produced, so the page has something to read', async () => {
    const { advisor, store } = harness();
    const advisory = await advisor.start(request([refusing('jobs', ADVISORY_SIGNALS)]));

    expect((await store.latest())?.id).toBe(advisory.id);
    expect((await store.forRun(advisory.runId))?.id).toBe(advisory.id);
  });

  it('refuses a second run while one is in flight, since both would read the same estate', async () => {
    const { advisor } = harness();
    let release = (): void => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));

    const first = advisor.start(
      request([
        {
          surface: 'sql',
          name: 'slow',
          signals: [...ADVISORY_SIGNALS],
          collect: async (ids): Promise<SignalResult[]> => {
            await held;
            return ids.map((id) => unmeasurable(id, 'held'));
          },
        },
      ])
    );

    await expect(advisor.start(request([refusing('jobs', ADVISORY_SIGNALS)]))).rejects.toBeInstanceOf(
      AdvisoryInProgressError
    );
    // And the waiting caller gets the answer rather than an error, which is what they wanted.
    expect(advisor.join()).toBeDefined();
    release();
    await first;
  });

  it('lets another run start after one fails, rather than refusing for ever', async () => {
    const { advisor } = harness();
    const breaking: Collector = {
      surface: 'sql',
      name: 'breaking',
      signals: [...ADVISORY_SIGNALS],
      collect: () => Promise.reject(new Error('the warehouse is gone')),
    };

    // A collector that throws does not fail the run — its signals are recorded as unmeasurable with the
    // fault named. What is asserted here is that the lock is released either way, which is the property
    // a `finally` exists for and the one a test would not notice was missing.
    const first = await advisor.start(request([breaking]));
    expect(sighted(first)).toBe(false);
    expect(advisor.running()).toBeUndefined();

    await expect(advisor.start(request([refusing('jobs', ADVISORY_SIGNALS)]))).resolves.toBeDefined();
  });

  it('reports a cancelled run as partial, and saves what it had', async () => {
    const { advisor, store } = harness();
    let release = (): void => undefined;
    const arrived = { at: false };
    const held = new Promise<void>((resolve) => (release = resolve));

    const running = advisor.start({
      ...request([
        {
          surface: 'sql',
          name: 'first',
          signals: [READINESS],
          collect: async (ids): Promise<SignalResult[]> => {
            arrived.at = true;
            await held;
            return ids.map((id) => observed(id, [], 0));
          },
        },
        refusing('second', [JOB_SPEND, JOB_INVENTORY]),
      ]),
    });

    // Waited for rather than assumed, so the cancel lands while the run is genuinely mid-collector.
    while (!arrived.at) await new Promise((resolve) => setTimeout(resolve, 1));
    advisor.cancel();
    release();
    const advisory = await running;

    // Partial rather than complete, and saved rather than discarded: the first collector's reading is
    // real and the record says the picture is incomplete. Which is the same bargain a cancelled scan
    // strikes, for the same reason.
    expect(advisory.state).toBe('partial');
    expect(advisory.incompleteReason).toContain('cancelled');
    expect((await store.latest())?.id).toBe(advisory.id);
  });

  it('does not read again what an earlier attempt reached', async () => {
    const read: SignalId[] = [];
    const { advisor } = harness();

    // Modelled on the SQL collector, which reads its signals one at a time and skips the ones already in
    // `collected`. That skip is the collector's to make — the loop hands it every signal it is
    // responsible for — so a test that asserted on what the loop passed would be asserting the wrong
    // half of the mechanism.
    const advisory = await advisor.start({
      ...request([
        {
          surface: 'sql',
          name: 'progressive',
          signals: [...ADVISORY_SIGNALS],
          collect: async (ids, context): Promise<SignalResult[]> => {
            const results: SignalResult[] = [];
            for (const id of ids) {
              if (context.collected.has(id)) continue;
              read.push(id);
              const result = unmeasurable(id, 'refused');
              results.push(result);
              await context.settled?.(result);
            }
            return results;
          },
        },
      ]),
      resume: new Map([[READINESS, observed(READINESS, [], 0)]]),
    });

    expect(read).not.toContain(READINESS);
    // And the resumed reading is on the record, rather than being dropped for not having been read by
    // this attempt. A resumption that lost what it resumed from would be a fresh run with extra steps.
    expect(advisory.readings.find((one) => one.id === READINESS)?.status).toBe('observed');
  });
});
