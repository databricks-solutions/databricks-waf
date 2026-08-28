/*
 * What the reads that load a whole record history cost, at the volume this app's own settings imply.
 *
 * `GAP-025` says six store reads load every revision of every record and filter in TypeScript. That is
 * a shape, not yet a defect: it costs nothing at forty rows. `46a` exists to find out what it costs at
 * the volume the app allows to accumulate, before `46b` reworks anything — because the measurement is
 * what decides which of the six is urgent and whether the other five are worth touching. H1 is the
 * worked example of skipping this step: eight statements were listed as past a cap, one was, and the
 * rework as planned would have reworked four that had room to spare.
 *
 * The volume is not a guess. `history-volume.ts` derives it from two constants the app ships — a
 * seven-year governance retention default and a ninety-day shortest cadence — and the catalogue's own
 * size. The records are not a guess either: `history-fixtures.ts` builds them as wide as their own type
 * declarations, and `history-fixtures.test.ts` fails when one is narrower.
 *
 * What this cannot say, said here rather than in the recording alone:
 *
 *   `LAKEBASE_ENDPOINT` binds the labs instance the way the live suite does; `WAF_BENCH_PG` remains
 *   for a local cluster. A recording that does not name which path it used is the failure `56` was
 *   raised for. The laptop-to-Lakebase TLS hop is the transport an install has; this process is not
 *   the app's Node on the platform.
 *
 *   Peak heap is sampled every two milliseconds rather than traced, so a spike shorter than that is
 *   missed and every heap figure is a lower bound. What it measures is the heap a read grows while it
 *   is in flight — the transient cost, which for these reads is most of the cost, because four of the
 *   five reduce ten thousand rows to a few hundred records and throw the rest away.
 *
 *   It does not say what an answer *retains*, and three versions of that measurement were written and
 *   deleted before this one shipped. `heapUsed` after a forced collection did not move for an answer of
 *   ten thousand records held in a local, and did not fall when that answer was released — so the
 *   instrument could not distinguish holding from having held, and a figure taken with it would have
 *   read as "these reads retain nothing", which is a claim nobody checked. What survives is the peak,
 *   and `tableBytes` beside it: the bodies the read's table holds, straight from `octet_length`, which
 *   is a fact about the database rather than about V8's accounting.
 *
 *   Warm durations are a median after a warmup run, as before. Cold durations are a median of the
 *   same count of samples, each taken after a filler table has evicted `shared_buffers` and
 *   `DISCARD ALL` has cleared the session. That is the coldest figure Lakebase will let a customer
 *   take without restarting compute: there is no `pg_buffercache`, and the role cannot drop the
 *   host's page cache. A recording that does not name its path is the failure `56` was raised for.
 *
 *   node --expose-gc --import tsx scripts/measure-history-reads.mts            # measure and record
 *   node --expose-gc --import tsx scripts/measure-history-reads.mts --publish  # rewrite the table
 *   node --import tsx scripts/measure-history-reads.mts --check                # doc against recording
 *
 * Lakebase, the way the live suite reaches a provisioned instance:
 *
 *   unset DATABRICKS_HOST DATABRICKS_TOKEN
 *   DATABRICKS_CONFIG_PROFILE=your-profile \
 *   LAKEBASE_ENDPOINT=ep-….database.….cloud.databricks.com \
 *   node --expose-gc --import tsx scripts/measure-history-reads.mts --publish
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLakebasePool, getUsernameWithApiLookup, getWorkspaceClient } from '@databricks/lakebase';
import pg from 'pg';
import { digestOf } from '../server/records/digest.js';
import { loadCatalogue } from '../server/catalogue/catalogue.js';
import { ensureSchema, type Postgres, type Sql } from '../server/store/postgres.js';
import { PostgresDefinitionStore } from '../server/define/postgres-store.js';
import { PostgresApplicabilityStore } from '../server/apply/postgres-store.js';
import { PostgresRiskStore } from '../server/accept/postgres-store.js';
import { PostgresAttestationStore } from '../server/attest/postgres-store.js';
import { PostgresImprovementStore } from '../server/improve/postgres-store.js';
import { PostgresNoteStore } from '../server/note/postgres-store.js';
import { PostgresValidationStore } from '../server/validate/postgres-store.js';
import {
  GOVERNANCE_DAYS,
  GROWTH_MARGIN,
  HISTORY_READS,
  REVISIONS_PER_REQUIREMENT,
  SHORTEST_CADENCE_DAYS,
  rowsIn,
  volumes,
  type HistoryVolume,
} from '../server/store/history-volume.js';
import {
  actions,
  attestations,
  attempts,
  decisions,
  definition,
  note,
  plan,
  requirementIds,
  risks,
} from '../server/store/history-fixtures.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const ROOT = join(APP, '..');
const RECORDING = join(HERE, 'recordings', 'history-reads.json');
const DOC = join(ROOT, 'docs', 'design', 'history-read-budget.md');

const START = '<!-- generated: history read budget. Run `npm run measure:history-reads -- --publish`. -->';
const END = '<!-- end generated -->';

/** Samples per read. Five, so the middle one is a median rather than the better of two. */
const SAMPLES = Number(process.env['SAMPLES'] ?? '5');

