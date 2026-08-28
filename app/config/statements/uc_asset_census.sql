-- Signal: sql:uc.census
-- Rows: 1
-- Benchmark: census
--
-- The governed asset estate: how many tables, where they live, whether they are
-- managed or external, what format they are in, and how many carry a description.
--
-- `system.information_schema` covers the current metastore only, which is the
-- right scope: Unity Catalog governance is a metastore property, and a table in
-- another metastore is governed by that metastore's configuration, not this one.
--
-- Databricks-owned catalogs are excluded from every aggregate and counted separately.
-- They are read-only and present in every workspace, so a finding about them is a finding
-- about tables the customer cannot change. The count is reported rather than dropped so
-- the finding can say what was left out and the total still reconciles against
-- `information_schema` — see the note in queries.ts for the measurement that prompted it.
--
-- This query counted `hive_metastore` tables until 2026-08-05, and the count was
-- structurally always zero. `system.information_schema` covers the Unity Catalog
-- metastore, and the legacy catalog sits outside it — confirmed against an estate with
-- 1,101 legacy tables, where `hive_metastore` does not appear in
-- `information_schema.catalogs` at all and has no `information_schema` of its own. Four
-- resolvers read that zero and turned it into a claim that every table was governed.
--
-- It is not replaced. The app measures Unity Catalog, and a legacy metastore is out of
-- scope rather than unmeasured within it: the advice for anything living there is to
-- migrate, which needs no count to give. So no aggregate here implies anything about
-- what sits beside this metastore, and nothing downstream may claim completeness from
-- a number in this row. See `docs/plan/e1-populations.md`, phase `E1b`.
--
-- Feeds: DG-01-02 (UC design), DG-01-03 (single metadata plane),
-- DG-01-05 (descriptions), CO-01-01 (data formats), DG-03-03 (standard formats).
SELECT
  count(*)                                                                    AS table_count,
  count(DISTINCT table_catalog)                                               AS catalog_count,
  count(DISTINCT concat_ws('.', table_catalog, table_schema))                 AS schema_count,
  sum(CASE WHEN table_type = 'MANAGED' THEN 1 ELSE 0 END)                     AS managed_tables,
  sum(CASE WHEN table_type = 'EXTERNAL' THEN 1 ELSE 0 END)                    AS external_tables,
  sum(CASE WHEN table_type = 'VIEW' THEN 1 ELSE 0 END)                        AS views,
  -- Metric views and foreign tables have no storage format to choose. The format
  -- resolvers subtract them from the denominator the same way they already subtract
  -- views. Counted here rather than filtered so a finding can say what was left out,
  -- and so this row still sums to `table_count`. Keep the same two sums in
  -- `uc_schema_census` or the per-schema gaps will not add up to the estate.
  sum(CASE WHEN table_type = 'METRIC_VIEW' THEN 1 ELSE 0 END)                 AS metric_views,
  sum(CASE WHEN table_type = 'FOREIGN' THEN 1 ELSE 0 END)                     AS foreign_tables,
  sum(CASE WHEN upper(COALESCE(data_source_format, '')) = 'DELTA' THEN 1 ELSE 0 END) AS delta_tables,
  sum(CASE WHEN upper(COALESCE(data_source_format, '')) = 'ICEBERG' THEN 1 ELSE 0 END) AS iceberg_tables,
  -- Open, performance-optimised formats per the cost pillar. Anything else
  -- (CSV, JSON, plain Parquet without a table format) is counted as neither.
  sum(CASE WHEN upper(COALESCE(data_source_format, '')) IN ('DELTA', 'ICEBERG') THEN 1 ELSE 0 END) AS optimized_format_tables,
  sum(CASE WHEN COALESCE(trim(comment), '') <> '' THEN 1 ELSE 0 END)          AS described_tables,
  count(DISTINCT table_owner)                                                 AS distinct_owners,
  -- What the exclusion removed, so the finding can state it and the numbers reconcile.
  (
    SELECT count(*)
    FROM system.information_schema.tables
    WHERE table_schema <> 'information_schema'
      AND NOT {{customer_catalog table_catalog}}
  )                                                                           AS databricks_owned_tables,
  (
    SELECT array_join(sort_array(collect_set(table_catalog)), ', ')
    FROM system.information_schema.tables
    WHERE table_schema <> 'information_schema'
      AND NOT {{customer_catalog table_catalog}}
  )                                                                           AS databricks_owned_catalogs
FROM system.information_schema.tables
WHERE table_schema <> 'information_schema'
  AND {{customer_catalog table_catalog}}
