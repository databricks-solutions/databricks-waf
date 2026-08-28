-- Probe: priced vs unpriced billing records and quantities, and price-boundary spanning (Q1a,
-- population d).
--
-- cost_attribution_coverage.sql and cost_compute_mix.sql left-join system.billing.list_prices and
-- coalesce a missing rate to zero, without returning how much usage had no matching price at all —
-- Q1c's finding. This measures that coverage directly: how many usage records and how much quantity
-- join to a price, using the same `usage_start_time` boundary the shipped statements use, and how many
-- records would join to a *different* price (or to none) if `usage_end_time` were used instead — the
-- boundary Q1c must settle between the shipped join and the one Databricks' own documented example
-- uses.
--
-- Two separate joins onto system.billing.usage in one pass, rather than two independent queries
-- compared afterwards, so both readings are counted from the same row set.
--
-- This comment used to end by asserting that each join, being an equality-plus-range condition per
-- usage row, produces at most one matching price row and so cannot duplicate a usage record. Nothing
-- in the join makes that true: two list-price rows for one SKU and interval — the same rate quoted in
-- two currencies would do it — match one usage row twice, and `usage_records` here is `count(*)`, so
-- the claim was load-bearing for every number this probe returns. It happens to hold on this price
-- list: 43,140 usage rows counted through both joins against 43,140 counted by the usage_units probe
-- with no join at all. That is a measurement of the price list, and the shipped statements now return
-- `duplicate_price_matches` so neither of them has to take it on trust.
SELECT
  count(*)                                                                                AS usage_records,
  round(sum(u.usage_quantity), 2)                                                         AS usage_quantity_total,
  count(CASE WHEN sp.pricing.effective_list.default IS NULL THEN 1 END)                    AS unpriced_by_start_time,
  round(
    sum(CASE WHEN sp.pricing.effective_list.default IS NULL THEN u.usage_quantity ELSE 0 END), 2
  )                                                                                        AS unpriced_quantity_by_start_time,
  count(CASE WHEN ep.pricing.effective_list.default IS NULL THEN 1 END)                    AS unpriced_by_end_time,
  round(
    sum(CASE WHEN ep.pricing.effective_list.default IS NULL THEN u.usage_quantity ELSE 0 END), 2
  )                                                                                        AS unpriced_quantity_by_end_time,
  -- Records where the two boundaries disagree about the price at all: this is the population that
  -- spans a price change between usage_start_time and usage_end_time, which is what makes the choice
  -- between them a real question rather than a cosmetic one.
  count(
    CASE WHEN sp.pricing.effective_list.default IS DISTINCT FROM ep.pricing.effective_list.default THEN 1 END
  )                                                                                        AS boundary_spanning_records
FROM system.billing.usage u
LEFT JOIN system.billing.list_prices sp
  ON u.sku_name = sp.sku_name
  AND u.usage_start_time >= sp.price_start_time
  AND (sp.price_end_time IS NULL OR u.usage_start_time < sp.price_end_time)
LEFT JOIN system.billing.list_prices ep
  ON u.sku_name = ep.sku_name
  AND u.usage_end_time >= ep.price_start_time
  AND (ep.price_end_time IS NULL OR u.usage_end_time < ep.price_end_time)
WHERE u.usage_date >= current_date() - make_dt_interval(:lookback_days)
  AND (:workspace_id = '' OR u.workspace_id = :workspace_id)
  AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), u.workspace_id))
