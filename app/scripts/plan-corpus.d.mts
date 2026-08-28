/** Types for plan-corpus.mjs, which is JavaScript so it can run from the CLI unbuilt. */

export interface FixtureNode {
  readonly id?: string | number | null;
  readonly tag?: string | null;
  readonly metrics?: readonly { readonly label?: string | null; readonly value?: number | null }[];
  readonly meta_data?: readonly { readonly key?: string | null; readonly value?: unknown }[];
  readonly key_metrics?: Readonly<Record<string, number>>;
}

export interface FixtureEdge {
  readonly from_id?: string | number | null;
  readonly to_id?: string | number | null;
}

export interface FixtureGraph {
  readonly nodes?: readonly FixtureNode[];
  readonly edges?: readonly FixtureEdge[];
}

export interface WidestGraph {
  readonly graph: FixtureGraph;
  readonly nodes: number;
}

export interface ShapeRow extends Readonly<Record<string, unknown>> {
  readonly statement_id?: string | null;
}

export interface FoundPlan {
  readonly shape: ShapeRow;
  readonly response: { readonly status: number; readonly text: string };
  readonly widest: WidestGraph;
}

export const corpusSettings: {
  readonly profile: string;
  readonly host: string;
  readonly warehouse: string;
  readonly lookbackDays: number;
  readonly shapeLimit: number;
};


export function fetchText(path: string): Promise<{ readonly status: number; readonly text: string }>;

export function call(path: string, init?: RequestInit): Promise<Record<string, unknown>>;

export interface StatementParameter {
  readonly name: string;
  readonly value: string;
  readonly type?: string;
}

export function runStatement(
  statement: string,
  parameters?: readonly StatementParameter[],
  polls?: number
): Promise<readonly Readonly<Record<string, unknown>>[]>;

export function runShapes(): Promise<readonly ShapeRow[]>;

export function widestGraph(body: unknown): WidestGraph | null;

export function eachPlan(): Promise<{
  readonly shapes: readonly ShapeRow[];
  readonly found: readonly FoundPlan[];
  readonly skipped: Readonly<Record<string, number>>;
}>;
