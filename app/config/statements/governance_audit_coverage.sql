-- Signal: sql:governance.audit_coverage
-- Rows: 1
-- Benchmark: coverage
--
-- Whether audit events are actually arriving, how recently, and across how many
-- services.
--
-- The system audit table exists whether or not anything is being recorded, so
-- presence of the table proves nothing. Recency is the useful measure: an estate
-- with no audit event in a week either has no activity or has lost its audit
-- trail, and both are worth surfacing.
--
-- The three distinct counts are taken over a grouped intermediate rather than over
-- `system.access.audit` directly, because Photon gives each `count(DISTINCT <column>)` in a
-- single aggregate a scan of its own and joins the results: this statement read `audit`
-- four times from one `FROM`. Grouping once by the three columns whose distinct values are
-- wanted, then counting distinct values of the grouped result, is one scan. Measured on
-- labs 2026-08-11, four alternating readings a side with the first of each dropped:
-- 7,948 ms against 15,454 ms, `execution_duration_ms` 6,509 against 14,010, and
-- `read_bytes` 29,349,662 against 39,994,787. The bytes fell by less than the scans did,
-- because the four scans were not four reads of the same thing — each distinct-count scan
-- takes one column plus the partition filters. Rows identical, on a populated window and
-- on one matching nothing.
--
-- `sum(events)` is coalesced and `sum(unity_catalog_events)` is not, which is not an
-- oversight: `count(*)` over no rows is 0 and `sum(...)` over no rows is null, so the
-- coalesce is what keeps `events` reading 0 on an estate with no audit events in the window
-- — the case this statement exists to detect. `unity_catalog_events` was already null there
-- before this rewrite, and making it 0 here would have been a silent change to what a
-- resolver sees.
--
-- Feeds: DG-02-02 (audit logging configured), DG-02-03 (auditing platform events),
-- SCP-05 (monitoring).
WITH grouped AS (
  SELECT
    service_name,
    action_name,
    COALESCE(user_identity.email, 'unknown')                       AS actor,
    count(*)                                                       AS events,
    max(event_time)                                                AS last_event,
    min(event_time)                                                AS first_event,
    max(event_date)                                                AS last_event_date,
    sum(CASE WHEN service_name = 'unityCatalog' THEN 1 ELSE 0 END) AS unity_catalog_events
  FROM system.access.audit
  WHERE event_date >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    -- Live workspaces only, so audit coverage is a fraction of the estate that exists.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY service_name, action_name, COALESCE(user_identity.email, 'unknown')
)
SELECT
  COALESCE(sum(events), 0)                                         AS events,
  count(DISTINCT service_name)                                     AS services,
  count(DISTINCT action_name)                                      AS actions,
  count(DISTINCT actor)                                            AS actors,
  max(last_event)                                                  AS last_event,
  min(first_event)                                                 AS first_event,
  datediff(current_date(), max(last_event_date))                   AS days_since_last_event,
  sum(unity_catalog_events)                                        AS unity_catalog_events
FROM grouped
