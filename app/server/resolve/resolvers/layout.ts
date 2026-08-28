// Table layout resolvers, from the per-table pass.
//
// Every control here reads `describe:storage.table_details`, which covers a sample rather
// than the estate. That asymmetry is load-bearing and is applied deliberately below: a
// table found badly laid out is badly laid out, so a failure in the sample is a real
// failure. A sample where nothing was found wrong is not evidence that nothing is wrong,
// so the pass says what it covered.
//
// The thresholds are the WAF's own published numbers rather than ones this project chose:
// do not partition tables below 1TB, and only partition by a column where each partition
// will hold at least 1GB. Quoted at the anchor these controls carry.

import type { ControlResolver } from '../resolver.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import { agreeing, bandOutcome, bandsOf, bytes, evidenceFrom, fromSignal, percent, threshold } from './helpers.js';
import { DETAILS, activelyRead, describedNothing, nameOf, someOf } from './table-details.js';

/** 1 TiB. The docs say "1TB"; the binary reading is the larger, so it flags fewer tables. */
const MIN_PARTITION_TABLE_BYTES = 1024 ** 4;

/**
 * Whether a table holds enough for how it is partitioned to be a question about reads.
 *
 * Not a second size band, and the distinction is the whole point. A partitioned table holding a
 * few kilobytes across a few files *is* over-partitioned, is cheap to fix, and fails below with
 * its size in the finding. This excludes only the case beneath that: a table holding nothing has
 * no partitions of any size, so whether its partitioning is too fine is not a question about
 * performance at all.
 *
 * Measured on `large-estate` 2026-08-12, recorded in [`E1g`](../../../../docs/plan/e1-populations.md):
 * of the nine tables the sample could describe there, the one partitioned table held 0 bytes in 0
 * files — and the control told the owner of a table drawing 15,558 reads in thirty days that its
 * file layout was slowing every one of them. `readFragmentation` already had this guard, in the
 * same pass over the same sample, for the same reason.
 */
function laidOut(table: TableDetail): boolean {
  return table.fileCount > 0 && table.sizeBytes > 0;
}

/** A table, its size and its file count, which is what lets a reader check the judgement. */
function locate(table: TableDetail): string {
  return `${nameOf(table)} at ${bytes(table.sizeBytes)} across ${agreeing(table.fileCount, 'file').noun}`;
}

/**
 * PE-03-13: over-partitioning.
 *
 * Directly measurable in one direction and not the other, and the finding says which.
 * A partitioned table below the size floor is over-partitioned by the documented rule —
 * that needs no interpretation. Whether each partition clears 1GB needs partition
 * cardinality, which `DESCRIBE DETAIL` does not carry and which would cost a
 * `count(DISTINCT …)` per table to obtain. Rather than approximate it and present the
 * approximation as a measurement, this reports the half it can prove and names the half
 * it cannot.
 *
 * Liquid clustering counts in a table's favour. The same page recommends it *instead of*
 * partitioning for new Delta tables, so a clustered table is following the guidance, not
 * evading the check.
 */
const overPartitioning = fromSignal<TableDetails>(DETAILS, ['PE-03-13'], (details, context) => {
  const empty = describedNothing(details);
  if (empty != null) return empty;

  const floor = threshold(context.spec, 'min_bytes_before_partitioning', MIN_PARTITION_TABLE_BYTES);
  const partitioned = details.tables.filter((table) => table.partitionColumns.length > 0);
  const judged = partitioned.filter(laidOut);
  const holdNothing = partitioned.filter((table) => !laidOut(table));
  const offenders = judged.filter((table) => table.sizeBytes < floor);
  const clustered = details.tables.filter((table) => table.clusteringColumns.length > 0 || table.automaticClustering);

  const covered = `${details.tables.length.toLocaleString('en-US')} of ${details.eligibleTables.toLocaleString('en-US')} Delta tables`;
  const expected = `Tables below ${bytes(floor)} are not partitioned`;

  // Partitioned tables were found and every one of them is empty, so the sample carries no table
  // this rule can be asked about. Not a pass: crediting it would credit an absence, which is
  // ADR 0074. The population that stays out of the denominator here is one the scan established
  // rather than one it failed to see — these tables were described, and what they hold is 0.
  if (partitioned.length > 0 && judged.length === 0) {
    const { noun, verb } = agreeing(partitioned.length, 'partitioned table');
    return {
      outcome: 'not-applicable',
      evidence: [
        evidenceFrom(context, DETAILS, `${noun} among the ${covered} examined ${verb} no data to lay out: ${someOf(holdNothing, 3, locate)}`, expected),
      ],
      outcomeReason:
        'Partitioning is too fine when its partitions are too small to skip past, and a table holding no data ' +
        `has no partitions of any size — so this sample holds no table the rule can judge, rather than a ` +
        'sample that satisfies it. It covers the most-read tables rather than the whole estate, so it is also ' +
        'not a statement that no over-partitioned table exists.',
    };
  }

  if (offenders.length === 0) {
    const { noun, verb } = agreeing(judged.length, 'partitioned table');
    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          DETAILS,
          judged.length === 0
            ? `None of the ${covered} examined are partitioned`
            : `${noun} among the ${covered} examined ${verb} at least ${bytes(floor)} of data`,
          expected
        ),
        ...(holdNothing.length > 0
          ? [
              evidenceFrom(
                context,
                DETAILS,
                `Left out of that: ${agreeing(holdNothing.length, 'partitioned table').noun} holding no data, whose ` +
                  `partitioning is not a question about reads — ${someOf(holdNothing, 3, locate)}`
              ),
            ]
          : []),
        ...(clustered.length > 0
          ? [
              evidenceFrom(
                context,
                DETAILS,
                `${clustered.length.toLocaleString('en-US')} tables use liquid clustering`,
                'Liquid clustering is used in preference to partitioning on new Delta tables'
              ),
            ]
          : []),
      ],
      outcomeReason:
        `No over-partitioned table was found among the ${covered} examined. This covers the most-read tables ` +
        'rather than the whole estate, so it is not a statement that none exists. The per-partition size rule ' +
        'is also not tested: that needs partition cardinality, which the per-table describe does not return.',
    };
  }

  const { noun, verb } = agreeing(offenders.length, 'partitioned table');
  return {
    outcome: 'fail',
    evidence: [
      evidenceFrom(context, DETAILS, `${noun} ${verb} less than ${bytes(floor)} of data: ${someOf(offenders, 3, locate)}`, expected),
    ],
    outcomeReason:
      `Partitioning a table below ${bytes(floor)} splits it into partitions too small to skip usefully, and ` +
      'the small files that result slow every read. These were found in a sample of the most-read tables, so ' +
      'there may be more.',
  };
});

