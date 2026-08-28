-- Signal: sql:jobs.inventory
-- Rows: one per job
-- Benchmark: inventory
-- Slice: workspace_id, job_id
--
-- One row per live job, from the latest definition of each. `system.lakeflow.jobs` is slowly
-- changing — a job edited five times has five rows — so the window picks each job's most recent row
-- and the lifecycle filter is applied to the row the window chose, not before it.
--
-- That ordering is the correctness question here. `WHERE delete_time IS NULL` used to sit in the same
-- query as the window, which discards the one row where `delete_time` is set and lets an older row
-- showing the job alive win the ranking: 69,361 rows reported as live where 13,365 exist, five times
-- over. `server/collect/sql/history.ts` refuses that shape now. Filtering on `workspace_id` before the
-- window is safe and this does it, because it is a partition key — it removes whole partitions rather
-- than changing which row wins inside one.
--
-- The population is every live job, not every job that ran recently. This drove from
-- `system.billing.usage` over the review window for one commit, which is right for a spend question and
-- wrong for a configuration one: the controls below score a share of jobs, and the jobs they exist to
-- find are the ones nobody scheduled — precisely the jobs least likely to have billed. Measured on a
-- large account, 781 of 13,365 live jobs billed in thirty days, and over that subset OE-02-04 reads
-- 9.6% automated against 3.3% for the real population, REL-01-04 8.1% with timeouts against 5.1%. Both
-- inflate toward a pass. That form also returned 184 deleted jobs among 965 rows, because "a job that
-- billed existed" is not "a job that exists". Recency belongs on the spend and activity statements,
-- which take it from the fact table, and not on a population that answers what is configured.
--
-- So this grows with the estate's live job count, 13,365 on that account, and payload is H1d's problem —
-- solved by slicing on the axis declared above, which keeps every row rather than narrowing the
-- question. See bounds.ts, and H1 in docs/plan-status.md.
--
-- Several columns here are
-- documented as unpopulated for rows written before early December 2025, so a job not
-- edited since then has NULL for `paused`, `timeout_seconds`, `health_rules` and
-- `trigger_type`. That is reported as unknown rather than as absent: treating an
-- unwritten column as "no timeout configured" would fail long-standing jobs for
-- a change in the system table, not a change in the estate.
-- (https://docs.databricks.com/aws/en/admin/system-tables/jobs, which is also where the two readings of
-- a null `trigger_type` come from: "older job records or jobs where the trigger type was not
-- configured".)
--
-- `change_time` is projected for that reason and not only for the window: it is the one field that dates
-- a row against the rollout, so a null trigger on a row written since can be read as a job with no
-- trigger rather than as a column nobody wrote.
--
-- `has_stream_backlog_rule` checks each job's health rules for a `STREAMING_BACKLOG_*` metric
-- (bytes, records, seconds, or files) — PE-05-03's signal that someone is watching a streaming
-- job's backlog rather than only whether it is still running. It reads false both when the job
-- carries no such rule and when `health_rules` was never written; `health_rules_known` beside it
-- is what tells the two apart, the same split `health_rule_count` already relies on.
--
-- Feeds: CO-04-01 (streaming triggers), REL-01 (job health), OE-04 (monitoring), PE-05-03
-- (streaming backlog alerting).
-- Every definition, ranked. Only partition keys are filtered here: an empty `workspace_id` means the
-- scope could not be narrowed and the whole visible account is assessed, which the scan records and the
-- UI states rather than leaving implied.
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, job_id ORDER BY change_time DESC) AS recency
  FROM system.lakeflow.jobs
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
-- The lifecycle filter, on the row the window chose.
latest AS (
  SELECT *
  FROM ranked
  WHERE recency = 1
    AND delete_time IS NULL
)
SELECT
  workspace_id,
  job_id,
  name,
  run_as,
  trigger_type,
  trigger.continuous.enabled                              AS continuous,
  -- True only when a quartz expression is present. False when the job is genuinely unscheduled, when
  -- the trigger struct was never written (pre-December 2025 rows), and when the job has more than one
  -- trigger — the platform returns a null `trigger` and `trigger_type = 'MULTIPLE'` for that, keeping
  -- the set in a `triggers` array this statement does not read.
  trigger.schedule.quartz_cron_expression IS NOT NULL     AS scheduled,
  -- Whether the struct was there, which is all this says. It cannot carry the distinction it was added
  -- for on its own: a job nobody scheduled has no trigger struct either, so this is false for both, and
  -- reading it as "unwritten" dropped every manual job out of OE-02-04's denominator. `change_time`
  -- below is what separates them — a row written after the columns existed and still carrying no trigger
  -- is a job with no trigger — and `resolvers/helpers.ts` does that reading.
  trigger IS NOT NULL                                     AS scheduled_known,
  paused,
  timeout_seconds,
  size(COALESCE(health_rules, array()))                   AS health_rule_count,
  health_rules IS NOT NULL                                AS health_rules_known,
  EXISTS(COALESCE(health_rules, array()), rule -> rule.metric LIKE 'STREAMING_BACKLOG_%')
                                                           AS has_stream_backlog_rule,
  size(COALESCE(map_keys(tags), array()))                 AS tag_count,
  deployment.kind                                         AS deployment_kind,
  change_time
FROM latest
ORDER BY name
