// The outbound surfaces a scan touches, and what it is allowed to spend on each.
//
// Every call this app makes to anything lands on one of these five. Naming them
// explicitly is what makes a per-surface limit possible: a scan that is polite to
// the warehouse and rude to the serving endpoint is not a polite scan.

/**
 * A distinct outbound surface with its own limits.
 *
 * `describe` is separated from `sql` despite both running statements on the
 * warehouse, because the two need different budgets: a few hundred cheap
 * aggregate queries and a few hundred per-table `DESCRIBE` calls are not
 * interchangeable, and the sampled per-table tier must be capped independently of
 * the estate-wide queries. They share a concurrency ceiling, which is a separate
 * question — see `limiterGroup`.
 *
 * `plans` is separated from `rest` for two reasons that are not the usual one. It is
 * the only surface whose calls this app makes without an SDK underneath — the
 * Query History service exposes `list` and no `get` — so it is the only one where
 * `clientRetries` can be false and mean it. And it is bounded far tighter than
 * `rest`'s eight: a plan fetch is one call per query shape against a single
 * workspace, where the rest of `rest` is spread over many endpoints.
 */
export type Surface = 'sql' | 'describe' | 'rest' | 'cloud' | 'ai' | 'plans';

export const SURFACES: readonly Surface[] = ['sql', 'describe', 'rest', 'cloud', 'ai', 'plans'];

export interface SurfaceLimits {
  /**
   * Ceiling on tasks in flight. The scheduler runs at or below this and reduces
   * itself under pressure, so this is the most it will ever use rather than what
   * it will always use.
   */
  readonly concurrency: number;

  /**
   * Units of work admitted per scan before the scan pauses. Counted in whatever
   * unit the surface bills in: statements for `sql` and `describe`, calls for
   * `rest` and `cloud`, requests for `ai`.
   */
  readonly budget: number;

  /**
   * Whether the client underneath this surface already retries on its own.
   *
   * This decides who retries, and getting it wrong is expensive in a way that is
   * invisible in testing: if the SDK retries three times and the scheduler retries
   * three times around it, a throttled endpoint receives nine requests where the
   * operator asked for one, and the backoff that was supposed to protect them
   * amplifies the load instead. Where this is true the scheduler adjusts
   * concurrency and reports the failure, but never re-issues the task.
   *
   * Each setting below names the client it is a claim about and how that was checked.
   * ADR 0093 records why: this was wrong on `sql` and `describe` for two releases
   * because it was written as a belief about a transport that had since been replaced,
   * and a belief and a reading are indistinguishable once they are both comments.
   */
  readonly clientRetries: boolean;

  /**
   * Surfaces sharing a group share one concurrency limiter.
   *
   * `sql` and `describe` share the `warehouse` group because they share a
   * warehouse. Their budgets are independent but their concurrency cannot be: two
   * limiters of four against one warehouse is eight concurrent statements, which
   * is not what either limit says.
   */
  readonly limiterGroup: string;

  /**
   * Whether concurrency is counted per partition rather than for the surface as a
   * whole. `cloud` is partitioned by service, since S3 and EC2 throttle
   * separately and a shared limiter would let a slow S3 scan starve everything
   * else.
   */
  readonly partitioned: boolean;
}

/**
 * Where the warehouse limits come from.
 *
 * A dedicated warehouse serves only this app, so the only cost of concurrency is
 * a faster scan. A shared one is serving the customer's own queries, and the
 * scan's whole obligation is to stay under a 10% p95 latency degradation bound
 * that it cannot measure from inside itself. Hence two settings rather than one
 * cautious compromise.
 */
export type WarehouseMode = 'shared' | 'dedicated';

/**
 * Starting limits, deliberately conservative and expected to move.
 *
 * These are guesses with reasons, not measurements. The batching spike will
 * replace the warehouse figures with real ones, and until it does the asymmetry
 * of being wrong governs: too low costs a longer scan, too high costs an
 * uninstall. So they err low.
 */
