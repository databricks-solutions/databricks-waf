-- Signal: sql:serverless.job_spend
-- Rows: one per job
-- Benchmark: inventory
-- Slice: workspace_id, job_id
--
-- Grouped per job and SKU family, so it grows with the estate and a little faster than the job
-- count. Paired with `serverless_job_readiness`, and the two should end up bounded together so a
-- job present in one is present in the other. See bounds.ts, and H1 in docs/plan-status.md.
--
-- What each job's classic compute cost in the window, and what a serverless DBU costs in
-- the same tier and region, so a migration estimate can be arithmetic on two observed
-- numbers rather than a rule of thumb.
--
-- Two things this deliberately does not do. It does not include the cloud bill: the EC2,
-- VM or GCE instances behind a classic cluster are charged by the cloud provider and
-- never appear in `system.billing.usage`, whereas a serverless DBU includes its
-- infrastructure. So the classic figure here is the Databricks half only, and every
-- comparison built on it understates what classic costs — which the analyzer states
-- rather than silently correcting for with a made-up multiplier.
--
-- And it does not convert DBUs between SKUs. A classic DBU and a serverless DBU are
-- different units of different things, and no published factor relates them. The
-- serverless rate is returned beside the classic quantity so the analyzer can apply one
-- stated assumption — that the same work takes the same DBU-hours — and name it as the
-- assumption it is.
--
-- The region the rate is read at comes from the workspace, not from the classic SKU,
-- because the classic SKU does not carry one. Verified against a real price list: the
-- serverless jobs SKUs are `{TIER}_JOBS_SERVERLESS_COMPUTE_{REGION}`, 16 regions per
-- tier, while classic jobs and all-purpose are plain `{TIER}_JOBS_COMPUTE` and
-- `{TIER}_ALL_PURPOSE_COMPUTE_(PHOTON)` with no region anywhere in the name. Matching a
-- region out of the classic name — which this statement did until it was run against the
-- table — extracts `(PHOTON)` or nothing, matches no serverless SKU, and silently returns
-- no rate for every job in the estate. That is the failure mode this comment exists to
-- prevent a future edit from reintroducing.
--
-- So the region is derived per workspace from the region-suffixed serverless SKUs the
-- workspace itself was billed on, whatever product they came from — serverless notebooks,
-- SQL warehouses, model serving, Lakebase. The vocabulary of valid regions is taken from
-- the price list's own serverless jobs SKUs rather than from a table authored here, so it
-- follows the platform when a region is added and cannot drift out of date. A workspace
-- with no serverless usage of any kind yields no region and therefore no rate, which the
-- analyzer reports as an absent estimate rather than a zero.
--
-- Feeds: the serverless readiness analyzer, behind CO-01-06, PE-02-01, REL-01-06 and
-- IU-03-02.
WITH serverless_rates AS (
  SELECT
    regexp_extract(sku_name, '^(ENTERPRISE|PREMIUM|STANDARD)_', 1)     AS tier,
    regexp_extract(sku_name, '_JOBS_SERVERLESS_COMPUTE_(.+)$', 1)      AS region,
    currency_code,
    -- The current price. A SKU with several open-ended rows would be a fault in the price
    -- list rather than a choice this statement should make, so the highest is taken: an
    -- estimate that reads high is a better error than one that reads cheap.
    max(pricing.effective_list.default)                                AS rate
  FROM system.billing.list_prices
  WHERE price_end_time IS NULL
    AND sku_name RLIKE '_JOBS_SERVERLESS_COMPUTE_'
  GROUP BY 1, 2, 3
),
-- Every region name the serverless jobs price list publishes. Used as the vocabulary a
-- workspace's region has to be one of, which is what keeps a suffix like
-- `_PROVISIONED_CAPACITY` — a real serverless SKU ending that is not a region — from
-- being read as a place.
published_regions AS (
  SELECT DISTINCT region FROM serverless_rates WHERE region <> ''
),
-- Aggregated before the region join, so that join is 16 rows against a few dozen rather
-- than against every usage record in the window.
serverless_usage AS (
  SELECT
    workspace_id,
    sku_name,
    sum(usage_quantity) AS dbus
  FROM system.billing.usage
  WHERE usage_date >= current_date() - make_dt_interval(:lookback_days)
    AND sku_name RLIKE 'SERVERLESS'
    AND usage_unit = 'DBU'
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  -- Named rather than `GROUP BY 1, 2`, because H1c executes this statement one workspace at a time and
  -- that is only exact if every grouping key includes workspace_id. A positional key is one a reader
  -- cannot check and slices.ts refuses for that reason.
  GROUP BY workspace_id, sku_name
),
workspace_region AS (
  SELECT workspace_id, region FROM (
    SELECT
      u.workspace_id,
      r.region,
      -- A workspace is in one region, so this picks a winner only where the same
      -- workspace shows two — which would mean a SKU was renamed mid-window. Most usage
      -- wins, then alphabetical, so the answer is deterministic either way.
      ROW_NUMBER() OVER (
        PARTITION BY u.workspace_id ORDER BY sum(u.dbus) DESC, r.region
      ) AS recency
    FROM serverless_usage u
    JOIN published_regions r ON endswith(u.sku_name, concat('_', r.region))
    GROUP BY u.workspace_id, r.region
  )
  WHERE recency = 1
),
priced AS (
  SELECT
    u.workspace_id,
    u.usage_metadata.job_id                                             AS job_id,
    u.sku_name,
    u.usage_quantity,
    -- Same expression as cost_compute_mix.sql / estate_compute_profile.sql.
    COALESCE(u.product_features.is_serverless, false)
      OR u.billing_origin_product IN (
        'MODEL_SERVING', 'LAKEBASE', 'APPS', 'VECTOR_SEARCH', 'AI_GATEWAY', 'GENIE',
        'AGENT_EVALUATION', 'DATA_CLASSIFICATION', 'LAKEHOUSE_MONITORING',
        'PREDICTIVE_OPTIMIZATION', 'SHARED_SERVERLESS_COMPUTE'
      )                                                                 AS is_serverless,
    CASE WHEN p.pricing.effective_list.default IS NOT NULL
      THEN u.usage_quantity * p.pricing.effective_list.default ELSE 0 END AS cost,
    p.currency_code,
    p.pricing.effective_list.default IS NOT NULL                        AS priced,
    -- The tier the SKU names, which classic SKUs do carry. Empty for a SKU in a shape
    -- this does not recognise, and an empty tier matches no serverless SKU, so the rate
    -- is then absent rather than taken from whichever tier sorted first.
    regexp_extract(u.sku_name, '^(ENTERPRISE|PREMIUM|STANDARD)_', 1)    AS tier
  FROM system.billing.usage u
  LEFT JOIN system.billing.list_prices p
    ON u.sku_name = p.sku_name
    AND u.usage_end_time >= p.price_start_time
    AND (p.price_end_time IS NULL OR u.usage_end_time < p.price_end_time)
  WHERE u.usage_date >= current_date() - make_dt_interval(:lookback_days)
    AND u.usage_metadata.job_id IS NOT NULL
    AND u.usage_unit = 'DBU'
    AND (:workspace_id = '' OR u.workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), u.workspace_id))
)
SELECT
  p.workspace_id,
  p.job_id,
  round(sum(p.cost), 2)                                                             AS cost,
  round(sum(CASE WHEN p.is_serverless THEN p.cost ELSE 0 END), 2)                   AS serverless_cost,
  round(sum(CASE WHEN NOT p.is_serverless THEN p.cost ELSE 0 END), 2)               AS classic_cost,
  round(sum(CASE WHEN NOT p.is_serverless THEN p.usage_quantity ELSE 0 END), 4)     AS classic_dbus,
  -- Usage rows the price list could not price. Without this a job billed on a SKU with no
  -- published rate would report a cost of zero, which reads as a job that costs nothing.
  sum(CASE WHEN p.priced THEN 0 ELSE 1 END)                                         AS unpriced_records,
  max(p.currency_code)                                                              AS currency,
  -- One rate per job: the classic SKUs a single job runs on share a tier, and where a job
  -- somehow spans two the higher rate is the conservative one to estimate with.
  max(r.rate)                                                                       AS serverless_rate,
  -- Which region's published rate was used, so the figure can be checked rather than
  -- taken on trust. Absent where the workspace's region could not be established.
  max(w.region)                                                                     AS serverless_region,
  concat_ws(',', slice(array_sort(array_distinct(collect_list(
    CASE WHEN NOT p.is_serverless THEN p.sku_name END
  ))), 1, 3))                                                                       AS classic_skus
FROM priced p
LEFT JOIN workspace_region w
  ON w.workspace_id = p.workspace_id
LEFT JOIN serverless_rates r
  ON r.tier = p.tier
  AND r.region = w.region
  AND r.currency_code = p.currency_code
GROUP BY p.workspace_id, p.job_id
HAVING sum(CASE WHEN NOT p.is_serverless THEN p.usage_quantity ELSE 0 END) > 0
   OR sum(p.cost) > 0
ORDER BY classic_cost DESC, p.job_id
