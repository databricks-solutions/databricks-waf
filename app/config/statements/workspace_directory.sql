-- Signal: sql:estate.workspaces
-- Rows: one per workspace
-- Benchmark: inventory
--
-- Against a declared target of 500 workspaces this is comfortably inside the inline ceiling, and it
-- is on the manifest anyway: every other signal filters on the ids this returns, so if it ever
-- truncated, every account-reach finding would narrow without saying so. See bounds.ts and H1.
--
-- The workspaces this account actually has, and their lifecycle status.
--
-- Needed as a denominator filter, not for labelling. The compute and job tables are
-- slowly-changing histories: when a workspace is cancelled its rows stay behind, and
-- `delete_time IS NULL` does not catch it because nothing deleted the individual
-- warehouse — the workspace around it went away. Measured on labs: 68 undeleted
-- warehouses across 70 workspace ids, of which 58 belong to workspaces no longer in the
-- account and 6 to banned ones. Four are real. Assessing all 68 produces a confident
-- finding about 64 resources nobody can configure.
--
-- Databricks removes a cancelled workspace's row from this table, so absence here means
-- cancelled. Presence with a status other than RUNNING means it exists but is not usable,
-- which the documentation's own sample query treats the same way.
--
-- This table is in Public Preview, so it may be unreadable in some accounts. The
-- collector treats that as a degradation to report rather than a scan failure: without it
-- the counts widen to include cancelled workspaces, and the finding says so.
--
-- Also the region filter, which is the other half of the same job. `workspaces_latest` and
-- `system.billing.usage` are documented as global — they carry every workspace in the account. The
-- tables that describe how compute is configured are documented as regional: "System tables contain
-- operational data for all workspaces in your account deployed within the same cloud region." A
-- Unity Catalog metastore is region-bound, so one deployment of this tool can only assess the region
-- it runs in, and reviewing another region means deploying it there.
--
-- Without this filter the two halves disagree and nothing says so. Measured on a large account: 15
-- workspaces, 10 of them billing DBUs from other regions, so the cost signals saw 15 workspaces
-- while every compute and jobs signal saw 5 — and the score was presented as covering the estate.
--
-- Each workspace's region is read from the names of the SKUs it billed. Serverless SKUs carry it —
-- `ENTERPRISE_ALL_PURPOSE_SERVERLESS_COMPUTE_US_WEST_OREGON`, `..._AP_TOKYO`, `..._EUROPE_IRELAND` —
-- and `system.billing.usage` is global, so this reads a region for a workspace no regional table can
-- see. That is the property that matters: the thing being detected is invisible to the tables that
-- would otherwise describe it.
--
-- Taken as the region carrying most of the workspace's DBUs, because a workspace can bill a SKU from
-- another region and two of fifteen measured did. Weighting settles it without ambiguity rather than
-- nearly: the large-estate calibration came out 3,385,590 DBUs in US_WEST_OREGON against 0.2 in
-- US_EAST_N_VIRGINIA, while a second calibration measured 516,119 in US_EAST_N_VIRGINIA against 0.0 in US_WEST_OREGON
-- — which is the right answer, since no regional table covers it.
--
-- NULL where it cannot be read: a workspace running only classic compute bills SKUs with no region in
-- the name, and one measured workspace is in that position. The collector treats an unknown region as
-- unfiltered rather than as foreign, and the app asks rather than guessing — assessing a workspace
-- that turns out to be elsewhere is a visible wrong answer, where silently dropping one is not.
--
-- Feeds: every account-reach signal, as the live-workspace filter.
WITH regional_sku AS (
  SELECT
    workspace_id,
    -- Anchored at the end of the name so only a region suffix matches, and empty for a SKU without one.
    -- Matched on the shape rather than an enumerated list, for the same reason the GPU families in
    -- `compute_cluster_inventory` are: Databricks adds regions, and a stale list would silently start
    -- reporting workspaces as region-unknown.
    regexp_extract(
      sku_name,
      '_(US_[A-Z_]+|EUROPE_[A-Z_]+|AP_[A-Z_]+|CANADA[A-Z_]*|SA_[A-Z_]+|AF_[A-Z_]+|ME_[A-Z_]+)$',
      1
    )                                                          AS region,
    usage_quantity
  FROM system.billing.usage
  WHERE usage_date >= current_date() - make_dt_interval(:lookback_days)
    -- DBUs only. DSU and GB are not comparable to DBUs; summing them into the region ranking
    -- would let storage or serving units pick a workspace's region.
    AND usage_unit = 'DBU'
),
by_volume AS (
  SELECT
    workspace_id,
    region,
    ROW_NUMBER() OVER (PARTITION BY workspace_id ORDER BY sum(usage_quantity) DESC) AS rank
  FROM regional_sku
  WHERE region <> ''
  GROUP BY workspace_id, region
)
SELECT
  w.workspace_id,
  w.workspace_name,
  w.workspace_url,
  w.status,
  r.region,
  w.status = 'RUNNING'                                         AS live,
  w.create_time
FROM system.access.workspaces_latest w
LEFT JOIN by_volume r ON r.workspace_id = w.workspace_id AND r.rank = 1
ORDER BY w.status, w.workspace_name
