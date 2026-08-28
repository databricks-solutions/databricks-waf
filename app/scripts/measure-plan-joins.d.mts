/** Types for measure-plan-joins.mjs, which is JavaScript so it can run from the CLI unbuilt. */

import type { FixtureEdge, FixtureNode } from './plan-corpus.d.mts';

export interface JoinInput {
  readonly tag: string;
  readonly rows: number | null;
  readonly peakMemoryBytes: number | null;
  readonly sizeLabels: readonly string[];
}

export interface JoinReading {
  readonly tag: string;
  readonly algorithm: readonly string[];
  readonly buildSide: readonly string[];
  readonly sizes: Readonly<Record<string, number>>;
  readonly rows: number | null;
  readonly inputs: readonly JoinInput[];
  readonly producersFound: number;
}

/** A count and the population it came out of, so no share is reported without its base. */
export interface OutOf {
  readonly of: number;
  readonly matching: number;
}

export interface Distinctly {
  readonly values: readonly string[];
  readonly withNone: number;
  readonly withMoreThanOne: number;
}

export interface JoinReadings {
  readonly joins: number;
  readonly algorithms: Distinctly;
  readonly buildSides: Distinctly;
  readonly joinTagsSeen: readonly string[];
  readonly broadcastJoins: number;
  readonly otherJoins: number;
  readonly sizeOnBroadcasts: Readonly<Record<string, OutOf>>;
  readonly sizeOnOtherJoins: Readonly<Record<string, OutOf>>;
  readonly anySizeOnOtherJoins: OutOf;
  readonly sizeValues: Readonly<Record<string, readonly number[]>>;
  readonly producers: {
    readonly joinsWhereTheWalkArrived: OutOf;
    readonly joinsWithTwoProducers: OutOf;
    readonly producerTags: readonly string[];
    readonly producerSizeLabels: readonly string[];
    readonly inputsWithRows: OutOf;
  };
}

export function metaValues(node: FixtureNode | undefined, key: string): readonly string[];

export function metricsOf(node: FixtureNode | undefined): Readonly<Record<string, number>>;

export function joinsIn(
  nodes: readonly FixtureNode[],
  edges: readonly FixtureEdge[] | undefined,
): readonly JoinReading[];

export function isBroadcast(join: Pick<JoinReading, 'algorithm'>): boolean;

export function distinctly(lists: readonly (readonly string[])[]): Distinctly;

export function readings(joins: readonly JoinReading[]): JoinReadings;
