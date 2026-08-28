// How many rows a statement is allowed to return, declared by the statement itself.
//
// `statements.ts` asks the Statement Execution API for `INLINE` results, and the comment there
// used to justify it by asserting that every statement in `config/statements` is "an aggregate or
// an explicitly capped detail query". Eight of the nineteen were neither. `jobs_inventory` returns
// one row per job and `compute_cluster_inventory` one row per cluster, with no `LIMIT` and no
// `GROUP BY` between them, and `system.compute.clusters` keeps a row per job-cluster definition so
// that count runs well ahead of anything a customer would call a fleet.
//
// The failure mode is what makes this worth a mechanism rather than two edits. Inline results are
// capped at 25 MiB, and past the cap the statement **fails** — so the larger the estate, the more
// likely the customer gets no assessment at all, rather than a smaller one that says it is smaller.
// Everything else in the scan degrades: a surface budget runs out and records why, a sampled tier
// says it sampled. This one falls over, and it falls over first for the customers who matter most.
//
// So the rule is that a statement declares its own ceiling in its header, and the declaration is
// checked from two sides:
//
//   `scripts/check-statement-bounds.mjs` reads every file and refuses one that declares nothing, or
//   that declares a ceiling growing with the estate and is not on the manifest of the eight already
//   doing so. The manifest can only shrink.
//
//   This module is the runtime half. A statement that declared a fixed ceiling and returned more
//   rows than that is a defect in the statement, and saying so beats discovering it as a 25 MiB
//   failure against a customer's estate months later.
//
// Declaring rather than inferring is deliberate. Deciding whether an arbitrary SQL statement's
// result grows with its input is not something a regular expression can do, and a check that
// guesses is a check that either blocks correct work or passes the next `jobs_inventory`. A
// declaration is a claim an author makes and a reviewer can see, and the runtime holds them to it.

/** The ceiling a statement declares, parsed from its `-- Rows:` header. */
export type Bound = Fixed | Parameterised | EstateScaled;

/** `-- Rows: 1` or `-- Rows: at most 100`. A constant, whatever the estate looks like. */
export interface Fixed {
  readonly kind: 'fixed';
  readonly rows: number;
}

/**
 * `-- Rows: at most :segment_limit`. Capped, by a value the collector binds.
 *
 * Distinct from `fixed` because the number is not in the file, so the runtime check needs the bound
 * parameter's value to enforce it and the static check can only confirm that a cap exists. Three
 * statements already work this way — `uc_schema_census`, `storage_table_metrics` and
 * `storage_sample_selection` — and they are the pattern the eight below should end up following.
 */
export interface Parameterised {
  readonly kind: 'parameterised';
  readonly parameter: string;
}

/**
 * `-- Rows: one per job`. Grows with the estate, which is the defect.
 *
 * Kept as a declarable form rather than made unrepresentable, because the eight statements that do
 * this exist today and the alternative to naming them is a check nobody can turn on. Naming them
 * puts each one in the manifest with a row in `docs/plan-status.md`, and the check refuses a ninth.
 */
export interface EstateScaled {
  readonly kind: 'estate-scaled';
  /** What the row count is proportional to: `job`, `cluster`, `workspace`. */
  readonly per: string;
}

const DECLARATION = /^--\s*Rows:\s*(.+?)\s*$/im;
const FIXED = /^(\d+)$/;
const AT_MOST_FIXED = /^at most (\d+)$/i;
const AT_MOST_PARAMETER = /^at most :([a-z_][a-z0-9_]*)$/i;
const ONE_PER = /^one per ([a-z][a-z0-9 _-]*)$/i;

/**
 * The bound a statement declares, or undefined when it declares none.
 *
 * Reads the loaded statement text rather than the file, so the runtime and the CI check parse the
 * same string through the same function. `FileQuerySource` strips a trailing semicolon and expands
 * `{{customer_catalog}}` fragments but leaves comments alone, which is what makes that possible.
 */
export function declaredBound(statement: string): Bound | undefined {
  const declaration = DECLARATION.exec(statement);
  if (declaration == null) return undefined;
  return parseBound(declaration[1]);
}

/** The declaration's value, parsed. Exported for the CI check, which reports on the text. */
export function parseBound(text: string): Bound | undefined {
  const fixed = FIXED.exec(text) ?? AT_MOST_FIXED.exec(text);
  if (fixed != null) return { kind: 'fixed', rows: Number(fixed[1]) };

  const parameterised = AT_MOST_PARAMETER.exec(text);
  if (parameterised != null) return { kind: 'parameterised', parameter: parameterised[1] };

  const scaled = ONE_PER.exec(text);
  if (scaled != null) return { kind: 'estate-scaled', per: scaled[1].trim() };

  return undefined;
}

/**
 * Why a statement's row count breaks its declaration, or undefined when it does not.
 *
 * Returns prose rather than throwing, and the caller decides what to do with it. At collection time
 * the rows are already in hand and already parseable: discarding a usable reading because it was
 * one row over a declaration would turn a documentation error into a lost measurement, which is the
 * wrong trade in a tool whose whole argument is that coverage is a statement about the estate.
 *
 * Two ways to break a declaration, and the second is the one that hid. A statement can return more
 * rows than it declared, and a statement can declare a ceiling that nothing supplies — where the
 * answer is not "no violation" but "this statement is running unchecked". This function returned
 * undefined for the second case, and said so in a comment claiming the parameter list test would
 * catch it. That test strips comment lines before matching, so it never saw a parameter that appears
 * only in a `-- Rows:` header. `at most :made_up_limit` passed the static check, passed the parameter
 * test, and disabled this one, which is three layers agreeing because none of them looked.
 *
 * An estate-scaled declaration is the one thing genuinely unenforceable here, and that is what the
 * manifest in `scripts/check-statement-bounds.mjs` is for: there is no ceiling to hold a statement
 * to, so only the static check can refuse a new one.
 */
export function boundProblem(bound: Bound | undefined, rows: number, limits: BoundParameters = {}): string | undefined {
  if (bound == null || bound.kind === 'estate-scaled') return undefined;

  if (bound.kind === 'fixed') return over(rows, bound.rows, String(bound.rows));

  const ceiling = limits[bound.parameter];
  if (ceiling == null) {
    return (
      `declares a ceiling of :${bound.parameter}, and no numeric value for that parameter was bound, ` +
      `so the ${rows.toLocaleString('en-US')} rows it returned were checked against nothing. Either the ` +
      `\`-- Rows:\` header names the wrong parameter, or the cap it names is no longer bound as a number. ` +
      `Until one of those is true the statement has no enforced ceiling, and an inline result is capped ` +
      `at 25 MiB by the Statement Execution API and fails rather than truncating.`
    );
  }

  return over(rows, ceiling, `:${bound.parameter} (${String(ceiling)})`);
}

/** The overrun message, or undefined when the count is within the ceiling. */
function over(rows: number, ceiling: number, declared: string): string | undefined {
  if (rows <= ceiling) return undefined;
  return (
    `returned ${rows.toLocaleString('en-US')} rows against a declared ceiling of ${declared}. ` +
    `The statement's own \`-- Rows:\` header is wrong, or the statement lost its cap: an inline ` +
    `result is capped at 25 MiB by the Statement Execution API and fails rather than truncating, ` +
    `so this grows into a scan that cannot run on a larger estate.`
  );
}

/** Values for `at most :parameter` declarations, as the collector bound them. */
export type BoundParameters = Readonly<Record<string, number | undefined>>;
