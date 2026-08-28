-- Signal: sql:uc.discovery
-- Rows: 1
-- Benchmark: coverage
--
-- Whether the assets consumers actually read carry the metadata that would let someone
-- find them, and how that compares with the estate as a whole.
--
-- DG-01-05 already measures descriptions across every table, and this is deliberately the
-- same measure over a different population — the same predicate as `uc_asset_census.sql`,
-- so the two numbers are comparable rather than merely adjacent. The two disagreeing is
-- the finding. Measured on labs 2026-08-10: 4 of 19 customer tables carry a description,
-- and of the 9 that anything read in the previous 30 days, none did. Both are true, and
-- only the second answers "can a consumer find what they need".
--
-- The first pass at that measurement said 88 of 143, because it left out
-- `table_schema <> 'information_schema'` and counted 124 of Databricks' own catalogue
-- views — which carry Databricks' comments, so the omission inflated the described share
-- and the population together. See `docs/plan/m1-measured-not-asked.md`, PR 37k.
--
-- Read activity comes from `system.access.table_lineage` for the same reason
-- `storage_sample_selection.sql` ranks by it: `system.query.history` records the statement
-- but not the tables it touched, so it cannot say which assets were read. Lineage records a
-- row per source table with no target for a plain SELECT — measured on labs, 1,235 of the
-- window's 1,247 customer-catalog read events had a null target and a null entity_type,
-- which is what a notebook or a warehouse query leaves behind.
--
-- What this cannot see is a consumer who looked and left. Someone who searched Catalog
-- Explorer, could not tell what a table held, and gave up reads nothing and appears
-- nowhere — so an estate whose undescribed tables go unread scores well here on the
-- strength of the thing the control is worried about. That is the limit of the reading and
-- the finding says so rather than the statement pretending otherwise.
--
-- Databricks-owned catalogs are excluded by the customer-catalog fragment on the census
-- side, and the read counts inherit that exclusion through the join rather than repeating
-- it. That matters more here than usual: on labs 7,170 of the window's 8,492 read events
-- were this app's own reads of `system`, against 1,247 of the customer's own tables.
--
-- The column half left this statement in row 61b and is `uc_discovery_columns.sql`. It read
-- `system.information_schema.columns`, which row 61a measured taking this statement from
-- 52,699 ms to 4,023,076 ms on large-estate, and row 75 found no predicate form reduces —
-- ADR 0092. What stayed is every field the control bands on.
--
-- Feeds: DG-01-06.
--
-- @param lookback_days  how far back read activity is counted
-- @param workspace_id   one workspace, or '' for the whole account
WITH customer_tables AS (
  SELECT
    concat_ws('.', table_catalog, table_schema, table_name) AS full_name,
    CASE WHEN comment IS NOT NULL AND trim(comment) <> '' THEN 1 ELSE 0 END AS described,
    CASE WHEN table_owner IS NOT NULL AND trim(table_owner) <> '' THEN 1 ELSE 0 END AS owned
  FROM system.information_schema.tables
  WHERE table_schema <> 'information_schema'
    AND {{customer_catalog table_catalog}}
),
-- One row per table, so a table read a thousand times counts once. The question is whether
-- the assets consumers reach for are described, not how hard they reached.
reads AS (
  SELECT
    concat_ws('.', source_table_catalog, source_table_schema, source_table_name) AS full_name,
    count(*) AS read_events
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND source_table_name IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
  GROUP BY ALL
),
tagged AS (
  SELECT DISTINCT concat_ws('.', catalog_name, schema_name, table_name) AS full_name
  FROM system.information_schema.table_tags
  WHERE {{customer_catalog catalog_name}}
)
SELECT
  count(*)                                                                     AS estate_tables,
  sum(t.described)                                                             AS estate_tables_described,
  sum(CASE WHEN r.full_name IS NOT NULL THEN 1 ELSE 0 END)                     AS read_tables,
  sum(CASE WHEN r.full_name IS NOT NULL THEN t.described ELSE 0 END)           AS read_tables_described,
  sum(CASE WHEN r.full_name IS NOT NULL AND g.full_name IS NOT NULL THEN 1 ELSE 0 END)
                                                                               AS read_tables_tagged,
  sum(CASE WHEN r.full_name IS NOT NULL THEN t.owned ELSE 0 END)               AS read_tables_owned,
  -- Not part of any share: it says how much activity the population above was drawn from,
  -- which is the difference between a quiet estate and an unread one.
  sum(coalesce(r.read_events, 0))                                              AS read_events
FROM customer_tables t
LEFT JOIN reads r ON r.full_name = t.full_name
LEFT JOIN tagged g ON g.full_name = t.full_name
