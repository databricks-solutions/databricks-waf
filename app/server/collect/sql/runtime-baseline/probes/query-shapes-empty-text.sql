-- Probe: query time on shapes later excluded as ambiguous (Q1a, population g).
--
-- workload_query_shapes.sql filters to `statement_text IS NOT NULL AND trim(statement_text) <> ''`
-- before it groups anything into a shape, because an empty text — most commonly customer-managed keys
-- redacting it — normalises to one shape covering every redacted statement in the window. This
-- measures the population that filter removes: how many statements have no usable text, and how much
-- of the window's query time they carry, against the total the statement's own window would otherwise
-- describe.
SELECT
  count(*)                                                                            AS statements,
  count(CASE WHEN statement_text IS NULL OR trim(statement_text) = '' THEN 1 END)      AS empty_text_statements,
  round(sum(total_duration_ms) / 1000.0 / 3600, 2)                                     AS total_hours,
  round(
    sum(CASE WHEN statement_text IS NULL OR trim(statement_text) = '' THEN total_duration_ms ELSE 0 END)
      / 1000.0 / 3600,
    2
  )                                                                                    AS empty_text_hours
FROM system.query.history
WHERE start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 15))
  AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
  AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
