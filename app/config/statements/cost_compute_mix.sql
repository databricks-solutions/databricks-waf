-- Signal: sql:cost.compute_mix
-- Rows: 1
-- Benchmark: billing
--
-- Where the money goes, split by the choices the cost pillar asks about:
-- serverless or classic, Photon or not, job compute or all-purpose.
--
-- Cost rather than DBUs, because DBUs are not comparable across SKUs — a
-- serverless DBU and an all-purpose DBU buy different things at different prices,
-- so a DBU-weighted split would misstate every share it reported.
--
-- Photon is read from the SKU name because nothing else records it: a cluster
-- configured with Photon that never ran costs nothing and should not count as
-- adoption, so the billed SKU is the only honest source.
--
-- All-purpose is read from `billing_origin_product` and NOT from the SKU name,
-- which is the correction of a measured defect. Serverless all-purpose compute
-- bills as `ENTERPRISE_ALL_PURPOSE_SERVERLESS_COMPUTE_<region>`, so a name match
-- on '%ALL_PURPOSE%' booked $3,157 of serverless Databricks Apps spend as
-- all-purpose on the workspace this was measured against. It produced no wrong
-- finding only because none of it carried a job id, which is luck rather than
-- design: a serverless notebook run by a job would have read as the exact waste
-- CO-01-02 exists to find.
--
-- Price join uses `usage_end_time` (documented list-price boundary). Monetary
-- sums are priced rows only; unpriced coverage columns sit beside them so a
-- resolver can refuse a definitive share when the gap is material.
--
-- Coverage is returned per `usage_unit` and not as one ratio, because quantities
-- in different units do not add. Measured on labs over 30 days (2026-08-09):
-- 140,149.74 DBU, 56.65 DSU and 21.91 GB. A pooled priced-share is therefore a
-- DBU share whatever it is called, and a GB population the price list covered not
-- at all would have moved it by 0.016% while being every GB there was — under the
-- 1% the resolver treats as material. `least_priced_unit` and
-- `least_priced_share` are the unit the price list covers worst and how well it
-- covers it, which is the figure that gate has to see. On the same reading the
-- worst-covered unit is DBU at 99.9973%, so this changes no verdict on labs; it
-- changes which estates can hide one.
--
-- Cost sums across units are sound, because they are money either way, and that
-- is the whole reason this statement is denominated in cost.
--
-- `duplicate_price_matches` is how many extra rows the price join produced, and
-- it exists because the alternative was a comment claiming it produces none. One
-- usage row matching two list-price rows — the same SKU and interval quoted in
-- two currencies would do it — double-counts that row's cost in every sum here
-- with nothing to say so. Measured zero on labs, over 48,186 usage rows, by this
-- column; the Q1a price-coverage probe reads the same zero a second way, 43,140
-- rows in and 43,140 out against the window counted with no price join at all.
-- Both are facts about that price list rather than about the join.
--
-- Feeds: CO-01-02 (job compute), CO-01-06 (serverless), CO-01-10 (Photon),
-- CO-03-03 (cost monitoring), PE-02-08 (Photon for performance).
WITH priced AS (
  SELECT
    u.record_id,
    u.usage_unit,
    u.sku_name,
    u.billing_origin_product,
    /*
     * Serverless, by the product and not only by the flag.
     *
     * `product_features.is_serverless` is false on serverless-only products —
     * measured on a real workspace, MODEL_SERVING and LAKEBASE both report false
     * while having no classic form to choose instead. Trusting the flag alone
     * understated serverless spend by $12,770 of a $16,190 bill.
     *
     * Keep this expression identical in estate_compute_profile.sql and
     * serverless_job_spend.sql — a vocabulary fixture fails when they diverge.
     */
    COALESCE(u.product_features.is_serverless, false)
      OR u.billing_origin_product IN (
        'MODEL_SERVING', 'LAKEBASE', 'APPS', 'VECTOR_SEARCH', 'AI_GATEWAY', 'GENIE',
        'AGENT_EVALUATION', 'DATA_CLASSIFICATION', 'LAKEHOUSE_MONITORING',
        'PREDICTIVE_OPTIMIZATION', 'SHARED_SERVERLESS_COMPUTE'
      )                                                                     AS is_serverless,
    /*
     * Where serverless is a choice somebody makes, which is the only spend an
     * adoption share may be measured over.
     *
     * These five products have both forms: classic job clusters or serverless
     * jobs, all-purpose clusters or serverless notebooks, pro warehouses or
     * serverless SQL, classic or serverless pipelines. Everything else in
     * `billing_origin_product` is either serverless-only — there is no classic
     * model serving to migrate from — or not compute at all, and both belong
     * outside the denominator rather than inside it as spend nobody can move.
     *
     * The same five are Photon-eligible, and for the same underlying reason:
     * these are the products where the customer configures the engine. They are
     * written twice because the two questions could diverge — a product could
     * gain a serverless form without gaining a Photon setting — and a single
     * list would then be silently wrong for one of them.
     */
    u.billing_origin_product IN ('JOBS', 'ALL_PURPOSE', 'INTERACTIVE', 'SQL', 'DLT') AS serverless_is_a_choice,
    upper(u.sku_name) LIKE '%PHOTON%'                                       AS is_photon,
    u.billing_origin_product = 'ALL_PURPOSE'
      AND NOT COALESCE(u.product_features.is_serverless, false)             AS is_all_purpose,
    u.usage_metadata.job_id IS NOT NULL                                     AS attributed_to_job,
    p.pricing.effective_list.default IS NOT NULL                            AS priced,
    u.usage_quantity,
    CASE WHEN p.pricing.effective_list.default IS NOT NULL
      THEN u.usage_quantity * p.pricing.effective_list.default ELSE 0 END   AS cost,
    p.currency_code
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.usage_end_time >= p.price_start_time
    AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
  WHERE u.usage_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR u.workspace_id = :workspace_id)
    -- Live workspaces only, so the compute mix describes the estate as it now stands.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), u.workspace_id))
),
/*
 * Everything per usage unit, and the row this statement returns is the aggregate
 * of these few rows.
 *
 * Two levels rather than one, because coverage has to be per unit and a `min`
 * over units cannot be taken in the same flat aggregate that sums the money. The
 * first shape of this read the units in two scalar subqueries beside the flat
 * aggregate, which measured 8.3-9.3s against 5.0-5.8s for the statement it
 * replaced (three interleaved runs each, labs, 2026-08-09) — the join was being
 * walked three times. This walks it once and aggregates a handful of unit rows.
 *
 * Every column below is either additive across units, or a set union. A usage
 * record carries exactly one unit, so summing per-unit record counts is the same
 * count; a SKU or a currency could appear under two units, so those two collect
 * and are counted distinct at the top.
 */
