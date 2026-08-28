/**
 * Types for the trimming helpers capture-plan-fixtures.mjs exports, so its tests type-check.
 *
 * The script is JavaScript because it is a live capture run by hand. The helpers are exported because what
 * they decide — which nodes a fixture keeps, which values are shortened, what is redacted — is what makes a
 * fixture stand for the response class its note claims, and `33ih` found the `meta_data` capping describing
 * itself wrongly with nothing to catch it.
 */

export interface MetaEntry {
  readonly key?: string;
  readonly label?: string;
  /** A scalar spelling. Mutually exclusive with `values`; which one a key uses is fixed per key. */
  readonly value?: unknown;
  /** A list spelling. Elements are strings in every capture, and typed loosely for the same reason. */
  readonly values?: unknown;
}

/** Counts of what was shortened, keyed by field, accumulated across every node in one capture. */
export type Capped = Record<string, number>;

export interface FixtureMetric {
  readonly label?: string;
  readonly value?: unknown;
}

export interface FixtureNode {
  readonly id?: string | number;
  readonly tag?: string;
  readonly meta_data?: readonly MetaEntry[];
  readonly metrics?: readonly FixtureMetric[];
  readonly expressions?: readonly unknown[];
}

export interface FixtureEdge {
  readonly from_id?: unknown;
  readonly to_id?: unknown;
}

export interface TrimmedOriginal {
  readonly graphEntries: number;
  readonly widestGraphKey: string;
  readonly widestGraphNodes: number;
  readonly distinctTags: readonly string[];
  readonly nodesKept: number;
  readonly edges: number;
  readonly edgesKept: number;
  readonly stageDataEntries: number;
  readonly cappedUnreadFields: Capped;
}

export const NAMED_METRICS: readonly string[];
export const PROMISED_META: readonly string[];
export function capEntry(entry: MetaEntry, capped: Capped): MetaEntry;
export function capUnread(node: FixtureNode, capped: Capped): FixtureNode;
export function trimNodes(nodes: readonly FixtureNode[]): FixtureNode[];
export function trimPlans(body: unknown): {
  readonly body: {
    readonly plans?: Record<string, { readonly nodes?: readonly FixtureNode[]; readonly edges?: readonly FixtureEdge[] }>;
  };
  readonly original: TrimmedOriginal | null;
};
export function redact(body: Record<string, unknown>): Record<string, unknown>;
