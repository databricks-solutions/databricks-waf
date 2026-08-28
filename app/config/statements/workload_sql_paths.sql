-- Signal: sql:workload.sql_paths
-- Rows: 1
-- Benchmark: workload
--
-- Which route SQL took through the estate: what compute ran it, what sent it, and how much of what it
-- read came from cache. Three requirements were being put to a person on the strength of this reading
-- not existing, and the audit in docs/decisions/0071-*.md is what said so. Each of them asks about a
-- path the platform records on every statement.
--
-- ## Ours is excluded before anything is counted, not discounted afterwards
--
-- The scan reads `system.query.history`, so the scan is in it. On a labs workspace this app was 51.8%
-- of query time over twenty days, and `client_application` records it as `node` — which is to say an
-- assessment that counted itself would report the estate's busiest SQL client as a Node process nobody
-- in the customer's organisation has heard of, and would find its own statements running on a
-- warehouse and call that evidence of good practice.
--
-- Excluded in the `WHERE`, by the four marks `server/collect/sql/self.ts` holds: the query tag applied
-- at submit time, the comment prepended beside it, and the `-- Signal:` and `-- Rows:` header
-- conventions that make history written before those two recognisable. Not as a share subtracted from a
-- total afterwards — a percentage of ourselves is a number a reader has to reason about, and there is
-- nothing to reason about here. The advisor reports what the assessment costs, which is the one place
-- that figure belongs; an assessment of the customer's estate is not the place.
--
-- ## An all-purpose cluster is identified from the cluster, not from a name
--
-- `compute.type` distinguishes a warehouse from a cluster and this does not read further into it,
-- because the reading CO-01-03 needs is narrower than the column: an interactive cluster somebody
-- started to run a query is the finding, and a job cluster running the SQL inside a scheduled task is
-- not. So a statement carrying a `cluster_id` is joined to `system.compute.clusters` and classified by
-- `cluster_source` — `UI` or `API` is all-purpose, `JOB` is a job cluster — which is the same
-- definition `isAllPurpose` applies everywhere else in the app rather than a second one that could
-- drift from it.
--
-- `system.compute.clusters` keeps a row per definition change, so it is deduplicated to the latest row
-- per cluster before the join. Without that a cluster edited five times multiplies every statement that
-- ran on it by five, which would be a wrong number rather than a missing one.
--
-- A statement whose cluster is not in the table is counted as neither warehouse nor all-purpose and
-- reported in `unattributed_statements`. That happens for a cluster deleted long enough ago to have
-- aged out, and reporting it is what keeps the shares below from being read as covering everything.
--
-- ## Interactive means nobody scheduled it
--
-- CO-01-03 asks which path is easiest for a person who needs to run SQL, so the population is the
-- statements a person submitted: no job and no pipeline in `query_source`. A `MERGE` running on a job
-- cluster inside a nightly task says nothing about what is easy for a human, and counting it would let
-- a heavily orchestrated estate read as one where everybody starts clusters by hand.
--
-- ## Cache is weighted by bytes, and statements with nothing to cache are not in the denominator
--
-- `read_io_cache_percent` is a percentage per statement, so averaging it over statements gives a small
-- metadata query the same weight as a scan of a terabyte. It is weighted by `read_bytes` instead, which
-- makes the returned figure the share of bytes that came from cache rather than the mean of a column.
--
-- Statements that read no files are excluded from that denominator rather than counted as a cache miss.
-- On one workspace 3,621 of 5,885 statements read nothing at all — they were served from metadata or
-- from memory — and a miss rate computed over those describes the shape of the workload rather than the
-- effectiveness of the cache. The result cache is counted separately for the same reason: a statement
-- served from the result cache never reached the IO cache, so it is neither a hit nor a miss there.
--
-- ## The client list is names, capped, joined in SQL
--
-- IU-01-03 asks which tools are in the data path, and a list of names is the answer — so the distinct
-- `client_application` values come back joined by commas, in descending order of how much SQL each
-- sent. Capped at twenty, because the requirement is about the tools that carry the estate's work and
-- an estate with a hundred distinct clients has a long tail of one-offs. `unnamed_client_statements`
-- carries what arrived with no application recorded, which is not the same as none.
--
-- Feeds: CO-01-03 (SQL on warehouses rather than all-purpose clusters), IU-01-03 (integration
-- surface), PE-03-10 (deliberate caching).
WITH clusters AS (
  SELECT cluster_id, cluster_source
  FROM system.compute.clusters
  QUALIFY ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) = 1
),
history AS (
  SELECT
    h.client_application,
    h.read_bytes,
    h.read_files,
    h.read_io_cache_percent,
    h.from_result_cache,
    h.compute.type                                            AS compute_type,
    c.cluster_source,
    -- Nobody scheduled it. See the header: this is the population CO-01-03 is actually about.
    CASE
      WHEN h.query_source.job_info.job_id IS NULL AND h.query_source.pipeline_info.pipeline_id IS NULL
      THEN 1
      ELSE 0
    END                                                       AS is_interactive,
    -- Ours, by the same four marks the shapes and pressure statements use.
    -- `server/collect/sql/self.ts` holds the strings.
    CASE
      WHEN try_element_at(h.query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(h.statement_text), '-- databricks-waf: assessment')
        OR contains(h.statement_text, '-- Signal: sql:')
        OR contains(h.statement_text, '-- Rows: ')
      THEN 1
      ELSE 0
    END                                                       AS is_self
  FROM system.query.history h
  LEFT JOIN clusters c
    ON c.cluster_id = h.compute.cluster_id
  WHERE h.start_time >= current_timestamp() - make_dt_interval(:lookback_days)
    AND h.execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    AND (:workspace_id = '' OR h.workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), h.workspace_id))
),
/*
 * The estate's own work, which is all of the figures below.
 *
 * A flag computed above and filtered here, which is the shape the other two history statements use and
 * not a stylistic preference. Written as one `AND NOT (…)` in the `WHERE` above, this returned zero
 * statements of 6,969 on labs while the identical expression counted 3,773 of them as ours: a statement
 * without the tag gives NULL from `try_element_at`, so the chain is NULL wherever nothing else is true,
 * and `NOT NULL` keeps no row. A `CASE` sends that NULL to its `ELSE` and the row survives as
 * not-ours. Redacted text reaches the same trap by another route — `statement_text` is emptied under
 * customer-managed keys and `contains(NULL, …)` is NULL — so the flag form is what makes both safe.
 */
