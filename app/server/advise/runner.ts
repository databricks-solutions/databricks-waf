// One advisory run at a time, and what it does.
//
// The counterpart of `ScanRunner`, and much smaller than it, because the hard parts are elsewhere: the
// collection loop is shared (`collect/collection.ts`), and surviving a restart is the run coordinator's
// job (`run/runs.ts`, ADR 0069). What is left here is the part that is genuinely the advisor's — which
// signals to ask for, and what to conclude from them.
//
// The single-flight lock is the same argument the scan runner makes and it applies with more force: two
// admins opening the Optimisation page and pressing the button produces two account-wide passes over
// `system.lakeflow` for the same answer. The second caller wanted the answer, not the act.

import { randomUUID } from 'node:crypto';
import { collectSignals, withInputs, type CollectionOptions } from '../collect/collection.js';
import type { SignalId, SignalResult } from '../collect/signal.js';
import type { CredentialProvider, DatabricksCredentials } from '../collect/credentials.js';
import { clientFor } from '../collect/rest/client.js';
import { localWarehouseIds } from '../collect/sql/plans/warehouses.js';
import { PlanFetcher, type PlanSource } from '../collect/sql/plans/fetch.js';
import { retrievePlans, summarise, type PlanRetrieval } from '../collect/sql/plans/retrieve.js';
import type { EstateScope } from '../collect/estate-scope.js';
import type { RunDefinition } from '../scan/identity.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import { analyseServerless, JOB_INVENTORY, SERVERLESS_ANALYZER_SIGNALS, WORKSPACES } from '../analyze/serverless.js';
import { DEFAULT_LOOKBACK_DAYS } from '../scan/runner.js';
import {
  rowsOf,
  type JobCompute,
  type JobRow,
  type JobRunHealth,
  type QueryShapeRow,
  type TableStatistics,
  type WarehousePressureRow,
  type WarehouseRow,
  type WritePatternRow,
  type WorkspaceDirectory,
} from '../collect/sql/shapes.js';
import { asJob, asWarehouse, linksIn } from '../resolve/locate.js';
import { analyseJobs, type JobAnalysis } from './jobs.js';
import { analyseSizing, type SizingAnalysis } from './sizing.js';
import { analyseWrites, type WriteAnalysis } from './writes.js';
import { analyseWorkload, type WorkloadAnalysis } from './workload.js';
import { planIndex } from './plan-index.js';
import { statsIndex } from './stats-index.js';
import { workloadRules } from './workload-rules.js';
import type { Advisory, AdvisoryState } from './advisory.js';
import type { AdvisoryStore } from './store.js';
import type { PlanExtractStore, RetainedPlan } from './plan-store.js';
import { isBaseline, planCapability, type PlanBaseline } from './plan-capability.js';
import { shapeFingerprintVersion, SHAPE_STATEMENT } from '../collect/sql/shape-version.js';
import { FileQuerySource, type QuerySource } from '../collect/sql/queries.js';

/** How far back a plan-reach baseline may come from. `baseline()` says why it is short. */
const BASELINE_LOOKBACK = 5;

/** The signal the workload analysis is built on. Its own constant, so the ask and the read agree. */
export const QUERY_SHAPES = 'sql:workload.query_shapes' as SignalId;

/**
 * The estate's statistics maintenance history, which one rule reads.
 *
 * A second signal rather than a join inside the shapes statement, and not for tidiness: it is keyed on a table
 * where the shapes are keyed on a shape, so joining them would multiply a shape's row by its tables. It is
 * also the only signal here that reads `system.access.table_lineage`, and a run without that permission should
 * lose this rule rather than the whole analysis — which is what a separate reading gets, because the workload
 * analysis is gated on the shapes alone.
 */
export const TABLE_STATISTICS = 'sql:workload.table_statistics' as SignalId;

/**
 * How the estate's jobs ran, which the job analysis is built on.
 *
 * Timing, outcome, repeats and cost, from the two Lakeflow timelines. The one input `33ca` found answerable
 * on an all-serverless estate, and the analysis is gated on it alone.
 */
