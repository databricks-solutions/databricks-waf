// Which nominated executions the plan endpoint can answer for, decided before a call is spent.
//
// `GET /api/2.0/sql/history/queries/{id}` is scoped to the workspace the app runs in.
// `system.query.history` is a system table on the metastore and carries every workspace that shares
// it. The two do not cover the same set, and where they differ the endpoint returns `404` — with a
// body that says nothing about which of the two reasons applies.
//
// Row 33k measured the gap on labs over fifteen days: of 21,693 statements, 20,996 (96.79%) ran on a
// warehouse this workspace can see, 673 (3.10%) on one of four it cannot, and 24 (0.11%) on compute
// that is not a warehouse. Both misses are decidable from two columns the shapes statement now
// returns, so 3.21% of the calls become calls never made.
//
// ## What this buys is not the calls
//
// 3.21% of a bounded fetch is not much traffic. What it buys is that an unexpected `404` becomes a
// signal: with the predictable misses removed, a failure rate is a statement about the platform or
// about our permissions rather than about the shape of the estate. Row 33m's circuit breaker trips on
// that rate, and a threshold set over a population containing a known-unfetchable 3.21% would have to
// be tuned around it — which means tuned around whatever proportion of a *particular* estate's
// statements come from sibling workspaces, a figure that is 3.10% on labs and unknown anywhere else.
//
// ## What this deliberately does not decide
//
// Whether a plan *exists*. A cache hit is retrievable and returns `200` with `plans_state: EMPTY`;
// a statement that failed before planning is the same. Those are outcomes of a call that was made,
// and `parse.ts` reads them. This module answers only whether the call can be answered at all.

/**
 * Why a nominated execution's plan cannot be fetched, known without asking.
 *
 * The three that 33k measured, plus `no-statement`. That fourth one is not something the statement can
 * produce — `workload_query_shapes.sql` returns a row only where `runs_now > 0`, and the representative
 * CTE covers exactly those rows — but `statementId` is optional on the row type, so a caller that
 * skipped the check would fetch a plan for `undefined`.
 */
export type SkipReason =
  | 'no-statement'
  | 'not-warehouse-compute'
  | 'no-warehouse-id'
  | 'warehouse-outside-workspace';

/**
 * What the pre-filter reads: one shape's nominated execution and where it ran.
 *
 * A structural subset of `QueryShapeRow` rather than the row itself, so a test can state a case in
 * four fields and so the dependency runs one way — the plans module reads shapes, and nothing about
 * shapes needs to know plans exist.
 */
export interface NominatedExecution {
  readonly statementId?: string;
  readonly representativeComputeType?: string;
  readonly representativeWarehouseId?: string;
}

/**
 * Whether to call the plan endpoint for this execution, and why not where the answer is no.
 *
 * `null` means call. The order of the checks is the order of the questions: is there something to
 * fetch, did it run somewhere with a plan, and is that somewhere one this workspace can ask about.
 *
 * `localWarehouseIds` is the workspace's own warehouse list. Empty is not "no restriction" — it skips
 * everything, which is the safe direction: a caller that could not read the warehouse list has not
 * established that any id is local, and spending the whole fetch to be told `404` is worse than
 * spending none. Row 33m is where that set comes from and where a scan says so when it is empty.
 */
export function skipReason(
  execution: NominatedExecution,
  localWarehouseIds: ReadonlySet<string>,
): SkipReason | null {
  if (execution.statementId == null || execution.statementId === '') return 'no-statement';
  // Uppercased because it is compared against a platform enum, not because a lower-case value has
  // been seen. `system.query.history` records `WAREHOUSE`; the other kinds 404 whatever their spelling.
  if ((execution.representativeComputeType ?? '').toUpperCase() !== 'WAREHOUSE') {
    return 'not-warehouse-compute';
  }
  const warehouseId = execution.representativeWarehouseId;
  if (warehouseId == null || warehouseId === '') return 'no-warehouse-id';
  if (!localWarehouseIds.has(warehouseId)) return 'warehouse-outside-workspace';
  return null;
}

/** One execution the pre-filter declined, and the reason, so a scan can report what it did not read. */
export interface SkippedExecution<T> {
  readonly shape: T;
  readonly reason: SkipReason;
}

/**
 * An execution that passed the filter, carrying the guarantee in its type.
 *
 * `statementId` is optional on `QueryShapeRow` and required to fetch anything, and the `no-statement`
 * check above is what closes that gap. Saying so here rather than leaving it to a comment means the
 * caller writes `shape.statementId` instead of asserting a non-null the filter already established —
 * and an assertion is indistinguishable from a guess at the point somebody reads it.
 */
export type Nominated<T> = T & { readonly statementId: string };

export interface PlanCandidates<T> {
  readonly fetch: readonly Nominated<T>[];
  /**
   * Kept rather than counted, because a surface that says "twelve shapes, nine plans" has to be able
   * to say which three and why. A count alone reads as a failure of the app.
   */
  readonly skipped: readonly SkippedExecution<T>[];
}

/**
 * Split nominated executions into the ones worth a call and the ones already answered.
 *
 * Generic over the row so this holds `QueryShapeRow`s and hands them back whole: the caller needs the
 * shape it skipped, not a statement id it would then have to look back up.
 */
export function planCandidates<T extends NominatedExecution>(
  executions: readonly T[],
  localWarehouseIds: ReadonlySet<string>,
): PlanCandidates<T> {
  const fetch: Nominated<T>[] = [];
  const skipped: SkippedExecution<T>[] = [];
  for (const shape of executions) {
    const reason = skipReason(shape, localWarehouseIds);
    // The cast is the one place the `no-statement` check is converted into a type, rather than every
    // caller doing it in a place where the check is out of sight.
    if (reason == null) fetch.push(shape as Nominated<T>);
    else skipped.push({ shape, reason });
  }
  return { fetch, skipped };
}
