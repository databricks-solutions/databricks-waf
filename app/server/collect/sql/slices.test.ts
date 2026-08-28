import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { declaredBound } from './bounds.js';
import { columnsOf } from './columns.js';
import { queryDirectory } from './queries.js';
import { SAMPLES } from './scale-fixtures.js';
import { bytesAtScale, insufficientMargin, rowsAtTarget } from './scale.js';
import { declaredSlice, orderKey, sliceProblem } from './slices.js';

// The premise H1c and H1d both rest on, measured before either is built.
//
// The claim is that executing these statements once per workspace and concatenating the results returns
// exactly what executing them whole returns. Not approximately — exactly, including the twelve
// `count(DISTINCT …)` expressions in `serverless_job_readiness`, which is where a plausible-sounding
// scheme would go wrong.
//
// The claim is not empirical, which is worth saying because the last two phases were both wrong about
// numbers. It follows from how `GROUP BY` works: if the slice predicate partitions the grouping key, no
// output group is ever split across two slices, so every group is computed over exactly the rows it
// would have been. There is no data on which that fails. So what has to be tested is not the theorem but
// its precondition — that the precondition actually holds for these four statements, and that it is
// checked rather than believed, because the next person to add an aggregate to one of them will not
// remember this.
//
// The counter-example below is the other half. A rule with no failing case is a rule nobody can tell
// they have broken, and "slice by date instead" is the specific mistake available here: it looks
// equivalent, it is cheaper to implement, and it inflates every migration verdict silently.

const statements = readdirSync(queryDirectory())
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ name: name.replace(/\.sql$/, ''), sql: readFileSync(join(queryDirectory(), name), 'utf8') }))
  .sort((left, right) => left.name.localeCompare(right.name));

/**
 * The statements that have to be sliced, derived rather than listed.
 *
 * Not every estate-scaled statement needs an axis. `uc_catalog_inventory` is one row per catalog at 0%
 * of the cap, and catalogs are account-level so it has no workspace column to slice on at all — a rule
 * demanding one would be demanding a column the data does not have. What makes slicing necessary is
 * lacking room, which `scale.ts` already measures, so this reads that rather than repeating a judgement
 * about which four they are. A statement that grows into the gate acquires the requirement on its own.
 */
const mustSlice = statements.filter((entry) => {
  const bound = declaredBound(entry.sql);
  if (bound?.kind !== 'estate-scaled') return false;
  const rows = rowsAtTarget(bound.per) ?? 0;
  return insufficientMargin(bytesAtScale(SAMPLES[entry.name]?.() ?? [], rows), rows, bound.per) != null;
});

