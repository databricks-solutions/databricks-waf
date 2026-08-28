// The shared identifier rule every generated Databricks SQL path must go through.
//
// Adversarial cases first: a backtick, a semicolon, a comment opener and a line break are the
// shapes that turn one statement into two when interpolated into backticks. The inventory below
// is what stops a new interpolation from appearing outside this rule — every generator named
// there must call `quoteIdent` (or refuse) rather than building `` `...` `` by hand.

import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GENERATED_SQL_FAMILIES, isApplicationId, quoteIdent } from './sql-identifiers.mjs';
import { grantFor } from '../server/define/preflight.js';
import { needsOf } from './schedule-principal.mjs';
import { bucketed } from '../server/collect/sql/buckets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');

describe('quoteIdent', () => {
  it('wraps a plain value in backticks', () => {
    expect(quoteIdent('alice@example.com')).toBe('`alice@example.com`');
  });

  it('doubles a backtick inside the value so it cannot close the identifier early', () => {
    expect(quoteIdent('a`; GRANT ALL ON CATALOG main TO `x')).toBe('`a``; GRANT ALL ON CATALOG main TO ``x`');
  });

  it('refuses a line break rather than escaping one', () => {
    expect(quoteIdent('alice\nGRANT ALL')).toBeUndefined();
    expect(quoteIdent('alice\rGRANT ALL')).toBeUndefined();
  });

  it('refuses empty and whitespace-only values', () => {
    expect(quoteIdent('')).toBeUndefined();
    expect(quoteIdent('   ')).toBeUndefined();
    expect(quoteIdent(null)).toBeUndefined();
    expect(quoteIdent(undefined)).toBeUndefined();
  });

  it('survives a semicolon and a comment opener without ending the statement', () => {
    // Quoting does not strip them — it keeps them inside the identifier token. The point is that
    // they do not become SQL after the closing backtick.
    const quoted = quoteIdent('x; -- drop');
    expect(quoted).toBe('`x; -- drop`');
    expect(quoted?.endsWith('`')).toBe(true);
  });
});

describe('isApplicationId', () => {
  it('accepts a UUID in either case', () => {
    expect(isApplicationId('5af463d1-8cb9-4417-b2a5-725cea64cce5')).toBe(true);
    expect(isApplicationId('5AF463D1-8CB9-4417-B2A5-725CEA64CCE5')).toBe(true);
  });

  it('rejects a display name, a numeric id, and anything with a backtick or newline', () => {
    expect(isApplicationId('Well-Architected schedule')).toBe(false);
    expect(isApplicationId('12345')).toBe(false);
    expect(isApplicationId('5af463d1-8cb9-4417-b2a5-725cea64cce5\n')).toBe(false);
    expect(isApplicationId('')).toBe(false);
  });
});

describe('every generated Databricks SQL shape goes through quoteIdent', () => {
  /**
   * The generators that interpolate an identifier into Databricks SQL, from the one list
   * `sql-identifiers.mjs` holds — the release gate reads the same one. A new generator that builds
   * `` `...` `` by hand fails the walk below until it is listed there and proven to call `quoteIdent`.
   */
  const GENERATORS: readonly string[] = GENERATED_SQL_FAMILIES.map((family) => family.path);

  it('lists every source that interpolates a backtick-quoted identifier', () => {
    // Walk the tree for the pattern that builds an identifier by hand. A new site that uses
    // replaceAll('`', '``') without going through quoteIdent is the regression this is for.
    const offenders: string[] = [];
    for (const dir of ['scripts', 'server']) {
      walk(join(APP, dir), (path, text) => {
        if (!text.includes("replaceAll('`', '``')") && !text.includes('replaceAll("`", "``")')) return;
        if (path.endsWith('sql-identifiers.mjs')) return;
        if (path.endsWith('.test.ts') || path.endsWith('.test.mts')) return;
        const relative = path.slice(APP.length + 1);
        if (!GENERATORS.includes(relative)) offenders.push(relative);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('each listed generator imports quoteIdent', () => {
    for (const relative of GENERATORS) {
      if (relative === 'scripts/sql-identifiers.mjs') continue;
      const text = readFileSync(join(APP, relative), 'utf8');
      expect(text, relative).toMatch(/quoteIdent/);
    }
  });

  it('preflight doubles backticks and refuses newlines', () => {
    expect(grantFor('system.access', 'a`; GRANT ALL TO `x')).toBe(
      'GRANT SELECT ON SCHEMA system.access TO `a``; GRANT ALL TO ``x`'
    );
    expect(grantFor('system.access', 'alice\nGRANT ALL')).toBeUndefined();
  });

  it('schedule-principal doubles backticks on GRANT statements', () => {
    const needs = needsOf({
      principal: '5af463d1-8cb9-4417-b2a5-725cea64cce5',
      group: 'admins',
      app: 'app',
      warehouse: 'wh',
      schemas: ['billing'],
    });
    for (const need of needs.filter((one) => one.kind === 'grant')) {
      expect(need.statement).toMatch(/TO `5af463d1-8cb9-4417-b2a5-725cea64cce5`$/);
    }

    expect(() =>
      needsOf({
        principal: 'evil\nGRANT ALL',
        group: 'admins',
        app: 'app',
        warehouse: 'wh',
        schemas: ['billing'],
      })
    ).toThrow(/line break/);
  });

  it('bucketed quotes the column through the same rule', () => {
    const sql = bucketed('SELECT job_id FROM t', 'job_id', { of: 4, index: 0 });
    expect(sql).toContain('sliced.`job_id`');
    expect(() => bucketed('SELECT 1', 'job\nid', { of: 4, index: 0 })).toThrow(/quotable/);
  });
});

function walk(root: string, visit: (path: string, text: string) => void): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      walk(path, visit);
      continue;
    }
    if (!/\.(ts|mts|mjs|js)$/.test(entry.name)) continue;
    visit(path, readFileSync(path, 'utf8'));
  }
}
