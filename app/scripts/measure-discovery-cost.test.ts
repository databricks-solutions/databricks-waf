// What the cost probes are probes *of*.
//
// The reading this script takes is only as good as the statements it sends, and one of them is built by
// cutting the shipped statement apart. A cut that removed the wrong thing would come back fast, look like
// a finding, and say a part is expensive that is not — the apparatus error `AGENTS.md` names and `46a`'s
// fixture committed. So the parser and the cut are held against the shipped statement here rather than
// eyeballed once on the day.

import { describe, expect, it } from 'vitest';

import {
  customerCatalog,
  dearestFirst,
  parts,
  shipped,
  splitTopLevel,
  verdict,
  without,
} from './measure-discovery-cost.mjs';

const TEXT = shipped('uc_discovery_metadata');
const COLUMNS = shipped('uc_discovery_columns');

describe('reading the statement apart', () => {
  it('finds the three CTEs the statement declares, in order', () => {
    // Four until `61b`. The `columns` CTE this script found to be the hour is now
    // `uc_discovery_columns.sql`, and the recording that found it names the sha it was taken from.
    expect(parts(TEXT).ctes.map((one) => one.name)).toEqual(['customer_tables', 'reads', 'tagged']);
  });

  it('finds the CTEs of the statement the expensive part moved to', () => {
    expect(parts(COLUMNS).ctes.map((one) => one.name)).toEqual(['reads', 'customer_tables', 'columns']);
  });

  it('gives each CTE the body between its own brackets and no more', () => {
    const { ctes } = parts(TEXT);
    const reads = ctes.find((one) => one.name === 'reads');
    expect(reads?.body).toContain('system.access.table_lineage');
    // The neighbours' tables, which a bracket-counting bug would swallow.
    expect(reads?.body).not.toContain('table_tags');
    expect(reads?.body).not.toContain('information_schema.tables');
  });

  it('keeps the final SELECT out of the CTE list', () => {
    const { tail } = parts(TEXT);
    expect(tail.startsWith('SELECT')).toBe(true);
    expect(tail).toContain('FROM customer_tables t');
  });

  it('refuses a statement whose shape it does not understand, rather than parsing part of one', () => {
    expect(() => parts('SELECT 1')).toThrow(/WITH/);
    expect(() => parts('WITH a AS (SELECT 1')).toThrow(/closing bracket/);
  });
});

describe('cutting one part out', () => {
  it('removes the CTE, its join and only the columns that read it', () => {
    const { statement, alias, droppedColumns } = without(TEXT, 'tagged');
    expect(alias).toBe('g');
    expect(statement).not.toContain('information_schema.table_tags');
    expect(statement).not.toMatch(/LEFT JOIN\s+tagged/);
    // The one output column that reads `g`, and not the six that do not.
    expect(droppedColumns).toBe(1);
    expect(statement).toContain('read_tables_described');
    expect(statement).not.toContain('read_tables_tagged');
  });

  it('leaves the other joins alone when it cuts one', () => {
    const { statement } = without(TEXT, 'tagged');
    expect(statement).toContain('LEFT JOIN reads r');
  });

  it('produces a variant that still parses as the same shape', () => {
    // The cut is only a measurement if what comes out is a statement. Re-parsing it is the cheapest check
    // that the rebuild did not leave a dangling comma or an empty WITH.
    for (const name of ['reads', 'tagged']) {
      const { statement } = without(TEXT, name);
      const again = parts(statement);
      expect(again.ctes.map((one) => one.name), name).not.toContain(name);
      expect(again.tail.startsWith('SELECT'), name).toBe(true);
    }
  });

  it('refuses a cut it cannot define rather than returning the statement unchanged', () => {
    // `customer_tables` is the FROM rather than a join, so there is no variant without it — and the
    // failure has to be an error, because a "variant" identical to the original would be recorded as a
    // reading showing the part costs nothing.
    expect(() => without(TEXT, 'customer_tables')).toThrow(/not joined/);
    expect(() => without(TEXT, 'no_such_cte')).toThrow(/not a CTE/);
  });
});

describe('cutting an inner join out', () => {
  // `uc_discovery_columns` restricts with plain JOINs, so a cut of one counts a wider population than
  // the statement ships. The cut is still the reading `61b` wants — whether the reference or the
  // restriction costs — but a recording that did not say so would be a number about a statement
  // nobody runs, presented as a number about one that is.
  it('takes the cut and says the variant counts a wider population', () => {
    const cut = without(COLUMNS, 'reads');

    expect(cut.alias).toBe('r');
    expect(cut.widensPopulation).toBe(true);
    expect(cut.statement).not.toContain('system.access.table_lineage');
    // Nothing in the select list reads `r`, so the cut is the restriction and nothing else.
    expect(cut.droppedColumns).toBe(0);
  });

  it('still refuses the cut that would leave nothing to time', () => {
    // Both output columns read `columns`, so there is no variant of this statement without it — which
    // is the shape of a statement that exists to read one thing.
    expect(() => without(COLUMNS, 'columns')).toThrow(/nothing left to time/);
  });

  it('says a left join does not widen it, which is what the distinction is for', () => {
    expect(without(TEXT, 'tagged').widensPopulation).toBe(false);
  });
});

