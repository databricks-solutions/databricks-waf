import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { historyProblem } from './history.js';
import { queryDirectory } from './queries.js';

// The regression test for the worst defect found so far, and for the class it belongs to.
//
// Two statements ranked a slowly-changing table to find each object's current row, and filtered
// `delete_time IS NULL` in the same query as the ranking. That filter removes the only row where
// `delete_time` is set — the one recording the deletion — so an older row won the ranking and the object
// was reported as current. On a large account it returned 6,136,941 clusters where 135,154 existed and
// 69,361 jobs where 13,365 existed, and no test noticed, because the shape of the result was right and
// only its contents were wrong.
//
// The tests below are in three parts, and the middle one is the part that matters. Asserting that
// today's statements pass proves nothing on its own: a rule that cannot fail passes everything. So the
// original defect is reconstructed here as a counter-example and the rule is required to catch it, and
// the two legitimate shapes it must *not* catch are pinned beside it — otherwise the cure is a check
// that fires on correct SQL and gets deleted the first time it blocks someone.

const statements = readdirSync(queryDirectory())
  .filter((name) => name.endsWith('.sql'))
  .map((name) => ({ name: name.replace(/\.sql$/, ''), sql: readFileSync(join(queryDirectory(), name), 'utf8') }))
  .sort((left, right) => left.name.localeCompare(right.name));

describe('every statement in the repository', () => {
  it('decides which history row is current before filtering on lifecycle columns', () => {
    const problems = statements
      .map(({ name, sql }) => {
        const problem = historyProblem(sql);
        return problem == null ? undefined : `${name}: ${problem}`;
      })
      .filter((problem) => problem != null);

    expect(problems).toEqual([]);
  });

  it('is not passing them all because nothing was scanned', () => {
    // Guards the assertion above against the file list being empty or the scanner silently reading
    // nothing: at least the two rewritten inventories must contain a ranking for the rule to have
    // anything to check.
    const ranked = statements.filter(({ sql }) => /PARTITION\s+BY/i.test(sql));
    expect(ranked.length).toBeGreaterThanOrEqual(2);
    expect(ranked.map(({ name }) => name)).toContain('compute_cluster_inventory');
    expect(ranked.map(({ name }) => name)).toContain('jobs_inventory');
  });
});

describe('the defect this rule exists for', () => {
  const broken = `
    WITH latest AS (
      SELECT *,
        ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
      FROM system.compute.clusters
      WHERE delete_time IS NULL
        AND (:workspace_id = '' OR workspace_id = :workspace_id)
    )
    SELECT workspace_id, cluster_id FROM latest WHERE recency = 1
  `;

  it('is caught', () => {
    expect(historyProblem(broken)).toBeDefined();
  });

  it('names the column and the line, so the reader is looking at the fault', () => {
    const problem = historyProblem(broken) ?? '';
    expect(problem).toContain('delete_time');
    expect(problem).toMatch(/line \d+/);
  });

  it('is caught the same way when the ranking is wrapped in a function call', () => {
    // The nested-window case that defeated an earlier version of the scope scanner: the region
    // enclosing the window is the argument list of `COALESCE`, which mentions nothing.
    expect(
      historyProblem(`
        WITH latest AS (
          SELECT *,
            COALESCE(ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC), 0) AS recency
          FROM system.lakeflow.jobs
          WHERE delete_time IS NULL
        )
        SELECT workspace_id, job_id FROM latest WHERE recency = 1
      `)
    ).toBeDefined();
  });

  it('catches the same mistake made with change_time to bound the window', () => {
    // The shape I nearly wrote when told to apply a recency bias. It drops every object that is
    // current but has not been edited lately: 16,181 of 135,154 clusters on the measured account.
    expect(
      historyProblem(`
        WITH latest AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
          FROM system.compute.clusters
          WHERE change_time >= current_date() - INTERVAL 30 DAYS
        )
        SELECT workspace_id, cluster_id FROM latest WHERE recency = 1
      `)
    ).toBeDefined();
  });
});

describe('the shapes it must not flag', () => {
  it('allows the filter when it is applied to the ranked result instead', () => {
    expect(
      historyProblem(`
        WITH latest AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
          FROM system.compute.clusters
        )
        SELECT workspace_id, cluster_id FROM latest WHERE recency = 1 AND delete_time IS NULL
      `)
    ).toBeUndefined();
  });

  it('allows filtering on a partition key, which removes whole partitions', () => {
    expect(
      historyProblem(`
        WITH latest AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
          FROM system.compute.clusters
          WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
            AND array_contains(split(:live_workspace_ids, ','), workspace_id)
        )
        SELECT workspace_id, cluster_id FROM latest WHERE recency = 1
      `)
    ).toBeUndefined();
  });

  it('allows a lifecycle column that is itself the partition key', () => {
    expect(
      historyProblem(`
        SELECT usage_date,
          ROW_NUMBER() OVER (PARTITION BY workspace_id, change_time ORDER BY usage_date DESC) AS recency
        FROM some.history
        WHERE change_time IS NOT NULL
      `)
    ).toBeUndefined();
  });

  it('does not read a nested query\u2019s WHERE as the ranking query\u2019s own', () => {
    expect(
      historyProblem(`
        WITH latest AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
          FROM system.compute.clusters
          WHERE workspace_id IN (SELECT workspace_id FROM other WHERE delete_time IS NULL)
        )
        SELECT workspace_id FROM latest WHERE recency = 1
      `)
    ).toBeUndefined();
  });

  it('does not fire on a statement with no ranking at all', () => {
    expect(historyProblem(`SELECT workspace_id FROM t WHERE delete_time IS NULL`)).toBeUndefined();
  });
});
