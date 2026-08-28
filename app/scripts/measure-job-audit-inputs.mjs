// What the job and cluster audit can actually see on a real workspace. Ledger row `33ca`.
//
// `33cb` to `33cd` build the eight rules of `docs/design/automated_lakeflow_job_audit.md` — four of them
// (A to D) thresholds over per-run worker utilisation, which nothing in this repository has looked at at that
// grain. This script looks, before any of it is written.
//
// It exists because the query half tested two premises and both were wrong in a way that changed the build.
// `33id` measured the skew ratio the advisor document specifies and found it non-zero on 23 of 27 plans, so a
// rule on it would have reported skew across most of the estate. `33iga` measured the statistics signal the
// same document names and found `DESCRIBE EXTENDED` reporting a `Statistics` row on seven tables nothing had
// ever analysed. Neither was caught by reading; both were caught by measuring. The numbers behind rules A to D
// are of the same kind and have the same standing.
//
// Eight questions, each of which decides something about the next three rows. Several can end a rule.
//
//   1. Does the run-window join reach anything? Query 4 joins task windows to `node_timeline` on cluster id.
//      A run on serverless compute has no node timeline, so the share of runs the join reaches is the ceiling
//      on rules A to D — all four of them, at once.
//   2. Is `compute_ids` still populated? The document's queries 3 and 4 explode it. This app already knows
//      something the document does not: `system.lakeflow.job_task_run_timeline` gained a `compute` struct
//      array in December 2025, and `serverless_job_readiness.sql` reads `compute_ids` only as the older
//      spelling. If new rows carry `compute` and not `compute_ids`, the document's own queries return nothing
//      on a current workspace.
//   3. Is the CPU claim reproducible, and at which grain? "44% of node-minutes across 6,534 clusters sit below
//      10% CPU" is every cluster in the estate including drivers and interactive ones. Rules A to D are per job
//      run, workers only. Those are different populations and only the second can set a threshold.
//   4. How many jobs clear the three-run guardrail (line 493)? If most jobs are ad-hoc this decides what the
//      audit covers, not merely how confident it is.
//   5. Is job-level duration really unusable (line 47)? If it is usable, the wall-clock derivation from the
//      task timeline is a join the app would not need.
//   6. Does the as-of cluster configuration join find a row (line 61)? An ephemeral job cluster may have one
//      configuration record, and it may be written after the run started.
//   7. What do the four utilisation distributions look like at the rules' own grain — CPU, memory, swap and
//      CPU-wait, per run, workers only? This plan has already found one of the document's numbers unusable:
//      `mem_swap_percent > 0` fires on 95% of node-minutes because the column has a nonzero baseline.
//   8. What is the retention window really (line 43: 90 days against the jobs tables' 365)? A utilisation rule
//      whose window is shorter than the duration trend's cannot be reported beside it without saying so.
//
// Nothing here is a collector and nothing here ships. Every statement is bounded, reads system tables only,
// and reads no query text or table contents.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=your-profile \
//        node scripts/measure-job-audit-inputs.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-job-audit-inputs.json`, and `41b` is why the estate is
// in that name rather than hard-coded to labs. Every reading below is a fact about the workspace it was taken
// from — rules A to E have no input on labs and may have one elsewhere, which is the entire reason to run this
// twice — so a fixed path means the second run silently replaces the recording the first run's conclusions were
// derived from, leaving two estates' numbers indistinguishable and one of them gone.
//
// The name comes from the profile, and two guards check that the name is true, because the name is the only
// thing keeping the two recordings apart and nothing else in this script would notice it being wrong. They are
// in `recording-guards.mjs`, which is where `41d` lifted them when a second script began recording per estate.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  HERE,
  '..',
  'server',
  'collect',
  'sql',
  'runtime-baseline',
  `${corpusSettings.profile}-job-audit-inputs.json`
);

/**
 * The window every question but the last is asked over.
 *
 * Thirty days because that is what the document's queries use and what the app's own lookback defaults to, so
 * a number here is comparable with one from a shipped statement. Question 8 asks a wider one on purpose.
 */
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/** The wider window, for the retention question only. */
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 400);

/**
 * The task timeline's one row per state period, reduced to one row per task run.
 *
 * Not the document's `GROUP BY ALL` over the raw rows, and the difference is a defect this app already paid
 * for: `serverless_job_readiness.sql` records that the timeline repeats a task run's durations on every state
 * period, so a run that queued, ran and finished carries its setup time three times. Taking the window
 * endpoints — `min(period_start_time)` to `max(period_end_time)` — is safe under that repetition where summing
 * anything is not, and it is what the document's query 1 does. This fragment is shared by every question below
 * that needs a run so all of them are asking about the same runs.
 */
export const TASK_RUNS = `
  SELECT
    workspace_id,
    job_id,
    job_run_id,
    run_id AS task_run_id,
    task_key,
    min(period_start_time) AS task_start,
    max(period_end_time)   AS task_end,
    max(compute_ids)       AS compute_ids,
    max(compute)           AS compute
  FROM system.lakeflow.job_task_run_timeline
  WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
  GROUP BY ALL
`;

