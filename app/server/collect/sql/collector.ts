// The system-table collector.
//
// Every signal here is one statement against `system.*`, submitted through the
// scheduler rather than executed directly. That is the whole reason the per-surface
// budget can be enforced: a collector that reached for the warehouse itself would
// be invisible to every limit in the app.
//
// The executor is injected rather than imported. In the app it is
// `analytics.asUser(req).query` for an on-demand scan and `analytics.query` for the
// scheduled one, and in tests it is a fixture. The collector cannot tell the
// difference, which is what stops the two execution paths from drifting into two
// copies of the check logic.

import { sql } from '@databricks/appkit';
import type { Surface } from '../../scan/surfaces.js';
import type { SkipReason, TaskOutcome } from '../../scan/scheduler.js';
import type { Collector, CollectorContext, CollectorSpend, SignalId, SignalResult } from '../signal.js';
import { observed, unmeasurable } from '../signal.js';
import type { Coverage, Reach } from '../signal.js';
import type { EstateScope } from '../estate-scope.js';
import { boundProblem, declaredBound, type BoundParameters } from './bounds.js';
import { declaredSlice, orderKey } from './slices.js';
import { bucketColumn, bucketed, describeBucket } from './buckets.js';
import {
  collectSlices,
  describeShortfall,
  sliceGroups,
  type FailedSlice,
  type Shortfall,
  type Slice,
} from './sliced.js';
import { FileQuerySource, type QuerySource } from './queries.js';
import { parse } from './shapes.js';
import type { SchemaCensus, StorageMetrics, WorkspaceDirectory } from './shapes.js';
import { scopedToRegion } from './region.js';
import { scopedToSelection } from './selection.js';
import type { ColumnTypes, Row } from './rows.js';

/**
 * Executes one statement and returns its rows.
 *
 * Rejects on failure rather than returning an error value, so the scheduler's
 * classification sees the original error with its status and `Retry-After`
 * intact. AppKit's `analytics.query` already behaves this way; a wrapper that
 * swallowed the rejection into `{ ok: false }` would flatten a 429 and a
 * permission denial into the same opaque string, and the scheduler would then
 * treat a throttle as a fatal error.
 */
export type SqlParameter = ReturnType<typeof sql.string> | ReturnType<typeof sql.int>;
export type SqlParameters = Record<string, SqlParameter>;

export type SqlExecutor = (statement: string, parameters: SqlParameters, signal?: AbortSignal) => Promise<unknown>;

export interface SqlCollectorOptions {
  readonly executor: SqlExecutor;
  readonly scope: EstateScope;
  /** Trailing window for the usage, audit and lineage signals. */
  readonly lookbackDays?: number;
  /** Row cap on the per-table storage detail. The estate aggregate is unaffected. */
  readonly tableDetailLimit?: number;
  /**
   * Row cap on the per-schema census.
   *
   * Separate from the table cap because they bound different things. The table cap
   * governs how many per-table statements follow, so raising it costs statements; this
   * one governs rows out of one aggregate statement, so raising it costs almost nothing
   * and can afford to be generous.
   */
  readonly segmentLimit?: number;
  /**
   * How many query shapes the advisor's statement returns.
   *
   * Forty rather than the twelve a page shows, because the ranking is a composite the analyzer
   * computes and the statement orders by total time — so the shape ranked first by the composite may
   * be tenth by time, and a statement that returned twelve would have thrown it away before anything
   * could rank it. Forty against twelve is the headroom that costs one screenful of rows.
   */
  readonly shapeLimit?: number;
  /**
   * How many warehouses the sizing statement returns, busiest first.
   *
   * Two hundred, against the thousand-warehouse target H1 records. Not a headroom cap like the shapes'
   * — nothing reorders these afterwards — so it is the surface's own limit, and the statement returns
   * the population beside it so a reader with more warehouses than this is told rather than misled.
   */
  readonly warehouseLimit?: number;
  /**
   * How many analysed tables the statistics statement returns, stalest first.
   *
   * Its own cap rather than the table one because it bounds a list that is not per table: `33iga` measured
   * one row per table analysed in the window, 34 over thirty days against a metastore of thousands. So this
   * is headroom on something small rather than a limit on something large, and two hundred is chosen to
   * match the shape of the table cap beside it rather than because anything measured needed it.
   */
  readonly statsLimit?: number;
  /**
   * How many served model entities the serving statement returns, busiest first.
   *
   * Two hundred. A limit on something large: `served_entities` is a change log, and taking the latest
   * configuration of each live entity on `large-estate` still leaves 3,965 of them. What the two
   * requirements read are the estate-wide counts the statement computes before this cap, so the rows are
   * for a reader to look at rather than for anything to count — which is why the cap can be this far
   * under the population without changing a reading.
   */
  readonly modelEntityLimit?: number;
  /**
   * How many jobs the run-health statement returns, longest-running first.
   *
   * Two hundred, and this one is a limit on something large rather than headroom on something small: a row
   * per job is what `serverless_job_readiness` measured at 110% of an inline result at 100,000 jobs, and
   * `H1`'s target estate is bigger than any list a person reads. So the statement is a declared sample of the
   * jobs an operator would look at first, and what reads it has to say so.
   */
  readonly jobLimit?: number;
  /**
   * What a serving declaration selects on, and what it selected — folded and comma-joined.
   *
   * Three strings rather than a structure because they are bound as values: the Statement Execution
   * API binds values and a list of names is a value, which is the same call `queries.ts` makes about
   * the customer-catalog fragment from the other side. The statements split them back apart.
   *
   * Empty is meaningful and is the default. A read of the population with no names and no keys bound
   * returns nothing, which is the right answer for an install where nobody has declared anything.
   */
  readonly servingNames?: string;
  readonly servingTagKeys?: string;
  readonly servingAssets?: string;
  /**
   * The row ceiling the three serving statements share.
   *
   * One cap over three statements because they describe one population, and a facts read bounded
   * differently from the population read would report dimensions over a set of assets that is not the
   * set the surface names. Two thousand: a serving population is something a person declared, and the
   * cap is here to stop a catalog-level tag selecting a metastore rather than to sample anything.
   */
  readonly servingLimit?: number;
  readonly queries?: QuerySource;
}

