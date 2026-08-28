-- Probe: manual maintenance attributable to the assessed population vs unrelated (Q1a, population b).
--
-- maintenance_recency.sql classifies manual OPTIMIZE/VACUUM/ANALYZE statements by operation_type and
-- counts them; it never asks whether the table each one names is part of the assessed estate. Q1b's
-- finding is that a manual command cannot satisfy a control until that is established. This measures
-- the population maintenance_recency.sql already counts, split three ways: statements with no
-- extractable three-part table name at all, statements naming a table this metastore's
-- information_schema does not know about (or that belongs to a Databricks-owned catalog), and
-- statements naming a table actually in the assessed population.
--
-- The extraction is a best-effort regular expression over a bare three-part identifier immediately
-- after the command — the same shape maintenance_recency.sql's own header says query history cannot
-- resolve further. A quoted identifier, a two-part name relying on a default catalog, or a `VACUUM`
-- with `DRY RUN`/`RETAIN ... HOURS` trailing the name all read as unidentified rather than guessed.
WITH manual AS (
  SELECT
    statement_text,
    CASE
      WHEN upper(statement_text) LIKE 'OPTIMIZE%' THEN 'OPTIMIZE'
      WHEN upper(statement_text) LIKE 'VACUUM%'   THEN 'VACUUM'
      ELSE 'ANALYZE'
    END AS operation_type,
    regexp_extract(
      trim(statement_text),
      '^(?:OPTIMIZE|VACUUM|ANALYZE[ ]+TABLE)[ ]+([A-Za-z_][A-Za-z0-9_]*[.][A-Za-z_][A-Za-z0-9_]*[.][A-Za-z_][A-Za-z0-9_]*)',
      1
    ) AS identified_table
  FROM system.query.history
  WHERE start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND execution_status = 'FINISHED'
    AND (
      upper(statement_text) LIKE 'OPTIMIZE%'
      OR upper(statement_text) LIKE 'VACUUM%'
      OR upper(statement_text) LIKE 'ANALYZE %'
    )
),
attributable AS (
  SELECT
    m.operation_type,
    m.identified_table,
    t.table_catalog IS NOT NULL AS in_population
  FROM manual m
  LEFT JOIN system.information_schema.tables t
    ON m.identified_table = concat_ws('.', t.table_catalog, t.table_schema, t.table_name)
    AND (
      t.table_catalog NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = 'System user')
      AND lower(t.table_catalog) NOT IN ('system', 'samples', '__databricks_internal')
    )
)
SELECT
  operation_type,
  count(*)                                                                      AS statements,
  count(CASE WHEN identified_table IS NULL THEN 1 END)                          AS no_table_identified,
  count(CASE WHEN identified_table IS NOT NULL AND NOT in_population THEN 1 END) AS identified_not_in_population,
  count(CASE WHEN in_population THEN 1 END)                                     AS attributable_to_population
FROM attributable
GROUP BY operation_type
ORDER BY operation_type
