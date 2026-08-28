-- Signal: sql:uc.discovery_columns
-- Rows: 1
-- Benchmark: coverage
--
-- The class is `uc_discovery_metadata`'s, which this is half of: a described share over the
-- population lineage says was read, computed from the same two relations by the same predicate.
-- Written as `census` on the first pass and changed here, which is worth saying plainly because
-- the change bought a fourfold ceiling on a statement that had just measured 5,001 ms against
-- census's 5,000 — the reading is what exposed the wrong word, not what chose the new one.
--
-- Whether the columns of the tables consumers read carry comments. The other half of
-- `uc_discovery_metadata`, in a statement of its own because it costs an hour and the
-- rest of the measure costs 53 seconds.
--
-- A described table whose columns are all blank is findable and not understandable, and
-- DG-01-06 asks for both — so this is not detail the control can do without on principle.
-- It is detail the control can do without *on an estate where it does not return*, which
-- is the distinction ADR 0092 draws and the reason this is an enrichment rather than a
-- requirement: `governance.ts` bands on the table share and adds this line when it has it.
--
-- **Why it is expensive, measured rather than assumed.** Row 61a found `uc_discovery_metadata`
-- taking 4,023,076 ms on large-estate against 52,699 ms for the same statement without its
-- `columns` CTE. Row 70 found the hour is compilation, not execution: 3,979,324 ms of
-- 3,984,316 ms. Row 75 then measured a probe reading `system.information_schema.columns` and
-- nothing else, under four predicate forms — the shipped subquery, a literal list of all
-- 3,558 customer catalogs, a single-catalog literal, and no predicate. Three of the four were
-- cancelled at fifteen minutes. The one that finished named one catalog and spent 360,720 ms
-- of its 361,329 ms compiling, reading zero bytes. So the cost is the reference itself, no
-- predicate reduces it, and nothing about this statement's own text can make it cheap.
--
-- Restricted to the read tables rather than the estate, which is what the measure asks for
-- and is also the only reduction available. It is not a cost reduction: row 70 built exactly
-- this restriction as a rework and measured it *slower* — 4,048,127 ms — because a WHERE
-- clause is applied to rows and the hour is spent before there are any.
--
-- Feeds: DG-01-06, as enrichment.
--
-- @param lookback_days  how far back read activity is counted
-- @param workspace_id   one workspace, or '' for the whole account
WITH reads AS (
  SELECT DISTINCT concat_ws('.', source_table_catalog, source_table_schema, source_table_name) AS full_name
  FROM system.access.table_lineage
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND source_table_name IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
),
-- The same population `uc_discovery_metadata` counts, by the same predicate, so the two
-- statements' denominators are the same estate rather than merely adjacent ones.
customer_tables AS (
  SELECT concat_ws('.', table_catalog, table_schema, table_name) AS full_name
  FROM system.information_schema.tables
  WHERE table_schema <> 'information_schema'
    AND {{customer_catalog table_catalog}}
),
columns AS (
  SELECT
    concat_ws('.', table_catalog, table_schema, table_name) AS full_name,
    count(*) AS column_count,
    sum(CASE WHEN comment IS NOT NULL AND trim(comment) <> '' THEN 1 ELSE 0 END) AS described_columns
  FROM system.information_schema.columns
  WHERE table_schema <> 'information_schema'
    AND {{customer_catalog table_catalog}}
  GROUP BY ALL
)
SELECT
  sum(c.column_count)                     AS read_table_columns,
  sum(c.described_columns)                AS read_table_columns_described
FROM customer_tables t
JOIN reads r ON r.full_name = t.full_name
JOIN columns c ON c.full_name = t.full_name
