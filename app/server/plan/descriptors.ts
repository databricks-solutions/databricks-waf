// What each signal does, touches and needs.
//
// This is the material for the question an admin asks before letting the app run and
// again when a pillar comes back mostly unmeasured: what exactly will this execute, where,
// and what does it need to be allowed to do. Until now that was answerable only by reading
// the collectors, which is not a reasonable thing to ask of the person deciding.
//
// Three kinds of fact live here and they are held to different standards.
//
// What a statement reads is derived from the statement — `tablesRead` over the same
// expanded text the collector loads — so it cannot describe a query that is not the one
// that runs. What a call contacts comes from the probe table, next to the code making the
// call. Only the sentence describing what a signal observes is written prose, and it is
// the one fact whose being stale costs nothing but clarity.
//
// The pairing with the collectors is checked, not trusted: a signal any collector produces
// and this table omits fails a test, because the failure mode otherwise is a requirements
// page that quietly under-reports what the app touches.

import { PROBES } from '../collect/rest/probes.js';
import { VOLUME_SIGNAL } from '../collect/cloud/collector.js';
import { DIRECTORY_SIGNAL, SQL_SIGNAL_SOURCES } from '../collect/sql/collector.js';
import { CATALOGS_SIGNAL, PO_SIGNAL } from '../collect/sql/predictive-optimization.js';
import { SAMPLE_SIGNAL, TABLE_DETAILS_SIGNAL } from '../collect/sql/describe.js';
import { FileQuerySource, type QuerySource } from '../collect/sql/queries.js';
import { schemasOf, tablesRead } from '../collect/sql/reads.js';
import type { Reach, SignalId } from '../collect/signal.js';
import type { Surface } from '../scan/surfaces.js';

/**
 * A thing the caller has to be allowed to do, in the terms whoever can grant it uses.
 *
 * Split by kind because the three are granted by different people in different places, and
 * a flat list of strings would leave a workspace admin scanning for the two lines that
 * concern them. A metastore grant is `GRANT SELECT` in a notebook, a workspace permission
 * is the admin settings page, and an app scope is neither — it is a property of this app's
 * deployment that no one in the workspace can change.
 */
export interface Requirement {
  readonly kind: 'metastore-grant' | 'workspace-permission' | 'app-scope';
  /** The grant, permission or scope itself. Shown verbatim. */
  readonly what: string;
  /**
   * For an app scope: whether Databricks Apps offers it to an app at all.
   *
   * False means no install of this app can ever hold it, so the reader should stop looking
   * for a setting to change. ADR 0016.
   */
  readonly grantable?: boolean;
  readonly note?: string;
}

/**
 * How much work one signal is, in the unit its surface is budgeted in.
 *
 * `perObject` exists because two signals on the same surface can differ by two orders of
 * magnitude: the estate census is one statement whatever the estate holds, while the
 * per-table pass is one statement per table it was given. A page that reported both as
 * "1 signal" would make the expensive one look free.
 */
export interface SignalCost {
  readonly kind: 'one-statement' | 'per-object' | 'one-call';
  /** What the objects are, when there is one operation per object. */
  readonly objects?: string;
  /** The app's own ceiling on how many, independent of the surface budget. */
  readonly ceiling?: number;
}

export interface SignalDescriptor {
  readonly id: SignalId;
  readonly surface: Surface;
  /** The collector that produces it, by the name it reports in the footprint. */
  readonly collector: string;
  readonly reach: Reach;
  /** One sentence: what this observes about the estate. */
  readonly observes: string;
  /** What it contacts: system tables by name, or an endpoint by path. */
  readonly touches: readonly string[];
  readonly cost: SignalCost;
  /** Requirements specific to this signal. Surface-wide ones are on the surface. */
  readonly requires: readonly Requirement[];
  /**
   * Signals that must be collected before this one, because its collector reads them.
   *
   * Present so the page's count of what a run executes matches what a run executes. The
   * scan collects the closure — a check needing one per-table signal drags in the sample
   * that chooses the tables, and the workspace directory that every account-wide statement
   * filters on — and a plan built only from what resolvers ask for would under-report by
   * three statements and omit the one whose failure silently widens every count.
   *
   * Checked against the collectors themselves, so this cannot describe a dependency the
   * code does not have.
   */
  readonly derivedFrom?: readonly SignalId[];
}

