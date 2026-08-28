/*
 * What the retention surface costs, and which of the swept tables an index on its stamp would pay for.
 *
 * `83` exists because sixteen of the twenty-two tables retention sweeps have no index led by the
 * column the sweep filters and orders on. Sixteen indexes is sixteen write costs on every insert and
 * sixteen objects to keep, and the row says the reading decides which of them earn it — H1's rule,
 * applied to a claim from the same lineage.
 *
 * # What is measured, and why the count rather than the delete is the subject
 *
 * Three statements reach each table. `count(*)` over the whole table, `count(*) where stamp < cutoff`,
 * and `order by stamp asc limit 1` to say how far back the install goes. A fourth, the delete, runs
 * only when somebody sweeps.
 *
 * The first three run together, for all twenty-two tables, every time the retention page is opened —
 * `eligibility()` in `retention.ts` calls `gateway.count` per table and the route calls it per class.
 * The delete runs when an administrator asks and confirms. So the statement worth an index is the
 * *count*, not the delete, and that is the opposite of what the row's own prose assumed when it said
 * the sweep "is not a hot path". It is not; the page in front of it is.
 *
 * # Two cutoffs, because the eligible fraction decides the plan
 *
 * An index on the stamp is a large win when nothing is eligible — it descends to one leaf and stops —
 * and no win at all when everything is, because a scan that must visit every row is cheapest done
 * sequentially. Measuring one fraction would produce a number that is true and unrepresentative of
 * the other case, so both are taken: `inside`, where the install is younger than its period and
 * nothing is eligible, and `overdue`, where a tenth of each table is past the cutoff.
 *
 * `inside` is the common case by a wide margin. An install inside its retention period is what an
 * install is for all but the tail of its life, and the retention page is opened during it.
 *
 * # What this cannot say
 *
 *   It runs against whatever Postgres `WAF_BENCH_PG` names. A local cluster over a unix socket is not
 *   Lakebase over TLS, so the durations are a floor. What transfers is the buffer count, which is a
 *   fact about pages the plan touched and does not depend on the transport.
 *
 *   The write cost of an index is measured as the time to insert a thousand rows with it and without,
 *   on a table already at volume. That is the cost on this hardware; the shape of the difference is
 *   what carries, not the milliseconds.
 *
 *   Every duration is a warm-cache median of `EXPLAIN (ANALYZE, BUFFERS)`, which measures the
 *   statement rather than the round trip.
 *
 *   node --import tsx scripts/measure-retention-sweeps.mts            # measure and record
 *   node --import tsx scripts/measure-retention-sweeps.mts --publish  # measure, then rewrite the table
 *   node --import tsx scripts/measure-retention-sweeps.mts --check    # doc against recording
 *   node --import tsx scripts/measure-retention-sweeps.mts --times=10 # at ten times this catalogue
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { loadCatalogue } from '../server/catalogue/catalogue.js';
import { ensureSchema, type Sql } from '../server/store/postgres.js';
import { CHAINED_TABLE, DEFAULT_PERIOD_DAYS, RETAINED, type Retained } from '../server/admin/retention.js';
import { RUN_CADENCE_DAYS, SWEPT_VOLUMES, unsized } from '../server/admin/retention-volume.js';
import { and, where } from '../server/admin/retention-store.js';
import { ORIGIN, rowFor } from '../server/store/retention-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const RECORDING = join(HERE, 'recordings', 'retention-sweeps.json');
const DOC = join(ROOT, 'docs', 'design', 'retention-sweep-cost.md');

const START = '<!-- generated: retention sweep cost. Run `npm run measure:retention-sweeps -- --publish`. -->';
const END = '<!-- end generated -->';

/** Samples per statement, so the middle one is a median rather than the better of two. */
const SAMPLES = Number(process.env['SAMPLES'] ?? '5');

/** Rows inserted to price an index's write cost, on a table already at volume. */
const WRITE_SAMPLE_ROWS = 1_000;

/** The share of each table past the cutoff at the `overdue` reading. */
const OVERDUE_SHARE = 0.1;

/**
 * Pages below which a saving is not worth an index, for grouping the tables in the published prose.
 *
 * Twenty 8 KiB pages is under a tenth of a millisecond at every reading here, and the smallest index
 * this measurement built is 48 KiB — six pages to keep, updated on every insert, to save fewer than
 * twenty on a read that runs when somebody opens a settings page.
 */
const NEGLIGIBLE_PAGES = 20;

type Cutoff = 'inside' | 'overdue';