/** How often peak heap is sampled while a read is in flight. */
const SAMPLE_INTERVAL_MS = 2;

interface Reading {
  readonly read: string;
  readonly volume: string;
  /** Rows this read's own statements returned, counted at the driver rather than off the table. */
  readonly fetched: number;
  /** Records the read answered with, after the reduction. */
  readonly answered: number;
  /** `octet_length` of every body in the table the read draws from, at this volume. */
  readonly tableBytes: number;
  readonly medianMs: number;
  /** Median of the same count of samples, each after shared_buffers was evicted and the session discarded. */
  readonly coldMs: number;
  readonly slowestMs: number;
  readonly slowestColdMs: number;
  /** Highest sampled heap while the read was in flight, over the baseline. A lower bound — see the header. */
  readonly peakHeapBytes: number;
}

interface Recording {
  readonly measuredAt: string;
  readonly apparatus: {
    readonly postgres: string;
    readonly node: string;
    readonly samples: number;
    readonly sampleIntervalMs: number;
    readonly collectorAvailable: boolean;
    /** `lakebase` when `LAKEBASE_ENDPOINT` bound the run; `local` when `WAF_BENCH_PG` did. */
    readonly path: 'lakebase' | 'local';
    /** Hostname, or `unix` for a socket. Named so a recording cannot be quoted without saying where. */
    readonly host: string;
    readonly sharedBuffers: string;
    /** How the cold samples were made cold. `unavailable` means the run did not evict. */
    readonly cacheDrop: string;
  };
  readonly requirements: number;
  readonly volumes: readonly HistoryVolume[];
  readonly readings: readonly Reading[];
}

async function main(): Promise<void> {
  const flags = new Set(process.argv.slice(2));

  if (flags.has('--check')) {
    check();
    process.stdout.write('The history read budget table quotes the recording.\n');
    return;
  }

  const bound = (process.env['LAKEBASE_ENDPOINT'] ?? '').trim() !== '' || (process.env['WAF_BENCH_PG'] ?? '').trim() !== '';

  // Re-publishing the table from the recording, without measuring. This is what `--check`'s own failure
  // text tells the reader to run when the numbers are unchanged and only the table's shape moved, and
  // for one commit it was advice to a command that then asked for a database it did not need.
  if (flags.has('--publish') && !bound) {
    publish(read());
    process.stdout.write('Rewrote the table in docs/design/history-read-budget.md from the recording.\n');
    return;
  }

  if (!bound) {
    process.stderr.write(
      'Neither LAKEBASE_ENDPOINT nor WAF_BENCH_PG is set, so there is no Postgres to measure against.\n' +
        'Point LAKEBASE_ENDPOINT at the labs instance (the live-suite path) or WAF_BENCH_PG at a local\n' +
        'cluster. `--check` needs no database.\n'
    );
    process.exit(2);
  }

  const catalogue = loadCatalogue();
  const requirements = catalogue.controls.length;
  const measured: Reading[] = [];
  const { pool, path, host } = await openPool();

  try {
    const version = await pool.query<{ version: string; shared: string }>(
      "select version() as version, current_setting('shared_buffers') as shared"
    );
    for (const volume of volumes(requirements)) {
      const schema = `bench_${volume.name}_${String(Date.now() % 100_000)}`;
      process.stdout.write(`\n${volume.name}: ${String(rowsIn(volume))} rows in each register\n`);
      const db = await open(pool, schema);
      await seed(db, volume, requirements);
      await settle(pool, schema);
      await verify(db, requirements);
      for (const reading of await time(db, pool, volume)) {
        measured.push(reading);
        process.stdout.write(
          `  ${reading.read.padEnd(26)} ${ms(reading.coldMs).padStart(9)} cold  ${ms(reading.medianMs).padStart(9)} warm  ` +
            `${String(reading.fetched).padStart(7)} rows fetched  ${String(reading.answered).padStart(6)} answered  ` +
            `${mib(reading.peakHeapBytes).padStart(9)} peak heap\n`
        );
      }
      await pool.query(`drop schema ${schema} cascade`);
    }

    const recording: Recording = {
      measuredAt: new Date().toISOString(),
      apparatus: {
        postgres: (version.rows[0]?.version ?? 'unknown').split(' ').slice(0, 2).join(' '),
        node: process.version,
        samples: SAMPLES,
        sampleIntervalMs: SAMPLE_INTERVAL_MS,
        collectorAvailable: typeof global.gc === 'function',
        path,
        host,
        sharedBuffers: version.rows[0]?.shared ?? 'unknown',
        cacheDrop: 'shared-buffers-evicted-by-filler',
      },
      requirements,
      volumes: volumes(requirements),
      readings: measured,
    };

    mkdirSync(dirname(RECORDING), { recursive: true });
    writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
    process.stdout.write(`\nRecorded ${String(measured.length)} readings in scripts/recordings/history-reads.json\n`);
    if (flags.has('--publish')) {
      publish(recording);
      process.stdout.write('Published the table in docs/design/history-read-budget.md\n');
    }
  } finally {
    await pool.end();
  }
}