/**
 * A surface, and what is true of every signal on it.
 *
 * Stated once rather than repeated per signal, because a scope the whole surface needs
 * repeated across fifteen entries reads as fifteen requirements. It is one, and either the
 * install has it or nothing on the surface works.
 */
export interface SurfaceDescriptor {
  readonly surface: Surface;
  readonly title: string;
  /** How the calls are made, in one sentence. */
  readonly how: string;
  /** Who they run as. The same for all of them today, and load-bearing: ADR 0016. */
  readonly identity: string;
  readonly requires: readonly Requirement[];
}

const RUNS_AS_USER =
  'whoever started the run, using the token the platform forwards to the app — a person who pressed the button, or the service principal a schedule runs as. The app never reads the estate as its own service principal, so an assessment shows only what the identity behind it is entitled to see';

export const SURFACES: readonly SurfaceDescriptor[] = [
  {
    surface: 'sql',
    title: 'System tables',
    how: 'One SQL statement per check, submitted to the bound SQL warehouse through the Statement Execution API.',
    identity: RUNS_AS_USER,
    requires: [
      {
        kind: 'app-scope',
        what: 'sql.statement-execution',
        grantable: true,
        note: 'Declared by the app and held. Without it no check on this surface runs at all.',
      },
      {
        kind: 'workspace-permission',
        what: 'CAN USE on the SQL warehouse bound to the app',
        note: 'The consuming admin binds the warehouse at install time; the identity a scan runs as needs to be able to run statements on it.',
      },
    ],
  },
  {
    surface: 'describe',
    title: 'Per-object metadata',
    how: 'One DESCRIBE statement per object, on the same warehouse but budgeted separately, because the count follows the estate rather than the number of checks.',
    identity: RUNS_AS_USER,
    requires: [
      {
        kind: 'app-scope',
        what: 'sql.statement-execution',
        grantable: true,
        note: 'The same scope the system-table checks use; these are statements too.',
      },
    ],
  },
  {
    surface: 'rest',
    title: 'Workspace configuration',
    how: 'One call per check to the workspace control plane, for settings no system table carries.',
    identity: RUNS_AS_USER,
    requires: [
      {
        kind: 'app-scope',
        what: 'one scope per API family, listed per check below',
        note: 'Most of these are not offered to apps at all, so the checks needing them cannot run under any install and are answered by attestation instead. ADR 0016.',
      },
    ],
  },
];

/** What a system-table statement needs, given the schemas it reads. */
function metastoreGrants(tables: readonly string[]): readonly Requirement[] {
  return schemasOf(tables).map((schema) => ({
    kind: 'metastore-grant' as const,
    what: `SELECT on ${schema}`,
    note:
      schema === 'system.information_schema'
        ? 'Readable by anyone who can use the metastore; no grant is normally needed.'
        : 'Granted on the system schema by a metastore admin. Without it the check reports itself unmeasured rather than failing the estate.',
  }));
}

/**
 * What each system-table signal observes.
 *
 * Prose, and the only part of a descriptor that is. Keyed by signal so a signal added to
 * the collector without a sentence here fails the pairing test rather than appearing on the
 * page as an unexplained identifier.
 */
