import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { boundProblem, declaredBound, parseBound } from './bounds.js';
import { queryDirectory } from './queries.js';

describe('declaredBound', () => {
  it('reads a single-row declaration', () => {
    expect(declaredBound('-- Signal: sql:uc.census\n-- Rows: 1\n--\nSELECT count(*) FROM t')).toEqual({
      kind: 'fixed',
      rows: 1,
    });
  });

  it('reads a fixed ceiling', () => {
    expect(declaredBound('-- Rows: at most 40\nSELECT 1')).toEqual({ kind: 'fixed', rows: 40 });
  });

  it('reads a ceiling the collector binds', () => {
    expect(declaredBound('-- Rows: at most :segment_limit\nSELECT 1')).toEqual({
      kind: 'parameterised',
      parameter: 'segment_limit',
    });
  });

  it('reads a declaration that the row count grows with the estate', () => {
    expect(declaredBound('-- Rows: one per job\nSELECT 1')).toEqual({ kind: 'estate-scaled', per: 'job' });
  });

  it('has no bound for a statement that declares none', () => {
    expect(declaredBound('-- Signal: sql:uc.census\nSELECT count(*) FROM t')).toBeUndefined();
  });

  it('has no bound for a declaration it cannot parse, rather than guessing at one', () => {
    // The alternative is treating an unreadable declaration as satisfied, which would let
    // `-- Rows: bounded, trust me` pass both halves of the mechanism.
    expect(declaredBound('-- Rows: bounded, trust me\nSELECT 1')).toBeUndefined();
  });

  it('reads the declaration wherever in the header it sits', () => {
    expect(parseBound('at most 12')).toEqual({ kind: 'fixed', rows: 12 });
  });
});

describe('boundProblem', () => {
  it('says nothing when a fixed bound holds', () => {
    expect(boundProblem({ kind: 'fixed', rows: 40 }, 40)).toBeUndefined();
  });

  it('reports a fixed bound that did not hold, with both numbers', () => {
    const problem = boundProblem({ kind: 'fixed', rows: 1 }, 4200);
    expect(problem).toContain('4,200 rows');
    expect(problem).toContain('declared ceiling of 1');
    // The reader needs to know why one row over matters, because on its own it does not look
    // like the kind of thing that stops a scan.
    expect(problem).toContain('25 MiB');
  });

  it('holds a parameterised bound to the value the collector bound', () => {
    expect(boundProblem({ kind: 'parameterised', parameter: 'table_limit' }, 500, { table_limit: 500 })).toBeUndefined();
    expect(boundProblem({ kind: 'parameterised', parameter: 'table_limit' }, 501, { table_limit: 500 })).toContain(
      ':table_limit (500)'
    );
  });

  describe('a declared cap that nothing bound', () => {
    // This returned undefined, and a comment justified it by saying the `bind exactly the parameters
    // their text uses` test would catch the mismatch. That test strips comment lines before matching,
    // so a parameter appearing only in a `-- Rows:` header was invisible to it, and the declaration
    // was then enforced by nothing at all. Silence here is what made it three layers deep.
    const problem = boundProblem({ kind: 'parameterised', parameter: 'made_up_limit' }, 10_000);

    it('says the rows were checked against nothing', () => {
      expect(problem).toContain('10,000 rows');
      expect(problem).toContain('checked against nothing');
    });

    it('names the parameter, since the header is where the fix goes', () => {
      expect(problem).toContain(':made_up_limit');
    });

    it('does not report it as an overrun, which would send the reader to the wrong fix', () => {
      expect(problem).not.toContain('declared ceiling of');
    });
  });

  it('reports an unbound cap even when the count is small, because the count is not the point', () => {
    // The failure is that no ceiling exists, and a statement returning three rows today is the one
    // that returns three million on a larger estate with nothing to notice.
    expect(boundProblem({ kind: 'parameterised', parameter: 'made_up_limit' }, 3)).toBeDefined();
  });

  it('treats a cap bound as something other than a number as unbound', () => {
    // `numbersIn` drops anything non-numeric rather than coercing, so a cap wired to a string arrives
    // here missing. That is a real defect and not a reason to fall silent.
    expect(boundProblem({ kind: 'parameterised', parameter: 'table_limit' }, 10, {})).toBeDefined();
  });

  it('enforces nothing for an estate-scaled declaration, which is why those need a manifest', () => {
    expect(boundProblem({ kind: 'estate-scaled', per: 'job' }, 100_000)).toBeUndefined();
  });

  it('enforces nothing when there is no declaration', () => {
    expect(boundProblem(undefined, 100_000)).toBeUndefined();
  });
});

describe('the shipped statements', () => {
  const directory = queryDirectory();
  const files = readdirSync(directory).filter((name) => name.endsWith('.sql'));

  it('has statements to check', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  // The same property `scripts/check-statement-bounds.mjs` enforces, asserted here too so a
  // statement added without a declaration fails the test run and not only the check that a
  // reviewer might not have run. They read the same files through the same grammar.
  it.each(files)('%s declares a row bound this module can parse', (file) => {
    expect(declaredBound(readFileSync(join(directory, file), 'utf8'))).toBeDefined();
  });
});