/**
 * A pool on the path the live suite uses.
 *
 * `LAKEBASE_ENDPOINT` wins, because that is the instance an install has. A provisioned host is an
 * ordinary Postgres client whose password is an OAuth token — the same route
 * `postgres.live.test.ts` takes. An Autoscaling `projects/…` path goes through
 * `@databricks/lakebase`. `WAF_BENCH_PG` remains for a local cluster.
 */
async function openPool(): Promise<{ pool: pg.Pool; path: 'lakebase' | 'local'; host: string }> {
  const lakebase = (process.env['LAKEBASE_ENDPOINT'] ?? '').trim();
  const bench = (process.env['WAF_BENCH_PG'] ?? '').trim();
  if (lakebase !== '') {
    if (lakebase.includes('/')) {
      const workspaceClient = getWorkspaceClient({});
      const user = await getUsernameWithApiLookup({ workspaceClient });
      const pool = createLakebasePool({ endpoint: lakebase, workspaceClient, ...(user != null ? { user } : {}) });
      return { pool, path: 'lakebase', host: 'autoscaling' };
    }
    const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'DEFAULT';
    const cli = (args: readonly string[]): Record<string, unknown> =>
      JSON.parse(execFileSync('databricks', [...args, '-p', profile], { encoding: 'utf8' })) as Record<string, unknown>;
    const pool = new pg.Pool({
      host: lakebase,
      port: 5432,
      database: process.env.PGDATABASE ?? 'databricks_postgres',
      user: String(cli(['current-user', 'me', '-o', 'json']).userName),
      password: String(cli(['auth', 'token']).access_token),
      ssl: true,
      max: 1,
    });
    return { pool, path: 'lakebase', host: lakebase };
  }
  return { pool: new pg.Pool({ connectionString: bench, max: 1 }), path: 'local', host: hostOf(bench) };
}

function hostOf(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return url.hostname === '' ? 'unix' : url.hostname;
  } catch {
    return connectionString.includes('/') ? 'unix' : 'unknown';
  }
}

/**
 * Evict `shared_buffers` by filling a table larger than it, then drop the table.
 *
 * Lakebase will not let this role drop the host page cache or read `pg_buffercache`. Filling
 * twice the configured buffers and scanning them is the eviction the instance actually permits.
 * `generate_series` runs on the server, so the bytes never cross the TLS link.
 */
async function evictSharedBuffers(pool: pg.Pool, schema: string): Promise<void> {
  const setting = await pool.query<{ v: string }>("select current_setting('shared_buffers') as v");
  const bytes = Math.max(parsePostgresSize(setting.rows[0]?.v ?? '128MB') * 2, 256 * 1024 * 1024);
  const rows = Math.ceil(bytes / 8000);
  await pool.query(`drop table if exists ${schema}.waf_evict`);
  await pool.query(`create table ${schema}.waf_evict (pad text)`);
  await pool.query(`insert into ${schema}.waf_evict select repeat('x', 8000) from generate_series(1, $1)`, [rows]);
  await pool.query(`select sum(length(pad)) from ${schema}.waf_evict`);
  await pool.query(`drop table ${schema}.waf_evict`);
}

function parsePostgresSize(raw: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*(kB|MB|GB|TB|B)?$/i.exec(raw.trim());
  if (match == null) return 128 * 1024 * 1024;
  const n = Number(match[1]);
  const unit = (match[2] ?? 'B').toUpperCase();
  if (unit === 'KB') return n * 1024;
  if (unit === 'MB') return n * 1024 * 1024;
  if (unit === 'GB') return n * 1024 * 1024 * 1024;
  if (unit === 'TB') return n * 1024 * 1024 * 1024 * 1024;
  return n;
}

/** A `Postgres` handle on one throwaway schema, with the app's own DDL run into it. */
async function open(pool: pg.Pool, schema: string): Promise<Postgres> {
  const sql: Sql = {
    query: async (text, values) => {
      const answer = await pool.query(text, values as unknown[]);
      return { rows: answer.rows as never[] };
    },
  };
  await ensureSchema(sql, schema);
  // `query: sql.query` would hand the method over without its receiver, which is the defect
  // `check:unbound-calls` exists for. It happens to be harmless here — the object literal above closes
  // over `pool` rather than reading `this` — and writing it the safe way costs nothing.
  return { schema, query: (text, values) => sql.query(text, values), end: () => Promise.resolve() };
}

/**
 * Every record the volume calls for, written straight into the tables.
 *
 * Not through the stores' own write methods, and the reason is that several of them read before they
 * write — an attestation names the one it supersedes, an acceptance refuses a second live one on the
 * same requirement — which makes seeding quadratic and, for the register stores, impossible at more
 * than one live record per requirement. What the shortcut risks is a row the reader cannot use, so
 * every read is asserted against the count seeded before any of them is timed.
 */
