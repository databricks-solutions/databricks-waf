-- Signal: sql:compute.warehouses
-- Rows: one per warehouse
-- Benchmark: inventory
--
-- Grows with the estate, though against a declared target of 1,000 warehouses this is the least
-- urgent of the eight — it is on the manifest because the shape is wrong, not because it is close
-- to the ceiling. See bounds.ts, and H1 in docs/plan-status.md.
--
-- One row per live SQL warehouse, latest definition only. Same slowly-changing
-- shape as the cluster table, and the same reason for collapsing it.
--
-- Feeds: CO-01-03 (SQL on warehouses), CO-02-01 (scaling), CO-02-02 (auto-stop),
-- CO-01-06 (serverless adoption), PE-01 (warehouse sizing).
-- The `delete_time IS NULL` filter sits below, on the ranked result, not here. Inside this query it
-- removed the only row where `delete_time` is set — the row recording the deletion — leaving an older
-- row to win the ranking and report a deleted warehouse as live. Measured account-wide: 5,101 warehouses
-- reported live where 24 exist, 212x, the worst of the three statements that had this defect and the one
-- nobody had noticed. `compute_cluster_inventory` and `jobs_inventory` were found by reading them after a
-- live count looked wrong; this one was found by `historyProblem` in server/collect/sql/history.ts, which
-- is the argument for the rule being a check rather than a paragraph.
--
-- The two filters that remain are on partition keys, which remove whole warehouses rather than choosing
-- between one warehouse's history rows, so they are safe here and cheaper here.
--
-- Not driven from billing as the cluster and job inventories now are, deliberately. A warehouse is a
-- persistent resource somebody configured and left, so an idle one with no auto-stop is a finding worth
-- reporting where an ephemeral job cluster that never ran is not. That difference is why the population
-- here is "exists" and theirs is "ran in the window".
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, warehouse_id ORDER BY change_time DESC) AS recency
  FROM system.compute.warehouses
  WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
    -- Live workspaces only. Measured on labs: without this, 68 warehouses are assessed
    -- where 4 exist, because 58 belong to cancelled workspaces and 6 to banned ones.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
latest AS (
  SELECT * FROM ranked WHERE recency = 1 AND delete_time IS NULL
)
SELECT
  workspace_id,
  warehouse_id,
  warehouse_name,
  warehouse_type,
  warehouse_type = 'SERVERLESS'          AS serverless,
  warehouse_channel,
  warehouse_size,
  min_clusters,
  max_clusters,
  COALESCE(max_clusters, 1) > COALESCE(min_clusters, 1) AS scales_out,
  auto_stop_minutes,
  COALESCE(auto_stop_minutes, 0) > 0      AS auto_stops,
  size(COALESCE(map_keys(tags), array())) AS tag_count,
  change_time
FROM latest
ORDER BY warehouse_name
