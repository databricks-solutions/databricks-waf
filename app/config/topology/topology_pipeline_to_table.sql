-- Signal: sql:topology.pipeline_to_table
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct pipeline → table pairs from lineage. This is the relation that
-- places a pipeline on the canvas; pipeline → cluster is declined (one
-- cluster per update) and is not this statement. The table is the customer's:
-- the same population the assessment uses.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  entity_id AS source_id,
  coalesce(target_table_full_name, source_table_full_name) AS target_id,
  max(event_time) AS last_seen
FROM system.access.table_lineage
WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
  AND entity_type = 'PIPELINE'
  AND entity_id IS NOT NULL
  AND coalesce(target_table_full_name, source_table_full_name) IS NOT NULL
  AND (
    (target_table_full_name IS NOT NULL AND {{customer_catalog target_table_catalog}})
    OR (target_table_full_name IS NULL AND {{customer_catalog source_table_catalog}})
  )
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
GROUP BY entity_id, coalesce(target_table_full_name, source_table_full_name)
ORDER BY last_seen DESC
LIMIT :topology_limit
