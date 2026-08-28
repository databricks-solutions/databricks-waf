// Typed signal values.
//
// The collector parses each query's rows into a declared shape, so a resolver
// reads `clusters.filter((c) => !c.autoTerminates)` rather than indexing an
// untyped row by a column name that may have been renamed in the SQL two commits
// ago. The parse is the single place where a column name appears twice — in the
// query and here — and a mismatch surfaces as an undefined field in a test rather
// than a wrong finding in production.

import { bool, count, date, num, text, type Row } from './rows.js';

/** `DESCRIBE DETAIL` returns array and struct columns as JSON text over the wire. */
export function jsonArray(row: Row, column: string): readonly string[] {
  const raw = text(row, column);
  if (raw == null || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    // A column the warehouse sent in a shape we did not expect. Reporting no clustering
    // columns is wrong in the safe direction — it cannot manufacture a passing finding,
    // because every control here treats absence as something to look into.
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
export function jsonMap(row: Row, column: string): Readonly<Record<string, string>> {
  const raw = text(row, column);
  if (raw == null || raw === '') return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const map: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) if (typeof value === 'string') map[key] = value;
    return map;
  } catch {
    // As with jsonArray: an unreadable column reports no properties, which every control
    // reading it treats as "the default applies" or "unmeasured" rather than as a pass.
    return {};
  }
}

export interface ComputeProfileRow {
  readonly product: string;
  readonly serverless: boolean;
  readonly usageRecords: number;
  readonly usageQuantity: number;
  readonly distinctClusters: number;
  readonly distinctWarehouses: number;
  readonly distinctJobs: number;
}

/**
 * What kind of compute the estate actually runs.
 *
 * The rows alone are not enough, because the question the applicability preconditions
 * ask is a single number: how many classic clusters did this estate run? An estate
 * that ran none has no cluster configuration to govern, and every cluster-shaped
 * control has to leave the denominator rather than fail. That number is exposed as
 * `summary` because preconditions read one scalar by convention rather than reaching
 * into a collector's payload shape.
 */
export interface EstateProfile {
  readonly rows: readonly ComputeProfileRow[];
  /** Distinct classic clusters seen in the window. Zero means an all-serverless estate. */
  readonly classicClusters: number;
  readonly serverlessUsage: number;
  readonly classicUsage: number;
  readonly summary: number;
}

/**
 * Which workspace a resource lives in.
 *
 * Carried on every inventory row because the assessment reaches the whole account: two
 * workspaces can each hold a warehouse called `analytics`, and a finding that names one
 * without saying where is a finding nobody can act on. Resolvers qualify names with the
 * workspace only when there is more than one, so a single-workspace estate reads plainly.
 */
interface InWorkspace {
  readonly workspaceId: string;
}

export interface ClusterRow extends InWorkspace {
  readonly clusterId: string;
  readonly name: string;
  /** `UI` and `API` are all-purpose; `JOB`, `PIPELINE` and the maintenance variants are ephemeral. */
  readonly source: string;
  readonly runtime?: string;
  readonly dataSecurityMode?: string;
  readonly hasPolicy: boolean;
  readonly autoscaling: boolean;
  readonly autoTerminationMinutes?: number;
  readonly autoTerminates: boolean;
  readonly gpuNode: boolean;
  readonly availability?: string;
  readonly initScriptCount: number;
  /** Of those, how many run from a DBFS root, which has no access control. */
  readonly dbfsInitScriptCount: number;
  /**
   * False when the system table did not write the column, which is not the same as no scripts.
   *
   * The same distinction `healthRulesKnown` draws on jobs, and it decides an outcome here rather
   * than merely qualifying one: a cluster with an unwritten `init_scripts` column would otherwise
   * read as a cluster with none, and pass.
   */
  readonly initScriptsKnown: boolean;
  readonly tagCount: number;
  readonly workerNodeType?: string;
  /** 0 for an autoscaling cluster, which carries its size in `minWorkers`/`maxWorkers` instead. */
  readonly workerCount: number;
  readonly minWorkers: number;
  readonly maxWorkers: number;
}

/** All-purpose clusters are the population most compute controls actually address. */
export function isAllPurpose(cluster: ClusterRow): boolean {
  return cluster.source === 'UI' || cluster.source === 'API';
}

export interface WarehouseRow extends InWorkspace {
  readonly warehouseId: string;
  readonly name: string;
  readonly type: string;
  readonly serverless: boolean;
  readonly channel?: string;
  readonly size?: string;
  readonly minClusters?: number;
  readonly maxClusters?: number;
  readonly scalesOut: boolean;
  readonly autoStopMinutes?: number;
  readonly autoStops: boolean;
  readonly tagCount: number;
}

/**
 * How much of a window's usage the price list could put a rate on, and what else would make a
 * monetary figure over it not worth reporting.
 *
 * Coverage is per usage unit rather than one ratio. `priced_quantity` and `unpriced_quantity` used to
 * come back pooled and were divided by each other to decide whether four cost controls reported a
 * share at all — over units that do not add. Labs bills three of them in a 30-day window (139,187.78
 * DBU, 55.24 DSU, 21.91 GB), so that ratio was a DBU ratio whatever it was called, and a GB
 * population the price list covered not at all would have moved it by 0.016% — well under the 1% the
 * gate treats as material. The pooled columns are gone rather than documented, so the division cannot
 * be written again.
 */
export interface PriceCoverage {
  /** Usage rows with no matching list price. Rows, which do add, unlike their quantities. */
  readonly unpricedRecords: number;
  /** The usage unit the price list covers worst, and the share of that unit's quantity it priced. */
  readonly leastPricedUnit?: string;
  readonly leastPricedShare?: number;
  readonly usageUnitCount?: number;
  /**
   * How many currencies the matched prices were quoted in.
   *
   * Above one, every monetary total in the same row is a sum of unlike amounts, and the single
   * `currency` label — `max(currency_code)` — names one of them as though it were the total's.
   */
  readonly currencies?: number;
  /**
   * Extra rows the list-price join produced beyond one per usage row.
   *
   * A usage row matching two price rows contributes its cost twice to every sum built on the join.
   * Measured zero on labs over 30 days across four workspaces — 42,799 usage rows in, 42,799 out —
   * which is a fact about that price list, not about the join, so it is returned and checked rather
   * than asserted in a comment.
   */
  readonly duplicatePriceMatches?: number;
  readonly currency?: string;
}

export interface CostAttribution extends PriceCoverage {
  readonly usageRecords: number;
  readonly pricedRecords: number;
  readonly listCost: number;
  readonly customTaggedCost: number;
  readonly identifiableCost: number;
  readonly tagKeys: readonly string[];
}

export interface ComputeMix extends PriceCoverage {
  /** Every billed line, including storage and networking. Context, never a denominator. */
  readonly totalCost: number;
  readonly serverlessCost: number;
  /**
   * Spend on the products where serverless is a choice, and the serverless part of it.
   *
   * The pair a serverless adoption share is computed from. `totalCost` was the denominator until it
   * was measured against a real workspace: a $16,190 bill that was 76% model serving reported 19%
   * serverless adoption while running no classic compute at all. Spend nobody can move belongs
   * outside the fraction. See the statement for which products these are and why.
   */
  readonly choiceCost: number;
  readonly serverlessChoiceCost: number;
  readonly photonCost: number;
  readonly photonEligibleCost: number;
  readonly allPurposeCost: number;
  readonly jobsOnAllPurposeCost: number;
  readonly distinctSkus: number;
  readonly usageRecords: number;
  readonly pricedRecords: number;
}

export interface JobRow extends InWorkspace {
  readonly jobId: string;
  readonly name: string;
  readonly triggerType?: string;
  readonly continuous?: boolean;
  readonly scheduled: boolean;
  /**
   * Whether the `trigger` struct was present on this row.
   *
   * Not the same as `scheduled: false`, which is a job whose trigger is present and carries no quartz
   * expression. Collapsing the two failed long-standing jobs for a change in the system table rather
   * than in the estate.
   *
   * On its own it does not say *why* the struct is absent, and it was read for a while as though it
   * did. A null `trigger` is three things at once: a definition written before the column existed, a
   * job nobody gave a trigger, and — per the platform reference — a job with more than one trigger,
   * whose set is in a `triggers` array this statement does not read. `changeTime` separates the first
   * from the second and `triggerType` names the third, so a caller wanting "can this job's trigger be
   * read" wants `triggerRecorded` in `resolvers/helpers.ts` rather than this field by itself.
   */
  readonly scheduledKnown: boolean;
  /**
   * When this definition was last modified, which is also when the row carrying it was written.
   *
   * Read for one purpose: `scheduledKnown` alone cannot tell a job nobody scheduled from a definition
   * whose trigger struct was never written, because both have a null `trigger`. The platform's own
   * reference says which rows are blank — "Not populated for rows emitted before early December 2025"
   * for `trigger`, `trigger_type`, `paused`, `timeout_seconds`, `health_rules` and `deployment` — so a
   * row written after that rollout has a null trigger because the job has none.
   *
   * https://docs.databricks.com/aws/en/admin/system-tables/jobs
   */
  readonly changeTime?: Date;
  readonly paused?: boolean;
  readonly timeoutSeconds?: number;
  readonly healthRuleCount: number;
  /** False when the system table predates the column, which is not the same as no rules. */
  readonly healthRulesKnown: boolean;
  /**
   * Whether any recorded health rule watches a streaming backlog metric (`STREAMING_BACKLOG_*`).
   *
   * False both when the job genuinely carries no such rule and when `healthRulesKnown` is false —
   * the same column, so a job predating the December 2025 write is not scored as having checked
   * this and found nothing. PE-05-03 reads `healthRulesKnown` beside this for that reason.
   */
  readonly hasStreamBacklogRule: boolean;
  readonly tagCount: number;
  /**
   * How the job definition got here. `BUNDLE` means a Databricks Asset Bundle deployed it.
   *
   * This is the only observable evidence of infrastructure-as-code in the estate, and it
   * is one-way: a bundle-deployed job proves a deployment pipeline exists, but a job
   * without the marker may still be Terraform-managed, since the Terraform provider
   * writes jobs through the same API a person uses and leaves no trace of itself. So it
   * carries a `partial` at worst and never a `fail` — see the IaC resolver.
   */
  readonly deploymentKind?: string;
  readonly runAs?: string;
}

/** A job deployed from a bundle, which is the observable half of infrastructure-as-code. */
export function fromBundle(job: JobRow): boolean {
  return (job.deploymentKind ?? '').toUpperCase() === 'BUNDLE';
}

/**
 * What one job ran on, and what its clusters were configured to do.
 *
 * Counted per cluster rather than per run throughout, because the question is how many
 * distinct things have to change: a job whose forty ephemeral clusters all carry the same
 * init script has one script to replace, not forty. The `unknown` counts are separate from
 * zero on purpose — a column the compute table never wrote is not a cluster without an
 * init script, and reading it as one would manufacture a clean verdict.
 */
export interface JobReadinessRow extends InWorkspace {
  readonly jobId: string;
  readonly runs: number;
  readonly taskRuns: number;
  /** Task runs whose durations the timeline did not record, so the timings below are partial. */
  readonly taskRunsUntimed: number;
  readonly longestTaskSeconds: number;
  /** Cluster start-up time, which is billed on classic compute and not on serverless. */
  readonly setupSeconds: number;
  readonly executionSeconds: number;
  readonly lastRun?: Date;
  readonly computeUses: number;
  readonly serverlessUses: number;
  readonly warehouseUses: number;
  readonly classicUses: number;
  /** Compute that was neither classified by the timeline nor matched to a cluster record. */
  readonly unclassifiedUses: number;
  readonly classicClusters: number;
  readonly unreadClusters: number;
  readonly allPurposeClusters: number;
  readonly initScriptClusters: number;
  readonly unknownInitScriptClusters: number;
  readonly gpuClusters: number;
  readonly pooledClusters: number;
  /** Clusters carrying an instance profile or Google service account of their own. */
  readonly cloudIdentityClusters: number;
  readonly policyClusters: number;
  readonly mlRuntimeClusters: number;
  readonly legacyAccessModeClusters: number;
  readonly unknownAccessModeClusters: number;
  /** Major version of the oldest runtime this job's classic clusters ran. */
  readonly oldestRuntimeMajor?: number;
  /** Up to three, for recognition: the reader needs to know which cluster, not all of them. */
  readonly clusterNames: readonly string[];
  readonly runtimes: readonly string[];
}

/**
 * One query shape in the window: how much it cost, and the signals that separate one cause from
 * another.
 *
 * A shape is a group of statements whose text normalises to the same string, so the counts here are
 * over many executions and the text is one of them. Everything optional is optional because the
 * platform records it as null in a case that means something — see the statement's header, which says
 * what each absence is a statement about. The one to know: `prunedPercent` is absent where no files
 * were read at all, which is a different fact from pruning nothing, and 3,621 of one measured
 * workspace's 5,885 statements were served without touching a file.
 */
