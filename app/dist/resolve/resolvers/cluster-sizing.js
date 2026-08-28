import { share } from "../../collect/sql/rows.js";
import { asCluster } from "../locate.js";
import { bandOutcome, bandsOf, evidenceFrom, fromSignal, notApplicable, offenders, percent, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/cluster-sizing.ts
const CLUSTERS = "sql:compute.clusters";
const NODE_UTILIZATION = "sql:compute.node_utilization";
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
function isSingleNode(cluster) {
	return cluster.workerCount === 0 && cluster.minWorkers === 0 && cluster.maxWorkers === 0;
}
/** Job and pipeline compute is unattended production work. UI and API clusters are interactive. */
function isProductionCluster(cluster) {
	return cluster.source === "JOB" || cluster.source === "PIPELINE";
}
const CLUSTER_SIZING_RESOLVERS = [fromSignal(CLUSTERS, ["REL-01-02"], (clusters, context) => {
	const population = clusters.filter(isProductionCluster);
	if (population.length === 0) return notApplicable("This estate runs no job or pipeline compute — the two sources that carry unattended production work — so there is no cluster here that could depend on a single machine. All-purpose clusters used interactively are a different question from this one.");
	const singleNode = population.filter(isSingleNode);
	return {
		outcome: bandOutcome(share(population.length - singleNode.length, population.length), bandsOf(context.spec, {
			pass: 1,
			partial: .9
		})),
		evidence: [evidenceFrom(context, CLUSTERS, `${singleNode.length} of ${population.length} job or pipeline clusters run with no workers and no autoscale range configured`, "Every job or pipeline cluster is configured with at least one worker, or an autoscale floor above zero"), ...offenders(context, CLUSTERS, "Running single-node", singleNode, asCluster, { note: () => "no workers, no autoscale range" })],
		outcomeReason: "A single-node cluster is configured with no worker for Spark to distribute work to: the driver is the only machine the run has. Serverless compute and Lakeflow pipelines that autoscale from a nonzero floor are not counted here — this is only the shape with neither a fixed worker count nor an autoscale range above zero. Read from the cluster configuration, which is what the inventory records; what a lost node does to a particular run is not in it."
	};
}), fromSignal(NODE_UTILIZATION, ["CO-01-08"], (utilization, context) => {
	if (utilization.nodeSamples === 0) return unmeasured("`system.compute.node_timeline` returned no row for this estate in the window. Per-node CPU would settle whether a workload runs on smaller compute than it is given, but only where the table has a sample to read — an estate with no recent classic-cluster activity has not been shown to run compute efficiently, it has simply not reported anything.", "attestation");
	if (utilization.clustersObserved === 0) return unmeasured(`${utilization.nodeSamples.toLocaleString("en-US")} node sample${utilization.nodeSamples === 1 ? "" : "s"} came back, but no cluster reached the 60 samples this reading needs before averaging them. A cluster that lived a few minutes has a CPU average, and it describes how the cluster started rather than how it runs, so nothing here says whether compute is sized to what it uses.`, "attestation");
	if (utilization.idleClusters === 0) return unmeasured(`${utilization.clustersObserved.toLocaleString("en-US")} cluster${utilization.clustersObserved === 1 ? "" : "s"} reached 60 or more node samples, none averaging under 5% combined CPU across the samples it has. That is not evidence every one is sized correctly — a cluster at 40% CPU can still be oversized for its workload, and nothing here says what the workload needed — only that none is idle enough for this reading to call out.`, "attestation");
	const idleShare = share(utilization.idleClusters, utilization.clustersObserved);
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, NODE_UTILIZATION, `${utilization.idleClusters.toLocaleString("en-US")} of ${utilization.clustersObserved.toLocaleString("en-US")} clusters with 60 or more node samples${idleShare == null ? "" : ` (${percent(idleShare)})`} averaged under 5% combined CPU across every sample they have`, "No cluster averages near-zero CPU across the samples it has")],
		outcomeReason: "Combined CPU (`cpu_user_percent + cpu_system_percent`) averaged under 5% across every sample a cluster has, over at least 60 samples, is direct evidence that at least one cluster was never right-sized for what it runs. This reports only the clusters it can show are idle; it says nothing about the rest, and nothing about clusters too short-lived to average."
	};
})];
//#endregion
export { CLUSTER_SIZING_RESOLVERS };
