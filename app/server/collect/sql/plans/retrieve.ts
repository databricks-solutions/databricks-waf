// Fetching a plan for each query shape worth one, and reporting what came back.
//
// The pieces already exist: row 33's statement nominates a representative execution per shape and returns
// its `statement_id`, `retrievable.ts` decides which nominations the endpoint can answer for, `fetch.ts`
// makes the call, and `parse.ts` reads the response. This is the loop between them, and what it mostly
// contributes is the accounting — every shape ends in exactly one recorded outcome, including the ones
// never asked about.
//
// ## Why nothing here recomputes which execution represents a shape
//
// `workload_query_shapes.sql` picks it — highest score, then highest duration, then most recent — and
// returns `statement_id` for the row it picked. A second implementation of that ordering here would be a
// second place it could change, and the plan filed against a shape would then be a plan for whichever
// execution the *other* rule chose. So nomination is a field read, not a decision made.
//
// ## Why a skipped shape is an outcome rather than an absence
//
// A run that fetched 31 plans for 40 shapes has to be able to say which nine and why, and the reasons are
// not interchangeable: `warehouse-outside-workspace` is an estate that spans workspaces, and
// `not-warehouse-compute` is a statement that never had a warehouse plan to fetch. Reported as a count,
// both read as the app having failed nine times.

import { parsePlanResponse, type ParsedPlan, type PlanExtract } from './parse.js';
import { planCandidates, type SkipReason } from './retrievable.js';
import { PlanBreaker } from './breaker.js';
import type { PlanResponse, PlanSource } from './fetch.js';
import type { QueryShapeRow } from '../shapes.js';
import type { CollectionScheduler } from '../../../scan/scheduler.js';

/**
 * What happened to one shape's plan.
 *
 * `skipped` is decided before a call, `failed` after one, and the two are separated because only the
 * second says anything about the platform. `33m`'s circuit breaker counts the second and would be
 * measuring the shape of the estate if it counted the first.
 */
/**
 * Which row an outcome belongs to.
 *
 * The workspace as well as the shape, because `workload_query_shapes.sql` groups by both: the same query
 * text running in two workspaces is two rows sharing one `shape`, and they can end differently — the one
 * in this workspace is fetchable and the one in a sibling is `warehouse-outside-workspace` by
 * construction, which is `33k`'s whole finding. Keyed on the shape alone, the second row overwrote the
 * first and the run reported one of them twice.
 */
export interface ShapeKey {
  readonly workspaceId: string;
  readonly shape: string;
}

export type PlanAttempt =
  | ({ readonly kind: 'parsed'; readonly parsed: ParsedPlan } & ShapeKey)
  | ({ readonly kind: 'skipped'; readonly reason: SkipReason } & ShapeKey)
  | ({ readonly kind: 'failed'; readonly detail: string } & ShapeKey)
  // Not a `skipped` reason: that type means a reason known without asking, and this one is only known
  // because enough asking already failed. Kept apart so a reader can tell an estate whose shapes ran
  // elsewhere from an endpoint that stopped answering part-way through.
  | ({ readonly kind: 'abandoned' } & ShapeKey)
  /**
   * Nothing was asked about this one: the run was cancelled, its budget was spent, or the warehouse list
   * it would have been filtered against was never read.
   *
   * Distinct from `failed` because nothing was learned about the endpoint. Folded into it, a cancelled run
   * looked identical to an endpoint answering nothing, and `plan-capability.ts` reported reach lost.
   */
  | ({ readonly kind: 'not-run'; readonly detail: string } & ShapeKey);

/** One shape's plan, where there was one to keep. */
export interface ShapePlan extends ShapeKey {
  readonly statementId: string;
  readonly extract: PlanExtract;
  /**
   * When the execution this plan describes ran, from the shape's representative.
   *
   * The domain time, which is what `33n` files a retained plan under and orders three of them by. It is
   * optional for the same reason `no-statement` is a skip reason the statement cannot produce: the two
   * come off one joined row in `workload_query_shapes.sql`, so a statement id without a start time is
   * not something the SQL can return — but the row type allows it, and a retained execution with no time
   * cannot be ordered against the two it would displace.
   */
  readonly observedAt?: Date;
}

/**
 * The two fields together, as a map key. Neither can hold the separator: both are ids.
 *
 * Exported because `plan-index.ts` keys the same pair for the analysis, and a second spelling of a key is a
 * second place for the reasoning above to be wrong.
 */