/**
 * PE-03-16: deletion vectors.
 *
 * Read from the table's Delta features rather than from its properties, because the
 * feature is what the reader and writer actually honour — a property set on a table
 * whose protocol was never upgraded does nothing.
 *
 * Scored against read activity rather than across every table. Deletion vectors change
 * the cost of row-level modification, so on a table nobody touches they change nothing,
 * and marking down an estate for not enabling them everywhere would be advice to churn
 * table protocols for no gain. The caveat is real: enabling them raises the minimum
 * reader version.
 */
const deletionVectors = fromSignal<TableDetails>(DETAILS, ['PE-03-16'], (details, context) => {
  const empty = describedNothing(details);
  if (empty != null) return empty;

  const active = details.tables.filter((table) => table.readEvents > 0);
  const population = active.length > 0 ? active : details.tables;
  const enabled = population.filter((table) => table.features.some((feature) => feature.toLowerCase() === 'deletionvectors'));
  const share = population.length === 0 ? 0 : enabled.length / population.length;
  const passShare = threshold(context.spec, 'pass_share', 0.8);
  const partialShare = threshold(context.spec, 'partial_share', 0.4);

  const scope = active.length > 0 ? `${String(active.length)} tables read in the window` : `${String(details.tables.length)} tables examined`;

  return {
    outcome: share >= passShare ? 'pass' : share >= partialShare ? 'partial' : 'fail',
    evidence: [
      evidenceFrom(
        context,
        DETAILS,
        `${String(enabled.length)} of ${scope} have deletion vectors enabled`,
        `At least ${String(Math.round(passShare * 100))}% of actively read tables mark deleted rows rather than rewriting files`
      ),
    ],
    ...(share >= passShare
      ? {}
      : {
          outcomeReason:
            'Without deletion vectors, every DELETE, UPDATE and MERGE rewrites whole data files rather than ' +
            'marking the affected rows, which costs compute proportional to file size rather than to the ' +
            'number of rows changed. Enabling them raises the minimum reader version, so check what reads ' +
            'each table first. Measured over a sample of the most-read tables.',
        }),
  };
});

/** Delta's default: statistics for the first 32 columns, which is what file skipping reads. */
const STATS_COLUMNS_PROPERTY = 'delta.dataSkippingNumIndexedCols';
const STATS_COLUMN_LIST_PROPERTY = 'delta.dataSkippingStatsColumns';

/**
 * PE-03-12: data skipping.
 *
 * Split deliberately into what is provable and what is not, because "is data skipping working" is
 * not answerable from table metadata and pretending otherwise would be the most tempting fabrication
 * in this pillar. Whether a file is skipped depends on the predicates queries actually use, and this
 * app does not correlate query predicates with table layout.
 *
 * What is provable is whether skipping is *possible*. Two facts carry it, and only the first is a
 * defect:
 *
 * Statistics turned off. `delta.dataSkippingNumIndexedCols = 0` means no min/max statistics are
 * written, so no file can be skipped on any predicate — skipping is off, whatever the layout. That
 * is unambiguous and it fails.
 *
 * No clustering strategy on a table where it would matter. A multi-file table with no liquid
 * clustering, no automatic clustering and no partitioning skips only to the extent that its natural
 * write order happens to correlate with how it is filtered. That is a risk rather than a defect, so
 * it is scored as a share with partial credit, and the reason says what it does and does not know.
 *
 * Small tables are excluded rather than passed: a table that fits in a few files is read whole
 * whether or not it can skip, so counting it either way would move the score for a table where the
 * control has no consequence.
 */