export const JOB_RUN_HEALTH = 'sql:workload.job_run_health' as SignalId;

/**
 * What the workers of those jobs' classic clusters were doing, which four more rules read.
 *
 * Not gated on, and that is the point of it being a second signal: `system.compute.node_timeline` holds no
 * row for serverless compute, so on an estate like labs this returns nothing and the four timeline rules
 * still run. Where it is absent the four utilisation rules report no population rather than a clean estate —
 * ADR 0074, and `analyseJobs` carries the distinction as `computeRead`.
 */
export const JOB_COMPUTE = 'sql:workload.job_compute_utilisation' as SignalId;

/**
 * The two the sizing analysis reads.
 *
 * The pressure statement measures what a warehouse was asked to do, and the inventory names it — its
 * size, its cluster range, whether it stops and whether it is serverless. Two signals rather than one
 * statement that joins them, because the inventory already carries a fix a second reader of
 * `system.compute.warehouses` would have to repeat: the latest row for a warehouse is the row recording
 * its deletion, and ranking without accounting for that reported 5,101 live warehouses where 24 existed.
 */
export const WAREHOUSE_PRESSURE = 'sql:workload.warehouse_pressure' as SignalId;
export const WAREHOUSE_INVENTORY = 'sql:compute.warehouses' as SignalId;

/**
 * How the estate writes, which the write analysis is built on.
 *
 * Its own signal over the same table the shapes come from, and gated on alone, because it is ranked by what
 * a statement wrote where that one is ranked by what it cost — see `workload_write_patterns.sql`. An estate
 * with no write statements returns nothing here and loses nothing else.
 */
export const WRITE_PATTERNS = 'sql:workload.write_patterns' as SignalId;

/**
 * What an advisory run reads.
 *
 * A declared list, not a set derived from a catalogue, because there are no controls here: nothing
 * scores, so nothing asks for a signal on a requirement's behalf. Adding an analysis means adding its
 * signals to this list, which is the visible cost of a new analysis and the right place to pay it.
 */
export const ADVISORY_SIGNALS: readonly SignalId[] = [
  ...SERVERLESS_ANALYZER_SIGNALS,
  QUERY_SHAPES,
  TABLE_STATISTICS,
  JOB_RUN_HEALTH,
  JOB_COMPUTE,
  WAREHOUSE_PRESSURE,
  WAREHOUSE_INVENTORY,
  WRITE_PATTERNS,
];

/**
 * What an advisory run is asked for.
 *
 * `lookbackDays` is optional here and required on `CollectionOptions`, which is the same split
 * `ScanRequest` makes against `RunScanOptions`: a caller may leave the window to the default, and the
 * collection loop may not — it has to record the number on every reading, and a loop that defaulted it
 * would be a second place the default lives.
 */
export interface AdvisoryRunRequest extends Omit<CollectionOptions, 'lookbackDays'> {
  readonly lookbackDays?: number;
  readonly scope: EstateScope;
  /** The assessment whose scope this ran against, when it was started from one. */
  readonly definition?: RunDefinition;
  /**
   * The run this belongs to, from the coordinator that opened it.
   *
   * Passed in rather than minted here, because the run record exists before the advisory does and the
   * two have to point at each other. Absent only where nothing opened a run — a direct call in a test —
   * and an id is minted so the field is never missing on a record somebody reads.
   */
  readonly runId?: string;
}

/**
 * How a run reaches the two things it needs that are not the warehouse.
 *
 * One port for both rather than two, because they are one dependency in practice: the warehouse list
 * decides which plans are worth asking for and the fetcher asks, so a test that faked one and not the
 * other would still need a workspace to run against.
 */
export interface PlanAccess {
  readonly warehouseIds: () => Promise<Set<string>>;
  readonly fetcher: PlanSource;
}

export type PlanAccessFactory = (credentials: CredentialProvider, identity: DatabricksCredentials) => PlanAccess;

