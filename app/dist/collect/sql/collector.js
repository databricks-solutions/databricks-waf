import { observed, unmeasurable } from "../signal.js";
import { boundProblem, declaredBound } from "./bounds.js";
import { declaredSlice, orderKey } from "./slices.js";
import { bucketColumn, bucketed, describeBucket } from "./buckets.js";
import { collectSlices, describeShortfall, sliceGroups } from "./sliced.js";
import { FileQuerySource } from "./queries.js";
import { parse } from "./shapes.js";
import { scopedToRegion } from "./region.js";
import { scopedToSelection } from "./selection.js";
import { sql } from "@databricks/appkit";
//#region server/collect/sql/collector.ts
/** The default row ceiling for the three serving statements. See `servingLimit`. */
const SERVING_LIMIT = 2e3;
/**
* Why an empty per-table snapshot is not an estate of zero bytes.
*
* `system.storage.table_metrics_history` has the right schema and is undocumented, and it
* held no rows against 347 catalogued tables on the workspace this was measured on. So the
* absence has to be reported as an absence: the alternative reads as a customer with no
* stored data and no maintenance debt, which is the most flattering possible wrong answer.
*/
const SNAPSHOT_EMPTY = "The per-table storage snapshot (system.storage.table_metrics_history) returned no rows for this metastore, so per-table size, file counts and predictive-optimization coverage could not be read. This is a platform snapshot the app cannot populate, and it is reported as unmeasured rather than as an estate of zero bytes. The bounded per-table pass covers a sample of the same ground.";
/**
* One entry per statement: what it reads, what it needs, and how far it reaches.
*
* Only the directory reaches the account. Everything taking `live_workspace_ids` is filtered to the
* workspaces this deployment can assess, which is one metastore's region — either because the table is
* regional, or because it is global and deliberately narrowed to agree with the ones that are not. Ten of
* these declared `account` until E1: the mis-declaration predated the region filter, because
* `system.compute.clusters` was always regional, and the filter only made the over-claim visible by
* making the numbers move. `declares no wider reach than its filter allows` in the tests holds this.
*/
const DEFINITIONS = {
	"sql:estate.workspaces": {
		query: "workspace_directory",
		parse: parse.workspaceDirectory,
		params: ["lookback_days"],
		reach: "account"
	},
	"sql:estate.compute_profile": {
		query: "estate_compute_profile",
		parse: parse.computeProfile,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:compute.clusters": {
		query: "compute_cluster_inventory",
		parse: parse.clusters,
		params: ["workspace_id", "live_workspace_ids"],
		reach: "metastore"
	},
	"sql:compute.warehouses": {
		query: "compute_warehouse_inventory",
		parse: parse.warehouses,
		params: ["workspace_id", "live_workspace_ids"],
		reach: "metastore"
	},
	"sql:compute.node_utilization": {
		query: "node_utilization",
		parse: parse.nodeUtilization,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:cost.attribution": {
		query: "cost_attribution_coverage",
		parse: parse.costAttribution,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:cost.compute_mix": {
		query: "cost_compute_mix",
		parse: parse.computeMix,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:jobs.inventory": {
		query: "jobs_inventory",
		parse: parse.jobs,
		params: ["workspace_id", "live_workspace_ids"],
		reach: "metastore"
	},
	"sql:serverless.job_readiness": {
		query: "serverless_job_readiness",
		parse: parse.jobReadiness,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:workload.query_shapes": {
		query: "workload_query_shapes",
		parse: parse.queryShapes,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"shape_limit"
		],
		reach: "metastore"
	},
	"sql:workload.write_patterns": {
		query: "workload_write_patterns",
		parse: parse.writePatterns,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"shape_limit"
		],
		reach: "metastore"
	},
	"sql:workload.table_statistics": {
		query: "workload_table_statistics",
		parse: parse.tableStatistics,
		params: ["lookback_days", "stats_limit"],
		reach: "metastore"
	},
	"sql:workload.job_run_health": {
		query: "job_run_health",
		parse: parse.jobRunHealth,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"job_limit"
		],
		reach: "metastore"
	},
	"sql:workload.job_compute_utilisation": {
		query: "job_compute_utilisation",
		parse: parse.jobCompute,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"job_limit"
		],
		reach: "metastore"
	},
	"sql:workload.sql_paths": {
		query: "workload_sql_paths",
		parse: parse.sqlPaths,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:workload.warehouse_pressure": {
		query: "workload_warehouse_pressure",
		parse: parse.warehousePressure,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"warehouse_limit"
		],
		reach: "metastore"
	},
	"sql:serverless.job_spend": {
		query: "serverless_job_spend",
		parse: parse.jobSpend,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:governance.audit_coverage": {
		query: "governance_audit_coverage",
		parse: parse.auditCoverage,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:security.auth_login_paths": {
		query: "auth_login_paths",
		parse: parse.authLoginPaths,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:security.dbfs_tables": {
		query: "security_dbfs_tables",
		parse: parse.dbfsTableAudit,
		params: [],
		reach: "metastore"
	},
	"sql:uc.census": {
		query: "uc_asset_census",
		parse: parse.assetCensus,
		params: [],
		reach: "metastore"
	},
	"sql:uc.platform_census": {
		query: "uc_platform_census",
		parse: parse.platformCensus,
		params: [],
		reach: "metastore"
	},
	"sql:uc.discovery": {
		query: "uc_discovery_metadata",
		parse: parse.discoveryMetadata,
		params: ["lookback_days", "workspace_id"],
		reach: "metastore"
	},
	"sql:uc.discovery_columns": {
		query: "uc_discovery_columns",
		parse: parse.discoveryColumns,
		params: ["lookback_days", "workspace_id"],
		reach: "metastore"
	},
	"sql:uc.quality_monitoring": {
		query: "uc_quality_monitoring",
		parse: parse.qualityMonitoring,
		params: ["lookback_days"],
		reach: "metastore"
	},
	"sql:pipelines.inventory": {
		query: "lakeflow_pipeline_inventory",
		parse: parse.pipelines,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:uc.schema_census": {
		query: "uc_schema_census",
		parse: parse.schemaCensus,
		params: ["segment_limit"],
		reach: "metastore"
	},
	"sql:storage.sample_selection": {
		query: "storage_sample_selection",
		parse: parse.sampleSelection,
		params: [
			"lookback_days",
			"workspace_id",
			"table_limit"
		],
		reach: "metastore"
	},
	"sql:uc.lineage_coverage": {
		query: "uc_lineage_coverage",
		parse: parse.lineageCoverage,
		params: ["lookback_days", "workspace_id"],
		reach: "metastore"
	},
	"sql:storage.table_metrics": {
		query: "storage_table_metrics",
		parse: parse.storageMetrics,
		params: ["table_limit"],
		reach: "metastore",
		noAnswer: (value) => value.snapshotAvailable ? void 0 : SNAPSHOT_EMPTY
	},
	"sql:uc.catalogs": {
		query: "uc_catalog_inventory",
		parse: parse.catalogs,
		params: [],
		reach: "metastore"
	},
	"sql:maintenance.recency": {
		query: "maintenance_recency",
		parse: parse.maintenance,
		params: ["lookback_days", "workspace_id"],
		reach: "metastore"
	},
	"sql:serving.population": {
		query: "serving_population",
		parse: parse.servingPopulation,
		params: [
			"serving_names",
			"serving_tag_keys",
			"serving_limit"
		],
		reach: "metastore"
	},
	"sql:serving.tags": {
		query: "serving_asset_tags",
		parse: parse.servingTags,
		params: ["serving_assets", "serving_limit"],
		reach: "metastore"
	},
	"sql:serving.facts": {
		query: "serving_asset_facts",
		parse: parse.servingFacts,
		params: [
			"serving_assets",
			"serving_limit",
			"lookback_days"
		],
		reach: "metastore"
	},
	"sql:serving.quality": {
		query: "serving_asset_quality",
		parse: parse.servingQuality,
		params: [
			"serving_assets",
			"serving_limit",
			"lookback_days"
		],
		reach: "metastore"
	},
	"sql:serving.classes": {
		query: "serving_asset_classifications",
		parse: parse.servingClasses,
		params: ["serving_assets", "serving_limit"],
		reach: "metastore"
	},
	"sql:serving.model_entities": {
		query: "serving_model_entities",
		parse: parse.servingModelEntities,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids",
			"serving_entity_limit"
		],
		reach: "metastore"
	},
	"sql:mlflow.run_tracking": {
		query: "mlflow_run_tracking",
		parse: parse.mlflowRunTracking,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	},
	"sql:query.capacity": {
		query: "query_capacity",
		parse: parse.queryCapacity,
		params: [
			"lookback_days",
			"workspace_id",
			"live_workspace_ids"
		],
		reach: "metastore"
	}
};
/**
* The workspace directory, which every other account-reach statement filters on.
*
* Named rather than inlined because the collect loop has to recognise it: it runs before
* the others regardless of the order it was asked for.
*/
const DIRECTORY_SIGNAL = "sql:estate.workspaces";
/** The one signal on this surface whose coverage can be short of complete. */
const SCHEMA_CENSUS_SIGNAL = "sql:uc.schema_census";
const SQL_SIGNALS = Object.keys(DEFINITIONS);
/**
* The query file and reach behind each signal, for the requirements page.
*
* Exported as the definitions' own fields rather than restated, so the page describes the
* statement that runs. What that statement reads is not here because it is not declared
* anywhere: it is read out of the query text by `tablesRead`, which cannot disagree with
* the file the collector loads.
*/
const SQL_SIGNAL_SOURCES = Object.fromEntries(Object.entries(DEFINITIONS).map(([id, definition]) => [id, {
	query: definition.query,
	reach: definition.reach
}]));
Object.values(DEFINITIONS).map((definition) => definition.query);
Object.fromEntries(Object.values(DEFINITIONS).map((definition) => [definition.query, definition.params]));
var SqlCollector = class {
	options;
	surface = "sql";
	name = "system-tables";
	signals = SQL_SIGNALS;
	/**
	* Declared even though this collector produces it, so the scan plan includes it.
	*
	* The plan collects only what a resolver reads, and no control reads the directory
	* directly — it is a filter, not evidence. Without this it still ran, because the
	* collect loop needs it, but it was absent from the reported signal list: the one
	* statement whose failure would silently widen every count was the one the user could
	* not see had run.
	*/
	requires = [DIRECTORY_SIGNAL];
	queries;
	lookbackDays;
	tableDetailLimit;
	segmentLimit;
	shapeLimit;
	warehouseLimit;
	statsLimit;
	modelEntityLimit;
	jobLimit;
	ledger = new StatementLedger();
	/** The directory statement, kept so it runs once however many signals are requested. */
	directory;
	/** Its parsed value, once observed. Absent means it could not be read. */
	directoryValue;
	constructor(options) {
		this.options = options;
		this.queries = options.queries ?? new FileQuerySource();
		this.lookbackDays = options.lookbackDays ?? 30;
		this.tableDetailLimit = options.tableDetailLimit ?? 200;
		this.segmentLimit = options.segmentLimit ?? 500;
		this.shapeLimit = options.shapeLimit ?? 40;
		this.warehouseLimit = options.warehouseLimit ?? 200;
		this.statsLimit = options.statsLimit ?? 200;
		this.modelEntityLimit = options.modelEntityLimit ?? 200;
		this.jobLimit = options.jobLimit ?? 200;
	}
	spent() {
		return this.ledger.spend(this.surface, this.name);
	}
	async collect(ids, context) {
		const directory = await this.directoryOnce(context);
		const results = [];
		for (const id of ids) {
			if (id !== "sql:estate.workspaces" && context.collected.has(id)) continue;
			const result = id === "sql:estate.workspaces" ? directory : await this.collectOne(id, context);
			results.push(result);
			await context.settled?.(result);
		}
		return results;
	}
	/**
	* The workspace directory, collected at most once per scan.
	*
	* Memoised on the promise rather than the value so two callers racing cannot issue the
	* statement twice — it is charged to the same warehouse budget as everything else.
	*/
	directoryOnce(context) {
		this.directory ??= this.collectOne(DIRECTORY_SIGNAL, context);
		return this.directory;
	}
	/**
	* The comma-separated live workspace ids, or empty when they could not be determined.
	*
	* Empty is the same convention the workspace filter uses: the queries read it as no
	* filter. That is deliberately the degraded path rather than a scan failure — the
	* directory table is in Public Preview and may be unreadable, and refusing to assess
	* anything at all would be a worse trade than assessing a wider set and saying so.
	*/
	liveWorkspaceIds() {
		if (this.directoryValue == null) return "";
		return this.directoryValue.live.map((workspace) => workspace.workspaceId).join(",");
	}
	/** The directory as this run's scope leaves it: this deployment's region, then what was asked for. */
	narrowed(parsed) {
		const regional = scopedToRegion(parsed, this.options.scope.hostWorkspaceId);
		const selected = this.options.scope.selected;
		return selected == null ? regional : scopedToSelection(regional, selected);
	}
	/**
	* Why a statement that filters on the workspace set must not run, when a scope was asked for.
	*
	* The filter reads an empty parameter as no filter, which is the right degraded behaviour for a scan
	* of the whole estate: the directory table is in Public Preview and may be unreadable, and assessing
	* a wider set while saying so beats assessing nothing. Under a selected scope it is the wrong
	* behaviour and a worse failure than the one it replaces — the run would read every workspace in the
	* account while its own scope, description and export all said it read six. So the statements that
	* cannot be narrowed are refused, and each says which of the two reasons applies.
	*
	* Only the statements taking the filter. The rest answer for their whole reach either way, and the
	* estate note is where that is said, because refusing them would leave a narrowed run unable to
	* measure the metastore it is attached to.
	*/
	unscopable(definition) {
		const selected = this.options.scope.selected;
		if (selected == null) return void 0;
		if (!definition.params.includes("live_workspace_ids")) return void 0;
		if (this.directoryValue == null) return "This assessment names the workspaces it covers, and the workspace directory could not be read, so there is no way to hold this statement to them. Reading it unfiltered would report on every workspace in the account under a scope that names a few, so it was not read.";
		if (this.directoryValue.live.length > 0) return void 0;
		return `None of the ${String(selected.length)} workspaces this assessment names is assessable — each is stopped, in a region this deployment cannot read, or no longer in the account — so this statement had nothing to read. The estate beside this scan says which.`;
	}
	async collectOne(id, context) {
		const definition = DEFINITIONS[id];
		if (definition == null) return unmeasurable(id, `No system-table query is defined for ${id}.`);
		const reach = this.options.scope.narrowedTo != null ? "workspace" : definition.reach;
		const unread = (reason) => unmeasurable(id, reason, {
			mode: "complete",
			reach
		});
		const unscopable = this.unscopable(definition);
		if (unscopable != null) return unread(unscopable);
		const started = Date.now();
		const statement = this.queries.text(definition.query);
		const groups = this.sliceInto(definition, statement);
		const outcome = groups == null ? await this.runOnce(id, definition, statement, context) : await this.runSliced(id, definition, statement, groups, context);
		if (outcome.status === "ok") {
			if (outcome.shortfall != null && outcome.value.rows.length === 0) return unread(describeShortfall(outcome.shortfall));
			const parsed = definition.parse(outcome.value.rows);
			const value = id === "sql:estate.workspaces" ? this.narrowed(parsed) : parsed;
			if (id === "sql:estate.workspaces") this.directoryValue = value;
			const noAnswer = definition.noAnswer?.(value);
			if (noAnswer != null) return unread(noAnswer);
			return observed(id, value, Date.now() - started, coverageOf(id, value, reach, outcome.shortfall));
		}
		if (outcome.status === "skipped") return unread(describeSkip(outcome.reason, outcome.detail));
		return unread(describeFailure(outcome.failure.kind, outcome.failure.message));
	}
	/**
	* The workspace groups to execute this statement once each for, or undefined to run it whole.
	*
	* Four conditions, and each one is a reason not to slice rather than a preference.
	*
	* A statement that does not filter on `live_workspace_ids` has no way to be told which workspaces
	* to answer for. A scan the user narrowed to one workspace already returns one workspace's rows.
	* A statement with no `-- Slice:` header has not been shown to survive the split — `slices.ts` is
	* what shows it, per statement — so an undeclared statement runs whole even if it looks divisible.
	*
	* And fewer than two live workspaces is nothing to spread across: one slice is the whole statement
	* with extra bookkeeping, and none means the directory could not be read, which is the existing
	* degraded path of assessing everything visible and saying so.
	*/
	sliceInto(definition, statement) {
		if (!definition.params.includes("live_workspace_ids")) return void 0;
		if (this.options.scope.narrowedTo != null) return void 0;
		if (declaredSlice(statement)?.columns[0] !== "workspace_id") return void 0;
		const ids = this.liveWorkspaceIds().split(",").filter((id) => id !== "");
		return ids.length > 1 ? sliceGroups(ids) : void 0;
	}
	/** One statement, one scheduled task, all the rows. The path everything but four signals takes. */
	runOnce(id, definition, statement, context) {
		return context.scheduler.run({
			surface: "sql",
			label: id,
			run: (signal) => this.execute(id, definition, statement, this.parameters(definition.params), signal)
		});
	}
	/**
	* One statement, one scheduled task per group of workspaces, the rows concatenated and re-sorted.
	*
	* The loop, the grouping, the ordering and the shortfall are `sliced.ts` and `concat.ts`; what stays
	* here is what only the collector knows — how to bind a group into the statement, which ceiling the
	* whole result is held to, and how a failed slice is worded.
	*/
	async runSliced(id, definition, statement, groups, context) {
		const bucketOn = bucketColumn(statement);
		const reading = await collectSlices({
			groups,
			order: orderKey(statement),
			describe: describeOutcomes,
			...bucketOn == null ? {} : { bucketOn },
			run: (workspaces, bucket) => context.scheduler.run({
				surface: "sql",
				label: `${id} (workspaces ${workspaces.join(",")}, ${describeBucket(bucket)})`,
				run: (signal) => this.execute(id, definition, bucket == null || bucketOn == null ? statement : bucketed(statement, bucketOn, bucket), this.parameters(definition.params, workspaces), signal, false)
			})
		});
		if (reading.status === "none") return reading.outcome;
		this.warnIfOverBound(id, definition, statement, reading.rows.length, this.parameters(definition.params));
		return {
			status: "ok",
			value: { rows: reading.rows },
			attempts: groups.length,
			...reading.shortfall == null ? {} : { shortfall: reading.shortfall }
		};
	}
	/**
	* The executor call and the ledger entry, shared by both paths.
	*
	* The bound check is the caller's, because what it is a check of differs: for one execution it is
	* the whole result, and for a slice it is a fraction of one and comparing it to an estate-wide
	* ceiling would mean nothing.
	*/
	async execute(id, definition, statement, parameters, signal, whole = true) {
		const raw = await this.options.executor(statement, parameters, signal);
		this.ledger.record(raw);
		const rows = rowsOf(raw);
		const truncated = wasTruncated(raw);
		if (whole && truncated) throw new Error("The warehouse returned more data than an inline result can carry, and this statement cannot be divided, so the rows it did return are part of the answer rather than the answer.");
		if (whole) this.warnIfOverBound(id, definition, statement, rows.length, parameters);
		const types = columnTypesOf(raw);
		return {
			rows,
			...types == null ? {} : { types },
			...truncated ? { truncated: true } : {}
		};
	}
	/**
	* The declared row ceiling, warned about rather than enforced.
	*
	* The rows are already in hand and already parseable, and discarding a usable reading because its
	* file's comment was wrong would turn a documentation error into a lost measurement.
	*
	* A warning is the weaker half of this. The strong half is static —
	* `scripts/check-statement-bounds.mjs` refuses a statement that declares nothing or newly declares
	* a count growing with the estate — and the half that exercises it is the scale fixtures, which run
	* these statements at the declared target cardinality and assert the ceiling holds rather than
	* hoping someone reads a log.
	*/
	warnIfOverBound(id, definition, statement, rows, parameters) {
		const problem = boundProblem(declaredBound(statement), rows, numbersIn(parameters));
		if (problem != null) console.warn(`Statement ${definition.query} (${id}) ${problem}`);
	}
	/**
	* The bound parameters, optionally narrowed to one slice's workspaces.
	*
	* A slice binds `live_workspace_ids` to a single id rather than using `workspace_id`, which looks
	* like the more obvious choice and is not: `workspace_id` is the user's own narrowing, reported in
	* the run record as what they asked for, and overwriting it here would make a full-estate scan
	* describe itself as a scan of one workspace. The two filters are also applied at different points
	* in some statements, and only the `live_workspace_ids` one is a partition-key filter in all four.
	*/
	parameters(names, onlyWorkspaces) {
		const values = {};
		for (const name of names) if (name === "lookback_days") values[name] = sql.int(this.lookbackDays);
		else if (name === "workspace_id") values[name] = sql.string(this.options.scope.narrowedTo ?? "");
		else if (name === "live_workspace_ids") values[name] = sql.string(onlyWorkspaces?.join(",") ?? this.liveWorkspaceIds());
		else if (name === "serving_names") values[name] = sql.string(this.options.servingNames ?? "");
		else if (name === "serving_tag_keys") values[name] = sql.string(this.options.servingTagKeys ?? "");
		else if (name === "serving_assets") values[name] = sql.string(this.options.servingAssets ?? "");
		else if (name === "serving_limit") values[name] = sql.int(this.options.servingLimit ?? 2e3);
		else if (name === "segment_limit") values[name] = sql.int(this.segmentLimit);
		else if (name === "shape_limit") values[name] = sql.int(this.shapeLimit);
		else if (name === "warehouse_limit") values[name] = sql.int(this.warehouseLimit);
		else if (name === "stats_limit") values[name] = sql.int(this.statsLimit);
		else if (name === "serving_entity_limit") values[name] = sql.int(this.modelEntityLimit);
		else if (name === "job_limit") values[name] = sql.int(this.jobLimit);
		else values[name] = sql.int(this.tableDetailLimit);
		return values;
	}
};
/**
* Bound parameters as numbers, for checking a statement against its declared ceiling.
*
* Every parameter is carried to the API as a string, so `at most :table_limit` needs converting back
* before it can be compared. Anything not numeric is dropped rather than coerced, and a declaration
* naming one of those then reads to `boundProblem` as a cap nothing supplied, which it reports. A
* ceiling of `:workspace_id` is not a ceiling, so being told so is the point.
*/
function numbersIn(parameters) {
	const numbers = {};
	for (const [name, marker] of Object.entries(parameters)) {
		const value = Number(marker.value);
		if (Number.isFinite(value)) numbers[name] = value;
	}
	return numbers;
}
/**
* Coverage for one signal's parsed value.
*
* Every statement on this surface is an aggregate over whatever the reader can see, so
* complete is the right answer for all but one of them: the per-schema census carries a
* row cap, and a capped result that claimed completeness would let a resolver name the
* four worst schemas out of the top five hundred and present them as the worst in the
* estate. The query returns the population so the difference is measured rather than
* inferred from whether the row count happens to equal the cap.
*/
function coverageOf(id, value, reach, shortfall) {
	if (shortfall != null) return {
		mode: "sampled",
		reach,
		basis: describeShortfall(shortfall)
	};
	if (id !== SCHEMA_CENSUS_SIGNAL) return {
		mode: "complete",
		reach
	};
	const census = value;
	const returned = census.schemas.length;
	if (returned >= census.schemaPopulation) return {
		mode: "complete",
		reach
	};
	return {
		mode: "sampled",
		reach,
		examined: returned,
		population: census.schemaPopulation,
		basis: "the schemas holding the most tables first, so a cut-off list still names the largest segments, with a stable tiebreak by catalog and schema name so the same segments are covered on the next scan"
	};
}
/**
* What this collector's statements consumed, accumulated as they complete.
*
* Kept next to the collector rather than inside the executor because the executor is
* built per statement from per-scan credentials, so it has nowhere to accumulate. The
* fields are optional throughout: a test fixture returns bare rows with no manifest,
* and a footprint that invented zeroes for those would be reporting a measurement it
* did not make.
*/
var StatementLedger = class {
	calls = 0;
	bytes = 0;
	rows = 0;
	measured = false;
	ids = [];
	record(raw) {
		this.calls += 1;
		const outcome = raw;
		if (typeof outcome?.statementId === "string") this.ids.push(outcome.statementId);
		if (typeof outcome?.bytesRead === "number") {
			this.bytes += outcome.bytesRead;
			this.measured = true;
		}
		if (typeof outcome?.rowCount === "number") {
			this.rows += outcome.rowCount;
			this.measured = true;
		}
	}
	spend(surface, name) {
		return {
			surface,
			name,
			calls: this.calls,
			...this.measured ? {
				bytesRead: this.bytes,
				rowsReturned: this.rows
			} : {},
			...this.ids.length > 0 ? { statementIds: [...this.ids] } : {}
		};
	}
};
/**
* Rows out of whatever the executor returned.
*
* AppKit's JSON path delivers `{ data: [...] }` after mapping the positional
* `data_array` onto column names. The other shapes are accepted because the
* statement API's response varies with disposition and format, and a collector
* that only understood one of them would break on a warehouse that answered with
* another.
*/
function rowsOf(raw) {
	if (raw == null) return [];
	if (Array.isArray(raw)) return raw;
	const record = raw;
	for (const candidate of [
		record.data,
		record.rows,
		record.data_array
	]) if (Array.isArray(candidate)) return candidate;
	return [];
}
/**
* Column types out of whatever the executor returned, when it reported any.
*
* Needed only by the sliced path, and only to re-sort a concatenation the way the statement would
* have: every value arrives as a string, so a BIGINT count and a STRING id full of digits are
* indistinguishable from the values alone and sort differently. Absent for a fixture, which
* `concat.ts` handles by inferring.
*/
function columnTypesOf(raw) {
	const types = raw?.columnTypes;
	if (types == null || typeof types !== "object") return void 0;
	const named = Object.entries(types).filter((entry) => typeof entry[1] === "string" && entry[1] !== "");
	return named.length > 0 ? Object.fromEntries(named) : void 0;
}
/**
* Whether the warehouse stopped sending rows before the end of the result set.
*
* Only ever true because `statements.ts` asks for a `byte_limit`: without one, an oversized inline
* result is refused outright and there is nothing to read this off. Absent on a fixture, which is the
* same as false — a fixture returns what it was given.
*/
function wasTruncated(raw) {
	return raw?.truncated === true;
}
/**
* Why a check did not run, in terms the reader can act on.
*
* Each of these is a different instruction to the customer, so they get different
* wording. Collapsing them into one "check skipped" message would leave a budget
* pause looking like a permissions problem.
*/
function describeSkip(reason, detail) {
	switch (reason) {
		case "cancelled": return "The scan was cancelled before this check ran.";
		case "budget-exhausted": return `The scan reached its query budget before running this check, so it is unmeasured rather than failed. Re-running the scan will pick it up. ${detail}`;
		case "permission-denied": return `The identity this scan ran as cannot read the system tables this check needs, so it is unmeasured. Grant SELECT on the relevant system schema to see it assessed. ${detail}`;
		case "not-found": return `A system table this check reads is not present in this workspace, so there is nothing to measure. ${detail}`;
		case "precondition": return `This check was not run: ${detail}`;
	}
}
/**
* The slices that did not complete, in the same words the whole statement would have used.
*
* Distinct reasons rather than the first one, because nine throttles and one permission denial have
* different answers and reporting only the first sends the reader to fix half the problem. Ordered by
* first occurrence, deduplicated by the sentence itself so the same cause reported by four slices is
* one sentence.
*/
function describeOutcomes(outcomes) {
	const said = /* @__PURE__ */ new Set();
	for (const outcome of outcomes) said.add(outcome.status === "skipped" ? describeSkip(outcome.reason, outcome.detail) : describeFailure(outcome.failure.kind, outcome.failure.message));
	return [...said].join(" ");
}
function describeFailure(kind, message) {
	switch (kind) {
		case "permission-denied": return `The identity this scan ran as cannot read the system tables this check needs. Grant SELECT on the relevant system schema to see it assessed. The warehouse reported: ${message}`;
		case "not-found": return `A system table this check reads is not available in this workspace, so there is nothing to measure rather than something missing. Reported: ${message}`;
		case "rate-limited": return "The warehouse was throttling and this check was given up on rather than retried further.";
		case "timeout": return "The query did not finish within its time budget, so this check is unmeasured for this scan.";
		case "deadline": return `${message} This check is unmeasured for this scan.`;
		default: return `This check could not be completed: ${message}`;
	}
}
//#endregion
export { DIRECTORY_SIGNAL, SERVING_LIMIT, SQL_SIGNALS, SQL_SIGNAL_SOURCES, SqlCollector, columnTypesOf, rowsOf, wasTruncated };
