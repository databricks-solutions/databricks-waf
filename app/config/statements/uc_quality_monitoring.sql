-- Signal: sql:uc.quality_monitoring
-- Rows: 1
-- Benchmark: census
--
-- What Unity Catalog's quality monitor last said about each customer table, counted rather than
-- scored. DG-03-02 reads this and does not band it: estate coverage measures platform adoption,
-- and the health share of monitored tables moves for nobody. ADR 0102 and row 78.
--
-- Its own statement, because system.data_quality_monitoring is enabled per metastore by an
-- account admin and is absent by default. An absent schema fails a statement at parse time
-- (ADR 0088), so this read shares a statement with nothing else.
--
-- Grain is latest verdict per table (`max_by` over the window), not a count of results. On
-- large-estate a thirty-day window held 378 Unhealthy results and one Unhealthy latest verdict;
-- those are different controls and this one is the current condition. Views are excluded from
-- the estate the same way the other census statements exclude them.
--
-- The customer-catalog predicate is inlined rather than written as a fragment. queries.ts
-- owns that expression; a statement on the awaiting-reading list cannot carry the fragment,
-- because a submission of the raw file would not have sent what the app sends.
--
-- @param lookback_days   how far back quality results are read
WITH estate AS (
  SELECT
    count(*) AS estate_tables,
    count(DISTINCT table_catalog) AS estate_catalogs
  FROM system.information_schema.tables
  WHERE (table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user') AND lower(table_catalog) NOT IN ('system', 'samples') AND NOT startswith(lower(table_catalog), '__databricks_internal'))
    AND table_type <> 'VIEW'
),
latest AS (
  SELECT
    catalog_name,
    max_by(status, event_time)              AS status,
    max_by(freshness.status, event_time)    AS freshness_status,
    max_by(completeness.status, event_time) AS completeness_status
  FROM system.data_quality_monitoring.table_results
  WHERE event_time >= current_timestamp() - make_dt_interval(:lookback_days)
    AND (catalog_name NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user') AND lower(catalog_name) NOT IN ('system', 'samples') AND NOT startswith(lower(catalog_name), '__databricks_internal'))
  GROUP BY catalog_name, schema_name, table_name
),
monitored AS (
  SELECT
    count(*)                                             AS monitored_tables,
    count(DISTINCT catalog_name)                         AS monitored_catalogs,
    count_if(status = 'Healthy')                         AS healthy,
    count_if(status = 'Unhealthy')                       AS unhealthy,
    count_if(status = 'Training')                        AS training,
    count_if(status = 'Error')                           AS errored,
    count_if(status NOT IN ('Healthy', 'Unhealthy', 'Training', 'Error')) AS unnamed_status,
    count_if(freshness_status IS NOT NULL)               AS freshness_present,
    count_if(completeness_status IS NOT NULL)            AS completeness_present,
    count_if(freshness_status <> 'Unknown')              AS freshness_established,
    count_if(completeness_status <> 'Unknown')           AS completeness_established
  FROM latest
)
SELECT
  e.estate_tables,
  e.estate_catalogs,
  m.monitored_tables,
  m.monitored_catalogs,
  m.healthy,
  m.unhealthy,
  m.training,
  m.errored,
  m.unnamed_status,
  m.freshness_present,
  m.completeness_present,
  m.freshness_established,
  m.completeness_established
FROM estate e
CROSS JOIN monitored m