const SQL_OBSERVES: Readonly<Record<string, string>> = {
  'sql:estate.workspaces':
    'Which workspaces the account has and which are still running, so every other account-wide check can exclude the ones that are gone.',
  'sql:estate.compute_profile': 'What each workspace spent over the lookback window, and on which kinds of compute.',
  'sql:compute.clusters':
    'Every cluster the account can see, with its policy, access mode, init scripts and runtime version.',
  'sql:compute.warehouses': 'Every SQL warehouse, with its size, type, scaling range and auto-stop setting.',
  'sql:compute.node_utilization':
    'Average per-cluster CPU utilisation over the window, and how many clusters sat idle throughout it.',
  'sql:cost.attribution':
    'How much of the spend carries the tags that would let it be attributed to a team or workload.',
  'sql:cost.compute_mix': 'How the spend divides between serverless, jobs and all-purpose compute.',
  'sql:jobs.inventory': 'Every job, with the compute it runs on, its schedule and its retry settings.',
  'sql:governance.audit_coverage':
    'Which workspaces are producing audit records, and how recently, since a workspace absent from the audit log is unmonitored rather than quiet.',
  'sql:security.auth_login_paths':
    'How people authenticated in the window: local username-and-password logins against SSO and OAuth, from the audit log.',
  'sql:security.dbfs_tables':
    'How many Unity Catalog managed tables in the metastore have their data stored on DBFS root rather than in a governed cloud location, where file-level access control does not apply.',
  'sql:uc.census': 'The metastore’s tables counted by format, ownership and whether they carry a description.',
  'sql:uc.schema_census':
    'The same census per schema, largest first, so a gap can be located rather than only counted.',
  'sql:uc.platform_census':
    'The rest of the metastore: what is shared and with whom, which external systems are federated in, and where masks, filters and tags are actually used.',
  'sql:uc.discovery':
    'Whether the tables anything actually read carry a description, a tag and an owner — the same measure as the census, over the assets consumers reach for.',
  'sql:uc.discovery_columns':
    'How many of the columns on those same read tables carry a comment. Read separately from the statement above because it references system.information_schema.columns, which on a large estate takes the planner an hour to load whatever the query asks of it; where it does not return in time the discoverability control still scores, without this line.',
  'sql:uc.quality_monitoring':
    'How many customer tables the platform’s quality monitor last wrote a verdict for, and how those latest verdicts split. Read from system.data_quality_monitoring, which an account admin enables per metastore and which is off by default; where it is off this statement does not run. The counts are reported and not judged — a Healthy verdict is not a pass, and a table the monitor does not watch is not a fail.',
  'sql:pipelines.inventory': 'Every declarative pipeline, whether it is in production mode, and whether it has run.',
  'sql:storage.sample_selection':
    'Chooses which tables the per-table pass will describe, favouring the ones recently used.',
  'sql:uc.lineage_coverage': 'How many tables have lineage recorded against them.',
  'sql:storage.table_metrics':
    'The platform’s own per-table storage snapshot, where it is populated. It was empty on every workspace measured so far, so the per-table pass covers the same ground.',
  'sql:uc.catalogs':
    'Which catalogs actually hold tables, so the catalog-level pass is not spent on a setting that governs nothing.',
  'sql:maintenance.recency':
    'When OPTIMIZE, VACUUM and ANALYZE last ran across the estate, and what predictive optimization did on its own.',
  // The two the serverless analyzer reads. Named as per-job rather than per-estate, because
  // that is the whole difference between them and the compute-mix signal above, and a reader
  // deciding whether to permit these two should know they return one row per job.
  'sql:serverless.job_readiness':
    'What each job actually ran on, and for the classic clusters among them the configuration that decides whether serverless could run the same work: GPUs, init scripts, instance pools, cloud identities, access modes and runtime versions.',
  // The one signal here that reads query text. Said plainly, because a reader deciding whether to permit
  // this should know it and not discover it on a page: the advisor is useless without it — nobody can act
  // on `118d86d07db5ece6` — and the app shows it as it was recorded rather than redacted, on the grounds
  // that it runs in the customer's own environment and the reader already has access to the history it
  // came from.
  'sql:workload.query_shapes':
    'The costliest query groups that ran in the window, grouped by the text of the statement: how long they took, how often they ran, how much they read, shuffled and spilled, how much of their time went to planning or to waiting for a warehouse, and how many of their runs failed. The text of one representative statement per group is read and displayed as it was recorded, because a fingerprint is not something anybody can act on. Materialised-view refreshes are left out, and how much query time that excluded is reported alongside.',
  'sql:workload.write_patterns':
    'The statements that wrote data in the window, grouped by the text of the statement the same way the costliest queries are: what kind of write each was, how many times it ran and on how many days, how much it wrote and read, and the text of the one that wrote the most, displayed as it was recorded. Only how much was written is read — no table contents — and where the platform recorded no written figure for a run, that run is counted apart rather than treated as having written nothing.',
  'sql:serving.model_entities':
    'The models the estate serves on managed serving endpoints: which endpoint each is on, what kind of model it is, the name and version it was resolved by, who created it, and how many requests reached it in the window and how many of those failed. Only the most recent configuration of each live endpoint is read, and an endpoint that took no requests is kept and reported as idle rather than dropped. Nothing about what a model was asked or what it answered is read — only the counts.',
  'sql:mlflow.run_tracking':
    'A single row counting how the estate’s MLflow runs in the window were started — by a job, from a notebook, from a machine elsewhere, or with no source recorded at all — how many experiments those runs reached, and how many of the runs finished. No parameters, metrics, artefacts or run names are read, and deleted runs and experiments are left out.',
  'sql:query.capacity':
    'A single aggregate row counting how many statements in the window waited at a capacity limit — a warehouse or serverless pool hitting a service quota — and the total time they spent waiting. No query text, no result data and no user identity are read: only the count and the duration the platform recorded against each statement.',
  'sql:workload.table_statistics':
    'For each table something computed optimizer statistics for in the window, when that happened and when the table was last written. No query text and no table contents are read — only the maintenance history and the lineage record of writes. Tables nothing analysed do not appear, because nothing the platform exposes can tell one of those from a table the automatic maintenance has not yet reached.',
  'sql:workload.job_run_health':
    'For the longest-running jobs in the window, how long each one’s runs took — the median, the 95th percentile and the longest — how many of them finished and how many did not, which task the job spends most of its time in, how often a task inside a run had to run again, and what the job billed. Durations are computed from the timelines’ start and end times, because the platform’s own duration fields were measured as written zero. No query text, no notebook source and no table contents are read.',
  'sql:workload.job_compute_utilisation':
    'For the same jobs, how busy the machines were on any classic cluster they ran on: average and peak CPU and memory across the cluster’s workers, how much of the CPU went to waiting on storage, how long each run spent starting the cluster before any work began, and the node type the cluster was configured with when the run started. Only worker nodes are read — a driver idles by design and averaging it in understates the cluster. This is a separate reading from the one above because a workspace that runs its jobs on serverless has no machine telemetry at all, and the rest of the job reading should not go missing with it. No query text, no notebook source and no table contents are read.',
  'sql:workload.sql_paths':
    'How SQL reached its data over the window, counted rather than sampled: how many statements ran on a warehouse against an interactive cluster somebody started, how many of those nobody scheduled, how much of what was read from files came from cache, and the names of the applications that sent the work. No query text is read or displayed — the statement matches four fixed comment markers to leave out the assessment’s own queries and reads nothing else from the text.',
  'sql:workload.warehouse_pressure':
    'What each SQL warehouse was asked to do over the last seven days against what it was billed for: how many statements ran on it, how long they took, how long they spent waiting for capacity, how much they spilled, how many days each of those happened on, and — from the warehouse event stream — how long it was up, how many clusters it ran and how often it had to start. No query text is read.',
  'sql:serverless.job_spend':
    'What each job’s compute cost over the window, split between serverless and classic, with the serverless rate your account’s price list publishes for the same tier and the region the workspace runs in, so a migration can be costed rather than guessed at.',
  // The five the serving-readiness read uses. They are on this page for the same reason as everything
  // above it — an admin deciding what to permit should see them — and they differ from the rest in one
  // way worth saying here: no scan runs them. They read the relations somebody declared they serve, and
  // nothing else, so an estate that has declared nothing is an estate on which these never execute.
  //
  // The last two read system schemas an account admin enables per metastore. An admin reading this page
  // to decide what to permit is the reader most likely to know whether they are on, which is why the
  // two say so here rather than only failing at read time.
  'sql:serving.population':
    'Which relations the serving declaration selects: the ones it names outright, and the ones carrying a tag under one of the keys it names. Only the tag keys the declaration lists are read, and no name is matched as a pattern.',
  'sql:serving.tags':
    'Every tag on the relations that turned out to be served, so the declaration can say which of them carry the keys it requires. Tag keys and values are read; nothing else about the relation is.',
  'sql:serving.facts':
    'For each served relation, the fields six of the readiness dimensions report: what kind of relation it is and what format it stores, how many columns it has and how many of those are commented, how many lineage events name it in the window and how many metric views read it, and how many of its columns carry a mask and whether a row filter applies. No table contents and no query text are read.',
  'sql:serving.quality':
    'The most recent status the platform’s own quality monitoring recorded against each served relation inside the window. Read from system.data_quality_monitoring, which an account admin enables per metastore and which is off by default; where it is off this statement does not run and the quality dimension reports itself unmeasured. The status is carried through as the platform wrote it and is not judged.',
  'sql:serving.classes':
    'Which classes the platform’s classification results assign to each served relation. Read from system.data_classification, which an account admin enables per metastore and which is off by default; where it is off this statement does not run and the dimensions reading a classification report themselves unmeasured. Class tags are read; the column values behind them are not.',
};

