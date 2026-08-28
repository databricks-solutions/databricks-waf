// What re-sorting a concatenation has to get right.
//
// Every case here is a way the sliced path could return the same rows as the unsliced one in a
// different order, and every one of them changes what the user reads: `offenders()` takes the first
// five rows of a signal's value and names them in the finding without sorting again, because the
// statement sorted. So an order that depends on which workspace executed first is a finding whose
// examples depend on which workspace executed first.

import { describe, expect, it } from 'vitest';
import { resort } from './concat.js';
import { orderKey } from './slices.js';

/** Rows in the shape the Statement Execution API delivers: every value a string. */
function rows(...values: readonly (readonly [string, string | null])[]) {
  return values.map(([name, score]) => ({ name, score }));
}

function names(sorted: readonly Record<string, unknown>[]): string[] {
  return sorted.map((row) => String(row.name));
}

describe('a concatenation of slices', () => {
  it('is re-sorted by the statement’s own ORDER BY, not left in workspace order', () => {
    // Two slices: workspace one answered with n, workspace two with a. Concatenated, `a` is second.
    const concatenated = rows(['n', '1'], ['z', '1'], ['a', '1'], ['m', '1']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY name')))).toEqual(['a', 'm', 'n', 'z']);
  });

  it('compares a numeric column as numbers, because every value arrives as a string', () => {
    // The failure this prevents: `'9' > '10'` is true, so the busiest job in the estate lands
    // ninth. `serverless_job_readiness` orders by `classic_uses DESC` and the finding names the
    // first five, so a lexicographic sort names five jobs that are not the worst five.
    const concatenated = rows(['few', '9'], ['many', '10'], ['most', '100']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score DESC, name')))).toEqual([
      'most',
      'many',
      'few',
    ]);
  });

  it('falls back to text when a column holds values that are not all numbers', () => {
    // Deciding per row instead would make the comparator intransitive, and `Array.sort` given an
    // intransitive comparator returns an arbitrary permutation rather than complaining.
    const concatenated = rows(['b', '10'], ['a', 'n/a'], ['c', '9']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score')))).toEqual(['b', 'c', 'a']);
  });

  it('puts nulls where Spark puts them: first ascending, last descending', () => {
    // Each slice already ordered its own nulls this way, so any other rule here reorders rows
    // relative to the very statement whose order is being restored.
    const concatenated = rows(['has', '1'], ['none', null], ['also', '2']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score')))).toEqual(['none', 'has', 'also']);
    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score DESC')))).toEqual(['also', 'has', 'none']);
  });

  it('treats an empty string as absent, because that is how a null arrives', () => {
    const concatenated = rows(['has', '1'], ['none', '']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score')))).toEqual(['none', 'has']);
  });

  it('breaks a tie by slice order, so two identical keys do not depend on timing', () => {
    // `Array.prototype.sort` is stable per spec and slice order is workspace order, so this is
    // deterministic without a tiebreak column. Two jobs sharing a name in different workspaces is
    // the real case: `jobs_inventory` orders by name alone.
    const concatenated = [
      { name: 'shared', workspace_id: '1' },
      { name: 'other', workspace_id: '1' },
      { name: 'shared', workspace_id: '2' },
    ];

    const sorted = resort(concatenated, orderKey('SELECT 1\nORDER BY name'));

    expect(names(sorted)).toEqual(['other', 'shared', 'shared']);
    expect(sorted.map((row) => row.workspace_id)).toEqual(['1', '1', '2']);
  });

  it('sorts a digit-only string column as text, because that is what the warehouse did', () => {
    // `job_id` is a STRING of digits. Inferring from the values makes the sliced path sort it
    // numerically while each individual slice sorted it lexicographically — so the concatenation would
    // be ordered by a rule none of its parts used. The manifest says which it is; the values cannot.
    const concatenated = [{ job_id: '9' }, { job_id: '10' }, { job_id: '100' }];
    const order = orderKey('SELECT 1\nORDER BY job_id');

    expect(resort(concatenated, order, { job_id: 'STRING' }).map((row) => row.job_id)).toEqual(['10', '100', '9']);
    // And the same column declared numeric sorts numerically, which is the case `classic_uses` is.
    expect(resort(concatenated, order, { job_id: 'LONG' }).map((row) => row.job_id)).toEqual(['9', '10', '100']);
  });

  it('infers from the values when the manifest did not name the column', () => {
    // A statement whose response carried no schema, or a column the manifest omitted: guessing beats
    // sorting a spend column lexicographically, and this is the pre-existing behaviour.
    const concatenated = rows(['few', '9'], ['many', '10']);

    expect(names(resort(concatenated, orderKey('SELECT 1\nORDER BY score'), { name: 'STRING' }))).toEqual([
      'few',
      'many',
    ]);
  });

  it('leaves rows alone when the statement declares no order', () => {
    // Not an invented order: a statement with no ORDER BY has none to preserve, and inventing one
    // here would be a difference between the sliced and unsliced paths rather than a fix.
    const concatenated = rows(['n', '1'], ['a', '2']);

    expect(names(resort(concatenated, orderKey('SELECT 1')))).toEqual(['n', 'a']);
  });

  it('copies rather than sorting the caller’s array', () => {
    const concatenated = rows(['n', '1'], ['a', '2']);
    resort(concatenated, orderKey('SELECT 1\nORDER BY name'));

    expect(names(concatenated)).toEqual(['n', 'a']);
  });
});
