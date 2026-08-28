// Two sizing measures, and the difference between a reading and a verdict.
//
// REL-01-02 is readable directly: a single-node cluster is no fixed workers and no autoscale range
// at the same time, and `cluster_source` already separates unattended job and pipeline compute from
// the clusters people attach to interactively. What these tests defend there is the population — an
// all-purpose cluster somebody uses to explore is not a production dependency on one machine — and
// that a single-node cluster is not averaged away by the multi-node ones beside it.
//
// CO-01-08 is the harder one, and the claim under test is that it only ever demonstrates its
// failure. Per-node CPU can show a cluster idled for a whole window; nothing in the table says what
// a busier cluster's workload needed, so a reading with no idle cluster is not a pass. And an empty
// reading — `node_timeline` has returned no row on every labs workspace probed for this — is not a
// pass either. Both are unmeasured, for two different reasons the resolver has to keep apart.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ClusterRow, NodeUtilization } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CLUSTERS = 'sql:compute.clusters' as SignalId;
const NODE_UTILIZATION = 'sql:compute.node_utilization' as SignalId;
const PROFILE = 'sql:estate.compute_profile' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function cluster(overrides: Partial<ClusterRow> = {}): ClusterRow {
  return {
    workspaceId: '1',
    clusterId: 'c-1',
    name: 'nightly-load',
    source: 'JOB',
    runtime: '15.4.x-scala2.12',
    hasPolicy: true,
    autoscaling: false,
    autoTerminates: true,
    gpuNode: false,
    initScriptCount: 0,
    dbfsInitScriptCount: 0,
    initScriptsKnown: true,
    tagCount: 1,
    workerCount: 2,
    minWorkers: 0,
    maxWorkers: 0,
    ...overrides,
  };
}

/** No fixed workers and no autoscale range: the driver runs alone. */
const singleNode = (overrides: Partial<ClusterRow> = {}) =>
  cluster({ workerCount: 0, minWorkers: 0, maxWorkers: 0, ...overrides });

function clusterFinding(clusters: readonly ClusterRow[]) {
  const spec = catalogue.controls.find((control) => control.id === 'REL-01-02');
  if (spec == null) throw new Error('REL-01-02 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([
    [CLUSTERS, observed(CLUSTERS, clusters, clusters.length, COMPLETE)],
    // The applicability precondition: a non-zero classic cluster count, so the control is assessed
    // rather than excluded as a serverless-only estate.
    [
      PROFILE,
      observed(PROFILE, { distinctClusters: clusters.length, summary: clusters.length }, 1, COMPLETE),
    ],
  ]);
  return resolveControl(spec, signals, registry.get('REL-01-02'));
}

function utilization(over: Partial<NodeUtilization> = {}): NodeUtilization {
  return { nodeSamples: 0, clustersObserved: 0, idleClusters: 0, ...over };
}

function sizingFinding(value: NodeUtilization) {
  const spec = catalogue.controls.find((control) => control.id === 'CO-01-08');
  if (spec == null) throw new Error('CO-01-08 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([
    [NODE_UTILIZATION, observed(NODE_UTILIZATION, value, 1, COMPLETE)],
  ]);
  return resolveControl(spec, signals, registry.get('CO-01-08'));
}

describe('REL-01-02, production work that depends on a single machine', () => {
  it('passes an estate whose job and pipeline clusters all have workers', () => {
    const finding = clusterFinding([
      cluster({ clusterId: 'c-1', workerCount: 4 }),
      cluster({ clusterId: 'c-2', source: 'PIPELINE', workerCount: 0, minWorkers: 1, maxWorkers: 8 }),
    ]);

    expect(finding.outcome).toBe('pass');
  });

  it('counts an autoscale floor above zero as having a worker', () => {
    // A cluster with no fixed worker count is not single-node if it autoscales from one upward. The
    // shape being flagged is neither a fixed count nor a range — reading `workerCount` alone would
    // fail every autoscaling cluster in the estate.
    const finding = clusterFinding([cluster({ workerCount: 0, minWorkers: 1, maxWorkers: 4, autoscaling: true })]);

    expect(finding.outcome).toBe('pass');
  });

  it('fails a single single-node production cluster rather than averaging it away', () => {
    // The band passes at 1.0 on purpose: nine resilient clusters do not make the tenth survive
    // losing its only node.
    const clusters = Array.from({ length: 9 }, (_unused, index) => cluster({ clusterId: `c-${index}`, workerCount: 2 }));
    clusters.push(singleNode({ clusterId: 'c-lonely', name: 'model-scoring' }));

    const finding = clusterFinding(clusters);

    expect(finding.outcome).not.toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 of 10 job or pipeline clusters');
    expect(finding.evidence.map((item) => item.observed).join(' ')).toContain('model-scoring');
  });

  it('leaves interactive clusters out of the population', () => {
    // An all-purpose cluster somebody attaches a notebook to is not unattended production work, and
    // single-node is a normal choice for one. Scoring it here would fail estates for a practice this
    // control is not about.
    const finding = clusterFinding([
      cluster({ clusterId: 'c-1', workerCount: 2 }),
      singleNode({ clusterId: 'c-2', source: 'UI' }),
      singleNode({ clusterId: 'c-3', source: 'API' }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('0 of 1 job or pipeline clusters');
  });

  it('excludes an estate with no job or pipeline compute at all', () => {
    const finding = clusterFinding([singleNode({ source: 'UI' })]);

    expect(finding.outcome).toBe('not-applicable');
  });
});

describe('CO-01-08, compute sized against what it uses', () => {
  it('fails over the clusters it can show idled for the whole window', () => {
    const finding = sizingFinding(utilization({ nodeSamples: 4_320, clustersObserved: 8, idleClusters: 2 }));

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('2 of 8 clusters');
  });

  it('reports unmeasurable rather than a pass when no cluster is idle', () => {
    // The asymmetry that makes this measure honest: a cluster at 40% CPU may still be twice the size
    // its workload needs, and nothing in `node_timeline` says what the workload needed.
    const finding = sizingFinding(utilization({ nodeSamples: 4_320, clustersObserved: 8, idleClusters: 0 }));

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/not evidence every one is sized correctly/);
  });

  it('reports unmeasurable when samples came back but no cluster ran long enough to average', () => {
    // The defect this replaced: `idle_clusters` counted any cluster under the threshold regardless of
    // how many samples it had, so a job cluster that lived four minutes at 3% CPU was reported as
    // never right-sized, under a sentence claiming a whole window this quiet. Below the floor the
    // cluster is left out of both counts instead.
    const finding = sizingFinding(utilization({ nodeSamples: 12, clustersObserved: 0, idleClusters: 0 }));

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/no cluster reached the 60 samples/);
  });

  it('reports unmeasurable rather than a pass when the table returned no row', () => {
    // The labs case, and the one that would have been scored as compliance by a resolver reading
    // zero idle clusters out of zero observed. An unread estate is not an efficient one.
    const finding = sizingFinding(utilization());

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/returned no row/);
  });

  it('reads only the signal each control needs', () => {
    expect(registry.get('REL-01-02')?.requires).toEqual([CLUSTERS]);
    expect(registry.get('CO-01-08')?.requires).toEqual([NODE_UTILIZATION]);
  });
});
