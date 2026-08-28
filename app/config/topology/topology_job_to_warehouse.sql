-- Signal: sql:topology.job_to_warehouse
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct job → warehouse pairs from the same task-run `compute` struct as
-- job → cluster. A job can name both in one period; they are different
-- relations and this statement only takes the warehouse end.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  t.job_id AS source_id,
  c.warehouse_id AS target_id,
  max(t.period_start_time) AS last_seen,
  count(DISTINCT t.run_id) AS runs
FROM system.lakeflow.job_task_run_timeline t
LATERAL VIEW OUTER explode(t.compute) e AS c
WHERE t.period_start_time >= current_date() - make_dt_interval(:lookback_days)
  AND t.job_id IS NOT NULL
  AND c.warehouse_id IS NOT NULL
  AND (:workspace_id = '' OR t.workspace_id = :workspace_id)
GROUP BY t.job_id, c.warehouse_id
ORDER BY last_seen DESC
LIMIT :topology_limit