export interface QueryShapeRow extends InWorkspace {
  /** Sixteen hex characters of a hash over the normalised text. Shown, so it is short on purpose. */
  readonly shape: string;
  readonly statementType: string;
  /** Distinct statement types in the group. Always 1 in a returned row — see the homogeneity guard. */
  readonly kinds: number;
  /** Every terminal execution in the current window, cached and failed included. */
  readonly runsNow: number;
  readonly runsBefore: number;
  /** The subset the timings below are over: finished, and not served from the result cache. */
  readonly measuredNow: number;
  readonly measuredBefore: number;
  readonly msNow: number;
  readonly msBefore: number;
  readonly meanMsNow?: number;
  readonly meanMsBefore?: number;
  readonly medianMs?: number;
  readonly worstMs?: number;
  readonly spilledBytes: number;
  readonly shuffleBytes: number;
  readonly readBytes: number;
  readonly writtenBytes: number;
  /** Absent where no files were read, which is not the same as pruning none of them. */
  readonly prunedPercent?: number;
  /** Files the scans opened. With `readBytes`, this is the mean file size a rule needs. */
  readonly readFiles: number;
  readonly prunedFiles: number;
  /** Task time over execution time: how many cores were busy on average. Below 1 is serial. */
  readonly parallelism?: number;
  readonly compilationPercent?: number;
  readonly queueMs: number;
  readonly cacheHits: number;
  /** Terminal and not `FINISHED`. Its own finding, and never folded into the ranking. */
  readonly failures: number;
  readonly warehouses: number;
  readonly jobs: number;
  readonly pipelines: number;
  /** The execution that stands for the shape, for anything that later wants its plan. */
  readonly statementId?: string;
  readonly statementText?: string;
  readonly representativeAt?: Date;
  /**
   * Whether the representative run produced timings, which is to say finished and was not cached.
   *
   * A shape whose every run in the window failed still has a representative — its longest failure —
   * because the failure list is made of exactly those shapes and used to render them with no query text
   * at all. False here means the text below is from a run that did not measure anything, and
   * `representativeStatus` is what says whether it failed or was served from the cache.
   */
  readonly representativeMeasured: boolean;
  /** What the representative run did: `FINISHED`, `FAILED` or `CANCELED`. */
  readonly representativeStatus?: string;
  /**
   * The warehouse the representative ran on, absent on compute that is not one.
   *
   * This execution's, not the group's — `warehouses` above is the distinct count and cannot answer the
   * question this field exists for. With `representativeComputeType` it decides whether the plan
   * endpoint can answer for this statement before a call finds out: the endpoint is scoped to one
   * workspace and `system.query.history` is scoped to the metastore, so a warehouse this workspace does
   * not own 404s exactly as non-warehouse compute does. `plans/retrievable.ts` reads both.
   */
  readonly representativeWarehouseId?: string;
  /** `WAREHOUSE`, or one of the compute kinds whose plans this app cannot fetch. */
  readonly representativeComputeType?: string;
  /** Query time in the window this signal describes. The same on every row. */
  readonly coveredMs: number;
  /** Query time it left out, so the surface can say what fraction it covers. */
  readonly excludedMs: number;
  /**
   * Query time this app spent assessing, which is excluded and is not the estate's.
   *
   * Its own figure rather than part of `excludedMs`, because the two answer different questions: that
   * one is the estate's work this advisor cannot help with, and this one is what the assessment cost.
   */
  readonly selfMs: number;
  readonly coveredRuns: number;
  readonly excludedRuns: number;
  readonly selfRuns: number;
  /**
   * The covered time and runs no returned shape describes, because those shapes spanned statement types.
   *
   * A subset of `coveredMs` and `coveredRuns` rather than a fourth category: the statement computes
   * coverage before the homogeneity guard drops them, so without this the coverage percentage overstates
   * what the analysis is about. `ambiguousShapes` is how many were dropped.
   */
  readonly ambiguousMs: number;
  readonly ambiguousRuns: number;
  readonly ambiguousShapes: number;
}

/**
 * One live served entity on a managed serving endpoint, with what it served and what reached it.
 *
 * The row is the *latest* configuration of the entity rather than every version of it:
 * `system.serving.served_entities` is a change log, and on `large-estate` its 50,158 rows describe 13,873
 * endpoint ids. A count over the raw table is a count of reconfigurations.
 *
 * **What this population cannot contain is the thing `PE-02-02` is about.** A model served from a
 * team's own service leaves no row here at all, so an empty result is an estate with no managed serving
 * *or* an estate that built its own, and nothing in these fields separates them. The resolver reports
 * that as unmeasured rather than as a failure.
 */
export interface ServingModelEntity extends InWorkspace {
  readonly servedEntityId: string;
  readonly endpointId: string;
  readonly endpointName: string;
  readonly servedEntityName: string;
  /** `CUSTOM_MODEL`, `FOUNDATION_MODEL`, `EXTERNAL_MODEL` or `FEATURE_SPEC`, as the platform spells it. */
  readonly entityType: string;
  /** What is served. A three-part name is a Unity Catalog model; a bare one is the workspace registry. */
  readonly entityName?: string;
  /** Absent where the platform recorded none, which is every external model and most foundation ones. */
  readonly entityVersion?: string;
  readonly task?: string;
  readonly createdBy?: string;
  readonly changedAt?: Date;
  /** Over the window. Zero is an entity that exists and was idle, which is not an entity that is absent. */
  readonly requests: number;
  readonly daysWithTraffic: number;
  readonly failedRequests: number;
  readonly requestsWithoutStatus: number;
  readonly lastRequest?: Date;
  /** The estate's whole live population, before the row cap. The same on every row. */
  readonly liveEntities: number;
  readonly liveEndpoints: number;
  readonly customModels: number;
  readonly foundationModels: number;
  readonly externalModels: number;
  readonly featureSpecs: number;
  readonly customModelsWithAVersion: number;
  readonly customModelsNamedInUc: number;
}

/**
 * How the estate's MLflow runs were started over the window, as one row.
 *
 * `runsWithoutASource` is the field that keeps this honest and it is not a rounding error: measured on
 * `large-estate`, 491 of 5,633 runs in thirty days carried no `mlflow.source.type` at all. Counting them
 * as interactive would move the automated share by eight points on the estate this was built against.
 */
export interface MlflowRunTracking {
  readonly runs: number;
  readonly experimentsWithRuns: number;
  readonly runsFromAJob: number;
  readonly experimentsWithAJobRun: number;
  readonly runsFromANotebook: number;
  readonly runsFromElsewhere: number;
  readonly runsFromAProject: number;
  /** Runs the platform recorded no source for. Neither automated nor interactive — unreadable. */
  readonly runsWithoutASource: number;
  readonly runsThatFinished: number;
  readonly experiments: number;
  readonly liveExperiments: number;
}

/**
 * One write shape: a statement the estate ran repeatedly to put data somewhere, and what it moved.
 *
 * The same fingerprint as `QueryShapeRow` over the same table, and a different question — see
 * `workload_write_patterns.sql`'s header for why the two are separate signals rather than one ranking.
 *
 * The field to read carefully is `runsStatingBytes`. `written_bytes` is null on a run the platform did
 * not record a figure for, and null is not zero: measured across both estates, 10,648 of 10,650 write
 * statements carried one — all 178 of labs', and 10,470 of field-eng's 10,472. So every byte
 * figure here is a sum over the runs that stated one, and a rule dividing by `runs` instead would report
 * a rewrite that wrote nothing on any estate whose history is redacted or older than the column.
 */
export interface WritePatternRow extends InWorkspace {
  /** Sixteen hex characters over the normalised text, as the query shapes signal computes it. */
  readonly shape: string;
  /** One of `INSERT`, `MERGE`, `UPDATE`, `DELETE`, `COPY`, `REPLACE`. Never several — see the guard. */
  readonly statementType: string;
  /** Every terminal execution in the window, failures included. */
  readonly runs: number;
  readonly finishedRuns: number;
  /** Calendar days it ran on, which is what tells a nightly rebuild from one bad afternoon. */
  readonly daysRun: number;
  /** Of `runs`, how many carried a `written_bytes` figure. The denominator of every byte field here. */
  readonly runsStatingBytes: number;
  readonly writtenBytes: number;
  readonly largestWriteBytes?: number;
  /**
   * The middle write, and the figure both rules read.
   *
   * A median rather than a mean because one backfill inside a fortnight of hourly loads moves a mean by
   * two orders of magnitude, and a fortnight of hourly loads with one backfill in it is precisely the
   * shape the small-writes rule must not fire on.
   */
  readonly medianWriteBytes?: number;
  readonly readBytes: number;
  readonly producedRows: number;
  readonly totalMs: number;
  readonly firstSeen?: Date;
  readonly lastSeen?: Date;
  /** The largest write of the group, so a reader has a statement rather than a hash. */
  readonly statementId?: string;
  readonly statementText?: string;
  readonly representativeAt?: Date;
  /** The estate's own write statements in the window. The same on every row. */
  readonly writeStatements: number;
  readonly writesStatingBytes: number;
  readonly estateWrittenBytes: number;
  /** Everything else the window saw, so a surface can say how much of the estate's SQL writes at all. */
  readonly otherStatements: number;
}

/**
 * When one table's optimizer statistics were last computed, and whether anything wrote it since.
 *
 * A row exists only for a table something *did* analyse in the window. That is not a filter this type could
 * relax: `33iga` measured that a table with no ANALYZE record is indistinguishable from one predictive
 * optimization has not reached, and that `DESCRIBE EXTENDED`'s `Statistics` row — the design document's own
 * suggestion — is present on tables nothing has ever analysed, because it is the Delta log's size estimate.
 * So the absence of a row here means unknown, and `MISSING_OR_STALE_STATS` answers the second half of its own
 * name only.
 */
export interface TableStatisticsRow {
  /** Fully qualified, three parts, as the platform assembled it. Matches a plan's `SCAN_IDENTIFIER`. */
  readonly table: string;
  readonly analysedAt: Date;
  readonly analyseOperations: number;
  /**
   * The last write lineage saw, absent where it saw none.
   *
   * Absent rather than the epoch, because "lineage recorded no write in the window" is not "the table was
   * not written" — lineage records what it observed. A rule reading this as fresh would be claiming the
   * second from the first.
   */
  readonly writtenAt?: Date;
  readonly writeEvents?: number;
  /**
   * Hours from the last ANALYZE to the last write, signed, absent where there was no write.
   *
   * Negative is health: predictive optimization analysed the table after the write, which is what it exists
   * to do, and 33 of the 34 analysed tables on labs were in that state. Only a positive gap is a finding.
   */
  readonly hoursWrittenAfterAnalyse?: number;
}

/** Every analysed table this run could read, stalest first. */
export interface TableStatistics {
  readonly tables: readonly TableStatisticsRow[];
}

/**
 * One job's runs over the window: how long they took, how many finished, and what they billed.
 *
 * Every duration is derived from the timelines' period columns, because `33ca` measured
 * `run_duration_seconds`, `setup_duration_seconds` and `execution_duration_seconds` **written as zero on all
 * 44 runs** rather than left null. So there is no field here for setup or execution time: the platform has
 * one, it says nothing, and a column carrying zeros would read as a measurement of a job that starts
 * instantly.
 *
 * Nothing here describes compute. The five utilisation and Photon rules of the design document need
 * `system.compute.node_timeline`, which returned no rows at all on the estate measured because every run was
 * serverless — ledger row `33ce`. A reader may not turn any of these fields into a sizing verdict.
 */