async function seed(db: Postgres, volume: HistoryVolume, requirements: number): Promise<void> {
  const ids = requirementIds(requirements);
  const revisions = volume.revisionsEach;

  const definitionStore = new PostgresDefinitionStore({ db });
  // Twelve assessments rather than one per requirement: an assessment is a thing a person writes, and
  // a monthly cadence over a year is the widest an install plausibly holds. Stated in the table.
  for (let index = 0; index < 12; index += 1) {
    const held = definition(`assessment-${String(index)}`, revisions, index, pillarsOf());
    await definitionStore.create({ id: held.id, versions: held.versions.slice(0, 1) });
    for (const version of held.versions.slice(1)) await definitionStore.appendVersion(held.id, version);
  }

  for (const [at, controlId] of ids.entries()) {
    await insertAll(
      db,
      'attestations',
      // `digest` and `definition_id` as well as the four a read needs, because this list mirrors
      // `PostgresEventLog.append` rather than what the timed reads happen to select. A seeded row
      // narrower than the row the app writes is a store nobody runs, and `definition_id` is the one
      // that shows it: no unscoped read looks at it, and every scoped read returns nothing without it.
      // `verify` below calls one, so a column dropped from this list fails the run.
      ['id', 'control_id', 'attested_at', 'body', 'digest', 'definition_id'],
      attestations(controlId, revisions, at).map((record) => [
        record.id,
        record.controlId,
        record.attestedAt,
        JSON.stringify(record),
        digestOf(record),
        record.definitionId,
      ])
    );

    await insertAll(
      db,
      'applicability_decisions',
      [
        'id',
        'revision',
        'control_id',
        'lever',
        'ordinal',
        'owner',
        'effective_from',
        'expires_at',
        'recorded_at',
        'revoked',
        'body',
        'digest',
        'definition_id',
      ],
      decisions(controlId, revisions, at).map((record) => [
        record.id,
        0,
        record.controlId,
        record.lever,
        record.ordinal,
        record.owner,
        record.effectiveFrom,
        record.expiresAt,
        record.recordedAt,
        record.revoked != null,
        JSON.stringify(record),
        digestOf(record),
        record.definitionId,
      ])
    );

    await insertAll(
      db,
      'accepted_risks',
      [
        'id',
        'revision',
        'control_id',
        'ordinal',
        'owner',
        'residual',
        'effective_from',
        'expires_at',
        'recorded_at',
        'revoked',
        'body',
        'digest',
        'definition_id',
      ],
      risks(controlId, revisions, at).map((record) => [
        record.id,
        0,
        record.controlId,
        record.ordinal,
        record.owner,
        record.residual,
        record.effectiveFrom,
        record.expiresAt,
        record.recordedAt,
        record.revoked != null,
        JSON.stringify(record),
        digestOf(record),
        record.definitionId,
      ])
    );
  }

  // One plan per twelve requirements, each holding actions that name two requirements — the shape a
  // board has rather than one action per requirement, which no plan is arranged as.
  const plans = Math.max(1, Math.ceil(requirements / 12));
  for (let index = 0; index < plans; index += 1) {
    const held = plan(`plan-${String(index)}`, index);
    // A plan may name no assessment — a board raised before one was published — but the fixture's do,
    // and a null here would seed exactly the schema `verify` was written to catch. So it is an error
    // rather than a fallback: the fixture changing shape should stop the run, not quietly widen it.
    if (held.assessment == null) throw new Error(`The fixture plan ${held.id} names no assessment.`);
    await insertAll(
      db,
      'improvement_plans',
      ['id', 'revision', 'created_at', 'changed_at', 'body', 'digest', 'definition_id'],
      [
        [
          held.id,
          0,
          held.createdAt,
          held.createdAt,
          JSON.stringify(held),
          digestOf(held),
          held.assessment.definitionId,
        ],
      ]
    );

    for (let which = 0; which < 12; which += 1) {
      const named = [ids[(index * 12 + which) % ids.length] ?? ids[0] ?? 'SEC-001-access', ids[which] ?? 'SEC-001-access'];
      await insertAll(
        db,
        'improvement_actions',
        ['id', 'revision', 'plan_id', 'plan_created_at', 'created_at', 'changed_at', 'body', 'digest'],
        actions(held.id, named, revisions, index * 12 + which).map((record) => [
          record.id,
          record.revision,
          record.planId,
          held.createdAt,
          record.createdAt,
          record.history.at(-1)?.at ?? record.createdAt,
          JSON.stringify(record),
          digestOf(record),
        ])
      );

      // One validation attempt per action revision, all but the newest answered.
      //
      // The mix is the subject. `outstanding` narrows on `answered = false`, which the revision-0 row
      // of an answered attempt carries for ever, so its cost follows how many attempts have ever been
      // *requested* — and a fixture where every attempt is still open would measure the one shape the
      // read is cheap in, which is the mistake the `scale.ts` fixture made in the other direction.
      const actionId = `action-${String(index * 12 + which)}`;
      for (let round = 0; round < revisions; round += 1) {
        const settled = round < revisions - 1;
        await insertAll(
          db,
          'validation_attempts',
          ['id', 'revision', 'action_id', 'plan_id', 'plan_created_at', 'requested_at', 'answered', 'body', 'digest'],
          attempts(held.id, actionId, named, index * 12 + which + round * 97, settled).map((record) => [
            record.id,
            record.answer == null ? 0 : 1,
            record.actionId,
            record.planId,
            held.createdAt,
            record.requestedAt,
            record.answer != null,
            JSON.stringify(record),
            digestOf(record),
          ])
        );
      }
    }
  }

  // Notes about requirements, at the density `counts` is read at: the page that calls it asks for one
  // tally per requirement in the catalogue, so the row count that decides its cost is notes per
  // requirement times requirements. Threads rather than single notes, because that is what people
  // leave and `counts` counts every message in one.
  for (const [at, controlId] of ids.entries()) {
    await insertAll(
      db,
      'notes',
      ['id', 'subject_kind', 'subject_id', 'noted_at', 'body', 'digest', 'definition_id'],
      Array.from({ length: notesEach(volume) }, (_, which) => note('control', controlId, at + which * 31)).map(
        (record) => [
          record.id,
          record.subject.kind,
          record.subject.id,
          record.at,
          JSON.stringify(record),
          digestOf(record),
          record.definitionId,
        ]
      )
    );
  }
}

