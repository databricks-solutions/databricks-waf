// Whether the three table-layout rules have an input anywhere. Ledger row `41d`.
//
// The rules are small files, maintenance coverage and over-partitioning: the half of `33g` that was moved out
// of it on 2026-08-12 rather than built. Two of them were said to have no input because
// `system.storage.table_metrics_history` returned no rows, and the third because a census of partitioned
// tables did not return. Neither reading could carry what was concluded from it — one window was bounded at
// thirty days, the other was not written down, the grants the reader held on that schema were never checked,
// and a query that does not finish is a fact about the query. So this script asks the three questions
// properly, and the answers decide what the row builds.
//
//   1. Is `system.storage.table_metrics_history` written, on this estate, at all? Unbounded — no date filter,
//      no limit — because every prior reading of it was bounded and a bounded empty window says nothing about
//      the dates outside it. The count is reported against the number of tables the metastore catalogues, as
//      ADR 0014 reported its own: zero rows is only interesting beside a population that should have produced
//      some.
//   2. Is a zero a refusal or the platform? On a shared estate a refusal is the expected failure, and it does
//      not look like one from inside a script that catches errors. Three things separate them: whether the
//      read raised or returned, whether the schema's other tables answer for the same principal in the same
//      session, and whether the relation is listed at all. A refused read raises; only a read that *returned*
//      zero is evidence about the platform.
//   3. How many partitioned tables are there, when the census is bounded? Two ways, because they answer
//      different questions. Per catalog over `system.information_schema.columns`, which is the census `33g`
//      attempted unbounded; and over the sample the app itself describes, which is the population the shipped
//      control actually judges. `information_schema` carries no size, and the WAF's rule is about size, so the
//      first can only ever count partitioned tables while the second can say whether any is over-partitioned.
//      The sample is selected and cut at the app's own two limits — 200 candidates, the first 50 described —
//      because a claim about what the control sees is only true of the population the control is given.
//
// Every probe is bounded except the two that may not be, and each of those says why where it stands. The whole
// script reads catalogue metadata and table layout — no query text, no table contents.
//
// Run: cd app && DATABRICKS_HOST=... DATABRICKS_WAREHOUSE_ID=... DATABRICKS_CONFIG_PROFILE=your-profile \
//        node scripts/measure-table-layout-inputs.mjs
//
// Writes `server/collect/sql/runtime-baseline/<profile>-table-layout-inputs.json`. The estate is in the name
// and two guards in `recording-guards.mjs` check that the name is true; `41b`'s header and `docs/estates.md`
// record what goes wrong when it is not.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, runStatement } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { quoteIdent } from './sql-identifiers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASELINES = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const OUT = join(BASELINES, `${corpusSettings.profile}-table-layout-inputs.json`);
const SAMPLE_SELECTION = join(HERE, '..', 'config', 'statements', 'storage_sample_selection.sql');

/**
 * How many catalogs the per-catalog census visits.
 *
 * Low, and the reason is the measurement that produced this row: the same census unbounded did not return
 * inside five and a half minutes on the measurement estate, and per catalog it is minutes rather than seconds
 * there. The catalogs are taken in order of how many tables they hold, so the visited ones are the largest
 * available — not most of the estate. The recording states the share covered, and on a wide estate that share
 * is a minority: a census bounded this way counts what it counted and nothing else.
 */
const CATALOG_LIMIT = Number(process.env.CATALOG_LIMIT ?? 3);

/**
 * The two caps the app applies to the sample, which are two numbers and not one.
 *
 * `collector.ts` binds `table_limit` at 200 for `storage_sample_selection`, and `DescribeCollector` then
 * describes the first `sampleLimit` of what came back, defaulting to 50. Selecting 50 here — or the 25 this
 * script first used — would rank against a shorter list and describe a different set, so every sentence about
 * what the shipped control sees would be about a population it never sees. Both numbers are quoted from the
 * app rather than chosen.
 */
const SELECT_LIMIT = Number(process.env.SELECT_LIMIT ?? 200);
const DESCRIBE_LIMIT = Number(process.env.DESCRIBE_LIMIT ?? 50);

/** The window the sample's read-activity ranking uses, which is the app's default lookback. */
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

