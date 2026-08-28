// Measures the premise `36j` is scheduled on, before the rework decides what it is.
//
// Live and optional, like measure-sql-plans.mjs: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-shape-fingerprint.mjs
//
// ## The premise
//
// `docs/plan/sql-quality.md` schedules `36j` because workload_query_shapes.sql computes a shape by
// lowercasing, replacing digit runs with `N`, replacing single-quoted literals with `S` and collapsing
// whitespace — and says "the ways it is wrong are known rather than suspected", listing six: comments,
// escaped strings, typed literals, quoted identifiers, `IN` lists of varying length, and digits inside
// identifiers, "each either splits statements that are the same shape or merges ones that are not".
//
// Nobody had measured which, or by how much, or in which direction. This does, the only way the
// direction can be established without a tokenizer to compare against: it computes the shipped
// fingerprint over the real population, computes a variant that fixes exactly one mode, and counts the
// shapes each produces. A variant with *more* shapes than shipped means the shipped rule merges
// statements that variant keeps apart; *fewer* means the shipped rule splits ones it joins.
//
// Which of those two is a defect is not something a count can tell you, and that is the finding. Two of the
// six modes move the same number of shapes in opposite directions: `IN` lists of varying length are a real
// defect, and digits inside identifiers merge as many shapes again in cases where merging is right. See the
// write-up in docs/design/q1a-runtime-baseline.md.
//
// ## What it also measures, and why those parts matter more
//
// **How many statements exercise each mode**, beside the shapes it moves. A variant that changes nothing and
// a variant whose pattern never fires both report zero, and this measurement published the wrong one of the
// two for `IN` lists — which turned out to be the joint-largest effect — and the right one for typed
// literals. Nothing in the output distinguished them until this column existed.
//
// **The corpus.** A shape count from a warehouse is only worth what the statements behind it are, and this
// warehouse is the one this project does its own probing on. So it reports the population by
// `client_application` before reporting anything about fingerprints, because most of labs' shapes are the
// ad-hoc SQL written while measuring — CLI and node one-offs that carry none of the four marks `is_self`
// looks for, and that grow with every run of this script. A magnitude from that corpus describes this
// project's habits, not an estate's workload, and the write-up says so rather than quoting the proportions
// as if they transferred.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-shapes.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
// Thirty days, which is what workload_query_shapes.sql reads at its own ceiling.
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

function token() {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' })).access_token;
}