const dataSkipping = fromSignal<TableDetails>(DETAILS, ['PE-03-12'], (details, context) => {
  const empty = describedNothing(details);
  if (empty != null) return empty;

  const sizeFloor = threshold(context.spec, 'min_bytes_for_skipping', 1024 ** 3);
  const fileFloor = threshold(context.spec, 'min_files_for_skipping', 10);

  const statisticsOff = details.tables.filter((table) => table.properties[STATS_COLUMNS_PROPERTY] === '0');
  const population = activelyRead(details).filter(
    (table) => table.sizeBytes >= sizeFloor && table.fileCount >= fileFloor
  );

  if (statisticsOff.length > 0) {
    return {
      outcome: 'fail',
      evidence: [
        evidenceFrom(
          context,
          DETAILS,
          `${statisticsOff.length.toLocaleString('en-US')} tables write no file statistics ` +
            `(${STATS_COLUMNS_PROPERTY} is 0): ` +
            someOf(statisticsOff, 3, (table) => `${nameOf(table)} across ${table.fileCount.toLocaleString('en-US')} files`),
          `${STATS_COLUMNS_PROPERTY} is left at Delta's default of 32, so file statistics exist to skip on`
        ),
      ],
      outcomeReason:
        'With no min/max statistics per file, no file can be skipped on any predicate: every query over these ' +
        'tables reads every file, whatever the clustering. This is the one data-skipping fact that needs no ' +
        'interpretation, which is why it is reported ahead of layout. Setting the property back does not backfill ' +
        'statistics for existing files — those are written on the next rewrite of each file.',
    };
  }

  if (population.length === 0) {
    return {
      outcome: 'not-applicable',
      evidence: [
        evidenceFrom(
          context,
          DETAILS,
          `None of the ${details.tables.length.toLocaleString('en-US')} tables examined are both larger than ` +
            `${bytes(sizeFloor)} and spread over at least ${fileFloor.toLocaleString('en-US')} files`
        ),
      ],
      outcomeReason:
        `Data skipping decides which files a query can avoid reading, so it changes nothing on a table small ` +
        `enough to be read whole. No table examined is above ${bytes(sizeFloor)} across ` +
        `${fileFloor.toLocaleString('en-US')} files, so the control does not apply to this estate rather than ` +
        'being satisfied by it.',
    };
  }

  const skippable = population.filter(
    (table) => table.clusteringColumns.length > 0 || table.automaticClustering || table.partitionColumns.length > 0
  );
  const narrowed = population.filter((table) => table.properties[STATS_COLUMN_LIST_PROPERTY] != null);
  const share = skippable.length / population.length;
  const bands = bandsOf(context.spec, { pass: 0.8, partial: 0.4 });

  const covered =
    `${population.length.toLocaleString('en-US')} tables above ${bytes(sizeFloor)} and ` +
    `${fileFloor.toLocaleString('en-US')} files, of the ${details.tables.length.toLocaleString('en-US')} examined`;

  return {
    outcome: bandOutcome(share, bands),
    evidence: [
      evidenceFrom(
        context,
        DETAILS,
        `${skippable.length.toLocaleString('en-US')} of ${covered} cluster or partition their data — ${percent(share)}`,
        `At least ${percent(bands.pass)} of tables large enough for skipping to matter organise their files, by ` +
          'liquid clustering, automatic clustering or partitioning'
      ),
      ...(narrowed.length > 0
        ? [
            evidenceFrom(
              context,
              DETAILS,
              `${narrowed.length.toLocaleString('en-US')} of them collect statistics for a named subset of columns ` +
                `(${STATS_COLUMN_LIST_PROPERTY}), so skipping works on those columns and not on others`
            ),
          ]
        : []),
    ],
    ...(share >= bands.pass
      ? {}
      : {
          outcomeReason:
            `${String(population.length - skippable.length)} large, actively read tables have no clustering and no ` +
            'partitioning, so a query filtering them skips files only where the write order happens to match the ' +
            'filter. Liquid clustering is the current recommendation and can be set on an existing table. What this ' +
            'does not measure is whether skipping is working: that depends on the predicates queries use, which ' +
            'this scan does not read. So this is a statement about whether skipping is possible, not about how ' +
            'much I/O it is saving. Measured over a sample of the most-read tables.',
        }),
  };
});

export const LAYOUT_RESOLVERS: readonly ControlResolver[] = [overPartitioning, deletionVectors, dataSkipping];