/**
 * Notes on one requirement, and the one volume in this file that is a stand-in rather than a derivation.
 *
 * The other three come from constants the app ships: a cadence to renew on and a retention period to
 * renew through. A note has neither. It is written when somebody has something to say, so nothing in
 * the app bounds how many there are and there is no arithmetic to do.
 *
 * What is used instead is the register volume — an install that has written as many notes about a
 * requirement as it has attestations of it. That is an assumption about how people work rather than a
 * reading of a setting, and it is stated as one in the published table. It is here rather than a
 * constant because a constant would have made this read flat across all three volumes by construction:
 * the first pass held it at four and reported 736 rows and 0.5 ms three times, which says nothing about
 * whether `counts` is a read to worry about.
 */
function notesEach(volume: HistoryVolume): number {
  return volume.revisionsEach;
}

function pillarsOf(): readonly string[] {
  return ['security', 'reliability', 'cost-optimisation', 'operational-excellence', 'performance', 'governance', 'ai'];
}

/** One multi-row insert per record, which is what makes seeding a hundred thousand rows finish. */
async function insertAll(
  db: Postgres,
  table: string,
  columns: readonly string[],
  rows: readonly (readonly unknown[])[]
): Promise<void> {
  if (rows.length === 0) return;
  const values: unknown[] = [];
  const tuples = rows.map((row) => {
    const holes = row.map((value) => {
      values.push(value);
      return `$${String(values.length)}`;
    });
    return `(${holes.join(',')})`;
  });
  await db.query(
    `insert into ${db.schema}.${table} (${columns.join(',')}) values ${tuples.join(',')} on conflict do nothing`,
    values
  );
}

/**
 * The state a seeded schema has to be in before a duration taken against it means anything.
 *
 * Seeding is one multi-row insert per record and nothing else, which leaves a database no install
 * ever runs: no statistics, so the planner is costing every read off its defaults, and — this is the
 * one that changed a reading — a GIN index whose pending list has never been flushed. Measured
 * without this call, the `improvement_actions` containment predicate was answered by a sequential
 * scan that detoasted every body, at 36 ms and 16,532 buffers; with it, by the index, at 3 ms and
 * 1,574. Both numbers are real and only the second is about the app, because a live install's
 * autovacuum has been running all along.
 *
 * `vacuum` cannot run inside a transaction, so it goes through the pool directly rather than through
 * the `Postgres` handle, and it is one statement per table rather than a bare `vacuum` so the schema
 * this run owns is the only thing it touches.
 */
async function settle(pool: pg.Pool, schema: string): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    'select tablename from pg_tables where schemaname = $1',
    [schema]
  );
  for (const { tablename } of rows) await pool.query(`vacuum analyze ${schema}.${tablename}`);
}

/**
 * That the seeded rows are rows the app's own reads can use, before any of them is timed.
 *
 * The seeding above bypasses the stores' write methods, so nothing but this stands between a measured
 * duration and a schema production does not write. An unscoped read cannot tell: it selects `body` and
 * would return every row whatever the promoted columns hold. So this calls a scoped one as well, which
 * filters on `definition_id` — the column the first version of the seed left null on four tables — and
 * a column dropped from a list above fails the run here rather than becoming a fast reading somebody
 * quotes.
 */
