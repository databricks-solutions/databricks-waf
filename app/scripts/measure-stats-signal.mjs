// Whether anything this app can read says a table's optimizer statistics are missing or stale. Ledger row `33iga`.
//
// `MISSING_OR_STALE_STATS` is the last of the fourteen rules and the only one no plan can answer: `33ia` measured the
// whole metric vocabulary and found no stat-freshness label, and the design document itself says the input is
// "plan/profile or catalog metadata". So the row was written as a collector before a rule — and a collector needs to
// know what the catalogue will say before it is written, which is this script.
//
// Four questions, in the order that decides the next row. Each can end it.
//
//   1. Does a plan name the tables it scans, fully qualified? `SCAN_IDENTIFIER` is one of the seven promised
//      `meta_data` keys and the fixtures carry `system.access.table_lineage` in it, three parts. If the identifier
//      is a bare table name on real plans, a rule cannot resolve it against a catalogue and there is nothing to
//      join a shape to.
//   2. Does `DESCRIBE EXTENDED` report statistics, and can absent be told from zero? This is the design document's
//      own suggestion. What matters is not that the command runs but that its output *distinguishes* a table nobody
//      has analysed from one that was analysed and is empty.
//   3. Is there a cheaper route than one command per table — an `information_schema` relation carrying the same
//      thing? A statement is one round trip; N `DESCRIBE`s are N, and `check-sql-release.mjs` budgets per statement.
//   4. Is there a *freshness* signal at all: something that says when statistics were last computed, and something
//      that says when the table was last written. Stale is a comparison of two timestamps and the rule needs both.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=your-profile \
//        node scripts/measure-stats-signal.mjs
//
// Writes `server/collect/sql/runtime-baseline/labs-stats-signal.json`.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, eachPlan, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline', 'labs-stats-signal.json');

// How many tables to `DESCRIBE`. A ceiling because this is the expensive question and the point is the shape of the
// answer rather than a census: if the first twenty tables all answer the same way, the twenty-first does not decide
// anything the next row needs.
const DESCRIBE_LIMIT = Number(process.env.DESCRIBE_LIMIT ?? 20);

/** A `meta_data` value, in either of the two spellings `parse.ts` reads. */
export function metaValues(node, key) {
  const found = [];
  for (const entry of node?.meta_data ?? []) {
    if (entry?.key !== key) continue;
    if (typeof entry.value === 'string' && entry.value !== '') found.push(entry.value);
    for (const value of entry.values ?? []) if (typeof value === 'string' && value !== '') found.push(value);
  }
  return found;
}

/** Every table a graph says it scanned, with the part count of each identifier as it was written. */
export function scansIn(graph) {
  const seen = [];
  for (const node of graph?.nodes ?? []) {
    for (const identifier of metaValues(node, 'SCAN_IDENTIFIER')) {
      seen.push({ identifier, parts: identifier.split('.').length, tag: node?.tag ?? null });
    }
  }
  return seen;
}

function tally(values) {
  const counts = {};
  for (const value of values) counts[String(value)] = (counts[String(value)] ?? 0) + 1;
  return counts;
}

/**
 * `DESCRIBE EXTENDED` for one table, as a map of its `col_name` to `data_type`.
 *
 * The command returns a three-column result whose first rows are the columns and whose tail is the metadata, so the
 * statistics line — if there is one — arrives as a row named `Statistics` rather than as a field. Errors are kept
 * rather than thrown: a table the warehouse cannot see is a reading about what a collector will meet.
 */
export async function describe(table) {
  try {
    const rows = await runStatement(`DESCRIBE EXTENDED ${table}`);
    const metadata = {};
    for (const row of rows) {
      const name = String(row['col_name'] ?? '').trim();
      if (name !== '' && !name.startsWith('#')) metadata[name] = String(row['data_type'] ?? '').trim();
    }
    return { table, rows: rows.length, statistics: metadata['Statistics'] ?? null, metadata };
  } catch (error) {
    return { table, error: String(error).slice(0, 300) };
  }
}

