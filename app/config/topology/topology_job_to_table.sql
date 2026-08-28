-- Signal: sql:topology.job_to_table
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct job → table pairs from lineage where the entity is a job. The table
-- is whichever side the event named; a job that only reads still places an
-- edge. That table's catalog is the customer's: the same population the
-- assessment uses. Cap is 101b's collector ceiling; this is the largest drawn
-- relation on large-estate at 8,510.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  entity_id AS source_id,
  coalesce(target_table_full_name, source_table_full_name) AS target_id,
  max(event_time) AS last_seen
FROM system.access.table_lineage
WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
  AND entity_type = 'JOB'
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