async function verify(db: Postgres, requirements: number): Promise<void> {
  const applicability = new PostgresApplicabilityStore({ db });
  const accepted = new PostgresRiskStore({ db });
  const attested = new PostgresAttestationStore({ db });
  const improvements = new PostgresImprovementStore({ db });
  const validations = new PostgresValidationStore({ db });
  const notes = new PostgresNoteStore({ db });
  const controlId = requirementIds(requirements)[0] ?? 'SEC-001-access';
  // What `history-fixtures.ts` stamps on the records of the first requirement, and on the first plan.
  const scope = 'assessment-0';

  const answers: readonly (readonly [string, Promise<{ readonly length: number }>])[] = [
    ['attestations.current, unscoped', attested.current()],
    [`attestations.current, scoped to ${scope}`, attested.current(scope)],
    [`attestations.historyFor, scoped to ${scope}`, attested.historyFor(controlId, scope)],
    [`applicability.for, scoped to ${scope}`, applicability.for(controlId, scope)],
    [`risks.for, scoped to ${scope}`, accepted.for(controlId, scope)],
    [`improvements.plans, scoped to ${scope}`, improvements.plans(scope)],
    [`improvements.actionsFor, scoped to ${scope}`, improvements.actionsFor(controlId, scope)],
    // No scoped pair for these two. `validation_attempts` is `by-parent` rather than `scoped` — it has
    // no `definition_id` at all, and its assessment is its action's — so a scoped read of it is not a
    // thing that exists. `notes.counts` is called scoped instead, which is the read that would return
    // nothing if the seed left the column null.
    ['validate.outstanding', validations.outstanding()],
    ['validate.for, on the first action', validations.for('action-0')],
    [
      `notes.counts, scoped to ${scope}`,
      notes.counts('control', scope).then((tally) => ({ length: Object.keys(tally).length })),
    ],
  ];

  const empty: string[] = [];
  for (const [what, answer] of answers) {
    if ((await answer).length === 0) empty.push(what);
  }
  if (empty.length > 0) {
    throw new Error(
      `The seeded schema is not one these reads can use — ${empty.join(', ')} returned nothing.\n` +
        '  Every one of those is a read the app makes, so a duration measured against this schema would\n' +
        '  be a duration for a store nobody runs. Check that `seed` writes every column the matching\n' +
        '  store writes, `definition_id` included.'
    );
  }
}

/** Every read in `HISTORY_READS`, timed against the seeded schema, cold then warm. */
async function time(db: Postgres, pool: pg.Pool, volume: HistoryVolume): Promise<readonly Reading[]> {
  // Rows are counted at the driver, on the way past, rather than with a `count(*)` over the table the
  // read draws from. The first pass of this benchmark did the latter and reported `applicability.for`
  // as having read ten thousand rows when its `where` clause had returned fifty-eight — a real number
  // about the wrong thing, which is the mistake H1's fixture made in the other direction.
  let fetched = 0;
  const watched: Postgres = {
    schema: db.schema,
    query: async <T,>(text: string, values?: readonly unknown[]): Promise<{ rows: T[] }> => {
      const answer = await db.query<T>(text, values);
      fetched += answer.rows.length;
      return answer;
    },
    end: () => Promise.resolve(),
  };

  const definitions = new PostgresDefinitionStore({ db: watched });
  const applicability = new PostgresApplicabilityStore({ db: watched });
  const accepted = new PostgresRiskStore({ db: watched });
  const attested = new PostgresAttestationStore({ db: watched });
  const improvements = new PostgresImprovementStore({ db: watched });
  const validations = new PostgresValidationStore({ db: watched });
  const notes = new PostgresNoteStore({ db: watched });
  const controlId = requirementIds(1)[0] ?? 'SEC-001-access';
  // The action the seed gives the first requirement's plan, so `validate.for` narrows to rows that
  // exist. `verify` fails the run if it does not.
  const actionId = 'action-0';

  // `{ length: number }` rather than each store's own record type: what is timed is the same for all
  // seven, and the count of what came back is the only part of an answer this file reads.
  const runs: Readonly<Record<string, { table: string; run: () => Promise<{ length: number }> }>> = {
    'definitions.all': { table: 'assessment_definition_versions', run: () => definitions.all() },
    'applicability.all': { table: 'applicability_decisions', run: () => applicability.all() },
    'applicability.for': { table: 'applicability_decisions', run: () => applicability.for(controlId) },
    'risks.all': { table: 'accepted_risks', run: () => accepted.all() },
    'attestations.current': { table: 'attestations', run: () => attested.current() },
    'attestations.historyFor': { table: 'attestations', run: () => attested.historyFor(controlId) },
    'improvements.actionsFor': { table: 'improvement_actions', run: () => improvements.actionsFor(controlId) },
    'validate.outstanding': { table: 'validation_attempts', run: () => validations.outstanding() },
    'validate.for': { table: 'validation_attempts', run: () => validations.for(actionId) },
    // `counts` answers with a record rather than a list, so its length is the requirements tallied
    // rather than the notes counted — which is the read's whole point and what the `fetched` column
    // beside it is there to contrast with.
    'notes.counts': {
      table: 'notes',
      run: async () => ({ length: Object.keys(await notes.counts('control')).length }),
    },
  };

  const readings: Reading[] = [];
  for (const read of HISTORY_READS) {
    const subject = runs[read.id];
    if (subject == null) throw new Error(`No run for ${read.id}, so a read in HISTORY_READS went unmeasured.`);

    const counted = await db.query<{ bytes: string | null }>(
      `select sum(octet_length(body::text))::text as bytes from ${db.schema}.${subject.table}`
    );

    // One run before any is timed, so the row count comes from a pass that is not a sample, and so
    // the first *warm* sample is not paying for a connection and a plan. The cold samples below
    // deliberately do pay for a plan: that is the point of them.
    fetched = 0;
    // One binding, cleared before each baseline, rather than a `const` per iteration: an answer left
    // reachable in a loop body's slot is in the baseline of every sample taken after it, which is how
    // the deleted retention figure came to read as zero.
    let answer: { length: number } | undefined = await subject.run();
    const answered = answer.length;
    const rowsFetched = fetched;

    const cold: number[] = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      answer = undefined;
      await evictSharedBuffers(pool, db.schema);
      await pool.query('discard all');
      collect();
      const started = performance.now();
      answer = await subject.run();
      cold.push(performance.now() - started);
    }

    const durations: number[] = [];
    let peak = 0;
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      answer = undefined;
      collect();
      const before = process.memoryUsage().heapUsed;
      let seen = before;
      const watch = setInterval(() => {
        seen = Math.max(seen, process.memoryUsage().heapUsed);
      }, SAMPLE_INTERVAL_MS);
      const started = performance.now();
      answer = await subject.run();
      const took = performance.now() - started;
      clearInterval(watch);
      peak = Math.max(peak, seen - before);
      durations.push(took);
    }
    answer = undefined;

    const sorted = [...durations].sort((a, b) => a - b);
    const sortedCold = [...cold].sort((a, b) => a - b);
    readings.push({
      read: read.id,
      volume: volume.name,
      fetched: rowsFetched,
      answered,
      tableBytes: Number(counted.rows[0]?.bytes ?? '0'),
      medianMs: round(sorted[Math.floor(sorted.length / 2)] ?? 0),
      coldMs: round(sortedCold[Math.floor(sortedCold.length / 2)] ?? 0),
      slowestMs: round(sorted.at(-1) ?? 0),
      slowestColdMs: round(sortedCold.at(-1) ?? 0),
      peakHeapBytes: peak,
    });
  }
  return readings;
}

