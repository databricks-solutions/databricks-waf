// Representative rows for the statements whose row count grows with the estate.
//
// These exist to answer one question the `-- Rows:` headers cannot: an unbounded statement is a
// defect, but is it a defect that actually breaks at the size this app claims to handle? The eight
// were listed by counting `GROUP BY` clauses, which says nothing about bytes, and the cap that fails a
// scan is a byte count. So each statement gets a sample of rows shaped like its own `SELECT` list, and
// `scale.test.ts` measures what those cost at `SCALE_TARGETS`.
//
// Two rules about the values, because a fixture that is not representative produces a ceiling nobody
// should trust:
//
//   Widths come from what the column holds in a real estate, not from what is convenient. A job name
//   in an enterprise is `dbt_prod_hourly_incremental_marketing_attribution_v3`, not `job1`, and the
//   difference is a factor of ten on the widest column in the row. Workspace and job ids are the
//   sixteen and fifteen digits the platform actually issues.
//
//   Variation is in the sample rather than averaged into it. Each generator varies name length and
//   leaves the columns documented as unpopulated on older rows null on some of them, so the mean row
//   is a mean over a realistic mix. A sample of one row repeated would measure a single guess very
//   precisely.
//
// Column order follows each statement's `SELECT` list, and every value is a string or null because
// `statements.ts` asks for `JSON_ARRAY`, where that is what the wire carries.

/** One row as the wire carries it: every column a string, or null. */
export type SampleRow = readonly (string | null)[];

/** How many rows each generator produces. Enough to carry the variation, small enough to be fast. */
const SAMPLE = 500;

/**
 * A generator per estate-scaled statement, keyed by file name without the extension.
 *
 * Keyed by file name so `scale.test.ts` can walk `config/statements` and fail on a statement that
 * declares an estate-scaled bound and has no fixture here. A statement nobody measured is how the
 * eight went unnoticed in the first place.
 */
