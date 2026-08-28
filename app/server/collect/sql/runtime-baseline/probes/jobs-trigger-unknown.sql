-- Probe: live jobs with unpopulated trigger/schedule fields (Q1a, population c).
--
-- jobs_inventory.sql's header documents that several columns are unpopulated for rows written before
-- early December 2025, so a job not edited since then has NULL for `trigger_type`, `paused`,
-- `timeout_seconds` and `health_rules`. Q1b's finding is that `scheduled` — derived as
-- `trigger.schedule.quartz_cron_expression IS NOT NULL` — is `false` rather than NULL in that case,
-- because the expression is false whether the struct was ever written or not, and the resolver then
-- calls the job manually triggered instead of unknown. This measures both directly, over the same
-- population jobs_inventory.sql returns: the latest live definition per job.
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) AS recency
  FROM system.lakeflow.jobs
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
latest AS (
  SELECT *
  FROM ranked
  WHERE recency = 1
    AND delete_time IS NULL
)
SELECT
  count(*)                                                              AS jobs,
  count(CASE WHEN trigger_type IS NULL THEN 1 END)                      AS trigger_type_unknown,
  count(CASE WHEN paused IS NULL THEN 1 END)                            AS paused_unknown,
  count(CASE WHEN timeout_seconds IS NULL THEN 1 END)                   AS timeout_unknown,
  count(CASE WHEN health_rules IS NULL THEN 1 END)                      AS health_rules_unknown,
  -- The struct `scheduled` is derived from. NULL here is what makes the derived column false rather
  -- than unknown, and is the population the header describes as unwritten before early December 2025.
  count(CASE WHEN trigger IS NULL THEN 1 END)                           AS trigger_struct_unknown,
  -- Of the jobs `scheduled` reads as false (no quartz expression), how many read false because the
  -- whole struct is unwritten (unknown, per the header) versus false because the struct is populated
  -- and genuinely carries no schedule.
  count(
    CASE WHEN trigger.schedule.quartz_cron_expression IS NULL AND trigger IS NULL THEN 1 END
  )                                                                     AS unscheduled_because_unknown,
  count(
    CASE WHEN trigger.schedule.quartz_cron_expression IS NULL AND trigger IS NOT NULL THEN 1 END
  )                                                                     AS unscheduled_and_populated
FROM latest