/** One statement, planned and executed, with what the plan touched. */
interface Timing {
  /** The top plan node, which is the answer to "did it use the index". */
  readonly node: string;
  readonly medianMs: number;
  /** Pages the plan read, hit and missed together. Transport-independent, unlike the duration. */
  readonly buffers: number;
  readonly rows: number;
}

interface Statement {
  /** `total`, `eligible`, `oldest` or `delete`. */
  readonly which: string;
  readonly cutoff: Cutoff;
  readonly without: Timing;
  /** Absent for a table that already has an index led by its stamp: there is nothing to add. */
  readonly with?: Timing;
}

interface TableReading {
  readonly table: string;
  readonly stamp: string;
  readonly rows: number;
  readonly provenance: string;
  readonly derives: string;
  /** How far the shipped indexes reach the stamp — read from the catalogue, not transcribed. */
  readonly reach: Reach;
  /** The index that reaches it, if one does. Named whether it leads with the stamp or merely holds it. */
  readonly ledBy?: string;
  readonly heapBytes: number;
  /** What the candidate index would occupy. Absent when one already exists. */
  readonly indexBytes?: number;
  /** Milliseconds to insert `WRITE_SAMPLE_ROWS`, without the candidate index and with it. */
  readonly writeMs?: { readonly without: number; readonly with: number };
  readonly statements: readonly Statement[];
}

