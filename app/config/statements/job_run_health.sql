-- Signal: sql:workload.job_run_health
-- Rows: at most :job_limit
-- Benchmark: workload
--
-- One row per job that ran in the window, describing how long its runs took, how many finished, how
-- often a task inside one had to run again, and what the job billed. It feeds the job advisor's rules;
-- like the query shapes it scores nothing and cites no requirement.
--
-- Bounded rather than a row per job, ordered by total wall clock. That is the H1d lesson taken in
-- advance: `serverless_job_readiness` is a row per job and is 110% of an inline result at 100,000 jobs,
-- and the rules over this statement are about the jobs worth an operator's attention, so a declared
-- sample of the longest-running ones is the population rather than a truncation of it. Anything reading
-- this must say it read the top :job_limit by total time and not "the estate", and `job_population` is
-- what it says that against: the count before the limit, on every row.
--
-- ## Everything below is what `33ca` measured, and four of the five differ from the design document
--
-- The document this implements is `docs/design/automated_lakeflow_job_audit.md`. Its queries 1, 2, 6 and
-- 8 are what a serverless estate can answer — its rules A to D and G read compute relations that have no
-- row for serverless compute, and those live in `job_compute_utilisation.sql`. Rule E is the exception
-- and is why this statement carries three Photon counts: `50` found the field on the billing record
-- rather than the cluster configuration, which is a relation this statement already reads. What follows
-- is where this statement departs from those four queries, each time because the measurement said so.
--
-- **The stated durations are unusable, so every duration here is derived from the period columns.**
-- `run_duration_seconds`, `setup_duration_seconds` and `execution_duration_seconds` were written as **0
-- on all 44 runs** measured, not left null. The document says job-level duration "can be zero or
-- incomplete"; zero is the dangerous half of that, because a null is a value a reader notices and a zero
-- is one a rule divides by or reports as a run that took no time. `min(period_start_time)` to
-- `max(period_end_time)` works, and the run timeline and the task timeline agree on it to a mean of half
-- a second across those runs, five of them multi-task.
--
-- **Durations are never summed.** Both timelines emit a row per state period and repeat each duration on
-- all of them, so a run that queued, ran and finished carries its figures three times.
-- `serverless_job_readiness.sql` records this and `grain.ts` refuses a read that does not get down to one
-- thing. Window endpoints only — which is safe under the repetition where a sum is not.
--
-- **A repeat is counted at the task grain, because the document's query 8 counts rows.** That query takes
-- `count(*) - 1` over `job_run_timeline` grouped by run and calls the result retries. Measured, it
-- reports **0 retried runs on a workspace where 16 of 44 runs ran a task more than once**, 22 repeated
-- task runs in total and up to 3 in a single run: a retry does not add a run-level period, it adds a task
-- run. So a repeat here is a second task run for the same `task_key` inside one `job_run_id`, which is
-- the thing that is observable.
--
-- What that count may **not** be called is a retry count. Nothing distinguishes an automatic retry from a
-- manual repair from a task that appears twice for another reason, so the column is named for what it
-- measures and any sentence built on it has to stop there.
--
-- **Cost is summed over the records rather than read from one.** Billing carries retractions: a corrected
-- usage record is offset by a negative one rather than replaced, so `sum(usage_quantity)` is the figure
-- and a single row is one that was already known to be wrong. The retraction count comes back too, so a
-- reader can tell a settled figure from one still being corrected.
--
-- **The outcome is read from the terminal period per run.** Counting periods with a result state
-- overstates runs — 46 rows for 41 `JOB_RUN`s on the workspace measured, with five of the extras being
-- in-flight periods of runs that do have a terminal state.
--
-- ## What this statement cannot say
--
-- No worker utilisation, no cluster configuration and no Photon: `system.compute.node_timeline` returned
-- **no rows at all** and no run's compute id matched a `system.compute.clusters` row, because every run
-- measured was on serverless. `node_utilization.sql` reports the same emptiness from the other direction.
-- Nothing here may be presented as a sizing verdict.
--
-- No job name. `jobs_inventory` already carries it behind the SCD2 fix that a second reader of
-- `system.lakeflow.jobs` would have to repeat — it reported 69,361 live jobs where 13,365 existed when
-- that fix was absent — so the name is joined by the analysis, as `serverless.ts` already does.
--
-- Feeds: the job advisor. Analysis rather than assessment: nothing here can change a score or a finding.
-- One row per task run, its window collapsed to its endpoints. The grouping is in the same scope as the
-- read, not a CTE below it: `grain.ts` judges a read on its own scope's clauses, which is the correction
-- that caught the one genuinely wrong statement in this tree — a top-level read of a period table with the
-- collapsing done in a derived table it joined. Endpoints rather than sums is what makes the seconds a
-- measurement instead of a multiple of one, under a table that repeats each duration per state period.
WITH task_runs AS (
  SELECT
    workspace_id,
    job_id,
    job_run_id,
    run_id,
    task_key,
    min(period_start_time) AS task_start,
    max(period_end_time)   AS task_end,
    unix_timestamp(max(period_end_time)) - unix_timestamp(min(period_start_time)) AS task_seconds
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    -- Live workspaces only, as everywhere else: a cancelled workspace's runs are history.
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, job_id, job_run_id, run_id, task_key
),
-- One row per job run: its wall clock, how many tasks it had, and how many task runs those tasks took.
-- The gap between the last two is the repeat count, and it is the only form of it that is observable.
job_runs AS (
  SELECT
    workspace_id,
    job_id,
    job_run_id,
    unix_timestamp(max(task_end)) - unix_timestamp(min(task_start)) AS wall_seconds,
    max(task_seconds)              AS longest_task_seconds,
    sum(task_seconds)              AS task_seconds,
    count(DISTINCT task_key)       AS tasks,
    count(DISTINCT run_id)         AS task_runs,
    max(task_start)                AS last_task_start
  FROM task_runs
  GROUP BY workspace_id, job_id, job_run_id
),
-- The busiest task per job across the window, by total time. Query 2 returns the top ten task runs per
-- job; this reduces to one task and its total, because ten rows per job is ten times a payload already
-- measured too large, and the question a rule asks is which task the job spends its time in.
task_totals AS (
  SELECT
    workspace_id,
    job_id,
    task_key,
    sum(task_seconds) AS task_seconds,
    ROW_NUMBER() OVER (
      PARTITION BY workspace_id, job_id ORDER BY sum(task_seconds) DESC, task_key
    ) AS busiest
  FROM task_runs
  GROUP BY workspace_id, job_id, task_key
),
-- The outcome, from the last period each run wrote. A run's earlier periods carry no result state or an
-- interim one, so counting periods counts states a run passed through rather than the one it ended in.
run_outcomes AS (
  SELECT * FROM (
    SELECT
      workspace_id,
      job_id,
      run_id,
      run_type,
      result_state,
      termination_code,
      ROW_NUMBER() OVER (
        PARTITION BY workspace_id, job_id, run_id ORDER BY period_end_time DESC
      ) AS recency
    FROM system.lakeflow.job_run_timeline
    WHERE period_start_time >= current_date() - make_dt_interval(:lookback_days)
      AND (:workspace_id = '' OR workspace_id = :workspace_id)
      AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  )
  WHERE recency = 1
),
outcomes AS (
  SELECT
    workspace_id,
    job_id,
    -- Runs the run timeline wrote a terminal period for, which is not the same as runs that stated an
    -- outcome: the three counts below divide this one, and the third of them is the unknown. Named for the
    -- period rather than for a result because that is all count(*) here carries.
    count(*)                                                     AS runs_with_a_terminal_period,
    count_if(result_state = 'SUCCEEDED')                          AS runs_succeeded,
    count_if(result_state IS NOT NULL AND result_state <> 'SUCCEEDED') AS runs_did_not_succeed,
    -- A run whose terminal period still states no outcome. Reported rather than folded into either
    -- count: it is a run in flight or one the table has not finished writing, and both are unknown.
    count_if(result_state IS NULL)                                AS runs_unresolved,
    count_if(termination_code IS NOT NULL)                        AS runs_with_a_termination_code
  FROM run_outcomes
  GROUP BY workspace_id, job_id
),
-- Cost, summed over every record including the negative ones. `billing_origin_product = 'JOBS'` is the
-- document's own filter; `usage_metadata.job_id` is what attributes a record to a job.
--
-- The three Photon counts ride here rather than on `job_compute_utilisation.sql`, and that is `50`'s
-- finding rather than convenience. Whether Photon is off is not in `system.compute.clusters` at all —
-- that record has no such column — and the runtime version spells it on only 60.8% of the records, as
-- a positive-only signal: a version naming Photon says it is on, and a version not naming it is every
-- other runtime. `product_features.is_photon` is stated on 7,695 of 7,695 classic job usage records
-- and reaches 96.6% of the clusters rule E is about, against the 8.7% the as-of configuration join
-- resolves — so the rule is readable here and would be bounded by a join that mostly misses there.
-- No extra scan: these are the records the sum above already reads.
spend AS (
  SELECT
    workspace_id,
    usage_metadata.job_id                             AS job_id,
    sum(usage_quantity)                               AS usage_quantity,
    count(*)                                          AS usage_records,
    count_if(usage_quantity < 0)                      AS usage_retractions,
    count(DISTINCT sku_name)                          AS usage_skus,
    -- Serverless excluded on all three, because Photon is not a setting on serverless and a share
    -- taken over records that cannot have it states the rule's reach as better or worse than it is
    -- depending on the mix. Stated and off are separate counts for ADR 0074's reason: a record with
    -- no `is_photon` is unread, and only the difference between the two is a measured absence.
    count_if(NOT coalesce(product_features.is_serverless, FALSE)) AS classic_usage_records,
    count_if(NOT coalesce(product_features.is_serverless, FALSE)
             AND product_features.is_photon IS NOT NULL)          AS classic_records_stating_photon,
    count_if(NOT coalesce(product_features.is_serverless, FALSE)
             AND product_features.is_photon = FALSE)              AS classic_records_with_photon_off
  FROM system.billing.usage
  WHERE usage_start_time >= current_date() - make_dt_interval(:lookback_days)
    AND billing_origin_product = 'JOBS'
    AND usage_metadata.job_id IS NOT NULL
    AND (:workspace_id = '' OR workspace_id = :workspace_id)
    AND (:live_workspace_ids = '' OR array_contains(split(:live_workspace_ids, ','), workspace_id))
  GROUP BY workspace_id, usage_metadata.job_id
)
SELECT
  r.workspace_id,
  r.job_id,
  count(*)                                                  AS runs,
  round(sum(r.wall_seconds))                                AS wall_seconds_total,
  round(avg(r.wall_seconds), 1)                             AS wall_seconds_mean,
  -- p95 rather than the mean alone, so an occasional pathological run is visible without one outlier
  -- deciding the reading. Both are returned because a rule that fires on the gap between them is
  -- describing something different from one that fires on either.
  round(percentile(r.wall_seconds, 0.95), 1)                AS wall_seconds_p95,
  round(percentile(r.wall_seconds, 0.50), 1)                AS wall_seconds_median,
  max(r.wall_seconds)                                       AS wall_seconds_max,
  max(r.longest_task_seconds)                               AS longest_task_seconds,
  round(sum(r.task_seconds))                                AS task_seconds_total,
  max(r.tasks)                                              AS tasks_most,
  -- Runs in which some task ran more than once, and how many extra task runs that came to. Not a retry
  -- count: nothing here distinguishes an automatic retry from a repair.
  count_if(r.task_runs > r.tasks)                           AS runs_with_a_repeated_task,
  sum(r.task_runs - r.tasks)                                AS repeated_task_runs,
  max(r.last_task_start)                                    AS last_run,
  max(b.task_key)                                           AS busiest_task_key,
  round(max(b.task_seconds))                                AS busiest_task_seconds,
  max(o.runs_with_a_terminal_period)                        AS runs_with_a_terminal_period,
  max(o.runs_succeeded)                                     AS runs_succeeded,
  max(o.runs_did_not_succeed)                               AS runs_did_not_succeed,
  max(o.runs_unresolved)                                    AS runs_unresolved,
  max(o.runs_with_a_termination_code)                       AS runs_with_a_termination_code,
  max(s.usage_quantity)                                     AS usage_quantity,
  max(s.usage_records)                                      AS usage_records,
  max(s.usage_retractions)                                  AS usage_retractions,
  max(s.usage_skus)                                         AS usage_skus,
  max(s.classic_usage_records)                              AS classic_usage_records,
  max(s.classic_records_stating_photon)                     AS classic_records_stating_photon,
  max(s.classic_records_with_photon_off)                    AS classic_records_with_photon_off,
  -- Jobs that ran in the window, counted before the limit applies, the way
  -- `workload_warehouse_pressure` returns its warehouse population. Without it a reader has the sample's
  -- size and no denominator to declare it against, which is the "must not say the estate" bound above
  -- with nothing available to keep it: a page can only disclose a cap it can see bite.
  count(*) OVER ()                                          AS job_population
FROM job_runs r
LEFT JOIN task_totals b
  ON b.workspace_id = r.workspace_id AND b.job_id = r.job_id AND b.busiest = 1
LEFT JOIN outcomes o
  ON o.workspace_id = r.workspace_id AND o.job_id = r.job_id
LEFT JOIN spend s
  ON s.workspace_id = r.workspace_id AND s.job_id = r.job_id
-- Named rather than positional, because H1c can execute a statement one workspace at a time and that is
-- only exact if every grouping key includes workspace_id.
GROUP BY r.workspace_id, r.job_id
ORDER BY wall_seconds_total DESC, r.job_id
LIMIT :job_limit