export const SAMPLES: Readonly<Record<string, () => readonly SampleRow[]>> = {
  jobs_inventory: () =>
    rows((index) => [
      workspaceId(index),
      jobId(index),
      jobName(index),
      principal(index),
      pick(index, ['PERIODIC', 'ONE_TIME', 'FILE_ARRIVAL', 'CONTINUOUS', null]),
      pick(index, ['true', 'false', 'false', 'false']),
      pick(index, ['true', 'false']),
      // False when the trigger struct itself was never written — not the same as unscheduled.
      older(index) ? 'false' : 'true',
      // Documented as unpopulated for rows not rewritten since late 2025, so a real estate has nulls
      // here and the statement reports them as unknown rather than absent.
      older(index) ? null : pick(index, ['false', 'true']),
      older(index) ? null : pick(index, ['3600', '7200', '0', '86400']),
      older(index) ? null : pick(index, ['0', '1', '2']),
      older(index) ? null : pick(index, ['true', 'false']),
      // Read off `health_rules` regardless of whether the list itself is known: an unpopulated list
      // coalesces to empty, so this reports false rather than unknown for the same rows above.
      pick(index, ['false', 'false', 'true']),
      pick(index, ['0', '3', '7', '12']),
      pick(index, ['BUNDLE', null, null]),
      timestamp(index),
    ]),

  compute_cluster_inventory: () =>
    rows((index) => [
      workspaceId(index),
      clusterId(index),
      clusterName(index),
      pick(index, ['UI', 'API', 'JOB', 'JOB', 'PIPELINE']),
      pick(index, ['15.4.x-scala2.12', '14.3.x-cpu-ml-scala2.12', '13.3.x-scala2.12', '16.1.x-photon-scala2.12']),
      pick(index, ['SINGLE_USER', 'USER_ISOLATION', 'LEGACY_SINGLE_USER', 'NONE', null]),
      pick(index, ['true', 'false']),
      pick(index, ['true', 'false']),
      pick(index, ['30', '60', '0', '120', null]),
      pick(index, ['true', 'false']),
      pick(index, ['2', '8', '0', '16']),
      pick(index, ['2', '0', '4']),
      pick(index, ['8', '0', '16']),
      nodeType(index),
      nodeType(index + 1),
      pick(index, ['true', 'false', 'false', 'false']),
      pick(index, ['SPOT_WITH_FALLBACK_AZURE', 'ON_DEMAND', 'SPOT', 'PREEMPTIBLE_WITH_FALLBACK_GCP', null]),
      pick(index, ['0', '1', '2']),
      pick(index, ['0', '0', '1']),
      pick(index, ['true', 'false']),
      pick(index, ['0', '4', '9']),
      timestamp(index),
    ]),

  compute_warehouse_inventory: () =>
    rows((index) => [
      workspaceId(index),
      warehouseId(index),
      warehouseName(index),
      pick(index, ['PRO', 'CLASSIC', 'SERVERLESS']),
      pick(index, ['true', 'false']),
      pick(index, ['CHANNEL_NAME_CURRENT', 'CHANNEL_NAME_PREVIEW']),
      pick(index, ['X-Small', 'Small', 'Medium', 'Large', '2X-Large']),
      pick(index, ['1', '2']),
      pick(index, ['1', '4', '8']),
      pick(index, ['true', 'false']),
      pick(index, ['10', '45', '0', null]),
      pick(index, ['true', 'false']),
      pick(index, ['0', '2', '5']),
      timestamp(index),
    ]),

  lakeflow_pipeline_inventory: () =>
    rows((index) => [
      workspaceId(index),
      pipelineId(index),
      pipelineName(index),
      pick(index, ['WORKSPACE', 'DLT', 'MANAGED_INGESTION']),
      pick(index, ['true', 'false']),
      pick(index, ['true', 'false']),
      pick(index, ['true', 'false']),
      pick(index, ['ADVANCED', 'PRO', 'CORE']),
      pick(index, ['CURRENT', 'PREVIEW']),
      principal(index),
      pick(index, ['0', '2', '6']),
      pick(index, ['0', '14', '260', '1440']),
      pick(index, ['0', '0', '3']),
    ]),

  uc_catalog_inventory: () =>
    rows((index) => [catalogName(index), pick(index, ['12', '480', '3100', '27500']), pick(index, ['8', '400', '2900']), pick(index, ['2', '14', '90'])]),

  workspace_directory: () =>
    rows((index) => [
      workspaceId(index),
      workspaceName(index),
      workspaceUrl(index),
      pick(index, ['RUNNING', 'RUNNING', 'RUNNING', 'CANCELLING', 'PROVISIONING']),
      // Region as it appears in a SKU name, at the widths those actually run to, with the empty case
      // a classic-only workspace produces.
      pick(index, ['US_WEST_OREGON', 'US_EAST_N_VIRGINIA', 'EUROPE_IRELAND', 'AP_TOKYO', '']),
      pick(index, ['true', 'true', 'true', 'false']),
      timestamp(index),
    ]),

  serverless_job_readiness: () =>
    rows((index) => [
      workspaceId(index),
      jobId(index),
      pick(index, ['4', '120', '730', '2190']),
      pick(index, ['8', '240', '1460']),
      pick(index, ['0', '2', '18']),
      pick(index, ['92', '1840', '7200']),
      pick(index, ['46', '180', '320']),
      pick(index, ['400', '1600', '6900']),
      timestamp(index),
      pick(index, ['1', '3', '9']),
      pick(index, ['0', '1', '2']),
      pick(index, ['0', '1']),
      pick(index, ['1', '2', '6']),
      pick(index, ['0', '1']),
      pick(index, ['1', '2', '4']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1', '2']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['0', '1']),
      pick(index, ['13', '14', '15', null]),
      // The sampled cluster names, which the statement returns so a reader can recognise the compute.
      `${clusterName(index)},${clusterName(index + 1)},${clusterName(index + 2)}`,
      // And the sampled runtimes after them, which this fixture omitted until review caught it. The
      // statement takes up to three distinct `dbr_version` values; a job's clusters usually share one,
      // so one and two are weighted over three, and the empty string is a job with no classic use at
      // all. The conclusion does not depend on that weighting — even a single runtime string per row
      // puts this statement over the cap, which is what makes the omission a wrong answer rather than
      // an imprecise one.
      pick(index, [
        '15.4.x-scala2.12',
        '14.3.x-cpu-ml-scala2.12,15.4.x-scala2.12',
        '16.1.x-photon-scala2.12',
        '13.3.x-scala2.12,14.3.x-scala2.12,15.4.x-photon-scala2.12',
        '',
      ]),
    ]),

  serverless_job_spend: () =>
    rows((index) => [
      workspaceId(index),
      jobId(index),
      pick(index, ['12.44', '1840.09', '96.20', '23904.771']),
      pick(index, ['0.0', '412.88', '19.04']),
      pick(index, ['12.44', '1427.21', '77.16']),
      pick(index, ['3.4821', '480.1194', '12.0093']),
      pick(index, ['0', '0', '4']),
      'USD',
      pick(index, ['0.55', '0.7', null]),
      pick(index, ['eastus', 'westeurope', 'us-east-1', null]),
      'PREMIUM_ALL_PURPOSE_COMPUTE,PREMIUM_JOBS_COMPUTE,PREMIUM_JOBS_SERVERLESS_COMPUTE_US_EAST',
    ]),
};

function rows(build: (index: number) => SampleRow): readonly SampleRow[] {
  column = 0;
  return Array.from({ length: SAMPLE }, (_unused, index) => {
    column = 0;
    return build(index);
  });
}

/**
 * Which column `pick` is filling, so two columns with the same number of options do not move together.
 *
 * Reset per row by `rows`, and incremented by every `pick`, which works because a fixture builds its
 * columns in order inside one array literal. Fragile if a fixture ever picks conditionally, and the
 * alternative — a salt at all two hundred call sites — was worse.
 */
let column = 0;

/**
 * A value from a list, chosen by index and by which column is asking.
 *
 * Deterministic rather than random, so a measurement is reproducible and a failure is the same
 * failure on a rerun. Repeating an entry in the list weights it, which is how the samples keep the
 * common case common — most clusters are not GPU clusters, and a sample where a fifth of them are
 * would overstate the width of the node-type column.
 *
 * The column is mixed in because `index % values.length` alone made every column with the same number
 * of options identical. `compute_cluster_inventory` picks a source from five and an access mode from
 * five, so every `UI` cluster was `SINGLE_USER` and every `PIPELINE` one was null — and SCP-04-07,
 * which divides all-purpose clusters by whether their mode reaches Unity Catalog, had no cluster on
 * either wrong side of it to count. The payload measurement was unaffected, since each column still
 * saw every one of its values equally often and the byte total is a sum over the column; what it broke
 * was using these rows to check behaviour, which H1c needs. Found by cluster-census.test.ts.
 */
function pick<T>(index: number, values: readonly T[]): T {
  return values[mix(index, column++) % values.length];
}

/**
 * A cheap integer mixer, so consecutive columns decorrelate rather than shifting by a constant.
 *
 * Adding the column would still align any two columns an exact multiple of the list length apart.
 * This is the finaliser from MurmurHash3, which is enough for a fixture and has no dependency.
 */
function mix(index: number, salt: number): number {
  let hashed = (index + salt * 0x9e37_79b9) | 0;
  hashed = Math.imul(hashed ^ (hashed >>> 16), 0x85eb_ca6b);
  hashed = Math.imul(hashed ^ (hashed >>> 13), 0xc2b2_ae35);
  return ((hashed ^ (hashed >>> 16)) >>> 0) % 0x7fff_ffff;
}

/** Whether this row predates a column being written, which is where the nulls come from. */
function older(index: number): boolean {
  return index % 5 === 0;
}

function workspaceId(index: number): string {
  return String(2_247_000_000_000_000 + (index % 500) * 7_919);
}

function jobId(index: number): string {
  return String(400_000_000_000_000 + index * 8_675_309);
}

function clusterId(index: number): string {
  return `${timestampPrefix(index)}-${String(100_000 + (index % 899_999))}-${slug(index, 8)}`;
}

function warehouseId(index: number): string {
  return `${slug(index, 16)}`;
}

function pipelineId(index: number): string {
  return `${slug(index, 8)}-${slug(index + 1, 4)}-${slug(index + 2, 4)}-${slug(index + 3, 4)}-${slug(index + 4, 12)}`;
}

/**
 * A job name at the lengths an enterprise actually uses.
 *
 * The widest column in the row and therefore the one that decides the answer, so it varies from the
 * short names a small team writes to the fully-qualified generated ones a bundle deploys.
 */
function jobName(index: number): string {
  const domains = ['marketing_attribution', 'risk_exposure', 'claims_ingest', 'customer_360', 'inventory_position'];
  const layers = ['bronze', 'silver', 'gold', 'staging'];
  const cadence = ['hourly', 'daily', 'nightly', '15min'];
  switch (index % 4) {
    case 0:
      return `load_${pick(index, domains)}`;
    case 1:
      return `dbt_prod_${pick(index, cadence)}_incremental_${pick(index, domains)}_v${String((index % 9) + 1)}`;
    case 2:
      return `${pick(index, layers)}_${pick(index, domains)}_${pick(index, cadence)}`;
    default:
      return `[prod] ${pick(index, domains)} / ${pick(index, layers)} / orchestrated by platform-engineering`;
  }
}

function clusterName(index: number): string {
  switch (index % 3) {
    case 0:
      return `job-${jobId(index)}-run-${String(1_000_000 + index)}`;
    case 1:
      return `${principalLocal(index)}'s Cluster`;
    default:
      return `shared-analytics-${pick(index, ['emea', 'apac', 'namer'])}-${pick(index, ['prod', 'uat'])}`;
  }
}

function warehouseName(index: number): string {
  return `${pick(index, ['Finance', 'Marketing', 'Risk', 'Platform'])} ${pick(index, ['BI', 'Ad-hoc', 'Embedded'])} Warehouse ${String(index % 40)}`;
}

function pipelineName(index: number): string {
  return `${pick(index, ['ingest', 'cdc', 'scd2'])}_${pick(index, ['salesforce', 'workday', 'kafka_events', 'mainframe_extract'])}_${pick(index, ['bronze', 'silver'])}`;
}

function catalogName(index: number): string {
  return `${pick(index, ['prod', 'dev', 'uat'])}_${pick(index, ['finance', 'marketing', 'ops', 'risk'])}_${String(index % 90)}`;
}

function workspaceName(index: number): string {
  return `${pick(index, ['emea', 'apac', 'namer', 'latam'])}-${pick(index, ['prod', 'dev', 'sandbox'])}-${pick(index, ['analytics', 'platform', 'ml'])}-${String(index % 120)}`;
}

/**
 * A workspace's URL, in the four forms the three clouds actually issue.
 *
 * This was one form — the Azure one — which measured a plausible width and still misrepresented the
 * estate: the app runs on all three clouds, and a sample where every workspace is Azure invites the
 * next reader to assume the widest case is the only case. Widths measured from
 * `system.access.workspaces_latest` on an AWS account: the vanity form runs 41 to 56 characters, mean
 * 45.3 across ten workspaces, and the generated `dbc-` form is exactly 46 across five. The Azure form
 * is 51 and the documented GCP form 45, so mixing them moves the mean per row by about five bytes —
 * immaterial to the ceiling at 500 workspaces, which is the point of recording it rather than leaving
 * a reader to wonder whether the single form was load-bearing.
 */
function workspaceUrl(index: number): string {
  const host = pick(index, [
    // AWS, vanity: the form an account with named workspaces gets, and the widest of the four.
    `${workspaceName(index)}-${slug(index, 4)}.cloud.databricks.com`,
    // AWS, generated.
    `dbc-${slug(index, 8)}-${slug(index + 1, 4)}.cloud.databricks.com`,
    // Azure.
    `adb-${workspaceId(index)}.${String(index % 16)}.azuredatabricks.net`,
    // GCP.
    `${workspaceId(index)}.${String(index % 16)}.gcp.databricks.com`,
  ]);
  return `https://${host}`;
}

function nodeType(index: number): string {
  return pick(index, [
    'Standard_DS4_v2',
    'Standard_E8ds_v4',
    'i3.2xlarge',
    'm5d.4xlarge',
    'n2-standard-16',
    'Standard_NC6s_v3',
  ]);
}

function principal(index: number): string {
  return `${principalLocal(index)}@example-enterprise.com`;
}

function principalLocal(index: number): string {
  return `${pick(index, ['a.mccarthy', 'priya.raghunathan', 'svc-platform-prod', 'j.oyelaran'])}`;
}

function timestamp(index: number): string {
  const day = String((index % 28) + 1).padStart(2, '0');
  const hour = String(index % 24).padStart(2, '0');
  return `2026-0${String((index % 7) + 1)}-${day}T${hour}:41:07.482Z`;
}

function timestampPrefix(index: number): string {
  return `0${String((index % 7) + 1)}${String((index % 28) + 1).padStart(2, '0')}-${String(index % 24).padStart(2, '0')}4107`;
}

/** A hex-ish id fragment, deterministic and the right width. */
function slug(index: number, width: number): string {
  return (index * 2_654_435_761).toString(16).padStart(width, '0').slice(0, width);
}
