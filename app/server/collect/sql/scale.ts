// The estate this app is built to assess, and what an inline result costs at that size.
//
// H1a made every statement declare how many rows it can return. That declaration is a claim, and for
// eight statements the claim is "one row per job" or "one per cluster" — honest, and unbounded. What
// it does not say is whether unbounded actually breaks anything, and until something measures that,
// the eight are a list of things a reader has to take on trust.
//
// This module is the measurement. Three pieces, and the order matters:
//
//   `SCALE_TARGETS` is the estate, declared once. Nothing about a customer's estate is knowable from
//   the code, so the size the app claims to handle has to be written down somewhere or it is decided
//   accidentally by whoever ships the next statement.
//
//   `ROWS_PER` turns a statement's own `-- Rows: one per job` header into a row count at that target,
//   which is what makes this general rather than a table of hand-maintained numbers. The author
//   already declares the axis; this says how long the axis is.
//
//   `inlineBytes` serialises rows the way the Statement Execution API does and measures them, because
//   the cap that matters is a byte count and not a row count. A statement returning 200,000 narrow
//   rows can be safe where one returning 30,000 wide ones is not, and guessing which is which from
//   the row count is how a ceiling gets set to a number that feels about right.
//
// The cap is the whole reason any of this exists: an inline result is capped at 25 MiB and **fails**
// past the cap rather than truncating, so the larger the customer, the likelier they get no
// assessment rather than a smaller one.

/** Bytes an inline result may hold before the Statement Execution API refuses it. */
export const INLINE_CAP_BYTES = 25 * 1024 * 1024;

/**
 * How far past the declared target a statement has to keep working.
 *
 * Measuring the eight put one of them over the cap outright and three more inside a factor of two.
 * `serverless_job_readiness` is 27.6 MiB at 100,000 jobs, 110% of an inline result, and **fails at
 * 90,606** — below the estate this app says it assesses, so it is broken now rather than on growth.
 * `jobs_inventory` fails at 124,034, `serverless_job_spend` at 136,877, `compute_cluster_inventory` at
 * 97,759.
 *
 * Reaching those numbers took two passes, and the first was wrong in the optimistic direction. It read
 * 99% for the readiness statement, because the fixture measuring it was one column narrower than the
 * statement — no `runtimes` list — so the measurement was of a statement that does not exist. A
 * measurement is only worth its apparatus, and `scale.test.ts` now holds every fixture to the arity of
 * its own `SELECT`.
 *
 * The cap is still not the gate, because three of these fit and fail on a customer's growth, which a
 * cap comparison cannot express. A target is an estimate, and an estate that hit the estimate last year
 * is over it this year. So the gate is fitting at twice the target, the smallest multiple that means
 * anything: a statement passing at exactly 1.0 fails on growth, and one held to 10 would fail the four
 * that are genuinely fine. Two is a year or two of headroom, stated rather than assumed.
 */
export const GROWTH_MARGIN = 2;

/**
 * The estate size this app claims to assess, by the axis a statement's header names.
 *
 * Chosen to be a large enterprise rather than the largest imaginable one, because a target nothing
 * plausibly reaches produces ceilings that block correct work. Five of these are the plan's declared
 * targets; `pipeline` and `catalog` are added here because two statements scale on those axes and
 * naming a number is the only way for the check below to have an opinion about them.
 *
 * These are deliberately not thresholds a customer can configure. A configurable target is a target
 * that gets lowered when a test fails.
 */
export const SCALE_TARGETS = {
  /** Workspaces in one account. Above the ~200 an account is soft-limited to, to leave headroom. */
  workspace: 500,
  /** Jobs across those workspaces. */
  job: 100_000,
  /**
   * Clusters across those workspaces.
   *
   * `system.compute.clusters` keeps a row per job-cluster definition and not per running cluster, so
   * this counts definitions and runs well ahead of any fleet a customer would describe in these terms.
   *
   * 150,000 because 50,000 was a guess and this is measured: a large account holds 135,177 live cluster
   * definitions, which the guess understated by 2.7x. Raising it does not change the verdict — the
   * statement was already declared past the cap — it changes how far past, which is what H1d has to
   * close.
   */
  cluster: 150_000,
  /** SQL warehouses. Small because warehouses are provisioned deliberately and reviewed. */
  warehouse: 1_000,
  /** Lakeflow pipelines. */
  pipeline: 10_000,
  /** Unity Catalog catalogs. */
  catalog: 1_000,
  /** Tables in the metastore, which only the sampled storage statements read at this cardinality. */
  table: 1_000_000,
  /** Days of query history any statement may look back over. */
  historyDays: 30,
} as const;