export function defaultLimits(warehouse: WarehouseMode = 'shared'): Record<Surface, SurfaceLimits> {
  return {
    sql: {
      concurrency: warehouse === 'dedicated' ? 4 : 2,
      budget: 250,
      // Said "Statements go through the Databricks SDK, which retries" until ADR 0093.
      // They stopped at ADR 0012, which replaced the SDK's statement path with
      // `StatementExecutor` — whose own header says "No retries. The scheduler owns retry
      // and concurrency per surface (ADR 0010)". Each layer was right about itself and the
      // two stopped composing, so a throttled statement was retried by nobody.
      clientRetries: false,
      limiterGroup: 'warehouse',
      partitioned: false,
    },
    describe: {
      concurrency: warehouse === 'dedicated' ? 4 : 2,
      budget: 250,
      // The same executor as `sql`, so the same answer.
      clientRetries: false,
      limiterGroup: 'warehouse',
      partitioned: false,
    },
    rest: {
      concurrency: 8,
      budget: 3000,
      // True, and checked rather than assumed: probes go through the SDK's
      // `WorkspaceClient`, whose `api-client` wraps every request in a retry loop bounded
      // by `retryTimeoutSeconds`, 300 by default. It is narrower than this app's own
      // `RETRYABLE` — `apierr.isRetryable` takes 429 and transient-message 4xx, and its
      // source says of 500 "we'll add that later" — so a 503 here is retried by nobody.
      // That is a gap in the SDK's coverage rather than in who owns the retry, and
      // flipping this flag would answer it by tripling every 429 as well.
      clientRetries: true,
      limiterGroup: 'rest',
      partitioned: false,
    },
    cloud: {
      concurrency: 4,
      budget: 500,
      // No collector runs on this surface yet, so there is no client underneath to be
      // right or wrong about. Left true because that is the conservative reading of an
      // unwritten transport: whoever writes the first cloud collector decides this, and
      // an over-cautious flag costs a lost signal where an over-eager one costs an
      // amplified burst against someone's account.
      clientRetries: true,
      limiterGroup: 'cloud',
      partitioned: true,
    },
    ai: {
      concurrency: 2,
      budget: 60,
      // AppKit disables retries on serving invokes, so nothing below this layer
      // retries and the scheduler has to.
      clientRetries: false,
      limiterGroup: 'ai',
      partitioned: false,
    },
    plans: {
      // Two, not the four at the top of the range 33m was scheduled against, and this
      // file's own bias decides it: a whole plan fetch is at most `shapeLimit` calls,
      // 40 by default, so two rather than four costs seconds at the end of a run that
      // already spent minutes on the warehouse. Too low costs a slower scan and too
      // high costs an uninstall, and that asymmetry does not change for being small.
      concurrency: 2,
      // Five times the default `shapeLimit` of 40, so the bound that stops a plan
      // fetch is the one shape nomination already applies rather than this. A budget
      // equal to the limit would turn raising `shapeLimit` into a silent truncation
      // here instead of a visible refusal there.
      budget: 200,
      // False, and the only surface where that is a statement about the transport
      // rather than about AppKit. `queryHistory` exposes `list` and no `get`, so a
      // plan is fetched by `fetch` directly, and there is no SDK beneath this to do
      // the retrying — see `plans/fetch.ts`.
      clientRetries: false,
      limiterGroup: 'plans',
      // The endpoint answers only for the workspace the app runs in — that is 33k's
      // finding and the reason `plans/retrievable.ts` exists — so one limiter is
      // already one per workspace, and a partition key would be a constant.
      partitioned: false,
    },
  };
}

/**
 * Wall-clock ceiling for a whole scan.
 *
 * A scan that runs for hours is indistinguishable from a scan that has hung, and
 * an operator who cannot tell the difference will kill it. Reaching this pauses
 * the scan with what it has, which is a result rather than an error.
 */
export const DEFAULT_WALL_CLOCK_MS = 45 * 60 * 1000;