/**
 * The real one: the SDK for the warehouse list, a raw `fetch` for the plan.
 *
 * The asymmetry is the SDK's. `WarehousesService.list` exists and paginates itself; `queryHistory`
 * exposes `list` and no `get`, which is why `fetch.ts` exists at all.
 */
const REAL_PLAN_ACCESS: PlanAccessFactory = (credentials, identity) => ({
  warehouseIds: () => localWarehouseIds(clientFor(credentials)),
  fetcher: new PlanFetcher({ host: identity.host, token: identity.token }),
});

export interface AdvisoryRunnerOptions {
  readonly store: AdvisoryStore;
  /**
   * Where the extracts go, when there is anywhere to put them.
   *
   * Optional because the plan-reading rules are not the run's purpose: an install that cannot keep plans
   * still produces a workload analysis, and the advisory's `plans` summary still says how many came back.
   * `chooseStore` binds it whenever it binds the advisory store, so in practice the two arrive together.
   */
  readonly planExtracts?: PlanExtractStore;
  /**
   * Where the shape statement's text is read from, to name the version its shapes are filed under.
   *
   * The version describes the statement this build ships, which is the statement that just produced
   * these shapes — one process, one bundle, one file. Injectable so a test can state the version it is
   * asserting about rather than digesting the shipped file, and for no other reason: a source that
   * disagreed with the collector's would name a normalisation that did not compute these shapes.
   */
  readonly queries?: QuerySource;
  /**
   * What to do once the advisory is on the record. Today: settle the work raised from earlier advice.
   *
   * After the save rather than before it, and unable to fail the run — the advice is real and worth
   * keeping whatever happens to somebody's board. The same arrangement `ScanRunner.onFinished` has, for
   * the same reason: a run measures the estate, and this reads what was measured against questions
   * somebody asked earlier.
   */
  readonly onFinished?: (advisory: Advisory) => Promise<void>;
  /** Overridden in tests so a run's dates are predictable. */
  readonly clock?: () => Date;
  /** Overridden in tests so a run does not need a workspace to fetch plans from. */
  readonly planAccess?: PlanAccessFactory;
}

export class AdvisoryInProgressError extends Error {
  constructor(
    readonly startedAt: Date,
    readonly actor: string
  ) {
    super(
      `An advisory run started by ${actor} at ${startedAt.toISOString()} is already running. One runs at ` +
        'a time so two people cannot double the load on the warehouse for the same advice. Wait for it ' +
        'to finish; its result will be the latest.'
    );
    this.name = 'AdvisoryInProgressError';
  }
}

/** What a run in flight reports about itself. */
export interface RunningAdvisory {
  readonly startedAt: Date;
  readonly actor: string;
  readonly scope: EstateScope;
  readonly callsMade: number;
}

/**
 * The claim on the runner, held for as long as a run is in flight.
 *
 * `actor` is mutable, which is the one concession here and is worth explaining. The claim has to be
 * taken *before* the first `await` — see `start` — and the actor is not known until the credentials
 * resolve, which is itself an await. So it starts as a placeholder and is filled in a tick later. The
 * alternative is taking the claim after the identity is known, which is the race this exists to close.
 */
interface Claim {
  readonly startedAt: Date;
  actor: string;
  readonly scope: EstateScope;
  readonly promise: Promise<Advisory>;
}

export class AdvisoryRunner {
  private inFlight: Claim | undefined;
  private scheduler: CollectionScheduler | undefined;
  private shapeText: string | undefined;

  constructor(private readonly options: AdvisoryRunnerOptions) {}

  private now(): Date {
    return this.options.clock?.() ?? new Date();
  }

  running(): RunningAdvisory | undefined {
    if (this.inFlight == null) return undefined;
    const { startedAt, actor, scope } = this.inFlight;
    return { startedAt, actor, scope, callsMade: this.callsMade() };
  }

  /** The run in flight's promise, for a caller content to wait rather than be refused. */
  join(): Promise<Advisory> | undefined {
    return this.inFlight?.promise;
  }