export interface JobRunHealthRow {
  readonly workspaceId: string;
  readonly jobId: string;
  readonly runs: number;
  readonly wallSecondsTotal: number;
  readonly wallSecondsMean: number;
  readonly wallSecondsP95: number;
  readonly wallSecondsMedian: number;
  readonly wallSecondsMax: number;
  /** The longest single task run in any of the job's runs, which is not necessarily in the longest run. */
  readonly longestTaskSeconds: number;
  readonly taskSecondsTotal: number;
  readonly tasksMost: number;
  /**
   * Runs in which some task ran more than once, and the extra task runs that came to.
   *
   * Deliberately not called retries. A second task run for one `task_key` inside a job run is what the
   * platform records; nothing distinguishes an automatic retry from a manual repair, so a sentence built on
   * these two may say a task ran again and may not say why. `33ca` measured the design document's own retry
   * query — `count(*) - 1` over the run timeline — reporting **zero** on a workspace where 16 of 44 runs ran
   * a task more than once, because a retry adds a task run and not a run-level period.
   */
  readonly runsWithARepeatedTask: number;
  readonly repeatedTaskRuns: number;
  readonly lastRun?: Date;
  /** The task the job spends most of its time in, across the window. Absent where no task run was read. */
  readonly busiestTaskKey?: string;
  readonly busiestTaskSeconds?: number;
  /**
   * Runs the run timeline wrote a terminal period for, and how those divide.
   *
   * `runsWithATerminalPeriod` is a count of periods and not of outcomes: the three counts below divide it,
   * and `runsUnresolved` is the share of it whose terminal period still states no result, which is unknown
   * rather than either success or failure. So a success rate is `runsSucceeded` over this only where
   * `runsUnresolved` is zero, and over `runsSucceeded + runsDidNotSucceed` otherwise.
   *
   * It can also be below `runs`: the two come from different timelines, and a run the task timeline saw may
   * have no run-level row yet.
   */
  readonly runsWithATerminalPeriod?: number;
  readonly runsSucceeded?: number;
  readonly runsDidNotSucceed?: number;
  readonly runsUnresolved?: number;
  readonly runsWithATerminationCode?: number;
  /**
   * What the job billed, summed over every usage record including the negative ones.
   *
   * Billing offsets a correction with a retraction rather than replacing the record, so the sum is the
   * figure and `usageRetractions` is how a reader tells a settled one from one still being corrected.
   * Absent where no usage record named the job, which is not the same as a job that cost nothing.
   */
  readonly usageQuantity?: number;
  readonly usageRecords?: number;
  readonly usageRetractions?: number;
  readonly usageSkus?: number;
  /**
   * Rule E's input: how much of the job's non-serverless usage ran without Photon.
   *
   * On the billing record and not on the cluster configuration, which is the whole of what `50` found.
   * `system.compute.clusters` carries no Photon column; `dbr_version` spells it on 60.8% of the records
   * and is positive-only, so a version not naming Photon is every other runtime rather than Photon off.
   * `product_features.is_photon` is stated on every classic job usage record measured and reaches 96.6%
   * of the clusters the rule is about.
   *
   * Three counts and not one share, because `stated` minus `off` is not `on`: a record that states
   * nothing is unread. Serverless records are in none of the three — Photon is not a setting there — so
   * `classicUsageRecords` at zero is a job with no classic usage rather than a job with Photon on.
   */
  readonly classicUsageRecords?: number;
  readonly classicRecordsStatingPhoton?: number;
  readonly classicRecordsWithPhotonOff?: number;
  /**
   * Jobs that ran in the window, before the statement's limit applied. The same figure on every row.
   *
   * The denominator the sample is declared against, and the statement cannot be read honestly without it:
   * the rows are the top `job_limit` by wall clock, so their own count is the cap and not the population.
   * Zero where the column was absent, which is a stored reading from a build that did not return it.
   */
  readonly jobPopulation: number;
}

/**
 * The longest-running jobs this run could read, longest first.
 *
 * A declared sample and not the estate: the statement takes the top `job_limit` by total wall clock, for the
 * reason `serverless_job_readiness` had to be reworked for — a row per job is 110% of an inline result at
 * 100,000 jobs. What it sampled from is `jobPopulation` on each row, and not this array's length.
 */
export interface JobRunHealth {
  readonly jobs: readonly JobRunHealthRow[];
}

/**
 * What the workers of one job's classic clusters were doing while its tasks ran.
 *
 * The inputs to the audit's rules A, B, C and G, which `JobRunHealthRow` says nothing about because
 * they read `system.compute.node_timeline` and an estate running everything on serverless has none of
 * it. Separate for that reason — see the statement's header and ADR 0092 — so a job with no classic
 * compute is absent here and still present there.
 *
 * **Every field is about the run-cluster pairs the node join reached, and that is a narrower
 * population than the job's runs.** `runsWithWorkerSamples` against `JobRunHealthRow.runs` is the
 * gap, and a share taken over the second while the numerator came from the first is the division
 * this family has already shipped once by accident.
 */
export interface JobComputeRow {
  readonly workspaceId: string;
  readonly jobId: string;
  /** Run-and-cluster pairs the overlap join matched, which is the grain the thresholds were measured at. */
  readonly runClusterPairs: number;
  readonly runsWithWorkerSamples: number;
  readonly clusters: number;
  readonly workerSamples: number;
  /**
   * Pairs averaged over fewer than three one-minute samples.
   *
   * Not filtered out by the statement: the floor is a threshold and lives in `job-rules.yaml`. 48.2%
   * of pairs on `large-estate` are below it, and a mean over one observation is not a mean.
   */
  readonly pairsBelowThreeSamples: number;
  /** Workers only and drivers excluded, which moves every one of these — see the statement's header. */
  readonly avgCpuPercent: number;
  readonly peakCpuPercent: number;
  readonly avgCpuWaitPercent: number;
  readonly avgMemoryPercent: number;
  readonly peakMemoryPercent: number;
  /**
   * Average swap, which has a nonzero baseline and may not be read as "swapping".
   *
   * `41b` measured `mem_swap_percent > 0` firing on 95% of node-minutes at a median of 0.05%. So a
   * rule reading this needs a threshold above the baseline, and the document's "sustained swap" is
   * not a condition any estate would fail to meet.
   */
  readonly avgSwapPercent: number;
  /**
   * Rule D's one live condition: bytes over node-minutes, and the estate's median beside it.
   *
   * A rate and not a ratio. `50` measured the two conditions that would compare it with data processed
   * as unanswerable — `system.query.history` names a cluster on 0 of the 4,106,493 rows in the window —
   * so nothing here supports the words *I/O-bound*, which imply that comparison. What the rate supports
   * is a job moving orders of magnitude more traffic per node-minute than its estate's middle: p50 3.0
   * MiB, p95 136.3, max 18,995, five orders of magnitude across the population.
   *
   * The median is the estate's and not the sample's, repeated on every row, because the returned jobs
   * are the top `job_limit` by wall clock and their own median is not the workspace's.
   */
  readonly networkBytesPerNodeMinute?: number;
  readonly pairsWithANetworkRate: number;
  /** Pairs whose every sample stated no network figure at all, which sum to zero and are not zero. */
  readonly pairsStatingNoNetwork: number;
  readonly estateMedianBytesPerNodeMinute?: number;
  readonly estatePairsWithARate: number;
  /**
   * The worker node type as the cluster was configured when the run started, where the as-of join
   * resolved it — 8.7% of classic pairs on `large-estate`.
   *
   * Absent rather than borrowed from a later record. Relaxing the ordering would reach 53.6%, and
   * every pair in that gain has one configuration record written *after* the run it would be
   * attributed to. `pairsWithAnAsOfConfig` is how many of the job's pairs this name came from, so a
   * name read off one pair of forty cannot be rendered as the job's compute.
   */
  readonly nodeType?: string;
  readonly pairsWithAnAsOfConfig: number;
  readonly workerCount?: number;
  /**
   * Runs whose `setup_duration_seconds` was null, kept apart from runs whose figure was zero.
   *
   * The platform writes a zero rather than a null — 0 of 176,261 runs carried no figure on
   * `large-estate` — so a zero is a measured absence of a setup phase and a null is an unread field.
   * ADR 0074 at the column: only the second is unmeasured.
   */
  readonly runsWithNoSetupFigure: number;
  readonly setupSecondsMax?: number;
  readonly setupSecondsMean?: number;
  /**
   * The run duration the platform states, which `33ca` measured as zero on all 44 runs on labs.
   *
   * Here only as rule G's denominator, and the rule has to check it: a setup share over a stated
   * duration of zero is a division by a field that is documented to be unreliable.
   */
  readonly statedRunSecondsMean?: number;
  /** The window these samples span, which is `node_timeline`'s 94 days and not the task timeline's 370. */
  readonly earliestSample?: Date;
  readonly latestSample?: Date;
  /** The funnel, repeated on every row. Counts over the window rather than over the returned rows. */
  readonly jobsThatRan: number;
  readonly jobsWithAComputeId: number;
  readonly jobsOnClassicCompute: number;
  readonly jobPopulation: number;
}

/**
 * The jobs whose classic-cluster workers this run could read, most-sampled first.
 *
 * Empty on an estate that runs everything on serverless, which is labs: the join reaches 0 of 7 jobs
 * there. That is a fact about the workspace and not about the platform — ADR 0074 — and the four
 * rules over it report no population rather than a clean estate.
 */
export interface JobCompute {
  readonly jobs: readonly JobComputeRow[];
}

/**
 * What one warehouse was asked to do over the seven days a sizing decision is made from.
 *
 * Two sources in one row: the statements that ran on it, from `system.query.history`, and the uptime it
 * was billed for, from `system.compute.warehouse_events`. Neither half is complete on its own — a
 * warehouse can be up all week and run nothing, or run everything without starting or stopping once —
 * so the statement outer-joins them and every count here can legitimately be zero on one side.
 *
 * The day counts are the point. `queueMs` says a warehouse queued; `daysQueued` says whether that is a
 * pattern or a Tuesday, and the sizing rules require the second. See the statement's header.
 *
 * What is deliberately not here: the warehouse's name, size, cluster range and auto-stop. Those come
 * from `WarehouseRow`, which the analyzer joins on, because `compute_warehouse_inventory` already reads
 * them and already carries the deleted-warehouse fix this would otherwise have to repeat.
 */
/**
 * Which route SQL took through the estate, as one row per workspace.
 *
 * Counts rather than shares, because the three requirements reading this divide by different
 * denominators — CO-01-03 over the statements a person submitted, PE-03-10 over the bytes that were
 * read from files — and a share computed in SQL would fit one of them and mislead the others.
 *
 * One object for the assessed estate rather than a row per workspace, which is the shape every other
 * `-- Rows: 1` statement returns. Each requirement here asks how the organisation works rather than
 * where, and a per-workspace split would invite a resolver to score the workspace it happens to run in
 * when the answer is about all of them.
 */
export interface SqlPaths {
  /** Terminal statements in the window, ours excluded. Zero on an estate nobody queried. */
  readonly statements: number;
  readonly warehouseStatements: number;
  /** Ran on a cluster somebody started from the UI or the API, rather than a job cluster. */
  readonly allPurposeStatements: number;
  readonly jobClusterStatements: number;
  /** On a cluster this metastore no longer records, so neither of the two above. */
  readonly unattributedStatements: number;
  /** Nobody scheduled it: no job and no pipeline on the statement. */
  readonly interactiveStatements: number;
  readonly interactiveWarehouseStatements: number;
  readonly interactiveAllPurposeStatements: number;
  /** Statements that read at least one file, which is the population the cache figures are over. */
  readonly fileReadingStatements: number;
  readonly fileReadBytes: number;
  /** Of `fileReadBytes`, the part served from the IO cache. Weighted by bytes, not by statement. */
  readonly cachedReadBytes: number;
  /** Served entirely from the result cache, so they reached no cache below it. */
  readonly resultCacheHits: number;
  readonly unnamedClientStatements: number;
  /** Distinct client applications, before the twenty-name cap the statement applies. */
  readonly clientCount: number;
  /** Up to twenty names, busiest first. */
  readonly clients: readonly string[];
}

export interface WarehousePressureRow extends InWorkspace {
  readonly warehouseId: string;
  /** Every terminal statement in the window. Zero on a warehouse that was up and unused. */
  readonly runs: number;
  /** The subset the timings are over: finished, and not served from the result cache. */
  readonly measured: number;
  readonly totalMs: number;
  /** Time spent executing, which is what utilisation is a ratio of. */
  readonly busyMs: number;
  readonly queueMs: number;
  readonly spilledBytes: number;
  /** Distinct users on the busiest day, which is what a cluster range answers to. */
  readonly peakUsers: number;
  /** Calendar days on which anything ran, out of the window's seven. The statement aligns the two. */
  readonly daysUsed: number;
  readonly daysQueued: number;
  readonly daysSpilled: number;
  /** Absent where nothing measurable ran: a warehouse with no statements has no slowest one. */
  readonly p95Ms?: number;
  readonly worstMs?: number;
  readonly worstQueueMs?: number;
  /** Wall-clock milliseconds with at least one cluster running, from the event stream. */
  readonly upMs: number;
  /** The same weighted by clusters running, which is what the account was billed for. */
  readonly clusterMs: number;
  readonly starts: number;
  readonly peakClusters: number;
  /**
   * Days on which any event was recorded, which is not days the warehouse was up.
   *
   * Zero with uptime is a warehouse that started before the window and was not touched inside it. That
   * used to be the only tell for a carried session, and is no longer: `carriedIn` says it outright, and
   * this stays a count of days something was recorded because the churn rule divides `starts` by it.
   */
  readonly daysSeen: number;
  /**
   * Whether the window opened with the warehouse already running.
   *
   * True means `upMs` includes time from a session that began before the window, seeded from the last
   * event before it. False means the last event before the window stopped it, or there was none within
   * thirty days of the boundary — the statement cannot tell those two apart and neither should a reader.
   */
  readonly carriedIn: boolean;
  /**
   * Whether this assessment ran on it, which is not a share and gates nothing.
   *
   * Every other figure here excludes our statements, so `runs` of zero has two meanings and they want
   * opposite advice: a warehouse nothing ran on is a candidate for deletion, and one the assessment was
   * the only thing to run on is the warehouse doing the assessing. Telling a customer that one is unused
   * invites them to remove it.
   */
  readonly ranAssessment: boolean;
  /**
   * Statement execution per cluster-millisecond of uptime, as a percentage.
   *
   * Over 100 on a concurrent warehouse, because statements execute at once and their durations sum past
   * the wall clock. Absent where there was no uptime to divide by. Not a CPU figure — see the statement.
   */
  readonly executionPercent?: number;
  readonly queuePercent?: number;
  /** Warehouses the window saw, so a capped result can say what it is a subset of. Same on every row. */
  readonly warehousePopulation: number;
}

