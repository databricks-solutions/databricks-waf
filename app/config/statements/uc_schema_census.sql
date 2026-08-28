-- Signal: sql:uc.schema_census
-- Rows: at most :segment_limit
-- Benchmark: census
--
-- The same census as `uc_asset_census`, broken down per schema.
--
-- The estate aggregate answers "how much of the estate is ungoverned"; this answers
-- "where". They are different questions and only the second one can be acted on: a
-- customer told that 103 of 347 tables carry no description has a statistic, and one
-- told that four schemas hold 90 of them has a morning's work.
--
-- Bounded by :segment_limit, ordered so the truncation is the least interesting part
-- of the answer: the schemas holding the most tables come first, so a cut-off list
-- still names the segments worth starting with. The collector reports how many
-- schemas exist against how many were returned, so a truncated result says so rather
-- than presenting the top slice as the whole.
--
-- Feeds the segment model that the maintenance controls need — predictive
-- optimization is enabled per catalog and per schema, so "is maintenance absent" can
-- only be answered per segment.
--
-- The filter is deliberately identical to `uc_asset_census` rather than tighter. If the
-- two disagreed, the per-schema counts would not sum to the estate total, and a user
-- checking one against the other would find a discrepancy with no stated cause.
--
-- @param segment_limit INT
SELECT
  table_catalog,
  table_schema,
  count(*)                                                                          AS table_count,
  sum(CASE WHEN table_type = 'MANAGED' THEN 1 ELSE 0 END)                           AS managed_tables,
  sum(CASE WHEN table_type = 'EXTERNAL' THEN 1 ELSE 0 END)                          AS external_tables,
  sum(CASE WHEN table_type = 'VIEW' THEN 1 ELSE 0 END)                              AS views,
  -- Same leftover types as `uc_asset_census`, so a per-schema gap sums to the estate one.
  sum(CASE WHEN table_type = 'METRIC_VIEW' THEN 1 ELSE 0 END)                       AS metric_views,
  sum(CASE WHEN table_type = 'FOREIGN' THEN 1 ELSE 0 END)                           AS foreign_tables,
  sum(CASE WHEN upper(COALESCE(data_source_format, '')) IN ('DELTA', 'ICEBERG') THEN 1 ELSE 0 END) AS optimized_format_tables,
  sum(CASE WHEN COALESCE(trim(comment), '') <> '' THEN 1 ELSE 0 END)                AS described_tables,
  count(DISTINCT table_owner)                                                       AS distinct_owners,
  -- Windows are evaluated over the grouped rows and before the LIMIT, so this is the
  -- number of schemas that exist, not the number returned. Without it a result of
  -- exactly :segment_limit rows is ambiguous — a complete answer and a truncated one
  -- look identical, and the ambiguity resolves silently in favour of the wrong one.
  count(*) OVER ()                                                                  AS schema_population
FROM system.information_schema.tables
WHERE table_schema <> 'information_schema'
  AND {{customer_catalog table_catalog}}
GROUP BY table_catalog, table_schema
ORDER BY table_count DESC, table_catalog, table_schema
LIMIT :segment_limit
