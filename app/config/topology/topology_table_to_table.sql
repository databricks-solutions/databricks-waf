-- Signal: sql:topology.table_to_table
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct source → target table pairs from lineage. Both ends must be named:
-- a row with one table is not an edge. Both catalogs are the customer's: the
-- same population the assessment uses, so `samples` and the rest of
-- Databricks' catalogs are not drawn. Cap is 101b's collector ceiling, bound
-- to 10,000; the largest this relation measured on large-estate is 5,194.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  source_table_full_name AS source_id,
  target_table_full_name AS target_id,
  max(event_time)        AS last_seen
FROM system.access.table_lineage
WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
  AND source_table_full_name IS NOT NULL
  AND target_table_full_name IS NOT NULL
  AND {{customer_catalog source_table_catalog}}
  AND {{customer_catalog target_table_catalog}}
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
GROUP BY source_table_full_name, target_table_full_name
ORDER BY last_seen DESC
LIMIT :topology_limit
