-- Signal: sql:topology.job_to_cluster
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct job → cluster pairs from the task-run timeline. `compute` is a
-- struct: the array of ids does not say what kind each is, and a serverless
-- compute id is not a cluster. One cluster per period is collapsed to the
-- pair by grouping; `count(distinct run_id)` is the grain the period table
-- owes. This is the relation 101b kept; the bill-derived pair is declined.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  t.job_id AS source_id,
  c.cluster_id AS target_id,
  max(t.period_start_time) AS last_seen,
  count(DISTINCT t.run_id) AS runs
FROM system.lakeflow.job_task_run_timeline t
LATERAL VIEW OUTER explode(t.compute) e AS c
WHERE t.period_start_time >= current_date() - make_dt_interval(:lookback_days)
  AND t.job_id IS NOT NULL
  AND c.cluster_id IS NOT NULL
  AND (:workspace_id = '' OR t.workspace_id = :workspace_id)
GROUP BY t.job_id, c.cluster_id
ORDER BY last_seen DESC
LIMIT :topology_limit
