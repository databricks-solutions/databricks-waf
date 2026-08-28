-- Signal: sql:pipelines.inventory
-- Rows: one per pipeline
-- Benchmark: inventory
--
-- The `GROUP BY pipeline_id` collapses a pipeline's update history, not the estate: one row per
-- pipeline still grows with the customer. See bounds.ts, and H1 in docs/plan-status.md.
--
-- Declarative pipelines: how many, in which mode, and whether they have run.
--
-- A declarative pipeline is the observable form of "we use an ETL framework rather than
-- hand-rolled orchestration", which is what the operational-excellence pillar asks about
-- in two separate places. The distinction the controls turn on is `development`:
-- a pipeline left in development mode does not retry failed updates and reuses its
-- cluster, so it is a pipeline nobody has put into production regardless of what it
-- processes.
--
-- `system.lakeflow.pipelines` is slowly changing, exactly like `system.lakeflow.jobs`: a
-- pipeline edited five times has five rows, and a deletion is a sixth row carrying
-- `delete_time` rather than the removal of the others. So the latest row per pipeline is
-- taken first and the lifecycle filter is applied to that row, in two steps for the reason
-- `history.ts` exists — filtering `delete_time IS NULL` in the same query as the window
-- deletes the evidence of deletion, leaving an earlier row to win the ranking and report a
-- deleted pipeline as live.
--
-- This statement had neither step until 2026-08-05, and declared `-- Rows: one per pipeline`
-- while returning one row per configuration version. Every OE-02-06 and OE-02-11 finding was
-- therefore a share over a population of versions. Found by `check:grain` on the day that
-- check was written, and measured the same day against an internal workspace large enough for
-- the two faults to separate: the old shape returned 101,207 rows where 8,934 pipelines exist,
-- over-reporting by 11.3x. 85,900 of those rows belonged to pipelines that had been deleted —
-- their pre-deletion rows all carry `delete_time IS NULL`, so a deleted pipeline is not merely
-- miscounted but resurrected, and 50,061 of the estate's 58,995 pipelines are deleted. The
-- remaining 15,307 rows were the 8,934 live pipelines counted 1.7 times each. Neither fault is
-- visible in a small workspace, which is why the check is static rather than a row-count assertion.
--
-- One row per pipeline rather than an aggregate, because the findings name the pipelines
-- that need attention and a count cannot.
--
-- Feeds: OE-02-06 (ETL frameworks), OE-02-11 (declarative management).
WITH ranked AS (
  SELECT
    *,
    ROW_NUMBER() OVER (PARTITION BY workspace_id, pipeline_id ORDER BY change_time DESC) AS recency
  FROM system.lakeflow.pipelines
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
  p.workspace_id,
  p.pipeline_id,
  p.name,
  p.pipeline_type,
  -- Development mode is what a pipeline is created in, so this field separates a pipeline
  -- someone finished from one someone started.
  COALESCE(p.settings.development, FALSE)                       AS development,
  COALESCE(p.settings.serverless, FALSE)                        AS serverless,
  COALESCE(p.settings.photon, FALSE)                            AS photon,
  p.settings.edition                                            AS edition,
  p.settings.channel                                            AS channel,
  p.run_as,
  size(COALESCE(map_keys(p.tags), array()))                      AS tag_count,
  -- Whether the pipeline ran in the window. A pipeline that has never updated is
  -- configuration rather than a workload, and the controls should not credit it as one.
  COALESCE(u.updates, 0)                                        AS updates,
  COALESCE(u.failed_updates, 0)                                 AS failed_updates
FROM latest p
/*
 * The update counts, over the same workspaces the inventory above is over.
 *
 * Both scope predicates and `workspace_id` in the grouping key, none of which used to be here. What that
 * cost was not a wrong count — a pipeline id is a UUID and the join found the right rows — but a scan of
 * every workspace's update timeline in the account to answer a question about the ones asked for.
 *
 * The grain matters for the same reason `slices.ts` gives, without that check reaching this statement:
 * `sliceProblem` runs over the statements that declare a `-- Slice:` header and this declares none, so
 * the group is held by `advisor-populations.test.ts` instead. H1c executes a sliced statement one
 * workspace at a time and the concatenation is only the estate's answer if each slice is that
 * workspace's, so a per-pipeline aggregate that spans workspaces is a grain this could not acquire an
 * axis on later.
 */
LEFT JOIN (
  SELECT
    workspace_id,
    pipeline_id,
    count(DISTINCT update_id)                                                          AS updates,
    count(DISTINCT CASE WHEN upper(COALESCE(result_state, '')) = 'FAILED' THEN update_id END)
                                                                                       AS failed_updates
  FROM system.lakeflow.pipeline_update_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, pipeline_id
) u
  ON u.workspace_id = p.workspace_id
  AND u.pipeline_id = p.pipeline_id
ORDER BY p.name
