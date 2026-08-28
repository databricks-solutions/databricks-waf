-- Signal: sql:storage.sample_selection
-- Rows: at most :table_limit
-- Benchmark: inventory
--
-- Chooses which tables the per-table pass will describe.
--
-- The plan was to rank by size, but `system.storage.table_metrics_history` — the only
-- system table carrying per-table bytes — is undocumented and was empty on the
-- workspace this was developed against, so size is not available to rank by at
-- metastore scale. See ADR 0014.
--
-- Read activity from `system.access.table_lineage` is the ranking used instead, and it
-- is arguably the better key regardless: a large table nobody reads costs storage but
-- not query time, while a heavily read table with bad layout costs both. Tables with no
-- observed reads still appear, below the active ones, so a quiet estate is described
-- rather than skipped.
--
-- The ordering is fully deterministic — read count, then catalog, schema and table name
-- — which matters more than it looks. The per-table pass covers a subset, and a subset
-- chosen differently on each scan would make scan-over-scan comparison meaningless: the
-- score would move because the sample moved. A stable order means a changed finding
-- reflects a changed estate.
--
-- Restricted to Delta because DESCRIBE DETAIL's layout fields — clustering columns,
-- deletion vectors, file counts — only exist for Delta. Other formats are counted by
-- the census and excluded here rather than described and reported as blank.
WITH reads AS (
  SELECT
    concat_ws('.', source_table_catalog, source_table_schema, source_table_name) AS full_name,
    count(*) AS read_events
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND source_table_name IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
  GROUP BY ALL
)
SELECT
  t.table_catalog,
  t.table_schema,
  t.table_name,
  t.table_type,
  coalesce(r.read_events, 0) AS read_events,
  -- The population the sample is drawn from, so the finding can state its coverage as
  -- a fraction rather than as a bare count of what it happened to look at.
  count(*) OVER () AS eligible_tables
FROM system.information_schema.tables t
LEFT JOIN reads r
  ON r.full_name = concat_ws('.', t.table_catalog, t.table_schema, t.table_name)
WHERE t.table_schema <> 'information_schema'
  -- Was `t.table_catalog <> 'system'`, which excluded the obvious Databricks-owned catalog
  -- and missed `samples`. On labs that left the per-table sample spending most of its
  -- budget describing Databricks' own demo datasets: the layout findings were true and
  -- about tables nobody at the customer owns.
  AND {{customer_catalog t.table_catalog}}
  AND t.table_type IN ('MANAGED', 'EXTERNAL')
  AND t.data_source_format = 'DELTA'
ORDER BY read_events DESC, t.table_catalog, t.table_schema, t.table_name
LIMIT :table_limit