/**
 * What one job cost, and what a serverless DBU costs where it ran.
 *
 * `serverlessRate` is absent rather than zero when the account's price list holds no
 * serverless jobs SKU for that tier and region, because the difference decides whether
 * there is an estimate at all.
 */
export interface JobSpendRow extends InWorkspace {
  readonly jobId: string;
  readonly cost: number;
  readonly serverlessCost: number;
  readonly classicCost: number;
  readonly classicDbus: number;
  /** Usage rows the price list could not price, so the cost above is short by that much. */
  readonly unpricedRecords: number;
  readonly currency?: string;
  readonly serverlessRate?: number;
  /**
   * The price list's own name for the region the rate was read at — `AP_SYDNEY`, not
   * `ap-southeast-2`. Established from the workspace's serverless usage rather than from
   * the classic SKU, which carries no region; absent when the workspace has no serverless
   * usage to establish it from, which is also when there is no rate.
   */
  readonly serverlessRegion?: string;
  readonly classicSkus: readonly string[];
}

export interface WorkspaceRow {
  readonly workspaceId: string;
  readonly name: string;
  readonly url?: string;
  /** One of NOT_PROVISIONED, PROVISIONING, RUNNING, FAILED, BANNED. */
  readonly status: string;
  /**
   * The cloud region this workspace bills from, as it appears in a SKU name, when it could be read.
   *
   * Absent for a workspace billing only classic compute, whose SKU names carry no region. The
   * comparison against the host workspace's own region is the collector's, because only it knows
   * which workspace the app is running in. See workspace_directory.sql.
   */
  readonly region?: string;
  readonly live: boolean;
}

/**
 * Why a workspace in the account is not part of the assessment.
 *
 * Two reasons, and they are not interchangeable to a reader: a cancelled workspace is nothing anyone
 * can act on, while a running workspace in another region is a real part of the estate that this
 * deployment cannot see and a second deployment could. Reporting both as "excluded" with only a status
 * beside them produced the worst version of this — a `RUNNING` workspace listed as excluded, with the
 * word RUNNING as its explanation.
 */
export type ExclusionReason = 'not-running' | 'other-region';