/**
 * The compute ids a task run used, from whichever of the two spellings carries one.
 *
 * The first version of this fragment preferred `compute` outright, because it is the newer column and carries
 * the kind. That was wrong, and the measurement caught it: on this workspace every row populates *both*
 * columns, but `compute`'s `cluster_id` and `warehouse_id` are both null on all 71 of them — the kind is
 * `SERVERLESS_COMPUTE` and the id lives only in `compute_ids`. Preferring the struct exploded an array of
 * nulls, which produced 44 run-compute pairs that could never match anything and a reach of zero that would
 * have read as a fact about the estate instead of about this fragment.
 *
 * So: the struct's ids where it has any, `compute_ids` where it does not, and the kind kept alongside either
 * way. `serverless_job_readiness.sql` reaches the same conclusion from the other direction and is worth reading
 * next to this.
 */
/**
 * The same fragment restricted to the compute a cluster rule is about.
 *
 * Added in `41b`'s review, and it is the apparatus error the review caught: the fragment below coalesces
 * `warehouse_id` and falls back to `compute_ids`, which is where a *serverless* task run's id lives — labs proved
 * it, 71 serverless task-computes with no cluster id at all still producing 58 "run-cluster pairs". So a share
 * computed over every pair is a share over a population that mostly cannot have a cluster configuration or a
 * cluster setup phase, and reporting it as what a cluster rule can see states the rule's reach as far worse than
 * it is. Rule G is about classic clusters; this asks about those.
 *
 * Exported, with `TASK_RUNS`, so `measure-job-rule-inputs.mjs` asks rules D and E about the population this
 * script's readings describe. A second copy of the fragment is two populations that look like one, which is
 * `33ii`'s lesson about the apparatus applied to the apparatus being shared.
 */
export const CLASSIC_TASK_CLUSTERS = `
  WITH task_runs AS (${TASK_RUNS}),
  classic AS (
    SELECT
      workspace_id, job_id, job_run_id, task_run_id, task_key, task_start, task_end,
      explode(
        filter(transform(coalesce(compute, array()), c -> CASE WHEN c.type = 'CLASSIC_COMPUTE' THEN c.cluster_id END),
               id -> id IS NOT NULL)
      ) AS cluster_id
    FROM task_runs
  )
  SELECT * FROM classic
`;

const TASK_CLUSTERS = `
  WITH task_runs AS (${TASK_RUNS}),
  ids AS (
    SELECT
      workspace_id,
      job_id,
      job_run_id,
      task_run_id,
      task_key,
      task_start,
      task_end,
      filter(
        transform(coalesce(compute, array()), c -> coalesce(c.cluster_id, c.warehouse_id)),
        id -> id IS NOT NULL
      ) AS stated_ids,
      coalesce(compute_ids, array()) AS fallback_ids
    FROM task_runs
  )
  SELECT
    workspace_id, job_id, job_run_id, task_run_id, task_key, task_start, task_end,
    explode(CASE WHEN size(stated_ids) > 0 THEN stated_ids ELSE fallback_ids END) AS cluster_id
  FROM ids
`;

/** Whether a statement runs and what it says, without assuming either. */
export async function probe(label, statement) {
  try {
    return { label, ok: true, rows: await runStatement(statement) };
  } catch (error) {
    return { label, ok: false, error: String(error).slice(0, 400) };
  }
}

/** The one row a summary probe returns, or nothing where it failed. */
export function only(probes, label) {
  const found = probes.find((one) => one.label === label);
  return found?.ok === true ? (found.rows[0] ?? null) : null;
}

/**
 * A number out of a probe's row, or `null`.
 *
 * `null` and not `0`, for the reason `33iga`'s review found the hard way: a derived count computed from a probe
 * that failed reads as a measurement of the estate when it is a measurement of the apparatus.
 */