function sqlDescriptors(queries: QuerySource): readonly SignalDescriptor[] {
  return Object.entries(SQL_SIGNAL_SOURCES).map(([id, source]) => {
    const tables = tablesRead(queries.text(source.query));
    return {
      id: id as SignalId,
      surface: 'sql' as const,
      collector: 'system-tables',
      reach: source.reach,
      observes: SQL_OBSERVES[id] ?? '',
      touches: tables,
      cost: { kind: 'one-statement' as const },
      requires: metastoreGrants(tables),
      // Every statement here filters on the directory, except the one that produces it.
      ...(id === (DIRECTORY_SIGNAL as string) ? {} : { derivedFrom: [DIRECTORY_SIGNAL] }),
    };
  });
}

const PER_OBJECT: readonly SignalDescriptor[] = [
  {
    id: TABLE_DETAILS_SIGNAL,
    surface: 'describe',
    collector: 'table-detail',
    reach: 'metastore',
    observes:
      'Size, file count, partitioning, clustering and deletion vectors for each table in the sample, which is what the layout and fragmentation checks are decided on.',
    touches: ['DESCRIBE DETAIL on each sampled table'],
    cost: { kind: 'per-object', objects: 'table in the sample', ceiling: 50 },
    derivedFrom: [SAMPLE_SIGNAL],
    requires: [
      {
        kind: 'metastore-grant',
        what: 'SELECT on the tables described, and USE on their catalog and schema',
        note: 'A table the reader cannot select from is left out of the sample with its name recorded, rather than counted as compliant.',
      },
    ],
  },
  {
    id: PO_SIGNAL,
    surface: 'describe',
    collector: 'predictive-optimization',
    reach: 'metastore',
    observes:
      'Whether predictive optimization is enabled on each catalog holding tables, and whether the setting is the catalog’s own or inherited.',
    touches: ['DESCRIBE CATALOG EXTENDED on each catalog holding tables'],
    cost: { kind: 'per-object', objects: 'catalog holding at least one table' },
    derivedFrom: [CATALOGS_SIGNAL],
    requires: [
      {
        kind: 'metastore-grant',
        what: 'USE CATALOG on each catalog',
        note: 'Coverage is weighted by how many tables each catalog holds, so a catalog that cannot be read narrows the claim rather than skewing it.',
      },
    ],
  },
];

