/**
 * What the imports list costs, against the size of the envelopes it is listing.
 *
 * Row 85 existed because `GET /api/evidence/imports` selected `body` — the whole uploaded envelope —
 * for every row, to compute a seven-field summary and throw the envelope away. `body` is `jsonb` and
 * every real envelope passes the two-kilobyte threshold, so each row of that list was an out-of-line
 * read and a `JSON.parse` of a document the answer does not contain.
 *
 * The row's premise was that this might not matter. It was half right, and the half decides the shape
 * of the fix, which is why this script prices three reads rather than one:
 *
 *   `whole`     what the route ran: every column, no limit. The thing being replaced.
 *   `summary`   what it runs now: the promoted columns, `body` never named.
 *   `paged`     the other candidate fix: every column, keyset on the index, one page.
 *
 * Both candidates were live when the row was planned and the plan called choosing between them a
 * product decision. The measurement removed the choice: paging bounds the cost at a page of
 * envelopes, which at the size `read.ts` accepts is still half a second, while the promoted columns
 * are flat because they are never out of line. That is the whole argument, and it only exists as an
 * argument because both were measured.
 *
 * ## The two sizes, and why neither alone is the answer
 *
 * An envelope's size is a fact about the estate it was collected from, and this repository does not
 * contain one. So the script measures at a size it is told, and the document names two:
 *
 *   the reading   an envelope actually collected from labs, which is the calibration estate
 *   the ceiling   the eight megabytes `read.ts` accepts, which is what an install permits
 *
 * Three orders of magnitude apart. The reading says the old read cost nothing; the ceiling says one
 * uploaded file could make it cost seconds. A fix justified on the reading alone would not have been
 * built, and one justified on the ceiling alone would be built on a number no estate has produced.
 *
 * ## Running it
 *
 *   node --import tsx scripts/measure-import-list.mts --publish   # measure, record, rewrite the table
 *   node --import tsx scripts/measure-import-list.mts --check     # doc against recording, no database
 *
 * `WAF_BENCH_PG` points at a database this may create schemas in; a local cluster is enough.
 * `--envelope <path>` measures a collected file instead of the recorded sizes, for taking a reading
 * from an estate. Such a run reports and does not record, for the reason `measure-retention-sweeps`
 * declines to record a `--times` run: the recording is the shape the document is checked against, and
 * a reading from somebody's workspace is not that shape.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { envelope as fixture, probe } from '../server/import/envelope-fixture.js';
import { MAX_BYTES } from '../server/import/read.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, 'recordings', 'import-list.json');
const DOC = join(HERE, '..', '..', 'docs', 'design', 'import-list-cost.md');

const START = '<!-- generated: import list cost. Run `npm run measure:import-list -- --publish`. -->';
const END = '<!-- end generated -->';

/**
 * The sizes the published table prices, and where each number comes from.
 *
 * `labs` is a real collection, and the size is the one it came out at — see the document. It is
 * reproduced here by growing the fixture to the same bytes rather than by committing the file, which
 * would put one workspace's inventory in the repository to measure a property of its length.
 */
const SIZES: readonly { readonly name: string; readonly bytes: number; readonly source: string }[] = [
  {
    name: 'labs',
    bytes: 26_429,
    source: 'the size of an envelope collected from labs on 2026-08-17, over 29 probes',
  },
  // Read from `read.ts` rather than restated, so a change to the cap re-measures rather than leaving
  // this table describing a ceiling the app no longer has.
  { name: 'the cap', bytes: MAX_BYTES, source: 'the largest upload `import/read.ts` accepts' },
];

/** How many imports an install holds. Not derivable — an import happens when a person uploads one. */
const COUNTS: readonly number[] = [1, 10, 50, 200];

/** A page of the list, for the keyset candidate. Twenty is what the other paged surfaces use. */
const PAGE = 20;

interface Reading {
  readonly size: string;
  readonly envelopeBytes: number;
  readonly imports: number;
  readonly wholeMs: number;
  readonly summaryMs: number;
  readonly pagedMs: number;
}

interface Recording {
  readonly measuredAt: string;
  readonly postgres: string;
  readonly page: number;
  readonly sizes: readonly { readonly name: string; readonly bytes: number; readonly source: string }[];
  readonly readings: readonly Reading[];
}

const flags = new Set(process.argv.slice(2));

if (flags.has('--check')) {
  check();
  process.stdout.write('The import list table quotes the recording.\n');
  process.exit(0);
}

const endpoint = process.env.WAF_BENCH_PG ?? '';
if (flags.has('--publish') && endpoint === '') {
  publish(read());
  process.stdout.write('Rewrote the table in docs/design/import-list-cost.md from the recording.\n');
  process.exit(0);
}

if (endpoint === '') {
  process.stderr.write(
    'WAF_BENCH_PG is unset, so there is no Postgres to measure against. Point it at a database this\n' +
      'run may create schemas in — a local cluster is enough. `--check` needs no database.\n'
  );
  process.exit(2);
}

