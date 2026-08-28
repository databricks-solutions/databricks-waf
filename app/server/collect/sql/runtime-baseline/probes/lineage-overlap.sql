-- Probe: source∩target overlap in system.access.table_lineage (Q1a, population a).
--
-- uc_lineage_coverage.sql counts `tables_written_with_lineage` and `tables_read_with_lineage`
-- separately, and Q1b's finding is that two resolvers then add those counts — so a table lineage
-- recorded as both a source and a target in the window is counted twice before the sum is clamped to
-- the population. This measures the overlap directly: how many tables are in both sets, and how large
-- the double-count is against the union that a correct count would report.
--
-- Same filters as the shipped statement — the lookback window, the workspace scope, and the exclusion
-- of Databricks-owned catalogs — so this is a reading of the same population rather than a related
-- one. The `{{customer_catalog ...}}` fragment is inlined rather than expanded through the macro,
-- because this file is read directly off disk by the measurement script rather than through
-- FileQuerySource; `queries.ts` holds the one definition and this predicate must read the same as it.
WITH sources AS (
  SELECT DISTINCT concat_ws('.', source_table_catalog, source_table_schema, source_table_name) AS table_id
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (
      source_table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user')
      AND lower(source_table_catalog) NOT IN ('system', 'samples', '__databricks_internal')
    )
),
targets AS (
  SELECT DISTINCT concat_ws('.', target_table_catalog, target_table_schema, target_table_name) AS table_id
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (
      target_table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user')
      AND lower(target_table_catalog) NOT IN ('system', 'samples', '__databricks_internal')
    )
),
overlap AS (
  SELECT s.table_id FROM sources s JOIN targets t ON t.table_id = s.table_id
),
combined AS (
  SELECT table_id FROM sources
  UNION
  SELECT table_id FROM targets
)
SELECT
  (SELECT count(*) FROM sources)  AS sources,
  (SELECT count(*) FROM targets)  AS targets,
  (SELECT count(*) FROM overlap)  AS overlap,
  (SELECT count(*) FROM combined) AS distinct_union