/**
 * The two size thresholds the controls apply, at the defaults the code carries.
 *
 * Both are `threshold(spec, ...)` calls in the resolvers — `min_bytes_before_partitioning` in `layout.ts` and
 * `min_average_file_bytes` in `platform.ts` and `storage.ts` — so a spec may move either. These are the
 * fallbacks those calls pass, which is what an estate running the shipped specs gets.
 */
const MIN_PARTITION_TABLE_BYTES = 1024 ** 4;
const MIN_AVERAGE_FILE_BYTES = 16 * 1024 * 1024;

/**
 * Mirrors `queries.ts`'s `customerCatalogPredicate`, as `measure-sql-plans.mjs` mirrors it.
 *
 * A copy because this file runs under plain Node and cannot import the app's TypeScript. The test asserts it
 * against the original rather than against a transcription of it, which is how `schedule-principal.test.ts`
 * holds its own copy of the same predicate.
 */
const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
export function customerCatalog(text) {
  return text.replace(
    FRAGMENT,
    (_whole, column) =>
      `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
      `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
      ` AND NOT startswith(lower(${column}), '__databricks_internal'))`
  );
}

/**
 * Whether a relation exists and what it carries, without assuming it does.
 *
 * The error is kept rather than thrown, and keeping it is the point of question 2: a probe that raised and a
 * probe that returned nothing are different findings, and a script that collapses them into an empty array
 * reports a refusal as a fact about the platform. Every reading below branches on `ok` before it counts rows.
 */
export async function probe(label, statement, parameters = []) {
  const started = Date.now();
  try {
    const rows = await runStatement(statement, parameters);
    return { label, ok: true, ms: Date.now() - started, rows };
  } catch (error) {
    return { label, ok: false, ms: Date.now() - started, error: String(error).slice(0, 300) };
  }
}

/** One probe by its label, or null where it is absent — never a fabricated empty one. */
export function only(probes, label) {
  return probes.find((one) => one.label === label) ?? null;
}

/** A probe's first row, or null where the probe failed or returned nothing. */
export function firstRow(probes, label) {
  const found = only(probes, label);
  if (found?.ok !== true) return null;
  return found.rows[0] ?? null;
}

/**
 * A numeric field, or null where there is nothing to read.
 *
 * Null rather than zero throughout, because a zero from a probe that failed is the one number this script must
 * never produce: the whole question is whether an empty reading is the estate or the apparatus.
 */
