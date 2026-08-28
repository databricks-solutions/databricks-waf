// What the two advisor statements are populations *of*, held at the statement.
//
// Neither of these can be checked from a row. A warehouse's uptime is right or wrong by comparison with
// an event stream the test does not have, and a coverage percentage is arithmetic over figures the same
// statement produced — so a fixture proves the parser and nothing about the population. What can be held
// is the shape of the SQL that decides the population, and each assertion below is on a line that was
// once the other way round and produced a number a reader would have believed.
//
// Three faults, each with its test:
//
//   Uptime was summed over in-window events only, so a warehouse running since last week reported
//   uptime from its first event inside the window — or none at all, if it had none. The seed reads the
//   last event before the boundary. Its lower bound matters too: without one this becomes a full scan of
//   the event table to find one row per warehouse.
//
//   Coverage was computed before the homogeneity guard dropped the shapes whose recorded text spanned
//   several statement types, so the percentage claimed work that reached no returned row.
//
//   The representative was filtered to measurable executions, so a shape whose every run failed came
//   back with no query text — and those shapes are what the failure list is made of.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { withoutComments } from './scan.js';

const statements = join(dirname(fileURLToPath(import.meta.url)), '../../../config/statements');
const PRESSURE = readFileSync(join(statements, 'workload_warehouse_pressure.sql'), 'utf8');
const SHAPES = readFileSync(join(statements, 'workload_query_shapes.sql'), 'utf8');
const READINESS = readFileSync(join(statements, 'serverless_job_readiness.sql'), 'utf8');
const PIPELINES = readFileSync(join(statements, 'lakeflow_pipeline_inventory.sql'), 'utf8');

/** The body of a named CTE, so an assertion is about one CTE rather than about the file. */
function cte(sql: string, name: string): string {
  const from = sql.indexOf(`\n${name} AS (`);
  expect(from, `${name} is not a CTE in this statement`).toBeGreaterThan(-1);
  let depth = 0;
  for (let at = from + name.length + 5; at < sql.length; at += 1) {
    if (sql[at] === '(') depth += 1;
    if (sql[at] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(from, at + 1);
    }
  }
  throw new Error(`${name} is not closed`);
}

describe('the window a warehouse’s uptime is measured over', () => {
  /*
   * The fault this replaced: a warehouse that started eight days ago and has not stopped has no event
   * inside a seven-day window, so it reported `up_ms` of zero — on a page whose next column divides
   * execution time by it. Utilisation came out unknown for the warehouses most likely to be oversized.
   */
  it('seeds the boundary from the last event before the window', () => {
    const carried = cte(PRESSURE, 'carried');

    expect(carried).toContain('system.compute.warehouse_events');
    expect(carried).toMatch(/event_time < date_sub\(current_date\(\), least\(:lookback_days, 7\) - 1\)/);
    // Ranked over every candidate, then the running ones kept — rather than the reverse, which would
    // seed a warehouse from an old running event that a later event had stopped.
    expect(carried).toContain('ROW_NUMBER() OVER (');
    expect(carried.indexOf('ROW_NUMBER() OVER (')).toBeLessThan(carried.indexOf('cluster_count > 0'));
  });

  /*
   * The seed had a thirty-day floor, on the reasoning that nothing is up for longer than an auto-stop
   * setting. A warehouse with auto-stop disabled is up for as long as nobody stops it and records nothing
   * meanwhile, so the floor excluded the warehouses whose seed matters most — and measured on labs it
   * discarded the last known state of 52 of 58 warehouses to save no measurable time.
   */
  it('reads back past any floor to find the last event before the window', () => {
    const carried = cte(PRESSURE, 'carried');

    expect(carried).not.toMatch(/event_time >=/);
    expect(carried.match(/event_time/g)).toHaveLength(2);
  });

  /*
   * The STOPPING and the STOPPED of one shutdown can share a second, and `recency = 1` has to pick one
   * of them. Broken towards the lower cluster count, so the tie is resolved by not seeding.
   */
  it('breaks a tie on the event time towards not seeding', () => {
    expect(cte(PRESSURE, 'carried')).toContain('ORDER BY event_time DESC, cluster_count ASC');
  });

  // The seed is only worth reading if uptime is summed over the timeline that contains it.
  it('sums uptime over the seeded timeline and not over the window’s own events', () => {
    const uptime = cte(PRESSURE, 'uptime');

    expect(uptime).toContain('FROM intervals');
    expect(uptime).not.toContain('FROM events');
  });

  /*
   * `days_seen` stayed a count of days an event was recorded, because the churn rule divides `starts`
   * by it. Counting seeded days into it would change what that rule is a rate of, silently.
   */
  it('keeps the day and start counts over recorded events only', () => {
    const seen = cte(PRESSURE, 'seen');

    expect(seen).toContain('FROM events');
    expect(seen).toContain("count(CASE WHEN event_type = 'STARTING' THEN 1 END)");
    expect(seen).toContain('count(DISTINCT date(event_time))');
  });

  // Whether the window opened with the warehouse up, which is the tell `days_seen` used to be.
  it('returns whether the uptime includes a session that began before the window', () => {
    expect(PRESSURE).toContain('AS carried_in');
  });
});