export function shapeMapKey(row: ShapeKey): string {
  return `${row.workspaceId}\u0000${row.shape}`;
}

export interface PlanRetrieval {
  /** The extracts, for the rules in `33ib` to `33ig` to read and `33n` to persist. */
  readonly plans: readonly ShapePlan[];
  /** Every shape's outcome, in the order the shapes arrived. One entry per shape, always. */
  readonly attempts: readonly PlanAttempt[];
  /**
   * Whether the workspace's warehouse list could be read.
   *
   * False means every shape was skipped for a reason that is about this run rather than about the
   * estate, and a reader told "no plans were retrievable" without that would draw the wrong conclusion
   * from it.
   *
   * Three causes since `41c`, not one. The list is submitted to the scheduler, so it is false for a
   * refusal, for a run cancelled before the listing went out, and for a spent budget or wall clock. The
   * three are one fact to every reader of this field — nothing was established about which warehouses
   * are local — and a surface that wants to say which one has to be given it, because this boolean
   * cannot carry it.
   */
  readonly warehousesKnown: boolean;
}

/**
 * What a run's plan retrieval came to, small enough to keep on the advisory record.
 *
 * The extracts are not here and will not be: `33b` measured them at 2 MB per workspace per scan against
 * a body that is one jsonb document, and where they go is `33n`'s question. What a reader needs from the
 * record is narrower — whether plan-level advice was possible at all, and if not, whether that is a fact
 * about this estate or about this app's permissions.
 */
export interface PlanRetrievalSummary {
  /** Shapes whose plan was fetched and yielded a graph. */
  readonly available: number;
  /** Shapes the platform answered for, without a graph: no plan, no parsable graph, or a 404. */
  readonly withoutPlan: number;
  /** Shapes never asked about, by reason. Absent reasons are absent rather than zero. */
  readonly skipped: Readonly<Partial<Record<SkipReason, number>>>;
  /**
   * Shapes that were asked about and whose fetch came back with no answer, after its own retries.
   *
   * The breaker counts a subset of this: the outcomes the scheduler classified as failed. A shape the
   * scheduler never ran is `notRun` and is in neither number.
   */
  readonly failed: number;
  /** Shapes the breaker had already opened before, so no request was made for them. */
  readonly abandoned: number;
  /**
   * Shapes nothing was asked about: the scan was cancelled, its budget was spent, or — since `41c` — the
   * warehouse list was not read, so no shape could be established as one this workspace can ask about.
   */
  readonly notRun: number;
  /** See `PlanRetrieval.warehousesKnown` — false makes every other number here uninformative. */
  readonly warehousesKnown: boolean;
}

export function summarise(retrieval: PlanRetrieval): PlanRetrievalSummary {
  const skipped: Partial<Record<SkipReason, number>> = {};
  let available = 0;
  let withoutPlan = 0;
  let failed = 0;
  let abandoned = 0;
  let notRun = 0;

  for (const attempt of retrieval.attempts) {
    if (attempt.kind === 'skipped') skipped[attempt.reason] = (skipped[attempt.reason] ?? 0) + 1;
    else if (attempt.kind === 'failed') failed += 1;
    else if (attempt.kind === 'abandoned') abandoned += 1;
    else if (attempt.kind === 'not-run') notRun += 1;
    else if (attempt.parsed.outcome === 'available') available += 1;
    else withoutPlan += 1;
  }

  return {
    available,
    withoutPlan,
    skipped,
    failed,
    abandoned,
    notRun,
    warehousesKnown: retrieval.warehousesKnown,
  };
}

export interface RetrievePlansOptions {
  readonly shapes: readonly QueryShapeRow[];
  readonly localWarehouseIds: ReadonlySet<string>;
  readonly warehousesKnown: boolean;
  readonly fetcher: PlanSource;
  readonly scheduler: CollectionScheduler;
  /** Injectable so a test can state a threshold; a run gets a fresh one per retrieval. */
  readonly breaker?: PlanBreaker;
}

/**
 * Fetches a plan per shape, bounded by the scheduler and pre-filtered by `retrievable.ts`.
 *
 * Every fetch goes through `scheduler.run` on the `plans` surface, which is what applies the concurrency
 * bound, the budget, the retry policy and cancellation. Calling `fetcher.plan` directly would opt out of
 * all four, which is the mistake `ADR 0010` exists to prevent.
 */
