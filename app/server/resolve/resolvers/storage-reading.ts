// Where table sizes and file counts come from, and what a reading is worth.
//
// Two controls need the same two numbers — bytes and files — and there are two places to
// get them. `system.storage.table_metrics_history` carries them for every table in the
// metastore, which would be the whole answer, except that it is undocumented and has held
// no rows anywhere this has run. The tier-2 `DESCRIBE DETAIL` pass carries them for a
// bounded sample, at a cost per table.
//
// Reading only the snapshot leaves both controls permanently unmeasured on every estate
// where it is empty, while the numbers sit collected in the sample. Reading only the
// sample throws away a complete measurement on the day the snapshot populates. So both are
// read, the complete source is preferred, and the reading says which one answered — because
// the difference changes what the finding may claim. A total from the snapshot is the
// estate's total; a total from a sample is a floor.
//
// Kept out of both resolvers because the fallback rule and the wording of its caveat are
// the part that would drift if written twice, and a drifted caveat is worse than none: two
// findings from the same sample describing their coverage differently reads as one of them
// being wrong.

import type { SignalId } from '../../collect/signal.js';
import type { StorageMetrics, TableDetails } from '../../collect/sql/shapes.js';
import type { Evidence } from '../finding.js';
import { bytes, evidenceFrom, observedValue, type Observation } from './helpers.js';

export const SNAPSHOT: SignalId = 'sql:storage.table_metrics';
export const SAMPLE: SignalId = 'describe:storage.table_details';

/** Both sources, for a resolver's `requires`, so whichever answers has been collected. */
export const STORAGE_SIGNALS: readonly SignalId[] = [SNAPSHOT, SAMPLE];

export interface StorageReading {
  /** Which signal answered, so evidence is attributed to what was actually read. */
  readonly signal: SignalId;
  readonly complete: boolean;
  readonly totalBytes: number;
  readonly files: number;
  readonly tables: number;
  /** Undefined when nothing holds a file, which is not the same as a zero average. */
  readonly averageFileBytes?: number;
  readonly largest: readonly { readonly name: string; readonly sizeBytes: number }[];
  /** How the reading was obtained and what it therefore does not cover. */
  readonly basis: string;
}

/**
 * The best available reading of stored bytes and file counts, or undefined if neither
 * source could be read.
 *
 * Soft-reads both signals rather than requiring either, so an empty snapshot degrades the
 * claim rather than withdrawing the control. Both are still declared in `requires` by the
 * resolvers that call this, so "neither could be read" means neither answered, never that
 * nobody asked.
 */
export function readStorage(context: Observation): StorageReading | undefined {
  return fromSnapshot(context) ?? fromSample(context);
}

/**
 * Why there is no reading, in the terms of both sources.
 *
 * Composed from the collectors' own reasons rather than restated here. A control that
 * cannot be measured because a permission was denied and one that cannot be measured
 * because a preview table is empty need different actions from the reader, and a single
 * generic sentence covering both would prompt neither.
 */
export function storageUnreadable(context: Observation): string {
  const reasons = STORAGE_SIGNALS.map((signal) => {
    const result = context.signals.get(signal);
    if (result == null) return `${label(signal)} was not collected in this scan`;
    if (result.status === 'unmeasurable') {
      return `${label(signal)} could not be read: ${result.unmeasurableReason ?? 'no reason was recorded'}`;
    }
    return `${label(signal)} returned no tables`;
  });

  return `Table sizes and file counts have two possible sources and neither answered. ${reasons.join('. ')}.`;
}