/**
 * An envelope of exactly `bytes`, by repeating the fixture's probe and padding the last one's value.
 *
 * Exactly, not approximately, because the size is the independent variable and a table that says
 * 25.2 KiB beside prose that says 25.8 KiB is describing a collection nobody took. Row `H1` is the
 * precedent: a measurement is only as good as the thing it was taken with, and that reading was wrong
 * because its fixture carried one fewer column than the statement it claimed to describe.
 *
 * The padding sits in a probe's `value`, which is where a real envelope carries its bulk — labs's
 * largest probe is `uc-models` at 9.0 KiB of one list.
 */
function envelopeOf(bytes: number): unknown {
  const one = fixture();
  const empty = Buffer.byteLength(JSON.stringify({ ...one, probes: [] }));
  const each = Buffer.byteLength(JSON.stringify(probe())) + 1;
  const many = Math.max(1, Math.floor((bytes - empty) / each));
  const probes = Array.from({ length: many }, (_, index) => probe({ label: `probe-${String(index)}` }));

  // Converged rather than computed, because replacing the last probe's value changes the length by
  // the pad plus whatever it displaced. Three passes is comfortably enough for a monotonic function.
  const built = (pad: number): unknown => ({
    ...one,
    probes: [...probes.slice(0, -1), probe({ label: `probe-${String(many - 1)}`, value: { pad: 'x'.repeat(pad) } })],
  });

  let pad = 0;
  for (let pass = 0; pass < 4; pass += 1) {
    const short = bytes - Buffer.byteLength(JSON.stringify(built(pad)));
    if (short === 0) break;
    pad = Math.max(0, pad + short);
  }
  return built(pad);
}

function ms(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toFixed(1);
}

