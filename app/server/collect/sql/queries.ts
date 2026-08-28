// Loading statement text from `config/statements`.
//
// The SQL lives in files rather than in string literals so it is reviewable as SQL: a
// reviewer can run a check against their own workspace and see exactly what it claims,
// which is not true of a string assembled across three functions.
//
// The directory is `config/statements` and not AppKit's `config/queries`, which is where
// these started. The analytics plugin validates every `.sql` file under `config/queries`
// at startup by running it with `LIMIT 0`, and these statements are templates: they carry
// `{{customer_catalog <column>}}` fragments that are expanded on load, so the file on disk
// is deliberately not valid SQL. The plugin's validation failed on them and took the
// server's listener down with it, on a directory convention this app does not otherwise
// use — nothing reads the types AppKit generates from these, because the collector binds
// its own parameters and parses its own rows (see statements.ts for why it does not use
// the plugin's asUser path either).
//
// The plugin stays registered. It declares the sql-warehouse resource requirement and
// performs the startup handshake, which is what gives a misconfigured install something
// specific to say; it just no longer scans files it will never execute.
//
// The directory is found by searching upwards for `config/statements` rather than by
// counting levels up from this module, because the source file and its build
// output sit at different depths below the app root. See shipped-config.ts.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { shippedConfigDirectory } from '../../shipped-config.js';

export interface QuerySource {
  /** Statement text for a file in `config/statements`, without the `.sql` suffix. */
  text(name: string): string;
}

/**
 * Catalogs Databricks provisions and owns, which are not part of the customer's estate.
 *
 * `system` and `samples` are auto-created, read-only and present in every workspace. The
 * customer cannot change a `samples` table's format or add a description to
 * `system.billing.usage`, so counting them as assets under assessment produces findings
 * about someone else's tables. Measured on the labs metastore: 130 of 141 catalogued
 * tables were Databricks-owned, which took the table-format control to 73% and `partial`
 * where the customer's own eleven tables were eleven of eleven and a pass. That is a
 * false failure of the same kind as marking a serverless estate down for having no cluster
 * policies.
 *
 * Identified by owner rather than by name, because `catalog_owner` is what actually
 * distinguishes them and a future Databricks-provided catalog would be caught without a
 * code change. The name list stays as a backstop in case that string is not stable, and
 * costs nothing: none of these names can be taken by a customer catalog.
 *
 * Both halves of that missed a whole family, and row `80` is where it was found. The
 * platform creates one internal catalog per workspace for materialised Lakeview datasets,
 * named `__databricks_internal_catalog_lakeview_<workspace id>`. It is not the literal
 * `__databricks_internal`, and it is not owned by `System user`, so it survived a predicate
 * whose two halves were each written believing the other was the backstop. Measured on
 * `large-estate` 2026-08-16: one such catalog held 28,248 of the 604,746 relations this
 * expression called the customer's, which is 4.7% of the estate under assessment and the
 * sixth-largest catalog in it. That is the false-failure this expression exists to prevent,
 * at estate scale, in the direction the comment above says it is safe from.
 *
 * So the name backstop is a prefix rather than a list. A customer could in principle take a
 * name beginning `__databricks_internal` — assume they will not; if they did, the cost is
 * under-counting their estate, which this file has already argued is the cheaper mistake.
 */
const DATABRICKS_OWNED = "'system', 'samples'";
const DATABRICKS_INTERNAL = "'__databricks_internal'";
const SYSTEM_OWNER = "'System user'";

/**
 * A boolean expression: is this catalog the customer's rather than Databricks'?
 *
 * Written as one expression usable in a `WHERE` or a `CASE`, so a query can either exclude
 * these tables or count them separately without the two definitions drifting apart. That
 * second half went four months unused and unchecked, and it is a stronger claim than the
 * first: the expression holds an `IN` subquery, and a subquery in a projection is a
 * narrower guarantee than one in a filter. Measured on labs 2026-08-11 it holds — a
 * `WHERE`, a bare projection and a `CASE` over `system.information_schema.tables` return
 * the same count, so Databricks decorrelates it either way. That is a reading of the one
 * engine this app runs on and not of the SQL standard. `uc_lineage_coverage` is the first
 * statement to depend on it, and needs to: an event's two sides are in scope
 * independently, and a `WHERE` could only test one of them. The
 * queries reference it as `{{customer_catalog <column>}}`; substitution happens on load,
 * once, in `FileQuerySource`.
 *
 * It is a fragment rather than a bound parameter because it is structure, not a value —
 * the Statement Execution API binds values, and a list of catalog names is neither
 * something the caller supplies nor something that varies per scan.
 */
export function customerCatalogPredicate(column: string): string {
  return (
    `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
    `WHERE catalog_owner = ${SYSTEM_OWNER}) AND lower(${column}) NOT IN (${DATABRICKS_OWNED})` +
    ` AND NOT startswith(lower(${column}), ${DATABRICKS_INTERNAL}))`
  );
}

const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;

/**
 * Expands the fragments a query file references.
 *
 * An unrecognised `{{...}}` is left alone deliberately — silently dropping it would send a
 * statement to the warehouse with a hole in its logic, which on a filter means assessing
 * more than was intended. A test asserts no query ships with an unexpanded fragment.
 */
export function expandFragments(statement: string): string {
  return statement.replace(FRAGMENT, (_whole, column: string) => customerCatalogPredicate(column));
}

export function queryDirectory(moduleUrl = import.meta.url): string {
  return shippedConfigDirectory('statements', moduleUrl);
}

export class FileQuerySource implements QuerySource {
  private readonly cache = new Map<string, string>();

  constructor(private readonly directory: string = queryDirectory()) {}

  text(name: string): string {
    const cached = this.cache.get(name);
    if (cached != null) return cached;

    const path = join(this.directory, `${name}.sql`);
    let contents: string;
    try {
      contents = readFileSync(path, 'utf8');
    } catch (cause) {
      // A missing query file is a packaging fault, not a workspace condition, and
      // must not be reported to the user as an unmeasurable control. Failing loudly
      // here is what makes the cold-start check able to catch it before release.
      throw new Error(`Query ${name} is missing from ${this.directory}; the app bundle is incomplete.`, { cause });
    }

    // Trailing semicolons are rejected by the Statement Execution API when
    // parameters are bound, and the files are written to be readable standalone,
    // so one may legitimately be there.
    const statement = expandFragments(contents.replace(/;\s*$/, '').trim());
    this.cache.set(name, statement);
    return statement;
  }
}

/** For tests and fixtures: query text supplied directly rather than read from disk. */
export class StaticQuerySource implements QuerySource {
  constructor(private readonly queries: Readonly<Record<string, string>>) {}

  text(name: string): string {
    const found = this.queries[name];
    if (found == null) throw new Error(`Query ${name} is missing from ${this.directory()}.`);
    return found;
  }

  private directory(): string {
    return `the static set (${Object.keys(this.queries).join(', ')})`;
  }
}
