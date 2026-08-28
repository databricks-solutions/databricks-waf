// This run's table statistics, by the table they belong to.
//
// The advisor's only catalogue-side input, and the second thing `findingsFor` is handed after a plan. It is
// separate from `PlanIndex` because it is keyed differently and scoped differently: a plan belongs to one
// shape in one workspace, where this belongs to a table and the same table is scanned by many shapes.
//
// # Why an index and not a list
//
// `findingsFor` runs per shape and a shape's plan names several tables — `33iga` measured 57 scan identifiers
// across 36 plans, 12 distinct tables. A scan of the statistics list per identifier per shape is quadratic on
// an estate with tens of thousands of shapes, which is the same argument `plan-index.ts` makes.
//
// # Case
//
// Keyed on the lower-cased name. A plan's `SCAN_IDENTIFIER` and the statement's `concat_ws` of three
// `information_schema`-side columns are two different assemblies of the same identity, and Unity Catalog
// names are case-insensitive while these two strings are not guaranteed to agree on case. Folding once here
// is cheaper than folding at every lookup and is the only place the two spellings meet.

import type { TableStatisticsRow } from '../collect/sql/shapes.js';

/**
 * The statistics a shape's rules may read, looked up by fully-qualified table name.
 *
 * A miss means **unknown**, not fresh. Nothing analysed the table in the window, and `33iga` measured that
 * this cannot be told from a table predictive optimization has not reached — so a rule reading a miss as a
 * finding would be reporting the collector's blind spot as the estate's problem.
 */
export interface StatsIndex {
  /** The statistics for one table, or nothing where this run has none for it. */
  for: (table: string) => TableStatisticsRow | undefined;
  /** How many tables have them. Reported so a test can tell an empty index from an unwired one. */
  readonly size: number;
}

const EMPTY: StatsIndex = { for: () => undefined, size: 0 };

/**
 * Indexes this run's table statistics.
 *
 * A table with two rows keeps the first, which the statement's `GROUP BY` makes unreachable — it aggregates
 * to one row per table — so this is a tie-break nothing exercises rather than a choice. Overwriting instead
 * would make which reading a rule saw depend on array order.
 */
export function statsIndex(rows: readonly TableStatisticsRow[] | undefined): StatsIndex {
  if (rows == null || rows.length === 0) return EMPTY;
  const byTable = new Map<string, TableStatisticsRow>();
  for (const row of rows) {
    const key = row.table.toLowerCase();
    if (!byTable.has(key)) byTable.set(key, row);
  }
  return {
    for: (table) => byTable.get(table.toLowerCase()),
    size: byTable.size,
  };
}

/** The empty index, for a run whose statistics statement was unreadable and for every caller with none. */
export function noStats(): StatsIndex {
  return EMPTY;
}