  /**
   * Asks the run in flight to stop, and does nothing where there is none.
   *
   * Through the scheduler rather than by rejecting the promise, so the stop takes effect at a unit
   * boundary and what has been read is saved. Doing nothing when idle is deliberate: the coordinator
   * calls this whenever the process holds an advisory run's lease, and a run that has already finished
   * between the flag being written and this call is not an error.
   */
  cancel(): void {
    this.scheduler?.cancel();
  }

  /** Calls that have reached a surface so far. Skipped work is left out, as in a scan. */
  private callsMade(): number {
    if (this.scheduler == null) return 0;
    return Object.values(this.scheduler.footprint().tasks).reduce(
      (total, surface) => total + surface.ok + surface.failed + surface.retries,
      0
    );
  }

  /**
   * Starts a run, or refuses because one is already going.
   *
   * **Nothing is awaited between the check and the claim, and that is the whole of why this method is
   * shaped the way it is.** Two callers arriving in the same tick both run the synchronous prologue
   * before either suspends, so a claim taken after `await credentials.databricks()` is a claim both of
   * them pass — and the refusal that exists to stop two account-wide passes over `system.lakeflow`
   * would let both through. Resolving the identity is therefore inside the chain, and the claim's actor
   * is filled in when it arrives.
   *
   * `async` with nothing awaited before the claim, which is not a contradiction: the body of an async
   * function runs synchronously up to its first `await`, so the claim is taken in the same tick and the
   * refusal still reaches a caller as a rejection rather than as a throw from a method whose signature
   * promises one.
   */
  async start(request: AdvisoryRunRequest): Promise<Advisory> {
    const already = this.running();
    if (already != null) throw new AdvisoryInProgressError(already.startedAt, already.actor);

    const scheduler = new CollectionScheduler();
    const startedAt = this.now();
    const claim: Claim = {
      startedAt,
      // Replaced a tick later, and only ever read by a refusal message. A second caller arriving before
      // the credentials resolve is told the truth about the timing and "somebody" about the person,
      // which is better than being let through.
      actor: 'somebody',
      scope: request.scope,
      promise: this.run(request, scheduler, startedAt, (actor) => (claim.actor = actor))
        .then(async (advisory) => {
          // A cancelled run is saved too, for the reason a cancelled scan is: it reached some of its
          // signals, what it read is real, and the record says so rather than the work being discarded.
          await this.options.store.save(advisory);
          await this.settled(advisory);
          return advisory;
        })
        .finally(() => {
          // In `finally` rather than after the save, so a run that throws does not leave the app
          // permanently refusing to start another.
          this.inFlight = undefined;
          this.scheduler = undefined;
        }),
    };

    this.inFlight = claim;
    this.scheduler = scheduler;
    return claim.promise;
  }

  /**
   * Runs the after-the-save work, and swallows its failure.
   *
   * Caught here rather than left to the caller because of what the caller is: `start` resolves with the
   * advisory, and a rejection out of this would tell whoever asked for advice that their run failed
   * when it is saved and readable. Reported through the same console the scan path uses, since a
   * settlement that did not happen is late rather than lost — the next advisory settles it.
   */
  private async settled(advisory: Advisory): Promise<void> {
    try {
      await this.options.onFinished?.(advisory);
    } catch (error) {
      console.error('[advisory] could not settle the work raised from earlier advice:', error);
    }
  }