per_unit AS (
  SELECT
    usage_unit,
    sum(usage_quantity)                                                     AS quantity,
    sum(CASE WHEN priced THEN usage_quantity ELSE 0 END)                    AS priced_quantity,
    sum(cost)                                                               AS cost,
    sum(CASE WHEN is_serverless THEN cost ELSE 0 END)                       AS serverless_cost,
    sum(CASE WHEN serverless_is_a_choice THEN cost ELSE 0 END)              AS choice_cost,
    sum(CASE WHEN serverless_is_a_choice AND is_serverless THEN cost ELSE 0 END) AS serverless_choice_cost,
    sum(CASE WHEN is_photon THEN cost ELSE 0 END)                           AS photon_cost,
    sum(CASE WHEN billing_origin_product IN ('JOBS', 'ALL_PURPOSE', 'SQL', 'INTERACTIVE', 'DLT') THEN cost ELSE 0 END) AS photon_eligible_cost,
    sum(CASE WHEN is_all_purpose THEN cost ELSE 0 END)                      AS all_purpose_cost,
    sum(CASE WHEN is_all_purpose AND attributed_to_job THEN cost ELSE 0 END) AS jobs_on_all_purpose_cost,
    collect_set(sku_name)                                                   AS skus,
    collect_set(currency_code)                                              AS currencies,
    count(DISTINCT record_id)                                               AS usage_records,
    count(*) - count(DISTINCT record_id)                                    AS duplicate_price_matches,
    count(DISTINCT CASE WHEN priced THEN record_id END)                     AS priced_records,
    count(DISTINCT CASE WHEN NOT priced THEN record_id END)                 AS unpriced_records
  FROM priced
  GROUP BY usage_unit
)
SELECT
  round(sum(cost), 2)                                                       AS total_cost,
  round(sum(serverless_cost), 2)                                            AS serverless_cost,
  -- The denominator for serverless adoption, and the numerator within it. Both
  -- restricted to the five products, so the share answers "of the compute you
  -- choose the form of, how much is serverless" rather than "what fraction of
  -- the bill happens to be serverless".
  round(sum(choice_cost), 2)                                                AS choice_cost,
  round(sum(serverless_choice_cost), 2)                                     AS serverless_choice_cost,
  round(sum(photon_cost), 2)                                                AS photon_cost,
  -- The denominator for Photon is the compute that could have used it. Storage,
  -- serving and marketplace lines have no Photon option, so including them would
  -- cap the achievable share below 100% and make full adoption look partial.
  round(sum(photon_eligible_cost), 2)                                       AS photon_eligible_cost,
  round(sum(all_purpose_cost), 2)                                           AS all_purpose_cost,
  round(sum(jobs_on_all_purpose_cost), 2)                                   AS jobs_on_all_purpose_cost,
  size(array_distinct(flatten(collect_list(skus))))                         AS distinct_skus,
  -- Usage rows, not joined rows, so a duplicated price match cannot inflate the
  -- population these counts describe. The duplication itself is the column below.
  sum(usage_records)                                                        AS usage_records,
  sum(duplicate_price_matches)                                              AS duplicate_price_matches,
  sum(priced_records)                                                       AS priced_records,
  sum(unpriced_records)                                                     AS unpriced_records,
  count(*)                                                                  AS usage_unit_count,
  -- The unit the price list covers worst, and how well it covers it. A unit with
  -- no quantity counts as covered: there is nothing in it to be missing.
  min_by(usage_unit, CASE WHEN quantity > 0 THEN priced_quantity / quantity ELSE 1 END) AS least_priced_unit,
  round(min(CASE WHEN quantity > 0 THEN priced_quantity / quantity ELSE 1 END), 6) AS least_priced_share,
  -- More than one currency and every total above adds unlike amounts, which no
  -- label on the figure can repair.
  size(array_distinct(flatten(collect_list(currencies))))                   AS currencies,
  array_max(flatten(collect_list(currencies)))                              AS currency
FROM per_unit
