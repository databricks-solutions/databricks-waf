-- Signal: sql:compute.clusters
-- Rows: one per cluster
-- Benchmark: inventory
-- Slice: workspace_id, cluster_id
--
-- One row per live cluster, from the latest definition of each. `system.compute.clusters` is slowly
-- changing: a cluster edited five times has five rows, so the window takes the most recent and the
-- lifecycle filter is applied to the row it chose.
--
-- Feeds: CO-01-04 (runtimes), CO-01-05 (GPUs), CO-02-01 (autoscaling),
-- CO-02-02 (auto-termination), CO-02-03 (policies), CO-04-02 (spot),
-- SCP-04-04 (deprecated runtimes), SCP-04-07 (access modes),
-- SCP-04-16 (init scripts on DBFS).
-- `WHERE delete_time IS NULL` used to sit in the same query as the window — so for a deleted cluster it
-- discarded the row recording the deletion and kept an older one where the cluster was still alive.
-- Measured live: 6,136,941 rows reported as live where 135,177 exist, 45x, every one of them feeding the
-- runtime, autoscaling, auto-termination, policy, spot and init-script controls below. The same shape
-- inflated `jobs_inventory` 5x. `server/collect/sql/history.ts` refuses it now.
--
-- This drove from `system.billing.usage` over the review window for one commit, which cut the rows to
-- 14,016 and was the wrong fix: the controls below score shares of the configured fleet, so scoping the
-- population to what billed in thirty days answers a different question and — measured on
-- `jobs_inventory`, where the same change was made — reports 19% deleted objects as live anyway, because
-- a cluster that billed is not necessarily a cluster that still exists. Recency stays on the spend
-- statements, which read it from the fact table where a date means something.
--
-- So this returns the live fleet, 135,177 on that account, which is past what an inline result holds.
-- That is H1d's problem and slicing on the declared axis is its answer; narrowing the population is not,
-- because every share here is over the fleet. Until H1d lands a large estate collects partially and says
-- so, which is the honest failure and a 45x improvement on the one it replaces. See bounds.ts and H1 in
-- docs/plan-status.md.
--
-- Every definition, ranked. Only partition keys are filtered here. An empty `workspace_id` means the
-- scope could not be narrowed and the whole visible account is assessed, which the scan records and the
-- UI states rather than leaving implied.
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC) AS recency
  FROM system.compute.clusters
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
  cluster_id,
  cluster_name,
  cluster_source,
  dbr_version,
  data_security_mode,
  policy_id IS NOT NULL                                       AS has_policy,
  min_autoscale_workers IS NOT NULL
    AND max_autoscale_workers > min_autoscale_workers          AS autoscaling,
  auto_termination_minutes,
  COALESCE(auto_termination_minutes, 0) > 0                    AS auto_terminates,
  COALESCE(worker_count, 0)                                    AS worker_count,
  COALESCE(min_autoscale_workers, 0)                           AS min_workers,
  COALESCE(max_autoscale_workers, 0)                           AS max_workers,
  driver_node_type,
  worker_node_type,
  -- GPU instance families across the three clouds. Matched on the family prefix
  -- rather than an enumerated list, because the list changes with every
  -- generation and a stale list would silently under-report.
  (
    upper(COALESCE(worker_node_type, '')) RLIKE '^(P[2-9]|G[3-9]|G[0-9][0-9]|INF|TRN|DL[0-9])'
    OR upper(COALESCE(worker_node_type, '')) RLIKE '(STANDARD_N[CDV])'
    OR upper(COALESCE(worker_node_type, '')) RLIKE '(A2-|G2-|A3-)'
  )                                                            AS gpu_node,
  COALESCE(aws_attributes.availability, azure_attributes.availability, gcp_attributes.availability) AS availability,
  size(COALESCE(init_scripts, array()))                        AS init_script_count,
  -- Init scripts whose destination is DBFS, which is the thing SCP-04-16 is about:
  -- DBFS has no access control, so anyone who can write there can change what runs as
  -- root on every node at startup. Counted here rather than returning the paths,
  -- because a path can name a directory someone chose to call something revealing and
  -- the count is all the control needs.
  --
  -- `init_scripts` is array<string> and is populated as an empty array for a cluster
  -- with none, which is why absence is readable: an empty array means no init scripts,
  -- where NULL would mean the column was not written. The two are distinguished below
  -- so a control cannot read one as the other.
  --
  -- Matched on the two spellings of a DBFS root and nothing else. A destination under
  -- `/Volumes`, `/Workspace` or a cloud URI is governed and is not what this control
  -- objects to, so an unrecognised destination counts as not-DBFS rather than as
  -- suspicious: over-reporting here would fail a cluster for storing its init script in
  -- the place the documentation now tells you to.
  size(
    filter(COALESCE(init_scripts, array()), s -> lower(s) RLIKE '^(dbfs:/|/dbfs/)')
  )                                                            AS dbfs_init_script_count,
  init_scripts IS NOT NULL                                     AS init_scripts_known,
  size(COALESCE(map_keys(tags), array()))                      AS tag_count,
  change_time
FROM latest
ORDER BY cluster_name
