// The premises behind rules D and E of the job audit, measured before either is designed. Ledger row `50`.
//
// `41b` measured what the eight rules of `docs/design/automated_lakeflow_job_audit.md` can see, and `47`
// replanned the family against it. Two of the eight came out of that replan without a premise anybody had
// read, and this script reads them — which is [`AGENTS.md`](../../AGENTS.md)'s procedure and the one `H1`,
// `41b` and `41d` are the worked examples of. Nothing here is a collector and nothing here ships.
//
// **Rule D, the I/O and network-bound rule, has one input measured and one never probed.** Of its three
// machine-readable conditions, low CPU selects 10,516 of 11,105 run-cluster pairs on `large-estate` — 94.7%, so
// it discriminates nothing — and CPU wait is measured as good as absent: p50 0.04%, p90 0.69%, p95 1.32%. That
// leaves the network and shuffle conditions carrying the whole rule, and neither had been looked at. So the
// questions here are whether a network figure exists at the rule's own grain, whether its distribution
// separates a population worth naming from the estate, and whether "relative to data processed" has a
// denominator at all.
//
// **Rule E, the Photon candidate rule, has never had its premise read.** `41b`'s script reads no Photon column
// anywhere, and the write-up bounded the rule by the as-of configuration join rather than by the input: the
// configuration record exists for 53.6% of classic pairs and resolves as-of for 8.7%. That bound assumed the
// input rides on that record. Whether it does is the first question below, and the document assumes it too —
// its rule engine reads `photon_enabled` off a row its own query 5 does not select.
//
// Eight probes. Two of them can end a rule as documented, and two can move it to a different table.
//
//   1. Which columns `system.compute.node_timeline` actually carries, so "there is no shuffle column" is a
//      reading rather than an assertion.
//   2. Whether any system table this app may read carries shuffle or spill bytes at all.
//   3. The network distribution at the rule's own grain — per classic run-cluster pair, workers only — beside
//      the CPU-wait distribution over the same pairs, so "discriminating" and "not" are the same comparison.
//   4. What a candidate threshold on it would select, at four magnitudes, because a distribution is only
//      discriminating if some cut separates a few pairs from most of them.
//   5. Whether the denominator of "relative to data processed" is readable for classic job compute.
//   6. Which columns `system.compute.clusters` carries, which is where rule E's input was assumed to be.
//   7. Whether `dbr_version` spells Photon, since it is the only candidate column on that record.
//   8. Whether billing usage states Photon for classic job compute, and for how much of the population rule E
//      would fire on — the route the write-up did not consider, and the one that decides `51`'s shape.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=large-estate \
//        node scripts/measure-job-rule-inputs.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-job-rule-inputs.json`. Per estate for the reason
// `41b` records: rules D and E have no input on labs, because every job run there is serverless, and a fixed
// path means the second run silently replaces the recording the first run's conclusions came from. The two
// guards in `recording-guards.mjs` check that the name is true, because the name is the only thing keeping
// two estates' numbers apart.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CLASSIC_TASK_CLUSTERS, count, only, probe, said, share } from './measure-job-audit-inputs.mjs';
import { corpusSettings } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(
  HERE,
  '..',
  'server',
  'collect',
  'sql',
  'runtime-baseline',
  `${corpusSettings.profile}-job-rule-inputs.json`
);

/**
 * The window, matching `measure-job-audit-inputs.mjs` exactly.
 *
 * Not a preference. The population fragment is imported from that script rather than copied so that the
 * numbers here can be read beside its 94.7% and its 8.7%, and a different window would make them numbers
 * about different populations while looking like numbers about one.
 */
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/** The wider window, for the configuration record, as `41b` used it. */
const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 400);

/**
 * Bytes per node-minute, at four magnitudes.
 *
 * A rate rather than a total, because a total is mostly a measurement of how long the run was: a six-hour
 * run moving 10 GiB and a four-minute run moving 10 GiB are the same total and not the same finding. Four
 * magnitudes rather than one candidate threshold, because what this probe is for is whether *any* cut
 * separates a population worth naming from the estate — a single number would answer a narrower question and
 * would be the number somebody then shipped.
 */
