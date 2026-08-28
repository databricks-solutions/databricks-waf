-- Signal: sql:maintenance.recency
-- Rows: at most 40
-- Benchmark: inventory
--
-- One per Delta operation type × source. A fixed vocabulary the platform defines, not an estate
-- dimension, so 40 is generous headroom rather than a cap that could bite.
--
-- When OPTIMIZE, VACUUM and ANALYZE last ran, from both directions: what
-- predictive optimization did automatically, and what someone ran by hand on a table
-- in the assessed population.
--
-- Two sources because neither is sufficient alone. Predictive optimization's
-- operations history records what it actually performed, which is the only
-- evidence that enablement translated into work. Query history records manual
-- maintenance, and is the only evidence for tables predictive optimization does
-- not cover.
--
-- Manual commands credit a control only when the table they name is in the assessed
-- population. Leading whitespace and comments are stripped before the command match,
-- so `-- note\nOPTIMIZE a.b.c` is not invisible. A statement whose target cannot be
-- extracted (quoted identifiers, two-part names, trailing DRY RUN options before a
-- bare name) or that names a table outside the assessed catalogs is returned under
-- `manual_unresolved` rather than as credit — the resolver treats that as unknown,
-- not as evidence the estate was maintained.
--
-- Table identity is joined on the three name parts, not concatenated: a quoted name
-- containing a dot must not collide with a different three-part name.
--
-- Query history has two documented limits that make an absence here weak
-- evidence, and the controls treat it accordingly: it retains a bounded window,
-- and it records SQL warehouse and serverless activity but not commands run in
-- notebooks on classic compute. A VACUUM run nightly from a notebook on a job
-- cluster is invisible to this query.
--
-- Feeds: CO-03-06 (VACUUM), PE-04 (OPTIMIZE and statistics),
-- and the predictive-optimization applicability precondition.
WITH po AS (
  SELECT
    operation_type,
    count(*)                                     AS operations,
    max(end_time)                                AS last_run,
    count(DISTINCT catalog_name, schema_name, table_name) AS tables_touched
  FROM system.storage.predictive_optimization_operations_history
  WHERE start_time >= current_date() - make_dt_interval(:lookback_days)
  GROUP BY operation_type
),
-- Strip leading whitespace and leading line/block comments so the command prefix is the
-- first token. Spark's Java regex; non-greedy block comments so nested noise does not eat
-- the rest of the statement.
cleaned AS (
  SELECT
    end_time,
    executed_by,
    upper(
      regexp_replace(
        trim(statement_text),
        '(?s)^(?:\\s|--[^\\n]*\\n|/\\*.*?\\*/)+',
        ''
      )
    ) AS command
  FROM system.query.history
  WHERE start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND execution_status = 'FINISHED'
    AND statement_text IS NOT NULL
),
classified AS (
  SELECT
    end_time,
    executed_by,
    command,
    CASE
      WHEN command LIKE 'OPTIMIZE%' THEN 'OPTIMIZE'
      WHEN command LIKE 'VACUUM%'   THEN 'VACUUM'
      WHEN command LIKE 'ANALYZE %' THEN 'ANALYZE'
    END AS operation_type,
    -- Best-effort bare three-part name immediately after the command. Quoted identifiers,
    -- two-part names, and VACUUM options that precede a name all leave these null —
    -- unidentified rather than guessed.
    nullif(
      regexp_extract(
        command,
        '^(?:OPTIMIZE|VACUUM|ANALYZE[ ]+TABLE)[ ]+([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)',
        1
      ),
      ''
    ) AS catalog_name,
    nullif(
      regexp_extract(
        command,
        '^(?:OPTIMIZE|VACUUM|ANALYZE[ ]+TABLE)[ ]+([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)',
        2
      ),
      ''
    ) AS schema_name,
    nullif(
      regexp_extract(
        command,
        '^(?:OPTIMIZE|VACUUM|ANALYZE[ ]+TABLE)[ ]+([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)[.]([A-Z_][A-Z0-9_]*)',
        3
      ),
      ''
    ) AS table_name
  FROM cleaned
  WHERE command LIKE 'OPTIMIZE%'
     OR command LIKE 'VACUUM%'
     OR command LIKE 'ANALYZE %'
),
attributed AS (
  SELECT
    c.operation_type,
    c.end_time,
    c.executed_by,
    t.table_catalog IS NOT NULL AS in_population
  FROM classified c
  LEFT JOIN system.information_schema.tables t
    ON upper(t.table_catalog) = c.catalog_name
   AND upper(t.table_schema)  = c.schema_name
   AND upper(t.table_name)    = c.table_name
   AND {{customer_catalog t.table_catalog}}
),
manual AS (
  SELECT
    CASE WHEN in_population THEN 'manual' ELSE 'manual_unresolved' END AS source,
    operation_type,
    count(*)                        AS operations,
    max(end_time)                   AS last_run,
    count(DISTINCT executed_by)     AS distinct_actors
  FROM attributed
  WHERE operation_type IS NOT NULL
  GROUP BY 1, 2
)
SELECT
  'predictive_optimization' AS source,
  operation_type,
  operations,
  last_run,
  tables_touched,
  CAST(NULL AS BIGINT)      AS distinct_actors
FROM po
UNION ALL
SELECT
  source,
  operation_type,
  operations,
  last_run,
  CAST(NULL AS BIGINT),
  distinct_actors
FROM manual
ORDER BY source, operation_type
