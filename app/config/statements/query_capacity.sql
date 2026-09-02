-- Signal: sql:query.capacity
-- Rows: 1
-- Benchmark: coverage
--
-- How many statements hit a capacity limit in the window, and how long they waited.
--
-- `system.query.history` records `waiting_at_capacity_duration_ms` for each statement. A
-- positive value means the statement was delayed because the warehouse or serverless pool
-- hit a quota or service limit. Zero (or null) means no capacity constraint delayed it.
--
-- ## What this can and cannot say
--
-- This is a one-way measurement. Statements with positive waiting time prove that a
-- capacity limit was reached during the window. Zero waiting-at-capacity statements prove
-- that limits did not bite in the window — not that proactive monitoring exists or that
-- headroom is known. The resolver caps its best possible verdict at `partial` for that
-- reason: the absence of a signal is not evidence of good management, only of a quiet
-- period.
--
-- Account-level quotas — the figure that says how far from a limit you are before it
-- bites — live on the account plane and have no workspace view. So even this one-way
-- measurement is incomplete: a workspace can hit a limit it never monitored.
--
-- ## Filters and scope
--
-- Filtered to the live workspace set, so a cancelled workspace that still has history
-- does not inflate the count. The lookback is capped at 30 days — the same guard the
-- mlflow statement uses — because `system.query.history` can be large and a longer
-- window does not change the interpretation: any capacity event is a finding regardless
-- of when in the window it occurred.
--
-- @param lookback_days      the window (capped at 30 in the WHERE clause)
-- @param workspace_id       one workspace, or '' for all live workspaces
-- @param live_workspace_ids the live workspaces, comma-joined, or '' for no filter
--
-- Feeds: OE-03-01.
SELECT
  COUNT(*) AS total_statements,
  COUNT(CASE WHEN waiting_at_capacity_duration_ms > 0 THEN 1 END) AS waiting_at_capacity,
  COALESCE(SUM(waiting_at_capacity_duration_ms), 0) AS total_wait_ms
FROM system.query.history
WHERE start_time >= current_timestamp() - make_dt_interval(least(:lookback_days, 30))
  AND (:workspace_id = '' OR workspace_id = :workspace_id)
  AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
