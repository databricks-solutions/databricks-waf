/**
 * Types for the reading helpers measure-plan-rule-inputs.mjs exports, so its tests type-check.
 *
 * The script is JavaScript because it is a live measurement run by hand, like its siblings; the helpers are
 * exported because what they encode are the findings — that a rule reads a metric's value and not its label,
 * that a `meta_data` entry spells its content `value` or `values` depending on the key, that the graph
 * carries edges the extract drops — and a finding with no test is a comment.
 */

export interface PlanMetric {
  readonly label?: string;
  readonly value?: number;
  readonly key?: string;
}

/**
 * Both spellings, because which one a key uses is the finding. `value` for the scalar keys, `values` for the
 * expression-shaped ones; a reader that declares only the second reports the first as empty.
 */
export interface MetaEntry {
  readonly key?: string;
  readonly label?: string;
  readonly value?: string;
  readonly values?: readonly string[];
}

export interface PlanNode {
  readonly id?: string;
  readonly name?: string;
  readonly tag?: string;
  readonly meta_data?: readonly MetaEntry[];
  readonly metrics?: readonly PlanMetric[];
  readonly insight_ids?: readonly string[];
  readonly key_metrics?: {
    readonly duration_ms?: number;
    readonly rows_num?: number;
    readonly peak_memory_bytes?: number;
  } | null;
}

export interface PlanStage {
  readonly num_tasks?: number;
  readonly num_failed_tasks?: number;
  readonly disk_bytes_spilled?: number;
  readonly executor_run_time_ms?: number;
  readonly name?: string;
}

export interface PlanGraph {
  readonly nodes?: readonly PlanNode[];
  readonly edges?: readonly unknown[];
  readonly stage_data?: readonly PlanStage[];
}

export interface Inventory {
  readonly nodes: number;
  readonly tags: readonly string[];
  readonly tagCounts: Readonly<Record<string, number>>;
  readonly nodeFields: readonly string[];
  readonly metaKeys: readonly string[];
  readonly metaKeysWithValues: readonly string[];
  readonly metaKeysOutsideExtract: readonly string[];
  readonly metaSpelling: Readonly<Record<string, 'value' | 'values'>>;
  readonly metricLabels: readonly string[];
  readonly metricKeys: readonly string[];
  readonly edges: number;
  readonly stages: number;
  readonly stageFields: readonly string[];
  readonly stageTasks: readonly {
    readonly tasks: number | null;
    readonly failed: number | null;
    readonly spilledBytes: number | null;
    readonly runMs: number | null;
    readonly name: string | null;
  }[];
  readonly insightIds: readonly string[];
}

/**
 * The inventory as the recording holds it: the label vocabulary is written once at the top of the file, so
 * each plan keeps its count and not the list. Separate from `Inventory` because that is what the function
 * returns, and a reader of the file would otherwise be typed with a field the file does not have.
 */
export type RecordedInventory = Omit<Inventory, 'metricLabels'> & { readonly metricLabelCount: number };

export interface OperatorReading {
  readonly tag?: string;
  readonly name?: string;
  readonly meta?: Record<string, readonly string[]>;
  readonly metrics?: readonly PlanMetric[];
  readonly keyMetrics?: PlanNode['key_metrics'];
}

export interface Operators {
  readonly skew: readonly OperatorReading[];
  readonly joins: readonly OperatorReading[];
  readonly sorts: readonly OperatorReading[];
  readonly udfs: readonly OperatorReading[];
  readonly statistics: readonly OperatorReading[];
}

export interface Tells {
  readonly [rule: string]: { readonly matched: number; readonly samples: readonly string[] };
}

export function widestGraph(body: unknown): {
  readonly index: string | null;
  readonly graph: PlanGraph | null;
  readonly nodes: number;
  readonly unparsable: number;
  readonly candidates: number;
};
export function valuesOf(entry: MetaEntry | null | undefined): {
  readonly spelling: 'value' | 'values' | null;
  readonly values: readonly string[];
};
export function inventory(graph: PlanGraph | null): Inventory;
export function operators(graph: PlanGraph | null): Operators;
export function tells(graph: PlanGraph | null): Tells;
export function strings(graph: unknown): string[];
export function uncached(statement: string): string;
