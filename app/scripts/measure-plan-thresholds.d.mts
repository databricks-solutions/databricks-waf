/** Types for measure-plan-thresholds.mjs, which is JavaScript so it can run from the CLI unbuilt. */

import type { FixtureEdge, FixtureNode } from './plan-corpus.d.mts';

export type ExchangeGroup = 'mapStage' | 'sink' | 'queryStage' | 'reused' | 'otherExchange';

export type ExchangeReading = 'tags' | 'pairs' | 'mapStages' | 'stages';

export interface ExchangeReadings {
  readonly counts: Readonly<Record<ExchangeGroup, number>>;
  readonly readings: Readonly<Record<ExchangeReading, number>>;
  readonly mapStagesEqualSinks: boolean;
}

export interface Spread {
  readonly n: number;
  readonly min: number;
  readonly p50: number;
  readonly p90: number;
  readonly p99: number;
  readonly max: number;
  readonly atOrAboveEight: number;
}

export interface SortReading {
  readonly tag: string;
  readonly downstreamOperators: number;
  readonly limited: boolean;
  readonly rows: number | null;
  readonly peakMemoryBytes: number | null;
  readonly durationMs: number | null;
  readonly spilledBytes: number | null;
}

export interface DirectionCheck {
  readonly scans: number;
  readonly sorts: number;
  readonly scanReachesAlongFrom: number | null;
  readonly sortReachesAlongFrom: number | null;
  readonly scanReachesAlongTo: number | null;
  readonly sortReachesAlongTo: number | null;
}

// Declared once, in the module that owns the corpus walk. `33ifb` moved the reader there and left the
// re-export here, so the shapes a caller of either sees cannot drift apart.
export type { FixtureEdge, FixtureNode, WidestGraph } from './plan-corpus.d.mts';

export { widestGraph } from './plan-corpus.d.mts';

export function exchangeReadings(tags: readonly string[]): ExchangeReadings;

export function sortsWithoutLimit(
  nodes: readonly FixtureNode[],
  edges: readonly FixtureEdge[] | undefined,
): readonly SortReading[];

export interface MetricReading {
  readonly max: number;
  readonly operators: number;
  readonly nonZero: number;
}

export function metricsByLabel(nodes: readonly FixtureNode[]): ReadonlyMap<string, MetricReading>;

export function tagsById(nodes: readonly FixtureNode[]): {
  readonly tagOf: ReadonlyMap<string, string>;
  readonly nodesWithoutAnId: number;
};

export function directionCheck(
  nodes: readonly FixtureNode[],
  edges: readonly FixtureEdge[] | undefined,
): DirectionCheck;

export function distribution(values: readonly number[]): Spread | null;
