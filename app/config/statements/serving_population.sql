-- Signal: sql:serving.population
-- Rows: at most :serving_limit
-- Benchmark: coverage
--
-- Which relations a serving declaration selects, and which part of the declaration selected each.
--
-- The population every dimension of the Genie and Unity Catalog readiness outcome is a share of.
-- `foundation/serving-asset.ts` decides membership; this finds the candidates it decides over, and the
-- division is deliberate — the rule that a name classifies nothing is the thing adversarial tests have
-- to be able to reach, and a rule expressed in SQL is a rule nobody can write a test against.
--
-- So this statement matches on two things and neither is a pattern. A relation is a candidate because
-- its qualified name is one of the names bound to :serving_names, or because a tag whose key is one of
-- the keys bound to :serving_tag_keys sits on it, on its schema or on its catalog. Values are not
-- filtered here: the value a tag carries decides membership and the module applies that, so a selector
-- accepting only `gold` still sees the `deprecated` rows and can say why it excluded them.
--
-- One row per relation *per matching tag*, rather than one per relation. Which tag put an asset in the
-- population is what the surface tells a reader, and the module picks the nearest of several — a tag
-- on the table over one on its schema over one on its catalog. Collapsing them here would make that
-- choice a property of whichever row the warehouse returned first.
--
-- Bounded by :serving_limit, and the bound matters more here than on a census: a tag on a catalog
-- declares every table under it to be served, so a single selector can name a hundred thousand
-- relations. `match_population` reports how many matched against how many came back, so a result that
-- stopped at the cap says so rather than presenting part of a population as the whole of one.
--
-- @param serving_names     the declared qualified names, folded and comma-joined, or '' for none
-- @param serving_tag_keys  the declared tag keys, folded and comma-joined, or '' for none
-- @param serving_limit     the row ceiling
WITH declared AS (
  SELECT DISTINCT lower(trim(part)) AS qualified
  FROM (SELECT explode(split(:serving_names, ',')) AS part)
  WHERE trim(part) <> ''
),
selectors AS (
  SELECT DISTINCT lower(trim(part)) AS tag_key
  FROM (SELECT explode(split(:serving_tag_keys, ',')) AS part)
  WHERE trim(part) <> ''
),
relations AS (
  SELECT
    lower(concat_ws('.', table_catalog, table_schema, table_name)) AS qualified,
    table_catalog,
    table_schema,
    table_name,
    comment AS table_comment,
    table_owner
  FROM system.information_schema.tables
  WHERE table_schema <> 'information_schema'
    AND {{customer_catalog table_catalog}}
),
matched AS (
  SELECT r.*, CAST(NULL AS STRING) AS tag_key, CAST(NULL AS STRING) AS tag_value, CAST(NULL AS STRING) AS tag_level
  FROM relations r
  JOIN declared d ON d.qualified = r.qualified

  UNION ALL

  SELECT r.*, lower(t.tag_name), t.tag_value, 'table'
  FROM relations r
  JOIN system.information_schema.table_tags t
    ON t.catalog_name = r.table_catalog
   AND t.schema_name = r.table_schema
   AND t.table_name = r.table_name
  JOIN selectors s ON s.tag_key = lower(t.tag_name)

  UNION ALL

  SELECT r.*, lower(t.tag_name), t.tag_value, 'schema'
  FROM relations r
  JOIN system.information_schema.schema_tags t
    ON t.catalog_name = r.table_catalog
   AND t.schema_name = r.table_schema
  JOIN selectors s ON s.tag_key = lower(t.tag_name)

  UNION ALL

  SELECT r.*, lower(t.tag_name), t.tag_value, 'catalog'
  FROM relations r
  JOIN system.information_schema.catalog_tags t
    ON t.catalog_name = r.table_catalog
  JOIN selectors s ON s.tag_key = lower(t.tag_name)
)
SELECT
  qualified,
  table_catalog,
  table_schema,
  table_name,
  table_comment,
  table_owner,
  tag_key,
  tag_value,
  tag_level,
  -- Evaluated before the LIMIT, so this is how many rows matched rather than how many came back.
  -- Without it a result of exactly :serving_limit rows is a complete answer and a truncated one at
  -- the same time, and the ambiguity resolves silently in favour of the wrong one.
  count(*) OVER () AS match_population
FROM matched
ORDER BY qualified, tag_level, tag_key, tag_value
LIMIT :serving_limit
