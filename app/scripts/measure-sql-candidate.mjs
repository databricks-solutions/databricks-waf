// Holds a candidate rewrite of a statement against the one that ships, on a live warehouse.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> node scripts/measure-sql-candidate.mjs \
//     uc_platform_census /tmp/candidate.sql
//
// Live and optional, like the other two measurement scripts: nothing in `npm run verify` runs it, and
// what it prints is committed by hand into the row that asked for it.
//
// The candidate is any file, and deliberately not a directory in this repository: a candidate kept
// beside the statement it was measured against is a second copy of that statement going stale. To
// re-measure a decision already taken, take the other side out of git —
//
//   git show <commit>^:app/config/statements/uc_platform_census.sql > /tmp/before.sql
//
// — and run this against it, which is how the reading in Q1k's row is reproduced.
//
// Why this exists rather than eyeballing the rewrite. `docs/plan/sql-quality.md` requires each Q1k
// change to be "re-measured ... with its duration, read, shuffle and spill budgets required to improve
// or stay inside the gate", and Q1e's own history is the reason: its headline rework was aimed at a
// mechanism the optimiser already applied, so it would have measured no improvement while looking like
// a tidier query. A candidate that does not measure better is not an improvement, and this is what says
// which.
//
// What it reports, and what each number is worth:
//
//   - `SAMPLES` readings of each side, alternating, and the median of each. Alternating rather than all
//     of one then all of the other, because a warehouse that gets slower during the run would otherwise
//     hand the whole difference to whichever side went second. 36l measured the first reading of a
//     statement as its slowest sixteen times in twenty-five, so the first of each side is also thrown
//     away before the medians are taken.
//   - `read_bytes` from `system.query.history` for one reading of each, which is the only number here
//     that is the engine's rather than a wall clock's.
//   - Whether the two return the same rows. A faster statement that answers differently is not a
//     candidate, and this compares the full result rather than the row count: the rewrite this was
//     built for merges scalar subqueries, where a column landing in the wrong order is exactly the
//     mistake that would otherwise ship.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const STATEMENTS_DIR = join(APP, 'config', 'statements');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '';
/** Readings per side. One more than the three the baseline takes, because the first of each is dropped. */
const SAMPLES = Math.max(2, Number(process.env.SAMPLES ?? 4));


let liveWorkspaceIds = '';

/** Mirrors measure-sql-baseline.mjs, for the reason that script's header gives about its own copies. */
function parameterValue(name) {
  switch (name) {
    case 'lookback_days':
      return { value: String(LOOKBACK_DAYS), type: 'INT' };
    case 'workspace_id':
      return { value: WORKSPACE_ID, type: 'STRING' };
    case 'live_workspace_ids':
      return { value: liveWorkspaceIds, type: 'STRING' };
    case 'table_limit':
      return { value: '200', type: 'INT' };
    case 'segment_limit':
      return { value: '500', type: 'INT' };
    case 'shape_limit':
      return { value: '40', type: 'INT' };
    case 'warehouse_limit':
      return { value: '200', type: 'INT' };
    default:
      throw new Error(`No default is known for parameter :${name}.`);
  }
}

function declaredParams(text) {
  const body = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return [...new Set([...body.matchAll(/:([a-z_][a-z0-9_]*)/g)].map((match) => match[1]))].sort();
}

const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
function customerCatalog(text) {
  return text.replace(
    FRAGMENT,
    (_whole, column) =>
      `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
      `WHERE catalog_owner = 'System user') AND lower(${column}) NOT IN ('system', 'samples')` +
      ` AND NOT startswith(lower(${column}), '__databricks_internal'))`
  );
}

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

async function run(text, parameters) {
  const started = Date.now();
  let response = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement: text,
      warehouse_id: WAREHOUSE,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      byte_limit: 20 * 1024 * 1024,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      parameters,
    }),
  });
  const statementId = response.statement_id;
  response = await settled(response, { call, polls: 150 });
  if (response.status?.state !== 'SUCCEEDED') {
    return { error: response.status?.error?.message ?? `state ${response.status?.state ?? 'UNKNOWN'}` };
  }
  const rows = [];
  let chunk = response.result;
  while (chunk != null) {
    for (const row of chunk.data_array ?? []) rows.push(row);
    const next = chunk.next_chunk_internal_link;
    if (next == null) break;
    chunk = (await call(next, { method: 'GET' })).result;
  }
  return {
    durationMs: Date.now() - started,
    statementId,
    rows,
    columns: (response.manifest?.schema?.columns ?? []).map((one) => one.name),
  };
}

async function readBytesFor(ids) {
  const found = new Map();
  const remaining = new Set(ids);
  const deadline = Date.now() + 9 * 60_000;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const wait = Math.min(60_000, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const list = [...remaining].map((id) => `'${id.replaceAll("'", "''")}'`).join(', ');
    const probe = await run(
      `SELECT statement_id, read_bytes, execution_duration_ms FROM system.query.history WHERE statement_id IN (${list})`,
      []
    );
    if (probe.error == null) {
      const at = (name) => probe.columns.indexOf(name);
      for (const row of probe.rows) {
        found.set(row[at('statement_id')], {
          readBytes: row[at('read_bytes')] == null ? null : Number(row[at('read_bytes')]),
          executionMs: row[at('execution_duration_ms')] == null ? null : Number(row[at('execution_duration_ms')]),
        });
        remaining.delete(row[at('statement_id')]);
      }
    }
    console.log(`  query history: ${String(found.size)} of ${String(ids.length)} landed.`);
    if (remaining.size === 0 || Date.now() >= deadline) break;
  }
  return found;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