interface Recording {
  readonly measuredAt: string;
  readonly apparatus: {
    readonly postgres: string;
    readonly node: string;
    readonly samples: number;
    readonly overdueShare: number;
    readonly writeSampleRows: number;
    readonly runCadenceDays: number;
  };
  readonly requirements: number;
  /** What the catalogue was multiplied by. The published reading is 1; anything else is an experiment. */
  readonly times: number;
  readonly readings: readonly TableReading[];
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));

  if (flags.has('--check')) {
    check();
    process.stdout.write('The retention sweep table quotes the recording.\n');
    return;
  }

  const endpoint = (process.env['WAF_BENCH_PG'] ?? '').trim();
  if (flags.has('--publish') && endpoint === '') {
    publish(read());
    process.stdout.write('Rewrote the table in docs/design/retention-sweep-cost.md from the recording.\n');
    return;
  }
  if (endpoint === '') {
    process.stderr.write(
      'WAF_BENCH_PG is unset, so there is no Postgres to measure against. Point it at a database this\n' +
        'run may create schemas in — a local cluster is enough. `--check` needs no database.\n'
    );
    process.exit(2);
  }

  // The invariant before anything is measured, rather than after. A table the sweep visits with no
  // volume would be seeded at zero rows, come out needing no index, and be published as a decision.
  const missing = unsized();
  if (missing.unsized.length > 0 || missing.unswept.length > 0) {
    throw new Error(
      `retention-volume.ts and RETAINED disagree — unsized: ${missing.unsized.join(', ') || 'none'}; ` +
        `unswept: ${missing.unswept.join(', ') || 'none'}. A table with no volume measures as empty.`
    );
  }

  // Every volume in `retention-volume.ts` is a retention period divided by a cadence, so the sweep
  // is what bounds these tables and none of them grows with time. The catalogue is the one free
  // variable, and `--times` multiplies it: the published reading is at 1, and a larger one answers
  // whether the decision this row records survives an estate several times this catalogue's size.
  // Extrapolating that from the 1× reading is what `H1` did wrong, so it is measured instead.
  const asked = [...flags].map((one) => /^--times=(.+)$/.exec(one)?.[1]).find((one) => one != null);
  const times = asked == null ? 1 : Number(asked);
  if (!Number.isFinite(times) || times < 1) {
    throw new Error(`--times takes a number of at least 1, not ${String(asked)}`);
  }
  const requirements = Math.round(loadCatalogue().controls.length * times);
  const pool = new pg.Pool({ connectionString: endpoint, max: 4 });
  const schema = `sweep_${String(Date.now() % 100_000)}`;

  try {
    const version = await pool.query<{ version: string }>('select version()');
    await open(pool, schema);
    process.stdout.write(`Seeding ${String(RETAINED.length)} sweep entries into ${schema}\n`);
    const seeded = await seed(pool, schema, requirements);
    await settle(pool, schema);

    const readings: TableReading[] = [];
    for (const entry of distinct(RETAINED)) {
      const reading = await measure(pool, schema, entry, seeded.get(entry.table) ?? 0);
      readings.push(reading);
      report(reading);
    }

    const recording: Recording = {
      measuredAt: new Date().toISOString(),
      apparatus: {
        postgres: (version.rows[0]?.version ?? 'unknown').split(' ').slice(0, 2).join(' '),
        node: process.version,
        samples: SAMPLES,
        overdueShare: OVERDUE_SHARE,
        writeSampleRows: WRITE_SAMPLE_ROWS,
        runCadenceDays: RUN_CADENCE_DAYS,
      },
      requirements,
      times,
      readings,
    };

    // A `--times` run is an experiment about a catalogue this app does not have, and the recording
    // is what the published table is checked against. Writing one over the other would put a
    // hypothetical estate's numbers in a document that says they are this one's.
    if (times !== 1) {
      process.stdout.write(
        `\nMeasured at ${String(times)}× the catalogue (${String(requirements)} requirements). ` +
          'Not recorded and not published — the recording is the 1× reading.\n' +
          `  ${summarise(readings)}\n`
      );
      return;
    }

    mkdirSync(dirname(RECORDING), { recursive: true });
    writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
    process.stdout.write(`\nRecorded ${String(readings.length)} tables in scripts/recordings/retention-sweeps.json\n`);
    if (flags.has('--publish')) {
      publish(recording);
      process.stdout.write('Published the table in docs/design/retention-sweep-cost.md\n');
    }
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`).catch(() => undefined);
    await pool.end();
  }
}

/**
 * The sweep entries, one per table.
 *
 * `RETAINED` holds `runs` and `run_attempts` twice each — the same table split by run kind so the two
 * kinds can carry different periods. A measurement per entry would price one table twice and publish
 * two rows a reader would read as two tables. The `only` clause differs between the pair and the
 * access path does not, so the first entry stands for both and the published row says which.
 */
function distinct(entries: readonly Retained[]): readonly Retained[] {
  const seen = new Set<string>();
  return entries.filter((one) => (seen.has(one.table) ? false : (seen.add(one.table), true)));
}

async function open(pool: pg.Pool, schema: string): Promise<void> {
  const sql: Sql = {
    query: async (text, values) => {
      const answer = await pool.query(text, values as unknown[]);
      return { rows: answer.rows as never[] };
    },
  };
  await ensureSchema(sql, schema);
}

/**
 * Every swept table filled to its volume, with stamps spread across its own retention period.
 *
 * The spread is what makes the two cutoffs mean anything. Rows are stamped evenly from the period's
 * start to now, so a cutoff at the period boundary catches nothing and one a tenth of the way in
 * catches a tenth — which is the fraction the published table names.
 */
async function seed(
  pool: pg.Pool,
  schema: string,
  requirements: number
): Promise<ReadonlyMap<string, number>> {
  const counts = new Map<string, number>();
  for (const entry of distinct(RETAINED)) {
    const volume = SWEPT_VOLUMES.find((one) => one.table === entry.table);
    if (volume == null) throw new Error(`No volume for ${entry.table}.`);
    const rows = volume.rows(requirements);
    const days = DEFAULT_PERIOD_DAYS[entry.retentionClass];

    // In batches, because one insert of a hundred thousand rows exceeds the parameter limit and a
    // row at a time takes longer than the measurement it feeds.
    const BATCH = 500;
    for (let from = 0; from < rows; from += BATCH) {
      const batch = Array.from({ length: Math.min(BATCH, rows - from) }, (_, index) =>
        rowFor(entry.table, from + index, rows, days)
      );
      await insertAll(pool, schema, entry.table, batch);
    }
    counts.set(entry.table, rows);
    process.stdout.write(`  ${entry.table.padEnd(26)} ${String(rows).padStart(7)} rows\n`);
  }
  return counts;
}

async function insertAll(
  pool: pg.Pool,
  schema: string,
  table: string,
  rows: readonly Readonly<Record<string, unknown>>[]
): Promise<void> {
  const first = rows[0];
  if (first == null) return;
  const columns = Object.keys(first);
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const holes = columns.map((column) => {
      values.push(row[column]);
      return `$${String(values.length)}`;
    });
    return `(${holes.join(',')})`;
  });
  await pool.query(
    `insert into ${schema}.${table} (${columns.join(',')}) values ${tuples.join(',')} on conflict do nothing`,
    values
  );
}

/** Statistics and a flushed index, for the reason `measure-history-reads.mts` gives at length. */
async function settle(pool: pg.Pool, schema: string): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    'select tablename from pg_tables where schemaname = $1',
    [schema]
  );
  for (const { tablename } of rows) await pool.query(`vacuum analyze ${schema}.${tablename}`);
}

/** Where the stamp sits in the best index that mentions it at all. */
export type Reach = 'leads' | 'covers' | 'absent';

/**
 * How far the existing indexes reach the stamp, read from the catalogue.
 *
 * Read rather than transcribed from the row's own table, which is the apparatus rule: `83` listed
 * sixteen tables by hand off the DDL, and a list written by hand is a list that can be wrong about
 * the schema it describes.
 *
 * Three states rather than two, because measuring proved the two-state version wrong. It tested
 * `attnum = indkey[0]` alone and called everything else unindexed, on the reasoning that an index
 * mentioning the stamp in second position cannot serve a predicate on the stamp. It can:
 * `attestations` is indexed on `(control_id, attested_at)` and the planner takes an index-only scan
 * over the whole index, reading 58 pages where the heap would have cost 1,068. That is not as cheap
 * as a leading index but it is not the same cost class as a scan, and a table already there has far
 * less to gain from a new index than the count of sixteen implies.
 */
async function reachOf(
  pool: pg.Pool,
  schema: string,
  table: string,
  stamp: string
): Promise<{ reach: Reach; index?: string }> {
  const { rows } = await pool.query<{ index: string; position: number }>(
    `select i.relname as index, array_position(x.indkey::int[], a.attnum) as position
       from pg_index x
       join pg_class t on t.oid = x.indrelid
       join pg_class i on i.oid = x.indexrelid
       join pg_namespace n on n.oid = t.relnamespace
       join pg_attribute a on a.attrelid = t.oid and a.attname = $3
      where n.nspname = $1 and t.relname = $2 and a.attnum = any(x.indkey::int[])
      order by position asc
      limit 1`,
    [schema, table, stamp]
  );
  const best = rows[0];
  if (best == null) return { reach: 'absent' };
  return { reach: best.position === 0 ? 'leads' : 'covers', index: best.index };
}

/** One statement, run `SAMPLES` times under `EXPLAIN (ANALYZE, BUFFERS)`, with the median taken. */
async function timeOne(pool: pg.Pool, text: string, values: readonly unknown[]): Promise<Timing> {
  const durations: number[] = [];
  let node = 'unknown';
  let buffers = 0;
  let rows = 0;

  for (let sample = 0; sample < SAMPLES; sample += 1) {
    // In a transaction that is rolled back, so a `delete` measured here does not empty the fixture
    // the next statement is measured against. `EXPLAIN ANALYZE` executes; that is the point of it.
    const client = await pool.connect();
    try {
      await client.query('begin');
      const explained = await client.query<{ 'QUERY PLAN': readonly PlanEnvelope[] }>(
        `explain (analyze, buffers, format json) ${text}`,
        values as unknown[]
      );
      await client.query('rollback');
      const plan = explained.rows[0]?.['QUERY PLAN']?.[0];
      if (plan == null) throw new Error(`No plan for: ${text}`);
      durations.push(plan['Execution Time']);
      node = plan.Plan['Node Type'];
      buffers = pagesIn(plan.Plan);
      rows = plan.Plan['Actual Rows'];
    } finally {
      client.release();
    }
  }

  const sorted = [...durations].sort((a, b) => a - b);
  return { node, medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0), buffers, rows };
}

interface PlanNode {
  readonly 'Node Type': string;
  readonly 'Actual Rows': number;
  readonly 'Shared Hit Blocks'?: number;
  readonly 'Shared Read Blocks'?: number;
  readonly Plans?: readonly PlanNode[];
}

interface PlanEnvelope {
  readonly Plan: PlanNode;
  readonly 'Execution Time': number;
}

/**
 * Pages the whole plan touched, hit and read together.
 *
 * The root's counters are cumulative — Postgres rolls each node's buffer usage up into its parent —
 * so this reads the root and stops. An earlier version summed the tree and reported exactly twice
 * the truth on every two-node plan here: `select count(*)` over a sequential scan came back as 2,136
 * pages for a 1,068-page table. Verified by hand against `accepted_risks`, where the Aggregate and
 * the Seq Scan beneath it each report the same 1,068.
 */
function pagesIn(node: PlanNode): number {
  return (node['Shared Hit Blocks'] ?? 0) + (node['Shared Read Blocks'] ?? 0);
}

/** Bytes a relation occupies, table or index, straight from the catalogue. */
async function bytesOf(pool: pg.Pool, qualified: string): Promise<number> {
  const { rows } = await pool.query<{ bytes: string }>('select pg_relation_size($1)::text as bytes', [qualified]);
  return Number(rows[0]?.bytes ?? '0');
}

/** How long `WRITE_SAMPLE_ROWS` inserts take, which is the cost an index is paid for with. */
async function writeCost(pool: pg.Pool, schema: string, table: string, rows: number, days: number): Promise<number> {
  // Continuing the sequence past the seeded rows rather than jumping to an arbitrary offset. The
  // jump was a million, and on the one table whose key space is a product of two small counts it
  // asked for a row that could not exist.
  const batch = Array.from({ length: WRITE_SAMPLE_ROWS }, (_, index) =>
    rowFor(table, rows + index, rows + WRITE_SAMPLE_ROWS, days)
  );
  const client = await pool.connect();
  try {
    await client.query('begin');
    const started = performance.now();
    for (let from = 0; from < batch.length; from += 500) {
      const slice = batch.slice(from, from + 500);
      const first = slice[0];
      if (first == null) continue;
      const columns = Object.keys(first);
      const values: unknown[] = [];
      const tuples = slice.map((row) => {
        const holes = columns.map((column) => {
          values.push(row[column]);
          return `$${String(values.length)}`;
        });
        return `(${holes.join(',')})`;
      });
      await client.query(
        `insert into ${schema}.${table} (${columns.join(',')}) values ${tuples.join(',')} on conflict do nothing`,
        values
      );
    }
    const took = performance.now() - started;
    await client.query('rollback');
    return round(took);
  } finally {
    client.release();
  }
}

/** Every statement the sweep sends at one table, at both cutoffs, with the index and without. */
async function measure(pool: pg.Pool, schema: string, entry: Retained, rows: number): Promise<TableReading> {
  const volume = SWEPT_VOLUMES.find((one) => one.table === entry.table);
  const days = DEFAULT_PERIOD_DAYS[entry.retentionClass];
  const { reach, index: named } = await reachOf(pool, schema, entry.table, entry.stamp);
  const qualified = `${schema}.${entry.table}`;

  const cutoffs: Readonly<Record<Cutoff, Date>> = {
    // The period boundary. Every seeded row is inside it, so nothing is eligible.
    inside: at(days),
    // A tenth of the way past the oldest row, which catches a tenth of the table.
    overdue: at(days * (1 - OVERDUE_SHARE)),
  };

  const statements = (cutoff: Cutoff): readonly (readonly [string, string, readonly unknown[]])[] => {
    const before = cutoffs[cutoff];
    // Composed with the bench schema, the way the gateway composes it with the app's. Passing the
    // clause unqualified is what `86` was, and this measurement is how it was found.
    const only = entry.only?.(schema);
    // The audit log is counted the way it is cut — by sequence, from the first event that must be
    // kept — so its eligible count is a different statement from every other table's. Measuring it
    // with `where at < $1` would be a reading about a sweep this app does not run.
    const eligible =
      entry.table === CHAINED_TABLE
        ? `select sequence from ${qualified} where at >= $1 order by sequence asc limit 1`
        : `select count(*) as total from ${qualified} where ${entry.stamp} < $1${and(only)}`;
    return [
      ['total', `select count(*) as total from ${qualified}${where(only)}`, []],
      ['eligible', eligible, [before]],
      ['oldest', `select ${entry.stamp} as oldest from ${qualified}${where(only)} order by ${entry.stamp} asc limit 1`, []],
      ...(cutoff === 'overdue' && entry.table !== CHAINED_TABLE
        ? ([['delete', `delete from ${qualified} where ${entry.stamp} < $1${and(only)}`, [before]]] as const)
        : []),
    ];
  };

  const taken: Statement[] = [];
  for (const cutoff of ['inside', 'overdue'] as const) {
    for (const [which, text, values] of statements(cutoff)) {
      taken.push({ which, cutoff, without: await timeOne(pool, text, values) });
    }
  }

  const reading: TableReading = {
    table: entry.table,
    stamp: entry.stamp,
    rows,
    provenance: volume?.provenance ?? 'assumed',
    derives: volume?.derives ?? '',
    reach,
    ...(named != null ? { ledBy: named } : {}),
    heapBytes: await bytesOf(pool, qualified),
    statements: taken,
  };
  if (reach === 'leads') return reading;

  // Nothing leads with the stamp, so the candidate is built, everything is measured again, and it
  // is dropped — the schema this run measures the next table against has to be the shipped one. A
  // table an index already *covers* is measured too: what a leading index adds over an index-only
  // scan of a wider one is the whole question for those, and it is not answerable by assuming.
  const candidate = `bench_${entry.table}_by_${entry.stamp}`;
  const before = await writeCost(pool, schema, entry.table, rows, days);
  await pool.query(`create index ${candidate} on ${qualified} (${entry.stamp})`);
  await pool.query(`analyze ${qualified}`);
  const after = await writeCost(pool, schema, entry.table, rows, days);
  const indexBytes = await bytesOf(pool, `${schema}.${candidate}`);

  const withIndex: Statement[] = [];
  for (const cutoff of ['inside', 'overdue'] as const) {
    for (const [which, text, values] of statements(cutoff)) {
      const found = taken.find((one) => one.which === which && one.cutoff === cutoff);
      if (found == null) continue;
      withIndex.push({ ...found, with: await timeOne(pool, text, values) });
    }
  }

  await pool.query(`drop index ${schema}.${candidate}`);
  await pool.query(`analyze ${qualified}`);

  return { ...reading, indexBytes, writeMs: { without: before, with: after }, statements: withIndex };
}

/**
 * A cutoff, measured back from the instant the fixtures stamp their rows from.
 *
 * `Date.now()` here rather than `ORIGIN` would sit minutes past the stamps by the time the last table
 * is measured, which moves the boundary between eligible and not by however long the seeding took.
 * The fixture module keeps the origin fixed for exactly this; reading the clock again would undo it.
 */
function at(daysAgo: number): Date {
  return new Date(ORIGIN.getTime() - daysAgo * 24 * 60 * 60 * 1000);
}

function report(reading: TableReading): void {
  const eligible = reading.statements.find((one) => one.which === 'eligible' && one.cutoff === 'inside');
  const gain =
    eligible?.with == null || eligible.without.buffers === 0
      ? 'leads already'
      : `${String(eligible.without.buffers)} to ${String(eligible.with.buffers)} pages`;
  process.stdout.write(
    `  ${reading.table.padEnd(26)} ${String(reading.rows).padStart(7)} rows  ${reading.reach.padEnd(7)} ` +
      `${(eligible?.without.node ?? '').padEnd(18)} ${gain}\n`
  );
}

/**
 * Whether a table's row count answers to the catalogue, computed by asking its volume twice.
 *
 * The decision this row records turns on this as much as on the pages: a table that scans the heap
 * and grows with the catalogue is a different case from one that scans it and cannot. `no` is not
 * `bounded`, and the prose says so — every count in `retention-volume.ts` is a retention period over
 * a cadence, and `MAX_PERIOD_DAYS` lets an administrator ask for a hundred years. This reports the
 * one dimension it can vary rather than guessing at the other.
 */
function growsWith(table: string): string {
  const volume = SWEPT_VOLUMES.find((one) => one.table === table);
  if (volume == null) return '—';
  return volume.rows(1840) > volume.rows(184) ? 'catalogue' : 'no';
}

/**
 * What a whole sweep costs, which is the number the indexing decision turns on.
 *
 * Per table the difference is a rounding error either way; it is the sum over all of them, at both
 * cutoffs, that says whether sixteen indexes are worth their write cost. Printed rather than
 * recorded for a `--times` run, because that reading describes a catalogue this app does not have.
 */
function summarise(readings: readonly TableReading[]): string {
  const spent = (take: (one: Statement) => Timing | undefined): number =>
    readings.reduce((total, one) => total + one.statements.reduce((sum, s) => sum + (take(s)?.medianMs ?? 0), 0), 0);
  const without = spent((one) => one.without);
  const with_ = spent((one) => one.with ?? one.without);
  const largest = [...readings].sort((a, b) => b.rows - a.rows)[0];
  return (
    `Every statement of a whole sweep: ${ms(without)} as shipped, ${ms(with_)} with every candidate index. ` +
    `Largest table ${largest?.table ?? '—'} at ${(largest?.rows ?? 0).toLocaleString('en-GB')} rows.`
  );
}

/** `a, b and c` — so a generated list reads like a sentence rather than a join. */
function listed(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1] ?? ''}`;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ms`;
}

function kib(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB` : `${Math.round(bytes / 1024)} KiB`;
}

