-- Signal: sql:mlflow.run_tracking
-- Rows: 1
-- Benchmark: coverage
--
-- How the estate's MLflow runs were started, over the window, as one row.
--
-- `OE-02-09` asks whether experiment tracking is automated. `runs_latest` carries a `tags` map, and the
-- platform writes `mlflow.source.type` into it: `JOB` for a run started by a Databricks job, `NOTEBOOK`
-- for one started from a notebook, `LOCAL` for one from a machine somewhere else, `PROJECT` and `RECIPE`
-- for the two MLflow entry points that name themselves. That is the field the question was asking a
-- person to describe.
--
-- ## What "automated" is being read as, and what it is not
--
-- A run tagged `JOB` was started by something scheduled or triggered rather than by somebody sitting at a
-- notebook, and that is the whole of the claim. It is **not** a claim that the run was tracked well, that
-- its parameters were logged, or that the model it produced was registered — those are other questions
-- with other fields. The resolver's sentence stops where this one does.
--
-- The reverse reading is weaker still and the resolver does not make it. Notebook runs are how almost
-- every model is developed, and an estate with many of them and some jobs is the ordinary healthy shape
-- rather than a failure. What is read is whether *any* automated tracking exists and what share of the
-- window's runs it accounts for, banded.
--
-- ## An untagged run is counted apart, not counted as manual
--
-- Measured on `large-estate` on 2026-08-16 over thirty days: 2,861 runs tagged `JOB` across 166
-- experiments, 1,348 `NOTEBOOK` across 178, 933 `LOCAL` across 38, and **491 with no
-- `mlflow.source.type` at all** across 149. That last group is an eighth of the window, and reading it as
-- manual would move the share by eight points on the estate this was built against. A client that does
-- not set the tag — an older MLflow, or a direct REST call — is unreadable rather than interactive, and
-- `runs_without_a_source` is what carries that to the surface.
--
-- ## One row, and why the experiments are counted rather than returned
--
-- The estate had 10,924 experiments, 10,807 of them live. Returning one row each would be an inventory of
-- something nobody is going to page through to answer this question, and the requirement is a share. What
-- comes back is the counts, plus how many distinct experiments each source type reached, so a reader can
-- tell 2,861 automated runs spread across 166 experiments from 2,861 in one.
--
-- Deleted runs and deleted experiments are excluded: `delete_time` is set on both, and a deleted run is
-- not evidence of anything the estate does now.
--
-- @param lookback_days       the window, capped at 30 in the WHERE clause
-- @param workspace_id        one workspace, or '' for every one the identity can see
-- @param live_workspace_ids  the live workspaces, comma-joined, or '' for no filter
--
-- Feeds: OE-02-09.
WITH runs AS (
  SELECT
    run_id,
    experiment_id,
    -- `try_element_at` rather than `[]`, so a workspace whose `tags` column is absent reads as untagged
    -- instead of failing the statement — the same guard the write patterns signal uses on `query_tags`.
    upper(coalesce(trim(try_element_at(tags, 'mlflow.source.type')), '')) AS source_type,
    status
  FROM system.mlflow.runs_latest
  WHERE start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 30))
    AND delete_time IS NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
/*
 * The tallies as their own aggregate, rather than grouped alongside the experiment counts.
 *
 * An aggregate with no `GROUP BY` returns one row over an empty input; the same expression grouped by
 * the experiment counts returns none. That difference decides what an estate with experiments and no
 * runs in the window looks like from here — a row of zeros that says so, or a signal that came back
 * empty and is indistinguishable from a read that failed.
 */
tallies AS (
  SELECT
    count(*)                                                          AS runs,
    count(DISTINCT experiment_id)                                     AS experiments_with_runs,
    count_if(source_type = 'JOB')                                     AS runs_from_a_job,
    count(DISTINCT CASE WHEN source_type = 'JOB' THEN experiment_id END) AS experiments_with_a_job_run,
    count_if(source_type = 'NOTEBOOK')                                AS runs_from_a_notebook,
    count_if(source_type = 'LOCAL')                                   AS runs_from_elsewhere,
    -- The two MLflow entry points that are automated without being a Databricks job. Counted separately
    -- rather than folded into `runs_from_a_job`, because the sentence above the number says "a Databricks
    -- job" and a fold would make that false on an estate that runs MLflow Projects.
    count_if(source_type IN ('PROJECT', 'RECIPE'))                    AS runs_from_a_project,
    -- Neither manual nor automated: no tag was recorded. See the header.
    count_if(source_type = '')                                        AS runs_without_a_source,
    count_if(status = 'FINISHED')                                     AS runs_that_finished
  FROM runs
),
experiments AS (
  SELECT
    count(*)                        AS experiments,
    count_if(delete_time IS NULL)   AS live_experiments
  FROM system.mlflow.experiments_latest
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
)
SELECT
  t.runs,
  t.experiments_with_runs,
  t.runs_from_a_job,
  t.experiments_with_a_job_run,
  t.runs_from_a_notebook,
  t.runs_from_elsewhere,
  t.runs_from_a_project,
  t.runs_without_a_source,
  t.runs_that_finished,
  e.experiments,
  e.live_experiments
FROM tallies t
CROSS JOIN experiments e
