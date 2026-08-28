// Which tables a statement reads, from the statement.
//
// Derived rather than declared, and that is the whole point. A list of tables written
// beside each signal would be documentation of the query, and documentation of a query
// drifts from the query — silently, because nothing executes it. The requirements page
// exists so an admin can decide whether to let this app run and what to grant it, so a
// stale list there is worse than no list: it is a wrong answer to "what will this touch".
//
// Read from the expanded text, after `expandFragments`, so the tables a shared fragment
// brings in are included. The customer-catalog predicate reads
// `system.information_schema.catalogs` in every query that filters on it, and a reader
// deciding which grants to give needs to see that.
//
// The parse is deliberately shallow: it finds three-part names after FROM and JOIN and
// nothing else. It is not a SQL parser and would be wrong to be one — the failure mode
// that matters is missing a table, so the test asserts the derived set against every
// shipped query, and a name this misses shows up there rather than in front of a user.

/**
 * `catalog.schema.table` after FROM or JOIN, ignoring case and any amount of whitespace
 * or newline between the keyword and the name.
 *
 * Three parts required. A bare or two-part name in these queries would be a reference to
 * something in the caller's own catalog, which no system-table statement here does, and
 * matching them would pick up CTE names — `FROM totals` is not a table anyone grants on.
 */
const REFERENCE = /\b(?:from|join)\s+([a-z_][\w]*\.[a-z_][\w]*\.[a-z_][\w]*)/gi;

/**
 * The tables one statement reads, lowercased and sorted.
 *
 * Sorted because the output is displayed and compared: an order that followed the
 * statement's own clause order would reshuffle the requirements page whenever a query was
 * rewritten, and would make the drift test's failure message depend on where in the SQL
 * the change happened.
 */
export function tablesRead(statement: string): readonly string[] {
  const found = new Set<string>();
  for (const match of statement.matchAll(REFERENCE)) {
    const name = match[1];
    if (name != null) found.add(name.toLowerCase());
  }
  return [...found].sort();
}

/**
 * The schema a grant would be made on: `system.billing` for `system.billing.usage`.
 *
 * Schema rather than table because that is the unit `GRANT SELECT` is realistically used
 * at on system tables, and because a page listing eleven tables across five schemas as
 * eleven separate requirements is a page nobody reads to the end of.
 */
export function schemaOf(table: string): string {
  const parts = table.split('.');
  return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : table;
}

/** The distinct schemas a set of tables sits in, sorted. */
export function schemasOf(tables: readonly string[]): readonly string[] {
  return [...new Set(tables.map(schemaOf))].sort();
}