function restDescriptors(): readonly SignalDescriptor[] {
  return PROBES.map((probe) => ({
    id: probe.id,
    surface: 'rest' as const,
    collector: 'control-plane',
    // Measured, not assumed: a workspace token is refused by another workspace's control
    // plane, so these describe this workspace and no other. ADR 0015.
    reach: 'workspace' as const,
    observes: `${probe.what}.`,
    touches: [probe.endpoint],
    cost: { kind: 'one-call' as const },
    requires: [
      { kind: 'app-scope' as const, what: probe.scope, grantable: probe.grantable },
      { kind: 'workspace-permission' as const, what: probe.permission },
    ],
  }));
}

/**
 * Every signal the app can collect, described.
 *
 * Takes the query source rather than opening its own, so a test can build descriptors from
 * fixture SQL and the server can share the collector's cache instead of re-reading fifteen
 * files per request.
 */
const CLOUD: readonly SignalDescriptor[] = [
  {
    id: VOLUME_SIGNAL,
    surface: 'cloud',
    collector: 'object-storage',
    reach: 'account',
    observes:
      'The cloud-side storage bill for the estate’s external locations, read with a Unity Catalog service credential. Off unless the install named one; absence is not a fail. Active bytes from the Delta log are a different and smaller number.',
    touches: [
      'Unity Catalog temporary service credentials',
      'S3 Storage Lens or CloudWatch, mapped to external locations',
    ],
    cost: { kind: 'one-call' as const },
    requires: [
      {
        kind: 'metastore-grant',
        what: 'ACCESS on the named Unity Catalog service credential',
        note: 'The install does not require a service credential. Without one this signal is unmeasurable and the Delta-log sample still reports active bytes.',
      },
    ],
  },
];

export function signalDescriptors(queries: QuerySource = new FileQuerySource()): readonly SignalDescriptor[] {
  return [...sqlDescriptors(queries), ...PER_OBJECT, ...restDescriptors(), ...CLOUD];
}