export async function retrievePlans(options: RetrievePlansOptions): Promise<PlanRetrieval> {
  const { shapes, localWarehouseIds, warehousesKnown, fetcher, scheduler } = options;
  const { fetch: candidates, skipped } = planCandidates(shapes, localWarehouseIds);

  const attempts = new Map<string, PlanAttempt>();
  for (const { shape, reason } of skipped) {
    const at = { workspaceId: shape.workspaceId, shape: shape.shape };
    // `warehouse-outside-workspace` is a claim about where the shape ran, and an unread warehouse list
    // cannot support it: every id is missing from an empty set, so every shape would be recorded as
    // having run somewhere this workspace cannot see. Recorded as never asked about instead, which is
    // what happened to it. The other three reasons are read off the shape and hold whatever the list
    // says, so they keep their own.
    //
    // Reached by a cancelled run since `41c` put the listing behind the scheduler, and by a refused one
    // before that.
    attempts.set(
      shapeMapKey(shape),
      !warehousesKnown && reason === 'warehouse-outside-workspace'
        ? { kind: 'not-run', ...at, detail: 'the workspace warehouse list was not read' }
        : { kind: 'skipped', ...at, reason }
    );
  }

  const plans: ShapePlan[] = [];

  const breaker = options.breaker ?? new PlanBreaker();

  // Fired together rather than in sequence, because the concurrency bound is the scheduler's to apply and
  // a loop that awaited each call would hold the surface at one regardless of what the limiter allows.
  //
  // The breaker is the task's `skipWhen` rather than a check inside `run`, for two reasons that both come
  // from where the scheduler evaluates each. `skipWhen` runs after the limiter admits the task, so a shape
  // queued behind a run of failures still sees an open breaker — that is what makes a breaker work here at
  // all. And it runs once, before the first attempt, where `run` is re-invoked per retry: a shape checked
  // inside `run` could make requests, fail, and then be recorded as one that was never asked about.
  const fetched = await Promise.all(
    candidates.map(async (shape) => {
      const outcome = await scheduler.run<PlanResponse>({
        surface: 'plans',
        label: `plan ${shape.shape}`,
        skipWhen: () => (breaker.open() ? 'the query history endpoint stopped answering' : undefined),
        run: (signal) => fetcher.plan(shape.statementId, signal),
      });

      // Recorded as each task settles rather than after `Promise.all`, so the count is available to the
      // shapes still queued. After the gather it would only ever describe a fetch that had finished.
      if (outcome.status === 'ok') breaker.answered();
      else if (outcome.status === 'failed') breaker.failed();

      return { shape, outcome };
    })
  );

  for (const { shape, outcome } of fetched) {
    const at = { workspaceId: shape.workspaceId, shape: shape.shape };
    if (outcome.status === 'ok') {
      const parsed = parsePlanResponse(outcome.value.status, outcome.value.body);
      attempts.set(shapeMapKey(shape), { kind: 'parsed', ...at, parsed });
      if (parsed.outcome === 'available') {
        plans.push({
          ...at,
          statementId: shape.statementId,
          extract: parsed.extract,
          ...(shape.representativeAt != null ? { observedAt: shape.representativeAt } : {}),
        });
      }
      continue;
    }

    if (outcome.status === 'failed') {
      attempts.set(shapeMapKey(shape), { kind: 'failed', ...at, detail: outcome.failure.message });
      continue;
    }

    // A `skipped` outcome from the scheduler is not a `skipped` attempt here, and it is not a failed one
    // either. The scheduler skips for cancellation, an exhausted budget, a status `classify` treats as
    // degradation, and the breaker — and none of those is a fact about whether the plan was retrievable.
    // Folded into `failed`, a cancelled run read as an endpoint that had stopped answering.
    attempts.set(
      shapeMapKey(shape),
      outcome.reason === 'precondition'
        ? { kind: 'abandoned', ...at }
        : { kind: 'not-run', ...at, detail: outcome.detail }
    );
  }

  return {
    plans,
    attempts: shapes.flatMap((shape) => {
      const attempt = attempts.get(shapeMapKey(shape));
      return attempt == null ? [] : [attempt];
    }),
    warehousesKnown,
  };
}
