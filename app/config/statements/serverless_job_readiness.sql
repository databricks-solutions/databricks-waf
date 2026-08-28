-- Signal: sql:serverless.job_readiness
-- Rows: one per job
-- Benchmark: inventory
-- Slice: workspace_id, job_id
--
-- One row per job that ran on classic compute in the window, so it grows with the estate — and this is
-- the one statement measured past the inline cap at that estate. 27.6 MiB against a 25 MiB ceiling at
-- 100,000 jobs, 110% of it, failing outright at 90,606: below the estate this app claims to assess, so
-- a customer that size gets no serverless analysis rather than a smaller one. Twenty-nine columns, two
-- of them the sampled `cluster_names` and `runtimes` lists, one row per job.
--
-- The rework is H1d, not a `LIMIT`. The analyzer ranks by classic usage, so a top-N looks like most of
-- the answer, but serverless.ts lists forty jobs while computing its verdict counts, total cost and
-- migration estimate over every row here — and each verdict also reads a column from jobs_inventory and
-- one from serverless_job_spend, per job. Bounding this statement alone would quietly change three
-- numbers the page presents as estate-wide. So the population becomes a declared sample and the page
-- says what it sampled from. See bounds.ts, scale.test.ts, and H1d in docs/plan-status.md.
--
-- One row per job that ran in the window, describing the compute it actually ran on
-- and, for the classic clusters among them, the configuration that decides whether
-- serverless could run the same work.
--
-- Read from what ran rather than from job definitions, for two reasons. A definition
-- names compute the job may not have used — a task with `existing_cluster_id` pointing
-- at a cluster nobody starts costs nothing and needs no migration — and the Jobs API,
-- which is where task-level compute configuration lives, is not a scope a Databricks App
-- can be granted. The run timeline carries the compute per task run, so what a job
-- really used is readable where its definition is not.
--
-- `compute` is a struct array written from early December 2025 and carries the compute
-- kind directly. Older rows have only `compute_ids`, so those are read as ids with an
-- unknown kind and classified by whether a cluster row matches. That distinction is
-- kept rather than flattened: a run whose compute cannot be classified is reported as
-- undeterminable, not as classic.
--
-- Deleted clusters are deliberately included. A job cluster exists for the length of
-- one run and is then deleted, so filtering on `delete_time IS NULL` — which every
-- other statement here does, correctly, because it is asking about clusters somebody
-- could still start — would discard almost every cluster this analysis is about.
--
-- ## The configuration read is the cluster's current one, not the one the run used
--
-- `clusters` takes the latest row per cluster over the whole of `system.compute.clusters`,
-- unbounded, and joins it to runs from the window. So every blocker below — the init
-- script, the access mode, the cloud identity, the GPU node type — is a fact about how
-- the cluster is configured now, and the runs are only what tells us the job used it.
--
-- Correct for what this is for. The question is whether the next run of this job could
-- go to serverless, and that is decided by the configuration it would run under, not by
-- the one a run last Tuesday happened to have. The consequence to know is the other
-- direction: a cluster reconfigured after its last run in the window is described by the
-- new shape, so a blocker removed on Friday is absent from a job that hit it all week.
--
-- Said here, and held by `advisor-populations.test.ts`, because the two readings are one
-- `ORDER BY` apart and nothing about the output distinguishes them. An as-of join —
-- latest row at or before each run — is a different statement answering a different
-- question, and it is not what this does. Nothing downstream may say a run *did* hit a
-- blocker; the honest sentence is that the cluster it used carries one now. This is also
-- why no column here reports when the configuration was read: the result is already 110%
-- of an inline result at 100,000 jobs, and adding a timestamp per row would lower the
-- estate at which it fails. It goes with the sampling rework, which is H1d.
--
-- A job cluster is the case where the two readings coincide: it is created for the run
-- and deleted after it, so its only configuration is the one the run had.
--
-- Feeds: the serverless readiness analyzer, behind CO-01-06, PE-02-01, REL-01-06 and
-- IU-03-02.
WITH task_runs AS (
  SELECT
    workspace_id,
    job_id,
    run_id,
    task_key,
    period_start_time,
    period_end_time,
    setup_duration_seconds,
    execution_duration_seconds,
    compute,
    compute_ids,
    -- The timeline emits a row per state period and repeats the durations on each of
    -- them, so a task run that queued, ran and finished contributes its setup time
    -- three times. Taking the last row per task run is what makes the sums below a
    -- measurement rather than a multiple of one.
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, job_id, run_id, task_key ORDER BY period_end_time DESC
    ) AS recency
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    -- Live workspaces only, as everywhere else: a cancelled workspace's runs are history.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
),
runs AS (SELECT * FROM task_runs WHERE recency = 1),
-- Time, aggregated before the compute is exploded. A task run that used two computes
-- would otherwise contribute its setup seconds twice, and setup time is the one figure
-- the cost estimate leans on.
timing AS (
  SELECT
    workspace_id,
    job_id,
    count(DISTINCT run_id)                                          AS runs,
    count(*)                                                        AS task_runs,
    sum(COALESCE(setup_duration_seconds, 0))                        AS setup_seconds,
    sum(COALESCE(execution_duration_seconds, 0))                    AS execution_seconds,
    -- Task runs whose durations the table never wrote. Reported so the estimate can say
    -- it is working from a partial measurement instead of treating absent as zero.
    sum(CASE WHEN setup_duration_seconds IS NULL THEN 1 ELSE 0 END) AS task_runs_untimed,
    -- The longest single task run, against the platform's seven-day ceiling on a
    -- serverless workload. Measured rather than taken from the job's configured timeout,
    -- because a timeout is a limit somebody set and this is what the work actually took.
    max(COALESCE(setup_duration_seconds, 0) + COALESCE(execution_duration_seconds, 0)) AS longest_task_seconds,
    max(period_start_time)                                          AS last_run
  FROM runs
  -- Named rather than `GROUP BY 1, 2`, because H1c executes this statement one workspace at a time and
  -- that is only exact if every grouping key includes workspace_id. A positional key is one a reader
  -- cannot check and slices.ts refuses for that reason.
  GROUP BY workspace_id, job_id
),
used AS (
  SELECT
    r.workspace_id,
    r.job_id,
    compute_kind,
    compute_cluster_id
  FROM runs r
  LATERAL VIEW OUTER inline(
    CASE
      WHEN size(COALESCE(r.compute, array())) > 0
        THEN transform(
          r.compute,
          c -> named_struct('kind', c.type, 'cluster_id', COALESCE(c.cluster_id, c.warehouse_id))
        )
      ELSE transform(
        COALESCE(r.compute_ids, array()),
        id -> named_struct('kind', CAST(NULL AS STRING), 'cluster_id', id)
      )
    END
  ) AS compute_kind, compute_cluster_id
),
clusters AS (
  SELECT * FROM (
    SELECT
      workspace_id,
      cluster_id,
      cluster_name,
      cluster_source,
      dbr_version,
      data_security_mode,
      init_scripts,
      worker_node_type,
      policy_id,
      COALESCE(worker_instance_pool_id, driver_instance_pool_id) AS instance_pool_id,
      -- A cloud identity attached to the cluster itself, which is how a classic cluster
      -- reaches storage that Unity Catalog does not govern. Serverless has no equivalent:
      -- data access goes through external locations, so a cluster carrying one is a data
      -- path that has to be re-pointed before the compute can move.
      COALESCE(aws_attributes.instance_profile_arn, gcp_attributes.google_service_account) AS cloud_identity,
      ROW_NUMBER() OVER (
        PARTITION BY workspace_id, cluster_id ORDER BY change_time DESC
      ) AS recency
    FROM system.compute.clusters
    WHERE (:workspace_id = '' OR workspace_id = :workspace_id)
      AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  )
  WHERE recency = 1
),
classified AS (
  SELECT
    u.workspace_id,
    u.job_id,
    u.compute_cluster_id,
    upper(COALESCE(u.compute_kind, '')) LIKE '%SERVERLESS%'                       AS on_serverless,
    upper(COALESCE(u.compute_kind, '')) LIKE '%WAREHOUSE%'                        AS on_warehouse,
    -- Classic means a cluster row matched, or the kind said cluster and one did. An id
    -- with no row is left unclassified below rather than assumed to be a cluster: it can
    -- equally be a warehouse id from an older row that carried only `compute_ids`.
    c.cluster_id IS NOT NULL                                                      AS on_cluster,
    c.cluster_source IN ('UI', 'API')                                             AS on_all_purpose,
    size(COALESCE(c.init_scripts, array())) > 0                                   AS has_init_script,
    c.init_scripts IS NULL                                                        AS init_scripts_unknown,
    -- The same GPU family match the cluster inventory uses, on the family prefix rather
    -- than an enumerated list of instance types.
    (
      upper(COALESCE(c.worker_node_type, '')) RLIKE '^(P[2-9]|G[3-9]|G[0-9][0-9]|INF|TRN|DL[0-9])'
      OR upper(COALESCE(c.worker_node_type, '')) RLIKE '(STANDARD_N[CDV])'
      OR upper(COALESCE(c.worker_node_type, '')) RLIKE '(A2-|G2-|A3-)'
    )                                                                             AS has_gpu,
    c.instance_pool_id IS NOT NULL                                                AS has_pool,
    c.cloud_identity IS NOT NULL                                                  AS has_cloud_identity,
    c.policy_id IS NOT NULL                                                       AS has_policy,
    lower(COALESCE(c.dbr_version, '')) RLIKE '(^|-)([0-9.]+x-)?(cpu-|gpu-)?ml-'   AS ml_runtime,
    -- Access modes serverless has no equivalent of. `NONE` is no-isolation shared, and
    -- the LEGACY_ modes predate Unity Catalog, so code written against either may use
    -- what that mode allowed rather than what serverless allows.
    upper(COALESCE(c.data_security_mode, '')) IN (
      'NONE', 'LEGACY_SINGLE_USER', 'LEGACY_SINGLE_USER_STANDARD', 'LEGACY_TABLE_ACL', 'LEGACY_PASSTHROUGH'
    )                                                                             AS legacy_access_mode,
    c.data_security_mode IS NULL                                                  AS access_mode_unknown,
    -- try_cast rather than cast: a runtime string in a shape this pattern does not match
    -- extracts as empty, and casting that would fail the whole statement for one cluster
    -- named something unexpected. NULL here reads as an unknown runtime, which is true.
    try_cast(nullif(regexp_extract(COALESCE(c.dbr_version, ''), '^([0-9]+)\\.', 1), '') AS INT) AS runtime_major,
    c.cluster_name,
    c.dbr_version
  FROM used u
  LEFT JOIN clusters c
    ON c.workspace_id = u.workspace_id
    AND c.cluster_id = u.compute_cluster_id
)
SELECT
  t.workspace_id,
  t.job_id,
  t.runs,
  t.task_runs,
  t.task_runs_untimed,
  t.longest_task_seconds,
  t.setup_seconds,
  t.execution_seconds,
  t.last_run,
  count(*)                                                                          AS compute_uses,
  sum(CASE WHEN k.on_serverless THEN 1 ELSE 0 END)                                  AS serverless_uses,
  sum(CASE WHEN k.on_warehouse THEN 1 ELSE 0 END)                                   AS warehouse_uses,
  sum(CASE WHEN k.on_cluster AND NOT k.on_serverless THEN 1 ELSE 0 END)             AS classic_uses,
  -- Neither a struct that named its kind nor an id that matched a cluster. `OUTER inline`
  -- keeps task runs that recorded no compute at all, and those land here too, which is
  -- right: they are the case the undeterminable verdict exists for. The count is what
  -- makes that verdict a measurement rather than a shrug.
  sum(
    CASE WHEN NOT k.on_cluster AND NOT k.on_serverless AND NOT k.on_warehouse THEN 1 ELSE 0 END
  )                                                                                 AS unclassified_uses,
  count(DISTINCT CASE WHEN k.on_cluster AND NOT k.on_serverless THEN k.compute_cluster_id END) AS classic_clusters,
  count(
    DISTINCT CASE
      WHEN NOT k.on_cluster AND NOT k.on_serverless AND NOT k.on_warehouse THEN k.compute_cluster_id
    END
  )                                                                                 AS unread_clusters,
  count(DISTINCT CASE WHEN k.on_all_purpose THEN k.compute_cluster_id END)          AS all_purpose_clusters,
  count(DISTINCT CASE WHEN k.has_init_script THEN k.compute_cluster_id END)         AS init_script_clusters,
  count(DISTINCT CASE WHEN k.init_scripts_unknown AND k.on_cluster THEN k.compute_cluster_id END) AS unknown_init_script_clusters,
  count(DISTINCT CASE WHEN k.has_gpu THEN k.compute_cluster_id END)                 AS gpu_clusters,
  count(DISTINCT CASE WHEN k.has_pool THEN k.compute_cluster_id END)                AS pooled_clusters,
  count(DISTINCT CASE WHEN k.has_cloud_identity THEN k.compute_cluster_id END)      AS cloud_identity_clusters,
  count(DISTINCT CASE WHEN k.has_policy THEN k.compute_cluster_id END)              AS policy_clusters,
  count(DISTINCT CASE WHEN k.ml_runtime THEN k.compute_cluster_id END)              AS ml_runtime_clusters,
  count(DISTINCT CASE WHEN k.legacy_access_mode THEN k.compute_cluster_id END)      AS legacy_access_mode_clusters,
  count(DISTINCT CASE WHEN k.access_mode_unknown AND k.on_cluster THEN k.compute_cluster_id END) AS unknown_access_mode_clusters,
  min(CASE WHEN k.on_cluster AND NOT k.on_serverless THEN k.runtime_major END)      AS oldest_runtime_major,
  -- A sample rather than every value: the reader needs to recognise the cluster, and a
  -- job with forty ephemeral clusters would otherwise return forty names nobody reads.
  concat_ws(
    ',',
    slice(array_sort(array_distinct(collect_list(CASE WHEN k.on_cluster THEN k.cluster_name END))), 1, 3)
  )                                                                                 AS cluster_names,
  concat_ws(
    ',',
    slice(array_sort(array_distinct(collect_list(CASE WHEN k.on_cluster THEN k.dbr_version END))), 1, 3)
  )                                                                                 AS runtimes
FROM timing t
LEFT JOIN classified k
  ON k.workspace_id = t.workspace_id
  AND k.job_id = t.job_id
GROUP BY
  t.workspace_id,
  t.job_id,
  t.runs,
  t.task_runs,
  t.task_runs_untimed,
  t.longest_task_seconds,
  t.setup_seconds,
  t.execution_seconds,
  t.last_run
ORDER BY classic_uses DESC, t.job_id
