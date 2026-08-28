-- Signal: sql:uc.lineage_coverage
-- Rows: 1
-- Benchmark: coverage
--
-- What fraction of the table estate has observed lineage in the window.
--
-- Lineage is emitted when a table is read or written through a governed path, so
-- absence has two very different causes: the table is inactive, or activity is
-- happening outside Unity Catalog's view. The query cannot tell them apart, so it
-- reports the population, the covered subset, and the number of tables read or
-- written in the window from query history, and leaves the interpretation to the
-- control.
--
-- `tables_with_lineage` counts each table once, whether it appears as a source, a
-- target, or both. The per-side counts remain for detail; they must not be added
-- for the coverage share — a table on both sides was double-counted that way
-- (measured on labs: 7 of 26 distinct tables sat in the overlap, 21% of the sum).
-- Identities are grouped on the three name parts rather than concatenated, so a
-- quoted name containing a dot cannot collide with a different three-part name.
--
-- The plan reads `system.access.table_lineage` once. It read it ten times, which is what
-- 36k's scan pass measured and what this statement was rewritten for: two `UNION ALL`
-- branches, each read three times over by the scalar subqueries that referenced them,
-- plus one read each for the event count and the last event time. On labs 2026-08-11 the
-- rewrite measured 4,739 ms against 22,000 ms — medians of four alternating readings with
-- the first of each dropped — with the engine's own `execution_duration_ms` agreeing
-- (2,597 ms against 17,782 ms), `read_bytes` down from 1,668,357 to 509,216, and the rows
-- identical. That took the statement from outside its 20s coverage ceiling to inside it,
-- and retired the budget exception it held.
--
-- Naming the relation once is not what did it. The first rewrite did exactly that — one
-- `FROM`, five scalar subqueries over a CTE — and the plan still showed four scans of the
-- base relation, at 8,058 ms. So a CTE that several scalar subqueries reference is not
-- read once here, whatever the text looks like. What measured one scan is one aggregate:
-- the `lineage` CTE below is a single pass over `sides`, and every figure is a conditional
-- aggregate within it. If a sixth figure is ever wanted here, add it to that aggregate
-- rather than beside it, and check the plan rather than the `FROM` list.
--
-- Feeds: DG-01-04 (lineage visibility), DG-02-03 (auditing data platform events).
WITH population AS (
  SELECT count(*) AS table_count
  FROM system.information_schema.tables
  WHERE table_schema <> 'information_schema'
    AND table_type IN ('MANAGED', 'EXTERNAL')
    -- Databricks-owned catalogs are out of the denominator: system tables do carry lineage
    -- of their own, and including them would move this ratio for reasons the customer
    -- neither caused nor can change.
    AND {{customer_catalog table_catalog}}
),
events AS (
  -- The only read of `table_lineage`. Both sides' scope tests are projected here rather
  -- than filtered, because the two sides are filtered differently downstream and a `WHERE`
  -- could only apply one of them. The fragment holds a subquery, which Databricks
  -- decorrelates in a projection as readily as in a `WHERE` (measured on labs 2026-08-11:
  -- the same count either way); its three-valued result is why the filter below is
  -- `target_in_scope OR source_in_scope` rather than a comparison against `true`.
  SELECT
    event_time,
    {{customer_catalog target_table_catalog}} AS target_in_scope,
    {{customer_catalog source_table_catalog}} AS source_in_scope,
    target_table_catalog,
    target_table_schema,
    target_table_name,
    source_table_catalog,
    source_table_schema,
    source_table_name
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
),
paired AS (
  -- One row per event that touches the assessed estate on either side, carrying whichever
  -- sides are in scope. `event_side` names the one side that will stand for the event, so
  -- an event with both sides in scope is counted once rather than twice.
  SELECT
    event_time,
    CASE WHEN target_in_scope THEN 'target' ELSE 'source' END AS event_side,
    array(
      CASE
        WHEN target_in_scope
          THEN named_struct(
            'side', 'target',
            'catalog_name', target_table_catalog,
            'schema_name', target_table_schema,
            'table_name', target_table_name
          )
      END,
      CASE
        WHEN source_in_scope
          THEN named_struct(
            'side', 'source',
            'catalog_name', source_table_catalog,
            'schema_name', source_table_schema,
            'table_name', source_table_name
          )
      END
    ) AS side_list
  FROM events
  WHERE target_in_scope OR source_in_scope
),
sides AS (
  -- One row per in-scope side of each event: what the two `UNION ALL` branches used to
  -- produce from two reads. The `IS NOT NULL` filter drops a side that was out of scope,
  -- which is why the array's elements are nullable `CASE`s.
  SELECT
    event_time,
    side.side              AS side,
    named_struct(
      'catalog_name', side.catalog_name,
      'schema_name',  side.schema_name,
      'table_name',   side.table_name
    )                      AS identity,
    side.side = event_side AS counts_the_event
  FROM paired
  LATERAL VIEW explode(side_list) AS side
  WHERE side IS NOT NULL
),
lineage AS (
  -- One pass. The identity is a struct rather than three arguments to
  -- `count(DISTINCT a, b, c)`, which skips a row where any argument is null: a lineage row
  -- can carry a table name without a schema, and `SELECT DISTINCT` — what this replaced —
  -- counts that as an identity of its own. A struct with a null field is not itself null,
  -- so it is counted, and struct equality treats two nulls as equal the way `DISTINCT`
  -- does. It also keeps the property a concatenated key would lose: a name containing a
  -- dot cannot collide with a different three-part name.
  SELECT
    count(DISTINCT identity)                                    AS tables_with_lineage,
    count(DISTINCT CASE WHEN side = 'target' THEN identity END) AS targets,
    count(DISTINCT CASE WHEN side = 'source' THEN identity END) AS sources,
    count(CASE WHEN counts_the_event THEN 1 END)                AS events,
    max(CASE WHEN counts_the_event THEN event_time END)         AS last_event
  FROM sides
)
SELECT
  population.table_count,
  lineage.tables_with_lineage,
  lineage.targets   AS tables_written_with_lineage,
  lineage.sources   AS tables_read_with_lineage,
  lineage.events    AS lineage_events,
  lineage.last_event
FROM population, lineage