statements AS (
  SELECT * FROM history WHERE is_self = 0
),
clients AS (
  SELECT
    -- Joined with a comma below, so a comma inside a name would arrive as two names. Client
    -- applications are product names — `Databricks Catalog Explorer`, `Tableau Desktop` — and none
    -- carries one today, but the reader is shown these verbatim and a split name reads as a tool
    -- nobody uses.
    replace(client_application, ',', ' ') AS client_application,
    count(*)                              AS sent
  FROM statements
  WHERE client_application IS NOT NULL AND trim(client_application) <> ''
  GROUP BY 1
  ORDER BY sent DESC, 1
  LIMIT 20
),
/*
 * The thirteen figures over the estate's own statements, in a CTE rather than as the returned SELECT.
 *
 * That is what lets the two client-list figures below be read once. Written as two scalar subqueries in
 * the returned SELECT — `(SELECT count(*) FROM clients)` and `(SELECT array_join(…) FROM clients)` — each
 * one re-planned `clients` and everything under it, so `system.query.history` and `system.compute.clusters`
 * were each read three times from two `FROM`s: once here and once per subquery. Joining one row to one row
 * reads them twice: 7,779 ms against 9,630 ms on labs 2026-08-11, medians of four alternating readings a
 * side with the first of each dropped, `execution_duration_ms` 5,965 against 7,439, same rows and columns.
 *
 * `read_bytes` is unchanged at 28,505,960 both ways, so what this removed was the repeated aggregation
 * rather than repeated reading — the opposite balance from `estate_compute_profile`, where the bytes fell
 * by two thirds. A repeated scan does not have one cost.
 */
totals AS (
SELECT
  count(*)                                                                        AS statements,
  sum(CASE WHEN compute_type = 'WAREHOUSE' THEN 1 ELSE 0 END)                     AS warehouse_statements,
  sum(CASE WHEN cluster_source IN ('UI', 'API') THEN 1 ELSE 0 END)                AS all_purpose_statements,
  sum(CASE WHEN cluster_source = 'JOB' THEN 1 ELSE 0 END)                         AS job_cluster_statements,
  -- Neither a warehouse nor a cluster this metastore still records. See the header.
  sum(
    CASE WHEN compute_type <> 'WAREHOUSE' AND cluster_source IS NULL THEN 1 ELSE 0 END
  )                                                                               AS unattributed_statements,
  sum(is_interactive)                                                             AS interactive_statements,
  sum(CASE WHEN is_interactive = 1 AND compute_type = 'WAREHOUSE' THEN 1 ELSE 0 END) AS interactive_warehouse_statements,
  sum(
    CASE WHEN is_interactive = 1 AND cluster_source IN ('UI', 'API') THEN 1 ELSE 0 END
  )                                                                               AS interactive_all_purpose_statements,
  -- The cache figures. Bytes rather than statements, over the statements that read files at all.
  sum(CASE WHEN read_files > 0 THEN 1 ELSE 0 END)                                 AS file_reading_statements,
  sum(CASE WHEN read_files > 0 THEN read_bytes ELSE 0 END)                        AS file_read_bytes,
  round(
    sum(CASE WHEN read_files > 0 THEN read_bytes * COALESCE(read_io_cache_percent, 0) / 100.0 ELSE 0 END)
  )                                                                               AS cached_read_bytes,
  sum(CASE WHEN COALESCE(from_result_cache, false) THEN 1 ELSE 0 END)             AS result_cache_hits,
  sum(CASE WHEN client_application IS NULL OR trim(client_application) = '' THEN 1 ELSE 0 END) AS unnamed_client_statements
FROM statements
),
-- One row, from the twenty rows `clients` returns. Both figures come off the same pass over it.
client_list AS (
  SELECT
    count(*)                                          AS client_count,
    array_join(collect_list(client_application), ',') AS clients
  FROM clients
)
-- One row joined to one row, which is why this is a CROSS JOIN and not a correlated read.
--
-- It stays one row when the estate matches nothing. A CROSS JOIN eliminates the row if its right side is
-- empty, and `clients` is empty on an estate with no named client application — but `client_list`
-- aggregates it without a GROUP BY, and that returns one row over no rows. Measured against the previous
-- form on a window matching nothing: both return a single row, `client_count` 0 and `clients` empty, every
-- other column identical. The two forms are not interchangeable in general and are here.
SELECT
  t.statements,
  t.warehouse_statements,
  t.all_purpose_statements,
  t.job_cluster_statements,
  t.unattributed_statements,
  t.interactive_statements,
  t.interactive_warehouse_statements,
  t.interactive_all_purpose_statements,
  t.file_reading_statements,
  t.file_read_bytes,
  t.cached_read_bytes,
  t.result_cache_hits,
  t.unnamed_client_statements,
  c.client_count,
  c.clients
FROM totals t
CROSS JOIN client_list c