describe('splitting a select list', () => {
  it('splits on the commas between expressions and not on the ones inside brackets', () => {
    expect(splitTopLevel('a, concat_ws(".", x, y), b').map((one) => one.trim())).toEqual([
      'a',
      'concat_ws(".", x, y)',
      'b',
    ]);
  });

  it('does not split on a comma inside a line comment', () => {
    // The defect that refused a probe on large-estate after eleven minutes of running. The comment
    // below is the shipped statement's, comma and all.
    const list = 'a,\n  -- drawn from, which is the difference between a quiet estate and an unread one.\n  sum(r.x) AS b';
    const found = splitTopLevel(list);

    expect(found).toHaveLength(2);
    // The comment stays with the column it introduces, so cutting that column takes it too.
    expect(found[1]).toContain('drawn from');
    expect(found[1]).toContain('sum(r.x)');
  });

  it('leaves a comment at the end of the list alone rather than looping on it', () => {
    expect(splitTopLevel('a, b -- trailing, unterminated').map((one) => one.trim())).toEqual([
      'a',
      'b -- trailing, unterminated',
    ]);
  });
});

describe('cutting the CTE whose columns a comment introduces', () => {
  it('takes the comment with them, leaving no comma before FROM', () => {
    // `without reads` generated a comma, then a comment, then FROM, and Spark refused it. Asserted on
    // the shipped statement rather than a fixture, because the sentence that broke it is in there.
    const { statement } = without(TEXT, 'reads') as { statement: string };
    const list = /^SELECT\s([\s\S]*?)\nFROM\s/im.exec(statement);

    expect(list).not.toBeNull();
    expect(list?.[1].trimEnd().endsWith(',')).toBe(false);
    expect(list?.[1]).not.toMatch(/--[^\n]*$/);
  });
});

describe('the customer-catalog fragment', () => {
  it('expands both occurrences, one per CTE that reads the catalogue', () => {
    // Two: `customer_tables` and `tagged` each carry one and `reads` inherits the exclusion through its
    // join. Three until `61b` took `columns` out. Held as a count rather than as "the braces are gone"
    // because the first pass wrote the number down from reading the SQL and got it wrong.
    const expanded = customerCatalog(TEXT);
    expect(expanded).not.toContain('{{customer_catalog');
    expect(expanded.match(/catalog_owner = 'System user'/g)?.length).toBe(2);
  });

  it('expands both of the column statement’s, since the two share a denominator', () => {
    const expanded = customerCatalog(COLUMNS);
    expect(expanded).not.toContain('{{customer_catalog');
    expect(expanded.match(/catalog_owner = 'System user'/g)?.length).toBe(2);
  });
});

describe('which cut runs first', () => {
  // This decides what a run that exhausts its budget comes back having measured, so it is held here
  // rather than trusted: the first attempt on `large-estate` was stopped because source order put the
  // only cut that could move the total behind two that could not.
  const ctes = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];

  it('puts the part that cost the most alone at the front', () => {
    const alone = [
      { name: 'a', ok: true, ms: 22_000 },
      { name: 'b', ok: true, ms: 6_000 },
      { name: 'c', ok: true, ms: 8_000 },
      { name: 'd', ok: true, ms: 900_000 },
    ];
    expect(dearestFirst(ctes, alone).map((one) => one.name)).toEqual(['d', 'a', 'c', 'b']);
  });

  it('ranks a part that outlasted its own cap above every part that returned a number', () => {
    const alone = [
      { name: 'a', ok: true, ms: 22_000 },
      { name: 'b', ok: false, error: 'gave up: {"state":"RUNNING"}' },
      { name: 'c', ok: true, ms: 8_000 },
      { name: 'd', ok: true, ms: 900_000 },
    ];
    expect(dearestFirst(ctes, alone)[0]?.name).toBe('b');
  });

  it('sinks a part that was refused, since a refusal is an absence rather than a cost', () => {
    const alone = [
      { name: 'a', ok: true, ms: 1 },
      { name: 'b', ok: false, error: 'PERMISSION_DENIED on USE CATALOG' },
      { name: 'c', ok: true, ms: 2 },
      { name: 'd', ok: true, ms: 3 },
    ];
    expect(dearestFirst(ctes, alone).map((one) => one.name)).toEqual(['d', 'c', 'a', 'b']);
  });

  it('returns every part exactly once, whatever the costs say', () => {
    const alone = ctes.map((one) => ({ name: one.name, ok: true, ms: 5 }));
    expect(dearestFirst(ctes, alone).map((one) => one.name).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('what a probe amounts to', () => {
  it('keeps a poll-budget timeout apart from a refusal, because they ask for different reworks', () => {
    expect(verdict({ ok: false, error: 'gave up: {"state":"RUNNING"}' })).toBe('unfinished');
    expect(verdict({ ok: false, error: 'PERMISSION_DENIED on USE CATALOG' })).toBe('refused');
    expect(verdict({ ok: true })).toBe('ran');
    expect(verdict({ skipped: 'the run budget was spent' })).toBe('not probed');
    expect(verdict(null)).toBe('not probed');
  });
});
