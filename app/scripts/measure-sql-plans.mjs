// Measures the two premises Q1e's rework is scheduled on, before the rework decides what it is.
//
// Live and optional, like measure-sql-baseline.mjs: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-sql-plans.mjs
//
// ## The two premises
//
// **That adaptive hash bucketing repeats the whole scan.** `docs/plan/sql-quality.md` says the wrapper
// "reduces serialized result size but repeats the full source scan and aggregation for every bucket",
// and schedules a rewrite that pushes the predicate below the grouping. Whether it repeats the scan is
// not a property of where the predicate is written — it is a property of where the engine evaluates it,
// and Catalyst pushes a deterministic filter on a grouping key through the aggregate as a matter of
// course. So this asks the engine: `EXPLAIN FORMATTED` on the wrapped statement, and where the bucket
// predicate lands in the plan it produces.
//
// **That a statement's recorded duration is a budget.** Q1a records one reading per statement and the
// release gate holds class ceilings against it. `uc_lineage_coverage` was recorded at 6.8s, then at
// 23.7s against a 20s ceiling, then at 21.0s, 22.0s, 22.6s and 27.1s on one afternoon, without the
// statement changing — so at least one of those numbers is not a budget. This runs every statement
// `SAMPLES` times and records the spread, which is the thing a ceiling has to be outside of before a
// plan change can be said to have moved anything.
//
// Both write to runtime-baseline/labs-plans.json, beside labs.json rather than inside it: the four
// readers of that file — the release gate, the published table, the acceptance script and
// runtime-baseline.test.ts — hold its shape, and a measurement that changes what it is answers a
// different question from the one it was recorded for.

import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const STATEMENTS_DIR = join(APP, 'config', 'statements');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plans.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '';
const SAMPLES = Number(process.env.SAMPLES ?? 5);
/** How many buckets the cost pass splits a statement into. Four is what `buckets.ts` starts at. */
const BUCKETS = Number(process.env.BUCKETS ?? 4);
// The three passes are separable because they cost very different amounts — the variance pass is
// every statement five times and takes a quarter of an hour, the other two are minutes. Each writes
// only its own section of the output file and leaves the others as the last run left them, so a
// re-measurement of one premise does not discard the other's readings.
const EXPLAIN = process.env.EXPLAIN !== '0';
const COST = process.env.COST !== '0';
const SCANS = process.env.SCANS !== '0';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

/** Mirrors measure-sql-baseline.mjs, which mirrors collector.ts. Copied for the reason its header gives. */
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

let liveWorkspaceIds = '';

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

/**
 * Every `:name` the statement's body binds, over the body only.
 *
 * Comments are stripped first, and not as tidiness: a header sentence containing `:estate` reads as a
 * parameter to a bare regex, and the first run of this script stopped on one. measure-sql-baseline.mjs
 * has the same pair of functions for the same reason, and this is copied from it rather than imported
 * for the reason that script's own header gives — both run as plain ESM outside the TypeScript build.
 */
function declaredParams(text) {
  const body = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
  return [...new Set([...body.matchAll(/:([a-z_][a-z0-9_]*)/g)].map((match) => match[1]))].sort();
}

/** Mirrors queries.ts's `customerCatalogPredicate`, as measure-sql-baseline.mjs mirrors it. */
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
  response = await settled(response, { call, polls: MAX_POLLS, pollIntervalMs: POLL_INTERVAL_MS });

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
    columns: (response.manifest?.schema?.columns ?? []).map((c) => c.name),
  };
}

/**
 * What the engine says each of these statements read, once query history has caught up.
 *
 * `read_bytes` is the field the bucketing premise turns on: a predicate the plan shows at the scan
 * still leaves the scan reading whatever the file layout forces it to, and only the bytes say which.
 * Polled rather than read once, and on the same budget as measure-sql-baseline.mjs, whose header
 * records the measurement that budget comes from — nothing landed at 30 seconds, everything by eight
 * minutes. Whatever has not landed by then stays null, and a null is reported as unknown rather than
 * as zero.
 */