function size(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1024 / 1024).toFixed(1)} MiB` : `${(bytes / 1024).toFixed(1)} KiB`;
}

/** The median of seven, for the reason `measure-history-reads.mts` gives: a first read is a cold one. */
async function median(run: () => Promise<void>): Promise<number> {
  const taken: number[] = [];
  for (let attempt = 0; attempt < 7; attempt += 1) {
    const at = performance.now();
    await run();
    taken.push(performance.now() - at);
  }
  return taken.sort((left, right) => left - right)[3] ?? 0;
}

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: endpoint, max: 2 });
  const readings: Reading[] = [];

  try {
    const { rows } = await pool.query<{ version: string }>('select version()');
    const postgres = (rows[0]?.version ?? '').split(' ').slice(0, 2).join(' ');

    const only = [...flags].find((flag) => flag.startsWith('--envelope='));
    const sizes =
      only == null
        ? SIZES
        : [
            {
              name: 'collected',
              bytes: Buffer.byteLength(readFileSync(only.slice('--envelope='.length), 'utf8')),
              source: only.slice('--envelope='.length),
            },
          ];

    for (const one of sizes) {
      const body =
        only == null
          ? envelopeOf(one.bytes)
          : (JSON.parse(readFileSync(only.slice('--envelope='.length), 'utf8')) as unknown);
      const bytes = Buffer.byteLength(JSON.stringify(body));
      process.stdout.write(`\n${one.name}: ${size(bytes)} an envelope\n`);
      readings.push(...(await measure(pool, body, bytes, one.name)));
    }

    if (only != null) {
      process.stdout.write(
        '\nNot recorded and not published — the recording is the reading the document names.\n'
      );
      return;
    }

    const recording: Recording = {
      measuredAt: new Date().toISOString().slice(0, 10),
      postgres,
      page: PAGE,
      sizes: SIZES,
      readings,
    };
    writeFileSync(RECORDING, `${JSON.stringify(recording, null, 2)}\n`);
    process.stdout.write(`\nRecorded ${String(readings.length)} readings in scripts/recordings/import-list.json.\n`);
    if (flags.has('--publish')) {
      publish(recording);
      process.stdout.write('Rewrote the table in docs/design/import-list-cost.md.\n');
    }
  } finally {
    await pool.end();
  }
}

async function measure(pool: pg.Pool, body: unknown, bytes: number, name: string): Promise<readonly Reading[]> {
  const schema = `bench_imports_${String(Date.now() % 100_000)}`;
  const readings: Reading[] = [];

  await pool.query(`create schema ${schema}`);
  try {
    // The table as `postgres.ts` builds it, including the column the row added. Written out rather
    // than built through `ensureSchema` because that would create thirty tables to measure one, and
    // a drift between the two is what the live suite is for.
    await pool.query(`
      create table ${schema}.imported_evidence (
        digest       text        primary key,
        generated_at timestamptz not null,
        imported_at  timestamptz not null,
        imported_by  text        not null,
        body         jsonb       not null,
        cautions     jsonb       not null,
        summary      jsonb,
        written_at   timestamptz not null default now()
      )
    `);
    await pool.query(
      `create index imported_evidence_newest_first on ${schema}.imported_evidence (imported_at desc)`
    );

    const text = JSON.stringify(body);
    let seeded = 0;
    for (const imports of COUNTS) {
      for (; seeded < imports; seeded += 1) {
        await pool.query(
          `insert into ${schema}.imported_evidence
             (digest, generated_at, imported_at, imported_by, body, cautions, summary)
           values ($1, now(), now() - make_interval(days => $2::int), $3, $4::jsonb, '[]'::jsonb, $5::jsonb)`,
          [
            `sha256:seeded-${String(seeded)}`,
            seeded,
            'importer@example.com',
            text,
            JSON.stringify({ observed: 1, refused: 0, requirements: 1 }),
          ]
        );
      }
      await pool.query(`vacuum analyze ${schema}.imported_evidence`);

      const wholeMs = await median(async () => {
        await pool.query(
          `select digest, generated_at, imported_at, imported_by, body, cautions
             from ${schema}.imported_evidence order by imported_at desc`
        );
      });
      const summaryMs = await median(async () => {
        await pool.query(
          `select digest, imported_at, imported_by, summary, cautions
             from ${schema}.imported_evidence order by imported_at desc`
        );
      });
      const pagedMs = await median(async () => {
        await pool.query(
          `select digest, generated_at, imported_at, imported_by, body, cautions
             from ${schema}.imported_evidence order by imported_at desc limit ${String(PAGE)}`
        );
      });

      readings.push({ size: name, envelopeBytes: bytes, imports, wholeMs, summaryMs, pagedMs });
      process.stdout.write(
        `  ${String(imports).padStart(4)} imports   whole ${ms(wholeMs).padStart(6)} ms` +
          `   summary ${ms(summaryMs).padStart(5)} ms   paged ${ms(pagedMs).padStart(6)} ms\n`
      );
    }
  } finally {
    await pool.query(`drop schema if exists ${schema} cascade`);
  }
  return readings;
}

function read(): Recording {
  if (!existsSync(RECORDING)) throw new Error(`No recording at ${RECORDING}. Run without --check first.`);
  return JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;
}

function figureTable(recording: Recording): string {
  const lines = [
    START,
    '',
    `Measured ${recording.measuredAt} on ${recording.postgres}, median of seven. **whole** is the read the`,
    `route ran before row 85: every column, no limit. **summary** is the read it runs now, which never names`,
    '`body`. **paged** is the candidate the row declined: every column, keyset on `imported_at`, one page of',
    `${String(recording.page)}.`,
    '',
    '| Envelope | Imports | whole | summary | paged |',
    '| --- | ---: | ---: | ---: | ---: |',
  ];

  for (const reading of recording.readings) {
    lines.push(
      `| ${reading.size} (${size(reading.envelopeBytes)}) | ${String(reading.imports)} | ` +
        `${ms(reading.wholeMs)} ms | ${ms(reading.summaryMs)} ms | ${ms(reading.pagedMs)} ms |`
    );
  }

  lines.push('', ...findings(recording), END, '');
  return lines.join('\n');
}

/** What the table says, in the sentences the numbers support and no wider. */
function findings(recording: Recording): readonly string[] {
  const said: string[] = [];
  for (const one of recording.sizes) {
    const rows = recording.readings.filter((reading) => reading.size === one.name);
    const smallest = rows[0];
    const largest = rows[rows.length - 1];
    if (smallest == null || largest == null) continue;

    said.push(
      `**${one.name}** — ${one.source}. At ${size(largest.envelopeBytes)} an envelope the old read cost ` +
        `${ms(smallest.wholeMs)} ms for one import and ${ms(largest.wholeMs)} ms for ${String(largest.imports)}; ` +
        `the summary read cost ${ms(largest.summaryMs)} ms for ${String(largest.imports)}, and paging ` +
        `${largest.pagedMs < largest.wholeMs / 2 ? 'bounded it at' : 'left it at'} ${ms(largest.pagedMs)} ms.`,
      ''
    );
  }
  return said;
}

function replaceBlock(doc: string, block: string): string {
  const start = doc.indexOf(START);
  const end = doc.indexOf(END);
  if (start < 0 || end < 0) throw new Error('docs/design/import-list-cost.md is missing the generated-table markers.');
  return `${doc.slice(0, start)}${block}${doc.slice(end + END.length + 1)}`;
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
  if (start < 0 || end < 0) throw new Error('docs/design/import-list-cost.md is missing the generated-table markers.');
  if (`${doc.slice(start, end + END.length)}\n` !== figureTable(recording)) {
    throw new Error(
      'The table in docs/design/import-list-cost.md is stale against scripts/recordings/import-list.json.\n' +
        '  Run `npm run measure:import-list -- --publish` against a database, or `--publish` alone if the\n' +
        '  numbers are unchanged and only the table drifted.'
    );
  }
}

await main();
