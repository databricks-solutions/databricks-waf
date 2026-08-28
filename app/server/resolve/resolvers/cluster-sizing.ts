// Two questions about whether compute is sized for what runs on it, one answered from the
// cluster inventory already collected and one from a table this codebase has never seen
// return a row.

import type { ControlResolver } from '../resolver.js';
import { asCluster } from '../locate.js';
import type { ClusterRow, NodeUtilization } from '../../collect/sql/shapes.js';
import { share } from '../../collect/sql/rows.js';
import {
  bandOutcome,
  bandsOf,
  evidenceFrom,
  fromSignal,
  notApplicable,
  offenders,
  percent,
  unmeasured,
} from './helpers.js';

const CLUSTERS = 'sql:compute.clusters';
const NODE_UTILIZATION = 'sql:compute.node_utilization';

/**
 * No fixed workers and no autoscale range: the driver runs alone, whatever else is configured.
 *
 * All three fields reach here through `COALESCE(…, 0)` in compute_cluster_inventory.sql, so a null
 * is indistinguishable from a configured zero. For the autoscale bounds that is the right reading —
 * a fixed-size cluster has no bounds, and null means it does not autoscale. For `worker_count` we
 * **assume** the same: that a null accompanies an autoscale range rather than appearing beside null
 * bounds. That assumption is unverified. `compute_cluster_inventory` returned no row on the labs
 * estate this was measured against, so no real cluster has exercised it, and if a null does appear
 * beside null bounds this reads that cluster as single-node and fails the control at high severity
 * for an unwritten column — the failure `init_scripts_known` exists to prevent, forty lines away in
 * the same statement. Telling the two apart needs a `workers_known` column, and adding a column
 * needs a fresh Q1a measurement to record its arity against; the M1b phase file carries it as open.
 */
function isSingleNode(cluster: ClusterRow): boolean {
  return cluster.workerCount === 0 && cluster.minWorkers === 0 && cluster.maxWorkers === 0;
}

/** Job and pipeline compute is unattended production work. UI and API clusters are interactive. */
function isProductionCluster(cluster: ClusterRow): boolean {
  return cluster.source === 'JOB' || cluster.source === 'PIPELINE';
}

/**
 * REL-01-02: production workloads that depend on a single machine.
 *
 * `cluster_source` already separates job and pipeline compute — unattended production work —
 * from the `UI` and `API` clusters people attach to interactively, and a single-node cluster
 * is directly readable as no fixed workers and no autoscale range at the same time. A cluster
 * in that shape has no worker to fail over to: losing the one node it has stops the job outright
 * rather than degrading it, which is exactly the dependency this control asks about.
 */
const singleNodeProduction = fromSignal<ClusterRow[]>(CLUSTERS, ['REL-01-02'], (clusters, context) => {
  const population = clusters.filter(isProductionCluster);
  if (population.length === 0) {
    return notApplicable(
      'This estate runs no job or pipeline compute — the two sources that carry unattended production ' +
        'work — so there is no cluster here that could depend on a single machine. All-purpose clusters ' +
        'used interactively are a different question from this one.'
    );
  }

  const singleNode = population.filter(isSingleNode);
  const distributed = population.length - singleNode.length;
  const adopted = share(distributed, population.length);

  return {
    outcome: bandOutcome(adopted, bandsOf(context.spec, { pass: 1, partial: 0.9 })),
    evidence: [
      evidenceFrom(
        context,
        CLUSTERS,
        `${singleNode.length} of ${population.length} job or pipeline clusters run with no workers and no ` +
          `autoscale range configured`,
        'Every job or pipeline cluster is configured with at least one worker, or an autoscale floor above zero'
      ),
      ...offenders(context, CLUSTERS, 'Running single-node', singleNode, asCluster, {
        note: () => 'no workers, no autoscale range',
      }),
    ],
    outcomeReason:
      'A single-node cluster is configured with no worker for Spark to distribute work to: the driver is the ' +
      'only machine the run has. Serverless compute and Lakeflow pipelines that autoscale from a nonzero floor ' +
      'are not counted here — this is only the shape with neither a fixed worker count nor an autoscale range ' +
      'above zero. Read from the cluster configuration, which is what the inventory records; what a lost node ' +
      'does to a particular run is not in it.',
  };
});

