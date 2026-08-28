/** Types for measure-stats-signal.mjs, which is JavaScript so it can run from the CLI unbuilt. */

import type { FixtureGraph, FixtureNode } from './plan-corpus.d.mts';

export interface ScanReading {
  readonly identifier: string;
  readonly parts: number;
  readonly tag: string | null;
}

export interface DescribeReading {
  readonly table: string;
  readonly rows?: number;
  readonly statistics?: string | null;
  readonly metadata?: Readonly<Record<string, string>>;
  readonly error?: string;
}

export interface ProbeReading {
  readonly label: string;
  readonly ok: boolean;
  readonly rows?: readonly Readonly<Record<string, unknown>>[];
  readonly error?: string;
}

/**
 * A count that is `null` where the ANALYZE history did not read.
 *
 * An unread history and an empty one produce the same set of analysed tables, and every count derived from it reads at
 * its most alarming when nothing was read. So the absence is in the type.
 */
export type AgainstHistory<T> = T | null;

export function metaValues(node: FixtureNode | undefined, key: string): readonly string[];

export function scansIn(graph: FixtureGraph | undefined): readonly ScanReading[];

export function describe(table: string): Promise<DescribeReading>;

export function probe(label: string, statement: string): Promise<ProbeReading>;