/** The default row ceiling for the three serving statements. See `servingLimit`. */
export const SERVING_LIMIT = 2000;

interface SignalDefinition {
  readonly query: string;
  readonly parse: (rows: readonly Row[]) => unknown;
  /** Which of the shared parameters this query declares. */
  readonly params: readonly ParameterName[];
  /**
   * How far this query sees, which follows from the tables it reads rather than from
   * preference: the narrowest reach of any table in the statement. Recorded per signal
   * because it is what the result is a statement about, and a wrong value here is an
   * overclaim rather than a bug the user can see.
   */
  readonly reach: Reach;
  /**
   * Why this signal's parsed value amounts to no answer, when it does.
   *
   * Declared per signal because "no rows" means different things per statement, and only
   * one of those meanings is a measurement. A census over an empty metastore genuinely
   * measured an empty metastore, and the controls above it correctly leave the denominator.
   * A per-table snapshot with no rows measured nothing at all — the table is in preview and
   * was empty on the workspace this app was built against — and every control resolved from
   * it would otherwise report an estate of zero bytes, zero files and no maintenance debt.
   *
   * Stated here rather than in each resolver so a resolver added later cannot omit it. Two
   * already carried the same check, and the third storage tier will read the same shape.
   */
  readonly noAnswer?: (value: unknown) => string | undefined;
}

type ParameterName =
  | 'lookback_days'
  | 'workspace_id'
  | 'table_limit'
  | 'live_workspace_ids'
  | 'segment_limit'
  | 'shape_limit'
  | 'warehouse_limit'
  | 'stats_limit'
  | 'serving_entity_limit'
  | 'job_limit'
  | 'serving_names'
  | 'serving_tag_keys'
  | 'serving_assets'
  | 'serving_limit';

/**
 * A scheduler outcome, plus what a sliced execution could not reach.
 *
 * An intersection rather than a fourth status, because a statement that read nine workspaces of
 * eleven succeeded, and what it lacks is part of the estate rather than an answer. See sliced.ts.
 */
type Reading = TaskOutcome<Slice> & { readonly shortfall?: Shortfall };

/**
 * Why an empty per-table snapshot is not an estate of zero bytes.
 *
 * `system.storage.table_metrics_history` has the right schema and is undocumented, and it
 * held no rows against 347 catalogued tables on the workspace this was measured on. So the
 * absence has to be reported as an absence: the alternative reads as a customer with no
 * stored data and no maintenance debt, which is the most flattering possible wrong answer.
 */