describe('the statements without room to grow', () => {
  it('are there to check, so a passing run is not an empty one', () => {
    // Four today. Asserted because the derivation above could silently select nothing — if `SAMPLES`
    // lost a fixture, every statement would measure zero bytes and this whole file would pass vacuously.
    expect(mustSlice.length).toBe(4);
  });

  it.each(mustSlice)('$name declares an axis it can be sliced on', ({ sql }) => {
    // A statement that cannot fit and has not said how it divides is one nobody has decided about. That
    // is the state all eight were in, and the state that let two phases get designed for the wrong remedy.
    expect(declaredSlice(sql)?.columns ?? []).not.toEqual([]);
  });

  it.each(mustSlice)('$name is actually safe on every axis it declares', ({ sql }) => {
    const problems = (declaredSlice(sql)?.columns ?? [])
      .map((column) => {
        const problem = sliceProblem(sql, column);
        return problem == null ? undefined : `slicing on ${column}: ${problem}`;
      })
      .filter((problem) => problem != null);

    expect(problems).toEqual([]);
  });

  it('slices every one of them on workspace_id, which is the axis H1c executes', () => {
    // Named here rather than left to the headers, because H1c's whole design is one execution per
    // workspace. A statement that dropped that axis would still pass the test above by declaring a
    // narrower one, and would quietly fall out of the scheme.
    const missing = mustSlice
      .filter((entry) => !(declaredSlice(entry.sql)?.columns ?? []).includes('workspace_id'))
      .map((entry) => entry.name);

    expect(missing).toEqual([]);
  });

  it.each(mustSlice)('$name can be re-sorted after concatenation without changing the SQL', ({ sql }) => {
    // The precondition H1d needs and this PR does not provide, measured here so H1d cannot assume it.
    //
    // Slicing keeps every row and loses the row order. That is not cosmetic: `offenders()` takes the
    // first five rows as the examples a finding names, without sorting, trusting the statement's
    // `ORDER BY` to have put the worst first. Concatenated slices would name five jobs from whichever
    // workspace ran first. So H1d re-sorts — which is only possible if every column the statement orders
    // by comes back in its result. All four do. If one ever did not, H1d would have to add the column
    // rather than discover the problem in a customer's report.
    const key = orderKey(sql);
    expect(key, 'no top-level ORDER BY, so nothing tells H1d what order to restore').toBeDefined();

    const returned = new Set(columnsOf(sql).filter((column) => column != null));
    expect((key ?? []).map(({ column }) => column).filter((column) => !returned.has(column))).toEqual([]);
  });

  it('orders on a mix of directions, so a re-sort cannot just reverse everything', () => {
    // Two order by a name ascending and two by a cost or a count descending. Recorded because a re-sort
    // that dropped direction would pass any test written against one of those halves alone.
    const directions = new Set(
      mustSlice.flatMap((entry) => (orderKey(entry.sql) ?? []).map(({ descending }) => descending))
    );

    expect([...directions].sort()).toEqual([false, true]);
  });

  it('declares a finer axis than workspace_id, which is what H1d subdivides on', () => {
    // Workspace alone assumes an estate is spread across workspaces. At the declared target the mean
    // slice is 200 jobs, but the distribution is skewed and one workspace holding 100,000 jobs
    // reproduces the whole problem — so each of these has to name something inside a workspace too.
    const single = mustSlice
      .filter((entry) => (declaredSlice(entry.sql)?.columns ?? []).length < 2)
      .map((entry) => entry.name);

    expect(single).toEqual([]);
  });
});

