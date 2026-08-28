-- Signal: sql:uc.catalogs
-- Rows: one per catalog
-- Benchmark: census
--
-- `uc_schema_census` beside it already carries `LIMIT :segment_limit` for the same reason, and this
-- statement is the one that missed it. See bounds.ts, and H1 in docs/plan-status.md.
--
-- The customer's catalogs, with how many tables each holds.
--
-- Exists to give the predictive-optimization pass its targets. Enablement is
-- readable per catalog with `DESCRIBE CATALOG EXTENDED`, and that is a statement
-- per catalog, so something has to say which catalogs are worth describing and
-- how much of the estate each one accounts for.
--
-- Only catalogs holding at least one table are listed. A catalog with no tables
-- has nothing for predictive optimization to maintain, so describing it would
-- spend a statement to learn a setting that governs nothing — and would make a
-- fully-enabled estate read as partial because an empty catalog was left on
-- INHERIT.
--
-- The table counts are what let catalog-level enablement be reported as a share
-- of the estate rather than a share of the catalogs. Four of four catalogs
-- enabled sounds complete; it is not, if the fifth catalog held every table.
SELECT
  table_catalog                                                            AS catalog_name,
  count(*)                                                                 AS table_count,
  count(CASE WHEN table_type = 'MANAGED' THEN 1 END)                       AS managed_tables,
  count(DISTINCT table_schema)                                             AS schema_count
FROM system.information_schema.tables
WHERE table_schema <> 'information_schema'
  AND {{customer_catalog table_catalog}}
GROUP BY table_catalog
ORDER BY managed_tables DESC, table_count DESC, table_catalog
