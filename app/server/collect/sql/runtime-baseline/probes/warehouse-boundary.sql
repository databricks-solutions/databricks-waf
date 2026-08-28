-- Probe: warehouses already running at the lookback boundary (Q1a, population f).
--
-- workload_warehouse_pressure.sql seeds its timeline from the last event before the window, and this is
-- the population that seed exists for: warehouses with a cluster running in the instant before the
-- window opens, and of those, the ones with no event at all inside it — which reported no uptime whatever
-- before the seed, on a page that divides execution time by it.
--
-- ## The boundary here is the statement's boundary, which it was not
--
-- This measured at `current_date() - make_dt_interval(:lookback_days)` while the statement measures at
-- `date_sub(current_date(), least(:lookback_days, 7) - 1)`. Those are different instants — a rolling
-- interval against a date boundary, and 30 days against a hard cap of 7 — so the probe was describing a
-- window this statement never opens, and reporting a real number about it. Now the same expression, so a
-- reading of zero here is a reading about the statement rather than about a boundary three weeks earlier.
--
-- ## And it reads back as far as the table goes, which is what makes it an apparatus
--
-- A thirty-day floor was briefly here as well, matching the one the seed carried. That made the probe
-- unable to see the population that bound excluded, and a probe narrowed to the implementation measures
-- the implementation. The three columns after the first are what a floor would have cost, so a later
-- estate can see it rather than infer it: on labs, over the live workspaces this is scoped to, no
-- warehouse's last event was beyond thirty days and the oldest was 26 days before the boundary. Over the
-- whole account — which this does not read, and which is the difference worth knowing about — 52 of 58
-- were beyond it, every one of them stopped.
WITH before AS (
  SELECT
    workspace_id,
    warehouse_id,
    cluster_count,
    event_time,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, warehouse_id
      ORDER BY event_time DESC, cluster_count ASC
    ) AS recency
  FROM system.compute.warehouse_events
  WHERE event_time < date_sub(current_date(), least(:lookback_days, 7) - 1)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
latest AS (
  SELECT workspace_id, warehouse_id, cluster_count, event_time
  FROM before
  WHERE recency = 1
),
in_window AS (
  SELECT DISTINCT workspace_id, warehouse_id
  FROM system.compute.warehouse_events
  WHERE event_time >= date_sub(current_date(), least(:lookback_days, 7) - 1)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
)
SELECT
  count(CASE WHEN l.cluster_count > 0 THEN 1 END)                          AS running_at_boundary,
  count(CASE WHEN l.cluster_count > 0 AND iw.warehouse_id IS NOT NULL THEN 1 END)
                                                                           AS running_at_boundary_with_in_window_event,
  count(CASE WHEN l.cluster_count > 0 AND iw.warehouse_id IS NULL THEN 1 END)
                                                                           AS running_at_boundary_with_no_in_window_event,
  -- What a floor on the seed would have cost. The first is the population it exists for and would have
  -- dropped; the second is the rest, which is why a floor can read as harmless on an estate like this one.
  count(
    CASE
      WHEN l.cluster_count > 0
        AND l.event_time < date_sub(current_date(), least(:lookback_days, 7) - 1 + 30)
      THEN 1
    END
  )                                                                        AS running_beyond_thirty_days,
  count(
    CASE
      WHEN l.cluster_count = 0
        AND l.event_time < date_sub(current_date(), least(:lookback_days, 7) - 1 + 30)
      THEN 1
    END
  )                                                                        AS stopped_beyond_thirty_days,
  -- How far back the seed had to read to find the oldest of these, in days before the boundary.
  max(datediff(date_sub(current_date(), least(:lookback_days, 7) - 1), date(l.event_time)))
                                                                           AS last_event_days
FROM latest l
LEFT JOIN in_window iw
  ON iw.workspace_id = l.workspace_id AND iw.warehouse_id = l.warehouse_id