export function count(row, key) {
  const value = row?.[key];
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * What the metrics table's reading amounts to, as one of five words rather than a row count.
 *
 * `refused` where the read raised, `unread` where it returned no count at all, `written` where rows came back,
 * `unwritten` where a returned zero stands beside a sibling that answered, and `empty-and-grant-unconfirmed`
 * where the zero returned but nothing establishes the grant.
 *
 * This is the whole of question 1 and 2, and it is written as a function so the recording carries the verdict
 * instead of leaving every later reader to derive it — including the derivation that was got wrong twice, in
 * which a zero became "the table is unwritten" without the read being unbounded or the grant being held.
 */
export function metricsVerdict(readable, rows, siblingRows) {
  if (!readable) return 'refused';
  if (rows == null) return 'unread';
  if (rows > 0) return 'written';
  // A zero from a read that returned, in a schema whose other table answered for the same principal in the
  // same session. The sibling is what makes this a statement about the table rather than about the grant.
  return siblingRows != null && siblingRows > 0 ? 'unwritten' : 'empty-and-grant-unconfirmed';
}

/**
 * `DESCRIBE DETAIL` for one table, reduced to the five fields the layout controls read.
 *
 * The name is quoted part by part through the same `quoteIdent` the shipped describe uses, so a schema with a
 * hyphen or a backtick in it resolves here as it does there rather than becoming a parse error this script
 * would then record as a refusal.
 */
export async function describeDetail(parts) {
  const quoted = parts.map((part) => quoteIdent(part));
  const table = quoted.includes(undefined) ? null : quoted.join('.');
  if (table == null) return { table: parts.join('.'), error: 'name is not quotable' };
  try {
    const [row] = await runStatement(`DESCRIBE DETAIL ${table}`);
    if (row == null) return { table, error: 'DESCRIBE DETAIL returned no row' };
    const partitionColumns = JSON.parse(String(row['partitionColumns'] ?? '[]'));
    const clusteringColumns = JSON.parse(String(row['clusteringColumns'] ?? '[]'));
    return {
      table,
      sizeBytes: count(row, 'sizeInBytes'),
      fileCount: count(row, 'numFiles'),
      partitionColumns,
      clusteringColumns,
      // `PE-03-13` treats an automatically clustered table as clustered, so a reading that counted only the
      // explicit column list would undercount the population the control excuses.
      automaticClustering: String(row['clusterByAuto'] ?? '').toLowerCase() === 'true',
    };
  } catch (error) {
    return { table, error: String(error).slice(0, 300) };
  }
}

async function main() {
  // Before the probes, not after: a census of a large shared estate that ends in a refusal to write is minutes
  // of somebody else's warehouse spent for nothing.
  refuseUnlessNamedForItsEstate(OUT, corpusSettings.profile, corpusSettings.host);

  const probes = [
    // Question 1. Unbounded on purpose and the only place in this script where that is true of a fact table:
    // every prior reading of this table was a window, and a window that is empty says nothing about the dates
    // outside it. The aggregate returns one row however many the table holds, so being unbounded costs a scan
    // rather than a result set.
    await probe(
      'the metrics table, unbounded',
      `SELECT count(*)                                                                    AS rows,
              count(DISTINCT concat_ws('.', catalog_name, schema_name, table_name))       AS tables,
              min(snapshot_date)                                                          AS earliest,
              max(snapshot_date)                                                          AS latest
         FROM system.storage.table_metrics_history`
    ),
    // That the relation exists and what it would carry if it were written. ADR 0014 read this schema on labs
    // and it is quoted in three places in the app; this re-reads it rather than trusting the quotation.
    await probe('the metrics table schema', 'DESCRIBE system.storage.table_metrics_history'),
    // Question 2, first half: which relations the storage schema actually exposes to this principal. A table
    // absent here and a table present-but-empty are different findings, and ADR 0014 found both at once — an
    // undocumented table present and a documented one absent.
    await probe(
      'what the storage schema exposes',
      `SELECT table_name, table_type
         FROM system.information_schema.tables
        WHERE table_catalog = 'system' AND table_schema = 'storage'
        ORDER BY table_name`
    ),
    // Question 2, second half, and the load-bearing one. Same schema, same principal, same session: if this
    // returns rows then the zero above is the table and not the grant. Unbounded for the same reason as the
    // first probe, and an aggregate for the same reason.
    await probe(
      'the sibling table in the same schema, unbounded',
      `SELECT count(*)             AS rows,
              min(start_time)      AS earliest,
              max(start_time)      AS latest,
              count(DISTINCT operation_type) AS operation_types
         FROM system.storage.predictive_optimization_operations_history`
    ),
    // The denominator. Zero rows is a reading about the platform only beside the number of tables that should
    // have produced rows, which is how ADR 0014 stated its own — zero against 347 catalogued. Every relation
    // the catalogue lists, views included, so it is an upper bound rather than the exact population.
    await probe(
      'tables the metastore catalogues',
      `SELECT count(*)                        AS tables,
              count(DISTINCT table_catalog)   AS catalogs,
              count_if(table_type IN ('MANAGED', 'EXTERNAL')) AS stored_tables
         FROM system.information_schema.tables`
    ),
    // Whether the census relation could answer the rule even if it were fast. It carries no size column, and
    // the WAF's threshold is a size, so this is the probe that decides the census cannot be the input — a
    // finding about the relation rather than about either estate.
    await probe('what the census relation carries', 'DESCRIBE system.information_schema.columns'),
  ];

  // Question 3, first way. Per catalog because unbounded did not return, and in table-count order because the
  // point of a bounded census is to cover as many tables as three catalogs can — which on a wide estate is a
  // minority of them, and the recording says which.
  const catalogs = await probe(
    'catalogs by table count',
    // Customer catalogs only, through the app's own predicate. Ranked without it, labs' three largest are
    // `samples` and `system` and a workshop, and a census of those answers a question about Databricks'
    // tables rather than about the estate the controls judge.
    customerCatalog(
      `SELECT table_catalog, count(*) AS tables
         FROM system.information_schema.tables
        WHERE {{customer_catalog table_catalog}}
        GROUP BY table_catalog
        ORDER BY tables DESC
        LIMIT ${String(CATALOG_LIMIT)}`
    )
  );
  probes.push(catalogs);

  for (const row of catalogs.ok ? catalogs.rows : []) {
    const name = String(row['table_catalog']);
    probes.push(
      await probe(
        `partitioned tables in ${name}`,
        `SELECT count(DISTINCT concat_ws('.', table_catalog, table_schema, table_name)) AS partitioned_tables,
                max(partition_index)                                                    AS deepest_partition_index
           FROM system.information_schema.columns
          WHERE table_catalog = :catalog
            AND partition_index IS NOT NULL`,
        // Bound rather than interpolated. A catalog name is estate data, and the alternative here was escaping
        // one quote character and hoping the rest of the name was ordinary.
        [{ name: 'catalog', value: name, type: 'STRING' }]
      )
    );
  }

  // Question 3, second way, and the one that answers the rule rather than counting its population. The
  // statement is the app's own, loaded rather than reproduced: a sample selected differently from the shipped
  // one would be a reading about a population the control never sees, which is the apparatus error
  // `AGENTS.md` names.
  const selection = await probe(
    'the sample the app describes',
    customerCatalog(readFileSync(SAMPLE_SELECTION, 'utf8')),
    // The collector's own three parameters, bound as it binds them rather than pasted in by hand: a
    // parameter this script forgot to substitute would fail the statement, and one the statement gains
    // later would be substituted by nobody.
    [
      { name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' },
      { name: 'workspace_id', value: '', type: 'STRING' },
      { name: 'table_limit', value: String(SELECT_LIMIT), type: 'INT' },
    ]
  );
  probes.push(selection);

  // `DescribeCollector` takes the first `sampleLimit` candidates in the order the selection returned them,
  // which is read activity descending. Taking a different slice would describe a different set.
  const candidates = (selection.ok ? selection.rows : []).slice(0, DESCRIBE_LIMIT);
  const described = [];
  for (const row of candidates) {
    described.push(
      await describeDetail([String(row['table_catalog']), String(row['table_schema']), String(row['table_name'])])
    );
  }

  const metrics = firstRow(probes, 'the metrics table, unbounded');
  const sibling = firstRow(probes, 'the sibling table in the same schema, unbounded');
  const catalogued = firstRow(probes, 'tables the metastore catalogues');
  const metricsRows = count(metrics, 'rows');
  const siblingRows = count(sibling, 'rows');
  const readable = only(probes, 'the metrics table, unbounded')?.ok === true;

  const laidOut = described.filter((one) => one.error == null);
  const partitioned = laidOut.filter((one) => one.partitionColumns.length > 0);
  // A describe that returned without a size is not a table of zero bytes, and the two counts below are
  // thresholds against size. Where no described table carried one, the count is null rather than nought:
  // saying "none is over-partitioned" from an unread size is the apparatus error this script exists to avoid.
  const sized = laidOut.filter((one) => one.sizeBytes != null);
  const sizedPartitioned = partitioned.filter((one) => one.sizeBytes != null);

  const reading = {
    runFinishedAt: new Date().toISOString(),
    profile: corpusSettings.profile,
    host: corpusSettings.host,
    warehouse: corpusSettings.warehouse,
    catalogLimit: CATALOG_LIMIT,
    selectLimit: SELECT_LIMIT,
    describeLimit: DESCRIBE_LIMIT,
    lookbackDays: LOOKBACK_DAYS,

    // Questions 1 and 2, as a verdict and the three things it was reached from.
    metricsTable: {
      verdict: metricsVerdict(readable, metricsRows, siblingRows),
      readable,
      bounded: false,
      rows: metricsRows,
      tables: count(metrics, 'tables'),
      // Every relation `information_schema.tables` lists, so views and foreign tables are in it and the
      // metrics table could never have a row for those. It is an upper bound on the population that should
      // have produced rows, which is all a denominator has to be to make a zero mean something.
      cataloguedRelations: count(catalogued, 'tables'),
      // The subset that can hold data, which is the population a per-table snapshot would have a row for.
      cataloguedStoredTables: count(catalogued, 'stored_tables'),
      siblingRows,
      listedInTheSchema:
        only(probes, 'what the storage schema exposes')?.ok === true
          ? (only(probes, 'what the storage schema exposes')?.rows ?? []).some(
              (row) => String(row['table_name']) === 'table_metrics_history'
            )
          : null,
    },

    // Question 3, both ways, each stating what it covered rather than implying it covered the estate.
    census: {
      catalogsVisited: catalogs.ok ? catalogs.rows.length : null,
      // What the visit covered, of every relation the catalogue holds. Stated because three catalogs of a
      // wide metastore is a small share of it, and a count with no share reads as an estate.
      relationsCovered: catalogs.ok
        ? catalogs.rows.reduce((sum, row) => sum + (count(row, 'tables') ?? 0), 0)
        : null,
      perCatalog: (catalogs.ok ? catalogs.rows : []).map((row) => {
        const name = String(row['table_catalog']);
        const found = only(probes, `partitioned tables in ${name}`);
        return {
          catalog: name,
          tables: count(row, 'tables'),
          returned: found?.ok === true,
          ms: found?.ms ?? null,
          partitionedTables: found?.ok === true ? count(found.rows[0], 'partitioned_tables') : null,
          deepestPartitionIndex: found?.ok === true ? count(found.rows[0], 'deepest_partition_index') : null,
        };
      }),
    },

    // What the shipped controls would see here. `PE-03-13` fails a partitioned table below 1 TiB and
    // `readFragmentation` asks its question only of tables that could hold a target-sized file, so both counts
    // below are populations rather than verdicts — and an empty population is why both controls have a
    // not-applicable branch.
    sample: {
      selected: selection.ok ? selection.rows.length : null,
      attempted: candidates.length,
      eligible: selection.ok ? count(selection.rows[0], 'eligible_tables') : null,
      described: laidOut.length,
      failed: described.length - laidOut.length,
      partitioned: partitioned.length,
      sized: sized.length,
      overPartitioned:
        sizedPartitioned.length === 0 && partitioned.length > 0
          ? null
          : sizedPartitioned.filter((one) => one.sizeBytes < MIN_PARTITION_TABLE_BYTES).length,
      // `PE-03-13` excuses a table that is clustered either way, so both count here as they do there.
      clustered: laidOut.filter((one) => one.clusteringColumns.length > 0 || one.automaticClustering).length,
      // The fragmentation control's own population: tables large enough for a target-sized file to be a target.
      compactable:
        sized.length === 0 && laidOut.length > 0
          ? null
          : sized.filter((one) => (one.fileCount ?? 0) > 0 && one.sizeBytes >= MIN_AVERAGE_FILE_BYTES).length,
      withSizeAndFileCount: laidOut.filter((one) => one.sizeBytes != null && one.fileCount != null).length,
    },

    described,
    probes,
  };

  writeFileSync(OUT, `${JSON.stringify(reading, null, 2)}\n`);
  process.stdout.write(
    [
      `estate: ${reading.profile} at ${reading.host}`,
      `metrics table: ${reading.metricsTable.verdict} — ${String(reading.metricsTable.rows)} rows against ` +
        `${String(reading.metricsTable.cataloguedRelations)} catalogued relations, sibling ${String(siblingRows)} rows`,
      ...reading.census.perCatalog.map((one) =>
        one.returned
          ? `census ${one.catalog}: ${String(one.partitionedTables)} partitioned of ${String(one.tables)} tables in ${String(one.ms)}ms`
          : `census ${one.catalog}: did not return in ${String(one.ms)}ms — a fact about the probe`
      ),
      `sample: ${String(reading.sample.described)} described of ${String(reading.sample.attempted)} attempted ` +
        `(${String(reading.sample.selected)} selected, ${String(reading.sample.eligible)} eligible), ` +
        `${String(reading.sample.partitioned)} partitioned, ${String(reading.sample.overPartitioned)} of those under 1 TiB`,
      ...probes.map((one) => `probe ${one.label}: ${one.ok ? `${String(one.rows.length)} rows` : `FAILED ${one.error}`}`),
      `written to ${OUT}`,
      '',
    ].join('\n')
  );
}

// Guarded so a test can import the readers without running a scan, which is every other measurement script's shape.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
