-- Signal: sql:topology.job_to_job
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- A job that another job started. `source_task_run_id` names a *task* run;
-- the two timelines number their runs separately. Joined to
-- `job_run_timeline.run_id` this relation reads 0 over 35 rows on an estate
-- where all 35 match the task timeline — 32h's apparatus caught that once.
--
-- Not in config/statements: no control reads this. 101e is the caller.
WITH child AS (
  SELECT
    job_id,
    source_task_run_id,
    max(period_start_time) AS last_seen,
    count(DISTINCT run_id) AS runs
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND source_task_run_id IS NOT NULL
    AND job_id IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
  GROUP BY job_id, source_task_run_id
),
tasks AS (
  SELECT run_id, job_id
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
  GROUP BY run_id, job_id
)
SELECT
  parent.job_id AS source_id,
  child.job_id  AS target_id,
  max(child.last_seen) AS last_seen
FROM child
INNER JOIN tasks parent ON parent.run_id = child.source_task_run_id
WHERE parent.job_id IS NOT NULL
GROUP BY parent.job_id, child.job_id
ORDER BY last_seen DESC
LIMIT :topology_limit
