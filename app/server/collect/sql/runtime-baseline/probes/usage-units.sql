-- Probe: every usage_unit value contributing to region selection and job-spend quantities (Q1a,
-- population e).
--
-- workspace_directory.sql weighs region membership by recent billing volume and serverless_job_spend.sql
-- sums usage_quantity per job, neither constraining usage_unit — Q1c's finding that raw quantities are
-- summed where the rows can carry different units. This names the vocabulary those sums are silently
-- mixing: every distinct unit in the window, how many records carry it, and how much quantity.
SELECT
  usage_unit,
  count(*)                      AS records,
  round(sum(usage_quantity), 2) AS quantity_total
FROM system.billing.usage
WHERE usage_date >= current_date() - make_dt_interval(:lookback_days)
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
  AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
GROUP BY usage_unit
ORDER BY quantity_total DESC