export function count(row, key) {
  const value = row?.[key];
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * A share, and — where there isn't one — which of the two reasons there isn't.
 *
 * The distinction is the whole point, and the first run of this script got it wrong: it printed "unknown — its
 * probe failed" against three readings whose probes had all succeeded and found an empty population, which is
 * the opposite finding. "The apparatus could not look" and "the apparatus looked and there is nothing there"
 * are facts about different things, and only the second is a measurement of the estate.
 */
export function share(part, whole) {
  if (part == null || whole == null) {
    return { share: null, of: whole, unknown: 'the probe returned no counts' };
  }
  if (whole === 0) {
    return { share: null, of: 0, unknown: 'the probe ran and this workspace has none of these' };
  }
  return { share: Math.round((part / whole) * 1000) / 1000, of: whole, unknown: null };
}

/** How one reading reads on one line. */
export function said(reading) {
  return reading.unknown == null
    ? `${String(reading.share)} of ${String(reading.of)}`
    : `no reading — ${reading.unknown}`;
}

async function main() {
  // Before the probes, not after: a scan of a large shared estate that ends in a refusal to write is a read
  // taken off somebody else's warehouse for nothing.
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const probes = [
    // Question 2 first, because the answer changes the reach query the rest depends on. Both spellings counted
    // over the same rows, so "one is empty" is distinguishable from "this workspace has no job runs".
    await probe(
      'which spelling of the compute column is populated',
      `SELECT
         count(*)                                                        AS timeline_rows,
         count_if(compute_ids IS NOT NULL AND size(compute_ids) > 0)      AS rows_with_compute_ids,
         count_if(compute IS NOT NULL AND size(compute) > 0)              AS rows_with_compute_struct,
         count_if(coalesce(size(compute_ids), 0) = 0 AND coalesce(size(compute), 0) = 0) AS rows_with_neither,
         min(period_start_time)                                          AS earliest,
         max(period_start_time)                                          AS latest
       FROM system.lakeflow.job_task_run_timeline
       WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})`
    ),

    // Question 1. The reach of the join rules A to D stand on, counted at three grains because a rule fires per
    // job and the guardrail counts runs. A LEFT JOIN so the unmatched side is countable rather than absent.
    await probe(
      'how far the run-window worker join reaches',
      `WITH task_clusters AS (${TASK_CLUSTERS}),
       matched AS (
         SELECT
           t.job_id,
           t.job_run_id,
           t.cluster_id,
           count(n.cluster_id) AS worker_samples
         FROM task_clusters t
         LEFT JOIN system.compute.node_timeline n
           ON  n.workspace_id = t.workspace_id
           AND n.cluster_id   = t.cluster_id
           AND n.start_time   < t.task_end
           AND n.end_time     > t.task_start
           AND n.driver       = FALSE
         GROUP BY ALL
       )
       SELECT
         count(*)                                                          AS run_cluster_pairs,
         count_if(worker_samples > 0)                                      AS pairs_with_worker_samples,
         count(DISTINCT job_id)                                            AS jobs,
         count(DISTINCT CASE WHEN worker_samples > 0 THEN job_id END)      AS jobs_with_worker_samples,
         count(DISTINCT job_run_id)                                        AS runs,
         count(DISTINCT CASE WHEN worker_samples > 0 THEN job_run_id END)  AS runs_with_worker_samples,
         sum(worker_samples)                                               AS worker_samples
       FROM matched`
    ),

    // What kind of compute those ids name. Added after the first run, which found 44 run-cluster pairs and not
    // one node sample against any of them — a result with two very different explanations. If the ids are
    // warehouse or serverless ids then rules A to D are not degraded here, they are inapplicable to this
    // compute, and the audit has to say which of the two it is. `compute.type` says directly.
    await probe(
      'what kind of compute the job runs used',
      `WITH task_runs AS (${TASK_RUNS}),
       kinds AS (
         SELECT
           job_run_id,
           explode(coalesce(compute, array())) AS one
         FROM task_runs
       )
       SELECT
         coalesce(one.type, 'unstated')          AS kind,
         count(*)                                AS task_computes,
         count(DISTINCT job_run_id)              AS runs,
         count_if(one.cluster_id IS NOT NULL)    AS with_a_cluster_id,
         count_if(one.warehouse_id IS NOT NULL)  AS with_a_warehouse_id
       FROM kinds
       GROUP BY ALL
       ORDER BY task_computes DESC`
    ),

    // Whether the two compute relations hold anything at all, bounded so this stays cheap on an estate where
    // they hold a great deal. A relation that is readable and empty is a different finding from one that is
    // unreadable, and both are different from one that has rows none of which match.
    await probe(
      'whether the compute relations hold anything at all',
      `SELECT 'node_timeline' AS relation, count(*) AS rows_in_first_thousand
       FROM (SELECT 1 FROM system.compute.node_timeline LIMIT 1000)
       UNION ALL
       SELECT 'clusters', count(*)
       FROM (SELECT 1 FROM system.compute.clusters LIMIT 1000)`
    ),

    // Question 3, first half: the claim as made. Every node sample in the window, drivers included, no job
    // attribution — which is the population "44% of node-minutes below 10% CPU" was read off.
    await probe(
      'the CPU claim as made, over every node sample',
      `SELECT
         count(*)                                                     AS node_samples,
         count(DISTINCT cluster_id)                                   AS clusters,
         count_if(driver)                                             AS driver_samples,
         round(avg(cpu_user_percent + cpu_system_percent), 2)         AS mean_cpu_percent,
         count_if(cpu_user_percent + cpu_system_percent < 10)         AS samples_below_10_percent,
         count_if(cpu_user_percent + cpu_system_percent < 30)         AS samples_below_30_percent,
         min(start_time)                                              AS earliest,
         max(start_time)                                              AS latest
       FROM system.compute.node_timeline
       WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})`
    ),

    // Question 3, second half, and question 7. The rules' own grain: one row per job run per cluster, workers
    // only, averaged over the samples inside the run window — then the distribution over those rows. This is
    // the population a threshold in `33cc` has to come from, and the deciles are so that a threshold can be
    // read off it rather than argued.
    await probe(
      'the four utilisation distributions at the rules’ own grain',
      `WITH task_clusters AS (${TASK_CLUSTERS}),
       per_run AS (
         SELECT
           t.job_id,
           t.job_run_id,
           t.cluster_id,
           avg(n.cpu_user_percent + n.cpu_system_percent) AS avg_cpu,
           max(n.cpu_user_percent + n.cpu_system_percent) AS peak_cpu,
           avg(n.cpu_wait_percent)                        AS avg_cpu_wait,
           avg(n.mem_used_percent)                        AS avg_memory,
           max(n.mem_used_percent)                        AS peak_memory,
           avg(n.mem_swap_percent)                        AS avg_swap,
           count(*)                                       AS samples
         FROM task_clusters t
         JOIN system.compute.node_timeline n
           ON  n.workspace_id = t.workspace_id
           AND n.cluster_id   = t.cluster_id
           AND n.start_time   < t.task_end
           AND n.end_time     > t.task_start
           AND n.driver       = FALSE
         GROUP BY ALL
       )
       SELECT
         count(*)                                                        AS run_cluster_pairs,
         round(avg(samples), 1)                                          AS mean_samples_per_pair,
         count_if(samples < 3)                                           AS pairs_with_under_three_samples,
         percentile(avg_cpu,      array(0.1, 0.25, 0.5, 0.75, 0.9, 0.95)) AS avg_cpu_percentiles,
         percentile(peak_cpu,     array(0.5, 0.9, 0.95))                  AS peak_cpu_percentiles,
         percentile(avg_cpu_wait, array(0.5, 0.9, 0.95))                  AS avg_cpu_wait_percentiles,
         percentile(avg_memory,   array(0.1, 0.25, 0.5, 0.75, 0.9, 0.95)) AS avg_memory_percentiles,
         percentile(peak_memory,  array(0.5, 0.9, 0.95))                  AS peak_memory_percentiles,
         percentile(avg_swap,     array(0.5, 0.9, 0.95))                  AS avg_swap_percentiles,
         count_if(avg_cpu < 30)                                          AS pairs_under_30_cpu,
         count_if(avg_cpu < 40)                                          AS pairs_under_40_cpu,
         count_if(avg_memory < 50)                                       AS pairs_under_50_memory,
         count_if(avg_cpu < 40 AND avg_memory < 50)                      AS pairs_rule_a_would_consider,
         count_if(avg_memory > 70)                                       AS pairs_rule_b_would_consider,
         count_if(avg_cpu > 80 AND avg_memory < 60)                      AS pairs_rule_c_would_consider,
         count_if(avg_swap > 0)                                          AS pairs_with_any_swap,
         count_if(avg_swap > 5)                                          AS pairs_with_swap_over_5
       FROM per_run`
    ),

    // Question 4. The guardrail's own number, and the distribution behind it — a mean would hide an estate of
    // one hourly job and two hundred one-offs, which is the shape that decides whether the guardrail is a
    // confidence measure or a coverage limit.
    await probe(
      'how many jobs clear the three-run guardrail',
      `WITH task_runs AS (${TASK_RUNS}),
       per_job AS (
         SELECT job_id, count(DISTINCT job_run_id) AS runs
         FROM task_runs
         GROUP BY ALL
       )
       SELECT
         count(*)                                            AS jobs,
         count_if(runs >= 3)                                 AS jobs_with_three_runs,
         count_if(runs = 1)                                  AS jobs_run_once,
         sum(runs)                                           AS runs,
         percentile(runs, array(0.5, 0.75, 0.9, 0.95))       AS runs_percentiles,
         max(runs)                                           AS most_runs
       FROM per_job`
    ),

    // Question 5. Whether the run timeline's own duration agrees with the wall clock derived from the tasks. A
    // disagreement is the document's claim confirmed; agreement means the derivation is avoidable work.
    await probe('what the run timeline carries', `DESCRIBE system.lakeflow.job_run_timeline`),
    // Two questions, and the first version of this asked one label over the other's SQL. It was labelled "whether
    // job-level duration agrees with the task-derived wall clock" and it derived the run's duration from the run
    // timeline's *period* columns, then compared that with the same derivation over the task timeline — two
    // derived wall clocks, which agreed to half a second, which the label read as the stated duration being
    // usable. It is not: the probe below reads `run_duration_seconds` itself and finds it zero on all 44 runs.
    // Both comparisons are worth having; only one of them was being reported.
    await probe(
      'whether the stated per-run durations are populated',
      `SELECT
         count(DISTINCT run_id)                                              AS runs,
         count(DISTINCT CASE WHEN run_duration_seconds IS NULL THEN run_id END)   AS runs_with_null_total,
         count(DISTINCT CASE WHEN run_duration_seconds = 0 THEN run_id END)       AS runs_with_zero_total,
         count(DISTINCT CASE WHEN run_duration_seconds > 0 THEN run_id END)       AS runs_with_a_total,
         count(DISTINCT CASE WHEN setup_duration_seconds IS NULL THEN run_id END) AS runs_with_null_setup,
         count(DISTINCT CASE WHEN setup_duration_seconds > 0 THEN run_id END)     AS runs_with_a_setup,
         count(DISTINCT CASE WHEN execution_duration_seconds > 0 THEN run_id END) AS runs_with_an_execution
       FROM system.lakeflow.job_run_timeline
       WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})`
    ),
    await probe(
      'whether the run timeline’s periods agree with the task timeline’s',
      `WITH task_runs AS (${TASK_RUNS}),
       derived AS (
         SELECT
           workspace_id,
           job_id,
           job_run_id,
           unix_timestamp(max(task_end)) - unix_timestamp(min(task_start)) AS derived_seconds,
           count(DISTINCT task_key)                                        AS tasks
         FROM task_runs
         GROUP BY ALL
       ),
       from_the_run_timeline AS (
         SELECT
           workspace_id,
           job_id,
           run_id AS job_run_id,
           unix_timestamp(max(period_end_time)) - unix_timestamp(min(period_start_time)) AS run_timeline_seconds
         FROM system.lakeflow.job_run_timeline
         WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
         GROUP BY ALL
       )
       SELECT
         count(*)                                                       AS runs,
         count_if(r.job_run_id IS NULL)                                 AS runs_absent_from_the_run_timeline,
         count_if(d.tasks > 1)                                          AS multi_task_runs,
         round(avg(abs(coalesce(r.run_timeline_seconds, 0) - d.derived_seconds)), 1) AS mean_absolute_difference_seconds,
         count_if(abs(coalesce(r.run_timeline_seconds, 0) - d.derived_seconds) > 60) AS runs_over_a_minute_apart,
         percentile(d.derived_seconds, array(0.5, 0.9, 0.95))            AS derived_seconds_percentiles
       FROM derived d
       LEFT JOIN from_the_run_timeline r USING (workspace_id, job_id, job_run_id)`
    ),

    // Question 6. Whether an as-of configuration exists for the clusters job runs used, and how often the only
    // record is written after the run began — which is the ephemeral-cluster case the document waves at.
    await probe(
      'whether the as-of cluster configuration join finds a row',
      `WITH task_clusters AS (${TASK_CLUSTERS}),
       runs AS (
         SELECT workspace_id, job_id, job_run_id, cluster_id, min(task_start) AS run_start
         FROM task_clusters
         GROUP BY ALL
       ),
       config AS (
         SELECT workspace_id, cluster_id, min(change_time) AS earliest_change, count(*) AS records
         FROM system.compute.clusters
         WHERE change_time >= current_timestamp() - make_dt_interval(${String(RETENTION_DAYS)})
         GROUP BY ALL
       )
       SELECT
         count(*)                                                        AS run_cluster_pairs,
         count_if(c.cluster_id IS NOT NULL)                              AS pairs_with_any_config,
         count_if(c.earliest_change <= r.run_start)                      AS pairs_with_an_as_of_config,
         count_if(c.cluster_id IS NOT NULL AND c.earliest_change > r.run_start) AS pairs_whose_only_config_postdates_the_run,
         round(avg(c.records), 2)                                        AS mean_config_records_per_cluster,
         count_if(c.records > 1)                                         AS pairs_on_a_reconfigured_cluster
       FROM runs r
       LEFT JOIN config c USING (workspace_id, cluster_id)`
    ),

    // The three inputs the *other* half of the audit needs — queries 6 and 8 and rule G. Added after the first
    // run, which found rules A to E have no input on this estate at all: if the rest is equally unreachable then
    // `33cb` has nothing to collect and the whole of H6c is blocked, and that is a different finding from four
    // rules being blocked. Asked now because it is three cheap probes and it decides the next three rows.
    // One row per run before anything is counted. The first version of this probe counted `job_run_timeline`
    // rows and called them runs, which is the period-grain error `grain.ts` exists to catch and which this same
    // script's `TASK_RUNS` fragment already avoids on the sibling table: a run that queued, ran and finished is
    // three rows there, so "46 runs, 28 of which did not succeed" was a count of state periods wearing a run's
    // label. Taking the terminal period per run is what `serverless_job_readiness.sql` does and for this reason.
    await probe(
      'whether retry and repair overhead is readable',
      `WITH periods AS (
         SELECT
           run_type, run_id, job_id, result_state, termination_code,
           ROW_NUMBER() OVER (
             PARTITION BY workspace_id, job_id, run_id ORDER BY period_end_time DESC
           ) AS recency
         FROM system.lakeflow.job_run_timeline
         WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
       ),
       runs AS (SELECT * FROM periods WHERE recency = 1)
       SELECT
         coalesce(run_type, 'unstated')                          AS run_type,
         count(*)                                                AS runs,
         count(DISTINCT job_id)                                  AS jobs,
         count_if(result_state = 'SUCCEEDED')                    AS succeeded,
         count_if(result_state <> 'SUCCEEDED')                    AS did_not_succeed,
         count_if(result_state IS NULL)                          AS result_unstated,
         count_if(termination_code IS NOT NULL)                  AS with_a_termination_code
       FROM runs
       GROUP BY ALL
       ORDER BY runs DESC`
    ),
    await probe(
      'whether the timing rule G needs is populated',
      `WITH runs AS (
         SELECT
           workspace_id, job_id, run_id,
           max(setup_duration_seconds)     AS setup_seconds,
           max(queue_duration_seconds)     AS queue_seconds,
           max(execution_duration_seconds) AS execution_seconds,
           max(run_duration_seconds)       AS run_seconds
         FROM system.lakeflow.job_run_timeline
         WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
         GROUP BY ALL
       )
       SELECT
         count(*)                                                    AS runs,
         count_if(setup_seconds IS NULL)                             AS runs_with_no_setup_figure,
         count_if(run_seconds IS NULL OR run_seconds = 0)             AS runs_with_no_total,
         round(avg(setup_seconds), 1)                                AS mean_setup_seconds,
         percentile(setup_seconds, array(0.5, 0.9, 0.95))             AS setup_percentiles,
         percentile(run_seconds, array(0.5, 0.9, 0.95))               AS total_percentiles,
         count_if(run_seconds > 0 AND setup_seconds / run_seconds > 0.25) AS runs_over_a_quarter_setup,
         count_if(run_seconds > 0 AND setup_seconds / run_seconds > 0.5)  AS runs_over_half_setup
       FROM runs`
    ),
    // Both sides of the cost reading in one statement. The share was first computed by dividing this probe's
    // distinct job count by the *guardrail* probe's, which reads a different table over a different window and
    // does not have to be the same job set — so the reading could exceed 1 and would have been unfalsifiable
    // either way. A numerator and a denominator belong to one population or they are not a share.
    await probe(
      'whether job cost is readable',
      `WITH task_runs AS (${TASK_RUNS}),
       ran AS (SELECT DISTINCT workspace_id, job_id FROM task_runs),
       billed AS (
         SELECT
           workspace_id,
           usage_metadata.job_id                       AS job_id,
           count(*)                                    AS usage_records,
           count(DISTINCT sku_name)                    AS skus,
           count_if(usage_metadata.job_run_id IS NOT NULL) AS records_naming_a_run,
           sum(usage_quantity)                         AS quantity,
           count_if(usage_quantity < 0)                AS retraction_records
         FROM system.billing.usage
         WHERE usage_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
           AND billing_origin_product = 'JOBS'
           AND usage_metadata.job_id IS NOT NULL
         GROUP BY ALL
       )
       SELECT
         count(*)                                      AS jobs_that_ran,
         count_if(b.job_id IS NOT NULL)                AS jobs_with_usage,
         sum(coalesce(b.usage_records, 0))             AS usage_records,
         sum(coalesce(b.records_naming_a_run, 0))      AS records_naming_a_run,
         max(b.skus)                                   AS most_skus_on_one_job,
         round(sum(coalesce(b.quantity, 0)), 2)        AS total_quantity,
         sum(coalesce(b.retraction_records, 0))        AS retraction_records
       FROM ran r
       LEFT JOIN billed b USING (workspace_id, job_id)`
    ),

    // Rule A's five conditions, one at a time, because two of them in isolation are not the rule. The review of
    // this row's first pass caught the write-up reporting `pairs_rule_a_would_consider` — CPU and memory only —
    // as "rule A as written", where the document (line 497) also requires three completed runs, a p95 runtime
    // above the audit threshold, and no meaningful swap or I/O-wait signal. Stepwise so the attrition is visible
    // and no single number has to stand for the conjunction. Per job, which is the grain the rule fires at.
    await probe(
      'how many jobs rule A’s documented conditions actually select',
      `WITH task_clusters AS (${TASK_CLUSTERS}),
       per_run AS (
         SELECT
           t.job_id,
           t.job_run_id,
           unix_timestamp(max(t.task_end)) - unix_timestamp(min(t.task_start)) AS run_seconds,
           avg(n.cpu_user_percent + n.cpu_system_percent) AS avg_cpu,
           avg(n.cpu_wait_percent)                        AS avg_cpu_wait,
           avg(n.mem_used_percent)                        AS avg_memory,
           avg(n.mem_swap_percent)                        AS avg_swap,
           count(*)                                       AS samples
         FROM task_clusters t
         JOIN system.compute.node_timeline n
           ON  n.workspace_id = t.workspace_id
           AND n.cluster_id   = t.cluster_id
           AND n.start_time   < t.task_end
           AND n.end_time     > t.task_start
           AND n.driver       = FALSE
         GROUP BY ALL
       ),
       per_job AS (
         SELECT
           job_id,
           count(DISTINCT job_run_id)              AS runs,
           percentile(run_seconds, 0.95)           AS p95_seconds,
           avg(avg_cpu)                            AS avg_cpu,
           avg(avg_memory)                         AS avg_memory,
           max(avg_swap)                           AS worst_swap,
           max(avg_cpu_wait)                       AS worst_cpu_wait,
           min(samples)                            AS fewest_samples
         FROM per_run
         GROUP BY ALL
       )
       SELECT
         count(*)                                                              AS jobs_with_worker_samples,
         count_if(runs >= 3)                                                   AS and_three_runs,
         count_if(runs >= 3 AND p95_seconds > 1800)                            AS and_p95_over_the_threshold,
         count_if(runs >= 3 AND p95_seconds > 1800 AND avg_cpu < 40)           AS and_cpu_under_40,
         count_if(runs >= 3 AND p95_seconds > 1800 AND avg_cpu < 40 AND avg_memory < 50) AS and_memory_under_50,
         count_if(
           runs >= 3 AND p95_seconds > 1800 AND avg_cpu < 40 AND avg_memory < 50
           AND worst_swap <= 5 AND worst_cpu_wait <= 5
         )                                                                     AS and_no_meaningful_swap_or_wait,
         count_if(
           runs >= 3 AND p95_seconds > 1800 AND avg_cpu < 40 AND avg_memory < 50
           AND worst_swap <= 5 AND worst_cpu_wait <= 5 AND fewest_samples >= 3
         )                                                                     AS and_three_samples_a_run,
         count_if(avg_cpu < 40 AND avg_memory < 50)                            AS the_two_thresholds_alone
       FROM per_job`
    ),

    // Rule G, over the compute rule G is about. Its first pass asked both halves over every run and every pair,
    // 85% of which are serverless or warehouse and can have neither a cluster configuration nor a cluster setup
    // phase — so "1.0%" and "0.2%" were shares of a population the rule does not apply to.
    await probe(
      'whether rule G’s inputs exist for classic job clusters',
      `WITH classic AS (${CLASSIC_TASK_CLUSTERS}),
       runs AS (
         SELECT workspace_id, job_id, job_run_id, cluster_id, min(task_start) AS run_start
         FROM classic
         GROUP BY ALL
       ),
       config AS (
         SELECT workspace_id, cluster_id, min(change_time) AS earliest_change, count(*) AS records
         FROM system.compute.clusters
         WHERE change_time >= current_timestamp() - make_dt_interval(${String(RETENTION_DAYS)})
         GROUP BY ALL
       ),
       timings AS (
         SELECT
           workspace_id, job_id, run_id,
           max(setup_duration_seconds) AS setup_seconds,
           max(run_duration_seconds)   AS run_seconds
         FROM system.lakeflow.job_run_timeline
         WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
         GROUP BY ALL
       )
       SELECT
         count(*)                                                              AS classic_run_cluster_pairs,
         count(DISTINCT r.job_run_id)                                          AS classic_runs,
         count_if(c.cluster_id IS NOT NULL)                                    AS pairs_with_any_config,
         count_if(c.earliest_change <= r.run_start)                            AS pairs_with_an_as_of_config,
         count_if(c.cluster_id IS NOT NULL AND c.earliest_change > r.run_start) AS pairs_whose_only_config_postdates_the_run,
         count_if(t.setup_seconds > 0)                                         AS pairs_with_a_setup_figure,
         count_if(t.setup_seconds > 0 AND t.run_seconds > 0 AND t.setup_seconds / t.run_seconds > 0.25) AS pairs_over_a_quarter_setup
       FROM runs r
       LEFT JOIN config c USING (workspace_id, cluster_id)
       LEFT JOIN timings t ON t.workspace_id = r.workspace_id AND t.run_id = r.job_run_id`
    ),

    // Whether `system.compute.clusters` not matching is an absence or a limit on what this reader can see. ADR
    // 0074's rule applied to our own measurement: the same cluster ids resolve in `node_timeline`, so "no
    // configuration record" and "no configuration record visible to this identity" are the two explanations and
    // only a neighbour reading distinguishes them. Both tables counted over the same window at the same grain.
    await probe(
      'whether the cluster configuration table sees what the node timeline sees',
      `SELECT
         'clusters' AS relation,
         count(*)                        AS rows_in_window,
         count(DISTINCT cluster_id)       AS clusters,
         count(DISTINCT workspace_id)     AS workspace_ids,
         min(change_time)                 AS earliest,
         max(change_time)                 AS latest
       FROM system.compute.clusters
       WHERE change_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
       UNION ALL
       SELECT
         'node_timeline',
         count(*),
         count(DISTINCT cluster_id),
         count(DISTINCT workspace_id),
         min(start_time),
         max(start_time)
       FROM system.compute.node_timeline
       WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})`
    ),

    // Question 3's missing intersection. The write-up's first pass put the driver count beside the below-10%-CPU
    // count and wrote "of which drivers", which no probe had asked: `driver_samples` is every driver sample in
    // the window, not the drivers among the low-CPU ones. Two counts that are nearly equal read as one being a
    // subset of the other, so the sentence claimed the strongest version of itself.
    await probe(
      'how many of the low-CPU samples are drivers',
      `SELECT
         count(*)                                                                    AS node_samples,
         count_if(cpu_user_percent + cpu_system_percent < 10)                        AS below_10_percent,
         count_if(driver AND cpu_user_percent + cpu_system_percent < 10)             AS drivers_below_10_percent,
         count_if(NOT driver AND cpu_user_percent + cpu_system_percent < 10)         AS workers_below_10_percent,
         count_if(NOT driver)                                                        AS worker_samples
       FROM system.compute.node_timeline
       WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})`
    ),

    // Question 8. Both retentions read the same way over the same wide window, so "90 days" is compared with
    // what this workspace holds rather than with the documentation.
    await probe(
      'how far back each table goes',
      `SELECT
         'node_timeline'                    AS relation,
         min(start_time)                    AS earliest,
         max(start_time)                    AS latest,
         datediff(DAY, min(start_time), max(start_time)) AS days_held
       FROM system.compute.node_timeline
       WHERE start_time >= current_timestamp() - make_dt_interval(${String(RETENTION_DAYS)})
       UNION ALL
       SELECT
         'job_task_run_timeline',
         min(period_start_time),
         max(period_start_time),
         datediff(DAY, min(period_start_time), max(period_start_time))
       FROM system.lakeflow.job_task_run_timeline
       WHERE period_start_time >= current_timestamp() - make_dt_interval(${String(RETENTION_DAYS)})`
    ),
  ];

  const spellings = only(probes, 'which spelling of the compute column is populated');
  const reach = only(probes, 'how far the run-window worker join reaches');
  const estate = only(probes, 'the CPU claim as made, over every node sample');
  const grain = only(probes, 'the four utilisation distributions at the rules’ own grain');
  const guardrail = only(probes, 'how many jobs clear the three-run guardrail');
  const asOf = only(probes, 'whether the as-of cluster configuration join finds a row');
  const stated = only(probes, 'whether the stated per-run durations are populated');
  const cost = only(probes, 'whether job cost is readable');

  // The seven readings the next three rows are decided by, each one a share so it can be compared with the
  // document's claim rather than with this workspace's size. Every one is `null` where its probe failed.
  const readings = {
    // Question 2. A zero on either side ends the document's queries 3 and 4 as written.
    computeIdsPopulated: share(count(spellings, 'rows_with_compute_ids'), count(spellings, 'timeline_rows')),
    computeStructPopulated: share(
      count(spellings, 'rows_with_compute_struct'),
      count(spellings, 'timeline_rows')
    ),
    // Question 1. The ceiling on rules A to D, at the grain each of them fires at.
    jobsTheWorkerJoinReaches: share(
      count(reach, 'jobs_with_worker_samples'),
      count(reach, 'jobs')
    ),
    runsTheWorkerJoinReaches: share(
      count(reach, 'runs_with_worker_samples'),
      count(reach, 'runs')
    ),
    // Question 3, both grains, so the difference between them is the reading rather than either number.
    nodeSamplesBelow10PercentCpu: share(
      count(estate, 'samples_below_10_percent'),
      count(estate, 'node_samples')
    ),
    runsBelow30PercentCpu: share(count(grain, 'pairs_under_30_cpu'), count(grain, 'run_cluster_pairs')),
    runsRuleAWouldConsider: share(
      count(grain, 'pairs_rule_a_would_consider'),
      count(grain, 'run_cluster_pairs')
    ),
    // Question 4. Coverage, not confidence, if this is low.
    jobsClearingTheGuardrail: share(
      count(guardrail, 'jobs_with_three_runs'),
      count(guardrail, 'jobs')
    ),
    // Question 6.
    pairsWithAnAsOfConfig: share(
      count(asOf, 'pairs_with_an_as_of_config'),
      count(asOf, 'run_cluster_pairs')
    ),
    // Question 5, read off the column itself rather than off a wall clock derived from period columns — which
    // is the distinction the first version of this script lost.
    runsWithAStatedTotal: share(count(stated, 'runs_with_a_total'), count(stated, 'runs')),
    runsWithAStatedSetup: share(count(stated, 'runs_with_a_setup'), count(stated, 'runs')),
    // What the other half of the audit can see, which is the difference between five rules blocked and all of
    // H6c blocked. Both sides from the cost probe's own join, not from two probes over two tables.
    jobsWithCostRecords: share(count(cost, 'jobs_with_usage'), count(cost, 'jobs_that_ran')),
  };

  const failed = probes.filter((one) => !one.ok);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        runFinishedAt: new Date().toISOString(),
        profile: corpusSettings.profile,
        host: corpusSettings.host,
        // Named because the write-up states it: on a large shared estate, which warehouse a probe ran on is part
        // of what the reading was taken with.
        warehouse: corpusSettings.warehouse,
        lookbackDays: LOOKBACK_DAYS,
        retentionDays: RETENTION_DAYS,
        readings,
        probes,
      },
      null,
      2
    )}\n`
  );

  console.log(`wrote ${OUT}`);
  for (const [name, reading] of Object.entries(readings)) console.log(`  ${name}: ${said(reading)}`);
  if (failed.length > 0) {
    console.log(`\n${String(failed.length)} probe(s) failed:`);
    for (const one of failed) console.log(`  ${one.label}: ${one.error}`);
  }
}

// Guarded so the helpers above are importable by a test without a warehouse. `33iga` shipped this unguarded and
// a review caught it: a test that imports the module runs the whole scan.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