const SNAPSHOT_EMPTY =
  'The per-table storage snapshot (system.storage.table_metrics_history) returned no rows for this ' +
  'metastore, so per-table size, file counts and predictive-optimization coverage could not be read. ' +
  'This is a platform snapshot the app cannot populate, and it is reported as unmeasured rather than ' +
  'as an estate of zero bytes. The bounded per-table pass covers a sample of the same ground.';

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
  // system.access.workspaces_latest — the account's own workspace list, and the filter
  // every regional statement depends on. Collected first for that reason. Genuinely account-wide:
  // it reports every workspace, including the ones it then marks as out of region.
  'sql:estate.workspaces': {
    query: 'workspace_directory',
    parse: parse.workspaceDirectory,
    // Takes the lookback to weigh region membership by recent billing volume. It cannot take
    // `live_workspace_ids`: this is the signal that produces them.
    params: ['lookback_days'],
    reach: 'account',
  },
  // system.billing.usage — global, but filtered to the live set, which is regional.
  'sql:estate.compute_profile': {
    query: 'estate_compute_profile',
    parse: parse.computeProfile,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.compute.clusters — a regional table, and it carries policy_id,
  // data_security_mode, init_scripts and dbr_version, so much of what looked like it
  // needed a per-workspace REST call does not.
  'sql:compute.clusters': {
    query: 'compute_cluster_inventory',
    parse: parse.clusters,
    // No lookback. The controls this feeds score shares of the configured fleet, so the population is
    // every live cluster; scoping it to what billed in the window moves those shares. See the statement.
    params: ['workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.compute.warehouses — regional, 70 workspaces on labs against a
  // workspace holding two. That gap is what prompted ADR 0015.
  'sql:compute.warehouses': {
    query: 'compute_warehouse_inventory',
    parse: parse.warehouses,
    params: ['workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.compute.node_timeline — regional, same reach as clusters above. Empty on every
  // labs workspace probed for CO-01-08 (no classic cluster has run in the region since
  // September 2024), which the resolver reads as unmeasured rather than as a pass.
  'sql:compute.node_utilization': {
    query: 'node_utilization',
    parse: parse.nodeUtilization,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.billing.usage joined to list_prices, both global, filtered to the live set.
  'sql:cost.attribution': {
    query: 'cost_attribution_coverage',
    parse: parse.costAttribution,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  'sql:cost.compute_mix': {
    query: 'cost_compute_mix',
    parse: parse.computeMix,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.lakeflow.jobs — regional.
  'sql:jobs.inventory': {
    query: 'jobs_inventory',
    parse: parse.jobs,
    // No lookback, for the reason in the statement: OE-02-04 and REL-01-04 score a share of jobs, and
    // the unscheduled jobs they exist to find are the least likely to have billed in the window.
    params: ['workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.lakeflow.job_task_run_timeline joined to system.compute.clusters, both
  // regional. Reads what jobs ran on, which the Jobs API would answer if a
  // Databricks App could be granted that scope — see the statement header.
  'sql:serverless.job_readiness': {
    query: 'serverless_job_readiness',
    parse: parse.jobReadiness,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.query.history, grouped into shapes. The one signal here that is read by no resolver and
  // scores nothing: it feeds the workload advisor, which is advice rather than assessment. An advisory
  // run asks for it directly, because there are no controls to derive the ask from — see
  // ADVISORY_SIGNALS.
  'sql:workload.query_shapes': {
    query: 'workload_query_shapes',
    parse: parse.queryShapes,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'shape_limit'],
    reach: 'metastore',
  },
  // system.query.history again, and grouped the same way, but over the writes and ranked by what they
  // wrote rather than by what they cost. A separate statement rather than a column beside the shapes,
  // because a rewrite is fast and still the finding — the statement's header has the argument. Read by
  // no resolver and scores nothing, like the shapes signal above it.
  'sql:workload.write_patterns': {
    query: 'workload_write_patterns',
    parse: parse.writePatterns,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'shape_limit'],
    reach: 'metastore',
  },
  // system.storage.predictive_optimization_operations_history joined to system.access.table_lineage, one row
  // per table something analysed in the window. The advisor's only catalogue-side input: `33iga` measured
  // that no plan carries a statistics signal and that `DESCRIBE EXTENDED` reports one it does not have. Read
  // by no resolver and scores nothing, like the two shapes signals it sits with.
  'sql:workload.table_statistics': {
    query: 'workload_table_statistics',
    parse: parse.tableStatistics,
    // No `live_workspace_ids`. Neither source carries a workspace: the operations history is metastore-scoped
    // and lineage is account-wide but names tables rather than workspaces, so there is nothing to filter on.
    params: ['lookback_days', 'stats_limit'],
    reach: 'metastore',
  },
  // The two Lakeflow run timelines joined to system.billing.usage, one row per job, bounded to the longest
  // running. Feeds the job advisor and scores nothing, like the two shapes signals. `33ca` measured what this
  // may and may not read: every duration comes from the period columns because the stated ones are written as
  // zero, and nothing here touches system.compute.node_timeline, which had no rows at all on that estate.
  'sql:workload.job_run_health': {
    query: 'job_run_health',
    parse: parse.jobRunHealth,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'job_limit'],
    reach: 'metastore',
  },
  // What the workers of those jobs' classic clusters were doing, from system.compute.node_timeline over the
  // run window with the driver excluded. Its own signal rather than columns on the one above, because an
  // estate running everything on serverless has no rows here and would otherwise lose the four rules that
  // need none — ADR 0092, and `41b` measured the join reaching 0 of 7 jobs on labs against 689 of 4,158 on
  // `large-estate`. Feeds the job advisor's rules A, B, C and G; scores nothing.
  'sql:workload.job_compute_utilisation': {
    query: 'job_compute_utilisation',
    parse: parse.jobCompute,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'job_limit'],
    reach: 'metastore',
  },
  // system.query.history joined to system.compute.clusters, one row for the estate. What compute ran
  // each statement, what sent it, and how much of what it read came from cache — three readings the
  // audit in ADR 0071 found were being put to a person instead.
  'sql:workload.sql_paths': {
    query: 'workload_sql_paths',
    parse: parse.sqlPaths,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.query.history joined to system.compute.warehouse_events, per warehouse. The advisor's other
  // half: what each warehouse was asked to do against what it was billed for. Read by no resolver and
  // scores nothing, for the same reason the shapes beside it do not — a size is a decision rather than a
  // standard to be measured against.
  'sql:workload.warehouse_pressure': {
    query: 'workload_warehouse_pressure',
    parse: parse.warehousePressure,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'warehouse_limit'],
    reach: 'metastore',
  },
  // system.billing.usage joined to list_prices, per job rather than per estate.
  'sql:serverless.job_spend': {
    query: 'serverless_job_spend',
    parse: parse.jobSpend,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.access.audit — regional, 10 workspaces on labs.
  'sql:governance.audit_coverage': {
    query: 'governance_audit_coverage',
    parse: parse.auditCoverage,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.access.audit — login action_name vocabulary. Settles the failure half of SCP-01-01.
  'sql:security.auth_login_paths': {
    query: 'auth_login_paths',
    parse: parse.authLoginPaths,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.information_schema.tables — the metastore's own catalogue, so metastore
  // reach however many workspaces attach to it.
  'sql:uc.census': {
    query: 'uc_asset_census',
    parse: parse.assetCensus,
    params: [],
    reach: 'metastore',
  },
  // The rest of system.information_schema: shares, recipients, connections, volumes,
  // routines, masks and tags. Same metastore reach as the table census, and the reason
  // this exists is in the query header — it reaches configuration the REST surface
  // cannot, because the information schema needs no scope beyond `sql`.
  'sql:uc.platform_census': {
    query: 'uc_platform_census',
    parse: parse.platformCensus,
    params: [],
    reach: 'metastore',
  },
  // The same table population as the census, restricted to what anything read, joined to
  // the descriptions, tags and column comments that would let a consumer find it. Metastore
  // reach: the catalogue half is the metastore's, and the lineage half is filtered to it by
  // the join rather than by a privilege.
  'sql:uc.discovery': {
    query: 'uc_discovery_metadata',
    parse: parse.discoveryMetadata,
    params: ['lookback_days', 'workspace_id'],
    reach: 'metastore',
  },
  // The column half of the same measure, in a statement of its own because the reference it
  // makes costs an hour on a large estate and no predicate reduces it — rows 61a, 70 and 75,
  // ADR 0090. Same reach and same population as the signal above; what differs is that the
  // resolver takes this one as enrichment, so an estate where it does not return still bands.
  'sql:uc.discovery_columns': {
    query: 'uc_discovery_columns',
    parse: parse.discoveryColumns,
    params: ['lookback_days', 'workspace_id'],
    reach: 'metastore',
  },
  // Optional schema, own statement: an absent `system.data_quality_monitoring` fails at parse
  // (ADR 0088). DG-03-02 reports the row and does not band it (ADR 0102). Metastore reach —
  // the monitor is enabled per metastore, and the estate half is the information schema.
  'sql:uc.quality_monitoring': {
    query: 'uc_quality_monitoring',
    parse: parse.qualityMonitoring,
    params: ['lookback_days'],
    reach: 'metastore',
  },
  // system.lakeflow.pipelines — regional, like the jobs inventory it sits beside.
  'sql:pipelines.inventory': {
    query: 'lakeflow_pipeline_inventory',
    parse: parse.pipelines,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // The same census per schema. Bounded, and the only signal on this surface whose
  // coverage can be short of complete: see coverageOf.
  'sql:uc.schema_census': {
    query: 'uc_schema_census',
    parse: parse.schemaCensus,
    params: ['segment_limit'],
    reach: 'metastore',
  },
  // Picks the tables the describe collector will look at. It lives here, on the
  // estate-wide surface, because it is one statement over the whole metastore — the
  // per-table statements it leads to are what the describe surface budgets.
  //
  // Reads information_schema alongside account-wide table_lineage, and the narrower
  // input governs: the tables it can name are the metastore's.
  'sql:storage.sample_selection': {
    query: 'storage_sample_selection',
    parse: parse.sampleSelection,
    params: ['lookback_days', 'workspace_id', 'table_limit'],
    reach: 'metastore',
  },
  // table_lineage is account-wide but joined onto information_schema, so the answer
  // is about the metastore's tables.
  'sql:uc.lineage_coverage': {
    query: 'uc_lineage_coverage',
    parse: parse.lineageCoverage,
    params: ['lookback_days', 'workspace_id'],
    reach: 'metastore',
  },
  'sql:storage.table_metrics': {
    query: 'storage_table_metrics',
    parse: parse.storageMetrics,
    params: ['table_limit'],
    reach: 'metastore',
    noAnswer: (value) => ((value as StorageMetrics).snapshotAvailable ? undefined : SNAPSHOT_EMPTY),
  },
  // Names the catalogs the predictive-optimization pass describes. Only catalogs holding
  // a table, so a statement is not spent on a setting that governs nothing.
  'sql:uc.catalogs': {
    query: 'uc_catalog_inventory',
    parse: parse.catalogs,
    params: [],
    reach: 'metastore',
  },
  // query.history is account-wide, but the maintenance it reports is maintenance of
  // this metastore's tables, and predictive_optimization history is metastore-scoped.
  'sql:maintenance.recency': {
    query: 'maintenance_recency',
    parse: parse.maintenance,
    params: ['lookback_days', 'workspace_id'],
    reach: 'metastore',
  },
  // The three serving-readiness statements. Not part of a scan: nothing in the catalogue asks for them,
  // and they are collected on demand by `foundation/readiness-read.ts` in two passes, because the second
  // pass is bound to the population the first one found. They are here rather than executed privately so
  // they carry what every other statement carries — a declared reach, a bound the runtime holds them to,
  // and a row on the requirements page telling an admin what this app reads.
  'sql:serving.population': {
    query: 'serving_population',
    parse: parse.servingPopulation,
    params: ['serving_names', 'serving_tag_keys', 'serving_limit'],
    reach: 'metastore',
  },
  'sql:serving.tags': {
    query: 'serving_asset_tags',
    parse: parse.servingTags,
    params: ['serving_assets', 'serving_limit'],
    reach: 'metastore',
  },
  // table_lineage is account-wide and everything else here is the metastore's, so the narrower governs.
  'sql:serving.facts': {
    query: 'serving_asset_facts',
    parse: parse.servingFacts,
    params: ['serving_assets', 'serving_limit', 'lookback_days'],
    reach: 'metastore',
  },
  // The two reads whose system schemas an account admin enables per metastore. Separate statements
  // rather than two more CTEs in the facts read, because an absent schema fails a statement at parse
  // time and while these were in it they took the other six dimensions with them — row 65, ADR 0088.
  // Their reach is the metastore that enabled them, which is the same reach as the rest.
  'sql:serving.quality': {
    query: 'serving_asset_quality',
    parse: parse.servingQuality,
    params: ['serving_assets', 'serving_limit', 'lookback_days'],
    reach: 'metastore',
  },
  'sql:serving.classes': {
    query: 'serving_asset_classifications',
    parse: parse.servingClasses,
    params: ['serving_assets', 'serving_limit'],
    reach: 'metastore',
  },
  /*
   * The two model-lifecycle reads. Named `serving.model_entities` and `mlflow.run_tracking` rather than
   * folded into the five above them, which are about *data* assets marked as served to somebody — a
   * different sense of the word that happens to share it.
   *
   * Metastore reach rather than account, and the filter is what decides it: both statements narrow to
   * the live workspace ids the directory found, which are the workspaces this metastore reaches. The
   * schemas are account-wide, and a declaration saying so while the WHERE clause says otherwise is the
   * thing `collector.test.ts` refuses.
   */
  'sql:serving.model_entities': {
    query: 'serving_model_entities',
    parse: parse.servingModelEntities,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids', 'serving_entity_limit'],
    reach: 'metastore',
  },
  'sql:mlflow.run_tracking': {
    query: 'mlflow_run_tracking',
    parse: parse.mlflowRunTracking,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
  // system.query.history — capacity-limit events, one aggregate row. Narrower than the two workload
  // shapes signals above it: those are per-shape rankings and this is a single estate-wide count.
  // Metastore reach because the WHERE clause filters to live_workspace_ids, the same as every other
  // statement that carries that parameter.
  'sql:query.capacity': {
    query: 'query_capacity',
    parse: parse.queryCapacity,
    params: ['lookback_days', 'workspace_id', 'live_workspace_ids'],
    reach: 'metastore',
  },
} as const satisfies Record<string, SignalDefinition>;

export type SqlSignalId = keyof typeof DEFINITIONS;

/**
 * The workspace directory, which every other account-reach statement filters on.
 *
 * Named rather than inlined because the collect loop has to recognise it: it runs before
 * the others regardless of the order it was asked for.
 */
export const DIRECTORY_SIGNAL = 'sql:estate.workspaces' satisfies SqlSignalId as SignalId;

/** The one signal on this surface whose coverage can be short of complete. */
const SCHEMA_CENSUS_SIGNAL = 'sql:uc.schema_census' satisfies SqlSignalId as SignalId;

export const SQL_SIGNALS = Object.keys(DEFINITIONS) as SqlSignalId[];

/**
 * The query file and reach behind each signal, for the requirements page.
 *
 * Exported as the definitions' own fields rather than restated, so the page describes the
 * statement that runs. What that statement reads is not here because it is not declared
 * anywhere: it is read out of the query text by `tablesRead`, which cannot disagree with
 * the file the collector loads.
 */
export const SQL_SIGNAL_SOURCES: Readonly<Record<SqlSignalId, { readonly query: string; readonly reach: Reach }>> =
  Object.fromEntries(
    Object.entries(DEFINITIONS).map(([id, definition]) => [id, { query: definition.query, reach: definition.reach }])
  ) as Readonly<Record<SqlSignalId, { readonly query: string; readonly reach: Reach }>>;

/**
 * The query files these signals need, exported so a test can check they are all there.
 *
 * A signal naming a query file that does not ship reports as unmeasurable at runtime,
 * which reads to the user as "your workspace could not be assessed" when the truth is
 * "this build is broken". That happened, so it is now checked.
 */
export const SQL_QUERY_NAMES: readonly string[] = Object.values(DEFINITIONS).map((definition) => definition.query);

/**
 * The parameters each query is told it has, exported so a test can check the file agrees.
 *
 * A statement holding a placeholder nobody binds is rejected by the API, and a parameter
 * bound to a statement that does not use it is dead weight the next reader has to
 * disprove. Neither shows up until a live scan, where it presents as an unmeasurable
 * control — a build fault wearing a workspace fault's clothes.
 */
export const SQL_QUERY_PARAMS: Readonly<Record<string, readonly string[]>> = Object.fromEntries(
  Object.values(DEFINITIONS).map((definition) => [definition.query, definition.params])
);

/**
 * The result each signal would carry if its statement returned no rows.
 *
 * Exported because an empty estate is the case most likely to be got wrong and the least
 * likely to be noticed: a query matching nothing still returns zeroes, and a zero
 * numerator over a zero denominator is a number that looks like an answer. Built from the
 * real parser and the real `noAnswer` rule rather than from a hand-written fixture, so a
 * test checking the empty case checks the one a resolver would actually be handed —
 * including whether it would be handed anything at all.
 */
export function emptySqlSignal(id: SignalId): SignalResult | undefined {
  const definition = DEFINITIONS[id as SqlSignalId] as SignalDefinition | undefined;
  if (definition == null) return undefined;

  const value = definition.parse([]);
  const noAnswer = definition.noAnswer?.(value);
  return noAnswer != null
    ? unmeasurable(id, noAnswer)
    : observed(id, value, 0, { mode: 'complete', reach: definition.reach });
}

export class SqlCollector implements Collector {
  readonly surface: Surface = 'sql';
  readonly name = 'system-tables';
  readonly signals: readonly SignalId[] = SQL_SIGNALS;
  /**
   * Declared even though this collector produces it, so the scan plan includes it.
   *
   * The plan collects only what a resolver reads, and no control reads the directory
   * directly — it is a filter, not evidence. Without this it still ran, because the
   * collect loop needs it, but it was absent from the reported signal list: the one
   * statement whose failure would silently widen every count was the one the user could
   * not see had run.
   */
  readonly requires: readonly SignalId[] = [DIRECTORY_SIGNAL];

  private readonly queries: QuerySource;
  private readonly lookbackDays: number;
  private readonly tableDetailLimit: number;
  private readonly segmentLimit: number;
  private readonly shapeLimit: number;
  private readonly warehouseLimit: number;
  private readonly statsLimit: number;
  private readonly modelEntityLimit: number;
  private readonly jobLimit: number;
  private readonly ledger = new StatementLedger();
  /** The directory statement, kept so it runs once however many signals are requested. */
  private directory?: Promise<SignalResult>;
  /** Its parsed value, once observed. Absent means it could not be read. */
  private directoryValue?: WorkspaceDirectory;

  constructor(private readonly options: SqlCollectorOptions) {
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

  spent(): CollectorSpend {
    return this.ledger.spend(this.surface, this.name);
  }

  async collect(ids: readonly SignalId[], context: CollectorContext): Promise<SignalResult[]> {
    // The directory first, always, because the other account-reach statements filter on
    // its result. Requested or not, it is collected once and reused; ordering this here
    // rather than relying on the caller's array order means a plan that happens to list
    // the warehouse inventory first cannot silently assess cancelled workspaces.
    const directory = await this.directoryOnce(context);

    // Sequentially rather than in parallel, deliberately. The scheduler bounds
    // concurrency anyway, but issuing twelve statements at once against a shared
    // warehouse means the app's own queries queue behind each other while the
    // customer's users wait behind all twelve. One at a time through a limiter that
    // permits two keeps the tail short for everyone.
    const results: SignalResult[] = [];
    for (const id of ids) {
      // Already read, by an earlier attempt at this run. Skipping it is the half of finer resumption
      // that saves anything: reporting each statement as it settles is what makes the reading durable,
      // and this is what stops the next attempt paying for it again.
      //
      // The directory is exempt because skipping it would save nothing. It runs above this loop on
      // every attempt whether it was asked for or not — parsing it is what sets the live workspace ids
      // the other statements filter on, and that state does not survive the attempt that read it. So
      // the statement is already paid for, and the reading it just produced is newer than the one being
      // carried; handing back the older one would be a worse answer for the same money.
      if (id !== DIRECTORY_SIGNAL && context.collected.has(id)) continue;

      const result = id === DIRECTORY_SIGNAL ? directory : await this.collectOne(id, context);
      results.push(result);

      // Reported as it settles, so an interrupted run keeps it. This is the collector the finer grain
      // was added for: every signal here is one statement against the customer's warehouse, and there
      // are up to nineteen of them, so a kill part-way through used to cost every statement already
      // read. Awaited, because a reading reported and not yet written is a reading a kill still loses.
      //
      // Waiting here adds no write. The checkpoint table is keyed per signal, so the store upserts one
      // row per reading whether it is handed one or nineteen; this moves those rows earlier rather than
      // writing more of them. `writes no more rows for reporting each signal` in runs.test.ts holds it.
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
  private directoryOnce(context: CollectorContext): Promise<SignalResult> {
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
  private liveWorkspaceIds(): string {
    if (this.directoryValue == null) return '';
    // Already narrowed: `scopedToRegion` and `scopedToSelection` narrowed this value when it was parsed,
    // so the ids here and the set the estate summary reports are the same set by construction rather
    // than by agreement.
    return this.directoryValue.live.map((workspace) => workspace.workspaceId).join(',');
  }

  /** The directory as this run's scope leaves it: this deployment's region, then what was asked for. */
  private narrowed(parsed: WorkspaceDirectory): WorkspaceDirectory {
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
  private unscopable(definition: SignalDefinition): string | undefined {
    const selected = this.options.scope.selected;
    if (selected == null) return undefined;
    if (!definition.params.includes('live_workspace_ids')) return undefined;

    if (this.directoryValue == null) {
      return (
        'This assessment names the workspaces it covers, and the workspace directory could not be read, ' +
        'so there is no way to hold this statement to them. Reading it unfiltered would report on every ' +
        'workspace in the account under a scope that names a few, so it was not read.'
      );
    }
    if (this.directoryValue.live.length > 0) return undefined;

    return (
      `None of the ${String(selected.length)} workspaces this assessment names is assessable — each is ` +
      'stopped, in a region this deployment cannot read, or no longer in the account — so this statement ' +
      'had nothing to read. The estate beside this scan says which.'
    );
  }

  private async collectOne(id: SignalId, context: CollectorContext): Promise<SignalResult> {
    const definition = DEFINITIONS[id as SqlSignalId] as SignalDefinition | undefined;
    if (definition == null) {
      return unmeasurable(id, `No system-table query is defined for ${id}.`);
    }

    // Reach belongs to the statement, not to whether it succeeded, so it is stated on
    // every result. A signal that could not be read still says what it would have been a
    // statement about, which is what lets the scan describe its own scope even when parts
    // of it failed.
    const reach: Reach = this.options.scope.narrowedTo != null ? 'workspace' : definition.reach;
    const unread = (reason: string): SignalResult => unmeasurable(id, reason, { mode: 'complete', reach });

    // Before the statement rather than after it, because the point is not to run it. A statement that
    // cannot be held to the scope this run claims would answer for the whole account, and the customer
    // would be charged for the reading as well as told something false about it.
    const unscopable = this.unscopable(definition);
    if (unscopable != null) return unread(unscopable);

    const started = Date.now();
    const statement = this.queries.text(definition.query);
    const groups = this.sliceInto(definition, statement);
    const outcome =
      groups == null
        ? await this.runOnce(id, definition, statement, context)
        : await this.runSliced(id, definition, statement, groups, context);

    if (outcome.status === 'ok') {
      // A statement that read some groups and no rows measured nothing: the rows it does have came
      // from the groups that answered, and the groups that did not are where the rows would be. Left
      // to `observed` it would reach a resolver as an estate with no jobs in it.
      if (outcome.shortfall != null && outcome.value.rows.length === 0) {
        return unread(describeShortfall(outcome.shortfall));
      }

      const parsed = definition.parse(outcome.value.rows);
      // The directory is narrowed here, once, so the value every later reader sees — the id filter, the
      // estate summary, the export — is the set actually assessed. Region first and the assessment's own
      // selection second: a selected workspace in another region is excluded with the reason that
      // explains it, which is more use to a reader than being recorded as unasked for.
      const value = id === DIRECTORY_SIGNAL ? this.narrowed(parsed as WorkspaceDirectory) : parsed;
      if (id === DIRECTORY_SIGNAL) this.directoryValue = value as WorkspaceDirectory;

      // A statement that ran and answered nothing. Reported as unmeasurable here rather
      // than handed on as a value full of zeroes, because a zero that reached a resolver
      // would be indistinguishable from a measurement.
      const noAnswer = definition.noAnswer?.(value);
      if (noAnswer != null) return unread(noAnswer);

      // Complete of what the statement can see, which is the point of carrying reach:
      // these are all complete scans, and a complete scan of one metastore and a complete
      // scan of eleven workspaces are different claims.
      return observed(id, value, Date.now() - started, coverageOf(id, value, reach, outcome.shortfall));
    }

    if (outcome.status === 'skipped') {
      return unread(describeSkip(outcome.reason, outcome.detail));
    }

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
  private sliceInto(definition: SignalDefinition, statement: string): readonly (readonly string[])[] | undefined {
    if (!definition.params.includes('live_workspace_ids')) return undefined;
    // A narrowed scan already returns one workspace's rows, so slicing it by the live set would
    // execute one statement per group to have every one but the user's answer with nothing.
    if (this.options.scope.narrowedTo != null) return undefined;
    if (declaredSlice(statement)?.columns[0] !== 'workspace_id') return undefined;

    const ids = this.liveWorkspaceIds()
      .split(',')
      .filter((id) => id !== '');
    return ids.length > 1 ? sliceGroups(ids) : undefined;
  }

  /** One statement, one scheduled task, all the rows. The path everything but four signals takes. */
  private runOnce(
    id: SignalId,
    definition: SignalDefinition,
    statement: string,
    context: CollectorContext
  ): Promise<Reading> {
    return context.scheduler.run({
      surface: 'sql',
      label: id,
      run: (signal) => this.execute(id, definition, statement, this.parameters(definition.params), signal),
    });
  }

  /**
   * One statement, one scheduled task per group of workspaces, the rows concatenated and re-sorted.
   *
   * The loop, the grouping, the ordering and the shortfall are `sliced.ts` and `concat.ts`; what stays
   * here is what only the collector knows — how to bind a group into the statement, which ceiling the
   * whole result is held to, and how a failed slice is worded.
   */
  private async runSliced(
    id: SignalId,
    definition: SignalDefinition,
    statement: string,
    groups: readonly (readonly string[])[],
    context: CollectorContext
  ): Promise<Reading> {
    const bucketOn = bucketColumn(statement);
    const reading = await collectSlices({
      groups,
      order: orderKey(statement),
      describe: describeOutcomes,
      ...(bucketOn == null ? {} : { bucketOn }),
      run: (workspaces, bucket) =>
        context.scheduler.run({
          surface: 'sql',
          // The group and the bucket in the label, because these appear in the scan's own task list and
          // a dozen identical rows there would be unreadable.
          label: `${id} (workspaces ${workspaces.join(',')}, ${describeBucket(bucket)})`,
          run: (signal) =>
            this.execute(
              id,
              definition,
              bucket == null || bucketOn == null ? statement : bucketed(statement, bucketOn, bucket),
              this.parameters(definition.params, workspaces),
              signal,
              false
            ),
        }),
    });

    if (reading.status === 'none') return reading.outcome;

    // Checked on the concatenation, not on a slice: the header declares what the statement can return
    // for the estate, and a slice returning a fraction of it says nothing about that. Held here
    // rather than inside `execute` for that reason, which is also why `execute` does not check.
    this.warnIfOverBound(id, definition, statement, reading.rows.length, this.parameters(definition.params));

    return {
      status: 'ok',
      value: { rows: reading.rows },
      attempts: groups.length,
      ...(reading.shortfall == null ? {} : { shortfall: reading.shortfall }),
    };
  }

  /**
   * The executor call and the ledger entry, shared by both paths.
   *
   * The bound check is the caller's, because what it is a check of differs: for one execution it is
   * the whole result, and for a slice it is a fraction of one and comparing it to an estate-wide
   * ceiling would mean nothing.
   */
  private async execute(
    id: SignalId,
    definition: SignalDefinition,
    statement: string,
    parameters: SqlParameters,
    signal?: AbortSignal,
    whole = true
  ): Promise<Slice> {
    const raw = await this.options.executor(statement, parameters, signal);
    this.ledger.record(raw);
    const rows = rowsOf(raw);
    const truncated = wasTruncated(raw);

    // A statement that cannot be sliced and was truncated has no second attempt to make: its rows are a
    // prefix of the answer, and the whole point of measuring a population is that it is the population.
    // Thrown rather than returned so it takes the same route as any other statement-level failure and
    // reaches the user as one unmeasured signal with a reason.
    if (whole && truncated) {
      throw new Error(
        'The warehouse returned more data than an inline result can carry, and this statement cannot ' +
          'be divided, so the rows it did return are part of the answer rather than the answer.'
      );
    }

    if (whole) this.warnIfOverBound(id, definition, statement, rows.length, parameters);
    const types = columnTypesOf(raw);
    return { rows, ...(types == null ? {} : { types }), ...(truncated ? { truncated: true } : {}) };
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
  private warnIfOverBound(
    id: SignalId,
    definition: SignalDefinition,
    statement: string,
    rows: number,
    parameters: SqlParameters
  ): void {
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
  private parameters(names: readonly ParameterName[], onlyWorkspaces?: readonly string[]): SqlParameters {
    const values: Record<string, SqlParameter> = {};
    for (const name of names) {
      if (name === 'lookback_days') values[name] = sql.int(this.lookbackDays);
      // Empty means no filter, and no filter is now the default. These statements read
      // account-wide or metastore-wide tables, so narrowing them to the host workspace
      // discarded most of the estate the user asked about — ten of eleven workspaces of
      // billing data on labs. A workspace id is bound only when the user asked to narrow.
      else if (name === 'workspace_id') values[name] = sql.string(this.options.scope.narrowedTo ?? '');
      else if (name === 'live_workspace_ids') {
        values[name] = sql.string(onlyWorkspaces?.join(',') ?? this.liveWorkspaceIds());
      } else if (name === 'serving_names') values[name] = sql.string(this.options.servingNames ?? '');
      else if (name === 'serving_tag_keys') values[name] = sql.string(this.options.servingTagKeys ?? '');
      else if (name === 'serving_assets') values[name] = sql.string(this.options.servingAssets ?? '');
      else if (name === 'serving_limit') values[name] = sql.int(this.options.servingLimit ?? SERVING_LIMIT);
      else if (name === 'segment_limit') values[name] = sql.int(this.segmentLimit);
      else if (name === 'shape_limit') values[name] = sql.int(this.shapeLimit);
      else if (name === 'warehouse_limit') values[name] = sql.int(this.warehouseLimit);
      else if (name === 'stats_limit') values[name] = sql.int(this.statsLimit);
      else if (name === 'serving_entity_limit') values[name] = sql.int(this.modelEntityLimit);
      else if (name === 'job_limit') values[name] = sql.int(this.jobLimit);
      else values[name] = sql.int(this.tableDetailLimit);
    }
    return values;
  }
}

/**
 * Bound parameters as numbers, for checking a statement against its declared ceiling.
 *
 * Every parameter is carried to the API as a string, so `at most :table_limit` needs converting back
 * before it can be compared. Anything not numeric is dropped rather than coerced, and a declaration
 * naming one of those then reads to `boundProblem` as a cap nothing supplied, which it reports. A
 * ceiling of `:workspace_id` is not a ceiling, so being told so is the point.
 */
function numbersIn(parameters: SqlParameters): BoundParameters {
  const numbers: Record<string, number> = {};
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
function coverageOf(id: SignalId, value: unknown, reach: Reach, shortfall?: Shortfall): Coverage {
  // A sliced statement that lost workspaces takes precedence over anything else this function would
  // say, because it is the wider shortfall: a census cut off at its segment limit still described the
  // metastore it ran against, and this one did not describe part of the estate at all.
  if (shortfall != null) {
    // Deliberately without `examined` and `population`. Everywhere else they count the resource the
    // control is about — schemas, tables — and the UI renders them as "2 of 3 resources affected" and
    // ranks findings on the first number. Putting slices there would report a jobs finding covering
    // thirteen thousand jobs as affecting two resources, and sort it below one affecting five tables.
    // The basis says "2 of 3 groups" in words, which is the honest place for a count of a different
    // thing, and an absent fraction is read as the whole rather than as a small one.
    return { mode: 'sampled', reach, basis: describeShortfall(shortfall) };
  }

  if (id !== SCHEMA_CENSUS_SIGNAL) return { mode: 'complete', reach };

  const census = value as SchemaCensus;
  const returned = census.schemas.length;
  if (returned >= census.schemaPopulation) return { mode: 'complete', reach };
  return {
    mode: 'sampled',
    reach,
    examined: returned,
    population: census.schemaPopulation,
    basis:
      'the schemas holding the most tables first, so a cut-off list still names the largest segments, ' +
      'with a stable tiebreak by catalog and schema name so the same segments are covered on the next scan',
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
class StatementLedger {
  private calls = 0;
  private bytes = 0;
  private rows = 0;
  private measured = false;
  private readonly ids: string[] = [];

  record(raw: unknown): void {
    this.calls += 1;

    const outcome = raw as { statementId?: unknown; bytesRead?: unknown; rowCount?: unknown };
    if (typeof outcome?.statementId === 'string') this.ids.push(outcome.statementId);
    if (typeof outcome?.bytesRead === 'number') {
      this.bytes += outcome.bytesRead;
      this.measured = true;
    }
    if (typeof outcome?.rowCount === 'number') {
      this.rows += outcome.rowCount;
      this.measured = true;
    }
  }

  spend(surface: Surface, name: string): CollectorSpend {
    return {
      surface,
      name,
      calls: this.calls,
      ...(this.measured ? { bytesRead: this.bytes, rowsReturned: this.rows } : {}),
      ...(this.ids.length > 0 ? { statementIds: [...this.ids] } : {}),
    };
  }
}

/**
 * Rows out of whatever the executor returned.
 *
 * AppKit's JSON path delivers `{ data: [...] }` after mapping the positional
 * `data_array` onto column names. The other shapes are accepted because the
 * statement API's response varies with disposition and format, and a collector
 * that only understood one of them would break on a warehouse that answered with
 * another.
 */
export function rowsOf(raw: unknown): Row[] {
  if (raw == null) return [];
  if (Array.isArray(raw)) return raw as Row[];

  const record = raw as { data?: unknown; data_array?: unknown; rows?: unknown };
  for (const candidate of [record.data, record.rows, record.data_array]) {
    if (Array.isArray(candidate)) return candidate as Row[];
  }
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
export function columnTypesOf(raw: unknown): ColumnTypes | undefined {
  const types = (raw as { columnTypes?: unknown } | null)?.columnTypes;
  if (types == null || typeof types !== 'object') return undefined;
  const named = Object.entries(types).filter(
    (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1] !== ''
  );
  return named.length > 0 ? Object.fromEntries(named) : undefined;
}

/**
 * Whether the warehouse stopped sending rows before the end of the result set.
 *
 * Only ever true because `statements.ts` asks for a `byte_limit`: without one, an oversized inline
 * result is refused outright and there is nothing to read this off. Absent on a fixture, which is the
 * same as false — a fixture returns what it was given.
 */
export function wasTruncated(raw: unknown): boolean {
  return (raw as { truncated?: unknown } | null)?.truncated === true;
}

/**
 * Why a check did not run, in terms the reader can act on.
 *
 * Each of these is a different instruction to the customer, so they get different
 * wording. Collapsing them into one "check skipped" message would leave a budget
 * pause looking like a permissions problem.
 */
function describeSkip(reason: SkipReason, detail: string): string {
  switch (reason) {
    case 'cancelled':
      return 'The scan was cancelled before this check ran.';
    case 'budget-exhausted':
      return (
        'The scan reached its query budget before running this check, so it is unmeasured rather than ' +
        `failed. Re-running the scan will pick it up. ${detail}`
      );
    case 'permission-denied':
      return (
        'The identity this scan ran as cannot read the system tables this check needs, so it is unmeasured. ' +
        `Grant SELECT on the relevant system schema to see it assessed. ${detail}`
      );
    case 'not-found':
      return `A system table this check reads is not present in this workspace, so there is nothing to measure. ${detail}`;
    case 'precondition':
      // No check on this surface submits a task with a `skipWhen`, so this branch is unreachable today and
      // exists because the switch is total. It defers to the detail rather than inventing a cause, because
      // the caller that set the precondition is the only thing that knows what it was.
      return `This check was not run: ${detail}`;
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
function describeOutcomes(outcomes: readonly FailedSlice[]): string {
  const said = new Set<string>();
  for (const outcome of outcomes) {
    said.add(
      outcome.status === 'skipped'
        ? describeSkip(outcome.reason, outcome.detail)
        : describeFailure(outcome.failure.kind, outcome.failure.message)
    );
  }
  return [...said].join(' ');
}

function describeFailure(kind: string, message: string): string {
  switch (kind) {
    case 'permission-denied':
      return (
        'The identity this scan ran as cannot read the system tables this check needs. ' +
        'Grant SELECT on the relevant system schema to see it assessed. ' +
        `The warehouse reported: ${message}`
      );
    case 'not-found':
      return (
        'A system table this check reads is not available in this workspace, ' +
        `so there is nothing to measure rather than something missing. Reported: ${message}`
      );
    case 'rate-limited':
      return 'The warehouse was throttling and this check was given up on rather than retried further.';
    case 'timeout':
      return 'The query did not finish within its time budget, so this check is unmeasured for this scan.';
    case 'deadline':
      // The thrower's own sentence, which says how long it waited and whether the warehouse
      // accepted the cancellation. Nothing here may improve on it: whether the statement would
      // finish given longer is not something this app read anywhere.
      return `${message} This check is unmeasured for this scan.`;
    default:
      return `This check could not be completed: ${message}`;
  }
}