/**
 * CO-01-08: compute sized against what it actually uses.
 *
 * `node_timeline` records per-node CPU, which settles the question this control asks about
 * without anyone testing anything by hand — but only where the table has a row. It has
 * returned none on every labs workspace probed for this, which the September 2024 note above
 * the statement explains: no classic cluster has run in that region since. An empty reading is
 * reported as unmeasured rather than as a pass, because an estate with no recent samples has
 * not been shown to run compute efficiently — it has simply not been read.
 *
 * A reading with no idle cluster is unmeasured for a different reason: a cluster averaging
 * above the idle threshold could still be oversized for what it runs, and nothing here says
 * what the workload needed. This can only ever demonstrate the failure — a cluster averaging
 * near zero across every sample it has — never the pass.
 *
 * Three unmeasured cases, not one, and they are different facts: the table returned nothing, it
 * returned samples but no cluster long-lived enough to average, or it returned averages and none
 * of them was idle. Collapsing the middle one into either neighbour is what let an earlier form of
 * this claim a whole window from four minutes of samples.
 */
const nodeSizing = fromSignal<NodeUtilization>(NODE_UTILIZATION, ['CO-01-08'], (utilization, context) => {
  if (utilization.nodeSamples === 0) {
    return unmeasured(
      '`system.compute.node_timeline` returned no row for this estate in the window. Per-node CPU would ' +
        'settle whether a workload runs on smaller compute than it is given, but only where the table has ' +
        'a sample to read — an estate with no recent classic-cluster activity has not been shown to run ' +
        'compute efficiently, it has simply not reported anything.',
      'attestation'
    );
  }

  /*
   * Samples exist, but no cluster ran long enough for an average over them to describe how it runs.
   * The statement's 60-sample floor is what separates this from the case below, and it is a third
   * answer rather than a variant of the empty one: the table answered, and what it returned was too
   * short to read.
   */
  if (utilization.clustersObserved === 0) {
    return unmeasured(
      `${utilization.nodeSamples.toLocaleString('en-US')} node sample` +
        `${utilization.nodeSamples === 1 ? '' : 's'} came back, but no cluster reached the 60 samples this ` +
        'reading needs before averaging them. A cluster that lived a few minutes has a CPU average, and it ' +
        'describes how the cluster started rather than how it runs, so nothing here says whether compute is ' +
        'sized to what it uses.',
      'attestation'
    );
  }

  if (utilization.idleClusters === 0) {
    return unmeasured(
      `${utilization.clustersObserved.toLocaleString('en-US')} cluster${utilization.clustersObserved === 1 ? '' : 's'} ` +
        `reached 60 or more node samples, none averaging under 5% combined CPU across the samples it has. ` +
        'That is not evidence every one is sized correctly — a cluster at 40% CPU can still be oversized for ' +
        'its workload, and nothing here says what the workload needed — only that none is idle enough for ' +
        'this reading to call out.',
      'attestation'
    );
  }

  const idleShare = share(utilization.idleClusters, utilization.clustersObserved);

  return {
    outcome: 'fail' as const,
    evidence: [
      evidenceFrom(
        context,
        NODE_UTILIZATION,
        `${utilization.idleClusters.toLocaleString('en-US')} of ${utilization.clustersObserved.toLocaleString('en-US')} ` +
          `clusters with 60 or more node samples${idleShare == null ? '' : ` (${percent(idleShare)})`} averaged ` +
          `under 5% combined CPU across every sample they have`,
        'No cluster averages near-zero CPU across the samples it has'
      ),
    ],
    outcomeReason:
      'Combined CPU (`cpu_user_percent + cpu_system_percent`) averaged under 5% across every sample a cluster ' +
      'has, over at least 60 samples, is direct evidence that at least one cluster was never right-sized for ' +
      'what it runs. This reports only the clusters it can show are idle; it says nothing about the rest, and ' +
      'nothing about clusters too short-lived to average.',
  };
});

export const CLUSTER_SIZING_RESOLVERS: readonly ControlResolver[] = [singleNodeProduction, nodeSizing];
