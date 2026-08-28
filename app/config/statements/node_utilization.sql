-- Signal: sql:compute.node_utilization
-- Rows: 1
-- Benchmark: coverage
--
-- Per-cluster average CPU utilisation from node_timeline, for CO-01-08. The question asks
-- whether anyone tested if a workload runs on smaller compute than it is given, and a cluster
-- sitting at near-zero utilisation across a long enough run is the direct evidence that at least
-- one was never right-sized. combined CPU (`cpu_user_percent + cpu_system_percent`) under 5%,
-- averaged across every sample the cluster has, is the threshold: low enough that a genuinely
-- light workload does not trip it.
--
-- A cluster is only counted once it has at least 60 samples. The table keeps a row per node per
-- minute, so **assume** 60 rows is roughly an hour of one node — long enough that an average over
-- them describes how the cluster runs rather than how it started. Without a floor, a job cluster
-- that lived four minutes at 3% CPU counts identically to one idling for a month, and the reading
-- would be asserting a whole window from four samples. Clusters below the floor are left out of
-- both counts rather than assumed either way, which is why `clusters_observed` counts only the
-- clusters that cleared it while `node_samples` counts every row read: an estate whose clusters
-- are all short-lived has samples but nothing to average, and that is a third case, distinct from
-- an empty table and from a busy estate.
--
-- This does not infer a pass. A cluster running at 40% CPU could still be oversized for its
-- workload — nothing here says what the workload needed — so the measure only ever fails an
-- estate over the clusters it can show are idle, and is silent about the rest.
--
-- `node_timeline` has returned no row on every labs workspace probed for this, going back to
-- the last classic cluster that ran in the region in September 2024. An empty reading is
-- reported as unmeasured rather than as a pass: an estate with no recent samples has not been
-- shown to run compute efficiently, it has simply not been read.
--
-- Feeds: CO-01-08 (choose the most efficient compute size).
-- Grouped by (workspace_id, cluster_id) in the same query that reads node_timeline, rather than
-- through an intermediate ungrouped CTE: the table keeps a row per period per instance, and a read
-- of it has to get down to one thing in its own scope for check-grain to accept it as a per-cluster
-- reading rather than a count of timeline rows. The workspace is part of the key because the scan
-- spans every live workspace in the account, and grouping on cluster_id alone would merge two
-- clusters into one average if the id ever repeated across them — the same scoping Q1d's open
-- pipeline finding asks for.
WITH per_cluster AS (
  SELECT
    workspace_id,
    cluster_id,
    avg(COALESCE(cpu_user_percent, 0) + COALESCE(cpu_system_percent, 0)) AS avg_cpu_percent,
    count(*)                                                             AS node_sample_count,
    max(start_time)                                                      AS last_sample
  FROM system.compute.node_timeline
  WHERE start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, cluster_id
)
SELECT
  (SELECT COALESCE(sum(node_sample_count), 0) FROM per_cluster)   AS node_samples,
  (SELECT count(*) FROM per_cluster WHERE node_sample_count >= 60) AS clusters_observed,
  (SELECT count(*) FROM per_cluster
    WHERE node_sample_count >= 60 AND avg_cpu_percent < 5)         AS idle_clusters,
  (SELECT max(last_sample) FROM per_cluster)                       AS last_sample
