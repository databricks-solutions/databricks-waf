//#region shared/api/topology.ts
const TOPOLOGY_KINDS = [
	"job",
	"cluster",
	"warehouse",
	"pipeline",
	"table"
];
/** Human type labels shared by the payload fallback, canvas and inspector. */
const TOPOLOGY_KIND_LABELS = {
	job: "Job",
	cluster: "Cluster",
	warehouse: "SQL warehouse",
	pipeline: "Pipeline",
	table: "Table"
};
/**
* Why a 32h probe is not a drawn relation.
*
* `pipeline-to-cluster` is one cluster per update. `cluster-to-table` is zero on both
* estates because the lineage-to-query-history join does not name a cluster.
* `bill-derived-pairs` is the same job→cluster pair read from a bill, which 32i's rule
* refuses.
*/
const TOPOLOGY_DECLINED = {
	"pipeline-to-cluster": "one cluster per update — an event log, not a relation",
	"cluster-to-table": "zero edges on both estates; the join does not carry cluster",
	"bill-derived-pairs": "32i's rule declines an edge drawn from a bill"
};
/**
* Per-relation collector ceiling. The largest drawn relation on large-estate in seven
* days is job→table at 8,510 edges; 10,000 is that reading with headroom. Each
* collector declares `at most :parameter` rather than joining the uncapped pair
* manifest H1a closed.
*/
const TOPOLOGY_COLLECTOR_CAP = 1e4;
/**
* Edges one topology response may carry. Measured at 428 KiB / 2,001 nodes in the
* worst case (every edge a unique pair). labs' whole graph is 306 edges / 80 KiB
* and is not truncated. The uncapped drawn graph on large-estate is 4.70 MiB.
*/
const TOPOLOGY_PAYLOAD_CAP = 2e3;
function topologyNodeId(kind, raw) {
	return `${kind}:${raw}`;
}
//#endregion
export { TOPOLOGY_COLLECTOR_CAP, TOPOLOGY_DECLINED, TOPOLOGY_KINDS, TOPOLOGY_KIND_LABELS, TOPOLOGY_PAYLOAD_CAP, topologyNodeId };