export interface ExcludedWorkspace extends WorkspaceRow {
  readonly reason: ExclusionReason;
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
export function rowsOf<T>(value: readonly T[] | undefined): readonly T[] {
  return isRows(value) ? value : [];
}

function isRows<T>(value: readonly T[] | undefined): value is readonly T[] {
  return Array.isArray(value);
}

export interface WorkspaceDirectory {
  /** Every workspace still in the account, whatever its status or region. */
  readonly workspaces: readonly WorkspaceRow[];
  /** The subset an assessment covers: running, and not known to be in another region. */
  readonly live: readonly WorkspaceRow[];
  /** Present but not assessable, each carrying which of the two reasons applies. */
  readonly excluded: readonly ExcludedWorkspace[];
  /**
   * Live workspaces whose region could not be read, and so are assessed unproven.
   *
   * A workspace billing only classic compute has no region in any SKU name. Dropping it would exclude
   * an in-region workspace on a guess, and keeping it silently would let a workspace in another region
   * count as assessed while contributing no rows to any regional table. So it is kept and named.
   */
  readonly regionUnverified: readonly WorkspaceRow[];
  /**
   * Assessable, and not among the workspaces this run was asked for.
   *
   * A third outcome rather than a second kind of exclusion, because the two send a reader to opposite
   * places: `excluded` is the estate answering — stopped, or in a region this deployment cannot read —
   * and nothing about the assessment changes it. This is the assessment answering, and widening the
   * scope is all it takes.
   *
   * Empty on an unnarrowed scan, which is every ad-hoc run. It exists so the three sets still sum to
   * `workspaces`: without it, narrowing `live` would leave workspaces in no set at all and the account
   * total would stop reconciling against a console the reader can check it in.
   */
  readonly outOfScope: readonly WorkspaceRow[];
  /** The region this assessment is scoped to, when the app's own workspace revealed one. */
  readonly homeRegion?: string;
}

/**
 * The Unity Catalog metastore's table estate.
 *
 * Every count here is *within* Unity Catalog and none of them says anything about what sits
 * beside it. There used to be a `hiveMetastoreTables` field and it was always zero, because
 * `system.information_schema` cannot see the legacy catalog — so four resolvers read the zero
 * and asserted that every table in the estate was governed. Nothing in this shape supports a
 * completeness claim, and a resolver that wants to make one has no field to make it from,
 * which is deliberate.
 */
export interface AssetCensus {
  readonly tableCount: number;
  readonly catalogCount: number;
  readonly schemaCount: number;
  readonly managedTables: number;
  readonly externalTables: number;
  readonly views: number;
  /**
   * Metric views, which define measures rather than store rows. They have no
   * storage format to choose; the format resolvers subtract them the same way
   * they already subtract `views`.
   *
   * Missing on a scan stored before this field existed. Readers treat absence as
   * zero so those scans still resolve (ADR 0079).
   */
  readonly metricViews: number;
  /**
   * Foreign tables, reached through a connection to another system. The format
   * lives on that system; the format resolvers subtract them the same way they
   * already subtract `views`.
   *
   * Missing on a scan stored before this field existed. Readers treat absence as
   * zero so those scans still resolve (ADR 0079).
   */
  readonly foreignTables: number;
  readonly deltaTables: number;
  readonly icebergTables: number;
  readonly optimizedFormatTables: number;
  readonly describedTables: number;
  readonly distinctOwners: number;
  /**
   * Tables in Databricks-owned catalogs, excluded from every count above.
   *
   * Reported rather than silently dropped: the totals here will not match a user's own
   * `SELECT count(*) FROM system.information_schema.tables`, and an unexplained gap in the
   * one number they can check themselves costs more trust than it saves.
   */
  readonly databricksOwnedTables: number;
  /** Which catalogs those were, for the sentence that explains the exclusion. */
  readonly databricksOwnedCatalogs: string;
}

/**
 * Discoverability metadata over two populations: the whole table estate, and the tables
 * anything read in the window.
 *
 * The pair is the shape rather than an accident of one statement returning both. DG-01-05
 * scores descriptions over `estateTables`, and this row exists because the same measure over
 * the read population can be a different answer — 4 of 19 against 0 of 9 on labs
 * 2026-08-10. Carrying both means a finding can report the one it scored beside the one a
 * reader would otherwise assume, without a second signal to keep in step.
 *
 * Every `read*` field counts each table once however often it was read. `readEvents` is the
 * exception and is not part of any share: it says how much activity the population was drawn
 * from, which is what separates a quiet estate from an unread one.
 */
export interface DiscoveryMetadata {
  readonly estateTables: number;
  readonly estateTablesDescribed: number;
  readonly readTables: number;
  readonly readTablesDescribed: number;
  readonly readTablesTagged: number;
  readonly readTablesOwned: number;
  readonly readEvents: number;
}

/**
 * Column comments over the tables anything read — the half of `DiscoveryMetadata` that costs
 * an hour.
 *
 * Its own shape because it is its own statement (ADR 0090), and its own statement because
 * `system.information_schema.columns` is the reference row 61a measured taking
 * `uc_discovery_metadata` from 52,699 ms to 4,023,076 ms on `large-estate`.
 *
 * Both fields count columns rather than tables, so `readTableColumns` is the denominator of a
 * share over columns and is not comparable with `DiscoveryMetadata.readTables`.
 */
export interface DiscoveryColumns {
  readonly readTableColumns: number;
  readonly readTableColumnsDescribed: number;
}

/**
 * The metastore's non-table objects: what is shared, what is federated, what is governed.
 *
 * Read from `system.information_schema` rather than from the Shares, Recipients and
 * Connections REST APIs, which need the `sharing` and `unity-catalog` authorization scopes
 * that Databricks Apps does not offer (ADR 0016). The information schema answers the same
 * questions with the `sql` scope the app already holds, which is why sixteen controls that
 * were classified unreachable are measured instead.
 */
export interface PlatformCensus {
  readonly shares: number;
  readonly recipients: number;
  /**
   * Recipients that authenticate with a bearer token, and so the population the
   * IP-allowlist control governs.
   *
   * Databricks-to-Databricks recipients authenticate through sharing identity federation
   * and have no token to restrict, so counting them in the denominator would fail an
   * estate for not applying a control that does not apply to it.
   */
  readonly tokenRecipients: number;
  readonly recipientsWithIpAllowlist: number;
  /** Shares this metastore receives, as opposed to shares it publishes. */
  readonly providers: number;
  readonly connections: number;
  /** Which source systems, uppercased and comma-joined, for the finding's sentence. */
  readonly connectionTypes: string;
  readonly externalLocations: number;
  readonly storageCredentials: number;
  readonly volumes: number;
  readonly managedVolumes: number;
  readonly routines: number;
  readonly columnMasks: number;
  readonly rowFilters: number;
  /** Distinct tables carrying at least one tag, not the number of tag rows. */
  readonly taggedTables: number;
  readonly taggedColumns: number;
  /**
   * Whether the identity that ran this owns the metastore, and which of the four sharing
   * privileges it holds — the two readings that decide whether a zero above is an estate with
   * nothing in it or a view this reader cannot see into.
   *
   * `shares`, `recipients`, `providers` and `connections` are each filtered by their own
   * metastore-level grant, measured one at a time on labs 2026-08-10 (`docs/plan/e1-populations.md`,
   * phase E1f). The owner is carried separately because it holds none of the four and sees all four.
   *
   * Privilege names are the underscored form the view returns — `USE_SHARE`, not `USE SHARE`.
   */
  readonly ownsMetastore: boolean;
  readonly sharingPrivileges: readonly string[];
}

/**
 * One declarative pipeline.
 *
 * `development` is the field the operational-excellence controls turn on: a pipeline in
 * development mode does not retry failed updates and reuses its cluster, so it is a
 * pipeline nobody has finished putting into production.
 */
export interface PipelineRow extends InWorkspace {
  readonly pipelineId: string;
  readonly name: string;
  readonly pipelineType?: string;
  readonly development: boolean;
  readonly serverless: boolean;
  readonly photon: boolean;
  readonly edition?: string;
  readonly channel?: string;
  readonly runAs?: string;
  readonly tagCount: number;
  /** Updates in the lookback window. Zero means configuration rather than a workload. */
  readonly updates: number;
  readonly failedUpdates: number;
}

/** A pipeline that has actually run is the only kind that evidences a working framework. */
export function hasRun(pipeline: PipelineRow): boolean {
  return pipeline.updates > 0;
}

/**
 * One schema's share of the census.
 *
 * The unit is the catalog-schema pair rather than the schema name, because schema names
 * repeat across catalogs and `sales` in two catalogs are two different places.
 */
export interface SchemaCensusRow {
  readonly catalog: string;
  readonly schema: string;
  readonly tableCount: number;
  readonly managedTables: number;
  readonly externalTables: number;
  readonly views: number;
  readonly metricViews: number;
  readonly foreignTables: number;
  readonly optimizedFormatTables: number;
  readonly describedTables: number;
  readonly distinctOwners: number;
}

export interface SchemaCensus {
  /**
   * The schemas returned, largest first.
   *
   * Possibly a subset. The signal's coverage states which, so a resolver that names the
   * worst offenders can say whether it looked at all of them.
   */
  readonly schemas: readonly SchemaCensusRow[];
  /** How many schemas exist, from the query's window function, not the row count. */
  readonly schemaPopulation: number;
}

export interface LineageCoverage {
  readonly tableCount: number;
  /**
   * Distinct tables that appear as a source, a target, or both. The coverage share is over this,
   * not over the sum of the per-side counts — a table on both sides is one table.
   */
  readonly tablesWithLineage: number;
  readonly tablesWrittenWithLineage: number;
  readonly tablesReadWithLineage: number;
  readonly lineageEvents: number;
  readonly lastEvent?: Date;
}

export interface AuditCoverage {
  readonly events: number;
  readonly services: number;
  readonly actions: number;
  readonly actors: number;
  readonly lastEvent?: Date;
  readonly daysSinceLastEvent?: number;
  readonly unityCatalogEvents: number;
}

/**
 * Login events by authentication path, for the failure half of SCP-01-01.
 *
 * Password logins identify local credentials in use. Their absence is not a pass — only that
 * none authenticated that way in the window.
 */
export interface AuthLoginPaths {
  /**
   * Events under the three action names this reading names, and only those. Zero of it means
   * none of those three paths was recorded — not that nobody authenticated, which is
   * `otherAuthEvents`.
   */
  readonly loginEvents: number;
  readonly passwordLogins: number;
  readonly samlLogins: number;
  readonly oidcLogins: number;
  /**
   * Events under any other action name whose name mentions login or authentication, with up to
   * eight of those names in `otherAuthActions`. Neither field says which of them are
   * interactive, which are machine-to-machine, or which imply a local credential: they are the
   * names the audit log emitted, surfaced so a finding can report them, and nothing may be
   * concluded from them.
   */
  readonly otherAuthEvents: number;
  readonly otherAuthActions: readonly string[];
  /** Events of either kind recorded against the account (`workspace_id = 0`) rather than a workspace. */
  readonly accountPlaneEvents: number;
  readonly passwordActors: number;
  readonly lastPasswordLogin?: Date;
}

/**
 * Per-cluster CPU utilisation from `node_timeline`, for CO-01-08.
 *
 * `nodeSamples` at zero means the table has returned no row for the window, not that every
 * cluster was busy — the two are indistinguishable from this shape alone, so the resolver must
 * treat zero samples as unmeasured rather than as a pass.
 */
export interface NodeUtilization {
  readonly nodeSamples: number;
  readonly clustersObserved: number;
  readonly idleClusters: number;
  readonly lastSample?: Date;
}

export interface TableMetric {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
  readonly tableType?: string;
  readonly activeBytes: number;
  readonly activeFiles: number;
  readonly predictiveOptimization: boolean;
}

export interface StorageMetrics {
  /** False when the snapshot table exists but carries no rows for this metastore. */
  readonly snapshotAvailable: boolean;
  readonly snapshotDate?: Date;
  readonly tableCount: number;
  readonly activeBytes: number;
  readonly activeFiles: number;
  readonly predictiveOptimizationTables: number;
  /** The largest tables, bounded by the query. Detail, not the estate total. */
  readonly largest: readonly TableMetric[];
}

/** One table the per-table pass will describe, and why it was chosen. */
export interface SampleCandidate {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
  readonly tableType?: string;
  readonly readEvents: number;
}

/**
 * Which tables the per-table pass will look at, out of how many it could have.
 *
 * `eligibleTables` is carried so a finding can state its coverage as a fraction of the
 * estate rather than as a bare count of what it happened to describe. A pass over 50
 * tables means something different in an estate of 60 than in one of 60,000, and the
 * finding is only honest if it says which.
 */
export interface SampleSelection {
  readonly candidates: readonly SampleCandidate[];
  readonly eligibleTables: number;
  /** Tables with at least one observed read, which are the ones layout affects most. */
  readonly activeTables: number;
}

/**
 * One table's layout, from `DESCRIBE DETAIL`.
 *
 * Read from the Delta log rather than by listing files, which is why a sample of these
 * is affordable where `ANALYZE … COMPUTE STORAGE METRICS` is not. The trade is that
 * vacuumable and time-travel bytes are absent — see ADR 0014.
 */
export interface TableDetail {
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
  readonly sizeBytes: number;
  readonly fileCount: number;
  readonly partitionColumns: readonly string[];
  readonly clusteringColumns: readonly string[];
  /** Delta table features, where `deletionVectors` appears when enabled. */
  readonly features: readonly string[];
  readonly automaticClustering: boolean;
  /**
   * The table's Delta properties, as set. Absence of a property means the Delta default applies,
   * which is a different fact from a property set to the default value — the first is inherited and
   * moves if Databricks moves it, the second was chosen. Retention is read this way.
   */
  readonly properties: Readonly<Record<string, string>>;
  readonly readEvents: number;
}

export interface TableDetails {
  readonly tables: readonly TableDetail[];
  /** Tables in the eligible population, so coverage is a fraction not a count. */
  readonly eligibleTables: number;
  /** Tables the pass failed to describe, with the reason, so coverage is not overstated. */
  readonly undescribed: readonly { readonly table: string; readonly reason: string }[];
}

export interface CatalogRow {
  readonly catalog: string;
  readonly tableCount: number;
  readonly managedTables: number;
  readonly schemaCount: number;
}

export interface CatalogInventory {
  readonly catalogs: readonly CatalogRow[];
}

export type PredictiveOptimizationState = 'enabled' | 'partial' | 'disabled' | 'unknown';

/** What `DESCRIBE CATALOG EXTENDED` reports for one catalog's setting. */
export type PredictiveOptimizationSetting = 'enable' | 'disable' | 'inherit' | 'unknown';

export interface CatalogPredictiveOptimization {
  readonly catalog: string;
  readonly setting: PredictiveOptimizationSetting;
  /**
   * Where an inherited setting came from, as reported — for example
   * `METASTORE metastore_aws_ap_southeast_2`.
   *
   * Worth keeping rather than collapsing to the effective value, because it is the
   * difference between an estate someone configured and an estate that happens to
   * sit under an enabled metastore. The remediation differs.
   */
  readonly inheritedFrom?: string;
  readonly managedTables: number;
}

export interface PredictiveOptimizationCoverage {
  /** Managed tables in the catalogs whose setting was read. */
  readonly managedTables: number;
  /**
   * Managed tables sitting under a catalog whose effective setting is enable.
   *
   * Named for what it measures. Enablement is read per catalog, so this is tables
   * covered *by their catalog's* setting, not tables individually confirmed. A
   * schema or table can override its catalog and this does not see that, which is
   * why every finding built on it says so.
   */
  readonly enabledTables: number;
  readonly catalogs: readonly CatalogPredictiveOptimization[];
  /** Catalogs whose setting could not be read, with the reason, so coverage is not overstated. */
  readonly unreadable: readonly { readonly catalog: string; readonly reason: string }[];
  readonly state: PredictiveOptimizationState;
  /**
   * The scalar an applicability precondition compares against, which by
   * convention is read from `summary`. Duplicating `state` here rather than
   * teaching preconditions to reach into payload shapes: a precondition coupled
   * to a collector's field names breaks silently the next time the query changes.
   */
  readonly summary: PredictiveOptimizationState;
}

export interface MaintenanceOperation {
  /**
   * `manual` is a command that named a table in the assessed population.
   * `manual_unresolved` is a command that looked like OPTIMIZE/VACUUM/ANALYZE but whose
   * target could not be attributed — leading comments stripped, still no joinable three-part
   * name, or a name outside the assessed catalogs. Resolvers may not credit the latter.
   */
  readonly source: 'predictive_optimization' | 'manual' | 'manual_unresolved';
  readonly operation: string;
  readonly operations: number;
  readonly lastRun?: Date;
  readonly tablesTouched?: number;
}

export interface MaintenanceRecency {
  readonly operations: readonly MaintenanceOperation[];
}

/**
 * A relation a serving declaration selected, and the tag that selected it where one did.
 *
 * `description` and `owner` are `null` rather than absent when the platform holds none, because the
 * statement always selects both columns: a read that carried the column and found nothing is a fact
 * about the table, and a field left out here would arrive at `serving-asset.ts` as a fact about the
 * read. That distinction is the one thing the metadata half of a definition rests on.
 */
export interface ServingMatch {
  readonly qualified: string;
  readonly catalog: string;
  readonly schema: string;
  readonly table: string;
  readonly description: string | null;
  readonly owner: string | null;
  /** Absent on a row matched by name, which is the reason it carries no tag. */
  readonly tagKey?: string;
  readonly tagValue?: string;
  readonly tagLevel?: string;
}

export interface ServingPopulationRows {
  /** How many rows matched, which is more than `matches.length` when the read hit its cap. */
  readonly matchPopulation: number;
  readonly matches: readonly ServingMatch[];
}

export interface ServingTag {
  readonly qualified: string;
  readonly key: string;
  readonly value: string;
}

export interface ServingTagRows {
  readonly tagPopulation: number;
  readonly tags: readonly ServingTag[];
}

/** Everything the readiness dimensions read about one asset. `null` is the platform holding none. */
export interface ServingFact {
  readonly qualified: string;
  readonly relationKind: string | null;
  readonly storageFormat: string | null;
  readonly columnCount: number;
  readonly commentedColumns: number;
  readonly lineageEvents: number;
  readonly semanticReaders: number;
  readonly maskedColumns: number;
  readonly rowFilters: number;
}

export interface ServingFactRows {
  readonly assetPopulation: number;
  readonly assets: readonly ServingFact[];
}

/**
 * The latest quality status the platform holds for an asset, read on its own.
 *
 * Separate from `ServingFact` because its source is separate: `system.data_quality_monitoring` is
 * enabled per metastore and absent by default, and row 65 exists because an absent schema took the six
 * dimensions that do not read it down with it. Absent here means the field is missing from the fact
 * the readiness dimensions are given, which they already read as unmeasured.
 */
/**
 * Latest quality-monitor verdicts over the customer's tables, counted at table grain.
 *
 * One row. DG-03-02 reports these figures and does not band them — ADR 0102. The four
 * named statuses are what `78` saw, not a claim that they are exhaustive: `unnamedStatus`
 * is the remainder.
 */
export interface QualityMonitoring {
  readonly estateTables: number;
  readonly estateCatalogs: number;
  readonly monitoredTables: number;
  readonly monitoredCatalogs: number;
  readonly healthy: number;
  readonly unhealthy: number;
  readonly training: number;
  readonly errored: number;
  readonly unnamedStatus: number;
  readonly freshnessPresent: number;
  readonly completenessPresent: number;
  readonly freshnessEstablished: number;
  readonly completenessEstablished: number;
}

export interface ServingQuality {
  readonly qualified: string;
  readonly qualityStatus: string | null;
}

export interface ServingQualityRows {
  readonly qualityPopulation: number;
  readonly statuses: readonly ServingQuality[];
}

/** The classification tags on an asset, read on its own for the reason `ServingQuality` is. */
export interface ServingClasses {
  readonly qualified: string;
  readonly classifications: readonly string[];
}

export interface ServingClassRows {
  readonly classPopulation: number;
  readonly classified: readonly ServingClasses[];
}

export const parse = {
  computeProfile: (rows: readonly Row[]): EstateProfile => {
    const parsed: ComputeProfileRow[] = rows.map((row) => ({
      product: text(row, 'billing_origin_product') ?? 'unknown',
      serverless: bool(row, 'is_serverless') ?? false,
      usageRecords: count(row, 'usage_records'),
      usageQuantity: count(row, 'total_usage_quantity'),
      distinctClusters: count(row, 'distinct_clusters'),
      distinctWarehouses: count(row, 'distinct_warehouses'),
      distinctJobs: count(row, 'distinct_jobs'),
    }));

    // Counted from the non-serverless rows only. Summing all clusters would include
    // the cluster ids serverless usage records carry, and an all-serverless estate
    // would then look like it had classic compute — turning the one applicability
    // rule that matters most into a no-op.
    const classic = parsed.filter((row) => !row.serverless);
    const classicClusters = classic.reduce((sum, row) => sum + row.distinctClusters, 0);

    return {
      rows: parsed,
      classicClusters,
      classicUsage: classic.reduce((sum, row) => sum + row.usageQuantity, 0),
      serverlessUsage: parsed.filter((row) => row.serverless).reduce((sum, row) => sum + row.usageQuantity, 0),
      summary: classicClusters,
    };
  },

  clusters: (rows: readonly Row[]): ClusterRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      clusterId: text(row, 'cluster_id') ?? '',
      name: text(row, 'cluster_name') ?? '(unnamed)',
      source: text(row, 'cluster_source') ?? 'UNKNOWN',
      ...optional('runtime', text(row, 'dbr_version')),
      ...optional('dataSecurityMode', text(row, 'data_security_mode')),
      hasPolicy: bool(row, 'has_policy') ?? false,
      autoscaling: bool(row, 'autoscaling') ?? false,
      ...optional('autoTerminationMinutes', num(row, 'auto_termination_minutes')),
      autoTerminates: bool(row, 'auto_terminates') ?? false,
      gpuNode: bool(row, 'gpu_node') ?? false,
      ...optional('availability', text(row, 'availability')),
      initScriptCount: count(row, 'init_script_count'),
      dbfsInitScriptCount: count(row, 'dbfs_init_script_count'),
      initScriptsKnown: bool(row, 'init_scripts_known') ?? false,
      tagCount: count(row, 'tag_count'),
      ...optional('workerNodeType', text(row, 'worker_node_type')),
      workerCount: count(row, 'worker_count'),
      minWorkers: count(row, 'min_workers'),
      maxWorkers: count(row, 'max_workers'),
    }));
  },

  warehouses: (rows: readonly Row[]): WarehouseRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      warehouseId: text(row, 'warehouse_id') ?? '',
      name: text(row, 'warehouse_name') ?? '(unnamed)',
      type: text(row, 'warehouse_type') ?? 'UNKNOWN',
      serverless: bool(row, 'serverless') ?? false,
      ...optional('channel', text(row, 'warehouse_channel')),
      ...optional('size', text(row, 'warehouse_size')),
      ...optional('minClusters', num(row, 'min_clusters')),
      ...optional('maxClusters', num(row, 'max_clusters')),
      scalesOut: bool(row, 'scales_out') ?? false,
      ...optional('autoStopMinutes', num(row, 'auto_stop_minutes')),
      autoStops: bool(row, 'auto_stops') ?? false,
      tagCount: count(row, 'tag_count'),
    }));
  },

  costAttribution: (rows: readonly Row[]): CostAttribution => {
    const row = rows[0] ?? {};
    const keys = text(row, 'tag_keys');
    return {
      usageRecords: count(row, 'usage_records'),
      pricedRecords: count(row, 'priced_records'),
      ...priceCoverage(row),
      listCost: count(row, 'list_cost'),
      customTaggedCost: count(row, 'custom_tagged_cost'),
      identifiableCost: count(row, 'identifiable_cost'),
      tagKeys: keys == null ? [] : keys.split(',').filter((k) => k !== ''),
      ...optional('currency', text(row, 'currency')),
    };
  },

  computeMix: (rows: readonly Row[]): ComputeMix => {
    const row = rows[0] ?? {};
    return {
      totalCost: count(row, 'total_cost'),
      serverlessCost: count(row, 'serverless_cost'),
      choiceCost: count(row, 'choice_cost'),
      serverlessChoiceCost: count(row, 'serverless_choice_cost'),
      photonCost: count(row, 'photon_cost'),
      photonEligibleCost: count(row, 'photon_eligible_cost'),
      allPurposeCost: count(row, 'all_purpose_cost'),
      jobsOnAllPurposeCost: count(row, 'jobs_on_all_purpose_cost'),
      distinctSkus: count(row, 'distinct_skus'),
      usageRecords: count(row, 'usage_records'),
      pricedRecords: count(row, 'priced_records'),
      ...priceCoverage(row),
    };
  },

  jobs: (rows: readonly Row[]): JobRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      jobId: text(row, 'job_id') ?? '',
      name: text(row, 'name') ?? '(unnamed)',
      ...optional('triggerType', text(row, 'trigger_type')),
      ...optional('continuous', bool(row, 'continuous')),
      scheduled: bool(row, 'scheduled') ?? false,
      // Absent column (fixtures written before this field) is treated as known, matching the
      // previous behaviour so older fixtures keep scoring; an explicit false is the unknown case.
      scheduledKnown: bool(row, 'scheduled_known') ?? true,
      ...optional('changeTime', date(row, 'change_time')),
      ...optional('paused', bool(row, 'paused')),
      ...optional('timeoutSeconds', num(row, 'timeout_seconds')),
      healthRuleCount: count(row, 'health_rule_count'),
      healthRulesKnown: bool(row, 'health_rules_known') ?? false,
      hasStreamBacklogRule: bool(row, 'has_stream_backlog_rule') ?? false,
      tagCount: count(row, 'tag_count'),
      ...optional('deploymentKind', text(row, 'deployment_kind')),
      ...optional('runAs', text(row, 'run_as')),
    }));
  },

  jobReadiness: (rows: readonly Row[]): JobReadinessRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      jobId: text(row, 'job_id') ?? '',
      runs: count(row, 'runs'),
      taskRuns: count(row, 'task_runs'),
      taskRunsUntimed: count(row, 'task_runs_untimed'),
      longestTaskSeconds: count(row, 'longest_task_seconds'),
      setupSeconds: count(row, 'setup_seconds'),
      executionSeconds: count(row, 'execution_seconds'),
      ...optional('lastRun', date(row, 'last_run')),
      computeUses: count(row, 'compute_uses'),
      serverlessUses: count(row, 'serverless_uses'),
      warehouseUses: count(row, 'warehouse_uses'),
      classicUses: count(row, 'classic_uses'),
      unclassifiedUses: count(row, 'unclassified_uses'),
      classicClusters: count(row, 'classic_clusters'),
      unreadClusters: count(row, 'unread_clusters'),
      allPurposeClusters: count(row, 'all_purpose_clusters'),
      initScriptClusters: count(row, 'init_script_clusters'),
      unknownInitScriptClusters: count(row, 'unknown_init_script_clusters'),
      gpuClusters: count(row, 'gpu_clusters'),
      pooledClusters: count(row, 'pooled_clusters'),
      cloudIdentityClusters: count(row, 'cloud_identity_clusters'),
      policyClusters: count(row, 'policy_clusters'),
      mlRuntimeClusters: count(row, 'ml_runtime_clusters'),
      legacyAccessModeClusters: count(row, 'legacy_access_mode_clusters'),
      unknownAccessModeClusters: count(row, 'unknown_access_mode_clusters'),
      ...optional('oldestRuntimeMajor', num(row, 'oldest_runtime_major')),
      clusterNames: list(row, 'cluster_names'),
      runtimes: list(row, 'runtimes'),
    }));
  },

  queryShapes: (rows: readonly Row[]): QueryShapeRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      shape: text(row, 'shape') ?? '',
      statementType: text(row, 'statement_type') ?? '',
      kinds: count(row, 'kinds'),
      runsNow: count(row, 'runs_now'),
      runsBefore: count(row, 'runs_before'),
      measuredNow: count(row, 'measured_now'),
      measuredBefore: count(row, 'measured_before'),
      msNow: count(row, 'ms_now'),
      msBefore: count(row, 'ms_before'),
      // `num` rather than `count` on all of these, because each is null in a case that means
      // something and zero would be a claim. A shape with no measured run has no mean; one that read no
      // files has no prune ratio; one whose execution time is zero has no parallelism figure.
      ...optional('meanMsNow', num(row, 'mean_ms_now')),
      ...optional('meanMsBefore', num(row, 'mean_ms_before')),
      ...optional('medianMs', num(row, 'median_ms')),
      ...optional('worstMs', num(row, 'worst_ms')),
      spilledBytes: count(row, 'spilled_bytes'),
      shuffleBytes: count(row, 'shuffle_bytes'),
      readBytes: count(row, 'read_bytes'),
      writtenBytes: count(row, 'written_bytes'),
      ...optional('prunedPercent', num(row, 'pruned_percent')),
      readFiles: count(row, 'read_files'),
      prunedFiles: count(row, 'pruned_files'),
      ...optional('parallelism', num(row, 'parallelism')),
      ...optional('compilationPercent', num(row, 'compilation_percent')),
      queueMs: count(row, 'queue_ms'),
      cacheHits: count(row, 'cache_hits'),
      failures: count(row, 'failures'),
      warehouses: count(row, 'warehouses'),
      jobs: count(row, 'jobs'),
      pipelines: count(row, 'pipelines'),
      ...optional('statementId', text(row, 'statement_id')),
      ...optional('statementText', text(row, 'statement_text')),
      ...optional('representativeAt', date(row, 'representative_at')),
      // False rather than absent where the column says nothing: it answers "did this text come from a
      // run that measured something", and an unreadable answer is not a claim that it did.
      representativeMeasured: bool(row, 'representative_measured') ?? false,
      ...optional('representativeStatus', text(row, 'representative_status')),
      // Absent rather than empty on non-warehouse compute, because the absence is what
      // `plans/retrievable.ts` reads: an empty string there would look like a warehouse with no id.
      ...optional('representativeWarehouseId', text(row, 'representative_warehouse_id')),
      ...optional('representativeComputeType', text(row, 'representative_compute_type')),
      coveredMs: count(row, 'covered_ms'),
      excludedMs: count(row, 'excluded_ms'),
      selfMs: count(row, 'self_ms'),
      coveredRuns: count(row, 'covered_runs'),
      excludedRuns: count(row, 'excluded_runs'),
      selfRuns: count(row, 'self_runs'),
      ambiguousMs: count(row, 'ambiguous_ms'),
      ambiguousRuns: count(row, 'ambiguous_runs'),
      ambiguousShapes: count(row, 'ambiguous_shapes'),
    }));
  },

  servingModelEntities: (rows: readonly Row[]): ServingModelEntity[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      servedEntityId: text(row, 'served_entity_id') ?? '',
      endpointId: text(row, 'endpoint_id') ?? '',
      endpointName: text(row, 'endpoint_name') ?? '',
      servedEntityName: text(row, 'served_entity_name') ?? '',
      entityType: text(row, 'entity_type') ?? '',
      // Optional rather than defaulted to empty, because `OE-02-08` reads the absence of a version as
      // the finding. An empty string here would be indistinguishable from a version of `""`.
      ...optional('entityName', text(row, 'entity_name')),
      ...optional('entityVersion', text(row, 'entity_version')),
      ...optional('task', text(row, 'task')),
      ...optional('createdBy', text(row, 'created_by')),
      ...optional('changedAt', date(row, 'change_time')),
      requests: count(row, 'requests'),
      daysWithTraffic: count(row, 'days_with_traffic'),
      failedRequests: count(row, 'failed_requests'),
      requestsWithoutStatus: count(row, 'requests_without_status'),
      ...optional('lastRequest', date(row, 'last_request')),
      liveEntities: count(row, 'live_entities'),
      liveEndpoints: count(row, 'live_endpoints'),
      customModels: count(row, 'custom_models'),
      foundationModels: count(row, 'foundation_models'),
      externalModels: count(row, 'external_models'),
      featureSpecs: count(row, 'feature_specs'),
      customModelsWithAVersion: count(row, 'custom_models_with_a_version'),
      customModelsNamedInUc: count(row, 'custom_models_named_in_uc'),
    }));
  },

  mlflowRunTracking: (rows: readonly Row[]): MlflowRunTracking => {
    const row = rows[0] ?? {};
    // The statement returns exactly one row, and a missing one is a read that produced nothing rather
    // than an estate with no runs — the statement's own aggregate returns zeros for that. Zeros here
    // would turn the first case into the second, which is why the signal's absence is what the resolver
    // reads and this only has to be total.
    return {
      runs: count(row, 'runs'),
      experimentsWithRuns: count(row, 'experiments_with_runs'),
      runsFromAJob: count(row, 'runs_from_a_job'),
      experimentsWithAJobRun: count(row, 'experiments_with_a_job_run'),
      runsFromANotebook: count(row, 'runs_from_a_notebook'),
      runsFromElsewhere: count(row, 'runs_from_elsewhere'),
      runsFromAProject: count(row, 'runs_from_a_project'),
      runsWithoutASource: count(row, 'runs_without_a_source'),
      runsThatFinished: count(row, 'runs_that_finished'),
      experiments: count(row, 'experiments'),
      liveExperiments: count(row, 'live_experiments'),
    };
  },

  writePatterns: (rows: readonly Row[]): WritePatternRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      shape: text(row, 'shape') ?? '',
      statementType: text(row, 'statement_type') ?? '',
      runs: count(row, 'runs'),
      finishedRuns: count(row, 'finished_runs'),
      daysRun: count(row, 'days_run'),
      runsStatingBytes: count(row, 'runs_stating_bytes'),
      writtenBytes: count(row, 'written_bytes'),
      // `num` on the two per-run byte figures, because a shape whose every run stated nothing has no
      // largest write and no middle one — and a zero there is the claim the whole signal is built to
      // avoid making, that a statement which wrote an unrecorded amount wrote none.
      ...optional('largestWriteBytes', num(row, 'largest_write_bytes')),
      ...optional('medianWriteBytes', num(row, 'median_write_bytes')),
      readBytes: count(row, 'read_bytes'),
      producedRows: count(row, 'produced_rows'),
      totalMs: count(row, 'total_ms'),
      ...optional('firstSeen', date(row, 'first_seen')),
      ...optional('lastSeen', date(row, 'last_seen')),
      ...optional('statementId', text(row, 'statement_id')),
      ...optional('statementText', text(row, 'statement_text')),
      ...optional('representativeAt', date(row, 'representative_at')),
      writeStatements: count(row, 'write_statements'),
      writesStatingBytes: count(row, 'writes_stating_bytes'),
      estateWrittenBytes: count(row, 'estate_written_bytes'),
      otherStatements: count(row, 'other_statements'),
    }));
  },

  tableStatistics: (rows: readonly Row[]): TableStatistics => ({
    // A row whose table name or ANALYZE time could not be read is dropped rather than defaulted. Both are the
    // row's identity — a stale-statistics claim needs to say which table and from when — and a row with
    // either missing is not a weaker reading, it is not a reading.
    tables: rows.flatMap((row) => {
      const table = text(row, 'table_name');
      const analysedAt = date(row, 'analysed_at');
      if (table == null || table === '' || analysedAt == null) return [];
      return [
        {
          table,
          analysedAt,
          analyseOperations: count(row, 'analyse_operations'),
          ...optional('writtenAt', date(row, 'written_at')),
          ...optional('writeEvents', num(row, 'write_events')),
          ...optional('hoursWrittenAfterAnalyse', num(row, 'hours_written_after_analyse')),
        },
      ];
    }),
  }),

  jobRunHealth: (rows: readonly Row[]): JobRunHealth => ({
    // A row whose workspace or job could not be read is dropped rather than defaulted, for the reason
    // `tableStatistics` drops one missing its table: the pair is the row's identity, and a finding about a job
    // nobody can name is not a weaker reading but not a reading.
    jobs: rows.flatMap((row) => {
      const workspaceId = text(row, 'workspace_id');
      const jobId = text(row, 'job_id');
      if (workspaceId == null || workspaceId === '' || jobId == null || jobId === '') return [];
      return [
        {
          workspaceId,
          jobId,
          runs: count(row, 'runs'),
          wallSecondsTotal: count(row, 'wall_seconds_total'),
          wallSecondsMean: count(row, 'wall_seconds_mean'),
          wallSecondsP95: count(row, 'wall_seconds_p95'),
          wallSecondsMedian: count(row, 'wall_seconds_median'),
          wallSecondsMax: count(row, 'wall_seconds_max'),
          longestTaskSeconds: count(row, 'longest_task_seconds'),
          taskSecondsTotal: count(row, 'task_seconds_total'),
          tasksMost: count(row, 'tasks_most'),
          runsWithARepeatedTask: count(row, 'runs_with_a_repeated_task'),
          repeatedTaskRuns: count(row, 'repeated_task_runs'),
          ...optional('lastRun', date(row, 'last_run')),
          ...optional('busiestTaskKey', text(row, 'busiest_task_key')),
          ...optional('busiestTaskSeconds', num(row, 'busiest_task_seconds')),
          // Every one of these is optional because its source is a LEFT JOIN that can miss: a run the task
          // timeline saw may have no run-level row, and a job may have no usage record naming it. Absent has
          // to stay distinguishable from zero — "no usage record" is not "cost nothing", and a rule reading
          // the second from the first is the class of claim this repository keeps paying for.
          ...optional('runsWithATerminalPeriod', num(row, 'runs_with_a_terminal_period')),
          ...optional('runsSucceeded', num(row, 'runs_succeeded')),
          ...optional('runsDidNotSucceed', num(row, 'runs_did_not_succeed')),
          ...optional('runsUnresolved', num(row, 'runs_unresolved')),
          ...optional('runsWithATerminationCode', num(row, 'runs_with_a_termination_code')),
          ...optional('usageQuantity', num(row, 'usage_quantity')),
          ...optional('usageRecords', num(row, 'usage_records')),
          ...optional('usageRetractions', num(row, 'usage_retractions')),
          ...optional('usageSkus', num(row, 'usage_skus')),
          ...optional('classicUsageRecords', num(row, 'classic_usage_records')),
          ...optional('classicRecordsStatingPhoton', num(row, 'classic_records_stating_photon')),
          ...optional('classicRecordsWithPhotonOff', num(row, 'classic_records_with_photon_off')),
          jobPopulation: count(row, 'job_population'),
        },
      ];
    }),
  }),

  jobCompute: (rows: readonly Row[]): JobCompute => ({
    // Identity before anything else, the way `jobRunHealth` does it: a utilisation reading nobody can
    // attach to a job is not a weaker reading, it is not one.
    jobs: rows.flatMap((row) => {
      const workspaceId = text(row, 'workspace_id');
      const jobId = text(row, 'job_id');
      if (workspaceId == null || workspaceId === '' || jobId == null || jobId === '') return [];
      return [
        {
          workspaceId,
          jobId,
          runClusterPairs: count(row, 'run_cluster_pairs'),
          runsWithWorkerSamples: count(row, 'runs_with_worker_samples'),
          clusters: count(row, 'clusters'),
          workerSamples: count(row, 'worker_samples'),
          pairsBelowThreeSamples: count(row, 'pairs_below_three_samples'),
          avgCpuPercent: count(row, 'avg_cpu_percent'),
          peakCpuPercent: count(row, 'peak_cpu_percent'),
          avgCpuWaitPercent: count(row, 'avg_cpu_wait_percent'),
          avgMemoryPercent: count(row, 'avg_memory_percent'),
          peakMemoryPercent: count(row, 'peak_memory_percent'),
          avgSwapPercent: count(row, 'avg_swap_percent'),
          // Optional, both of them, because a rate needs node-minutes to divide by: a job every one of
          // whose pairs ran inside a single sample boundary has no rate, and a zero there would read as
          // a job that moved no traffic. The estate median is absent for the same reason on an estate
          // with no pair long enough to have one.
          ...optional('networkBytesPerNodeMinute', num(row, 'network_bytes_per_node_minute')),
          pairsWithANetworkRate: count(row, 'pairs_with_a_network_rate'),
          pairsStatingNoNetwork: count(row, 'pairs_stating_no_network'),
          ...optional('estateMedianBytesPerNodeMinute', num(row, 'estate_median_bytes_per_node_minute')),
          estatePairsWithARate: count(row, 'estate_pairs_with_a_rate'),
          // Optional because the as-of join misses on 91.3% of classic pairs, and a name defaulted
          // from a later configuration record would be a claim about a cluster as it was after the
          // run it is attributed to.
          ...optional('nodeType', text(row, 'node_type')),
          pairsWithAnAsOfConfig: count(row, 'pairs_with_an_as_of_config'),
          ...optional('workerCount', num(row, 'worker_count')),
          runsWithNoSetupFigure: count(row, 'runs_with_no_setup_figure'),
          ...optional('setupSecondsMax', num(row, 'setup_seconds_max')),
          ...optional('setupSecondsMean', num(row, 'setup_seconds_mean')),
          ...optional('statedRunSecondsMean', num(row, 'stated_run_seconds_mean')),
          ...optional('earliestSample', date(row, 'earliest_sample')),
          ...optional('latestSample', date(row, 'latest_sample')),
          jobsThatRan: count(row, 'jobs_that_ran'),
          jobsWithAComputeId: count(row, 'jobs_with_a_compute_id'),
          jobsOnClassicCompute: count(row, 'jobs_on_classic_compute'),
          jobPopulation: count(row, 'job_population'),
        },
      ];
    }),
  }),

  sqlPaths: (rows: readonly Row[]): SqlPaths => {
    const row = rows[0] ?? {};
    return {
      statements: count(row, 'statements'),
      warehouseStatements: count(row, 'warehouse_statements'),
      allPurposeStatements: count(row, 'all_purpose_statements'),
      jobClusterStatements: count(row, 'job_cluster_statements'),
      unattributedStatements: count(row, 'unattributed_statements'),
      interactiveStatements: count(row, 'interactive_statements'),
      interactiveWarehouseStatements: count(row, 'interactive_warehouse_statements'),
      interactiveAllPurposeStatements: count(row, 'interactive_all_purpose_statements'),
      fileReadingStatements: count(row, 'file_reading_statements'),
      fileReadBytes: count(row, 'file_read_bytes'),
      cachedReadBytes: count(row, 'cached_read_bytes'),
      resultCacheHits: count(row, 'result_cache_hits'),
      unnamedClientStatements: count(row, 'unnamed_client_statements'),
      clientCount: count(row, 'client_count'),
      clients: list(row, 'clients'),
    };
  },

  warehousePressure: (rows: readonly Row[]): WarehousePressureRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      warehouseId: text(row, 'warehouse_id') ?? '',
      runs: count(row, 'runs'),
      measured: count(row, 'measured'),
      totalMs: count(row, 'total_ms'),
      busyMs: count(row, 'busy_ms'),
      queueMs: count(row, 'queue_ms'),
      spilledBytes: count(row, 'spilled_bytes'),
      peakUsers: count(row, 'peak_users'),
      daysUsed: count(row, 'days_used'),
      daysQueued: count(row, 'days_queued'),
      daysSpilled: count(row, 'days_spilled'),
      // `num` rather than `count` on these five, because each is null in a case that means something and
      // zero would be a claim: a warehouse that ran nothing has no p95, and one that was never up has no
      // utilisation share rather than a utilisation of none.
      ...optional('p95Ms', num(row, 'p95_ms')),
      ...optional('worstMs', num(row, 'worst_ms')),
      ...optional('worstQueueMs', num(row, 'worst_queue_ms')),
      upMs: count(row, 'up_ms'),
      clusterMs: count(row, 'cluster_ms'),
      starts: count(row, 'starts'),
      peakClusters: count(row, 'peak_clusters'),
      daysSeen: count(row, 'days_seen'),
      // False rather than absent for the same reason as `ranAssessment` below: it answers "did the
      // window open with this up", and an unreadable answer is not a claim that it did.
      carriedIn: bool(row, 'carried_in') ?? false,
      ...optional('executionPercent', num(row, 'execution_percent')),
      ...optional('queuePercent', num(row, 'queue_percent')),
      // False rather than absent when the column says nothing. It answers "did we run here", and the
      // honest default for an unreadable answer is that we did not claim to have.
      ranAssessment: bool(row, 'ran_assessment') ?? false,
      warehousePopulation: count(row, 'warehouse_population'),
    }));
  },

  jobSpend: (rows: readonly Row[]): JobSpendRow[] => {
    return rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      jobId: text(row, 'job_id') ?? '',
      cost: count(row, 'cost'),
      serverlessCost: count(row, 'serverless_cost'),
      classicCost: count(row, 'classic_cost'),
      classicDbus: count(row, 'classic_dbus'),
      unpricedRecords: count(row, 'unpriced_records'),
      ...optional('currency', text(row, 'currency')),
      // Absent rather than zero: no serverless SKU for this region is the difference
      // between "we could not price this" and "it would be free".
      ...optional('serverlessRate', num(row, 'serverless_rate')),
      ...optional('serverlessRegion', text(row, 'serverless_region')),
      classicSkus: list(row, 'classic_skus'),
    }));
  },

  workspaceDirectory: (rows: readonly Row[]): WorkspaceDirectory => {
    const workspaces = rows.map<WorkspaceRow>((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      name: text(row, 'workspace_name') ?? '(unnamed)',
      ...optional('url', text(row, 'workspace_url')),
      status: text(row, 'status') ?? 'UNKNOWN',
      ...optional('region', text(row, 'region')),
      live: bool(row, 'live') ?? false,
    }));

    // Status only. The region half needs the app's own workspace id and the scope half needs what the
    // assessment asked for, neither of which this parser has any way to know, so `scopedToRegion` and
    // `scopedToSelection` narrow this before anything reads it. See region.ts and selection.ts.
    return {
      workspaces,
      live: workspaces.filter((workspace) => workspace.live),
      excluded: workspaces
        .filter((workspace) => !workspace.live)
        .map((workspace) => ({ ...workspace, reason: 'not-running' as const })),
      regionUnverified: [],
      outOfScope: [],
    };
  },

  assetCensus: (rows: readonly Row[]): AssetCensus => {
    const row = rows[0] ?? {};
    return {
      tableCount: count(row, 'table_count'),
      catalogCount: count(row, 'catalog_count'),
      schemaCount: count(row, 'schema_count'),
      managedTables: count(row, 'managed_tables'),
      externalTables: count(row, 'external_tables'),
      views: count(row, 'views'),
      metricViews: count(row, 'metric_views'),
      foreignTables: count(row, 'foreign_tables'),
      deltaTables: count(row, 'delta_tables'),
      icebergTables: count(row, 'iceberg_tables'),
      optimizedFormatTables: count(row, 'optimized_format_tables'),
      describedTables: count(row, 'described_tables'),
      distinctOwners: count(row, 'distinct_owners'),
      databricksOwnedTables: count(row, 'databricks_owned_tables'),
      databricksOwnedCatalogs: text(row, 'databricks_owned_catalogs') ?? '',
    };
  },

  discoveryMetadata: (rows: readonly Row[]): DiscoveryMetadata => {
    const row = rows[0] ?? {};
    return {
      estateTables: count(row, 'estate_tables'),
      estateTablesDescribed: count(row, 'estate_tables_described'),
      readTables: count(row, 'read_tables'),
      readTablesDescribed: count(row, 'read_tables_described'),
      readTablesTagged: count(row, 'read_tables_tagged'),
      readTablesOwned: count(row, 'read_tables_owned'),
      readEvents: count(row, 'read_events'),
    };
  },

  discoveryColumns: (rows: readonly Row[]): DiscoveryColumns => {
    const row = rows[0] ?? {};
    return {
      readTableColumns: count(row, 'read_table_columns'),
      readTableColumnsDescribed: count(row, 'read_table_columns_described'),
    };
  },

  platformCensus: (rows: readonly Row[]): PlatformCensus => {
    const row = rows[0] ?? {};
    return {
      shares: count(row, 'shares'),
      recipients: count(row, 'recipients'),
      tokenRecipients: count(row, 'token_recipients'),
      recipientsWithIpAllowlist: count(row, 'recipients_with_ip_allowlist'),
      providers: count(row, 'providers'),
      connections: count(row, 'connections'),
      connectionTypes: text(row, 'connection_types') ?? '',
      externalLocations: count(row, 'external_locations'),
      storageCredentials: count(row, 'storage_credentials'),
      volumes: count(row, 'volumes'),
      managedVolumes: count(row, 'managed_volumes'),
      routines: count(row, 'routines'),
      columnMasks: count(row, 'column_masks'),
      rowFilters: count(row, 'row_filters'),
      taggedTables: count(row, 'tagged_tables'),
      taggedColumns: count(row, 'tagged_columns'),
      // `?? false` and not `?? true`: a reading that did not come back cannot establish that this
      // identity sees everything, and the resolvers treat an unestablished visibility as unreadable
      // rather than as an empty estate.
      ownsMetastore: bool(row, 'owns_metastore') ?? false,
      sharingPrivileges: (text(row, 'sharing_privileges') ?? '').split(',').filter((one) => one !== ''),
    };
  },

  pipelines: (rows: readonly Row[]): PipelineRow[] =>
    rows.map((row) => ({
      workspaceId: text(row, 'workspace_id') ?? '',
      pipelineId: text(row, 'pipeline_id') ?? '',
      name: text(row, 'name') ?? '(unnamed)',
      ...optional('pipelineType', text(row, 'pipeline_type')),
      development: bool(row, 'development') ?? false,
      serverless: bool(row, 'serverless') ?? false,
      photon: bool(row, 'photon') ?? false,
      ...optional('edition', text(row, 'edition')),
      ...optional('channel', text(row, 'channel')),
      ...optional('runAs', text(row, 'run_as')),
      tagCount: count(row, 'tag_count'),
      updates: count(row, 'updates'),
      failedUpdates: count(row, 'failed_updates'),
    })),

  servingPopulation: (rows: readonly Row[]): ServingPopulationRows => ({
    matchPopulation: count(rows[0] ?? {}, 'match_population'),
    matches: rows.map<ServingMatch>((row) => ({
      qualified: text(row, 'qualified') ?? '',
      catalog: text(row, 'table_catalog') ?? '',
      schema: text(row, 'table_schema') ?? '',
      table: text(row, 'table_name') ?? '',
      description: text(row, 'table_comment') ?? null,
      owner: text(row, 'table_owner') ?? null,
      ...optional('tagKey', text(row, 'tag_key')),
      ...optional('tagValue', text(row, 'tag_value')),
      ...optional('tagLevel', text(row, 'tag_level')),
    })),
  }),

  servingTags: (rows: readonly Row[]): ServingTagRows => ({
    tagPopulation: count(rows[0] ?? {}, 'tag_population'),
    tags: rows.map<ServingTag>((row) => ({
      qualified: text(row, 'qualified') ?? '',
      key: text(row, 'tag_key') ?? '',
      value: text(row, 'tag_value') ?? '',
    })),
  }),

  servingFacts: (rows: readonly Row[]): ServingFactRows => ({
    assetPopulation: count(rows[0] ?? {}, 'asset_population'),
    assets: rows.map<ServingFact>((row) => ({
      qualified: text(row, 'qualified') ?? '',
      relationKind: text(row, 'relation_kind') ?? null,
      storageFormat: text(row, 'storage_format') ?? null,
      columnCount: count(row, 'column_count'),
      commentedColumns: count(row, 'commented_columns'),
      lineageEvents: count(row, 'lineage_events'),
      semanticReaders: count(row, 'semantic_readers'),
      maskedColumns: count(row, 'masked_columns'),
      rowFilters: count(row, 'row_filters'),
    })),
  }),

  qualityMonitoring: (rows: readonly Row[]): QualityMonitoring => {
    const row = rows[0] ?? {};
    return {
      estateTables: count(row, 'estate_tables'),
      estateCatalogs: count(row, 'estate_catalogs'),
      monitoredTables: count(row, 'monitored_tables'),
      monitoredCatalogs: count(row, 'monitored_catalogs'),
      healthy: count(row, 'healthy'),
      unhealthy: count(row, 'unhealthy'),
      training: count(row, 'training'),
      errored: count(row, 'errored'),
      unnamedStatus: count(row, 'unnamed_status'),
      freshnessPresent: count(row, 'freshness_present'),
      completenessPresent: count(row, 'completeness_present'),
      freshnessEstablished: count(row, 'freshness_established'),
      completenessEstablished: count(row, 'completeness_established'),
    };
  },

  servingQuality: (rows: readonly Row[]): ServingQualityRows => ({
    qualityPopulation: count(rows[0] ?? {}, 'quality_population'),
    statuses: rows.map<ServingQuality>((row) => ({
      qualified: text(row, 'qualified') ?? '',
      // Kept as the platform's text. Row 65 split this read out of the facts statement and changed
      // nothing about what the status means, because nothing about it has been measured.
      qualityStatus: text(row, 'quality_status') ?? null,
    })),
  }),

  servingClasses: (rows: readonly Row[]): ServingClassRows => ({
    classPopulation: count(rows[0] ?? {}, 'class_population'),
    classified: rows.map<ServingClasses>((row) => ({
      qualified: text(row, 'qualified') ?? '',
      classifications: list(row, 'classifications'),
    })),
  }),

  schemaCensus: (rows: readonly Row[]): SchemaCensus => ({
    // Every row repeats the population, so any row carries it. Falling back to the row
    // count would report a truncated result as complete.
    schemaPopulation: count(rows[0] ?? {}, 'schema_population'),
    schemas: rows.map<SchemaCensusRow>((row) => ({
      catalog: text(row, 'table_catalog') ?? '(unknown)',
      schema: text(row, 'table_schema') ?? '(unknown)',
      tableCount: count(row, 'table_count'),
      managedTables: count(row, 'managed_tables'),
      externalTables: count(row, 'external_tables'),
      views: count(row, 'views'),
      metricViews: count(row, 'metric_views'),
      foreignTables: count(row, 'foreign_tables'),
      optimizedFormatTables: count(row, 'optimized_format_tables'),
      describedTables: count(row, 'described_tables'),
      distinctOwners: count(row, 'distinct_owners'),
    })),
  }),

  lineageCoverage: (rows: readonly Row[]): LineageCoverage => {
    const row = rows[0] ?? {};
    return {
      tableCount: count(row, 'table_count'),
      tablesWithLineage: count(row, 'tables_with_lineage'),
      tablesWrittenWithLineage: count(row, 'tables_written_with_lineage'),
      tablesReadWithLineage: count(row, 'tables_read_with_lineage'),
      lineageEvents: count(row, 'lineage_events'),
      ...optional('lastEvent', date(row, 'last_event')),
    };
  },

  auditCoverage: (rows: readonly Row[]): AuditCoverage => {
    const row = rows[0] ?? {};
    return {
      events: count(row, 'events'),
      services: count(row, 'services'),
      actions: count(row, 'actions'),
      actors: count(row, 'actors'),
      ...optional('lastEvent', date(row, 'last_event')),
      ...optional('daysSinceLastEvent', num(row, 'days_since_last_event')),
      unityCatalogEvents: count(row, 'unity_catalog_events'),
    };
  },

  authLoginPaths: (rows: readonly Row[]): AuthLoginPaths => {
    const row = rows[0] ?? {};
    return {
      loginEvents: count(row, 'login_events'),
      passwordLogins: count(row, 'password_logins'),
      samlLogins: count(row, 'saml_logins'),
      oidcLogins: count(row, 'oidc_logins'),
      otherAuthEvents: count(row, 'other_auth_events'),
      otherAuthActions: list(row, 'other_auth_actions'),
      accountPlaneEvents: count(row, 'account_plane_events'),
      passwordActors: count(row, 'password_actors'),
      ...optional('lastPasswordLogin', date(row, 'last_password_login')),
    };
  },

  nodeUtilization: (rows: readonly Row[]): NodeUtilization => {
    const row = rows[0] ?? {};
    return {
      nodeSamples: count(row, 'node_samples'),
      clustersObserved: count(row, 'clusters_observed'),
      idleClusters: count(row, 'idle_clusters'),
      ...optional('lastSample', date(row, 'last_sample')),
    };
  },

  storageMetrics: (rows: readonly Row[]): StorageMetrics => {
    const estate = rows.find((row) => text(row, 'row_kind') === 'estate') ?? {};
    const tableCount = count(estate, 'table_count');
    return {
      snapshotAvailable: tableCount > 0,
      ...optional('snapshotDate', date(estate, 'snapshot_date')),
      tableCount,
      activeBytes: count(estate, 'active_bytes'),
      activeFiles: count(estate, 'active_files'),
      predictiveOptimizationTables: count(estate, 'po_tables'),
      largest: rows
        .filter((row) => text(row, 'row_kind') === 'table')
        .map((row) => ({
          catalog: text(row, 'catalog_name') ?? '',
          schema: text(row, 'schema_name') ?? '',
          table: text(row, 'table_name') ?? '',
          ...optional('tableType', text(row, 'table_type')),
          activeBytes: count(row, 'active_bytes'),
          activeFiles: count(row, 'active_files'),
          predictiveOptimization: count(row, 'po_tables') > 0,
        })),
    };
  },

  sampleSelection: (rows: readonly Row[]): SampleSelection => {
    const candidates = rows.map((row) => ({
      catalog: text(row, 'table_catalog') ?? '',
      schema: text(row, 'table_schema') ?? '',
      table: text(row, 'table_name') ?? '',
      ...optional('tableType', text(row, 'table_type')),
      readEvents: count(row, 'read_events'),
    }));
    return {
      candidates,
      // The window function repeats the population on every row, so any row carries it.
      // Falling back to the row count would understate it to exactly the sample size,
      // which is the one wrong answer that looks plausible.
      eligibleTables: count(rows[0] ?? {}, 'eligible_tables'),
      activeTables: candidates.filter((candidate) => candidate.readEvents > 0).length,
    };
  },

  catalogs: (rows: readonly Row[]): CatalogInventory => ({
    catalogs: rows.map((row) => ({
      catalog: text(row, 'catalog_name') ?? 'unknown',
      tableCount: count(row, 'table_count'),
      managedTables: count(row, 'managed_tables'),
      schemaCount: count(row, 'schema_count'),
    })),
  }),

  maintenance: (rows: readonly Row[]): MaintenanceRecency => {
    return {
      operations: rows.map((row) => {
        const raw = text(row, 'source');
        const source =
          raw === 'predictive_optimization'
            ? ('predictive_optimization' as const)
            : raw === 'manual_unresolved'
              ? ('manual_unresolved' as const)
              : ('manual' as const);
        return {
          source,
          operation: text(row, 'operation_type') ?? 'UNKNOWN',
          operations: count(row, 'operations'),
          ...optional('lastRun', date(row, 'last_run')),
          ...optional('tablesTouched', num(row, 'tables_touched')),
        };
      }),
    };
  },
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
function priceCoverage(row: Row): PriceCoverage {
  return {
    unpricedRecords: count(row, 'unpriced_records'),
    ...optional('leastPricedUnit', text(row, 'least_priced_unit')),
    ...optional('leastPricedShare', num(row, 'least_priced_share')),
    ...optional('usageUnitCount', num(row, 'usage_unit_count')),
    ...optional('currencies', num(row, 'currencies')),
    ...optional('duplicatePriceMatches', num(row, 'duplicate_price_matches')),
    ...optional('currency', text(row, 'currency')),
  };
}

function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

/**
 * A comma-joined column as a list.
 *
 * The statements that return a sample of names join them in SQL rather than returning an
 * array, because an array column arrives as JSON text over the wire and a list of names is
 * not worth a JSON parse. Empty entries are dropped: `concat_ws` skips nulls but a column
 * with nothing in it still arrives as the empty string.
 */
function list(row: Row, column: string): readonly string[] {
  const joined = text(row, column);
  return joined == null ? [] : joined.split(',').filter((item) => item !== '');
}