async function readBytesFor(statementIds) {
  const found = new Map();
  if (statementIds.length === 0) return found;
  const remaining = new Set(statementIds);
  const deadline = Date.now() + 9 * 60_000;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const wait = Math.min(60_000, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const list = [...remaining].map((id) => `'${id.replaceAll("'", "''")}'`).join(', ');
    const probe = await run(
      `SELECT statement_id, read_bytes, read_files, execution_duration_ms\nFROM system.query.history\nWHERE statement_id IN (${list})`,
      []
    );
    if (probe.error == null) {
      const at = (name) => probe.columns.indexOf(name);
      for (const row of probe.rows) {
        found.set(row[at('statement_id')], {
          readBytes: row[at('read_bytes')] == null ? null : Number(row[at('read_bytes')]),
          readFiles: row[at('read_files')] == null ? null : Number(row[at('read_files')]),
          executionMs: row[at('execution_duration_ms')] == null ? null : Number(row[at('execution_duration_ms')]),
        });
        remaining.delete(row[at('statement_id')]);
      }
    }
    console.log(`  query history: ${String(found.size)} of ${String(statementIds.length)} landed so far.`);
    if (remaining.size === 0 || Date.now() >= deadline) break;
  }
  return found;
}

/**
 * Where the bucket predicate ends up in the plan the engine chose.
 *
 * Read off the physical plan's own vocabulary rather than by parsing the tree. `RequiredDataFilters` and
 * `PushedFilters` on a scan node are the engine saying it applies the predicate while reading; a
 * `PhotonFilter` above the aggregate is the engine saying it applies it afterwards, which is the reading
 * the plan assumed. Both can appear — the question the premise turns on is whether the *scan* carries
 * it, because that is what decides whether a second bucket re-reads the first bucket's rows.
 */
function wherePredicateLanded(plan) {
  const lines = plan.split('\n');
  const scanFilters = lines.filter((line) => /Required(Data)?Filters:|PushedFilters:/.test(line));
  const atScan = scanFilters.some((line) => line.includes('pmod') && line.includes('hash'));
  const filterNodes = lines.filter((line) => /^\(\d+\) \w*Filter/.test(line.trim()));
  return {
    atScan,
    scanFilterLines: scanFilters.map((line) => line.trim()),
    filterNodeCount: filterNodes.length,
  };
}

/** The plan's numbered node headers, in the order `EXPLAIN FORMATTED` prints them. */
function nodesOf(plan) {
  return plan
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^\(\d+\) [A-Za-z]/.test(line));
}

/**
 * Every scan in the plan, with the relation it reads and how many columns it takes off it.
 *
 * This is what decides Q1k's two remaining premises, and neither is decidable from the SQL text.
 *
 * `SELECT *` inside a CTE reads as a statement carrying every column of a wide history table through a
 * window. Whether it *does* is a property of the optimiser: column pruning is supposed to cut the scan
 * back to the columns something above it references, and if it does then the `*` costs nothing and
 * rewriting it is cosmetic. `Output [n]:` on the scan node is the engine's own count of what it reads.
 *
 * A CTE referenced twice reads as two scans of the same relation. Whether it is depends on whether the
 * engine reuses the subtree, so counting the scan nodes per relation is the question asked directly.
 * The detail section is used rather than the tree, because `EXPLAIN FORMATTED` prints one numbered
 * block per node there and a scan appears in it once per time the engine performs it.
 */