/** Whether a relation exists and what it carries, without assuming it does. */
export async function probe(label, statement) {
  try {
    return { label, ok: true, rows: await runStatement(statement) };
  } catch (error) {
    return { label, ok: false, error: String(error).slice(0, 300) };
  }
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const { shapes, found, skipped } = await eachPlan();

  const scans = found.flatMap(({ shape, widest }) =>
    scansIn(widest.graph).map((scan) => ({ ...scan, shape: shape.shape }))
  );
  const tables = [...new Set(scans.filter((scan) => scan.parts === 3).map((scan) => scan.identifier))];
  const shapesWithAScan = new Set(scans.map((scan) => scan.shape)).size;

  const described = [];
  for (const table of tables.slice(0, DESCRIBE_LIMIT)) described.push(await describe(table));

  // Three relations a collector could read instead of N `DESCRIBE`s, each probed rather than assumed. The third is
  // the one the app already reads for `sql:maintenance.recency`, asked here for the operation types it carries.
  const probes = [
    await probe(
      'information_schema.tables',
      `SELECT table_catalog, table_schema, table_name, table_type, data_source_format, last_altered
         FROM system.information_schema.tables
        WHERE concat_ws('.', table_catalog, table_schema, table_name) IN (${tables
          .slice(0, DESCRIBE_LIMIT)
          .map((table) => `'${table}'`)
          .join(', ')})
        LIMIT 50`
    ),
    await probe('information_schema.columns has a stats column', `DESCRIBE system.information_schema.columns`),
    await probe(
      'predictive_optimization_operations_history operation types',
      `SELECT operation_type, count(*) AS runs, max(end_time) AS latest
         FROM system.storage.predictive_optimization_operations_history
        WHERE start_time >= current_timestamp() - INTERVAL 30 DAYS
        GROUP BY operation_type
        ORDER BY runs DESC`
    ),
    await probe(
      'ANALYZE in query history',
      `SELECT count(*) AS statements, count(DISTINCT statement_text) AS texts, max(start_time) AS latest
         FROM system.query.history
        WHERE start_time >= current_timestamp() - INTERVAL 30 DAYS
          AND upper(trim(statement_text)) LIKE 'ANALYZE %'`
    ),
    await probe(
      'table_metrics_history carries a write time',
      `DESCRIBE system.storage.table_metrics_history`
    ),
    // The apparatus check, and the one that decides the row. If `DESCRIBE EXTENDED` reports a `Statistics` row on a
    // table nothing has analysed, the row is not evidence that statistics were computed, and question 2 above is
    // answered no however many tables carry it. These two probes are the two halves of that: which tables predictive
    // optimization actually analysed, and whether the columns of a table carry statistics of their own.
    // Unbounded on purpose, where every other probe here is capped. Two derived counts below read this probe as the
    // set of analysed tables, so a `LIMIT` would make a table that *was* analysed but ranked below the cut read as one
    // that never was — which is the reading this whole script exists to contradict, arrived at by the apparatus
    // instead of by the platform. The aggregate is one row per table with an ANALYZE in thirty days, which was 34 on
    // labs; if that ever becomes large the fix is a join to the corpus's tables, not a cap.
    await probe(
      'which tables predictive optimization analysed',
      `SELECT concat_ws('.', catalog_name, schema_name, table_name) AS table_name,
              count(*) AS runs,
              max(end_time) AS latest
         FROM system.storage.predictive_optimization_operations_history
        WHERE operation_type = 'ANALYZE'
          AND start_time >= current_timestamp() - INTERVAL 30 DAYS
        GROUP BY ALL
        ORDER BY runs DESC`
    ),
    ...(await Promise.all(
      tables
        .slice(0, 2)
        .map((table) => probe(`every DESCRIBE EXTENDED row of ${table}`, `DESCRIBE EXTENDED ${table}`))
    )),
    // The one comparison that survives the four questions, run here so the next row inherits a timing and a row count
    // rather than a design. Last ANALYZE against last write, per table, from two system tables and no `DESCRIBE`:
    // bounded by the ANALYZE history rather than by the table count, which is what makes it declarable.
    await probe(
      'last ANALYZE against last write',
      `WITH analysed AS (
         SELECT concat_ws('.', catalog_name, schema_name, table_name) AS full_name,
                max(end_time)                                        AS analysed_at,
                count(*)                                             AS analyze_runs
           FROM system.storage.predictive_optimization_operations_history
          WHERE operation_type = 'ANALYZE'
            AND start_time >= current_timestamp() - INTERVAL 30 DAYS
          GROUP BY ALL
       ),
       written AS (
         SELECT target_table_full_name AS full_name,
                max(event_time)        AS written_at,
                count(*)               AS write_events
           FROM system.access.table_lineage
          WHERE event_time >= current_timestamp() - INTERVAL 30 DAYS
            AND target_table_full_name IS NOT NULL
          GROUP BY ALL
       )
       SELECT a.full_name, a.analysed_at, a.analyze_runs, w.written_at, w.write_events,
              datediff(HOUR, a.analysed_at, w.written_at) AS hours_written_after_analyse
         FROM analysed a
         LEFT JOIN written w ON w.full_name = a.full_name
        ORDER BY hours_written_after_analyse DESC NULLS LAST
        LIMIT 50`
    ),
  ];

  // What the two halves say about each other: of the tables the corpus's own shapes scan, how many the ANALYZE
  // history knows at all. A table absent from it is one whose statistics state is *unknown* rather than missing, and
  // the count is the ceiling on what a rule built here could ever say.
  //
  // Every count below is `null` where that probe failed, rather than computed from an empty set. An unread ANALYZE
  // history and an empty one produce the same `analysedNames`, and the derived reading — "carried a Statistics row
  // with no ANALYZE record" — is at its most alarming exactly when the probe read nothing. A recording that cannot
  // tell those apart is the failure this file spent its length describing.
  const analysed = probes.find((row) => row.label === 'which tables predictive optimization analysed');
  const analyseHistoryRead = analysed?.ok === true;
  const analysedNames = new Set((analysed?.rows ?? []).map((row) => String(row['table_name'])));
  const againstHistory = (value) => (analyseHistoryRead ? value() : null);
  const scannedAndAnalysed = tables.filter((table) => analysedNames.has(table));

  const reading = {
    takenAt: new Date().toISOString(),
    ...corpusSettings,
    describeLimit: DESCRIBE_LIMIT,
    corpus: { shapes: shapes.length, plans: found.length, skipped },
    scans: {
      total: scans.length,
      shapesWithAScan,
      distinctThreePartTables: tables.length,
      partsPerIdentifier: tally(scans.map((scan) => scan.parts)),
      tagsCarryingOne: tally(scans.map((scan) => scan.tag)),
      sample: tables.slice(0, 12),
    },
    described,
    describedSummary: {
      attempted: described.length,
      errored: described.filter((row) => row.error != null).length,
      withAStatisticsRow: described.filter((row) => row.statistics != null).length,
      statisticsValues: tally(described.filter((row) => row.statistics != null).map((row) => row.statistics)),
      // The apparatus check, as a pair of counts. A table carrying a `Statistics` row that nothing analysed is one
      // that the row does not describe, and the number of them is what answers question 2.
      withAStatisticsRowAndNoAnalyzeRecord: againstHistory(
        () => described.filter((row) => row.statistics != null && !analysedNames.has(row.table)).length
      ),
      withAnAnalyzeRecordAndNoStatisticsRow: againstHistory(
        () => described.filter((row) => row.statistics == null && analysedNames.has(row.table)).length
      ),
    },
    scannedTablesAgainstAnalyzeHistory: {
      analyseHistoryRead,
      scanned: tables.length,
      inTheAnalyzeHistory: againstHistory(() => scannedAndAnalysed.length),
      inIt: againstHistory(() => scannedAndAnalysed),
      notInIt: againstHistory(() => tables.filter((table) => !analysedNames.has(table))),
    },
    probes,
  };

  writeFileSync(OUT, `${JSON.stringify(reading, null, 2)}\n`);
  process.stdout.write(
    [
      `corpus: ${String(found.length)} plans of ${String(shapes.length)} shapes`,
      `scans: ${String(scans.length)} identifiers on ${String(shapesWithAScan)} shapes, ${String(tables.length)} distinct three-part tables`,
      `parts per identifier: ${JSON.stringify(reading.scans.partsPerIdentifier)}`,
      `described: ${String(reading.describedSummary.attempted)} attempted, ${String(reading.describedSummary.errored)} errored, ${String(reading.describedSummary.withAStatisticsRow)} carried a Statistics row`,
      analyseHistoryRead
        ? `of those, ${String(reading.describedSummary.withAStatisticsRowAndNoAnalyzeRecord)} carried one with no ANALYZE record at all`
        : 'the ANALYZE history did not read, so nothing below compares against it',
      analyseHistoryRead
        ? `scanned tables in the ANALYZE history: ${String(reading.scannedTablesAgainstAnalyzeHistory.inTheAnalyzeHistory)} of ${String(tables.length)}`
        : `scanned tables: ${String(tables.length)}, none compared`,
      ...probes.map((row) => `probe ${row.label}: ${row.ok ? `${String(row.rows.length)} rows` : `FAILED ${row.error}`}`),
      `written to ${OUT}`,
      '',
    ].join('\n')
  );
}

// Guarded so a test can import the readers without running a scan, which is every other measurement script's shape.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