const RATE_CUTS = [1, 10, 100, 1000];

/** One MiB, the unit the cuts are in. */
const MIB = 1024 * 1024;

/**
 * The classic run-cluster pairs with a network figure, and the figures.
 *
 * Workers only and inside the task window, which is rules A to E's own grain — `41b`'s review found the first
 * pass computing shares over every pair including serverless, 85% of which cannot have a node sample at all.
 * `network_sent_bytes` and `network_received_bytes` are cumulative counters per node sample, so the run's
 * figure is the sum across its samples rather than a max: a sum over overlapping samples of one node
 * over-counts, and this is a measurement of whether a distribution discriminates rather than of any one
 * cluster's traffic. Recorded as an assumption because it is one, and it errs toward the rule firing.
 */
const NETWORK_PER_PAIR = `
  WITH classic AS (${CLASSIC_TASK_CLUSTERS}),
  windows AS (
    SELECT workspace_id, job_id, job_run_id, cluster_id, min(task_start) AS run_start, max(task_end) AS run_end
    FROM classic
    GROUP BY ALL
  ),
  samples AS (
    SELECT
      w.job_id,
      w.job_run_id,
      w.cluster_id,
      count(*)                                                                  AS worker_samples,
      sum(coalesce(n.network_received_bytes, 0) + coalesce(n.network_sent_bytes, 0)) AS network_bytes,
      count_if(n.network_received_bytes IS NULL AND n.network_sent_bytes IS NULL) AS samples_stating_no_network,
      avg(n.cpu_wait_percent)                                                   AS avg_cpu_wait,
      avg(coalesce(n.cpu_user_percent, 0) + coalesce(n.cpu_system_percent, 0))  AS avg_cpu,
      sum(unix_timestamp(n.end_time) - unix_timestamp(n.start_time)) / 60.0     AS node_minutes
    FROM windows w
    JOIN system.compute.node_timeline n
      ON  n.workspace_id = w.workspace_id
      AND n.cluster_id   = w.cluster_id
      AND n.start_time   < w.run_end
      AND n.end_time     > w.run_start
      AND n.driver       = FALSE
    GROUP BY ALL
  )
  SELECT
    job_id,
    job_run_id,
    cluster_id,
    worker_samples,
    samples_stating_no_network,
    network_bytes,
    node_minutes,
    avg_cpu,
    avg_cpu_wait,
    CASE WHEN node_minutes > 0 THEN network_bytes / node_minutes END AS bytes_per_node_minute
  FROM samples
`;