export function scansOf(plan) {
  const scans = [];
  const folded = [];
  const lines = plan.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const header = /^\((\d+)\) ([A-Za-z]\w*)(?: (.*))?$/.exec(lines[index].trim());
    if (header == null) continue;
    const kind = header[2];
    // `LocalTableScan` names no relation, and its presence is the finding rather than a detail: the
    // engine replaced a read with a constant, which on these statements means the relation was empty.
    // The first version of this function matched only named scans, so every statement whose reads all
    // folded reported zero scans and "no relation read twice" — a clean-looking answer to a question
    // the estate cannot answer. That is the reading `storage_table_metrics` and `uc_platform_census`
    // returned, and it is why this reports folds separately instead of skipping them.
    const isFold = kind === 'LocalTableScan';
    const isScan = /^(?:Photon)?(?:Scan|BatchScan|FileScan)/.test(kind);
    if (!isFold && !isScan) continue;
    // `Scan parquet system.lakeflow.jobs` names the format before the relation. Stripped, so that two
    // reads of one table count as two reads of one name rather than being keyed by `parquet system…`.
    const named = (header[3] ?? '').trim();
    const relation = /^[a-z]+ (\S.*)$/.exec(named)?.[1] ?? named;
    // The one-row source every `SELECT <scalars>` has. Not a read of anything, and counting it as one
    // put a scan of nothing beside `uc_platform_census`'s eighteen subqueries.
    if (relation === 'OneRowRelation') continue;

    // `Output [8]: [catalog_name#1, ...]`, read from this node's own block: the search stops at the
    // next numbered header rather than running into the following block's Output.
    let columnCount = null;
    let emptyArguments = false;
    for (let ahead = index + 1; ahead < lines.length; ahead += 1) {
      const line = lines[ahead].trim();
      if (/^\(\d+\) [A-Za-z]/.test(line)) break;
      const output = /^Output ?(?:\[(\d+)\])?:(.*)$/.exec(line);
      if (output != null && columnCount == null) {
        columnCount = output[1] != null ? Number(output[1]) : (output[2].match(/#\d+/g) ?? []).length;
      }
      if (/^Arguments: <empty>/.test(line)) emptyArguments = true;
    }
    const entry = { node: Number(header[1]), kind, relation, columnCount, emptyArguments };
    if (isFold) folded.push(entry);
    else scans.push(entry);
  }
  return { scans, folded };
}

/** How many times each relation is scanned, relation name to scan count. */
function scansPerRelation(scans) {
  const counted = {};
  for (const scan of scans) counted[scan.relation] = (counted[scan.relation] ?? 0) + 1;
  return counted;
}

/** The statements whose text asks for every column of something, and the relation each one reads. */
function starProjections(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .filter((line) => /(^|\s|\()SELECT\s+\*(\s|,|$)/i.test(line) || /^\s*\*,\s*$/.test(line))
    .map((line) => line.trim());
}

/**
 * The statement's declared slice axes, coarsest first. `slices.ts` is the authority; this reads the header.
 *
 * Lowercased for the same reason `declaredSlice` lowercases: a header written `-- Slice: workspace_id,
 * Job_id` would otherwise have this script bucket on `Job_id` and the collector on `job_id`, which is
 * two different measurements of one wrapper and no failure anywhere. `measure-sql-plans.test.ts` holds
 * the two readings equal over the four statements on disk, and none of them is mixed case today — which
 * is why this is a copy of the rule rather than a reaction to a fault.
 */
export function declaredSliceColumns(text) {
  const header = /^--\s*Slice:\s*(.+)$/im.exec(text);
  return header == null
    ? []
    : header[1]
        .split(',')
        .map((part) => part.trim().toLowerCase())
        .filter((part) => part !== '');
}

/**
 * The wrapper `buckets.ts` builds, reproduced here because that module is TypeScript and this runs as
 * plain ESM outside the build, for the reason measure-sql-baseline.mjs gives about its own copies.
 *
 * Reproduced is the load-bearing word. A measurement of a wrapper this repository does not ship is a
 * real, reproducible number about something that does not exist, which is H1b's fixture and the reason
 * `measure-sql-plans.test.ts` holds this against `buckets.ts` character for character.
 */
export function bucketed(statement, column, of, index) {
  const first = /^--.*$/m.exec(statement)?.[0] ?? '-- statement';
  return (
    `${first} (bucket ${String(index + 1)} of ${String(of)} on ${column})\n` +
    `SELECT * FROM (\n${statement}\n) AS sliced\nWHERE pmod(hash(sliced.\`${column}\`), ${String(of)}) = ${String(index)}`
  );
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (WAREHOUSE === '' || HOST === '') {
    console.error('Set DATABRICKS_WAREHOUSE_ID and DATABRICKS_HOST (both live in app/.env for labs).');
    process.exit(2);
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(STATEMENTS_DIR).filter((name) => name.endsWith('.sql')).sort();
  const ordered = ['workspace_directory.sql', ...files.filter((name) => name !== 'workspace_directory.sql')];
  const texts = new Map(
    ordered.map((file) => [file.replace(/\.sql$/, ''), customerCatalog(readFileSync(join(STATEMENTS_DIR, file), 'utf8').replace(/;\s*$/, '').trim())])
  );

  console.log('warming the warehouse (this reading is discarded)...');
  await run('SELECT 1', []);

  // workspace_directory first, for the live ids every other statement filters on.
  const directory = await run(texts.get('workspace_directory'), declaredParams(texts.get('workspace_directory')).map((name) => ({ name, ...parameterValue(name) })));
  if (directory.error == null) {
    const live = directory.columns.indexOf('live');
    const id = directory.columns.indexOf('workspace_id');
    liveWorkspaceIds = directory.rows.filter((row) => row[live] === 'true').map((row) => row[id]).join(',');
  }
  console.log(`  live workspaces: ${String(liveWorkspaceIds.split(',').filter((one) => one !== '').length)}`);

  console.log('\nexplaining the bucket wrapper against the statements that can be bucketed...');
  const bucketing = {};
  for (const [name, text] of texts) {
    if (!EXPLAIN) break;
    const columns = declaredSliceColumns(text);
    if (columns.length < 2) continue;
    const column = columns[1];
    const parameters = declaredParams(text).map((one) => ({ name: one, ...parameterValue(one) }));
    const whole = await run(`EXPLAIN FORMATTED ${text}`, parameters);
    // The same fan-out the cost pass runs, so a re-measurement at another `BUCKETS` does not leave the
    // plan evidence describing four buckets beside a cost over sixteen.
    const piece = await run(`EXPLAIN FORMATTED ${bucketed(text, column, BUCKETS, 1)}`, parameters);
    if (whole.error != null || piece.error != null) {
      console.log(`  ${name}: FAILED ${String(whole.error ?? piece.error)}`);
      bucketing[name] = { column, error: whole.error ?? piece.error };
      continue;
    }
    const plan = piece.rows[0][0];
    const landed = wherePredicateLanded(plan);
    console.log(`  ${name} on ${column}: predicate ${landed.atScan ? 'reaches the scan' : 'stays above the scan'}`);
    bucketing[name] = {
      column,
      predicateAtScan: landed.atScan,
      scanFilterLines: landed.scanFilterLines,
      // The node list rather than the plan. A formatted plan for these four is 30 to 90 KB of one-line
      // JSON string each, which is evidence nobody reads in a diff and the reason this keeps the
      // skeleton and the filter lines instead: the node list says what the engine built, the filter
      // lines say where it put the predicate, and re-running the script reproduces the rest.
      buckets: BUCKETS,
      wholeNodes: nodesOf(whole.rows[0][0]),
      bucketedNodes: nodesOf(plan),
      bucketedPlanChars: plan.length,
    };
  }

  console.log('\nexplaining every statement, for what its scans read and how many times...');
  const scanning = {};
  for (const [name, text] of texts) {
    if (!SCANS) break;
    const parameters = declaredParams(text).map((one) => ({ name: one, ...parameterValue(one) }));
    const explained = await run(`EXPLAIN FORMATTED ${text}`, parameters);
    if (explained.error != null) {
      console.log(`  ${name}: FAILED ${explained.error}`);
      scanning[name] = { error: explained.error };
      continue;
    }
    const plan = explained.rows[0][0];
    const { scans, folded } = scansOf(plan);
    const perRelation = scansPerRelation(scans);
    const repeated = Object.entries(perRelation).filter(([, count]) => count > 1);
    const stars = starProjections(text);
    // A statement with no file scan in its plan cannot answer either question, and there are two
    // different reasons for that which must not be collapsed into one.
    //
    // A read folded to an *empty* local relation means the relation holds nothing on this estate — the
    // premise is untestable here and testable elsewhere. `system.storage.table_metrics_history` is the
    // case: 0 rows on labs, so the statement's second branch and its LIMIT are optimised away entirely.
    //
    // A read folded to a *non-empty* local relation means the plan never exposed a scan to inspect.
    // Every `system.information_schema` view does this: the metastore returns the rows and the engine
    // treats them as a constant relation, so plan inspection is the wrong instrument rather than the
    // estate being the wrong estate.
    const foldedToEmpty = folded.filter((one) => one.emptyArguments).length;
    const answerable = scans.length > 0;
    const why = answerable
      ? null
      : foldedToEmpty > 0
        ? 'a relation is empty on this estate, so the plan has no read to inspect'
        : 'every read is metastore-served and arrives as a local relation, which no plan exposes as a scan';
    scanning[name] = {
      // What the text asks for, beside what the engine does about it. Both halves are needed: the lines
      // alone are the premise and the counts alone cannot be traced back to a statement.
      starLines: stars,
      scans: scans.map((scan) => ({ relation: scan.relation, columns: scan.columnCount })),
      scansPerRelation: perRelation,
      repeatedRelations: Object.fromEntries(repeated),
      widestScanColumns: scans.reduce((widest, scan) => Math.max(widest, scan.columnCount ?? 0), 0),
      localScans: folded.length,
      localScansOnEmptyRelation: foldedToEmpty,
      // Not "no repeated scan" but "this reading does not say". The distinction is the whole value of
      // the field: the premise about these statements stays untested rather than being recorded as
      // refuted by a plan that contains no reads at all.
      answersRepeatedScans: answerable,
      ...(why == null ? {} : { unanswerableBecause: why }),
    };
    console.log(
      answerable
        ? `  ${name}: ${String(scans.length)} scan(s), widest reads ${String(scanning[name].widestScanColumns)} ` +
            `columns, ${repeated.length === 0 ? 'no relation read twice' : `${String(repeated.length)} read more than once`}` +
            `${stars.length === 0 ? '' : `, ${String(stars.length)} \`SELECT *\` in the text`}`
        : `  ${name}: no scan in the plan, ${String(folded.length)} local relation(s) — ${String(why)}`
    );
  }

  console.log('\nrunning the bucketable statements whole and in four buckets...');
  const cost = {};
  const ids = [];
  for (const [name, text] of texts) {
    if (!COST) break;
    const columns = declaredSliceColumns(text);
    if (columns.length < 2) continue;
    const column = columns[1];
    const parameters = declaredParams(text).map((one) => ({ name: one, ...parameterValue(one) }));
    const whole = await run(text, parameters);
    if (whole.error != null) {
      console.log(`  ${name}: FAILED ${whole.error}`);
      cost[name] = { column, error: whole.error };
      continue;
    }
    const pieces = [];
    for (let index = 0; index < BUCKETS; index += 1) {
      const piece = await run(bucketed(text, column, BUCKETS, index), parameters);
      if (piece.error != null) {
        console.log(`  ${name}: bucket ${String(index)} FAILED ${piece.error}`);
        break;
      }
      pieces.push({ statementId: piece.statementId, durationMs: piece.durationMs, rows: piece.rows.length });
    }
    if (pieces.length < BUCKETS) {
      cost[name] = { column, error: 'a bucket did not complete' };
      continue;
    }
    ids.push(whole.statementId, ...pieces.map((piece) => piece.statementId));
    cost[name] = {
      column,
      buckets: BUCKETS,
      whole: { statementId: whole.statementId, durationMs: whole.durationMs, rows: whole.rows.length },
      pieces,
      // The rows every bucket returned, against the rows the whole statement did. Equal is what the
      // wrapper claims and what `bucket-pushdown.test.ts` holds over fixtures; unequal here would say
      // the estate does something the fixtures do not.
      rowsWhole: whole.rows.length,
      rowsBucketed: pieces.reduce((sum, piece) => sum + piece.rows, 0),
    };
    console.log(
      `  ${name}: whole ${String(whole.durationMs)} ms / ${String(whole.rows.length)} rows, ` +
        `four buckets ${pieces.map((piece) => String(piece.durationMs)).join(' + ')} ms / ` +
        `${String(cost[name].rowsBucketed)} rows`
    );
  }

  console.log('\nreading what each of those scanned...');
  let history = new Map();
  try {
    history = await readBytesFor(ids);
  } catch (error) {
    console.log(`  query history read failed, leaving bytes unknown: ${String(error.message ?? error)}`);
  }
  for (const [name, entry] of Object.entries(cost)) {
    if (entry.whole == null) continue;
    entry.whole = { ...entry.whole, ...(history.get(entry.whole.statementId) ?? {}) };
    entry.pieces = entry.pieces.map((piece) => ({ ...piece, ...(history.get(piece.statementId) ?? {}) }));
    const bytes = entry.pieces.map((piece) => piece.readBytes);
    entry.readBytesWhole = entry.whole.readBytes ?? null;
    entry.readBytesBucketed = bytes.some((one) => one == null) ? null : bytes.reduce((sum, one) => sum + one, 0);
    if (entry.readBytesWhole != null && entry.readBytesBucketed != null && entry.readBytesWhole > 0) {
      entry.readAmplification = Math.round((entry.readBytesBucketed / entry.readBytesWhole) * 100) / 100;
      console.log(
        `  ${name}: whole read ${String(entry.readBytesWhole)} bytes, ${String(BUCKETS)} buckets read ` +
          `${String(entry.readBytesBucketed)} — ×${String(entry.readAmplification)}`
      );
    } else {
      // Reported rather than skipped. `compute_cluster_inventory` read zero bytes whole and 12,668 per
      // bucket on the run this was written against, which is not a ratio and is not nothing either.
      console.log(
        `  ${name}: whole read ${String(entry.readBytesWhole)} bytes, ${String(BUCKETS)} buckets read ` +
          `${String(entry.readBytesBucketed)} — no ratio, because the whole read is ${String(entry.readBytesWhole)}`
      );
    }
  }

  console.log(`\nsampling every statement ${String(SAMPLES)} times...`);
  const variance = {};
  for (const [name, text] of texts) {
    if (SAMPLES < 1) break;
    const parameters = declaredParams(text).map((one) => ({ name: one, ...parameterValue(one) }));
    const readings = [];
    for (let sample = 0; sample < SAMPLES; sample += 1) {
      const result = await run(text, parameters);
      if (result.error != null) {
        console.log(`  ${name}: FAILED ${result.error}`);
        break;
      }
      readings.push(result.durationMs);
    }
    if (readings.length === 0) {
      variance[name] = { error: 'no reading completed' };
      continue;
    }
    const min = Math.min(...readings);
    const max = Math.max(...readings);
    variance[name] = { readings, min, median: median(readings), max, spreadRatio: Math.round((max / min) * 100) / 100 };
    console.log(`  ${name}: ${readings.join(', ')} ms — median ${String(variance[name].median)}, spread ×${String(variance[name].spreadRatio)}`);
  }

  let previous = {};
  try {
    previous = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  } catch {
    previous = {};
  }
  // A fan-out at the top of the file was a lie waiting for the first run at another one: the two passes
  // that use it can be switched off independently, so one number cannot describe both. Each entry of
  // `bucketing` and `cost` carries the fan-out it was measured at, and this drops the old top-level copy
  // rather than trying to keep it true.
  delete previous.buckets;
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        ...previous,
        runFinishedAt: new Date().toISOString(),
        profile: PROFILE,
        lookbackDays: LOOKBACK_DAYS,
        workspaceId: WORKSPACE_ID,
        // A pass that did not run leaves the last run's number where it was.
        samples: SAMPLES < 1 ? (previous.samples ?? 0) : SAMPLES,
        ...(EXPLAIN ? { bucketing } : {}),
        ...(SCANS ? { scanning } : {}),
        ...(COST ? { cost } : {}),
        ...(SAMPLES < 1 ? {} : { variance }),
      },
      null,
      2
    )}\n`
  );
  console.log(`\nwrote ${OUT_FILE}`);
}

// Only when run, so `measure-sql-plans.test.ts` can import the two functions that have to agree with
// what ships. Importing a module whose top level runs a fifteen-minute measurement is the kind of
// test that gets deleted rather than fixed.
if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) await main();