  private async run(
    request: AdvisoryRunRequest,
    scheduler: CollectionScheduler,
    startedAt: Date,
    named: (actor: string) => void
  ): Promise<Advisory> {
    const identity = await request.credentials.databricks();
    named(identity.actor);
    const lookbackDays = request.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
    const needed = withInputs(new Set(ADVISORY_SIGNALS), request.collectors);
    const collected = await collectSignals(needed, { ...request, lookbackDays }, scheduler, identity);
    const plans = await this.plans(collected, request, scheduler, identity);
    // Read before this advisory is saved, so the baseline is an earlier run and never this one.
    const alert = planCapability(plans == null ? undefined : summarise(plans), await this.baseline());
    const readings = [...collected.values()];
    const footprint = scheduler.footprint();
    const id = randomUUID();
    // Read once and used twice, because a plan is aged from the advisory that filed it: two calls would
    // put the row's `advisory_at` a few milliseconds off the advisory's own `finishedAt`.
    const finishedAt = this.now();
    const retained = await this.keep(id, finishedAt, plans);

    return {
      id,
      // Filled in by the caller that owns the run record. An advisory produced outside a run — which
      // is every direct call in a test — gets its own id here so the field is never absent.
      runId: request.runId ?? randomUUID(),
      startedAt,
      finishedAt,
      state: state(footprint.cancelled, footprint.exhaustion != null),
      ...(footprint.cancelled
        ? {
            incompleteReason:
              'The run was cancelled. The advice below is formed from what it had read, and is not a ' +
              'complete picture of the estate.',
          }
        : {}),
      scope: request.scope,
      lookbackDays,
      stamp: {
        actor: identity.actor,
        executionMode: identity.mode,
        ...(request.warehouse != null ? { warehouse: request.warehouse } : {}),
      },
      ...(request.definition != null ? { definition: request.definition } : {}),
      // Stripped of values before the record is built, not by the store. What an advisory keeps is the
      // reachability of a signal and not its rows: the rows are what the analysis is derived from, and
      // keeping both would store the estate twice and make the record grow with the estate.
      readings: readings.map(withoutValue),
      ...serverless(collected, lookbackDays),
      ...workload(collected, lookbackDays, plans),
      ...jobs(collected, lookbackDays),
      ...sizing(collected, lookbackDays),
      ...writes(collected, lookbackDays),
      ...(plans == null ? {} : { plans: summarise(plans) }),
      ...(alert == null ? {} : { planCapability: alert }),
      ...(retained == null ? {} : { retainedPlans: retained }),
    };
  }

  /**
   * Keeps this run's extracts, and answers how many, or nothing where none were kept.
   *
   * Never throws, for the reason `baseline` does not: an advisory that produced a workload analysis and
   * failed to file its plans is worth saving, and losing it to a write on a table nothing has read yet
   * would be the worse trade. What stops that from being silent is the number it returns — the record
   * carries it, so a saved advisory reporting plans it read and no count of plans it kept says the write
   * did not finish. See `retainedPlans` on the record, which is the wording it can support: `keep` writes
   * a shape at a time, so a failure partway through has filed some of them and the count is absent.
   *
   * A plan with no `observedAt` is not kept. `retrievePlans` says why the field is optional: the case is
   * one the statement cannot produce, and an execution with no time cannot be ordered against the two it
   * would displace.
   */
  private async keep(
    advisoryId: string,
    advisoryAt: Date,
    plans: PlanRetrieval | undefined
  ): Promise<number | undefined> {
    const store = this.options.planExtracts;
    if (store == null || plans == null || plans.plans.length === 0) return undefined;

    try {
      // Inside the `catch`, and the count's absence is the right report if it throws: a version that
      // cannot be read means these plans were not filed, which is what an absent count says. The case is
      // one a run holding plans has already ruled out — the shapes came from this same file, through this
      // same source — so what is covered here is a packaging fault that collection would have hit first.
      const shapeVersion = shapeFingerprintVersion(this.shapeStatement());
      const retained: RetainedPlan[] = plans.plans.flatMap((plan) =>
        plan.observedAt == null
          ? []
          : [
              {
                workspaceId: plan.workspaceId,
                shape: plan.shape,
                statementId: plan.statementId,
                advisoryId,
                advisoryAt,
                observedAt: plan.observedAt,
                shapeVersion,
                extract: plan.extract,
              },
            ]
      );
      await store.keep(retained);
      return retained.length;
    } catch {
      return undefined;
    }
  }

  /**
   * The shape statement's text.
   *
   * Held on the runner rather than read per run: `FileQuerySource` reads and expands a 600-line file, and
   * a runner outlives the runs it performs. Reading it once is also what makes the version a statement
   * about the build rather than about whatever is on disk during a long-lived process.
   */
  private shapeStatement(): string {
    this.shapeText ??= (this.options.queries ?? new FileQuerySource()).text(SHAPE_STATEMENT);
    return this.shapeText;
  }

