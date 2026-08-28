/**
 * Types for the reading helpers measure-plan-extract-additions.mjs exports, so its tests type-check.
 *
 * The script is JavaScript because it is a live measurement run by hand, like its siblings; the helpers are
 * exported because what they encode are the findings — what an edge's endpoints are named and whether they
 * resolve, which field `SORT_ORDER` spells its content in, and what each addition costs in bytes — and a
 * finding with no test is a comment.
 */

export interface EdgeResolution {
  readonly edgesCarryingBoth: number;
  readonly resolvedStrictly: number;
  readonly resolvedAfterCoercion: number;
}

export interface EdgeShape {
  readonly edges: number;
  readonly nodes: number;
  readonly fields: readonly string[];
  readonly fieldTypes: Readonly<Record<string, readonly string[]>>;
  readonly nodeIdTypes: readonly string[];
  readonly nodeIdsUnique: boolean;
  readonly resolution: Readonly<Record<string, EdgeResolution>>;
  readonly sample: readonly unknown[];
}

export interface MetaKeyShape {
  readonly spellings: readonly string[];
  readonly tags: readonly (string | undefined)[];
  readonly operators: number;
  readonly entries: number;
  readonly samples: readonly string[];
}

export interface NamedMetric {
  readonly carried: number;
  readonly nonZero: number;
  readonly keys: readonly (string | null)[];
  readonly samples: readonly { readonly tag?: string; readonly value?: unknown }[];
}

export interface Addition {
  readonly bytes: number;
  readonly addedBytes: number;
  readonly addedPercent: number;
}

export interface Cost {
  readonly responseBytes: number;
  readonly baselineBytes: number;
  readonly responseOverBaseline: number;
  readonly added: Readonly<Record<'edges' | 'sortOrder' | 'namedMetrics' | 'all', Addition>>;
}

export interface Metric {
  readonly label?: string;
  readonly value?: number;
  readonly key?: string;
}

export interface MetaEntry {
  readonly key?: string;
  readonly label?: string;
  readonly value?: string;
  readonly values?: readonly string[];
}

export interface Node {
  readonly id?: string | number;
  readonly tag?: string;
  readonly meta_data?: readonly MetaEntry[];
  readonly metrics?: readonly Metric[];
  readonly key_metrics?: {
    readonly duration_ms?: number;
    readonly rows_num?: number;
    readonly peak_memory_bytes?: number;
  } | null;
}

export interface Graph {
  readonly nodes?: readonly Node[];
  readonly edges?: readonly Readonly<Record<string, unknown>>[];
}

export interface Additions {
  readonly edges?: boolean;
  readonly sortOrder?: boolean;
  readonly metrics?: readonly string[];
}

export function widestGraph(body: unknown): {
  readonly index: string | null;
  readonly graph: Graph | null;
  readonly nodes: number;
};
export function edgeShape(graph: Graph | null): EdgeShape;
export function endpointNames(shape: EdgeShape): string | null;
export function aroundSorts(
  graph: Graph | null,
  pair: string | null,
  hops?: number,
): readonly {
  readonly id: string;
  readonly tag?: string;
  readonly alongTo: readonly string[];
  readonly alongFrom: readonly string[];
}[];
export function metaShape(graph: Graph | null, pattern: RegExp): Readonly<Record<string, MetaKeyShape>>;
export function namedMetrics(graph: Graph | null, labels: readonly string[]): Readonly<Record<string, NamedMetric>>;
export function extractLike(graph: Graph | null, additions?: Additions): Readonly<Record<string, unknown>>;
export function costOf(graph: Graph | null, responseBytes: number, labels?: readonly string[]): Cost;
export function uncached(statement: string): string;
