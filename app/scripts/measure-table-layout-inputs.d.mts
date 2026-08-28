/** Types for measure-table-layout-inputs.mjs, which is JavaScript so it can run from the CLI unbuilt. */

/** One probe: whether it ran, how long it took, and what it said if it did. */
export interface Probe {
  readonly label: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly rows?: readonly Readonly<Record<string, string | null>>[];
  readonly error?: string;
}

/** One table's layout, as `DESCRIBE DETAIL` reports it, or why it could not be read. */
export interface DescribedTable {
  readonly table: string;
  readonly sizeBytes?: number | null;
  readonly fileCount?: number | null;
  readonly partitionColumns?: readonly string[];
  readonly clusteringColumns?: readonly string[];
  /** `clusterByAuto`, which `PE-03-13` treats as clustered exactly as it treats an explicit column list. */
  readonly automaticClustering?: boolean;
  readonly error?: string;
}

/**
 * What an unbounded read of `system.storage.table_metrics_history` established.
 *
 * `verdict` is the field to read, and the five values are not degrees of the same thing:
 *
 * - `written` — rows exist, so the two rules that need it have an input here.
 * - `unwritten` — the read returned zero, and a sibling table in the same schema returned rows for the same
 *   principal in the same session, so the zero is the table rather than the grant.
 * - `empty-and-grant-unconfirmed` — the read returned zero and nothing else in the schema answered, which is
 *   the reading `33g` took and could not support.
 * - `refused` — the read raised. A coverage limit, and not a fact about the platform.
 * - `unread` — the read returned but carried no count, so there is nothing to conclude from either way.
 */
export interface MetricsTableReading {
  readonly verdict: 'written' | 'unwritten' | 'empty-and-grant-unconfirmed' | 'refused' | 'unread';
  readonly readable: boolean;
  /** Always false: the read carries no window, which is the whole point of re-taking it. */
  readonly bounded: boolean;
  readonly rows: number | null;
  readonly tables: number | null;
  /** Every relation `information_schema.tables` lists, views included: an upper bound on the population. */
  readonly cataloguedRelations: number | null;
  /** The `MANAGED` and `EXTERNAL` subset — what a per-table snapshot could have a row for. */
  readonly cataloguedStoredTables: number | null;
  readonly siblingRows: number | null;
  readonly listedInTheSchema: boolean | null;
}

/** One catalog's partitioned-table census, with the timing that says whether the bound was needed. */
export interface CatalogCensus {
  readonly catalog: string;
  readonly tables: number | null;
  readonly returned: boolean;
  readonly ms: number | null;
  readonly partitionedTables: number | null;
  readonly deepestPartitionIndex: number | null;
}

/**
 * What the shipped layout controls would see on this estate.
 *
 * Populations rather than verdicts. `PE-03-13` fails a partitioned table below 1 TiB, and `readFragmentation`
 * asks its question only of tables that could hold a target-sized file, so a zero in either count is a reason
 * the control reports not-applicable rather than a pass.
 *
 * `overPartitioned` and `compactable` are null, not zero, where the size they threshold against was never
 * read: a describe that refused is not a table of no bytes.
 */
export interface SampleReading {
  /** What the selection returned, at the app's `table_limit` of 200. */
  readonly selected: number | null;
  /** What was described, at the app's `sampleLimit` of 50 — the first of the selection, as the collector takes them. */
  readonly attempted: number;
  readonly eligible: number | null;
  readonly described: number;
  readonly failed: number;
  readonly partitioned: number;
  /** Described tables carrying a size, which is the population both thresholds below can be applied to. */
  readonly sized: number;
  readonly overPartitioned: number | null;
  readonly clustered: number;
  readonly compactable: number | null;
  readonly withSizeAndFileCount: number;
}

export interface TableLayoutInputs {
  readonly runFinishedAt: string;
  /** The estate, which is also the recording's filename. */
  readonly profile: string;
  /** Where the numbers actually came from, which the profile alone does not establish. */
  readonly host: string;
  /** Which warehouse ran the probes, because on a shared estate that is part of the apparatus. */
  readonly warehouse: string;
  readonly catalogLimit: number;
  readonly selectLimit: number;
  readonly describeLimit: number;
  readonly lookbackDays: number;
  readonly metricsTable: MetricsTableReading;
  readonly census: {
    readonly catalogsVisited: number | null;
    /** Relations in the visited catalogs, against `cataloguedRelations` — the share the census covered. */
    readonly relationsCovered: number | null;
    readonly perCatalog: readonly CatalogCensus[];
  };
  readonly sample: SampleReading;
  readonly described: readonly DescribedTable[];
  readonly probes: readonly Probe[];
}

export function customerCatalog(text: string): string;

export function probe(
  label: string,
  statement: string,
  parameters?: readonly { readonly name: string; readonly value: string; readonly type?: string }[]
): Promise<Probe>;

export function only(probes: readonly Probe[], label: string): Probe | null;

export function firstRow(
  probes: readonly Probe[],
  label: string
): Readonly<Record<string, string | null>> | null;

export function count(row: Readonly<Record<string, string | null>> | null | undefined, key: string): number | null;

export function metricsVerdict(
  readable: boolean,
  rows: number | null,
  siblingRows: number | null
): MetricsTableReading['verdict'];

export function describeDetail(parts: readonly string[]): Promise<DescribedTable>;