  /**
   * The newest earlier run whose plan reach means anything, or nothing.
   *
   * Bounded at five rather than the whole history, because the point of walking back at all is to step over
   * a run that could not list warehouses, and a baseline six runs old says less about today's estate than
   * about how long the app has been broken. Each candidate costs a `get`, since `history` returns summaries.
   *
   * Never throws: a baseline that cannot be read makes the alert quieter, and losing an advisory to a failed
   * history query would be a worse trade than losing the comparison.
   */
  private async baseline(): Promise<PlanBaseline | undefined> {
    try {
      const history = await this.options.store.history(BASELINE_LOOKBACK);
      for (const entry of history) {
        const earlier = await this.options.store.get(entry.id);
        if (earlier?.plans != null && isBaseline(earlier.plans)) {
          return { advisoryId: earlier.id, plans: earlier.plans };
        }
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /**
   * Fetches a plan for each shape the endpoint can answer for, or nothing when there are no shapes.
   *
   * After collection rather than inside it, because a plan fetch is not a signal: it reads nothing off
   * the estate that a control could score, and it needs the shapes as *rows* — which `collectSignals`
   * strips from the record but keeps in the map it returns.
   *
   * Never throws. The warehouse list is the one call here that can fail in a way that stops everything,
   * and the scheduler answers rather than raising: an advisory run that produced a workload analysis and
   * could not list warehouses should return the analysis, with the record saying plan retrieval was not
   * possible. `warehousesKnown` is what carries that, and it is why the empty set and the refusal are
   * not collapsed into one.
   */
  private async plans(
    collected: ReadonlyMap<SignalId, SignalResult>,
    request: AdvisoryRunRequest,
    scheduler: CollectionScheduler,
    identity: DatabricksCredentials
  ): Promise<PlanRetrieval | undefined> {
    const reading = collected.get(QUERY_SHAPES);
    if (reading?.status !== 'observed') return undefined;
    const shapes = rowsOf(reading.value as QueryShapeRow[] | undefined);
    if (shapes.length === 0) return undefined;

    const access = (this.options.planAccess ?? REAL_PLAN_ACCESS)(request.credentials, identity);

    // Submitted rather than called, which is `ADR 0010` and is what the surface means: it is the
    // submission that puts this under `rest`, not the retrying client underneath it. Three things follow
    // that a direct call did not have. The listing spends a `rest` unit and is counted in the footprint,
    // where before it spent nothing and appeared nowhere. It holds a concurrency slot. And a run
    // cancelled during collection never issues it, where before the whole listing went out and
    // `retrievePlans` then discovered the scan had been abandoned — `plans` is reached unconditionally
    // after collection, so there was nothing else to stop it.
    //
    // Counted in the footprint is not the same as counted in `callsMade`, and the difference is the case
    // this row is most about: `callsMade` sums `ok`, `failed` and `retries`, so a listing refused for
    // want of permission is a `skipped` task that spent its unit and shows up in neither. What an
    // operator reading a run in flight now sees is a listing that reached the workspace.
    //
    // One unit for a listing that paginates, and unbounded where a `rest` probe is capped at 1,000
    // records with the truncation reported. Deliberate, and the asymmetry is `retrievable.ts`: it reads
    // an id missing from this set as a shape that ran on another workspace and skips it, so a truncated
    // list is not a smaller reading but a wrong one. Truncate-and-report — the probes' pattern, which
    // here means `warehousesKnown: false` — would trade that for fetching no plans at all on any estate
    // above the ceiling, and there is no measurement of warehouses per workspace to set one from.
    //
    // The abort signal goes unused because `PlanAccess.warehouseIds` takes none, not because the call
    // could not honour one: `WarehousesService.list` accepts a `Context` carrying a cancellation token
    // and checks it between pages, and no SDK call in this app passes one today. So cancellation stops
    // this listing from starting rather than interrupting one in flight.
    const listing = await scheduler.run<Set<string>>({
      surface: 'rest',
      label: 'rest:warehouses.list',
      run: () => access.warehouseIds(),
    });

    // Every outcome that is not `ok` is the same fact — this app could not establish which warehouses are
    // local — and the record keeps that apart from the third state rather than folding all three
    // together. A workspace with no warehouses ran none of the statements being nominated; a list that
    // was refused, cancelled or budgeted out may hold every one of them. Both end in fetching no plans
    // and only the second is about us.
    return retrievePlans({
      shapes,
      localWarehouseIds: listing.status === 'ok' ? listing.value : new Set<string>(),
      warehousesKnown: listing.status === 'ok',
      fetcher: access.fetcher,
      scheduler,
    });
  }
}

/** How completely the run got through its plan. */
function state(cancelled: boolean, exhausted: boolean): AdvisoryState {
  return cancelled || exhausted ? 'partial' : 'complete';
}

/**
 * The serverless analysis, when there was anything to analyse.
 *
 * Unconditional here, unlike in a scan where it is gated on the requirements being in scope: an
 * advisory run exists in order to produce this, so gating it would gate the run's only output.
 */
function serverless(
  collected: ReadonlyMap<SignalId, SignalResult>,
  lookbackDays: number
): { serverless?: ReturnType<typeof analyseServerless> } {
  const analysis = analyseServerless(collected, lookbackDays);
  return analysis == null ? {} : { serverless: analysis };
}

/**
 * The workload analysis, when the shapes could be read.
 *
 * Absent rather than empty where the signal was unreadable or the window held no queries, for the reason
 * `analyseWorkload` gives: an empty analysis renders as an estate with no expensive queries, which is a
 * finding this run did not make. The readings on the record are what distinguish the two.
 *
 * Gated on the shapes alone, where the statistics reading only narrows what one rule can say. That asymmetry
 * is the same one `sizing` draws against its inventory, and for the same reason: an estate whose lineage table
 * is not readable should still get the twelve rules that do not need it.
 */
function workload(
  collected: ReadonlyMap<SignalId, SignalResult>,
  lookbackDays: number,
  plans: PlanRetrieval | undefined
): { workload?: WorkloadAnalysis } {
  const reading = collected.get(QUERY_SHAPES);
  if (reading?.status !== 'observed') return {};
  const statistics = collected.get(TABLE_STATISTICS);
  // `rowsOf` rather than a bare cast, for the reason it exists: a reading imported from a collection an
  // older collector wrote may not hold the shape the type promises, and this runs after the estate has
  // already been paid for.
  const analysis = analyseWorkload(
    rowsOf(reading.value as QueryShapeRow[] | undefined),
    lookbackDays,
    workloadRules(),
    // This run's plans, joined onto the rows by workspace and shape. Retrieval already happened above and
    // its result was only summarised onto the record until `33ib`; passing it here is what lets a rule read
    // an operator graph at all. The retained corpus in `plan_extracts` is deliberately not read — see
    // `plan-index.ts` for why a rule uses this run's plan and not the three kept across runs.
    planIndex(plans?.plans),
    // The statistics, where they were readable. An unreadable reading indexes to empty rather than voiding the
    // analysis, and `stats-index.ts` says why that is safe: a miss in the index already means unknown, so a
    // rule reading an empty one declines everywhere instead of firing wrongly.
    statsIndex(
      statistics?.status === 'observed' ? rowsOf((statistics.value as TableStatistics | undefined)?.tables) : undefined
    )
  );
  return analysis == null ? {} : { workload: analysis };
}

/**
 * The job analysis, when the run health statement could be read.
 *
 * Gated on that statement alone, the same asymmetry `sizing` draws against its inventory: the inventory is
 * what gives a job its name, and its absence costs the names rather than the analysis. An estate whose
 * `system.lakeflow.jobs` read was refused still gets four rules over its runs, reported by job id.
 *
 * The compute reading is passed the same way and the asymmetry there is sharper: it is passed as
 * `undefined` when the statement was not observed and as its rows — possibly none — when it was. The
 * analysis renders those differently, because a run that did not ask and a run that asked and found an
 * all-serverless estate are not the same fact about the estate's clusters.
 */
function jobs(collected: ReadonlyMap<SignalId, SignalResult>, lookbackDays: number): { jobs?: JobAnalysis } {
  const reading = collected.get(JOB_RUN_HEALTH);
  if (reading?.status !== 'observed') return {};
  const inventory = collected.get(JOB_INVENTORY);
  const compute = collected.get(JOB_COMPUTE);
  const analysis = analyseJobs(
    rowsOf((reading.value as JobRunHealth | undefined)?.jobs),
    inventory?.status === 'observed' ? rowsOf(inventory.value as JobRow[] | undefined) : [],
    lookbackDays,
    // The ruleset's own default. Named as absent rather than reconstructed here, so the shipped ruleset is
    // loaded in one place and a test overriding it overrides the same thing the runner uses.
    undefined,
    compute?.status === 'observed' ? rowsOf((compute.value as JobCompute | undefined)?.jobs) : undefined
  );
  if (analysis == null) return {};
  const directory = collected.get(WORKSPACES);
  const locate = linksIn(
    directory?.status === 'observed' ? (directory.value as WorkspaceDirectory | undefined) : undefined
  );
  return {
    jobs: {
      ...analysis,
      jobs: analysis.jobs.map((job) => {
        const link = locate(asJob(job));
        return { ...job, ...(link != null ? { link } : {}) };
      }),
    },
  };
}

/**
 * The warehouse sizing analysis, when the pressure statement could be read.
 *
 * Gated on the pressure signal alone. The inventory is what names a warehouse and what tells a classic one
 * from serverless, and its absence degrades the analysis rather than voiding it: a warehouse with no
 * matched definition is reported by id, and the one rule that needs to know the type declines to fire.
 * Requiring both would throw away a readable measurement because a second statement failed.
 */
function sizing(collected: ReadonlyMap<SignalId, SignalResult>, lookbackDays: number): { sizing?: SizingAnalysis } {
  const reading = collected.get(WAREHOUSE_PRESSURE);
  if (reading?.status !== 'observed') return {};
  const inventory = collected.get(WAREHOUSE_INVENTORY);
  const analysis = analyseSizing(
    rowsOf(reading.value as WarehousePressureRow[] | undefined),
    inventory?.status === 'observed' ? rowsOf(inventory.value as WarehouseRow[] | undefined) : [],
    lookbackDays
  );
  if (analysis == null) return {};
  const directory = collected.get(WORKSPACES);
  const locate = linksIn(
    directory?.status === 'observed' ? (directory.value as WorkspaceDirectory | undefined) : undefined
  );
  return {
    sizing: {
      ...analysis,
      warehouses: analysis.warehouses.map((warehouse) => {
        const link = locate(asWarehouse(warehouse));
        return { ...warehouse, ...(link != null ? { link } : {}) };
      }),
    },
  };
}

/**
 * The write pattern analysis, when the write statement could be read.
 *
 * Gated on that statement alone, and there is no second signal to degrade against: everything the two rules
 * read is in the one row. An estate whose history could not be read has no analysis here rather than an
 * empty one, for the reason `analyseWrites` gives — an empty one would say the estate writes nothing.
 */
function writes(collected: ReadonlyMap<SignalId, SignalResult>, lookbackDays: number): { writes?: WriteAnalysis } {
  const reading = collected.get(WRITE_PATTERNS);
  if (reading?.status !== 'observed') return {};
  const analysis = analyseWrites(rowsOf(reading.value as WritePatternRow[] | undefined), lookbackDays);
  return analysis == null ? {} : { writes: analysis };
}

/**
 * A reading without its rows.
 *
 * The same thing `encodeScan` does before a scan is written, done here rather than in the store because
 * an advisory in memory should not hold the estate either — the in-memory store keeps twenty of them.
 */
function withoutValue(reading: SignalResult): SignalResult {
  const { value: _value, ...rest } = reading;
  return rest;
}