describe('what the query-shape coverage figure is a share of', () => {
  /*
   * `covered_ms` is computed over `windows`, which is before `HAVING kinds = 1` removes the shapes whose
   * recorded text spans several statement types — 1.0% of query time on the estate the guard was
   * measured against. Returned rather than corrected in place: covered is what this could advise on,
   * ambiguous is the part of it that reached no row, and the two are different claims.
   */
  it('returns the covered time that no returned shape describes', () => {
    const ambiguity = cte(SHAPES, 'ambiguity');

    expect(ambiguity).toContain('FROM per_shape');
    expect(ambiguity).toContain('kinds > 1');
    expect(ambiguity).toContain('AS ambiguous_ms');
    expect(ambiguity).toContain('AS ambiguous_runs');
    expect(ambiguity).toContain('AS ambiguous_shapes');
  });

  /*
   * Counted over the same population the final `WHERE` counts, or the exclusion would be a share of a
   * different denominator from the one it is subtracted from.
   */
  it('counts the exclusion over the same rows the result is filtered to', () => {
    expect(cte(SHAPES, 'ambiguity')).toContain('runs_now > 0');
    expect(SHAPES).toContain('WHERE runs_now > 0');
  });
});

describe('which execution stands for a shape', () => {
  /*
   * The fault: `WHERE is_measurable = 1` meant a shape with no finished, uncached run in the window
   * matched nothing, and the `LEFT JOIN` gave it a null text. Those shapes are exactly what the failure
   * list is made of, so the page that exists to show what is failing showed a heading over an empty
   * block. Measurable is now the first sort key rather than a filter.
   */
  it('prefers a measurable execution without requiring one', () => {
    const representative = cte(SHAPES, 'representative');

    expect(representative).toContain('ORDER BY is_measurable DESC, total_duration_ms DESC, start_time DESC');
    expect(representative).toContain('WHERE is_now = 1\n');
    expect(representative).not.toContain('is_measurable = 1');
  });

  /*
   * Two fields rather than one, because "not measurable" covers a failed run and a cache hit and a
   * sentence naming either needs to be able to tell them apart. See `representativeCaveat`.
   */
  it('returns both whether the chosen run measured anything and what it did', () => {
    expect(SHAPES).toContain('AS representative_measured');
    expect(SHAPES).toContain('AS representative_status');
  });
});

describe('which configuration the serverless verdict is read from', () => {
  /*
   * The join is to each cluster's current row, and the runs only say which clusters to read. That is the
   * right reading for "could the next run move", and it is one `ORDER BY` away from an as-of join that
   * would answer "did that run meet a blocker" — a question this does not answer and nothing downstream
   * may imply it does. Held here because the output of the two is identical in shape.
   */
  it('reads the latest cluster row rather than the one in force at the run', () => {
    expect(cte(READINESS, 'clusters')).toContain('PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC');

    /*
     * An as-of join is `change_time` compared against a run's time — in the ranking, or as a predicate
     * anywhere below it. So the assertion is over the whole statement rather than over the CTE: the
     * earlier version of this test asserted that `system.compute.clusters` had no `period_start_time`
     * in it, which is a column that table does not have and an assertion that could not fail.
     */
    const uses = [...withoutComments(READINESS).matchAll(/change_time/g)];
    expect(uses).toHaveLength(1);
    expect(withoutComments(READINESS)).toContain('ORDER BY change_time DESC');
  });

  /*
   * The consequence, stated where the statement is read rather than only in a design note. A header that
   * did not say which reading this was left every sentence downstream free to imply the other.
   */
  it('says which of the two readings it is', () => {
    expect(READINESS).toContain('current one, not the one the run used');
  });
});

describe('which workspaces a pipeline’s update counts come from', () => {
  /*
   * The counts were grouped on `pipeline_id` alone with neither scope predicate, so answering a question
   * about one workspace read every workspace's update timeline in the account. The ids are UUIDs, so the
   * join found the right rows and the fault was invisible in the output — cost, and a grain no slice
   * could be taken of, rather than a wrong number.
   *
   * Held here because `sliceProblem` cannot hold it: that check runs over the statements declaring a
   * `-- Slice:` header, and this statement declares none. Revert the grouping and nothing else fails.
   */
  it('scopes and groups the update counts by workspace', () => {
    const updates = /LEFT JOIN \(\s*SELECT[\s\S]*?\) u\b/.exec(PIPELINES)?.[0] ?? '';

    expect(updates).toContain('GROUP BY workspace_id, pipeline_id');
    expect(updates).toContain(':workspace_id');
    expect(updates).toContain(':live_workspace_ids');
    expect(PIPELINES).toContain('ON u.workspace_id = p.workspace_id');
  });
});
