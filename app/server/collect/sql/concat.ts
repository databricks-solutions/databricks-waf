// Putting sliced results back in the order the statement asked for.
//
// H1d executes four statements once per workspace and concatenates the rows. That keeps every row,
// which is what keeps every estate-wide number, and it loses the one thing a concatenation cannot
// preserve on its own: the order. `ORDER BY classic_uses DESC` inside each slice orders that
// workspace's jobs, and eleven of those laid end to end put the eleventh workspace's worst job below
// the first workspace's best.
//
// That is not cosmetic. `offenders()` takes the first five rows and names them as the examples in a
// finding, without sorting, because the statement already sorted. Under concatenation those five
// come from whichever workspace happened to execute first — the same rows, the same counts, and a
// different sentence in front of the customer.
//
// So this re-sorts by the statement's own `ORDER BY`, read out of the SQL by `orderKey`. The
// comparison mirrors Spark rather than JavaScript in the two places they disagree, both of which
// show up in these four statements:
//
//   Numbers. Every value arrives from the Statement Execution API as a string, so `9` sorts above
//   `10` under the default comparison. A column whose values all parse as numbers is compared
//   numerically. Mixed columns fall back to text, because a column holding both is one this cannot
//   reorder faithfully and guessing per row would order rows against each other inconsistently.
//
//   Nulls. Spark puts them first ascending and last descending. JavaScript has no opinion and
//   `undefined < 1` is false, which would silently pile the nulls at whichever end the sort
//   algorithm left them.
//
// Stable beyond that: `Array.prototype.sort` is stable per spec, so rows equal on every sort column
// stay in slice order, which is workspace order. Two jobs with the same name in different workspaces
// therefore come out in a deterministic order rather than one that depends on execution timing.

import type { SortColumn } from './slices.js';
import { isNumericType, type ColumnTypes, type Row } from './rows.js';

/**
 * The concatenated rows, in the order the statement's own `ORDER BY` puts them.
 *
 * Returns the input untouched when there is nothing to sort by. A statement with no `ORDER BY` has
 * no order to preserve, so slice order — which is workspace order, and stable — is as good an answer
 * as any, and inventing one would be a difference between the sliced and unsliced paths.
 */
export function resort(rows: readonly Row[], order: readonly SortColumn[] | undefined, types?: ColumnTypes): Row[] {
  const copy = [...rows];
  if (order == null || order.length === 0) return copy;

  const numeric = new Set(order.filter((by) => sortsAsNumber(rows, by.column, types)).map((by) => by.column));

  return copy.sort((left, right) => {
    for (const by of order) {
      const compared = compare(left[by.column], right[by.column], by.descending, numeric.has(by.column));
      if (compared !== 0) return compared;
    }
    return 0;
  });
}

/**
 * Whether a column sorts as a number: the manifest's answer where there is one, the values' otherwise.
 *
 * The manifest first because the values cannot settle it. `job_id` is a STRING in
 * `system.lakeflow.jobs` and holds nothing but digits, and it is the tiebreak in two of these four
 * statements — so inferring from the values would sort it numerically where Spark sorted it byte by
 * byte, and the rows a finding quotes as its examples would differ from the rows a customer sees
 * running the same SQL by hand. That is the exact divergence this module exists to prevent.
 *
 * The inference stays as the fallback rather than being deleted, because a manifest with no types is
 * a real case — a fixture, an older response shape — and text ordering on a count column is the worse
 * failure of the two: it puts `9` above `10` on the primary sort key rather than reordering a tie.
 */
function sortsAsNumber(rows: readonly Row[], column: string, types: ColumnTypes | undefined): boolean {
  return isNumericType(types?.[column]) ?? allNumeric(rows, column);
}

/**
 * Whether every present value in a column parses as a number.
 *
 * Decided per column over the whole result rather than per pair, so the comparison is transitive.
 * A column where `'10'` and `'9'` compare numerically but `'10'` and `'abc'` compare as text has no
 * consistent order at all, and `Array.prototype.sort` given an inconsistent comparator produces an
 * arbitrary permutation rather than an error.
 */
function allNumeric(rows: readonly Row[], column: string): boolean {
  let seen = 0;
  for (const row of rows) {
    const value = row[column];
    if (value == null || value === '') continue;
    if (typeof value === 'number' || typeof value === 'bigint') {
      seen += 1;
      continue;
    }
    if (typeof value !== 'string' || !Number.isFinite(Number(value))) return false;
    seen += 1;
  }
  // A column of nothing but nulls is not numeric, and it does not matter: every comparison over it
  // is decided by the null rule below before the numeric one is consulted.
  return seen > 0;
}

/** One column's comparison, with Spark's null placement and the direction the statement asked for. */
function compare(left: unknown, right: unknown, descending: boolean, numeric: boolean): number {
  const missing = (value: unknown): boolean => value == null || value === '';

  // Ascending puts nulls first and descending puts them last, which is Spark's default and therefore
  // what each slice already did internally. Applying the direction to the null rule as well would
  // sort nulls the opposite way from the slices they came out of.
  if (missing(left) && missing(right)) return 0;
  if (missing(left)) return descending ? 1 : -1;
  if (missing(right)) return descending ? -1 : 1;

  const order = numeric ? sign(Number(left) - Number(right)) : text(left, right);
  return descending ? -order : order;
}

function text(left: unknown, right: unknown): number {
  const [a, b] = [String(left), String(right)];
  return a < b ? -1 : a > b ? 1 : 0;
}

function sign(value: number): number {
  return value < 0 ? -1 : value > 0 ? 1 : 0;
}