function collect(): void {
  global.gc?.();
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A duration, at a precision that does not turn a fast read into no read.
 *
 * The first published table rounded to whole milliseconds, and the controls came out at `0 ms` — which
 * reads as zero latency rather than as the third of a millisecond the recording holds, and the controls
 * are the rows a reader checks the apparatus against. Anything under ten milliseconds keeps a decimal.
 */
function ms(value: number): string {
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ms`;
}

/**
 * The published table, one row per read and one column per volume.
 *
 * Three figures per cell — rows fetched, median duration, highest sampled heap — because any one of
 * them alone reads as the whole cost. A read that takes 40 ms and grows the heap by 150 MiB on the way
 * is a different problem from one that takes 400 ms and grows it by nothing, and `46b` has to be able
 * to tell them apart. The duration and the heap are both lower bounds, for the two different reasons
 * the header gives.
 *
 * The rows are in the cell rather than in a footnote under the table, and that is the second attempt:
 * the first published one number per volume and said it was what "each history table" held, which was
 * true of the three registers and of neither the version table nor the action table — twelve
 * assessments' versions and a plan-shaped action board are not `requirements x revisions`. A count in
 * the cell is the count that read fetched, which is a field of the recording and cannot be wrong about
 * a table it never touched.
 *
 * The two narrowed reads are last and marked, because a reader scanning for the worst number should
 * not find a control there and take it for a subject.
 */
function figureTable(recording: Recording): string {
  const names = recording.volumes.map((volume) => volume.name);
  const lines = [
    START,
    '',
    `| Read | Loads | ${names.map((name) => `${name} — rows · cold · warm · peak heap`).join(' | ')} |`,
    `| --- | --- | ${names.map(() => '---').join(' | ')} |`,
  ];

  const ordered = [...HISTORY_READS].sort((a, b) => Number(a.control) - Number(b.control));
  for (const read of ordered) {
    const cells = names.map((name) => {
      const found = recording.readings.find((reading) => reading.read === read.id && reading.volume === name);
      if (found == null) return 'not measured';
      return `${found.fetched.toLocaleString('en-GB')} · ${ms(found.coldMs)} cold · ${ms(found.medianMs)} warm · ${mib(found.peakHeapBytes)}`;
    });
    if (cells.every((cell) => cell === 'not measured')) continue;
    lines.push(`| \`${read.id}\` | ${read.fetches} | ${cells.join(' | ')} |`);
  }

  const registers = recording.volumes.map((volume) => `${volume.name} ${String(rowsIn(volume))}`).join(', ');
  lines.push(
    '',
    `Where the volumes come from: ${String(recording.requirements)} scored requirements, each answered ` +
      `${String(REVISIONS_PER_REQUIREMENT)} times — which is ` +
      `\`ceil(${String(GOVERNANCE_DAYS)} / ${String(SHORTEST_CADENCE_DAYS)})\`, the app's own governance ` +
      `retention default over its shortest cadence — and again at the ${String(GROWTH_MARGIN)}x margin. ` +
      `That is ${registers} in each of the three registers. The version table and the action table are ` +
      `arranged by assessment and by plan rather than by requirement, so they hold their own counts; ` +
      `what each read fetched is in its cell. Measured on ${recording.apparatus.postgres} under ` +
      `Node ${recording.apparatus.node}, ${recording.apparatus.path} via ${recording.apparatus.host}, ` +
      `shared_buffers ${recording.apparatus.sharedBuffers}, ${String(recording.apparatus.samples)} samples ` +
      `per read per cache state, ${recording.measuredAt.slice(0, 10)}. Cold samples evict shared_buffers ` +
      `with a filler table (${recording.apparatus.cacheDrop}). Peak heap is sampled every ` +
      `${String(recording.apparatus.sampleIntervalMs)} ms and is a lower bound.`,
    '',
    ...finding(recording),
    END
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The sentences that name the costliest read and say by how much, generated rather than written.
 *
 * Written prose beside a generated table is how a document comes to disagree with its own figures: the
 * table is re-published, the paragraph under it still quotes last month's duration, and the paragraph
 * is what a reader quotes back. So every number in this document that is a measurement is inside the
 * generated block, and the hand-written sections carry the mechanism and the caveats — the parts a
 * re-measurement does not change.
 */
function finding(recording: Recording): readonly string[] {
  const largest = recording.volumes.at(-1)?.name ?? 'growth';
  const previous = recording.volumes.at(-2)?.name;
  const at = (volume: string): readonly Reading[] =>
    recording.readings.filter((reading) => reading.volume === volume);

  const subjects = new Set(HISTORY_READS.filter((read) => !read.control).map((read) => read.id));
  const ranked = [...at(largest)]
    .filter((reading) => subjects.has(reading.read))
    .sort((a, b) => b.medianMs - a.medianMs);
  const worst = ranked[0];
  const next = ranked[1];
  if (worst == null || next == null) return [];

  const said = [
    `At the ${largest} volume the costliest of these is \`${worst.read}\`: it fetches ` +
      `${worst.fetched.toLocaleString('en-GB')} rows and grows the heap by ${mib(worst.peakHeapBytes)} to ` +
      `answer with ${String(worst.answered)}, in ${ms(worst.medianMs)} warm and ${ms(worst.coldMs)} cold. The next ` +
      `costliest is \`${next.read}\`, at ${ms(next.medianMs)} warm and ${mib(next.peakHeapBytes)}.`,
  ];

  // The comparison between the two largest volumes, because a read whose cost rises faster than the
  // table does is the one to rework first and the table alone does not say which that is.
  if (previous != null) {
    const before = at(previous).find((reading) => reading.read === worst.read);
    if (before != null && before.medianMs > 0 && before.fetched > 0) {
      const times = (value: number, over: number): string => `${(value / over).toFixed(1)}x`;
      said.push(
        '',
        `Between ${previous} and ${largest} its row count rises ` +
          `${times(worst.fetched, before.fetched)} and its median duration ` +
          `${times(worst.medianMs, before.medianMs)}. The bodies in the table it reads rise ` +
          `${times(worst.tableBytes, before.tableBytes)}, from ${mib(before.tableBytes)} to ` +
          `${mib(worst.tableBytes)}.`
      );
    }
  }
  return said;
}

function replaceBlock(doc: string, block: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0 || end < start) {
    throw new Error(`docs/design/history-read-budget.md is missing the generated-table markers ${START}`);
  }
  return `${doc.slice(0, start)}${block}${doc.slice(end + END.length).replace(/^\n/, '')}`;
}

