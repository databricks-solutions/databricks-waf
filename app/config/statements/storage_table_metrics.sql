-- Signal: sql:storage.table_metrics
-- Rows: at most :table_limit
-- Benchmark: inventory
--
-- Per-table size and file counts for the whole metastore, from the daily snapshot
-- in `system.storage.table_metrics_history`.
--
-- Where this table is written it is what would make the storage assessment
-- something other than a sampling exercise. It carries `active_bytes`,
-- `active_files` and `predictive_optimization_enabled` per table at metastore
-- scale, so size, file-count and predictive-optimization coverage would be
-- complete rather than estimated from a sample, and only the attributes it does
-- not carry — clustering columns, deletion vectors, history depth — would still
-- need a bounded per-table pass.
--
-- Nowhere this app has measured is it written. It was empty on the workspace this
-- was developed against; read unbounded on 2026-08-12 it returned zero rows on
-- both labs and the measurement estate, the second holding 615,361 catalogued
-- relations, with the grant established from a sibling table in the same schema.
-- See docs/decisions/0078-the-table-layout-questions-are-the-assessments-and-its-metrics-table-is-unwritten.md
-- and the two `*-table-layout-inputs.json` recordings. So the sampled path is not
-- a fallback in practice, it is the path — and this statement stays because the
-- collector's `noAnswer` reports an empty snapshot as unmeasured rather than as an
-- estate of zero bytes, and because it is how the app would notice the day the
-- platform starts writing it.
--
-- Returns the largest tables plus a complete aggregate, so the estate total is
-- exact while the row detail stays bounded.
--
-- The `SELECT *` below stays. Q1k scheduled removing it on the premise that a wide
-- projection through a CTE makes the scan read columns nothing uses; measured, the
-- optimiser prunes the scan to what the projection above it references — 19 columns to 14
-- on `jobs_inventory`, 27 to 21 on the cluster inventory, 14 to 13 and 13 to 10 on the two
-- other statements written this way. Not measured on this statement, because
-- `system.storage.table_metrics_history` is empty on labs and its whole plan folds to a
-- constant. See docs/design/q1a-runtime-baseline.md.
WITH snapshot AS (
  SELECT * FROM system.storage.table_metrics_history
  WHERE snapshot_date = (SELECT max(snapshot_date) FROM system.storage.table_metrics_history)
    AND table_dropped_time IS NULL
)
SELECT
  'estate'                                       AS row_kind,
  NULL                                           AS catalog_name,
  NULL                                           AS schema_name,
  NULL                                           AS table_name,
  NULL                                           AS table_type,
  count(*)                                       AS table_count,
  sum(active_bytes)                              AS active_bytes,
  sum(active_files)                              AS active_files,
  sum(CASE WHEN predictive_optimization_enabled THEN 1 ELSE 0 END) AS po_tables,
  max(snapshot_date)                             AS snapshot_date
FROM snapshot
UNION ALL
SELECT
  'table',
  catalog_name,
  schema_name,
  table_name,
  table_type,
  1,
  active_bytes,
  active_files,
  CASE WHEN predictive_optimization_enabled THEN 1 ELSE 0 END,
  snapshot_date
FROM snapshot
-- The qualified name breaks ties, and it is not cosmetic: `active_bytes` is the only thing
-- above it that separates tables, `LIMIT` then keeps a prefix of this order, and tables of
-- equal size are common — every empty table is zero and every unmeasured one is null. Two
-- runs over one snapshot could otherwise return different tables and both be correct, so a
-- reader comparing weeks would see tables appear and disappear on no change at all. Unique
-- because the source holds one row per table per `snapshot_date` and the CTE above pins the
-- snapshot to one date. The estate row sorts first on `row_kind` and there is only one of
-- it, so its nulls here never decide anything.
ORDER BY row_kind, active_bytes DESC NULLS LAST, catalog_name, schema_name, table_name
LIMIT :table_limit