describe('the rule, on statements written to break it', () => {
  it('rejects a grouping key that does not include the slice column', () => {
    const sql = `
      WITH usage AS (
        SELECT workspace_id, sku_name, sum(dbus) AS dbus
        FROM system.billing.usage
        WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
        GROUP BY sku_name
      )
      SELECT workspace_id, sku_name, dbus FROM usage`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/GROUP BY at line 6 does not include workspace_id/);
  });

  it('rejects a window partition that does not include the slice column', () => {
    const sql = `
      SELECT
        workspace_id,
        job_id,
        ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY change_time DESC) AS recency
      FROM system.lakeflow.jobs`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/PARTITION BY at line 5 does not include workspace_id/);
  });

  it('rejects a window nested inside a function call, where the enclosing parentheses are not a scope', () => {
    // Caught in review, and the second miss of the same kind. The scope that decides a window is the
    // query it is evaluated in, and both earlier versions resolved to something smaller: first the
    // `OVER (…)` clause, then whatever region enclosed it — which here is the argument list of
    // `COALESCE`, mentioning no workspace_id, so the exemption for dimension tables accepted it.
    const sql = `
      SELECT
        workspace_id,
        job_id,
        COALESCE(ROW_NUMBER() OVER (PARTITION BY job_id ORDER BY change_time DESC), 0) AS recency
      FROM system.lakeflow.jobs`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/PARTITION BY at line 5 does not include workspace_id/);
  });

  it('rejects a window nested two functions deep, so the fix is about queries and not about COALESCE', () => {
    const sql = `
      SELECT
        workspace_id,
        job_id,
        GREATEST(COALESCE(ROW_NUMBER() OVER (PARTITION BY job_id), 0), 1) AS recency
      FROM system.lakeflow.jobs`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/PARTITION BY at line 5 does not include workspace_id/);
  });

  it('still exempts a window in a subquery that has no workspace column of its own', () => {
    // The other side of the same rule. A derived table is a query scope, so a window inside one is judged
    // against that query and not against the statement — and a price table has no workspace to partition
    // by. Losing this would force a workspace column onto tables that have no business carrying one.
    const sql = `
      SELECT u.workspace_id, u.job_id, p.rate
      FROM usage u
      JOIN (
        SELECT sku_name, rate, ROW_NUMBER() OVER (PARTITION BY sku_name ORDER BY rate DESC) AS recency
        FROM system.billing.list_prices
      ) p ON p.sku_name = u.sku_name AND p.recency = 1
      WHERE (:workspace_id = '' OR u.workspace_id = :workspace_id)`;

    expect(sliceProblem(sql, 'workspace_id')).toBeUndefined();
  });

  it('rejects a positional grouping key, because nobody can read whether it is safe', () => {
    const sql = `
      SELECT workspace_id, job_id, count(DISTINCT run_id) AS runs
      FROM system.lakeflow.job_run_timeline
      GROUP BY 1, 2`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/names its columns by position/);
  });

  it('rejects a statement that does not return the column it would be sliced on', () => {
    const sql = `SELECT job_id, count(*) AS runs FROM system.lakeflow.jobs GROUP BY job_id`;

    expect(sliceProblem(sql, 'workspace_id')).toMatch(/does not return workspace_id/);
  });

  it('allows a dimension lookup with no reference to the slice column at all', () => {
    // The `serverless_job_spend` case, reduced. A price table has no workspace dimension, so its rows
    // are identical in every slice and joining to it per slice is wasteful rather than wrong. A rule
    // that failed this would force a workspace column onto a table that has no business carrying one.
    const sql = `
      WITH prices AS (
        SELECT sku_name, currency_code, max(pricing.effective_list.default) AS rate
        FROM system.billing.list_prices
        WHERE price_end_time IS NULL
        GROUP BY sku_name, currency_code
      )
      SELECT u.workspace_id, u.job_id, sum(u.dbus * p.rate) AS cost
      FROM usage u JOIN prices p ON p.sku_name = u.sku_name
      WHERE (:workspace_id = '' OR u.workspace_id = :workspace_id)
      GROUP BY u.workspace_id, u.job_id`;

    expect(sliceProblem(sql, 'workspace_id')).toBeUndefined();
  });

  it('reads a qualified column as the same column, so an alias is not a false alarm', () => {
    const sql = `
      SELECT t.workspace_id, t.job_id, count(DISTINCT t.run_id) AS runs
      FROM timing t
      GROUP BY t.workspace_id, t.job_id`;

    expect(sliceProblem(sql, 'workspace_id')).toBeUndefined();
  });

  it('rejects date as an axis on the statement whose distinct counts it would inflate', () => {
    // The counter-example the whole design turns on, and the axis that was asked for.
    //
    // Slicing this by date splits one job's rows across windows. `runs` would still be right, because
    // summing counts across disjoint row sets is the same count. `clusters` would not: a cluster used in
    // January and February is one distinct cluster to the whole statement and two to the sum of its
    // slices. The verdicts read high and nothing fails, which is why this is a test and not a comment.
    const sql = `
      SELECT
        workspace_id,
        job_id,
        count(DISTINCT run_id) AS runs,
        count(DISTINCT compute_cluster_id) AS clusters
      FROM system.lakeflow.job_task_run_timeline
      WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
      GROUP BY workspace_id, job_id`;

    expect(sliceProblem(sql, 'workspace_id')).toBeUndefined();
    expect(sliceProblem(sql, 'period_start_time')).toMatch(/does not include period_start_time/);
  });
});
