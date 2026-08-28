// That the SQL a scan needs is actually present, and findable from the build output.
//
// These are packaging tests rather than behaviour tests. The first live scan against a
// real workspace reported all seventy-eight controls unmeasurable, because the query
// directory was located by counting levels up from the module and the build output
// sits at a different depth than the source. Every control then explained, correctly
// but uselessly, that it could not be measured. The customer-visible symptom of a
// build fault should not be a workspace that appears unassessable.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SQL_QUERY_NAMES, SQL_QUERY_PARAMS } from './collector.js';
import { FileQuerySource, customerCatalogPredicate, queryDirectory } from './queries.js';
import { catalogueDirectory } from '../../catalogue/catalogue.js';

describe('the query files the SQL collector names', () => {
  it('are all present and load as statements', () => {
    const source = new FileQuerySource();
    for (const name of SQL_QUERY_NAMES) {
      const text = source.text(name);
      expect(text, `${name}.sql is empty`).not.toBe('');
      // The Statement Execution API rejects a trailing semicolon when parameters are
      // bound, and the files are written to be runnable standalone, so one is likely.
      expect(text.endsWith(';'), `${name}.sql still ends in a semicolon`).toBe(false);
    }
  });

  it('has no query file that no signal uses', () => {
    const shipped = readdirSync(queryDirectory())
      .filter((name) => name.endsWith('.sql'))
      .map((name) => name.replace(/\.sql$/, ''))
      .sort();
    // Not a style point: an orphaned statement is one a reviewer will read as something
    // the app runs, so it invites a reader to believe a check exists that does not.
    expect(shipped).toEqual([...SQL_QUERY_NAMES].sort());
  });

  it('ship no unexpanded fragment', () => {
    const source = new FileQuerySource();
    for (const name of SQL_QUERY_NAMES) {
      // A fragment that survives to the warehouse is a syntax error at best. At worst the
      // fragment is a filter, and the statement that reaches the warehouse then assesses
      // more of the estate than the query says it does — the failure would look like data.
      expect(source.text(name), `${name}.sql has an unexpanded fragment`).not.toMatch(/\{\{/);
    }
  });

  it('exclude Databricks-owned catalogs wherever they read the table catalogue', () => {
    const source = new FileQuerySource();
    const reading = SQL_QUERY_NAMES.filter((name) => source.text(name).includes('information_schema.tables'));

    // `system` and `samples` are read-only and in every workspace, so a finding about them
    // is about tables the customer cannot change. Measured on labs: 130 of 141 catalogued
    // tables were Databricks-owned. Each query has to opt in, and it is easy to forget —
    // storage_sample_selection excluded `system` by hand and missed `samples` for weeks.
    expect(reading.length).toBeGreaterThan(0);
    for (const name of reading) {
      expect(source.text(name), `${name}.sql counts Databricks-owned catalogs`).toContain('catalog_owner');
    }
  });

  it('bind exactly the parameters their text uses', () => {
    const source = new FileQuerySource();
    for (const [query, declared] of Object.entries(SQL_QUERY_PARAMS)) {
      // Comments are stripped first, because the files document their parameters in a
      // `-- @param` line and matching that would make every query pass itself.
      const statement = source
        .text(query)
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n');
      const used = [...new Set(statement.match(/:([a-z_]+)/g) ?? [])].map((match) => match.slice(1)).sort();

      // Unbound placeholders are rejected by the statement API, so a missing one fails the
      // signal at scan time and reads to the user as an unassessable workspace.
      expect(used, `${query}.sql uses parameters the collector does not bind`).toEqual([...declared].sort());
    }
  });
});

describe('every copy of the customer-catalog predicate', () => {
  // Nine copies of this one sentence exist, because the measurement scripts run under plain Node and
  // cannot import a `.ts`. Three were asserted against the original and six were not, so when row `80`
  // found the sentence wrong — it let `__databricks_internal_catalog_lakeview_<id>` through, 28,248
  // relations of `large-estate` counted as the customer's — a fix could have landed in the three that
  // were checked and left six saying the old thing. Two of the six decide which catalogs a scan reads.
  //
  // Held as source text rather than by importing each script: `measure-sql-baseline.mjs` calls `main()`
  // at module scope, so importing it to compare a string would start a measurement run.

  const scripts = join(import.meta.dirname, '..', '..', '..', 'scripts');

  /** The predicate with its column wildcarded, so a copy matches whatever it names the column. */
  const canonical = (): RegExp => {
    const marks = customerCatalogPredicate('\u0000').split('\u0000');
    const literal = marks.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\u0000');
    // The column is spelled `${column}`, `table_catalog` or `t.table_catalog` depending on the copy.
    // Whichever it is, all three occurrences have to be the same one, which is what the backreference is.
    return new RegExp(literal.replace('\u0000', '([\\w.${}]+)').replaceAll('\u0000', '\\1'));
  };

  /** A copy as the warehouse would see it: constants resolved, concatenation joined, one space between. */
  const asSubmitted = (source: string): string =>
    source
      .replaceAll('${SYSTEM_OWNER}', "'System user'")
      .replaceAll('${DATABRICKS_OWNED}', "'system', 'samples'")
      .replaceAll('${DATABRICKS_INTERNAL}', "'__databricks_internal'")
      .replace(/["`]\s*\+\s*["`]/g, '')
      .replace(/\s+/g, ' ');

  const copies = readdirSync(scripts)
    .filter((name) => /\.m[jt]s$/.test(name) && !name.includes('.test.'))
    .filter((name) => readFileSync(join(scripts, name), 'utf8').includes('catalog_owner'));

  it('is in the scripts this test knows to look at', () => {
    // Guards the census itself. `79` was the same shape — a check that passed because it was looking at
    // nothing — and the way this one fails silently is a rename that empties the list.
    expect(copies.length).toBeGreaterThanOrEqual(8);
  });

  it.each(copies)('says the same thing in %s', (name) => {
    const source = asSubmitted(readFileSync(join(scripts, name), 'utf8'));
    // A script naming `catalog_owner` is deciding which catalogs are the customer's, and there is one
    // answer to that. If a script needs a different population it needs a different comment, not a
    // quietly different predicate — that is how this one stayed wrong across nine files.
    expect(source, `${name} spells the customer-catalog predicate differently from queries.ts`).toMatch(
      canonical()
    );
  });
});

describe('locating the data directories from an arbitrary depth', () => {
  // Standing in for the build output, which sits at a different depth below the app
  // root than this source file does. The upward search has to be indifferent to that.
  const deep = pathToFileURL(join(import.meta.dirname, 'a', 'b', 'c', 'module.js')).href;

  it('finds the queries', () => {
    expect(queryDirectory(deep)).toBe(queryDirectory());
  });

  it('finds the catalogue', () => {
    expect(catalogueDirectory(deep)).toBe(catalogueDirectory());
  });

  it('says which directory is missing rather than guessing', () => {
    const outside = pathToFileURL(join('/', 'module.js')).href;
    expect(() => queryDirectory(outside)).toThrow(/config\/statements/);
  });
});

describe('the built bundle', () => {
  // Skipped when dist is absent so a plain `npm test` on a fresh clone still passes;
  // CI bundles before testing, and the cold-start check covers the deployed tree.
  const dist = join(import.meta.dirname, '..', '..', '..', 'dist');

  it.skipIf(!existsSync(dist))('resolves both directories from its own location', () => {
    const bundled = pathToFileURL(join(dist, 'collect', 'sql', 'queries.js')).href;
    expect(queryDirectory(bundled)).toBe(queryDirectory());
    expect(catalogueDirectory(bundled)).toBe(catalogueDirectory());
  });
});
