-- Signal: sql:topology.warehouse_to_table
-- Rows: at most :topology_limit
-- Benchmark: inventory
--
-- Distinct warehouse → table pairs. Lineage names the table and the statement;
-- query history names the warehouse that ran it. The join is on statement_id,
-- which is the field 32h measured — not a shared name. Inner rather than left:
-- a lineage row whose statement is not in history is not an edge. The table is
-- the customer's: the same population the assessment uses.
--
-- Not in config/statements: no control reads this. 101e is the caller.
SELECT
  r.warehouse_id AS source_id,
  t.table_name   AS target_id,
  max(t.event_time) AS last_seen
FROM (
  SELECT
    statement_id,
    coalesce(target_table_full_name, source_table_full_name) AS table_name,
    event_time
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND statement_id IS NOT NULL
    AND coalesce(target_table_full_name, source_table_full_name) IS NOT NULL
    AND (
      (target_table_full_name IS NOT NULL AND {{customer_catalog target_table_catalog}})
      OR (target_table_full_name IS NULL AND {{customer_catalog source_table_catalog}})
    )
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
) t
INNER JOIN (
  SELECT statement_id, compute.warehouse_id AS warehouse_id
  FROM system.query.history
  WHERE start_time >= current_date() - make_dt_interval(:lookback_days)
    AND compute.warehouse_id IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
) r ON r.statement_id = t.statement_id
GROUP BY r.warehouse_id, t.table_name
ORDER BY last_seen DESC
LIMIT :topology_limit
