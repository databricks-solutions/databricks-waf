-- Signal: sql:workload.table_statistics
-- Rows: at most :stats_limit
-- Benchmark: workload
--
-- When a table's optimizer statistics were last computed, and whether it has been written since.
--
-- Feeds the workload advisor's `MISSING_OR_STALE_STATS` rule, which joins these rows to the tables a query
-- shape's plan says it scanned. Analysis rather than assessment: nothing here can change a score or a
-- finding. `docs/plan/h6-workload-advisor.md` under `33iga` records the measurement this statement's shape
-- came out of, and the three things it establishes are the three that decide what is not here.
--
-- ## It cannot say statistics are missing, and does not try
--
-- The rule the design document names is `MISSING_OR_STALE_STATS` and this answers the second half only.
--
-- A table with no ANALYZE record is indistinguishable from a table predictive optimization has not reached.
-- `33iga` measured the alternative the design document suggests — `DESCRIBE EXTENDED`, whose `Statistics`
-- row it hoped would say — and found the row present on 11 of the 12 tables a corpus of plans scanned while
-- **7 of those 11 had no ANALYZE record of any kind**. That row is the Delta log's own size and row estimate,
-- present on any Delta table carrying file statistics, and `system.billing.usage` reports one at
-- "140251663055 bytes, 1970658704 rows" having never been analysed by anything. Nothing else in that
-- command's 34 rows of output says when statistics were computed, and `information_schema` carries no
-- statistic at all — its `columns` relation has ten columns documented "Always NULL, reserved for future
-- use" and not one of them is this.
--
-- So absence is unknown here rather than absent, and a row this returns is always a table something did
-- analyse. What the rule may say is bounded by that, and its ruleset entry says so to the reader.
--
-- ## Its ceiling is the ANALYZE history, which is what makes it declarable
--
-- `LIMIT :stats_limit` is a cap on a list already bounded by something much smaller than the estate: one row
-- per table analysed in the window, which was 34 over thirty days on labs against a metastore of thousands
-- of tables. A statement returning a row per *table* would be estate-scaled and would need slicing; this one
-- is not, because predictive optimization analyses a table when something writes it and most tables in a
-- month are not written.
--
-- Ordered by the gap descending so the cap, if it ever binds, keeps the stalest — the rows a rule fires on.
--
-- ## Two sources, and neither is the other's substitute
--
-- Predictive optimization's operations history is the only place an ANALYZE is recorded reliably. Query
-- history holds manual ones and `33iga` measured **one statement in thirty days** against 38 automatic
-- operations, which is the same limit ADR 0063 and PE-03-15 already record from the estate side: ANALYZE
-- submitted from a notebook on classic compute is not in query history at all. Reading only query history
-- would find almost nothing; reading it as well would add a source whose absences mean nothing.
--
-- Writes come from `system.access.table_lineage` rather than from a table property, because
-- `delta.lastCommitTimestamp` is only reachable through one `DESCRIBE EXTENDED` per table and this is one
-- statement. Lineage is the app's existing route to a write — `uc_lineage_coverage` and
-- `storage_sample_selection` both read it — and its own limit is that it records what the lineage system
-- saw, so a table written by something lineage does not observe reads here as not written.
--
-- ## A negative gap is health
--
-- On labs, 33 of the 34 analysed tables were last written *before* their statistics were computed, which is
-- predictive optimization doing exactly what it exists to do. Only a positive gap is a finding, so the
-- comparison is returned as a signed number of hours and the threshold lives in the ruleset rather than
-- here — the statement reports, the rule decides.
--
-- Feeds: the workload advisor. Cites no requirement and scores nothing.
WITH analysed AS (
  SELECT
    concat_ws('.', catalog_name, schema_name, table_name) AS table_name,
    max(end_time)                                        AS analysed_at,
    count(*)                                             AS analyse_operations
  FROM system.storage.predictive_optimization_operations_history
  WHERE start_time >= current_timestamp() - make_dt_interval(:lookback_days)
    AND operation_type = 'ANALYZE'
    -- A Databricks-owned catalog is not something a reader can ANALYZE, so a finding about one would be
    -- advice nobody can take. `33iga` measured none in the history, so this costs nothing today and is
    -- here because "measured none" is a reading of one metastore rather than a property of the field.
    AND {{customer_catalog catalog_name}}
  GROUP BY ALL
),
/*
 * The last write to each table, from lineage.
 *
 * `target_table_full_name` is already the three-part name, which is what makes this join a string comparison
 * rather than the three-column one `maintenance_recency.sql` needs — that statement extracts a name out of
 * statement text, where this one reads a column the platform assembled.
 *
 * Not restricted to the analysed set: a semi-join here would be a second scan of the same window, and
 * lineage's own aggregate over thirty days is one row per written table.
 */
written AS (
  SELECT
    target_table_full_name AS table_name,
    max(event_time)        AS written_at,
    count(*)               AS write_events
  FROM system.access.table_lineage
  WHERE event_time >= current_timestamp() - make_dt_interval(:lookback_days)
    AND target_table_full_name IS NOT NULL
  GROUP BY ALL
)
SELECT
  a.table_name,
  a.analysed_at,
  a.analyse_operations,
  -- Null where lineage saw no write in the window, which is a different statement from "not written": see
  -- the header. The rule reads the null as unknown rather than as fresh.
  w.written_at,
  w.write_events,
  -- Signed, and the sign is the reading. Positive means the table was written after its statistics were
  -- computed; negative means predictive optimization analysed it after the write, which is health.
  datediff(HOUR, a.analysed_at, w.written_at) AS hours_written_after_analyse
FROM analysed a
LEFT JOIN written w
  ON w.table_name = a.table_name
-- Stalest first, so the cap keeps the rows a rule fires on. Nulls last for the same reason: a table lineage
-- saw no write to is the least interesting row here, not the most.
ORDER BY hours_written_after_analyse DESC NULLS LAST, a.table_name
LIMIT :stats_limit
