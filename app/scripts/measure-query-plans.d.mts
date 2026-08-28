/**
 * Types for the parsing helpers measure-query-plans.mjs exports, so its tests type-check.
 *
 * The script is JavaScript because it is a live measurement run by hand, like its siblings; the helpers are
 * exported because what they encode — which graph carries the plan, what the fingerprint covers, how absence
 * is spelled — are the findings, and a finding with no test is a comment.
 */

export interface PlanNode {
  readonly id?: string;
  readonly name?: string;
  readonly tag?: string;
  /**
   * An entry holds one spelling or the other, fixed per key: a scalar in `value`, a list in `values`. This
   * said only `values` until `33ih`, and both this script and the parser read only that field, so five of the
   * six keys the extract promises were stored empty on every plan either of them read.
   */
  readonly meta_data?: readonly {
    readonly key?: string;
    readonly value?: string;
    readonly values?: readonly string[];
  }[];
  /** Nullable as well as optional: the response spells "no metric" three ways and a rule must not care. */
  readonly key_metrics?: {
    readonly duration_ms?: number;
    readonly rows_num?: number;
    readonly peak_memory_bytes?: number;
  } | null;
}

export interface PlanGraph {
  readonly nodes?: readonly PlanNode[];
  readonly edges?: readonly unknown[];
  readonly source?: string;
}

export interface ChosenGraph {
  readonly index: string | null;
  readonly graph: PlanGraph | null;
  readonly nodes: number;
}

export interface MetricPresence {
  readonly operators: number;
  readonly absent: number;
  readonly allZero: number;
  readonly measured: number;
}

export interface ExtractedNode {
  readonly id?: string;
  readonly tag?: string;
  readonly meta?: Record<string, readonly string[]>;
  readonly key_metrics?: PlanNode['key_metrics'];
}

export function widestGraph(body: unknown): ChosenGraph;
export function planFingerprint(graph: PlanGraph | null): string;
export function extract(graph: PlanGraph | null): ExtractedNode[];
export function metricPresence(graph: PlanGraph | null): MetricPresence;
