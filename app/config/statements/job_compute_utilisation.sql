-- Signal: sql:workload.job_compute_utilisation
-- Rows: at most :job_limit
-- Benchmark: workload
--
-- What the workers of a job's classic clusters were doing while its tasks ran. One row per job that
-- ran on classic compute in the window, carrying the four utilisation measures the audit's rules A,
-- B and C read, the setup overhead rule G reads, the network rate the one live condition of rule D
-- reads, and the node type the as-of configuration join resolves. It feeds the job advisor; like
-- `job_run_health.sql` it scores nothing and cites no requirement.
--
-- Separate from `job_run_health.sql` rather than more columns on it, for
-- [ADR 0092](../../../docs/decisions/0092-the-expensive-half-of-a-measure-becomes-an-enrichment.md)'s
-- reason: `system.compute.node_timeline` is a row per node per minute and every estate that runs
-- nothing on classic compute has none of it. On labs the join reaches 0 of 7 jobs and this statement
-- returns no rows, while `job_run_health` returns seven — folded together, an estate with no classic
-- compute would lose the four rules that do not need any.
--
-- ## Every join below is one `41b` measured on `large-estate`, and three of them were wrong first
--
-- **The compute id comes from `compute` where it names a classic cluster, and nowhere else.**
-- `41b`'s first fragment coalesced `compute.warehouse_id` and fell back to `compute_ids`, which is
-- where a *serverless* task run's id lives — 71 serverless task-computes with no cluster id at all
-- still produced 58 "run-cluster pairs". A share of what a cluster rule can see, computed over a
-- population that mostly cannot have a cluster, states the rule's reach as far worse than it is.
--
-- **The node join is an overlap and excludes the driver.** `n.start_time < task_end AND n.end_time >
-- task_start` is the document's own condition at line 309: without it, historical node metrics attach
-- to unrelated runs when a cluster id is reused. `driver = FALSE` is line 250's, because a driver's
-- utilisation is not evidence about worker sizing. Measured on `large-estate`, drivers are a material
-- share of the samples below 10% CPU, so including them would move every rule's population.
--
-- **The configuration join is as-of and stays as-of.** `change_time <= run_start`, which reaches 8.7%
-- of classic pairs where a plain "any record" join reaches 53.6%. Every pair in that gap has exactly
-- one configuration record and it postdates the run start — 7,405 with a record, 1,204 as-of, and
-- 6,201 the difference — so the relaxed join would not be reading a stale configuration some of the
-- time. It would be reading, for all 6,201, a cluster configured after the run it is attributed to.
-- Naming a node type off that makes a sentence more specific than the field beneath it. So the node
-- type is null where the as-of join finds nothing, and the rule says the direction without the name.
--
-- ## Two windows, and this is the shorter one
--
-- `node_timeline` held 94 days of rows on `large-estate` against the task timeline's 370. Anything
-- rendering a utilisation figure beside a duration trend is showing two windows on one page, so the
-- earliest and latest samples come back and the surface has to say so.
--
-- ## The sample floor is this app's and not the document's
--
-- 48.2% of run-cluster pairs are averaged over fewer than three one-minute samples. A mean over one
-- observation is not a mean, and the document says nothing about it — it costs three of the twelve
-- jobs rule A would otherwise select. The count comes back per job rather than the floor being
-- applied here: the floor is a threshold and thresholds live in `job-rules.yaml`.
--
-- ## The network rate is a rate and is not a ratio
--
-- `50` measured rule D's five conditions and three of them are gone: low CPU selects 98.4% of the
-- pairs, CPU wait's p95 is 1.28% with a thirty-day maximum of 23.6%, and the two that compare traffic
-- with data processed need a denominator `system.query.history` names no classic job cluster on — 0
-- rows of 4,106,493 in the window. What remains is the rate itself, which does discriminate: p50 3.0
-- MiB per node-minute, p95 136.3, max 18,995. So the figures below are bytes over node-minutes and
-- nothing here is divided by a volume of data. Read as *I/O-bound* they would be a comparison this
-- app cannot make.
--
-- The estate's own median comes back on every row because the finding is relative. An absolute rate
-- means nothing without the workspace it is large against, and computing it on the client from the
-- returned rows would take the median of the top `:job_limit` jobs rather than of the estate.
--
-- `network_received_bytes` and `network_sent_bytes` are per-sample counters, so a pair's traffic is
-- the sum across its samples. Overlapping samples of one node would be counted twice; recorded as an
-- assumption because it is one, and it errs toward the rule firing rather than away.
--
-- ## What this statement may not be read as
--
-- Not a cost figure and not a saving. The document's line 744 is explicit that savings are not one
-- minus CPU utilisation, and nothing here divides anything by a price.
--
-- Feeds: the job advisor. Analysis rather than assessment: nothing here can change a score or a
-- finding.
--
-- @param lookback_days       how far back runs are counted
-- @param workspace_id        one workspace, or '' for the whole account
-- @param live_workspace_ids  the workspaces still live, or '' for no restriction
-- @param job_limit           how many jobs to return, longest-running first
--
-- One row per task run, its window collapsed to its endpoints, in the same scope as the read of the
-- period table — `grain.ts` judges a read on its own scope's clauses. Endpoints rather than sums,
-- under a table that repeats each duration on every state period.
WITH task_runs AS (
  SELECT
    workspace_id,
    job_id,
    job_run_id,
    run_id,
    min(period_start_time) AS task_start,
    max(period_end_time)   AS task_end,
    max(compute)           AS compute
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, job_id, job_run_id, run_id
),
-- The classic cluster ids only. A serverless task run states its kind here and carries no cluster id,
-- so filtering on the kind is what keeps the denominators below about the compute these rules concern.
classic AS (
  SELECT
    workspace_id,
    job_id,
    job_run_id,
    task_start,
    task_end,
    explode(
      filter(
        transform(coalesce(compute, array()), c -> CASE WHEN c.type = 'CLASSIC_COMPUTE' THEN c.cluster_id END),
        id -> id IS NOT NULL
      )
    ) AS cluster_id
  FROM task_runs
),
-- One row per run and cluster, which is the grain the rules' thresholds were measured at. The window
-- is the run's, so a long-lived cluster shared by two runs contributes each run's own samples.
pairs AS (
  SELECT
    c.workspace_id,
    c.job_id,
    c.job_run_id,
    c.cluster_id,
    min(c.task_start)                                             AS run_start,
    count(*)                                                      AS worker_samples,
    avg(n.cpu_user_percent + n.cpu_system_percent)                AS avg_cpu,
    max(n.cpu_user_percent + n.cpu_system_percent)                AS peak_cpu,
    avg(n.cpu_wait_percent)                                       AS avg_cpu_wait,
    avg(n.mem_used_percent)                                       AS avg_memory,
    max(n.mem_used_percent)                                       AS peak_memory,
    avg(n.mem_swap_percent)                                       AS avg_swap,
    -- Rule D's one live condition. Coalesced to zero rather than dropped, and the samples that stated
    -- nothing counted beside it: a pair whose every sample is silent has a sum of zero, which would
    -- otherwise read as a pair that moved no traffic.
    sum(coalesce(n.network_received_bytes, 0) + coalesce(n.network_sent_bytes, 0)) AS network_bytes,
    count_if(n.network_received_bytes IS NULL AND n.network_sent_bytes IS NULL)    AS samples_stating_no_network,
    sum(unix_timestamp(n.end_time) - unix_timestamp(n.start_time)) / 60.0          AS node_minutes,
    min(n.start_time)                                             AS earliest_sample,
    max(n.start_time)                                             AS latest_sample
  FROM classic c
  JOIN system.compute.node_timeline n
    ON  n.workspace_id = c.workspace_id
    AND n.cluster_id   = c.cluster_id
    AND n.start_time   < c.task_end
    AND n.end_time     > c.task_start
    AND n.driver       = FALSE
  GROUP BY c.workspace_id, c.job_id, c.job_run_id, c.cluster_id
),
-- The workspace's own middle, over every pair rather than over the returned jobs. Rule D fires on a
-- job whose rate is orders of magnitude above this, and the estate `50` read spans five of them — so
-- the comparison has to be against the population and not against the sample the limit leaves.
estate AS (
  SELECT
    percentile(network_bytes / node_minutes, 0.5) AS median_bytes_per_node_minute,
    count(*)                                      AS pairs_with_a_rate
  FROM pairs
  WHERE node_minutes > 0
),
-- The cluster as it was configured when the run started. `max_by` over the records at or before the
-- run start is the as-of read; a cluster whose only record postdates the run resolves to nothing here
-- and the node type is absent rather than borrowed from a later configuration.
config AS (
  SELECT
    p.workspace_id,
    p.job_id,
    p.job_run_id,
    p.cluster_id,
    max_by(k.worker_node_type, k.change_time) AS node_type,
    max_by(k.worker_count, k.change_time)     AS worker_count
  FROM pairs p
  JOIN system.compute.clusters k
    ON  k.workspace_id = p.workspace_id
    AND k.cluster_id   = p.cluster_id
    AND k.change_time <= p.run_start
  GROUP BY p.workspace_id, p.job_id, p.job_run_id, p.cluster_id
),
-- Rule G's input, at the run grain the platform writes it at. `setup_duration_seconds` is written as
-- a zero rather than a null on every run measured — 0 of 176,261 carried no figure — so an absent
-- setup phase is a measured zero and a null would be a different fact. Both are kept apart below.
setup AS (
  SELECT
    workspace_id,
    job_id,
    run_id,
    max(setup_duration_seconds) AS setup_seconds,
    max(run_duration_seconds)   AS stated_run_seconds
  FROM system.lakeflow.job_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, job_id, run_id
),
-- Setup summarised per job at the run grain and not the pair grain. A run on two clusters is two rows
-- in `pairs` and one setup phase, so averaging it there would weight a job by how many clusters its
-- runs used. Only the runs the node join reached are in it, which is the same population as the rest
-- of the row.
job_setup AS (
  SELECT
    r.workspace_id,
    r.job_id,
    count_if(s.setup_seconds IS NULL) AS runs_with_no_setup_figure,
    max(s.setup_seconds)              AS setup_seconds_max,
    avg(s.setup_seconds)              AS setup_seconds_mean,
    avg(s.stated_run_seconds)         AS stated_run_seconds_mean
  FROM (SELECT DISTINCT workspace_id, job_id, job_run_id FROM pairs) r
  LEFT JOIN setup s
    ON s.workspace_id = r.workspace_id AND s.job_id = r.job_id AND s.run_id = r.job_run_id
  GROUP BY r.workspace_id, r.job_id
),
-- The funnel's first two steps, before the node join narrows anything. Both are counts over the
-- window rather than over the returned rows: a page quoting the rules' reach against the estate's
-- job count would divide a figure about the sample by a figure about the estate.
reach AS (
  SELECT
    count(DISTINCT job_id)                                                  AS jobs_that_ran,
    count(DISTINCT CASE WHEN size(coalesce(compute, array())) > 0 THEN job_id END) AS jobs_with_a_compute_id,
    count(DISTINCT CASE
      WHEN exists(coalesce(compute, array()), c -> c.type = 'CLASSIC_COMPUTE' AND c.cluster_id IS NOT NULL)
      THEN job_id END)                                                      AS jobs_on_classic_compute
  FROM task_runs
),
-- One row per job, before the population count and the limit. Separate from the tail for the reason
-- `job_run_health` groups in its CTEs: `count(*) OVER ()` has to see the grouped rows to count jobs
-- rather than pairs.
per_job AS (
SELECT
  p.workspace_id,
  p.job_id,
  count(*)                                            AS run_cluster_pairs,
  count(DISTINCT p.job_run_id)                        AS runs_with_worker_samples,
  count(DISTINCT p.cluster_id)                        AS clusters,
  sum(p.worker_samples)                               AS worker_samples,
  -- Pairs averaged over too few samples to be a mean. Returned rather than filtered on, so the floor
  -- stays a threshold in the ruleset and the surface can say how many runs it excluded.
  count_if(p.worker_samples < 3)                      AS pairs_below_three_samples,
  round(avg(p.avg_cpu), 2)                            AS avg_cpu_percent,
  round(max(p.peak_cpu), 2)                           AS peak_cpu_percent,
  round(avg(p.avg_cpu_wait), 2)                       AS avg_cpu_wait_percent,
  round(avg(p.avg_memory), 2)                         AS avg_memory_percent,
  round(max(p.peak_memory), 2)                        AS peak_memory_percent,
  round(avg(p.avg_swap), 2)                           AS avg_swap_percent,
  -- Rule D. The job's mean rate over its pairs that ran long enough to have one, the estate's median
  -- beside it, and how many pairs are behind each: a rate averaged over one pair is not the job's.
  round(avg(CASE WHEN p.node_minutes > 0 THEN p.network_bytes / p.node_minutes END))  AS network_bytes_per_node_minute,
  count_if(p.node_minutes > 0)                        AS pairs_with_a_network_rate,
  count_if(p.samples_stating_no_network = p.worker_samples) AS pairs_stating_no_network,
  round(max(e.median_bytes_per_node_minute))          AS estate_median_bytes_per_node_minute,
  max(e.pairs_with_a_rate)                            AS estate_pairs_with_a_rate,
  -- The node type where the as-of join resolved it, and how many of the job's pairs it resolved for.
  -- The second is what stops a name read off one pair being rendered as the job's compute.
  max(g.node_type)                                    AS node_type,
  count_if(g.node_type IS NOT NULL)                   AS pairs_with_an_as_of_config,
  max(g.worker_count)                                 AS worker_count,
  -- Rule G. A run whose setup figure is null is counted apart from one whose figure is zero: the
  -- first is unread and the second is a measured absence, which is ADR 0074 at the column.
  max(t.runs_with_no_setup_figure)                    AS runs_with_no_setup_figure,
  round(max(t.setup_seconds_max), 1)                  AS setup_seconds_max,
  round(max(t.setup_seconds_mean), 1)                 AS setup_seconds_mean,
  round(max(t.stated_run_seconds_mean), 1)            AS stated_run_seconds_mean,
  -- The window this reading covers, which is not the task timeline's. Rendered beside any duration
  -- trend, because the two tables retain for 94 days and 370.
  min(p.earliest_sample)                              AS earliest_sample,
  max(p.latest_sample)                                AS latest_sample,
  max(r.jobs_that_ran)                                AS jobs_that_ran,
  max(r.jobs_with_a_compute_id)                       AS jobs_with_a_compute_id,
  max(r.jobs_on_classic_compute)                      AS jobs_on_classic_compute
FROM pairs p
LEFT JOIN config g
  ON  g.workspace_id = p.workspace_id AND g.job_id = p.job_id
  AND g.job_run_id = p.job_run_id AND g.cluster_id = p.cluster_id
LEFT JOIN job_setup t
  ON  t.workspace_id = p.workspace_id AND t.job_id = p.job_id
CROSS JOIN reach r
CROSS JOIN estate e
GROUP BY p.workspace_id, p.job_id
)
SELECT
  -- Enumerated rather than `j.*` because the arity of the returned row is read from this list, by
  -- `columnsOf` and by the baseline test that holds a recording to the statement it was taken with.
  j.workspace_id,
  j.job_id,
  j.run_cluster_pairs,
  j.runs_with_worker_samples,
  j.clusters,
  j.worker_samples,
  j.pairs_below_three_samples,
  j.avg_cpu_percent,
  j.peak_cpu_percent,
  j.avg_cpu_wait_percent,
  j.avg_memory_percent,
  j.peak_memory_percent,
  j.avg_swap_percent,
  j.network_bytes_per_node_minute,
  j.pairs_with_a_network_rate,
  j.pairs_stating_no_network,
  j.estate_median_bytes_per_node_minute,
  j.estate_pairs_with_a_rate,
  j.node_type,
  j.pairs_with_an_as_of_config,
  j.worker_count,
  j.runs_with_no_setup_figure,
  j.setup_seconds_max,
  j.setup_seconds_mean,
  j.stated_run_seconds_mean,
  j.earliest_sample,
  j.latest_sample,
  j.jobs_that_ran,
  j.jobs_with_a_compute_id,
  j.jobs_on_classic_compute,
  -- Jobs the node join reached, counted before the limit applies, the way `job_run_health` returns
  -- its own. The fourth step of the funnel above and the denominator the sample is declared against.
  count(*) OVER () AS job_population
FROM per_job j
ORDER BY j.worker_samples DESC, j.job_id
LIMIT :job_limit
