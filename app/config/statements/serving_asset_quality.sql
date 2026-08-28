-- Signal: sql:serving.quality
-- Rows: at most :serving_limit
-- Benchmark: coverage
--
-- The latest quality status the platform recorded for each serving asset, inside the window.
--
-- Its own statement rather than a seventh CTE in `serving_asset_facts`, because
-- `system.data_quality_monitoring` is enabled per metastore by an account admin and is absent by
-- default. An absent schema fails a statement at parse time, so while this read shared a statement
-- with the other six dimensions it took all of them with it wherever the schema was off — including
-- the calibration estate, where the combined statement has never run. ADR 0088 records the choice.
--
-- No judgement about the status. The platform writes four of them and this app has not measured what
-- any one means, so the status is carried through as text and the dimension counts whether one was
-- recorded, not whether it was a good one. That is unchanged by the split and is the reason this
-- returns the status rather than a boolean.
--
-- `max_by` over the window rather than a count: the dimension asks whether the platform has said
-- anything lately about this asset, and the most recent thing it said is the answer to that.
--
-- @param serving_assets  the population's qualified names, folded and comma-joined
-- @param serving_limit   the row ceiling
-- @param lookback_days   how far back quality results are read
WITH declared AS (
  SELECT DISTINCT lower(trim(part)) AS qualified
  FROM (SELECT explode(split(:serving_assets, ',')) AS part)
  WHERE trim(part) <> ''
),
latest AS (
  SELECT
    d.qualified,
    max_by(q.status, q.event_time) AS quality_status
  FROM system.data_quality_monitoring.table_results q
  JOIN declared d
    ON d.qualified = lower(concat_ws('.', q.catalog_name, q.schema_name, q.table_name))
  WHERE q.event_time >= current_timestamp() - make_dt_interval(:lookback_days)
  GROUP BY ALL
)
-- The population is carried on every row so the reader can tell a short answer from a complete one.
-- It matters here for the same reason it matters on the tag read: an asset missing from this result is
-- indistinguishable from an asset the platform has recorded no status for, and the reading that
-- follows from no status is that the dimension is unmet. So a result cut at the ceiling would report
-- assets as failing on the strength of rows that never arrived. Grouped first and counted after,
-- because the count wanted is of assets with a status, not of the result rows behind them.
SELECT
  qualified,
  quality_status,
  count(*) OVER () AS quality_population
FROM latest
ORDER BY qualified
LIMIT :serving_limit