/**
 * The published table, one row per swept table.
 *
 * The `inside` cutoff is what the columns show, because it is the case the retention page is opened
 * in and the one an index changes most. The `overdue` figures are in the recording and in the
 * sentences under the table, which name the tables where the two disagree.
 */
function figureTable(recording: Recording): string {
  const lines = [
    START,
    '',
    '| Table | Rows | Grows with | Swept on | Index reaching it | Pages, counting eligible | With an index | Index size |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
  ];

  const ordered = [...recording.readings].sort((a, b) => b.rows - a.rows);
  for (const reading of ordered) {
    const eligible = reading.statements.find((one) => one.which === 'eligible' && one.cutoff === 'inside');
    if (eligible == null) continue;
    lines.push(
      `| \`${reading.table}\` | ${reading.rows.toLocaleString('en-GB')} | ${growsWith(reading.table)} | \`${reading.stamp}\` | ` +
        `${reading.ledBy == null ? '—' : `\`${reading.ledBy}\` ${reading.reach}`} | ` +
        `${eligible.without.buffers.toLocaleString('en-GB')} · ${ms(eligible.without.medianMs)} | ` +
        `${eligible.with == null ? 'n/a' : `${eligible.with.buffers.toLocaleString('en-GB')} · ${ms(eligible.with.medianMs)}`} | ` +
        `${reading.indexBytes == null ? '—' : kib(reading.indexBytes)} |`
    );
  }

  lines.push(
    '',
    `Rows come from \`retention-volume.ts\`, which derives each table's count from this app's own ` +
      `periods and states an assumption where no constant bounds one — ` +
      `${String(recording.readings.filter((one) => one.provenance === 'derived').length)} of ` +
      `${String(recording.readings.length)} are derived and the rest assumed, the run cadence at ` +
      `${String(recording.apparatus.runCadenceDays)} days being the assumption nine of them rest on. ` +
      `Pages are shared buffers hit and read, at the \`inside\` cutoff — an install younger than its ` +
      `retention period, where nothing is eligible, which is the state the retention page is opened ` +
      `in. Measured on ${recording.apparatus.postgres} under Node ${recording.apparatus.node}, ` +
      `${String(recording.apparatus.samples)} samples per statement, ${recording.measuredAt.slice(0, 10)}.`,
    '',
    ...finding(recording),
    END
  );
  return `${lines.join('\n')}\n`;
}

