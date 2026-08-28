-- Signal: sql:serving.facts
-- Rows: at most :serving_limit
-- Benchmark: coverage
--
-- One row per serving asset, carrying the field each readiness dimension reads.
--
-- Six dimensions in one statement rather than six statements, because they share a population and the
-- population is the expensive part: every aggregate below is joined to the declared list before it is
-- grouped, so each reads the rows of a few hundred relations rather than of the metastore. That is the
-- difference between this and `uc_discovery_metadata`, which joins reads onto a census of every
-- relation and cost 4,023,076 ms on the measurement estate — see `docs/plan/61-...`.
--
-- Six and not eight. Quality and classification were here and are now `serving_asset_quality` and
-- `serving_asset_classifications`, because their sources are the two system schemas an account admin
-- enables per metastore and neither is on by default. An absent schema is not an empty table: it fails
-- the statement at parse time, and while these eight were one statement that took the other six
-- dimensions with it on every metastore that had not enabled both — which is the calibration estate,
-- where this statement has never run. ADR 0088 records the choice; row 65 is the defect.
--
-- Nothing else moved out. The remaining six read `information_schema` and `system.access`, which are
-- present on every metastore this app supports, so the argument above for keeping them together holds
-- for exactly the sources it holds for.
--
-- What is deliberately not here:
--
--   * **`system.information_schema.abac_policy_definitions`.** It returned 720 rows in 16 minutes 34
--     seconds against 1.2 to 11 seconds for every other source measured. What the policy dimension
--     needs is whether a protection is on a table, and masks and filters answer that in a second.
--   * **Anything about Genie.** `system.access.assistant_events` names no space, conversation, asset or
--     feedback, so there is nothing here to join it on. The outcome reports that absence.
--   * **A judgement about the quality status.** The platform writes four of them and this app has not
--     measured what any one means, so the status is carried through as text and the dimension counts
--     whether one was recorded, not whether it was a good one.
--
-- Every count is coalesced to zero and every left join is a left join, so an asset the aggregates say
-- nothing about still returns a row. That is what lets the reader tell an asset with no lineage in the
-- window from an asset the statement never returned — the first is a reading and the second is not.
--
-- @param serving_assets  the population's qualified names, folded and comma-joined
-- @param serving_limit   the row ceiling
-- @param lookback_days   how far back lineage and quality results are read
WITH declared AS (
  SELECT DISTINCT lower(trim(part)) AS qualified
  FROM (SELECT explode(split(:serving_assets, ',')) AS part)
  WHERE trim(part) <> ''
),
relations AS (
  SELECT
    lower(concat_ws('.', table_catalog, table_schema, table_name)) AS qualified,
    table_type,
    data_source_format
  FROM system.information_schema.tables
  WHERE table_schema <> 'information_schema'
    AND {{customer_catalog table_catalog}}
),
column_comments AS (
  SELECT
    d.qualified,
    count(*) AS column_count,
    sum(CASE WHEN c.comment IS NOT NULL AND trim(c.comment) <> '' THEN 1 ELSE 0 END) AS commented_columns
  FROM system.information_schema.columns c
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', c.table_catalog, c.table_schema, c.table_name))
  GROUP BY ALL
),
-- The lineage window, read once. Both sides of an event are read from it: an asset nothing writes and
-- everything reads is as much a part of the estate's lineage as one nothing reads at all.
window_events AS (
  SELECT
    source_table_catalog AS source_catalog,
    source_table_schema AS source_schema,
    source_table_name AS source_table,
    target_table_catalog AS target_catalog,
    target_table_schema AS target_schema,
    target_table_name AS target_table
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
),
touched AS (
  SELECT d.qualified, count(*) AS lineage_events
  FROM (
    SELECT lower(concat_ws('.', source_catalog, source_schema, source_table)) AS qualified
    FROM window_events
    WHERE source_table IS NOT NULL

    UNION ALL

    SELECT lower(concat_ws('.', target_catalog, target_schema, target_table))
    FROM window_events
    WHERE target_table IS NOT NULL
  ) e
  JOIN declared d ON d.qualified = e.qualified
  GROUP BY ALL
),
-- A semantic asset over this one: a metric view that lineage says read it inside the window. The
-- METRIC_VIEW filter runs on the target side, so this counts the metric views built on an asset rather
-- than everything that ever selected from it.
semantic AS (
  SELECT
    d.qualified,
    count(DISTINCT lower(concat_ws('.', e.target_catalog, e.target_schema, e.target_table))) AS semantic_readers
  FROM window_events e
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', e.source_catalog, e.source_schema, e.source_table))
  JOIN system.information_schema.tables k
    ON k.table_catalog = e.target_catalog
   AND k.table_schema = e.target_schema
   AND k.table_name = e.target_table
   AND k.table_type = 'METRIC_VIEW'
  GROUP BY ALL
),
masks AS (
  SELECT d.qualified, count(*) AS masked_columns
  FROM system.information_schema.column_masks m
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', m.table_catalog, m.table_schema, m.table_name))
  GROUP BY ALL
),
filters AS (
  SELECT d.qualified, count(*) AS row_filters
  FROM system.information_schema.row_filters f
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', f.table_catalog, f.table_schema, f.table_name))
  GROUP BY ALL
)
SELECT
  d.qualified,
  r.table_type AS relation_kind,
  r.data_source_format AS storage_format,
  coalesce(cc.column_count, 0) AS column_count,
  coalesce(cc.commented_columns, 0) AS commented_columns,
  coalesce(t.lineage_events, 0) AS lineage_events,
  coalesce(s.semantic_readers, 0) AS semantic_readers,
  coalesce(m.masked_columns, 0) AS masked_columns,
  coalesce(f.row_filters, 0) AS row_filters,
  count(*) OVER () AS asset_population
FROM declared d
LEFT JOIN relations r ON r.qualified = d.qualified
LEFT JOIN column_comments cc ON cc.qualified = d.qualified
LEFT JOIN touched t ON t.qualified = d.qualified
LEFT JOIN semantic s ON s.qualified = d.qualified
LEFT JOIN masks m ON m.qualified = d.qualified
LEFT JOIN filters f ON f.qualified = d.qualified
ORDER BY d.qualified
LIMIT :serving_limit
