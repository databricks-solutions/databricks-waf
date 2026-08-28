import { shippedConfigDirectory } from "../../shipped-config.js";
import { FileQuerySource } from "../sql/queries.js";
import { rowsOf } from "../sql/collector.js";
import { TOPOLOGY_COLLECTOR_CAP, TOPOLOGY_DECLINED } from "../../shared/api/topology.js";
import { topologyPayload } from "./payload.js";
import { parseTopologyEdges } from "./parse.js";
import { TOPOLOGY_NAMES_QUERY, parseTopologyNames, topologyNameParameters } from "./names.js";
import { sql } from "@databricks/appkit";
//#region server/collect/topology/collector.ts
const TABLE_SIDE_RELATIONS = [
	"table-to-table",
	"job-to-table",
	"pipeline-to-table",
	"warehouse-to-table"
];
/**
* One statement per table-side relation. The query name is the file under
* `config/topology/`; the spec is what the parser adds that the SQL does not.
*/
const TABLE_SIDE = {
	"table-to-table": {
		query: "topology_table_to_table",
		spec: {
			relation: "table-to-table",
			sourceKind: "table",
			targetKind: "table",
			joinedBy: "system.access.table_lineage"
		}
	},
	"job-to-table": {
		query: "topology_job_to_table",
		spec: {
			relation: "job-to-table",
			sourceKind: "job",
			targetKind: "table",
			joinedBy: "system.access.table_lineage"
		}
	},
	"pipeline-to-table": {
		query: "topology_pipeline_to_table",
		spec: {
			relation: "pipeline-to-table",
			sourceKind: "pipeline",
			targetKind: "table",
			joinedBy: "system.access.table_lineage"
		}
	},
	"warehouse-to-table": {
		query: "topology_warehouse_to_table",
		spec: {
			relation: "warehouse-to-table",
			sourceKind: "warehouse",
			targetKind: "table",
			joinedBy: "system.access.table_lineage ⋈ system.query.history"
		}
	}
};
const COMPUTE_SIDE_RELATIONS = [
	"job-to-cluster",
	"job-to-warehouse",
	"job-to-job"
];
TOPOLOGY_DECLINED["pipeline-to-cluster"];
const COMPUTE_SIDE = {
	"job-to-cluster": {
		query: "topology_job_to_cluster",
		spec: {
			relation: "job-to-cluster",
			sourceKind: "job",
			targetKind: "cluster",
			joinedBy: "system.lakeflow.job_task_run_timeline"
		}
	},
	"job-to-warehouse": {
		query: "topology_job_to_warehouse",
		spec: {
			relation: "job-to-warehouse",
			sourceKind: "job",
			targetKind: "warehouse",
			joinedBy: "system.lakeflow.job_task_run_timeline"
		}
	},
	"job-to-job": {
		query: "topology_job_to_job",
		spec: {
			relation: "job-to-job",
			sourceKind: "job",
			targetKind: "job",
			joinedBy: "system.lakeflow.job_run_timeline ⋈ system.lakeflow.job_task_run_timeline"
		}
	}
};
const DRAWN = {
	...TABLE_SIDE,
	...COMPUTE_SIDE
};
function topologyQueryDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("topology", moduleUrl);
}
function tableSideQueries(moduleUrl = import.meta.url) {
	return new FileQuerySource(topologyQueryDirectory(moduleUrl));
}
function parameters(lookbackDays, workspaceId) {
	return {
		lookback_days: sql.int(lookbackDays),
		workspace_id: sql.string(workspaceId),
		topology_limit: sql.int(TOPOLOGY_COLLECTOR_CAP)
	};
}
/**
* The four table-side relations, each one statement, concatenated.
*
* Sequential for the same reason the scan collector is: four lineage reads at
* once queue behind each other on a shared warehouse. 101e can ask for one
* relation if it only needs one.
*/
function collectors(options, relations) {
	const queries = options.queries ?? tableSideQueries();
	const bound = parameters(options.lookbackDays ?? 30, options.workspaceId ?? "");
	const run = async (relation) => {
		const entry = DRAWN[relation];
		const rows = rowsOf(await options.executor(queries.text(entry.query), bound, options.signal));
		return parseTopologyEdges(entry.spec, rows);
	};
	return {
		parameters: bound,
		collect: async (relation) => run(relation),
		collectAll: async () => {
			const edges = [];
			for (const relation of relations) edges.push(...await run(relation));
			return edges;
		}
	};
}
function drawnTopology(options) {
	return collectors(options, [...TABLE_SIDE_RELATIONS, ...COMPUTE_SIDE_RELATIONS]);
}
async function collectTopologyNames(options, nodes) {
	if (nodes.every((node) => node.kind === "table")) return {};
	const queries = options.queries ?? tableSideQueries();
	return parseTopologyNames(rowsOf(await options.executor(queries.text(TOPOLOGY_NAMES_QUERY), topologyNameParameters(nodes, options.workspaceId ?? ""), options.signal)));
}
/** The seven exact edge reads followed by one name read for nodes inside the response cap. */
async function collectNamedTopology(options) {
	const edges = await drawnTopology(options).collectAll();
	const nodes = topologyPayload(edges).nodes;
	return {
		edges,
		names: await collectTopologyNames(options, nodes)
	};
}
//#endregion
export { COMPUTE_SIDE, COMPUTE_SIDE_RELATIONS, DRAWN, TABLE_SIDE, TABLE_SIDE_RELATIONS, collectNamedTopology, collectTopologyNames, drawnTopology, tableSideQueries, topologyQueryDirectory };