async function call(path, init) {
  const response = await fetch(path.startsWith('http') ? path : `${HOST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

async function run(statement) {
  let response = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement,
      warehouse_id: WAREHOUSE,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      wait_timeout: '50s',
    }),
  });
  response = await settled(response, { call, polls: MAX_POLLS, pollIntervalMs: POLL_INTERVAL_MS });
  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(JSON.stringify(response.status).slice(0, 500));
  }
  return {
    columns: (response.manifest?.schema?.columns ?? []).map((column) => column.name),
    rows: response.result?.data_array ?? [],
  };
}

/**
 * The population workload_query_shapes.sql would group, and not one statement more.
 *
 * Both of the statement's flags are reproduced, because `shaped` requires `is_covered = 1` as well as
 * `is_self = 0` and the difference is not marginal. `is_covered` is a positive list of eight statement
 * types, so `GRANT`, `DROP`, `SET`, `USE` and `SHOW` never reach the fingerprint at all — and the first
 * version of this measurement, filtering only on `is_self`, drew its headline evidence from a `DROP` and
 * seven `GRANT`s. Real statements, reproducible counts, and a fingerprint that never sees any of them.
 *
 * `is_self` is reproduced as the four-way CASE the statement writes rather than as a `NOT (...)`, and
 * that is not a style preference either: `try_element_at` is NULL where the tags column is absent, `NULL
 * OR false` is NULL, and `NOT NULL` filters the row out. Written as a negation, the first run reported a
 * population of zero and a shape count of zero, which reads exactly like a finding about a quiet
 * warehouse.
 */
const POPULATION = String.raw`
  SELECT
    coalesce(client_application, '(none)') AS app,
    lower(trim(statement_text))            AS t
  FROM system.query.history
  WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
    AND execution_status IN ('FINISHED', 'FAILED', 'CANCELED')
    AND statement_text IS NOT NULL
    AND trim(statement_text) <> ''
    AND statement_type IN (
      'SELECT', 'INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE', 'CREATE'
    )
    AND CASE
      WHEN try_element_at(query_tags, 'databricks_waf') = 'assessment'
        OR startswith(trim(statement_text), '-- databricks-waf: assessment')
        OR contains(statement_text, '-- Signal: sql:')
        OR contains(statement_text, '-- Rows: ')
      THEN 1 ELSE 0
    END = 0`;

/**
 * The shipped fingerprint's normalisation, over any expression, in the order the statement applies it.
 *
 * Written as a function of the input so the same text can be rendered over `t` for the measurement and
 * over `lower(trim(statement_text))` for comparison against the statement itself. It is a second copy of
 * something workload_query_shapes.sql owns, which is a thing this repository has been bitten by twice — so
 * `measure-shape-fingerprint.test.ts` renders it the statement's way and fails if the statement no longer
 * contains it. A measurement of a fingerprint we do not ship is a real, reproducible number about nothing.
 */
export function normalisation(input, digits = '[0-9]+') {
  return String.raw`trim(regexp_replace(
  regexp_replace(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(${input}, '${digits}', 'N'),
          concat(chr(39), '([^', chr(39), chr(10), ']|', chr(39), chr(39), ')*', chr(39)), 'S'
        ),
        concat('(?s)(?<![a-z0-9_])--[^', chr(10), ']*|/\\*.*?\\*/|', chr(96)), ''
      ), '\\b(date|timestamp|interval)\\s+S', 'S'
    ), '\\(\\s*(S|N)(\\s*,\\s*(S|N))+\\s*\\)', '(S)'
  ), '[ \t\n\r]+', ' '))`;
}

/** The fingerprint `36s` replaced, kept as a variant so the recording carries the delta in one window. */
export function previousNormalisation(input) {
  return String.raw`regexp_replace(
  regexp_replace(
    regexp_replace(${input}, '[0-9]+', 'N'),
    concat(chr(39), '[^', chr(39), ']*', chr(39)), 'S'
  ), '[ \t\n\r]+', ' ')`;
}

const SHIPPED = normalisation('t');

/**
 * One variant per claimed failure mode, each fixing that mode and nothing else.
 *
 * A count of shapes is only interpretable against a variant that differs in one place, so these are
 * deliberately minimal rather than good: `standalone_digits` is not a proposal, it is the narrowest
 * expression of "stop eating digits inside identifiers" that can be compared against what ships.
 */
/**
 * How to tell, per mode, that the corpus contains something for the variant to act on.
 *
 * Recorded beside the shape counts because a variant that changes nothing and a variant whose pattern
 * matches nothing produce the same number and mean opposite things — and this measurement published the
 * wrong one of the two for `IN` lists and typed literals, from a pattern written in the wrong case. A
 * count of statements exercising the mode makes that indistinguishable pair distinguishable, and it is
 * cheaper than remembering.
 */
const EXERCISED = {
  standalone_digits: String.raw`${SHIPPED} rlike '[a-z_]N|N[a-z_]'`,
};

/**
 * The one claimed failure mode `36s` deliberately did not fix, still measured against labs.
 *
 * `36j` ran a variant per mode. Five of the six are now inside the fingerprint, so a variant fixing one of
 * them has nothing left to act on and its count says nothing — and four of the five did report exactly zero
 * once `36s` landed, which is how a table can go on producing numbers after it has stopped measuring
 * anything. They are retired; the corpus holds those modes, and holds them on statements written for the
 * purpose rather than on whatever labs ran this month.
 *
 * Digits are different. `36j` measured that collapsing runs inside identifiers is *right* on this corpus —
 * every shape it merges is one generated scratch table — and `36s` therefore left it alone. That is a
 * decision resting on a labs measurement, so the measurement has to keep running: this is the same pipeline
 * with the digit rule narrowed and nothing else changed, which is what makes the difference attributable.
 */
const VARIANTS = {
  standalone_digits: normalisation('t', '(?<![a-z_0-9])[0-9]+(?![a-z_])'),
};

/**
 * Statements written to exercise one claimed failure mode each, and the relations between them.
 *
 * `36j` measured the six modes against labs and could not measure two of them, because labs has no statement
 * that exercises them — and could not have told the difference between that and a broken pattern without
 * being told twice. A corpus written by hand is the answer to both: every mode is exercised by construction,
 * and what the fingerprint does to each pair is recorded rather than reasoned about.
 *
 * The relations are the specification. `want: 'same'` means the pair is one query shape and a fingerprint
 * that separates them is wrong; `want: 'different'` means the opposite. `held` says whether the shipped
 * fingerprint gets it right today, so the corpus states the intended behaviour and the gap in one place, and
 * a change that closes a gap shows up as `held` flipping rather than as a number moving.
 */
export const FIXTURES = [
  { id: 'plain', text: 'SELECT a FROM t WHERE x = 1' },
  { id: 'plain-upper-and-spaced', text: 'select   a\nFROM t\n  where X = 1' },
  { id: 'plain-other-number', text: 'SELECT a FROM t WHERE x = 2' },
  { id: 'plain-wide-number', text: 'SELECT a FROM t WHERE x = 987654' },
  { id: 'other-statement', text: 'DELETE FROM t WHERE x = 1' },
  { id: 'table-one', text: 'SELECT a FROM t1' },
  { id: 'table-two', text: 'SELECT a FROM t2' },
  { id: 'literal-short', text: "SELECT a FROM t WHERE s = 'a'" },
  { id: 'literal-long', text: "SELECT a FROM t WHERE s = 'a much longer value'" },
  { id: 'literal-escaped-quote', text: "SELECT a FROM t WHERE s = 'it''s'" },
  { id: 'commented', text: '-- why this runs\nSELECT a FROM t WHERE x = 1' },
  { id: 'block-commented', text: '/* why this runs */ SELECT a FROM t WHERE x = 1' },
  // The pair that matters most: an apostrophe in a comment leaves an odd number of quotes, and the literal
  // rule pairs it with the next quote anywhere below — consuming the statement in between.
  { id: 'apostrophe-comment-a', text: "-- don't\nSELECT a FROM t WHERE s = 'p'" },
  { id: 'apostrophe-comment-b', text: "-- don't\nSELECT zzz FROM qqq WHERE s = 'p'" },
  { id: 'typed-literal', text: "SELECT a FROM t WHERE d = DATE '2024-01-01'" },
  { id: 'untyped-literal', text: "SELECT a FROM t WHERE d = '2024-01-01'" },
  { id: 'quoted-ident', text: 'SELECT `a` FROM `t`' },
  { id: 'bare-ident', text: 'SELECT a FROM t' },
  { id: 'in-list-two', text: 'SELECT a FROM t WHERE x IN (1, 2)' },
  { id: 'in-list-three', text: 'SELECT a FROM t WHERE x IN (1, 2, 3)' },
  { id: 'in-list-strings-two', text: "SELECT a FROM t WHERE s IN ('a', 'b')" },
  { id: 'in-list-strings-five', text: "SELECT a FROM t WHERE s IN ('a', 'b', 'c', 'd', 'e')" },
  // Everything below exercises a way removing comments can go wrong, rather than a mode of the old rule.
  // A statement's text can contain `--` somewhere that is not a comment, and each of these is one.
  { id: 'literal-with-dashes', text: "SELECT a FROM t WHERE s = 'a--b'" },
  { id: 'quoted-ident-dashes-b', text: 'SELECT `a--b` FROM t' },
  { id: 'quoted-ident-dashes-c', text: 'SELECT `a--c` FROM t' },
  { id: 'comment-hugging-a-token', text: 'SELECT a FROM t WHERE x = 1--why' },
  { id: 'comment-hugging-an-identifier', text: 'SELECT a FROM t--why' },
  { id: 'block-comment-multiline', text: '/* why\n   this runs */\nSELECT a FROM t WHERE x = 1' },
  { id: 'comment-only-trailing', text: 'SELECT a FROM t WHERE x = 1\n-- trailing note\n' },
];

export const RELATIONS = [
  // The five the shipped fingerprint gets right, and the control. Without the control, a canonicalizer that
  // collapsed every statement to one shape would satisfy every other row here.
  { left: 'plain', right: 'plain-upper-and-spaced', want: 'same', held: true, mode: 'case and whitespace' },
  { left: 'plain', right: 'plain-other-number', want: 'same', held: true, mode: 'standalone digits' },
  { left: 'plain', right: 'plain-wide-number', want: 'same', held: true, mode: 'standalone digits, any width' },
  { left: 'literal-short', right: 'literal-long', want: 'same', held: true, mode: 'string literals' },
  { left: 'table-one', right: 'table-two', want: 'same', held: true, mode: 'digits inside identifiers' },
  { left: 'plain', right: 'other-statement', want: 'different', held: true, mode: 'the control: different SQL' },

  // The gaps `36j` measured on labs, plus the two it could not.
  {
    left: 'in-list-two',
    right: 'in-list-three',
    want: 'same',
    held: true,
    mode: 'IN lists of varying length',
  },
  {
    left: 'in-list-strings-two',
    right: 'in-list-strings-five',
    want: 'same',
    held: true,
    mode: 'IN lists of varying length, of literals',
  },
  { left: 'quoted-ident', right: 'bare-ident', want: 'same', held: true, mode: 'quoted identifiers' },
  { left: 'plain', right: 'commented', want: 'same', held: true, mode: 'line comments' },
  { left: 'plain', right: 'block-commented', want: 'same', held: true, mode: 'block comments' },
  { left: 'typed-literal', right: 'untyped-literal', want: 'same', held: true, mode: 'typed literals' },
  {
    left: 'literal-short',
    right: 'literal-escaped-quote',
    want: 'same',
    held: true,
    mode: 'escaped quote inside a literal',
  },
  // Not a split or a merge of degree one: two unrelated statements collapsing into one shape, which is the
  // same class of defect as the `spark.sql(stmt)` group the statement already guards against by hand.
  {
    left: 'apostrophe-comment-a',
    right: 'apostrophe-comment-b',
    want: 'different',
    held: true,
    mode: 'an apostrophe in a comment swallows the statement',
  },

  // What removing comments can break. Two of these are `want: different`, and they are the reason the rule
  // is anchored rather than written the obvious way: `--` occurs in text that is not a comment, and a rule
  // that eats from there to the end of the line takes real SQL with it.
  {
    left: 'literal-with-dashes',
    right: 'literal-short',
    want: 'same',
    held: true,
    mode: 'a literal containing --',
  },
  {
    left: 'quoted-ident-dashes-b',
    right: 'quoted-ident-dashes-c',
    want: 'different',
    held: true,
    mode: 'two identifiers that differ only after a --',
  },
  {
    left: 'comment-hugging-a-token',
    right: 'plain',
    want: 'same',
    held: true,
    mode: 'a comment hugging a literal or a number',
  },
  // The boundary of the row above, and the reason it is not labelled "a comment with no space before it".
  // It holds there only because the digit pass has already put an upper-case `N` before the `--`, and the
  // anchor is lower case. After an identifier the comment stays in the text, which is what shipped before.
  {
    left: 'comment-hugging-an-identifier',
    right: 'bare-ident',
    want: 'same',
    held: false,
    mode: 'a comment hugging an identifier',
  },
  {
    left: 'block-comment-multiline',
    right: 'plain',
    want: 'same',
    held: true,
    mode: 'a block comment spanning lines',
  },
  {
    left: 'comment-only-trailing',
    right: 'plain',
    want: 'same',
    held: true,
    mode: 'a comment after the statement',
  },
];

/**
 * A SQL expression for arbitrary statement text, with no escape semantics relied on anywhere.
 *
 * Doubling the quote — the SQL standard's escape, and the obvious thing to write — is *silently wrong* on
 * this warehouse: `'x = ''y'''` reads back as `x = y`, five characters, with the quotes gone rather than
 * escaped. The first run of the fixture corpus therefore measured statements that had had every quote
 * removed from them, which made the string-literal rule look broken and the swallowed-statement case look
 * safe. Both were the apparatus.
 *
 * So every character whose meaning depends on an escape convention is passed as its code point instead, and
 * the rest as plain literal chunks. `chr(39)` is what the statement itself uses for the same reason.
 */
function literal(text) {
  const CODES = new Map([
    ["'", 39],
    ['\\', 92],
    ['\n', 10],
    ['\r', 13],
    ['\t', 9],
  ]);
  const parts = [];
  let chunk = '';
  for (const character of text) {
    const code = CODES.get(character);
    if (code == null) {
      chunk += character;
      continue;
    }
    if (chunk !== '') parts.push(`'${chunk}'`);
    chunk = '';
    parts.push(`chr(${String(code)})`);
  }
  if (chunk !== '') parts.push(`'${chunk}'`);
  if (parts.length === 0) return "''";
  return parts.length === 1 ? parts[0] : `concat(${parts.join(', ')})`;
}

/**
 * What the fingerprint does to the corpus, read back as normalised text rather than as a hash.
 *
 * The hash is the part with nothing to learn from: two fixtures share a shape exactly when they share a
 * normalisation, and the normalised text says *why* they do, which a digest cannot.
 */
async function fixtures() {
  const rows = FIXTURES.map((fixture) => `(${literal(fixture.id)}, ${literal(fixture.text)})`).join(',\n    ');
  const { rows: read } = await run(`
    WITH corpus AS (
      SELECT * FROM VALUES
    ${rows}
      AS f(id, raw)
    ),
    lowered AS (SELECT id, lower(trim(raw)) AS t FROM corpus)
    SELECT id, ${SHIPPED} AS normalised FROM lowered`);
  return new Map(read.map(([id, normalised]) => [id, normalised]));
}

function table(rows, columns) {
  const widths = columns.map((column, index) =>
    Math.max(column.length, ...rows.map((row) => String(row[index]).length))
  );
  const line = (cells) => cells.map((cell, index) => String(cell).padEnd(widths[index])).join('  ');
  console.log(`  ${line(columns)}`);
  console.log(`  ${line(widths.map((width) => '-'.repeat(width)))}`);
  for (const row of rows) console.log(`  ${line(row)}`);
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (!HOST) throw new Error('DATABRICKS_HOST is not set.');
  if (!WAREHOUSE) throw new Error('DATABRICKS_WAREHOUSE_ID is not set.');

  console.log(`Reading ${String(LOOKBACK_DAYS)} days of query history on profile ${PROFILE}.\n`);

  // The corpus first, because it decides what the rest of the output is worth.
  console.log('The population, by client, after the statement\'s own is_self exclusion:');
  const corpus = await run(`
    WITH pop AS (${POPULATION})
    SELECT app, count(*) AS statements, count(DISTINCT ${SHIPPED}) AS shapes
    FROM pop GROUP BY app ORDER BY statements DESC`);
  table(corpus.rows, corpus.columns);

  const clients = corpus.rows.map(([app, statements, shapes]) => ({
    app,
    statements: Number(statements),
    shapes: Number(shapes),
  }));
  const statements = clients.reduce((sum, client) => sum + client.statements, 0);

  // Then one shape count per variant, plus how many statements exercise each mode, all in one pass so
  // that every figure describes the same population.
  const selects = Object.entries(VARIANTS)
    .map(([name, expression]) => `count(DISTINCT ${expression}) AS ${name}`)
    .join(',\n      ');
  const exercised = Object.entries(EXERCISED)
    .map(([name, predicate]) => `count_if(${predicate}) AS exercised_${name}`)
    .join(',\n      ');
  const counted = await run(`
    WITH pop AS (${POPULATION})
    SELECT
      count(*) AS statements,
      count(DISTINCT ${SHIPPED}) AS shipped,
      -- The before, in the same window as the after. The shipped count moved between two runs 20 minutes
      -- apart, because this project's probing is most of the corpus, so a before from an earlier run is not
      -- comparable with an after from this one.
      count(DISTINCT ${previousNormalisation('t')}) AS before_36s,
      ${selects},
      ${exercised},
      -- chr(10) and chr(39) rather than escapes, so what the regex is does not depend on whether this
      -- file's template literal is raw and on whether Spark's string literals process a backslash.
      count_if(t rlike concat('--[^', chr(10), ']*', chr(39))) AS apostrophe_in_a_line_comment
    FROM pop`);
  const read = Object.fromEntries(counted.columns.map((column, index) => [column, Number(counted.rows[0][index])]));

  console.log('\nShapes, shipped against one variant per claimed failure mode:');
  const shipped = read.shipped;
  table(
    Object.keys(VARIANTS).map((name) => {
      const shapes = read[name];
      const delta = shapes - shipped;
      const exercisedBy = read[`exercised_${name}`];
      const direction =
        delta > 0
          ? `shipped merges ${String(delta)} apart in the variant`
          : delta < 0
            ? `shipped splits ${String(-delta)} joined in the variant`
            : exercisedBy === 0
              ? 'not exercised: no statement here has one'
              : 'exercised, and changes nothing';
      return [
        name,
        String(exercisedBy),
        String(shapes),
        delta > 0 ? `+${String(delta)}` : String(delta),
        direction,
      ];
    }),
    ['mode fixed', 'statements', 'shapes', 'vs shipped', 'reading']
  );

  // Where a variant moved the count, which statements moved — the only part that says whether the
  // shipped behaviour or the variant's is the right one, and on labs it says the shipped one.
  console.log('\nThe shipped shapes that standalone_digits splits, and what they are:');
  const split = await run(`
    WITH pop AS (${POPULATION}),
    f AS (SELECT app, ${SHIPPED} AS shipped, ${VARIANTS.standalone_digits} AS narrow FROM pop)
    SELECT
      max(app)                    AS an_app,
      count(DISTINCT narrow)      AS narrower_shapes,
      substr(min(shipped), 1, 96) AS shipped_shape
    FROM f
    GROUP BY shipped
    HAVING count(DISTINCT narrow) > 1
    ORDER BY narrower_shapes DESC
    LIMIT 10`);
  table(split.rows, split.columns);

  // The hand-written corpus, which is the only place the two modes labs cannot exercise get measured at all.
  const normalised = await fixtures();
  const relations = RELATIONS.map((relation) => {
    const left = normalised.get(relation.left);
    const right = normalised.get(relation.right);
    if (left == null || right == null) {
      throw new Error(`RELATIONS names a fixture FIXTURES does not define: ${relation.left} or ${relation.right}`);
    }
    return { ...relation, is: left === right ? 'same' : 'different' };
  });

  console.log('\nWhat the shipped fingerprint does to a corpus written to exercise every mode:');
  table(
    relations.map((relation) => [
      relation.mode,
      relation.want,
      relation.is,
      relation.is === relation.want ? 'holds' : 'gap',
      relation.held === (relation.is === relation.want) ? '' : 'DECLARATION IS STALE',
    ]),
    ['mode', 'want', 'is', 'verdict', '']
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        recordedAt: new Date().toISOString(),
        profile: PROFILE,
        lookbackDays: LOOKBACK_DAYS,
        statements,
        clients,
        shapes: {
          shipped,
          before36s: read.before_36s,
          ...Object.fromEntries(Object.keys(VARIANTS).map((name) => [name, read[name]])),
        },
        exercised: Object.fromEntries(Object.keys(EXERCISED).map((name) => [name, read[`exercised_${name}`]])),
        apostropheInALineComment: read.apostrophe_in_a_line_comment,
        splitByStandaloneDigits: split.rows.map(([app, shapes, shape]) => ({
          app,
          narrowerShapes: Number(shapes),
          shippedShape: shape,
        })),
        fixtures: {
          // The normalisation per fixture, so a reader can see why a pair merged without running anything.
          normalised: Object.fromEntries(FIXTURES.map((fixture) => [fixture.id, normalised.get(fixture.id)])),
          relations,
        },
      },
      null,
      2
    )}\n`
  );
  console.log(`\nWrote ${OUT_FILE.replace(`${APP}/`, '')}.`);
}

// Only when run, so the test can import the corpus and the normalisation it has to agree with. Importing
// a module whose top level talks to a warehouse is the kind of test that gets deleted rather than fixed.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) await main();
