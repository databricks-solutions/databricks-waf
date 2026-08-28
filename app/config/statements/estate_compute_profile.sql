-- Signal: sql:estate.compute_profile
-- Rows: at most 100
-- Benchmark: billing
--
-- One per billing product and serverless flag. Both are platform vocabularies rather than estate
-- dimensions, so this stays put however large the customer is.
--
-- Estate compute composition over a trailing window.
--
-- This is the foundational applicability signal, not a scored control. Almost
-- every compute-related control depends on knowing what kind of compute the
-- customer actually runs: a control about cluster policies has no meaning in an
-- estate with no classic clusters, and scoring its absence as a failure is the
-- single most important bug this app must not have.
--
-- Serverless is identified the same way as `cost_compute_mix.sql`: the
-- `product_features.is_serverless` flag OR a closed list of serverless-only
-- products. The flag alone is false on MODEL_SERVING and LAKEBASE, which have no
-- classic form — measured understatement of $12,770 on a $16,190 bill. Quantity
-- is DBU-only: DSU and GB are not comparable to DBUs and must not enter
-- classicUsage / serverlessUsage.
--
-- The .obo.sql suffix runs this on behalf of the signed-in user, so the result
-- reflects what that user is permitted to see and nothing more.
--
-- The three distinct counts are taken over a grouped intermediate rather than over
-- `system.billing.usage` directly. Photon gives each `count(DISTINCT <expression>)` a scan
-- of its own, so three of them plus the plain aggregates read this table four times from one
-- `FROM`. Grouping first by the three identities whose distinct values are wanted, then
-- counting distinct values of the grouped result, is one scan: 3,369 ms against 5,545 ms on
-- labs 2026-08-11, medians of four alternating readings a side with the first of each
-- dropped, `execution_duration_ms` 2,055 against 4,570 and `read_bytes` 629,698 against
-- 1,841,186, same rows.
--
-- The unit is the expression, not the column: three distinct counts of the same column under
-- different CASE guards measured three scans, the same as three distinct counts of three
-- different columns. Guarding several counts onto one column does not merge them.
--
-- The inner group has to compute something the outer query consumes, and here it computes
-- four things. A pre-grouping whose aggregates go unused is eliminated by the optimiser and
-- the scans come back, and putting a join between the scan and the counts does not help
-- either — both measured, on constructed pairs, in docs/design/q1a-runtime-baseline.md.
-- `usage_records` and `total_usage_quantity` are what carry it, so removing either is not a
-- cosmetic change.
--
-- Nulls survive the extra grouping: `count(DISTINCT x)` skips a null `x` either way, and a
-- usage row with no `cluster_id` becomes a group of its own that the outer count then skips,
-- exactly as it was skipped before.
--
-- @param lookback_days INT
-- @param workspace_id STRING
-- @param live_workspace_ids STRING
WITH per_identity AS (
  SELECT
    billing_origin_product,
    (
      coalesce(product_features.is_serverless, false)
      OR billing_origin_product IN (
        'MODEL_SERVING', 'LAKEBASE', 'APPS', 'VECTOR_SEARCH', 'AI_GATEWAY', 'GENIE',
        'AGENT_EVALUATION', 'DATA_CLASSIFICATION', 'LAKEHOUSE_MONITORING',
        'PREDICTIVE_OPTIMIZATION', 'SHARED_SERVERLESS_COMPUTE'
      )
    ) AS is_serverless,
    usage_metadata.cluster_id   AS cluster_id,
    usage_metadata.warehouse_id AS warehouse_id,
    usage_metadata.job_id       AS job_id,
    count(*)                    AS usage_records,
    sum(usage_quantity)         AS total_usage_quantity,
    min(usage_date)             AS first_usage_date,
    max(usage_date)             AS last_usage_date
  FROM system.billing.usage
  WHERE usage_date >= current_date() - make_dt_interval(:lookback_days)
    AND usage_unit = 'DBU'
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    -- Live workspaces only. Empty means the directory could not be read, in which case the
    -- rows widen to include cancelled workspaces and the finding says so.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY
    billing_origin_product,
    (
      coalesce(product_features.is_serverless, false)
      OR billing_origin_product IN (
        'MODEL_SERVING', 'LAKEBASE', 'APPS', 'VECTOR_SEARCH', 'AI_GATEWAY', 'GENIE',
        'AGENT_EVALUATION', 'DATA_CLASSIFICATION', 'LAKEHOUSE_MONITORING',
        'PREDICTIVE_OPTIMIZATION', 'SHARED_SERVERLESS_COMPUTE'
      )
    ),
    usage_metadata.cluster_id,
    usage_metadata.warehouse_id,
    usage_metadata.job_id
)
SELECT
  billing_origin_product,
  is_serverless,
  sum(usage_records)           AS usage_records,
  count(DISTINCT cluster_id)   AS distinct_clusters,
  count(DISTINCT warehouse_id) AS distinct_warehouses,
  count(DISTINCT job_id)       AS distinct_jobs,
  sum(total_usage_quantity)    AS total_usage_quantity,
  min(first_usage_date)        AS first_usage_date,
  max(last_usage_date)         AS last_usage_date
FROM per_identity
GROUP BY
  billing_origin_product,
  is_serverless
ORDER BY
  total_usage_quantity DESC;
