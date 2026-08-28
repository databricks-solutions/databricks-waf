import { describe, expect, it } from 'vitest';

import { GRAINED, grainFaults, grainProblem } from './grain.js';

// The counter-example first, then the shapes that must stay quiet.
//
// `history.test.ts` ends with `does not fire on a statement with no ranking at all`, which is an accurate
// description of that rule and also the hole the live defect fell through. A statement that never ranks a
// slowly-changing table has nothing for `historyProblem` to inspect, so the worst possible read of an SCD2
// table — no window, no grouping, a bare `delete_time IS NULL` — was the one read nothing checked.
//
// The middle section is the one that earns the file. Asserting that the tree passes proves nothing about a
// rule, since a rule that cannot fire passes everything; and the first draft of this one fired on nine
// correct guidance steps, which is the failure mode that gets a check deleted rather than fixed. So both
// directions are pinned: the defect as it actually shipped, and each legitimate shape that tripped the
// draft.

/** The defect as it shipped, reduced to the part that matters. */
const shipped = `
  SELECT
    workspace_id,
    pipeline_id,
    name,
    COALESCE(settings.development, FALSE) AS development
  FROM system.lakeflow.pipelines
  WHERE delete_time IS NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
  ORDER BY name
`;

describe('the defect this rule exists for', () => {
  it('is caught', () => {
    expect(grainFaults(shipped)).toHaveLength(1);
  });

  it('names the table, the line and the entity, so the reader is looking at the fault', () => {
    const problem = grainProblem(shipped) ?? '';
    expect(problem).toContain('system.lakeflow.pipelines');
    expect(problem).toContain('pipeline_id');
    expect(problem).toMatch(/line \d+/);
  });

  it('is what history.ts cannot see, which is why both exist', async () => {
    // Pinned as a pair rather than described in a comment: if `historyProblem` ever grows to cover the
    // no-window case, this failing is how we find out the two rules now overlap.
    const { historyProblem } = await import('./history.js');
    expect(historyProblem(shipped)).toBeUndefined();
    expect(grainProblem(shipped)).toBeDefined();
  });

  it('catches a timeline averaged over periods rather than runs', () => {
    // A row is a period of a run, so this averages period durations and calls the result a run duration.
    const faults = grainFaults(`
      SELECT job_id, avg(period_end_time - period_start_time) AS duration
      FROM system.lakeflow.job_run_timeline
      WHERE period_start_time >= current_date() - INTERVAL 30 DAYS
      GROUP BY job_id
    `);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.grain).toBe('period');
  });

  it('catches a snapshot table read across every day it holds', () => {
    const faults = grainFaults(`
      SELECT sum(table_size_bytes) AS bytes
      FROM system.storage.table_metrics_history
    `);
    expect(faults).toHaveLength(1);
    expect(faults[0]?.grain).toBe('snapshot');
  });

  it('does not let a nested grouping vouch for the query that reads the table', () => {
    // The exact shape of the live statement: the table is read at the top level and a derived table
    // groups by the entity. An earlier draft accepted this, which is how the defect passed its own check.
    expect(
      grainFaults(`
        SELECT p.pipeline_id, p.name, u.updates
        FROM system.lakeflow.pipelines p
        LEFT JOIN (
          SELECT pipeline_id, count(DISTINCT update_id) AS updates
          FROM system.lakeflow.pipeline_update_timeline
          GROUP BY pipeline_id
        ) u ON u.pipeline_id = p.pipeline_id
      `)
    ).toHaveLength(1);
  });
});

describe('the shapes it must not flag', () => {
  it('accepts the fix that shipped: rank in one query, filter in the next', () => {
    expect(
      grainProblem(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (PARTITION BY workspace_id, pipeline_id ORDER BY change_time DESC) AS recency
          FROM system.lakeflow.pipelines
        ),
        latest AS (SELECT * FROM ranked WHERE recency = 1 AND delete_time IS NULL)
        SELECT pipeline_id, name FROM latest
      `)
    ).toBeUndefined();
  });

  it('accepts QUALIFY, which exists to filter a window and cannot mean anything else here', () => {
    expect(
      grainProblem(`
        SELECT workspace_id, job_id, name
        FROM system.lakeflow.jobs
        QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) = 1
      `)
    ).toBeUndefined();
  });

  it('accepts MAX_BY, which is a window written as an aggregate', () => {
    expect(
      grainProblem(`
        SELECT workspace_id, job_id, MAX_BY(name, change_time) AS name
        FROM system.lakeflow.jobs
        GROUP BY workspace_id, job_id
      `)
    ).toBeUndefined();
  });

  it('accepts count(distinct entity), which counts things whatever the rows are', () => {
    expect(
      grainProblem(`
        SELECT count(DISTINCT run_id) AS runs
        FROM system.lakeflow.job_run_timeline
        WHERE period_start_time >= current_date() - INTERVAL 7 DAYS
      `)
    ).toBeUndefined();
  });

  it('accepts GROUP BY ALL, which puts the grouping key in the select list', () => {
    // Four correct queries in the tree are written this way and the draft that could not read it failed
    // all four.
    expect(
      grainProblem(`
        SELECT run_id, min(period_start_time) AS started
        FROM system.lakeflow.job_run_timeline
        GROUP BY ALL
      `)
    ).toBeUndefined();
  });

  it('accepts a snapshot pinned to one day through a subquery', () => {
    expect(
      grainProblem(`
        SELECT sum(table_size_bytes) AS bytes
        FROM system.storage.table_metrics_history
        WHERE snapshot_date = (SELECT max(snapshot_date) FROM system.storage.table_metrics_history)
      `)
    ).toBeUndefined();
  });

  it('does not require a dedupe on event tables, where the many rows are the subject', () => {
    // Usage records, query history and audit rows are not a grain mistake — asking about them *is* the
    // question. Requiring a dedupe here would invent a failure on around forty correct statements.
    expect(
      grainProblem(`
        SELECT sku_name, sum(usage_quantity) AS dbus
        FROM system.billing.usage
        WHERE usage_date >= current_date() - INTERVAL 30 DAYS
        GROUP BY sku_name
      `)
    ).toBeUndefined();
  });

  it('does not match a table whose name merely starts with a grained one', () => {
    expect(grainProblem('SELECT count(*) FROM system.lakeflow.jobs_extra')).toBeUndefined();
  });
});

describe('the table list', () => {
  it('names an entity for every table, since the message is built from it', () => {
    for (const [table, grained] of Object.entries(GRAINED)) {
      expect(grained.entity.length, table).toBeGreaterThan(0);
      for (const column of grained.entity) expect(column, table).toMatch(/^[a-z_]+$/);
    }
  });

  it('covers the three SCD2 tables the earlier defect was measured on', () => {
    // These are the tables `history.ts` was written for. A grain rule that did not know them would leave
    // the no-window case open on precisely the tables already proven to carry the hazard.
    expect(Object.keys(GRAINED)).toContain('system.compute.clusters');
    expect(Object.keys(GRAINED)).toContain('system.lakeflow.jobs');
    expect(Object.keys(GRAINED)).toContain('system.lakeflow.pipelines');
  });
});