function fromSnapshot(context: Observation): StorageReading | undefined {
  const metrics = observedValue<StorageMetrics>(context, SNAPSHOT);
  // `snapshotAvailable` is false when the table exists but holds no rows for this
  // metastore. The collector already reports that as unmeasurable, so this is the belt to
  // that braces: if the rule ever moves, an empty snapshot must not become an estate of
  // zero bytes here.
  if (metrics == null || !metrics.snapshotAvailable) return undefined;

  const asOf = metrics.snapshotDate?.toISOString().slice(0, 10);
  return {
    signal: SNAPSHOT,
    complete: true,
    totalBytes: metrics.activeBytes,
    files: metrics.activeFiles,
    tables: metrics.tableCount,
    ...average(metrics.activeBytes, metrics.activeFiles),
    largest: metrics.largest.map((table) => ({
      name: `${table.catalog}.${table.schema}.${table.table}`,
      sizeBytes: table.activeBytes,
    })),
    basis:
      `Measured across all ${metrics.tableCount.toLocaleString('en-US')} tables in the metastore from the ` +
      `platform's per-table storage snapshot` +
      (asOf != null ? `, as of ${asOf}` : ''),
  };
}

function fromSample(context: Observation): StorageReading | undefined {
  const details = observedValue<TableDetails>(context, SAMPLE);
  if (details == null || details.tables.length === 0) return undefined;

  const totalBytes = details.tables.reduce((sum, table) => sum + table.sizeBytes, 0);
  const files = details.tables.reduce((sum, table) => sum + table.fileCount, 0);
  const complete = details.tables.length >= details.eligibleTables;

  return {
    signal: SAMPLE,
    complete,
    totalBytes,
    files,
    tables: details.tables.length,
    ...average(totalBytes, files),
    largest: [...details.tables]
      .sort((left, right) => right.sizeBytes - left.sizeBytes)
      .slice(0, 3)
      .map((table) => ({ name: `${table.catalog}.${table.schema}.${table.table}`, sizeBytes: table.sizeBytes })),
    basis: complete
      ? `Measured across all ${details.tables.length.toLocaleString('en-US')} eligible tables by reading each ` +
        `table's Delta log`
      : `Measured across ${details.tables.length.toLocaleString('en-US')} of ` +
        `${details.eligibleTables.toLocaleString('en-US')} eligible tables by reading each table's Delta log, so ` +
        `the total is a floor for the estate rather than its size. The platform's per-table storage snapshot, ` +
        `which would cover every table, has no rows for this metastore`,
  };
}

/**
 * Whether small files are a problem, which is not the same as whether files are small.
 *
 * The estate-wide average is the wrong test on its own, and reporting it as one produced a
 * live false positive: an estate of eleven tables totalling 678 KiB was told its 26 KiB
 * files were costing it scan performance, and advised to enable a predictive optimization
 * that was already on. A 605 KiB table cannot hold a 16 MiB file. Compaction has nothing to
 * do there, and a control that says otherwise is asking for work that cannot be done.
 *
 * So the question is asked only of tables big enough for it to have an answer — those
 * holding at least one target-sized file — and when none qualify, the answer is that the
 * control does not apply rather than that the estate is fragmented.
 *
 * Only the sample can support that, since it carries per-table sizes. The snapshot carries
 * estate aggregates, so it can offer the average with its limitation stated and nothing
 * more; the per-table figures it would need are in the tier that lists files.
 */
export type Fragmentation =
  | { readonly kind: 'no-population'; readonly signal: SignalId; readonly reason: string }
  | {
      readonly kind: 'per-table';
      readonly signal: SignalId;
      readonly fragmented: readonly { readonly name: string; readonly averageFileBytes: number }[];
      readonly compactable: number;
    }
  | { readonly kind: 'estate-average'; readonly signal: SignalId; readonly averageFileBytes: number };

export function readFragmentation(context: Observation, minAverage: number): Fragmentation | undefined {
  const details = observedValue<TableDetails>(context, SAMPLE);
  if (details != null && details.tables.length > 0) {
    // A table with no files has nothing to compact; a table smaller than one target file
    // cannot reach the target however it is written.
    const compactable = details.tables.filter((table) => table.fileCount > 0 && table.sizeBytes >= minAverage);
    if (compactable.length === 0) {
      return {
        kind: 'no-population',
        signal: SAMPLE,
        reason:
          `None of the ${details.tables.length.toLocaleString('en-US')} tables measured holds as much as one ` +
          `${bytes(minAverage)} file, so none of them can be compacted to that size. File counts at these ` +
          'sizes are not a performance question.',
      };
    }

    return {
      kind: 'per-table',
      signal: SAMPLE,
      compactable: compactable.length,
      fragmented: compactable
        .map((table) => ({
          name: `${table.catalog}.${table.schema}.${table.table}`,
          averageFileBytes: table.sizeBytes / table.fileCount,
        }))
        .filter((table) => table.averageFileBytes < minAverage)
        .sort((left, right) => left.averageFileBytes - right.averageFileBytes),
    };
  }

  const reading = fromSnapshot(context);
  if (reading?.averageFileBytes == null) return undefined;
  return { kind: 'estate-average', signal: SNAPSHOT, averageFileBytes: reading.averageFileBytes };
}

