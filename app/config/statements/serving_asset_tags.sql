-- Signal: sql:serving.tags
-- Rows: at most :serving_limit
-- Benchmark: census
--
-- Every tag on the relations a serving declaration selected, whatever key it carries.
--
-- A second read of the tag relations rather than a reuse of the first, and the two ask different
-- questions. `serving_population.sql` reads the keys the declaration *selects on*, to find out which
-- relations are served. This reads all of them on the relations that turned out to be served, because
-- the metadata half of a declaration requires keys it does not select on — `certification = gold` puts
-- an asset in the population and `owner_team` is what it then owes.
--
-- Table level only. A tag on a catalog can declare a table served, which is a claim about the table;
-- it is not the table carrying the key, which is what the requirement asks. Reading the inherited ones
-- as carried would report an estate that tagged one catalog as an estate that tagged every table in it.
--
-- Bounded by :serving_limit over tags rather than over assets, so a population well inside its own cap
-- can still truncate here. `tag_population` says when it did, and a truncated read is reported as tags
-- unread rather than as an asset that carries none: a missing required key is a finding, and inferring
-- one from a row that never arrived is the failure this whole family is about.
--
-- @param serving_assets  the population's qualified names, folded and comma-joined
-- @param serving_limit   the row ceiling
WITH declared AS (
  SELECT DISTINCT lower(trim(part)) AS qualified
  FROM (SELECT explode(split(:serving_assets, ',')) AS part)
  WHERE trim(part) <> ''
)
SELECT
  d.qualified,
  lower(t.tag_name) AS tag_key,
  t.tag_value,
  count(*) OVER () AS tag_population
FROM system.information_schema.table_tags t
JOIN declared d
  ON d.qualified = lower(concat_ws('.', t.catalog_name, t.schema_name, t.table_name))
ORDER BY d.qualified, tag_key, t.tag_value
LIMIT :serving_limit