async function main() {
  // Before the probes rather than after, as `41b` has it: a scan of a large shared estate that ends in a
  // refusal to write is a read taken off somebody else's warehouse for nothing.
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const probes = [
    // 1. What the node timeline holds. Read from the catalogue rather than asserted from the documentation,
    //    because the finding this row may land is that a documented condition has no column behind it, and
    //    that finding is only worth anything if the column list came from the workspace.
    await probe(
      'which columns the node timeline carries',
      `SELECT column_name, data_type
       FROM system.information_schema.columns
       WHERE table_catalog = 'system' AND table_schema = 'compute' AND table_name = 'node_timeline'
       ORDER BY ordinal_position`
    ),

    // 2. Whether shuffle is anywhere. Rule D's fourth condition is "shuffle read/write is high", and the
    //    document's own queries never select one — so before concluding it is unanswerable, ask every relation
    //    this app is allowed to read. A name match rather than a hand-written list of tables: the list would go
    //    stale silently and read as an absence.
    await probe(
      'whether any readable system table carries shuffle, spill or byte volumes',
      `SELECT table_schema, table_name, column_name, data_type
       FROM system.information_schema.columns
       WHERE table_catalog = 'system'
         AND table_schema IN ('compute', 'lakeflow', 'query', 'billing')
         AND (
           lower(column_name) LIKE '%shuffle%'
           OR lower(column_name) LIKE '%spill%'
           OR lower(column_name) LIKE '%bytes%'
         )
       ORDER BY table_schema, table_name, column_name`
    ),

    // 3. The two distributions side by side over the same pairs. CPU wait is re-read here rather than quoted
    //    from `41b` for the same reason the population fragment is imported: a comparison between two numbers
    //    taken over two populations is not a comparison.
    await probe(
      'the network and CPU-wait distributions at the rule’s own grain',
      `WITH pairs AS (${NETWORK_PER_PAIR})
       SELECT
         count(*)                                                     AS classic_pairs_with_worker_samples,
         count_if(bytes_per_node_minute IS NOT NULL)                   AS pairs_with_a_rate,
         sum(samples_stating_no_network)                               AS samples_stating_no_network,
         sum(worker_samples)                                           AS worker_samples,
         percentile(bytes_per_node_minute, 0.5)                        AS rate_p50,
         percentile(bytes_per_node_minute, 0.9)                        AS rate_p90,
         percentile(bytes_per_node_minute, 0.95)                       AS rate_p95,
         max(bytes_per_node_minute)                                    AS rate_max,
         percentile(avg_cpu_wait, 0.5)                                 AS cpu_wait_p50,
         percentile(avg_cpu_wait, 0.9)                                 AS cpu_wait_p90,
         percentile(avg_cpu_wait, 0.95)                                AS cpu_wait_p95,
         max(avg_cpu_wait)                                             AS cpu_wait_max,
         count_if(avg_cpu < 40)                                        AS pairs_under_40_cpu
       FROM pairs`
    ),

    // 4. What a cut would select. Four magnitudes in one row, so the shape of the distribution is legible
    //    without a second read of a shared estate.
    await probe(
      'what a rate threshold would select, at four magnitudes',
      `WITH pairs AS (${NETWORK_PER_PAIR})
       SELECT
         count_if(bytes_per_node_minute IS NOT NULL) AS pairs_with_a_rate,
         ${RATE_CUTS.map(
           (cut) =>
             `count_if(bytes_per_node_minute > ${String(cut * MIB)}) AS above_${String(cut)}_mib_per_node_minute`
         ).join(',\n         ')},
         count_if(bytes_per_node_minute > ${String(RATE_CUTS[0] * MIB)} AND avg_cpu < 40)
           AS above_the_lowest_cut_and_low_cpu
       FROM pairs`
    ),

    // 5. The denominator rule D's third condition needs. "Network transfer is large relative to data
    //    processed" is a ratio, and nothing measured so far has looked for the bottom of it. Query history is
    //    the only relation carrying bytes read per statement, so the question is whether it holds anything for
    //    the runs on classic job compute — not whether the column exists.
    await probe(
      'whether data processed is readable for classic job compute',
      `WITH classic AS (${CLASSIC_TASK_CLUSTERS}),
       pairs AS (
         SELECT DISTINCT workspace_id, job_run_id, cluster_id
         FROM classic
       ),
       -- Counted separately because the reading below is per cluster and the population is per pair, and a
       -- share whose halves are at different grains is not a share. The first pass wrote one anyway.
       rule_clusters AS (SELECT DISTINCT cluster_id FROM pairs),
       history AS (
         SELECT
           workspace_id,
           statement_id,
           read_bytes,
           compute
         FROM system.query.history
         WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
       )
       SELECT
         (SELECT count(*) FROM pairs)                                   AS classic_pairs,
         (SELECT count(*) FROM rule_clusters)                           AS classic_clusters,
         count(*)                                                       AS history_rows_in_window,
         count_if(read_bytes IS NOT NULL)                               AS rows_stating_read_bytes,
         count_if(compute.cluster_id IS NOT NULL)                       AS rows_naming_a_cluster,
         count(DISTINCT CASE WHEN compute.cluster_id IN (SELECT cluster_id FROM rule_clusters)
                             THEN compute.cluster_id END)              AS classic_job_clusters_in_history
       FROM history`
    ),

    // 6. Where rule E's input was assumed to be. The write-up bounded the rule by this record's as-of join, so
    //    whether the record carries the input at all decides whether that bound was the right one.
    await probe(
      'which columns the cluster configuration record carries',
      `SELECT column_name, data_type
       FROM system.information_schema.columns
       WHERE table_catalog = 'system' AND table_schema = 'compute' AND table_name = 'clusters'
       ORDER BY ordinal_position`
    ),

    // 7. The one candidate column on that record. A Photon runtime is spelled in the version string on some
    //    surfaces, so this asks the workspace rather than assuming either way — over the classic job clusters
    //    the rule would fire on, not over every cluster in the estate.
    await probe(
      'whether the runtime version spells Photon on classic job clusters',
      `WITH classic AS (${CLASSIC_TASK_CLUSTERS}),
       ids AS (SELECT DISTINCT workspace_id, cluster_id FROM classic),
       config AS (
         SELECT c.cluster_id, c.dbr_version
         FROM system.compute.clusters c
         JOIN ids USING (workspace_id, cluster_id)
         WHERE c.change_time >= current_timestamp() - make_dt_interval(${String(RETENTION_DAYS)})
       )
       SELECT
         count(*)                                                   AS configuration_records,
         count(DISTINCT cluster_id)                                  AS clusters,
         count_if(dbr_version IS NOT NULL)                           AS records_stating_a_version,
         count_if(lower(coalesce(dbr_version, '')) LIKE '%photon%')  AS records_spelling_photon,
         slice(array_sort(array_distinct(collect_list(dbr_version))), 1, 12) AS versions
       FROM config`
    ),

    // 8. The route nobody considered. `product_features.is_photon` sits on the usage record, so the reading is
    //    per billing record rather than per configuration — which means rule E's reach is bounded by whether
    //    usage names the cluster, not by whether a configuration record resolves as-of. Restricted to job
    //    compute that is not serverless, because Photon is not a setting on serverless and a share over
    //    serverless records would state the rule's reach as better or worse than it is depending on the mix.
    await probe(
      'whether billing usage states Photon for the classic job compute the rule is about',
      `WITH classic AS (${CLASSIC_TASK_CLUSTERS}),
       pairs AS (SELECT DISTINCT workspace_id, job_run_id, cluster_id FROM classic),
       -- The rule's population as a set of clusters, which is what the reach below is a share of. Its first
       -- pass divided the clusters usage names by the clusters usage names, and 100% of a set over itself
       -- reads exactly like full coverage of the estate.
       rule_clusters AS (SELECT DISTINCT cluster_id FROM pairs),
       usage AS (
         SELECT
           usage_metadata.cluster_id                AS cluster_id,
           usage_metadata.job_run_id                AS job_run_id,
           product_features.is_photon               AS is_photon,
           product_features.is_serverless           AS is_serverless
         FROM system.billing.usage
         WHERE usage_start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
           AND billing_origin_product = 'JOBS'
           AND coalesce(product_features.is_serverless, FALSE) = FALSE
           AND usage_metadata.cluster_id IS NOT NULL
       )
       SELECT
         (SELECT count(*) FROM pairs)                                        AS classic_pairs,
         (SELECT count(*) FROM rule_clusters)                                AS classic_clusters,
         count(*)                                                            AS classic_job_usage_records,
         count_if(is_photon IS NOT NULL)                                     AS records_stating_photon,
         count_if(is_photon = FALSE)                                         AS records_with_photon_off,
         count(DISTINCT cluster_id)                                          AS clusters,
         count(DISTINCT CASE WHEN is_photon = FALSE THEN cluster_id END)      AS clusters_with_photon_off,
         count(DISTINCT CASE WHEN cluster_id IN (SELECT cluster_id FROM rule_clusters) AND is_photon IS NOT NULL
                             THEN cluster_id END)                            AS rule_clusters_stating_photon,
         count(DISTINCT CASE WHEN cluster_id IN (SELECT cluster_id FROM rule_clusters) AND is_photon = FALSE
                             THEN cluster_id END)                            AS rule_clusters_with_photon_off
       FROM usage`
    ),
  ];

  const distributions = only(probes, 'the network and CPU-wait distributions at the rule’s own grain');
  const cuts = only(probes, 'what a rate threshold would select, at four magnitudes');
  const processed = only(probes, 'whether data processed is readable for classic job compute');
  const versions = only(probes, 'whether the runtime version spells Photon on classic job clusters');
  const photon = only(probes, 'whether billing usage states Photon for the classic job compute the rule is about');

  /**
   * The readings `51` is decided by, each a share so it reads against the document's claim rather than
   * against this workspace's size. Every one is `null` where its probe failed, and says which kind of
   * nothing it found — `41b`'s first pass reported three empty populations as failed probes, which is the
   * opposite finding.
   */
  const readings = {
    // Rule D. Whether the network figure exists at all on the population the rule fires on.
    pairsWithANetworkRate: share(
      count(distributions, 'pairs_with_a_rate'),
      count(distributions, 'classic_pairs_with_worker_samples')
    ),
    // And whether a cut through it selects a population worth naming. Both ends, because a cut that takes
    // nearly all of the pairs and one that takes none are the same verdict for different reasons, and only
    // the pair of them says the distribution is unusable rather than the threshold badly chosen.
    pairsAboveTheLowestCut: share(
      count(cuts, `above_${String(RATE_CUTS[0])}_mib_per_node_minute`),
      count(cuts, 'pairs_with_a_rate')
    ),
    pairsAboveTheHighestCut: share(
      count(cuts, `above_${String(RATE_CUTS[RATE_CUTS.length - 1])}_mib_per_node_minute`),
      count(cuts, 'pairs_with_a_rate')
    ),
    // Rule D's third condition needs a denominator, and this is whether it has one for this compute. Per
    // cluster on both sides: the classic pairs are a coarser population and dividing by them would report a
    // worse reach than the data supports.
    classicJobClustersWithADataVolume: share(
      count(processed, 'classic_job_clusters_in_history'),
      count(processed, 'classic_clusters')
    ),
    // Rule E, first as the write-up assumed it: off the configuration record.
    configurationRecordsSpellingPhoton: share(
      count(versions, 'records_spelling_photon'),
      count(versions, 'configuration_records')
    ),
    // Then off the record that carries the field. Two shares, because "usage states it where usage has a
    // record" and "usage has a record for the clusters the rule is about" are different facts, and only the
    // second is the rule's reach.
    jobUsageStatingPhoton: share(
      count(photon, 'records_stating_photon'),
      count(photon, 'classic_job_usage_records')
    ),
    ruleClustersStatingPhoton: share(
      count(photon, 'rule_clusters_stating_photon'),
      count(photon, 'classic_clusters')
    ),
    // What the rule would then find, over the population it can read rather than over every cluster billed.
    ruleClustersWithPhotonOff: share(
      count(photon, 'rule_clusters_with_photon_off'),
      count(photon, 'rule_clusters_stating_photon')
    ),
  };

  const failed = probes.filter((one) => !one.ok);

  writeFileSync(
    OUT,
    `${JSON.stringify(
      {
        runFinishedAt: new Date().toISOString(),
        profile: corpusSettings.profile,
        host: corpusSettings.host,
        // Which warehouse ran the probes: on a shared estate that is part of what the reading was taken with.
        warehouse: corpusSettings.warehouse,
        lookbackDays: LOOKBACK_DAYS,
        retentionDays: RETENTION_DAYS,
        rateCutsMib: RATE_CUTS,
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

// Guarded so a test can import this without a warehouse, which `33iga` shipped wrong and a review caught.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

export { NETWORK_PER_PAIR, RATE_CUTS };