/** The sentences that name what the reading decided, generated so they cannot drift from the table. */
function finding(recording: Recording): readonly string[] {
  const candidates = recording.readings.filter((one) => one.reach !== 'leads');
  const pages = (reading: TableReading, cutoff: Cutoff): { without: number; with?: number } => {
    const found = reading.statements.filter((one) => one.cutoff === cutoff);
    return {
      without: found.reduce((total, one) => total + one.without.buffers, 0),
      ...(found.every((one) => one.with != null)
        ? { with: found.reduce((total, one) => total + (one.with?.buffers ?? 0), 0) }
        : {}),
    };
  };

  const saved = candidates
    .map((reading) => ({ reading, ...pages(reading, 'inside') }))
    .filter((one): one is { reading: TableReading; without: number; with: number } => one.with != null)
    .sort((a, b) => b.without - b.with - (a.without - a.with));

  const best = saved[0];
  if (best == null) return [];

  const total = saved.reduce((sum, one) => sum + one.without, 0);
  const kept = saved.reduce((sum, one) => sum + one.with, 0);
  const said = [
    `Opening the retention page reads ${total.toLocaleString('en-GB')} pages across the ` +
      `${String(candidates.length)} tables no index leads, and would read ${kept.toLocaleString('en-GB')} ` +
      `with one on each — every statement at the \`inside\` cutoff, so these are larger than the ` +
      `eligible-count column alone. The largest single saving is \`${best.reading.table}\`: ` +
      `${best.without.toLocaleString('en-GB')} pages to ${best.with.toLocaleString('en-GB')}, for an ` +
      `index of ${kib(best.reading.indexBytes ?? 0)}.`,
  ];

  // Three groups rather than two, because the measurement found all three. Named rather than left
  // for a reader to infer from a table of numbers: this is the half of the reading `83` says has to
  // be recorded as a decision, and generating it means the decision cannot outlive its own numbers.
  // An earlier version had one group and called every table in it a saving, which put
  // `month_publications` — 525 pages *worse* with the index — in a list of tables that save.
  const grouped = (one: (typeof saved)[number]): 'earns' | 'negligible' | 'costs' => {
    if (one.with > one.without) return 'costs';
    return one.without - one.with < NEGLIGIBLE_PAGES ? 'negligible' : 'earns';
  };
  const name = (one: (typeof saved)[number]): string =>
    `\`${one.reading.table}\` (${String(one.without)} to ${String(one.with)})`;

  const costs = saved.filter((one) => grouped(one) === 'costs');
  const negligible = saved.filter((one) => grouped(one) === 'negligible');
  const earns = saved.filter((one) => grouped(one) === 'earns');

  if (earns.length > 0) {
    const growing = earns.filter((one) => growsWith(one.reading.table) === 'catalogue');
    said.push(
      '',
      `${String(earns.length)} of the ${String(candidates.length)} save more than ` +
        `${String(NEGLIGIBLE_PAGES)} pages: ${listed(earns.map(name))}. ` +
        (growing.length === 0
          ? 'None of them grows with the catalogue, so what each saves now is what it saves, and this ' +
            'reading declines them on that ground rather than on the size of the saving.'
          : `${String(growing.length)} of those grow with the catalogue — ` +
            `${listed(growing.map((one) => `\`${one.reading.table}\``))} — so the saving grows with it ` +
            `too, and they are the candidates this reading puts forward.`)
    );
  }

  if (negligible.length > 0) {
    said.push(
      '',
      `${String(negligible.length)} ${negligible.length === 1 ? 'saves' : 'save'} fewer than ` +
        `${String(NEGLIGIBLE_PAGES)} pages, which is under a tenth of a millisecond: ` +
        `${negligible.map(name).join(', ')}. An index there costs more to keep than it returns.`
    );
  }

  if (costs.length > 0) {
    // Two reasons, not one. A table already covered by a wider index is not a small table, and
    // saying it is would be a sentence more specific than the field under it.
    const covered = costs.filter((one) => one.reading.reach === 'covers');
    const small = costs.filter((one) => one.reading.reach !== 'covers');
    said.push(
      '',
      `${String(costs.length)} are **worse** with the index than without: ${costs.map(name).join(', ')}.` +
        (small.length > 0
          ? ` For ${listed(small.map((one) => `\`${one.reading.table}\``))} the table is small enough that ` +
            `reading it whole beats reading an index and then reading it.`
          : '') +
        (covered.length > 0
          ? ` For ${listed(covered.map((one) => `\`${one.reading.table}\``))} an index already reaches the ` +
            `stamp without leading on it, so the planner already takes an index-only scan and the ` +
            `candidate adds a second thing to keep for a plan that was not reading the heap anyway.`
          : '')
    );
  }

  // The indexes this reading justified now lead, so the rows that carried the evidence for them read
  // `leads` like any other and their saving is no longer in the table. Naming them keeps the decision
  // legible from the document rather than from the recording's history. `_by_sweep` is the convention
  // `83` shipped them under, and it is the only thing distinguishing them from an index that predates
  // the measurement.
  const shipped = recording.readings.filter((one) => one.ledBy?.endsWith('_by_sweep') === true);
  if (shipped.length > 0) {
    said.push(
      '',
      `${String(shipped.length)} tables read 2 or 3 pages here because \`83\` gave them an index and ` +
        `this measurement is of the schema that shipped: ` +
        `${listed(shipped.map((one) => `\`${one.ledBy ?? ''}\``))}. What each saved is in the reading ` +
        `taken before they existed, and in the comment above each one in \`postgres.ts\`.`
    );
  }

  const write = candidates.filter((one) => one.writeMs != null && one.writeMs.without > 0);
  if (write.length > 0) {
    const slowest = [...write].sort(
      (a, b) => (b.writeMs?.with ?? 0) / (b.writeMs?.without ?? 1) - (a.writeMs?.with ?? 0) / (a.writeMs?.without ?? 1)
    )[0];
    if (slowest?.writeMs != null) {
      said.push(
        '',
        `The write cost, measured as ${String(recording.apparatus.writeSampleRows)} inserts into a table ` +
          `already at volume: the index slows the worst of them, \`${slowest.table}\`, from ` +
          `${ms(slowest.writeMs.without)} to ${ms(slowest.writeMs.with)}.`
      );
    }
  }
  return said;
}

