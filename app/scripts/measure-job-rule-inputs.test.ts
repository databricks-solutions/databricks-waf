// What the recording says about rules D and E, pinned to the recording rather than to prose. Ledger row `50`.
//
// Every figure `docs/plan/h6-workload-advisor.md` quotes about these two rules is read from
// `large-estate-job-rule-inputs.json` here, and the assertions are the shape of the conclusion rather than the
// digits: "the network rate discriminates and CPU wait does not" is checked as a relation between two
// distributions, so it fails if a re-reading reverses it and survives a re-reading that only moves it.
//
// That is `41b`'s lesson and `33ii`'s. A number typed into a plan is a claim nothing checks, and the one that
// cost most here was a share whose halves were at different grains — the first pass divided the clusters
// billing usage names by the clusters billing usage names and read 100%, which looks exactly like full
// coverage of the estate. So the reach assertions below name both halves.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { JobRuleInputs } from './measure-job-rule-inputs.d.mts';
import { RATE_CUTS } from './measure-job-rule-inputs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');

const recording = JSON.parse(
  readFileSync(join(BASELINES, 'large-estate-job-rule-inputs.json'), 'utf8')
) as JobRuleInputs;

function row(label: string): Readonly<Record<string, string | null>> {
  const found = recording.probes.find((one) => one.label === label);
  if (found?.ok !== true) throw new Error(`the recording has no successful probe called ${label}`);
  const [first] = found.rows ?? [];
  if (first == null) throw new Error(`the probe called ${label} returned no row`);
  return first;
}

function rows(label: string): readonly Readonly<Record<string, string | null>>[] {
  const found = recording.probes.find((one) => one.label === label);
  if (found?.ok !== true) throw new Error(`the recording has no successful probe called ${label}`);
  return found.rows ?? [];
}

function figure(label: string, key: string): number {
  const value = row(label)[key];
  if (value == null || value === '') throw new Error(`${label} stated no ${key}`);
  return Number(value);
}

const DISTRIBUTIONS = 'the network and CPU-wait distributions at the rule’s own grain';
const CUTS = 'what a rate threshold would select, at four magnitudes';
const PROCESSED = 'whether data processed is readable for classic job compute';
const VOLUMES = 'whether any readable system table carries shuffle, spill or byte volumes';
const VERSIONS = 'whether the runtime version spells Photon on classic job clusters';
const PHOTON = 'whether billing usage states Photon for the classic job compute the rule is about';

describe('the recording says which estate it is about', () => {
  // The guard in `recording-guards.mjs` covers the write. This covers the read: a conclusion about classic
  // compute drawn from a recording taken on a serverless estate would be wrong in the direction that reads
  // fine, and labs is that estate.
  it('names large-estate and the host that estate resolves to', () => {
    expect(recording.profile).toBe('large-estate');
    expect(recording.host).toBe('https://example.cloud.databricks.com');
  });

  it('states the window every share was taken over, and the magnitudes the rate was cut at', () => {
    expect(recording.lookbackDays).toBe(30);
    expect(recording.rateCutsMib).toEqual([...RATE_CUTS]);
  });

  it('records every probe as having run', () => {
    expect(recording.probes.filter((one) => !one.ok)).toEqual([]);
  });
});

describe('rule D: what its conditions can be asked of', () => {
  it('has a network figure for the whole population, so the condition is readable', () => {
    const pairs = figure(DISTRIBUTIONS, 'classic_pairs_with_worker_samples');
    const rated = figure(DISTRIBUTIONS, 'pairs_with_a_rate');

    expect(pairs).toBeGreaterThan(1000);
    expect(rated).toBe(pairs);
  });

  // The reading the row exists for. CPU wait was already measured as good as absent, and the question was
  // whether the network figure is any better. It is, and the comparison rather than either number is the
  // finding: a distribution whose tail is orders of magnitude above its median can carry a threshold, and one
  // whose p95 sits near zero cannot.
  it('spreads over orders of magnitude where CPU wait does not', () => {
    const rateP50 = figure(DISTRIBUTIONS, 'rate_p50');
    const rateP95 = figure(DISTRIBUTIONS, 'rate_p95');
    const waitP95 = figure(DISTRIBUTIONS, 'cpu_wait_p95');

    expect(rateP95 / rateP50).toBeGreaterThan(10);
    // Per cent, so this is a hundredth of the scale it is measured on. No threshold separates a population
    // from the estate on it.
    expect(waitP95).toBeLessThan(5);
  });

  it('has a cut that selects a few pairs rather than most of them', () => {
    const rated = figure(CUTS, 'pairs_with_a_rate');
    const lowest = figure(CUTS, `above_${String(RATE_CUTS[0])}_mib_per_node_minute`);
    const highest = figure(CUTS, `above_${String(RATE_CUTS[RATE_CUTS.length - 1])}_mib_per_node_minute`);

    // The lowest cut is not a rule — it takes most of the estate, which is the same defect low CPU has.
    expect(lowest / rated).toBeGreaterThan(0.5);
    // The highest is: a small named population rather than a restatement of the workspace.
    expect(highest / rated).toBeLessThan(0.1);
    expect(highest).toBeGreaterThan(0);
  });

  // Low CPU, re-read on this population. `41b` had it at 94.7% of every pair; over the pairs that have worker
  // samples at all it is worse, which matters because that is the population a rule fires on.
  it('cannot lean on low CPU, which selects nearly every pair', () => {
    const share =
      figure(DISTRIBUTIONS, 'pairs_under_40_cpu') / figure(DISTRIBUTIONS, 'classic_pairs_with_worker_samples');

    expect(share).toBeGreaterThan(0.9);
  });

  // The condition that ends as documented. "Network transfer is large relative to data processed" needs a
  // denominator, and query history is the only relation carrying one.
  it('has no data-processed denominator for classic job compute, because query history names no cluster', () => {
    expect(figure(PROCESSED, 'history_rows_in_window')).toBeGreaterThan(0);
    expect(figure(PROCESSED, 'rows_stating_read_bytes')).toBeGreaterThan(0);
    expect(figure(PROCESSED, 'rows_naming_a_cluster')).toBe(0);
    expect(figure(PROCESSED, 'classic_job_clusters_in_history')).toBe(0);
    expect(figure(PROCESSED, 'classic_clusters')).toBeGreaterThan(0);
  });

  // And the fourth condition, for the same reason as the third. Shuffle exists in exactly one relation, and it
  // is the relation the probe above found names no cluster.
  it('has shuffle bytes only in the relation that names no classic job cluster', () => {
    const carriers = rows(VOLUMES)
      .filter((one) => (one.column_name ?? '').includes('shuffle'))
      .map((one) => `${String(one.table_schema)}.${String(one.table_name)}`);

    expect(carriers.length).toBeGreaterThan(0);
    expect([...new Set(carriers)]).toEqual(['query.history']);
  });
});