/** An axis a statement's row count can grow along, as its `-- Rows: one per <thing>` header names it. */
export type ScaleAxis = keyof typeof SCALE_TARGETS;

/**
 * Rows a statement returns at target scale, from the axis its own header declares.
 *
 * Returns undefined for an axis with no declared target, which is a gap to close by declaring one
 * rather than a statement to wave through — `rowsAtTarget` reports it as unmeasurable so the ceiling
 * test fails rather than silently skipping.
 */
export function rowsAtTarget(per: string): number | undefined {
  const axis = singular(per);
  if (!(axis in SCALE_TARGETS)) return undefined;
  return SCALE_TARGETS[axis as ScaleAxis];
}

/**
 * The axis name, normalised.
 *
 * `-- Rows: one per job` and `one per pipeline` are what the headers say today, and the plural and
 * the spaced form are accepted because a header is prose and the next author will write `one per
 * pipelines` eventually. Better to read it than to fail a statement over a letter.
 */
function singular(per: string): string {
  const word = per.trim().toLowerCase().replace(/\s+/g, '_');
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

/**
 * Bytes an inline `JSON_ARRAY` result holds for these rows.
 *
 * Measured against the wire format rather than modelled, because the format is where the cost is:
 * `statements.ts` asks for `JSON_ARRAY`, so every value arrives as a quoted string in an array of
 * arrays, and a null integer column costs four bytes while a job name costs its length plus quotes.
 * A model would have to keep up with that, and would be wrong in the direction of optimism.
 *
 * The chunk envelope around `data_array` is excluded. It is a few hundred bytes against a cap of 25
 * MiB, and including it would imply a precision this does not have.
 */
export function inlineBytes(rows: readonly (readonly (string | null)[])[]): number {
  return Buffer.byteLength(JSON.stringify(rows), 'utf8');
}

/**
 * Bytes an inline result holds at a row count, extrapolated from a varied sample.
 *
 * Extrapolated rather than materialised because the largest target is 100,000 rows against statements
 * selecting thirty-odd columns, and holding several million strings to measure a length would make
 * the test slower than the thing it protects. The sample carries the variation instead — short job
 * names beside the sixty-character generated ones, populated columns beside the nulls a row written
 * before a column existed has — so the mean it produces is a mean over realistic rows and not over
 * one row repeated.
 *
 * Not exact, and the inexactness is one-sided in the direction that matters. A cap this lands within
 * a few per cent of is a cap the statement is already too close to.
 */
export function bytesAtScale(sample: readonly (readonly (string | null)[])[], rows: number): number {
  if (sample.length === 0 || rows === 0) return 0;
  const perRow = inlineBytes(sample) / sample.length;
  return Math.round(perRow * rows);
}

/**
 * Why a statement has too little room at target scale, as prose, or undefined when it has enough.
 *
 * Prose rather than a boolean so the caller can say what the numbers were. "Over budget" sends the
 * reader off to measure it again; "27.6 MiB at 100,000 rows, 110% of the cap, fails at 90,606" has
 * already told them the size of the problem and what a fix has to achieve.
 *
 * The row count it fails at is the useful half. A percentage of a cap is abstract, and the estate size
 * that stops working is the same fact in the units the customer's estate is measured in.
 */
export function insufficientMargin(bytes: number, rows: number, per: string): string | undefined {
  if (bytes * GROWTH_MARGIN <= INLINE_CAP_BYTES) return undefined;
  const perRow = bytes / rows;
  const breaks = Math.floor(INLINE_CAP_BYTES / perRow);
  const verb = bytes > INLINE_CAP_BYTES ? 'already over' : 'fills';
  return (
    `${verb} ${percentOfCap(bytes)} of an inline result at ${rows.toLocaleString('en-US')} rows ` +
    `(one per ${per}, ${mib(bytes)} of ${mib(INLINE_CAP_BYTES)}), and fails outright at ` +
    `${breaks.toLocaleString('en-US')}. The gate is fitting at ${String(GROWTH_MARGIN)}x the declared ` +
    `target, because past the cap the Statement Execution API fails the statement rather than ` +
    `truncating it — so an estate that grows into this gets no assessment rather than a smaller one.`
  );
}

/** Share of an inline result these bytes occupy, for a reader who thinks in headroom. */
export function percentOfCap(bytes: number): string {
  return `${((bytes / INLINE_CAP_BYTES) * 100).toFixed(0)}%`;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
