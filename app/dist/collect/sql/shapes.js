import { bool, count, date, num, text } from "./rows.js";
//#region server/collect/sql/shapes.ts
/** `DESCRIBE DETAIL` returns array and struct columns as JSON text over the wire. */
function jsonArray(row, column) {
	const raw = text(row, column);
	if (raw == null || raw === "") return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
	} catch {
		return [];
	}
}
/**
* `DESCRIBE DETAIL`'s `properties` column, a map returned as JSON text.
*
* Only string values are kept. Delta table properties are strings by definition — `"30 days"`,
* `"true"`, `"32"` — so a non-string value means the shape is not what this expects, and dropping
* it is safer than coercing: a property read as a number when it is a duration would silently
* answer a retention question wrongly.
*/
function jsonMap(row, column) {
	const raw = text(row, column);
	if (raw == null || raw === "") return {};
	try {
		const parsed = JSON.parse(raw);
		if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
		const map = {};
		for (const [key, value] of Object.entries(parsed)) if (typeof value === "string") map[key] = value;
		return map;
	} catch {
		return {};
	}
}
/** All-purpose clusters are the population most compute controls actually address. */
function isAllPurpose(cluster) {
	return cluster.source === "UI" || cluster.source === "API";
}
/** A job deployed from a bundle, which is the observable half of infrastructure-as-code. */
function fromBundle(job) {
	return (job.deploymentKind ?? "").toUpperCase() === "BUNDLE";
}
/**
* The account's workspaces, and which of them an assessment can be about.
*
* `live` is the set every regional signal is filtered to. The distinction is not cosmetic: the compute
* and job system tables keep a cancelled workspace's rows, so without this filter the estate looks an
* order of magnitude larger than it is and every inventory control reports on resources nobody can
* configure.
*
* The region half of that partition is applied by `scopedToRegion` in region.ts and not by the parser,
* because only the collector knows which workspace the app runs in. Both halves land here so that one
* partition answers the queries, the estate summary and the export — the previous arrangement filtered
* the queries in the collector and left this shape describing the wider set, so a scan covering five
* workspaces reported fifteen.
*/
/**
* The rows of one of a directory's sets, or none where the value is not the shape the type promises.
*
* Needed because a reading can come from a collection an older version of the collector wrote and
* imported here, and every consumer of this shape runs *after* the estate has been read — so a property
* that turned out to be absent takes down an analysis that had already been paid for, rather than
* degrading to an answer with less in it. See `linksIn`, which is where this first cost a run.
*
* A declared guard rather than a bare `Array.isArray`, whose narrowing widens a typed array to `any[]`
* and so trades one unsound read for another.
*/
function rowsOf(value) {
	return isRows(value) ? value : [];
}
function isRows(value) {
	return Array.isArray(value);
}
/** A pipeline that has actually run is the only kind that evidences a working framework. */
function hasRun(pipeline) {
	return pipeline.updates > 0;
}
const parse = {
	computeProfile: (rows) => {
		const parsed = rows.map((row) => ({
			product: text(row, "billing_origin_product") ?? "unknown",
			serverless: bool(row, "is_serverless") ?? false,
			usageRecords: count(row, "usage_records"),
			usageQuantity: count(row, "total_usage_quantity"),
			distinctClusters: count(row, "distinct_clusters"),
			distinctWarehouses: count(row, "distinct_warehouses"),
			distinctJobs: count(row, "distinct_jobs")
		}));
		const classic = parsed.filter((row) => !row.serverless);
		const classicClusters = classic.reduce((sum, row) => sum + row.distinctClusters, 0);
		return {
			rows: parsed,
			classicClusters,
			classicUsage: classic.reduce((sum, row) => sum + row.usageQuantity, 0),
			serverlessUsage: parsed.filter((row) => row.serverless).reduce((sum, row) => sum + row.usageQuantity, 0),
			summary: classicClusters
		};
	},
	clusters: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			clusterId: text(row, "cluster_id") ?? "",
			name: text(row, "cluster_name") ?? "(unnamed)",
			source: text(row, "cluster_source") ?? "UNKNOWN",
			...optional("runtime", text(row, "dbr_version")),
			...optional("dataSecurityMode", text(row, "data_security_mode")),
			hasPolicy: bool(row, "has_policy") ?? false,
			autoscaling: bool(row, "autoscaling") ?? false,
			...optional("autoTerminationMinutes", num(row, "auto_termination_minutes")),
			autoTerminates: bool(row, "auto_terminates") ?? false,
			gpuNode: bool(row, "gpu_node") ?? false,
			...optional("availability", text(row, "availability")),
			initScriptCount: count(row, "init_script_count"),
			dbfsInitScriptCount: count(row, "dbfs_init_script_count"),
			initScriptsKnown: bool(row, "init_scripts_known") ?? false,
			tagCount: count(row, "tag_count"),
			...optional("workerNodeType", text(row, "worker_node_type")),
			workerCount: count(row, "worker_count"),
			minWorkers: count(row, "min_workers"),
			maxWorkers: count(row, "max_workers")
		}));
	},
	warehouses: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			warehouseId: text(row, "warehouse_id") ?? "",
			name: text(row, "warehouse_name") ?? "(unnamed)",
			type: text(row, "warehouse_type") ?? "UNKNOWN",
			serverless: bool(row, "serverless") ?? false,
			...optional("channel", text(row, "warehouse_channel")),
			...optional("size", text(row, "warehouse_size")),
			...optional("minClusters", num(row, "min_clusters")),
			...optional("maxClusters", num(row, "max_clusters")),
			scalesOut: bool(row, "scales_out") ?? false,
			...optional("autoStopMinutes", num(row, "auto_stop_minutes")),
			autoStops: bool(row, "auto_stops") ?? false,
			tagCount: count(row, "tag_count")
		}));
	},
	costAttribution: (rows) => {
		const row = rows[0] ?? {};
		const keys = text(row, "tag_keys");
		return {
			usageRecords: count(row, "usage_records"),
			pricedRecords: count(row, "priced_records"),
			...priceCoverage(row),
			listCost: count(row, "list_cost"),
			customTaggedCost: count(row, "custom_tagged_cost"),
			identifiableCost: count(row, "identifiable_cost"),
			tagKeys: keys == null ? [] : keys.split(",").filter((k) => k !== ""),
			...optional("currency", text(row, "currency"))
		};
	},
	computeMix: (rows) => {
		const row = rows[0] ?? {};
		return {
			totalCost: count(row, "total_cost"),
			serverlessCost: count(row, "serverless_cost"),
			choiceCost: count(row, "choice_cost"),
			serverlessChoiceCost: count(row, "serverless_choice_cost"),
			photonCost: count(row, "photon_cost"),
			photonEligibleCost: count(row, "photon_eligible_cost"),
			allPurposeCost: count(row, "all_purpose_cost"),
			jobsOnAllPurposeCost: count(row, "jobs_on_all_purpose_cost"),
			distinctSkus: count(row, "distinct_skus"),
			usageRecords: count(row, "usage_records"),
			pricedRecords: count(row, "priced_records"),
			...priceCoverage(row)
		};
	},
	jobs: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			jobId: text(row, "job_id") ?? "",
			name: text(row, "name") ?? "(unnamed)",
			...optional("triggerType", text(row, "trigger_type")),
			...optional("continuous", bool(row, "continuous")),
			scheduled: bool(row, "scheduled") ?? false,
			scheduledKnown: bool(row, "scheduled_known") ?? true,
			...optional("changeTime", date(row, "change_time")),
			...optional("paused", bool(row, "paused")),
			...optional("timeoutSeconds", num(row, "timeout_seconds")),
			healthRuleCount: count(row, "health_rule_count"),
			healthRulesKnown: bool(row, "health_rules_known") ?? false,
			hasStreamBacklogRule: bool(row, "has_stream_backlog_rule") ?? false,
			tagCount: count(row, "tag_count"),
			...optional("deploymentKind", text(row, "deployment_kind")),
			...optional("runAs", text(row, "run_as"))
		}));
	},
	jobReadiness: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			jobId: text(row, "job_id") ?? "",
			runs: count(row, "runs"),
			taskRuns: count(row, "task_runs"),
			taskRunsUntimed: count(row, "task_runs_untimed"),
			longestTaskSeconds: count(row, "longest_task_seconds"),
			setupSeconds: count(row, "setup_seconds"),
			executionSeconds: count(row, "execution_seconds"),
			...optional("lastRun", date(row, "last_run")),
			computeUses: count(row, "compute_uses"),
			serverlessUses: count(row, "serverless_uses"),
			warehouseUses: count(row, "warehouse_uses"),
			classicUses: count(row, "classic_uses"),
			unclassifiedUses: count(row, "unclassified_uses"),
			classicClusters: count(row, "classic_clusters"),
			unreadClusters: count(row, "unread_clusters"),
			allPurposeClusters: count(row, "all_purpose_clusters"),
			initScriptClusters: count(row, "init_script_clusters"),
			unknownInitScriptClusters: count(row, "unknown_init_script_clusters"),
			gpuClusters: count(row, "gpu_clusters"),
			pooledClusters: count(row, "pooled_clusters"),
			cloudIdentityClusters: count(row, "cloud_identity_clusters"),
			policyClusters: count(row, "policy_clusters"),
			mlRuntimeClusters: count(row, "ml_runtime_clusters"),
			legacyAccessModeClusters: count(row, "legacy_access_mode_clusters"),
			unknownAccessModeClusters: count(row, "unknown_access_mode_clusters"),
			...optional("oldestRuntimeMajor", num(row, "oldest_runtime_major")),
			clusterNames: list(row, "cluster_names"),
			runtimes: list(row, "runtimes")
		}));
	},
	queryShapes: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			shape: text(row, "shape") ?? "",
			statementType: text(row, "statement_type") ?? "",
			kinds: count(row, "kinds"),
			runsNow: count(row, "runs_now"),
			runsBefore: count(row, "runs_before"),
			measuredNow: count(row, "measured_now"),
			measuredBefore: count(row, "measured_before"),
			msNow: count(row, "ms_now"),
			msBefore: count(row, "ms_before"),
			...optional("meanMsNow", num(row, "mean_ms_now")),
			...optional("meanMsBefore", num(row, "mean_ms_before")),
			...optional("medianMs", num(row, "median_ms")),
			...optional("worstMs", num(row, "worst_ms")),
			spilledBytes: count(row, "spilled_bytes"),
			shuffleBytes: count(row, "shuffle_bytes"),
			readBytes: count(row, "read_bytes"),
			writtenBytes: count(row, "written_bytes"),
			...optional("prunedPercent", num(row, "pruned_percent")),
			readFiles: count(row, "read_files"),
			prunedFiles: count(row, "pruned_files"),
			...optional("parallelism", num(row, "parallelism")),
			...optional("compilationPercent", num(row, "compilation_percent")),
			queueMs: count(row, "queue_ms"),
			cacheHits: count(row, "cache_hits"),
			failures: count(row, "failures"),
			warehouses: count(row, "warehouses"),
			jobs: count(row, "jobs"),
			pipelines: count(row, "pipelines"),
			...optional("statementId", text(row, "statement_id")),
			...optional("statementText", text(row, "statement_text")),
			...optional("representativeAt", date(row, "representative_at")),
			representativeMeasured: bool(row, "representative_measured") ?? false,
			...optional("representativeStatus", text(row, "representative_status")),
			...optional("representativeWarehouseId", text(row, "representative_warehouse_id")),
			...optional("representativeComputeType", text(row, "representative_compute_type")),
			coveredMs: count(row, "covered_ms"),
			excludedMs: count(row, "excluded_ms"),
			selfMs: count(row, "self_ms"),
			coveredRuns: count(row, "covered_runs"),
			excludedRuns: count(row, "excluded_runs"),
			selfRuns: count(row, "self_runs"),
			ambiguousMs: count(row, "ambiguous_ms"),
			ambiguousRuns: count(row, "ambiguous_runs"),
			ambiguousShapes: count(row, "ambiguous_shapes")
		}));
	},
	servingModelEntities: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			servedEntityId: text(row, "served_entity_id") ?? "",
			endpointId: text(row, "endpoint_id") ?? "",
			endpointName: text(row, "endpoint_name") ?? "",
			servedEntityName: text(row, "served_entity_name") ?? "",
			entityType: text(row, "entity_type") ?? "",
			...optional("entityName", text(row, "entity_name")),
			...optional("entityVersion", text(row, "entity_version")),
			...optional("task", text(row, "task")),
			...optional("createdBy", text(row, "created_by")),
			...optional("changedAt", date(row, "change_time")),
			requests: count(row, "requests"),
			daysWithTraffic: count(row, "days_with_traffic"),
			failedRequests: count(row, "failed_requests"),
			requestsWithoutStatus: count(row, "requests_without_status"),
			...optional("lastRequest", date(row, "last_request")),
			liveEntities: count(row, "live_entities"),
			liveEndpoints: count(row, "live_endpoints"),
			customModels: count(row, "custom_models"),
			foundationModels: count(row, "foundation_models"),
			externalModels: count(row, "external_models"),
			featureSpecs: count(row, "feature_specs"),
			customModelsWithAVersion: count(row, "custom_models_with_a_version"),
			customModelsNamedInUc: count(row, "custom_models_named_in_uc")
		}));
	},
	mlflowRunTracking: (rows) => {
		const row = rows[0] ?? {};
		return {
			runs: count(row, "runs"),
			experimentsWithRuns: count(row, "experiments_with_runs"),
			runsFromAJob: count(row, "runs_from_a_job"),
			experimentsWithAJobRun: count(row, "experiments_with_a_job_run"),
			runsFromANotebook: count(row, "runs_from_a_notebook"),
			runsFromElsewhere: count(row, "runs_from_elsewhere"),
			runsFromAProject: count(row, "runs_from_a_project"),
			runsWithoutASource: count(row, "runs_without_a_source"),
			runsThatFinished: count(row, "runs_that_finished"),
			experiments: count(row, "experiments"),
			liveExperiments: count(row, "live_experiments")
		};
	},
	writePatterns: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			shape: text(row, "shape") ?? "",
			statementType: text(row, "statement_type") ?? "",
			runs: count(row, "runs"),
			finishedRuns: count(row, "finished_runs"),
			daysRun: count(row, "days_run"),
			runsStatingBytes: count(row, "runs_stating_bytes"),
			writtenBytes: count(row, "written_bytes"),
			...optional("largestWriteBytes", num(row, "largest_write_bytes")),
			...optional("medianWriteBytes", num(row, "median_write_bytes")),
			readBytes: count(row, "read_bytes"),
			producedRows: count(row, "produced_rows"),
			totalMs: count(row, "total_ms"),
			...optional("firstSeen", date(row, "first_seen")),
			...optional("lastSeen", date(row, "last_seen")),
			...optional("statementId", text(row, "statement_id")),
			...optional("statementText", text(row, "statement_text")),
			...optional("representativeAt", date(row, "representative_at")),
			writeStatements: count(row, "write_statements"),
			writesStatingBytes: count(row, "writes_stating_bytes"),
			estateWrittenBytes: count(row, "estate_written_bytes"),
			otherStatements: count(row, "other_statements")
		}));
	},
	tableStatistics: (rows) => ({ tables: rows.flatMap((row) => {
		const table = text(row, "table_name");
		const analysedAt = date(row, "analysed_at");
		if (table == null || table === "" || analysedAt == null) return [];
		return [{
			table,
			analysedAt,
			analyseOperations: count(row, "analyse_operations"),
			...optional("writtenAt", date(row, "written_at")),
			...optional("writeEvents", num(row, "write_events")),
			...optional("hoursWrittenAfterAnalyse", num(row, "hours_written_after_analyse"))
		}];
	}) }),
	jobRunHealth: (rows) => ({ jobs: rows.flatMap((row) => {
		const workspaceId = text(row, "workspace_id");
		const jobId = text(row, "job_id");
		if (workspaceId == null || workspaceId === "" || jobId == null || jobId === "") return [];
		return [{
			workspaceId,
			jobId,
			runs: count(row, "runs"),
			wallSecondsTotal: count(row, "wall_seconds_total"),
			wallSecondsMean: count(row, "wall_seconds_mean"),
			wallSecondsP95: count(row, "wall_seconds_p95"),
			wallSecondsMedian: count(row, "wall_seconds_median"),
			wallSecondsMax: count(row, "wall_seconds_max"),
			longestTaskSeconds: count(row, "longest_task_seconds"),
			taskSecondsTotal: count(row, "task_seconds_total"),
			tasksMost: count(row, "tasks_most"),
			runsWithARepeatedTask: count(row, "runs_with_a_repeated_task"),
			repeatedTaskRuns: count(row, "repeated_task_runs"),
			...optional("lastRun", date(row, "last_run")),
			...optional("busiestTaskKey", text(row, "busiest_task_key")),
			...optional("busiestTaskSeconds", num(row, "busiest_task_seconds")),
			...optional("runsWithATerminalPeriod", num(row, "runs_with_a_terminal_period")),
			...optional("runsSucceeded", num(row, "runs_succeeded")),
			...optional("runsDidNotSucceed", num(row, "runs_did_not_succeed")),
			...optional("runsUnresolved", num(row, "runs_unresolved")),
			...optional("runsWithATerminationCode", num(row, "runs_with_a_termination_code")),
			...optional("usageQuantity", num(row, "usage_quantity")),
			...optional("usageRecords", num(row, "usage_records")),
			...optional("usageRetractions", num(row, "usage_retractions")),
			...optional("usageSkus", num(row, "usage_skus")),
			...optional("classicUsageRecords", num(row, "classic_usage_records")),
			...optional("classicRecordsStatingPhoton", num(row, "classic_records_stating_photon")),
			...optional("classicRecordsWithPhotonOff", num(row, "classic_records_with_photon_off")),
			jobPopulation: count(row, "job_population")
		}];
	}) }),
	jobCompute: (rows) => ({ jobs: rows.flatMap((row) => {
		const workspaceId = text(row, "workspace_id");
		const jobId = text(row, "job_id");
		if (workspaceId == null || workspaceId === "" || jobId == null || jobId === "") return [];
		return [{
			workspaceId,
			jobId,
			runClusterPairs: count(row, "run_cluster_pairs"),
			runsWithWorkerSamples: count(row, "runs_with_worker_samples"),
			clusters: count(row, "clusters"),
			workerSamples: count(row, "worker_samples"),
			pairsBelowThreeSamples: count(row, "pairs_below_three_samples"),
			avgCpuPercent: count(row, "avg_cpu_percent"),
			peakCpuPercent: count(row, "peak_cpu_percent"),
			avgCpuWaitPercent: count(row, "avg_cpu_wait_percent"),
			avgMemoryPercent: count(row, "avg_memory_percent"),
			peakMemoryPercent: count(row, "peak_memory_percent"),
			avgSwapPercent: count(row, "avg_swap_percent"),
			...optional("networkBytesPerNodeMinute", num(row, "network_bytes_per_node_minute")),
			pairsWithANetworkRate: count(row, "pairs_with_a_network_rate"),
			pairsStatingNoNetwork: count(row, "pairs_stating_no_network"),
			...optional("estateMedianBytesPerNodeMinute", num(row, "estate_median_bytes_per_node_minute")),
			estatePairsWithARate: count(row, "estate_pairs_with_a_rate"),
			...optional("nodeType", text(row, "node_type")),
			pairsWithAnAsOfConfig: count(row, "pairs_with_an_as_of_config"),
			...optional("workerCount", num(row, "worker_count")),
			runsWithNoSetupFigure: count(row, "runs_with_no_setup_figure"),
			...optional("setupSecondsMax", num(row, "setup_seconds_max")),
			...optional("setupSecondsMean", num(row, "setup_seconds_mean")),
			...optional("statedRunSecondsMean", num(row, "stated_run_seconds_mean")),
			...optional("earliestSample", date(row, "earliest_sample")),
			...optional("latestSample", date(row, "latest_sample")),
			jobsThatRan: count(row, "jobs_that_ran"),
			jobsWithAComputeId: count(row, "jobs_with_a_compute_id"),
			jobsOnClassicCompute: count(row, "jobs_on_classic_compute"),
			jobPopulation: count(row, "job_population")
		}];
	}) }),
	sqlPaths: (rows) => {
		const row = rows[0] ?? {};
		return {
			statements: count(row, "statements"),
			warehouseStatements: count(row, "warehouse_statements"),
			allPurposeStatements: count(row, "all_purpose_statements"),
			jobClusterStatements: count(row, "job_cluster_statements"),
			unattributedStatements: count(row, "unattributed_statements"),
			interactiveStatements: count(row, "interactive_statements"),
			interactiveWarehouseStatements: count(row, "interactive_warehouse_statements"),
			interactiveAllPurposeStatements: count(row, "interactive_all_purpose_statements"),
			fileReadingStatements: count(row, "file_reading_statements"),
			fileReadBytes: count(row, "file_read_bytes"),
			cachedReadBytes: count(row, "cached_read_bytes"),
			resultCacheHits: count(row, "result_cache_hits"),
			unnamedClientStatements: count(row, "unnamed_client_statements"),
			clientCount: count(row, "client_count"),
			clients: list(row, "clients")
		};
	},
	warehousePressure: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			warehouseId: text(row, "warehouse_id") ?? "",
			runs: count(row, "runs"),
			measured: count(row, "measured"),
			totalMs: count(row, "total_ms"),
			busyMs: count(row, "busy_ms"),
			queueMs: count(row, "queue_ms"),
			spilledBytes: count(row, "spilled_bytes"),
			peakUsers: count(row, "peak_users"),
			daysUsed: count(row, "days_used"),
			daysQueued: count(row, "days_queued"),
			daysSpilled: count(row, "days_spilled"),
			...optional("p95Ms", num(row, "p95_ms")),
			...optional("worstMs", num(row, "worst_ms")),
			...optional("worstQueueMs", num(row, "worst_queue_ms")),
			upMs: count(row, "up_ms"),
			clusterMs: count(row, "cluster_ms"),
			starts: count(row, "starts"),
			peakClusters: count(row, "peak_clusters"),
			daysSeen: count(row, "days_seen"),
			carriedIn: bool(row, "carried_in") ?? false,
			...optional("executionPercent", num(row, "execution_percent")),
			...optional("queuePercent", num(row, "queue_percent")),
			ranAssessment: bool(row, "ran_assessment") ?? false,
			warehousePopulation: count(row, "warehouse_population")
		}));
	},
	jobSpend: (rows) => {
		return rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			jobId: text(row, "job_id") ?? "",
			cost: count(row, "cost"),
			serverlessCost: count(row, "serverless_cost"),
			classicCost: count(row, "classic_cost"),
			classicDbus: count(row, "classic_dbus"),
			unpricedRecords: count(row, "unpriced_records"),
			...optional("currency", text(row, "currency")),
			...optional("serverlessRate", num(row, "serverless_rate")),
			...optional("serverlessRegion", text(row, "serverless_region")),
			classicSkus: list(row, "classic_skus")
		}));
	},
	workspaceDirectory: (rows) => {
		const workspaces = rows.map((row) => ({
			workspaceId: text(row, "workspace_id") ?? "",
			name: text(row, "workspace_name") ?? "(unnamed)",
			...optional("url", text(row, "workspace_url")),
			status: text(row, "status") ?? "UNKNOWN",
			...optional("region", text(row, "region")),
			live: bool(row, "live") ?? false
		}));
		return {
			workspaces,
			live: workspaces.filter((workspace) => workspace.live),
			excluded: workspaces.filter((workspace) => !workspace.live).map((workspace) => ({
				...workspace,
				reason: "not-running"
			})),
			regionUnverified: [],
			outOfScope: []
		};
	},
	assetCensus: (rows) => {
		const row = rows[0] ?? {};
		return {
			tableCount: count(row, "table_count"),
			catalogCount: count(row, "catalog_count"),
			schemaCount: count(row, "schema_count"),
			managedTables: count(row, "managed_tables"),
			externalTables: count(row, "external_tables"),
			views: count(row, "views"),
			metricViews: count(row, "metric_views"),
			foreignTables: count(row, "foreign_tables"),
			deltaTables: count(row, "delta_tables"),
			icebergTables: count(row, "iceberg_tables"),
			optimizedFormatTables: count(row, "optimized_format_tables"),
			describedTables: count(row, "described_tables"),
			distinctOwners: count(row, "distinct_owners"),
			databricksOwnedTables: count(row, "databricks_owned_tables"),
			databricksOwnedCatalogs: text(row, "databricks_owned_catalogs") ?? ""
		};
	},
	discoveryMetadata: (rows) => {
		const row = rows[0] ?? {};
		return {
			estateTables: count(row, "estate_tables"),
			estateTablesDescribed: count(row, "estate_tables_described"),
			readTables: count(row, "read_tables"),
			readTablesDescribed: count(row, "read_tables_described"),
			readTablesTagged: count(row, "read_tables_tagged"),
			readTablesOwned: count(row, "read_tables_owned"),
			readEvents: count(row, "read_events")
		};
	},
	discoveryColumns: (rows) => {
		const row = rows[0] ?? {};
		return {
			readTableColumns: count(row, "read_table_columns"),
			readTableColumnsDescribed: count(row, "read_table_columns_described")
		};
	},
	platformCensus: (rows) => {
		const row = rows[0] ?? {};
		return {
			shares: count(row, "shares"),
			recipients: count(row, "recipients"),
			tokenRecipients: count(row, "token_recipients"),
			recipientsWithIpAllowlist: count(row, "recipients_with_ip_allowlist"),
			providers: count(row, "providers"),
			connections: count(row, "connections"),
			connectionTypes: text(row, "connection_types") ?? "",
			externalLocations: count(row, "external_locations"),
			storageCredentials: count(row, "storage_credentials"),
			volumes: count(row, "volumes"),
			managedVolumes: count(row, "managed_volumes"),
			routines: count(row, "routines"),
			columnMasks: count(row, "column_masks"),
			rowFilters: count(row, "row_filters"),
			taggedTables: count(row, "tagged_tables"),
			taggedColumns: count(row, "tagged_columns"),
			ownsMetastore: bool(row, "owns_metastore") ?? false,
			sharingPrivileges: (text(row, "sharing_privileges") ?? "").split(",").filter((one) => one !== "")
		};
	},
	pipelines: (rows) => rows.map((row) => ({
		workspaceId: text(row, "workspace_id") ?? "",
		pipelineId: text(row, "pipeline_id") ?? "",
		name: text(row, "name") ?? "(unnamed)",
		...optional("pipelineType", text(row, "pipeline_type")),
		development: bool(row, "development") ?? false,
		serverless: bool(row, "serverless") ?? false,
		photon: bool(row, "photon") ?? false,
		...optional("edition", text(row, "edition")),
		...optional("channel", text(row, "channel")),
		...optional("runAs", text(row, "run_as")),
		tagCount: count(row, "tag_count"),
		updates: count(row, "updates"),
		failedUpdates: count(row, "failed_updates")
	})),
	servingPopulation: (rows) => ({
		matchPopulation: count(rows[0] ?? {}, "match_population"),
		matches: rows.map((row) => ({
			qualified: text(row, "qualified") ?? "",
			catalog: text(row, "table_catalog") ?? "",
			schema: text(row, "table_schema") ?? "",
			table: text(row, "table_name") ?? "",
			description: text(row, "table_comment") ?? null,
			owner: text(row, "table_owner") ?? null,
			...optional("tagKey", text(row, "tag_key")),
			...optional("tagValue", text(row, "tag_value")),
			...optional("tagLevel", text(row, "tag_level"))
		}))
	}),
	servingTags: (rows) => ({
		tagPopulation: count(rows[0] ?? {}, "tag_population"),
		tags: rows.map((row) => ({
			qualified: text(row, "qualified") ?? "",
			key: text(row, "tag_key") ?? "",
			value: text(row, "tag_value") ?? ""
		}))
	}),
	servingFacts: (rows) => ({
		assetPopulation: count(rows[0] ?? {}, "asset_population"),
		assets: rows.map((row) => ({
			qualified: text(row, "qualified") ?? "",
			relationKind: text(row, "relation_kind") ?? null,
			storageFormat: text(row, "storage_format") ?? null,
			columnCount: count(row, "column_count"),
			commentedColumns: count(row, "commented_columns"),
			lineageEvents: count(row, "lineage_events"),
			semanticReaders: count(row, "semantic_readers"),
			maskedColumns: count(row, "masked_columns"),
			rowFilters: count(row, "row_filters")
		}))
	}),
	qualityMonitoring: (rows) => {
		const row = rows[0] ?? {};
		return {
			estateTables: count(row, "estate_tables"),
			estateCatalogs: count(row, "estate_catalogs"),
			monitoredTables: count(row, "monitored_tables"),
			monitoredCatalogs: count(row, "monitored_catalogs"),
			healthy: count(row, "healthy"),
			unhealthy: count(row, "unhealthy"),
			training: count(row, "training"),
			errored: count(row, "errored"),
			unnamedStatus: count(row, "unnamed_status"),
			freshnessPresent: count(row, "freshness_present"),
			completenessPresent: count(row, "completeness_present"),
			freshnessEstablished: count(row, "freshness_established"),
			completenessEstablished: count(row, "completeness_established")
		};
	},
	servingQuality: (rows) => ({
		qualityPopulation: count(rows[0] ?? {}, "quality_population"),
		statuses: rows.map((row) => ({
			qualified: text(row, "qualified") ?? "",
			qualityStatus: text(row, "quality_status") ?? null
		}))
	}),
	servingClasses: (rows) => ({
		classPopulation: count(rows[0] ?? {}, "class_population"),
		classified: rows.map((row) => ({
			qualified: text(row, "qualified") ?? "",
			classifications: list(row, "classifications")
		}))
	}),
	schemaCensus: (rows) => ({
		schemaPopulation: count(rows[0] ?? {}, "schema_population"),
		schemas: rows.map((row) => ({
			catalog: text(row, "table_catalog") ?? "(unknown)",
			schema: text(row, "table_schema") ?? "(unknown)",
			tableCount: count(row, "table_count"),
			managedTables: count(row, "managed_tables"),
			externalTables: count(row, "external_tables"),
			views: count(row, "views"),
			metricViews: count(row, "metric_views"),
			foreignTables: count(row, "foreign_tables"),
			optimizedFormatTables: count(row, "optimized_format_tables"),
			describedTables: count(row, "described_tables"),
			distinctOwners: count(row, "distinct_owners")
		}))
	}),
	lineageCoverage: (rows) => {
		const row = rows[0] ?? {};
		return {
			tableCount: count(row, "table_count"),
			tablesWithLineage: count(row, "tables_with_lineage"),
			tablesWrittenWithLineage: count(row, "tables_written_with_lineage"),
			tablesReadWithLineage: count(row, "tables_read_with_lineage"),
			lineageEvents: count(row, "lineage_events"),
			...optional("lastEvent", date(row, "last_event"))
		};
	},
	auditCoverage: (rows) => {
		const row = rows[0] ?? {};
		return {
			events: count(row, "events"),
			services: count(row, "services"),
			actions: count(row, "actions"),
			actors: count(row, "actors"),
			...optional("lastEvent", date(row, "last_event")),
			...optional("daysSinceLastEvent", num(row, "days_since_last_event")),
			unityCatalogEvents: count(row, "unity_catalog_events")
		};
	},
	authLoginPaths: (rows) => {
		const row = rows[0] ?? {};
		return {
			loginEvents: count(row, "login_events"),
			passwordLogins: count(row, "password_logins"),
			samlLogins: count(row, "saml_logins"),
			oidcLogins: count(row, "oidc_logins"),
			otherAuthEvents: count(row, "other_auth_events"),
			otherAuthActions: list(row, "other_auth_actions"),
			accountPlaneEvents: count(row, "account_plane_events"),
			passwordActors: count(row, "password_actors"),
			...optional("lastPasswordLogin", date(row, "last_password_login"))
		};
	},
	nodeUtilization: (rows) => {
		const row = rows[0] ?? {};
		return {
			nodeSamples: count(row, "node_samples"),
			clustersObserved: count(row, "clusters_observed"),
			idleClusters: count(row, "idle_clusters"),
			...optional("lastSample", date(row, "last_sample"))
		};
	},
	storageMetrics: (rows) => {
		const estate = rows.find((row) => text(row, "row_kind") === "estate") ?? {};
		const tableCount = count(estate, "table_count");
		return {
			snapshotAvailable: tableCount > 0,
			...optional("snapshotDate", date(estate, "snapshot_date")),
			tableCount,
			activeBytes: count(estate, "active_bytes"),
			activeFiles: count(estate, "active_files"),
			predictiveOptimizationTables: count(estate, "po_tables"),
			largest: rows.filter((row) => text(row, "row_kind") === "table").map((row) => ({
				catalog: text(row, "catalog_name") ?? "",
				schema: text(row, "schema_name") ?? "",
				table: text(row, "table_name") ?? "",
				...optional("tableType", text(row, "table_type")),
				activeBytes: count(row, "active_bytes"),
				activeFiles: count(row, "active_files"),
				predictiveOptimization: count(row, "po_tables") > 0
			}))
		};
	},
	sampleSelection: (rows) => {
		const candidates = rows.map((row) => ({
			catalog: text(row, "table_catalog") ?? "",
			schema: text(row, "table_schema") ?? "",
			table: text(row, "table_name") ?? "",
			...optional("tableType", text(row, "table_type")),
			readEvents: count(row, "read_events")
		}));
		return {
			candidates,
			eligibleTables: count(rows[0] ?? {}, "eligible_tables"),
			activeTables: candidates.filter((candidate) => candidate.readEvents > 0).length
		};
	},
	catalogs: (rows) => ({ catalogs: rows.map((row) => ({
		catalog: text(row, "catalog_name") ?? "unknown",
		tableCount: count(row, "table_count"),
		managedTables: count(row, "managed_tables"),
		schemaCount: count(row, "schema_count")
	})) }),
	maintenance: (rows) => {
		return { operations: rows.map((row) => {
			const raw = text(row, "source");
			return {
				source: raw === "predictive_optimization" ? "predictive_optimization" : raw === "manual_unresolved" ? "manual_unresolved" : "manual",
				operation: text(row, "operation_type") ?? "UNKNOWN",
				operations: count(row, "operations"),
				...optional("lastRun", date(row, "last_run")),
				...optional("tablesTouched", num(row, "tables_touched"))
			};
		}) };
	}
};
/**
* Include a key only when it has a value.
*
* `exactOptionalPropertyTypes` distinguishes an absent property from one set to
* undefined, and the distinction is the point: an optional field that is present
* and undefined would satisfy a `field != null` guard nowhere but would still
* serialise as `"field": null`, turning "the system table has not recorded this"
* into an apparent value.
*/
/**
* The price-coverage columns the two priced billing statements share.
*
* Read together and in one place so a statement cannot carry half of them: the per-unit pair without
* `currencies` would gate on coverage while still labelling a mixed-currency sum with one currency.
* The optional ones are read with `num`, not `count`, because absent has to stay absent — a missing
* `least_priced_share` coerced to zero reads as a wholly unpriced estate and refuses every figure.
*/
function priceCoverage(row) {
	return {
		unpricedRecords: count(row, "unpriced_records"),
		...optional("leastPricedUnit", text(row, "least_priced_unit")),
		...optional("leastPricedShare", num(row, "least_priced_share")),
		...optional("usageUnitCount", num(row, "usage_unit_count")),
		...optional("currencies", num(row, "currencies")),
		...optional("duplicatePriceMatches", num(row, "duplicate_price_matches")),
		...optional("currency", text(row, "currency"))
	};
}
function optional(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
/**
* A comma-joined column as a list.
*
* The statements that return a sample of names join them in SQL rather than returning an
* array, because an array column arrives as JSON text over the wire and a list of names is
* not worth a JSON parse. Empty entries are dropped: `concat_ws` skips nulls but a column
* with nothing in it still arrives as the empty string.
*/
function list(row, column) {
	const joined = text(row, column);
	return joined == null ? [] : joined.split(",").filter((item) => item !== "");
}
//#endregion
export { fromBundle, hasRun, isAllPurpose, jsonArray, jsonMap, parse, rowsOf };
