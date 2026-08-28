-- Signal: sql:serving.classes
-- Rows: at most :serving_limit
-- Benchmark: coverage
--
-- The classification tags the platform has attached to each serving asset.
--
-- Its own statement rather than an eighth CTE in `serving_asset_facts`, because
-- `system.data_classification` is enabled per metastore by an account admin and is absent by default.
-- An absent schema fails a statement at parse time, so while this read shared a statement with the
-- other six dimensions it took all of them with it wherever the schema was off — including the
-- calibration estate, where the combined statement has never run. ADR 0088 records the choice.
--
-- Comma-joined rather than returned as an array, because the result arrives over the wire as text
-- either way and a joined list is one the reader parses with a split instead of a JSON parse that can
-- half-succeed. Class tags are identifiers, so none of them holds the separator.
--
-- No window. A classification is a property of the asset rather than an event in a period, and the
-- platform carries the current set — which is why this statement takes no `lookback_days` where the
-- quality read beside it does.
--
-- @param serving_assets  the population's qualified names, folded and comma-joined
-- @param serving_limit   the row ceiling
WITH declared AS (
  SELECT DISTINCT lower(trim(part)) AS qualified
  FROM (SELECT explode(split(:serving_assets, ',')) AS part)
  WHERE trim(part) <> ''
),
tagged AS (
  SELECT
    d.qualified,
    concat_ws(',', array_sort(collect_set(lower(c.class_tag)))) AS classifications
  FROM system.data_classification.results c
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', c.catalog_name, c.schema_name, c.table_name))
  GROUP BY ALL
)
-- Carried on every row for the reason the quality read carries its own: an asset missing from a result
-- cut at the ceiling reads as an asset with no classifications, and "no classifications" is a finding.
SELECT
  qualified,
  classifications,
  count(*) OVER () AS class_population
FROM tagged
ORDER BY qualified
LIMIT :serving_limit