describe('rule E: where its premise actually lives', () => {
  // What the write-up assumed, checked. It bounded the rule by the as-of configuration join at 8.7% on the
  // premise that the input rides on that record. The record has no field for it.
  it('has no Photon column on the cluster configuration record', () => {
    const columns = rows('which columns the cluster configuration record carries').map((one) =>
      (one.column_name ?? '').toLowerCase()
    );

    expect(columns).toContain('dbr_version');
    expect(columns.filter((name) => name.includes('photon'))).toEqual([]);
    expect(columns.filter((name) => name.includes('runtime_engine'))).toEqual([]);
  });

  // The one candidate on that record, and why it is a worse answer than it looks. It is a positive-only
  // signal: a version spelling `photon` says Photon is on, and a version not spelling it is every other
  // runtime including ones this reading cannot classify.
  it('finds Photon spelled in the runtime version, on some records and not all', () => {
    const records = figure(VERSIONS, 'configuration_records');
    const spelled = figure(VERSIONS, 'records_spelling_photon');

    expect(figure(VERSIONS, 'records_stating_a_version')).toBe(records);
    expect(spelled).toBeGreaterThan(0);
    expect(spelled).toBeLessThan(records);
  });

  it('states Photon explicitly on every classic job usage record it has', () => {
    const records = figure(PHOTON, 'classic_job_usage_records');

    expect(records).toBeGreaterThan(0);
    expect(figure(PHOTON, 'records_stating_photon')).toBe(records);
  });

  // The reach, with both halves named. This is the assertion the first pass could not have made: it divided
  // the clusters usage names by the clusters usage names, which is 1 whatever the estate does.
  it('reaches most of the rule’s own cluster population, and the denominator is that population', () => {
    const clusters = figure(PHOTON, 'classic_clusters');
    const stating = figure(PHOTON, 'rule_clusters_stating_photon');

    expect(clusters).toBeGreaterThan(1000);
    expect(stating).toBeLessThanOrEqual(clusters);
    expect(stating / clusters).toBeGreaterThan(0.9);
    // Far better than the as-of configuration join the write-up bounded the rule by, and that difference is
    // the whole of what this row hands to `51`.
    expect(stating / clusters).toBeGreaterThan(0.087);
  });

  it('finds a population with Photon off that is neither everything nor nothing', () => {
    const off = figure(PHOTON, 'rule_clusters_with_photon_off');
    const stating = figure(PHOTON, 'rule_clusters_stating_photon');

    expect(off).toBeGreaterThan(0);
    expect(off / stating).toBeLessThan(0.9);
  });
});

describe('the readings the plan quotes', () => {
  // Each of these is a sentence in `h6-workload-advisor.md`. The test is here so that re-reading the estate
  // and finding something else fails the build rather than leaving the plan asserting last month's estate.
  it('agrees with the plan about which of rule D’s conditions survive', () => {
    const readings = recording.readings;

    expect(readings.pairsWithANetworkRate?.share).toBe(1);
    expect(readings.classicJobClustersWithADataVolume?.share).toBe(0);
    expect(readings.pairsAboveTheHighestCut?.share).toBeLessThan(0.1);
  });

  it('agrees with the plan about rule E being readable from usage and not from configuration', () => {
    const readings = recording.readings;

    expect(readings.jobUsageStatingPhoton?.share).toBe(1);
    expect(readings.ruleClustersStatingPhoton?.share ?? 0).toBeGreaterThan(0.9);
    expect(readings.ruleClustersWithPhotonOff?.share ?? 0).toBeGreaterThan(0);
  });
});