const name = process.argv[2];
const candidatePath = process.argv[3];
if (name == null || candidatePath == null) {
  console.error('Usage: node scripts/measure-sql-candidate.mjs <statement_name> <candidate.sql>');
  process.exit(2);
}
if (WAREHOUSE === '' || HOST === '') {
  console.error('Set DATABRICKS_WAREHOUSE_ID and DATABRICKS_HOST (both live in app/.env for labs).');
  process.exit(2);
}

const shipped = customerCatalog(
  readFileSync(join(STATEMENTS_DIR, `${name}.sql`), 'utf8').replace(/;\s*$/, '').trim()
);
// `resolve` rather than `join`, so the absolute path this script's own header documents reaches the
// file it names: `join(APP, '/tmp/candidate.sql')` is `app/tmp/candidate.sql`, which does not exist.
const candidate = customerCatalog(
  readFileSync(resolve(APP, candidatePath.replace(/^app\//, '')), 'utf8').replace(/;\s*$/, '').trim()
);

console.log('warming the warehouse (this reading is discarded)...');
await run('SELECT 1', []);

// Every statement that filters on live workspaces needs the ids the directory returns, the way the
// collector binds them.
const directoryText = customerCatalog(
  readFileSync(join(STATEMENTS_DIR, 'workspace_directory.sql'), 'utf8').replace(/;\s*$/, '').trim()
);
const directory = await run(
  directoryText,
  declaredParams(directoryText).map((one) => ({ name: one, ...parameterValue(one) }))
);
if (directory.error == null) {
  const live = directory.columns.indexOf('live');
  const id = directory.columns.indexOf('workspace_id');
  liveWorkspaceIds = directory.rows
    .filter((row) => row[live] === 'true')
    .map((row) => row[id])
    .join(',');
}
console.log(`  live workspaces: ${String(liveWorkspaceIds.split(',').filter((one) => one !== '').length)}`);

const parameters = declaredParams(shipped).map((one) => ({ name: one, ...parameterValue(one) }));
const candidateParameters = declaredParams(candidate).map((one) => ({ name: one, ...parameterValue(one) }));

console.log(`\nrunning ${name} and its candidate ${String(SAMPLES)}× each, alternating...`);
const sides = { shipped: [], candidate: [] };
const ids = { shipped: [], candidate: [] };
let shippedRows = null;
let candidateRows = null;
for (let sample = 0; sample < SAMPLES; sample += 1) {
  const a = await run(shipped, parameters);
  const b = await run(candidate, candidateParameters);
  if (a.error != null || b.error != null) {
    console.error(`  FAILED: ${String(a.error ?? b.error)}`);
    process.exit(1);
  }
  sides.shipped.push(a.durationMs);
  sides.candidate.push(b.durationMs);
  ids.shipped.push(a.statementId);
  ids.candidate.push(b.statementId);
  shippedRows ??= { columns: a.columns, rows: a.rows };
  candidateRows ??= { columns: b.columns, rows: b.rows };
  console.log(
    `  sample ${String(sample + 1)}: shipped ${String(a.durationMs)} ms, candidate ${String(b.durationMs)} ms`
  );
}

// The first of each side dropped, for the reason the header gives.
const shippedKept = sides.shipped.slice(1);
const candidateKept = sides.candidate.slice(1);
const shippedMedian = median(shippedKept);
const candidateMedian = median(candidateKept);

console.log('\nreading what each scanned...');
const history = await readBytesFor([ids.shipped[1], ids.candidate[1]]);
const shippedBytes = history.get(ids.shipped[1]) ?? {};
const candidateBytes = history.get(ids.candidate[1]) ?? {};

const sameColumns = JSON.stringify(shippedRows.columns) === JSON.stringify(candidateRows.columns);
const sameRows = JSON.stringify(shippedRows.rows) === JSON.stringify(candidateRows.rows);

console.log(`\n${name}: shipped vs candidate`);
console.log(`  readings   shipped ${sides.shipped.join(', ')} ms (first dropped)`);
console.log(`             candidate ${sides.candidate.join(', ')} ms (first dropped)`);
console.log(`  median     shipped ${String(shippedMedian)} ms, candidate ${String(candidateMedian)} ms`);
console.log(
  `             ${
    candidateMedian < shippedMedian
      ? `candidate is ${String(Math.round((1 - candidateMedian / shippedMedian) * 100))}% faster`
      : `candidate is ${String(Math.round((candidateMedian / shippedMedian - 1) * 100))}% slower`
  }`
);
console.log(
  `  read_bytes shipped ${String(shippedBytes.readBytes ?? 'unknown')}, candidate ${String(candidateBytes.readBytes ?? 'unknown')}`
);
console.log(
  `  engine ms  shipped ${String(shippedBytes.executionMs ?? 'unknown')}, candidate ${String(candidateBytes.executionMs ?? 'unknown')}`
);
console.log(`  same columns: ${String(sameColumns)}, same rows: ${String(sameRows)}`);
if (!sameColumns || !sameRows) {
  console.log('\n  The candidate does not answer what the shipped statement answers. That is not a candidate.');
  if (!sameColumns) {
    console.log(`    shipped columns:   ${shippedRows.columns.join(', ')}`);
    console.log(`    candidate columns: ${candidateRows.columns.join(', ')}`);
  }
  process.exit(1);
}
