-- Signal: sql:cost.attribution
-- Rows: 1
-- Benchmark: billing
--
-- How much of the spend can be attributed to something, and how much cannot.
--
-- Cost attribution is deliberately measured in currency rather than in records.
-- A thousand untagged rows for a trivial job matter far less than one untagged
-- row for a warehouse running continuously, and a record count would rank them
-- the other way round.
--
-- Two kinds of tag are distinguished. `custom_tags` is what the customer set
-- deliberately; the identity columns under `usage_metadata` are populated by the
-- platform regardless. Only the first is evidence of a tagging practice, but the
-- second still allows attribution, so both are reported and the control decides.
--
-- Price join uses `usage_end_time` against the list-price interval — the Databricks
-- documented boundary. Q1a measured zero records on labs where start and end
-- disagreed; this statement still documents and tests the end-time rule rather than
-- treating that sample as proof the two are equivalent. Monetary sums include only
-- priced rows; unpriced record and quantity coverage travel beside them so a
-- resolver can decline a definitive share when the gap is material, and so every
-- ratio can state its coverage.
--
-- That coverage is per `usage_unit`, for the reason cost_compute_mix.sql gives at
-- length: DBUs, DSUs and GB all appear in this window and do not add, so one
-- pooled priced-share is a DBU share wearing a general name, and a unit the price
-- list covers not at all disappears into it. `duplicate_price_matches` is there
-- for the same reason — a usage row matching two list-price rows counts its cost
-- twice in every sum below — and measured zero on labs, over the same 48,186
-- usage rows. The two statements return the same coverage on that reading, which
-- is what they should: they read one window of one table through one price join.
--
-- Feeds: CO-03-01 (tagging for attribution), CO-03-03 (cost monitoring).
WITH joined AS (
  SELECT
    u.record_id,
    u.usage_unit,
    u.usage_quantity,
    u.custom_tags,
    u.usage_metadata,
    p.currency_code,
    p.pricing.effective_list.default                              AS rate
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.usage_end_time >= p.price_start_time
    AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
  WHERE u.usage_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR u.workspace_id = :workspace_id)
    -- Live workspaces only. Spend in a cancelled workspace was real, but tagging it is not
    -- something anyone can now do, so counting it as unattributed spend would report a
    -- failure with no available fix. The excluded workspaces are named on the finding.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), u.workspace_id))
),
/*
 * Per usage unit, and the row this returns is the aggregate of those few rows.
 * cost_compute_mix.sql explains the shape and what it measured: coverage has to
 * be per unit, a `min` over units cannot be taken in the flat aggregate that sums
 * the money, and doing it in scalar subqueries beside that aggregate walks the
 * price join three times instead of once.
 */
per_unit AS (
  SELECT
    usage_unit,
    sum(usage_quantity)                                           AS quantity,
    sum(CASE WHEN rate IS NOT NULL THEN usage_quantity ELSE 0 END) AS priced_quantity,
    sum(CASE WHEN rate IS NOT NULL THEN usage_quantity * rate ELSE 0 END) AS list_cost,
    sum(
      CASE WHEN rate IS NOT NULL
        AND size(COALESCE(map_keys(custom_tags), array())) > 0
        THEN usage_quantity * rate ELSE 0 END
    )                                                             AS custom_tagged_cost,
    sum(
      CASE WHEN rate IS NOT NULL
        AND (
          usage_metadata.job_id IS NOT NULL
          OR usage_metadata.cluster_id IS NOT NULL
          OR usage_metadata.warehouse_id IS NOT NULL
          OR usage_metadata.dlt_pipeline_id IS NOT NULL
          OR usage_metadata.endpoint_id IS NOT NULL
        )
        THEN usage_quantity * rate ELSE 0 END
    )                                                             AS identifiable_cost,
    count(DISTINCT record_id)                                     AS usage_records,
    count(*) - count(DISTINCT record_id)                          AS duplicate_price_matches,
    count(DISTINCT CASE WHEN rate IS NOT NULL THEN record_id END) AS priced_records,
    count(DISTINCT CASE WHEN rate IS NULL THEN record_id END)     AS unpriced_records,
    flatten(collect_set(map_keys(custom_tags)))                   AS tag_keys,
    collect_set(currency_code)                                    AS currencies
  FROM joined
  GROUP BY usage_unit
)
SELECT
  sum(usage_records)                                             AS usage_records,
  sum(duplicate_price_matches)                                   AS duplicate_price_matches,
  sum(priced_records)                                            AS priced_records,
  sum(unpriced_records)                                          AS unpriced_records,
  count(*)                                                       AS usage_unit_count,
  min_by(usage_unit, CASE WHEN quantity > 0 THEN priced_quantity / quantity ELSE 1 END) AS least_priced_unit,
  round(min(CASE WHEN quantity > 0 THEN priced_quantity / quantity ELSE 1 END), 6) AS least_priced_share,
  size(array_distinct(flatten(collect_list(currencies))))         AS currencies,
  round(sum(list_cost), 2)                                       AS list_cost,
  round(sum(custom_tagged_cost), 2)                              AS custom_tagged_cost,
  round(sum(identifiable_cost), 2)                               AS identifiable_cost,
  size(array_distinct(flatten(collect_list(tag_keys)))) > 0       AS any_custom_tags,
  array_join(array_sort(array_distinct(flatten(collect_list(tag_keys)))), ',') AS tag_keys,
  array_max(flatten(collect_list(currencies)))                   AS currency
FROM per_unit