/** The committed recording, which is the only thing `--check` and a database-less `--publish` read. */
function read(): Recording {
  if (!existsSync(RECORDING)) {
    throw new Error(`No recording at ${RECORDING}. Run the benchmark against a database first.`);
  }
  const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
  if (recording.readings.length === 0) throw new Error('The history-read recording holds no readings.');
  return recording;
}

function publish(recording: Recording): void {
  if (!existsSync(DOC)) throw new Error(`No document at ${DOC}`);
  writeFileSync(DOC, replaceBlock(readFileSync(DOC, 'utf8'), figureTable(recording)));
}

/**
 * The published table against the recording, and nothing else.
 *
 * Deliberately not a re-measurement: a duration measured on somebody's laptop is not the duration in
 * the recording, so a check that re-ran the benchmark would fail on every machine but the one that
 * took it. What it holds is that the table quotes the numbers somebody committed — the same division
 * `check:baseline-table` draws for the warehouse baseline.
 */
function check(): void {
  const recording = read();
  const doc = readFileSync(DOC, 'utf8');
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error('docs/design/history-read-budget.md is missing the generated-table markers.');
  if (`${doc.slice(start, end + END.length)}\n` !== figureTable(recording)) {
    throw new Error(
      'The table in docs/design/history-read-budget.md is stale against scripts/recordings/history-reads.json.\n' +
        '  Run `npm run measure:history-reads -- --publish` against a database, or `--publish` alone if the\n' +
        '  numbers are unchanged and only the table drifted.'
    );
  }
}

await main();
