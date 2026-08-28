/** Types for measure-serving-readiness-sources.mjs, which is JavaScript so it can run from the CLI unbuilt. */

/** One probe: whether it ran, how long it took, and what it said if it did. */
export interface Probe {
  readonly label: string;
  readonly ok: boolean;
  readonly ms: number;
  readonly rows?: readonly Readonly<Record<string, string | null>>[];
  readonly error?: string;
}

/**
 * What a candidate source amounts to, in one word rather than a row count.
 *
 * The two failures are separate on purpose. `refused` is a grant saying no and bounds what this reading
 * covers; `unfinished` is the source still running when the poll budget ran out, which is a fact about the
 * source and the one thing a dimension most needs to know before it is designed around it.
 */
export type SourceVerdict = 'written' | 'empty' | 'unread' | 'refused' | 'unfinished';

/** One source's reading: whether it answers, how much it holds, and what it cost. */
export interface SourceReading {
  readonly verdict: SourceVerdict;
  readonly ms: number | null;
  readonly rows: number | null;
  readonly error?: string;
  readonly [field: string]: number | string | null | undefined;
}

/** One page of the Genie spaces walk, with what it cost and what it carried. */
export interface SpacePage {
  readonly page: number;
  readonly ms: number;
  /** Null where the request never reached a response — a socket closing rather than a refusal. */
  readonly status: number | null;
  readonly spaces?: number;
  readonly keys?: readonly string[];
  readonly error?: string;
}

/**
 * The three populations the shipped statements each call "the tables", read from those statements.
 *
 * Every share `45c` reports is a numerator over one of these, and a share taken over one presented beside a
 * share taken over another is `41b`'s defect with a plausible number on it. Each figure is the output of
 * the statement that scores the control named beside it rather than of a probe written by reading it —
 * the first pass did the latter and got one of the three populations wrong.
 */
export interface Denominators {
  /** `uc_asset_census.table_count`, scoring `DG-01-05`: every relation the catalogue lists. */
  readonly everyRelation: number | null;
  /** `uc_lineage_coverage.table_count`, scoring `DG-01-04`: `MANAGED` and `EXTERNAL` only. */
  readonly storedTables: number | null;
  /**
   * `uc_discovery_metadata.read_tables`, scoring `DG-01-06`: catalogued tables something read in the
   * window. A left join onto the census population, so a subset of `everyRelation` by construction.
   */
  readonly readTables: number | null;
  /** Distinct sources `access.table_lineage` names in the same window, which is a wider set. */
  readonly lineageNames: number | null;
  /** How much wider — relations lineage saw that the catalogue does not list, so no statement counts. */
  readonly readButNotCatalogued: number | null;
  readonly byType: {
    readonly views: number | null;
    readonly metricViews: number | null;
    readonly foreign: number | null;
    readonly pipelineOutputs: number | null;
  };
  /** One measure over three populations, stated as three figures rather than as one and a caveat. */
  readonly described: {
    readonly everyRelation: number | null;
    /** The one figure here no shipped statement reports, so taken from this script's own probe. */
    readonly storedTables: number | null;
    readonly readTables: number | null;
  };
}

export interface ServingReadinessSources {
  readonly runFinishedAt: string;
  /** The estate, which is also the recording's filename. */
  readonly profile: string;
  /** Where the numbers actually came from, which the profile alone does not establish. */
  readonly host: string;
  readonly warehouse: string;
  readonly lookbackDays: number;
  readonly denominators: Denominators;
  readonly sources: Readonly<Record<string, SourceReading>>;
  readonly semanticAssets: {
    readonly metricViews: number | null;
    readonly genieSpaces: {
      readonly walked: number | null;
      readonly complete: boolean;
      readonly pages: readonly SpacePage[];
      readonly fields: readonly string[] | null;
      readonly namesItsAssets: boolean | null;
      readonly lookedFor: readonly string[];
    };
  };
  readonly genieAttribution: {
    readonly columns: readonly string[] | null;
    readonly namesASpace: boolean | null;
    readonly namesAnAsset: boolean | null;
    readonly carriesFeedback: boolean | null;
    readonly lookedFor: {
      readonly space: readonly string[];
      readonly asset: readonly string[];
      readonly feedback: readonly string[];
    };
  };
  readonly cost: Readonly<Record<string, number>>;
  readonly probes: readonly Probe[];
}

export function customerCatalog(text: string): string;

export function probe(
  label: string,
  statement: string,
  parameters?: readonly { readonly name: string; readonly value: string; readonly type?: string }[]
): Promise<Probe>;

export function only(probes: readonly Probe[], label: string): Probe | null;

export function firstRow(probes: readonly Probe[], label: string): Readonly<Record<string, string | null>> | null;

export function count(row: Readonly<Record<string, string | null>> | null | undefined, key: string): number | null;

export function verdict(found: Probe | null, rows: number | null): SourceVerdict;

export function carries(fields: readonly string[] | null, names: readonly string[]): boolean | null;

export const ASSET_FIELDS: readonly string[];
export const SPACE_FIELDS: readonly string[];
export const ASSET_EVENT_FIELDS: readonly string[];
export const FEEDBACK_FIELDS: readonly string[];

export function walkSpaces(
  pages: number,
  pageSize: number
): Promise<{
  readonly walked: readonly SpacePage[];
  readonly complete: boolean;
  readonly spaces: number | null;
  readonly keys: readonly string[] | null;
}>;