/** The wording every finding built from the estate average has to carry. */
export const ESTATE_AVERAGE_CAVEAT =
  'This is one average across the metastore, so it does not separate tables that are too small to ' +
  'compact from tables that are fragmented, and a few large well-written tables can hide many small ones.';

/**
 * The share of compactable tables that are well sized, or undefined if the question does
 * not apply.
 *
 * A share rather than a count because one fragmented table in four hundred and four hundred
 * in four hundred are not the same finding, and a control that reported them alike would be
 * ignored by the estate that has one.
 */
export function compactedShare(fragmentation: Fragmentation | undefined): number | undefined {
  if (fragmentation == null || fragmentation.kind === 'no-population') return undefined;
  if (fragmentation.kind === 'estate-average') return undefined;
  return (fragmentation.compactable - fragmentation.fragmented.length) / fragmentation.compactable;
}

/** Whether the estate average, where that is all there is, sits below the target. */
export function averageBelowTarget(fragmentation: Fragmentation | undefined, minAverage: number): boolean {
  return fragmentation?.kind === 'estate-average' && fragmentation.averageFileBytes < minAverage;
}

export function fragmentationEvidence(
  context: Observation,
  fragmentation: Fragmentation,
  minAverage: number
): Evidence {
  const expected = `Tables large enough to compact hold files averaging at least ${bytes(minAverage)}`;

  if (fragmentation.kind === 'no-population') {
    return evidenceFrom(context, fragmentation.signal, fragmentation.reason, expected);
  }

  if (fragmentation.kind === 'estate-average') {
    return evidenceFrom(
      context,
      fragmentation.signal,
      `Active files average ${bytes(fragmentation.averageFileBytes)} across the metastore`,
      expected
    );
  }

  const worst = fragmentation.fragmented
    .slice(0, 3)
    .map((table) => `${table.name} at ${bytes(table.averageFileBytes)}`)
    .join('; ');

  return evidenceFrom(
    context,
    fragmentation.signal,
    `${fragmentation.compactable - fragmentation.fragmented.length} of ${fragmentation.compactable} tables large ` +
      `enough to compact hold files averaging at least ${bytes(minAverage)}` +
      (worst === '' ? '' : `; smallest average: ${worst}`),
    expected
  );
}

/**
 * How the total may be described, given what it covers.
 *
 * A sampled sum is a floor and a complete sum is a size, and the difference is not
 * decoration: "1.2 TiB" from half the tables invites a capacity decision the number does
 * not support.
 */
export function describeTotal(reading: StorageReading): string {
  const total = bytes(reading.totalBytes);
  const tables = `${reading.tables.toLocaleString('en-US')} table${reading.tables === 1 ? '' : 's'}`;
  const files = `${reading.files.toLocaleString('en-US')} file${reading.files === 1 ? '' : 's'}`;
  return reading.complete
    ? `${total} of active data across ${tables} in ${files}`
    : `At least ${total} of active data, across the ${tables} measured, in ${files}`;
}

function average(totalBytes: number, files: number): { readonly averageFileBytes?: number } {
  return files > 0 ? { averageFileBytes: totalBytes / files } : {};
}

function label(signal: SignalId): string {
  return signal === SNAPSHOT
    ? "the platform's per-table storage snapshot (system.storage.table_metrics_history)"
    : 'the per-table DESCRIBE DETAIL pass';
}