function replaceBlock(doc: string, block: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/design/retention-sweep-cost.md is missing the generated-table markers ${START}`);
  }
  return `${doc.slice(0, start)}${block}${doc.slice(end + END.length).replace(/^\n/, '')}`;
}

function read(): Recording {
  if (!existsSync(RECORDING)) {
    throw new Error(`No recording at ${RECORDING}. Run the benchmark against a database first.`);
  }
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
  if (recording.readings.length === 0) throw new Error('The retention-sweep recording holds no readings.');
  return recording;
}

function publish(recording: Recording): void {
  if (!existsSync(DOC)) throw new Error(`No document at ${DOC}`);
  writeFileSync(DOC, replaceBlock(readFileSync(DOC, 'utf8'), figureTable(recording)));
}

/** The published table against the recording, for the reason `measure-history-reads.mts` gives. */
function check(): void {
  const recording = read();
  const doc = readFileSync(DOC, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error('docs/design/retention-sweep-cost.md is missing the generated-table markers.');
  if (`${doc.slice(start, end + END.length)}\n` !== figureTable(recording)) {
    throw new Error(
      'The table in docs/design/retention-sweep-cost.md is stale against scripts/recordings/retention-sweeps.json.\n' +
        '  Run `npm run measure:retention-sweeps -- --publish` against a database, or `--publish` alone if the\n' +
        '  numbers are unchanged and only the table drifted.'
    );
  }
}

await main();
