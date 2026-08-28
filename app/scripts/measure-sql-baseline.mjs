// Measures every statement in config/statements/ against a real warehouse, and records the seven
// correctness populations docs/plan/sql-quality.md Q1a needs before any of Q1b through Q1e rewrites
// what these statements do.
//
// Live, optional, like guidance:sql: nothing here runs as part of `npm run verify`, because it needs a
// warehouse and a CLI profile with a token to mint. Run it by hand and commit what it writes.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-sql-baseline.mjs
//
// `ONLY=<statement>[,<statement>]` measures those and merges them into the committed recording, which is what
// adding one statement needs. See `ONLY` below for what a merge may and may not carry forward.
//
// Each statement runs `SAMPLES` times, five by default, and the record carries the distribution as
// well as the first reading. That is 36l's change, and the reason is 36e's measurement: five samples of
// every statement on labs put the previously-committed reading below all five for ten of the
// twenty-five, and two statements over their class ceiling on the median while the file said they were
// inside it. `durationMs` remains the first execution's own wall clock, because the id, the row and byte
// counts and the sha beside it all come from that execution; `durations.median` is what the gate holds.
//
// What this measures and what it does not. `manifest.total_byte_count` and `manifest.total_row_count`
// come back with the result and cost nothing extra, so they are exact. `durationMs` is this script's
// own wall clock around the call, which is what a caller actually waits — not the warehouse's internal
// `execution_duration_ms`, which system.query.history carries and which the best-effort enrichment
// pass below adds when it can. Shuffle and spill are read from system.query.history in one pass after
// every statement has run, and are null when that table has not yet caught up with a submission this
// recent — a real limit of measuring "now" against a table with unspecified ingestion latency, and
// `docs/design/q1a-runtime-baseline.md` says which statements it held true for. The physical plan is
// left null throughout: reading it needs a second API surface per statement rather than a column on
// the one already open, and nothing downstream of this pack depends on it existing.
//
// Parameter binding and the `{{customer_catalog ...}}` fragment mirror
// server/collect/sql/collector.ts and server/collect/sql/queries.ts, copied rather than imported
// because this script runs as plain ESM outside the TypeScript build. `columns.ts`'s `columnsOf` is
// not copied here for the same reason it does not need to be: the warehouse's own manifest names the
// column count for every statement this script runs, and runtime-baseline.test.ts holds that count
// against the real `columnsOf` from the TypeScript source directly, so there is exactly one copy of
// that logic in the tree.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const STATEMENTS_DIR = join(APP, 'config', 'statements');
const PROBES_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline', 'probes');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);
const WORKSPACE_ID = process.env.WORKSPACE_ID ?? '';
/**
 * How many times each statement runs, because one reading is not a budget.
 *
 * Measured, not chosen as a round number: 36e ran every statement five times on labs and the committed
 * reading was below all five samples for ten of the twenty-five. `check-sql-release.mjs` refuses a
 * recording with fewer than `MINIMUM_SAMPLES` of them, so lowering this is a change a reviewer sees
 * rather than a faster run.
 *
 * Five rather than three since 36n, and the reason is that this recording is what the gate compares
 * against. Held against itself — the same statement on both sides, so any difference is this apparatus —
 * `workspace_directory` gave eight readings spanning ×1.67 and two medians of four that were 21% apart.
 * A ×1.5 regression factor sits about three of those error bars from zero, so a median of three decides
 * gate outcomes on the warehouse's mood. Three was previously the default as a compromise with a run
 * somebody will sit through; the compromise was on the wrong side, because a false failure costs the
 * twenty minutes it saved plus the investigation.
 */
const SAMPLES = Math.max(1, Number(process.env.SAMPLES ?? 5));
/**
 * Which statements to measure, defaulting to all of them.
 *
 * `ONLY=workload_table_statistics node scripts/measure-sql-baseline.mjs` measures one and merges its reading
 * into the committed recording, leaving every other entry exactly as it was.
 *
 * Added because adding a statement had no cheap way to record one. The alternative was re-measuring
 * twenty-five, which is minutes of warehouse time to answer a question about one of them and — the reason
 * this exists rather than being a convenience — puts twenty-four unrelated readings back through the gate's
 * comparison against `accepted.json` at a moment when nothing about them changed. A ×1.5 regression factor
 * against a warehouse whose spread 36n measured at ×1.67 on one statement means a full re-measure can fail
 * on the warehouse's mood, and a failure nobody caused is a failure nobody reads.
 *
 * A merge whose reading failed writes nothing at all and exits non-zero, because the entry it would replace is
 * one that worked — see the write below.
 *
 * What a merge may not become is a way to keep a stale reading beside a rewritten statement:
 * `runtime-baseline.test.ts` recomputes each entry's `statementSha` from the file on disk, so an entry left
 * behind by a merge while its `.sql` changed fails there. That check is what makes this safe, and it predates
 * this flag — it exists because three readings were once spliced in by hand under one file-level date.
 */
const ONLY = (process.env.ONLY ?? '')
  .split(',')
  .map((one) => one.trim())
  .filter((one) => one !== '');

if (WAREHOUSE === '' || HOST === '') {
  console.error('Set DATABRICKS_WAREHOUSE_ID and DATABRICKS_HOST (both live in app/.env for labs).');
  console.error('DATABRICKS_CONFIG_PROFILE selects the CLI profile a token is minted from, and defaults to labs.');
  process.exit(2);
}

// Mirrors server/collect/sql/self.ts. A run of this script has to be recognisable in query history by
// the same marks the app's own statements carry, both so a workspace admin can tell it apart from the
// app's scheduled runs and so it does not get counted as the estate's own work by the population this
// pack measures for workload_query_shapes.sql (probe g) and workload_warehouse_pressure.sql.
const SELF_MARKER = '-- databricks-waf: assessment\n';
const SELF_TAGS = [{ key: 'databricks_waf', value: 'assessment' }];
function mark(statement) {
  return statement.startsWith(SELF_MARKER) ? statement : `${SELF_MARKER}${statement}`;
}

// Mirrors server/collect/sql/queries.ts's customerCatalogPredicate and expandFragments. The fragment
// is structure rather than a bound value, so it cannot go through the parameters below; queries.ts
// holds the one definition this has to keep reading the same as.
const DATABRICKS_OWNED = "'system', 'samples'";
const DATABRICKS_INTERNAL = "'__databricks_internal'";
const SYSTEM_OWNER = "'System user'";
function customerCatalogPredicate(column) {
  return (
    `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs ` +
    `WHERE catalog_owner = ${SYSTEM_OWNER}) AND lower(${column}) NOT IN (${DATABRICKS_OWNED})` +
    ` AND NOT startswith(lower(${column}), ${DATABRICKS_INTERNAL}))`
  );
}
const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
function expandFragments(statement) {
  return statement.replace(FRAGMENT, (_whole, column) => customerCatalogPredicate(column));
}

/**
 * The fingerprint of the text that was submitted, recorded beside every reading.
 *
 * Arity was the only thing tying a reading to a statement, so any rewrite that preserved column count
 * left the old duration in place as a measured budget for a statement that no longer existed. This is
 * over the expanded text as submitted, minus the self marker, and `runtime-baseline.test.ts` recomputes
 * it the same way it recomputes arity — so a statement edited without re-measuring fails `verify`
 * instead of publishing a budget for its previous form.
 *
 * The text as submitted includes the comments, because that is what goes to the warehouse. So editing a
 * statement's prose invalidates the recording and costs a fresh run of this script — twenty-odd minutes
 * at `SAMPLES=5`. That is the honest behaviour for a fingerprint of what was executed, and it is worth
 * knowing before a review round asks for a comment change: settle the prose in the same pass as the SQL.
 */
function statementSha(text) {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}

/**
 * The slice column a statement declares, or null. Recorded because this harness binds every live
 * workspace at once and the collector executes a sliced statement once per workspace, re-executing
 * truncating slices as hash buckets: for these statements the reading describes a form of the
 * statement the app never runs, and `slicedInRecording` is false on every record so that a reader of
 * the file, the gate or the published table is told which ones those are.
 */
function sliceColumn(text) {
  return /^--\s*Slice:\s*(\S+)/m.exec(text)?.[1] ?? null;
}

/** A statement with its `--` comment lines removed, so a parameter only mentioned in prose is not bound. */
function withoutLineComments(text) {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n');
}

/** Every `:name` parameter a statement's body actually uses, matching the convention check-statement-bounds.mjs reads by. */
function declaredParams(text) {
  const found = new Set();
  for (const match of withoutLineComments(text).matchAll(/:([a-z_][a-z0-9_]*)/g)) found.add(match[1]);
  return [...found].sort();
}

/** The live workspace ids, filled in once workspace_directory has run. Empty means no filter — the same degraded-path convention collector.ts uses. */
let liveWorkspaceIds = '';

/**
 * The serving declaration these three statements are measured against, and why it is written here.
 *
 * `SqlCollector` binds `''` to all three of these by default, because what a customer serves is
 * something a person declares in the app and no default can guess it. Bound empty, `serving_population`
 * matches nothing and the two reads below it are handed no assets — three statements that return in
 * milliseconds and describe nothing. `62` says exactly that: a statement measured over nothing has a
 * duration and no budget.
 *
 * So this is a declaration, made here, of the shape a customer's would be, and read off labs rather
 * than invented: `main.servco_demo`'s eight tables carry `data_product` on all eight, `domain` on all
 * eight and `layer` on three, which is the tagged half. The two named tables are in the same schema and
 * carry no tags at all, which is the half a tag selector cannot reach — a declaration naming only tags
 * would leave `serving_population`'s `declared` branch untimed, and it is one of the four unioned
 * arms of the statement.
 *
 * What it does not establish is scale. Labs holds 408 catalogued relations against large-estate's
 * 495,558, and these statements are bounded to a declared population rather than to the estate, so the
 * reading says what the statement costs over a population of this size and nothing about a population
 * a catalog tag would select. [`61`](../../docs/plan/61-discovery-statement-cost.md) is the row that
 * exists for that, and the recording carries these values on every reading so a reader can see which
 * question was answered.
 */
const SERVING_DECLARATION = {
  names: 'main.servco_demo.call_actions,main.servco_demo.document_extracts',
  tagKeys: 'data_product,domain,layer',
};

/**
 * The population's qualified names, filled in once serving_population has run.
 *
 * The app binds the second pass to what the first pass selected rather than to the declaration —
 * `readiness-read.ts` does it in one line, and the comment beside it says why: a second pass bound to
 * the declaration reads the catalogue for every tag key it mentions. Binding the declaration here would
 * measure a statement the app never runs, which is the same defect `slicedInRecording` exists to
 * disclose. So this mirrors it, and `merging` refuses a run that would leave it empty.
 */
let servingAssets = '';

/** Mirrors the default parameter values SqlCollector binds in server/collect/sql/collector.ts. */
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
    case 'stats_limit':
      return { value: '200', type: 'INT' };
    case 'job_limit':
      return { value: '200', type: 'INT' };
    case 'serving_names':
      return { value: SERVING_DECLARATION.names, type: 'STRING' };
    case 'serving_tag_keys':
      return { value: SERVING_DECLARATION.tagKeys, type: 'STRING' };
    // Refused rather than bound empty, which is the one binding here that has no honest empty case.
    // `live_workspace_ids` empty means no filter and collector.ts does the same; an empty asset list
    // means this statement reads nothing and returns in a millisecond, and that reading would go into
    // the recording, past the gate and into the published table looking like a fast statement. Two
    // things produce it — the statement running before serving_population, which `dependenciesFirst`
    // is what prevents, and serving_population selecting nothing at all — so the message names both.
    case 'serving_assets':
      if (servingAssets === '') {
        throw new Error(
          'serving_assets is empty, so this statement would be measured over no assets at all. Either it ' +
            'ran before serving_population, or serving_population selected nothing — check the run above ' +
            'for how many assets it reported.'
        );
      }
      return { value: servingAssets, type: 'STRING' };
    // 2,000, the same number collector.ts binds from SERVING_LIMIT. Written rather than imported for
    // the reason at the top of this file, and held to that source by runtime-baseline.test.ts.
    case 'serving_limit':
      return { value: '2000', type: 'INT' };
    // 200, the same number collector.ts defaults `modelEntityLimit` to. A different parameter from
    // `serving_limit` above it and a different sense of the word: this one caps served *models*,
    // that one caps data assets somebody declared as served to a consumer.
    case 'serving_entity_limit':
      return { value: '200', type: 'INT' };
    default:
      throw new Error(`No default is known for parameter :${name}. Add one beside collector.ts's own defaults.`);
  }
}

function bindParameters(names) {
  return names.map((name) => ({ name, ...parameterValue(name) }));
}

/**
 * A token that outlives the run, rather than whichever one the CLI had lying around.
 *
 * `databricks auth token` returns a cached token with its `expiry`, and it is only obliged to refresh
 * one it considers expired. Minting once and caching that for the whole run means a run started 53
 * minutes into a token's hour dies 7 minutes in — which is how a five-sample recording failed at
 * `uc_discovery_metadata` with `SyntaxError: Unexpected token 'I', "Invalid Token"`, the JSON parse of a
 * plaintext 401 body. A three-sample run had fitted inside the remainder and never showed it, so raising
 * SAMPLES to five is what surfaced this.
 *
 * So: re-mint whenever under `TOKEN_LEEWAY_MS` remains, and treat the expiry as the thing that decides,
 * not the age of our own cache.
 */
const TOKEN_LEEWAY_MS = 10 * 60 * 1000;
let cached = null;
function token({ force = false } = {}) {
  const remaining = cached == null ? 0 : cached.expiresAt - Date.now();
  if (force || cached == null || remaining < TOKEN_LEEWAY_MS) {
    const minted = JSON.parse(
      execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' })
    );
    const expiresAt = Date.parse(minted.expiry ?? '');
    cached = {
      value: minted.access_token,
      // No expiry field is not a reason to re-mint on every call; the leeway above then applies to a
      // conservative hour, which is what this CLI has been observed to issue.
      expiresAt: Number.isNaN(expiresAt) ? Date.now() + 60 * 60 * 1000 : expiresAt,
    };
    const minutes = Math.round((cached.expiresAt - Date.now()) / 60000);
    if (minutes < 15) {
      console.log(
        `  note: minted token expires in ${String(minutes)} min. A full run is longer than that, so this ` +
          'will re-mint mid-run; if the CLI keeps returning the same one, run `databricks auth login -p ' +
          `${PROFILE}` +
          '` first.'
      );
    }
  }
  return cached.value;
}

async function call(path, init, { retriedUnauthorized = false } = {}) {
  const response = await fetch(`${HOST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  });
  // An expired token answers in plaintext, so parsing unconditionally reports itself as a JSON syntax
  // error a hundred lines from the cause. Read the body as text and say what arrived.
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    if (response.status === 401 && !retriedUnauthorized) {
      token({ force: true });
      return call(path, init, { retriedUnauthorized: true });
    }
    throw new Error(
      `${path} -> ${String(response.status)}: response was not JSON: ${text.slice(0, 200)}`
    );
  }
  if (response.status === 401 && !retriedUnauthorized) {
    token({ force: true });
    return call(path, init, { retriedUnauthorized: true });
  }
  if (!response.ok) {
    throw new Error(`${path} -> ${String(response.status)}: ${body?.message ?? JSON.stringify(body)}`);
  }
  return body;
}

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 400; // ~10 minutes past the inline wait, generous for a cold labs warehouse.

/**
 * Runs one statement to completion and returns everything this pack records about it.
 *
 * `durationMs` wraps the whole call, submit through the last poll, because that is what a caller of
 * this statement actually waits — the same wall clock convention collector.ts uses for its own
 * `observed(..., Date.now() - started, ...)`.
 */
async function runStatement(name, statementText, parameterNames) {
  const started = Date.now();
  const parameters = bindParameters(parameterNames);
  let response = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement: mark(statementText),
      query_tags: SELF_TAGS,
      warehouse_id: WAREHOUSE,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      byte_limit: 20 * 1024 * 1024,
      wait_timeout: '50s',
      on_wait_timeout: 'CONTINUE',
      parameters: parameters.map(({ name: paramName, value, type }) => ({ name: paramName, value, type })),
    }),
  });

  const statementId = response.statement_id;
  // The same 400 polls this has always waited, and a cancellation on the way out that it never did —
  // see `statement-wait.mjs`. It no longer throws at the cap: a statement that outlasted its budget
  // falls through to the branch below and is recorded as a statement without a duration, which is
  // what it is. Throwing lost the other nineteen statements of the pack for one slow one.
  response = await settled(response, { call, polls: MAX_POLLS, pollIntervalMs: POLL_INTERVAL_MS });

  const state = response.status?.state;
  if (state !== 'SUCCEEDED') {
    return {
      name,
      statementId,
      measuredAt: new Date(started).toISOString(),
      warehouseId: WAREHOUSE,
      statementSha: statementSha(statementText),
      slicedInRecording: false,
      sliceColumn: sliceColumn(statementText),
      rows: null,
      columnCount: null,
      serializedBytes: null,
      durationMs: Date.now() - started,
      // Filled in by the caller, which takes the samples; null here so a failed statement still carries
      // the key, the way every other metric on this shape does.
      durations: null,
      bytesRead: null,
      truncated: null,
      scannedBytes: null,
      shuffleReadBytes: null,
      spilledLocalBytes: null,
      plan: null,
      error: response.status?.error?.message ?? `finished in state ${state ?? 'UNKNOWN'}`,
      parameters: Object.fromEntries(parameters.map(({ name: paramName, value }) => [paramName, value])),
    };
  }

  const dataArray = [];
  let chunk = response.result;
  while (chunk != null) {
    for (const row of chunk.data_array ?? []) dataArray.push(row);
    const next = chunk.next_chunk_internal_link;
    if (next == null) break;
    chunk = (await call(next, { method: 'GET' })).result;
  }

  const durationMs = Date.now() - started;
  const columnCount = response.manifest?.schema?.columns?.length ?? null;
  return {
    name,
    statementId,
    measuredAt: new Date(started).toISOString(),
    warehouseId: WAREHOUSE,
    statementSha: statementSha(statementText),
    slicedInRecording: false,
    sliceColumn: sliceColumn(statementText),
    rows: response.manifest?.total_row_count ?? dataArray.length,
    columnCount,
    serializedBytes: Buffer.byteLength(JSON.stringify(dataArray)),
    durationMs,
    durations: null,
    // The size of the answer, from the result manifest. Not the data scanned to compute it — that is
    // `scannedBytes` below, which only query history can say and which the enrichment pass fills in.
    bytesRead: response.manifest?.total_byte_count ?? null,
    truncated: response.manifest?.truncated === true,
    scannedBytes: null,
    shuffleReadBytes: null,
    spilledLocalBytes: null,
    plan: null,
    error: null,
    parameters: Object.fromEntries(parameters.map(({ name: paramName, value }) => [paramName, value])),
    columns: (response.manifest?.schema?.columns ?? []).map((column) => column.name ?? null),
    dataArray,
  };
}

/**
 * The live workspace ids out of workspace_directory's own result, read the way workspace_directory.sql
 * itself computes `live` — a boolean the statement already derives, so this reads its answer rather
 * than re-deriving one. Simpler than collector.ts's `narrowed()`, which additionally scopes to this
 * deployment's own region; that scoping is not needed for a measurement run against every statement.
 */
/**
 * The distinct qualified names serving_population selected, comma-joined, as readiness-read.ts joins them.
 *
 * Distinct because that statement returns one row per relation *per matching tag* — three keys on one
 * table is three rows — and the two reads below take a list of assets. Binding the duplicates would
 * measure a list two to three times longer than the one the app builds.
 */
function servingAssetsFrom(populationResult) {
  const at = populationResult.columns?.indexOf('qualified') ?? -1;
  if (at === -1) return '';
  return [...new Set(populationResult.dataArray.map((row) => row[at]).filter((one) => one != null))].join(',');
}

function liveWorkspaceIdsFrom(directoryResult) {
  const liveIndex = directoryResult.columns.indexOf('live');
  const idIndex = directoryResult.columns.indexOf('workspace_id');
  if (liveIndex === -1 || idIndex === -1) return '';
  return directoryResult.dataArray
    .filter((row) => row[liveIndex] === 'true')
    .map((row) => row[idIndex])
    .join(',');
}

/**
 * One query against system.query.history for every statement id this run submitted, returning
 * whichever of them have landed.
 */
async function historySnapshot(statementIds) {
  const list = statementIds.map((id) => `'${id.replaceAll("'", "''")}'`).join(', ');
  const probe = await runStatement(
    '_history_enrichment',
    `SELECT statement_id, read_bytes, shuffle_read_bytes, spilled_local_bytes, execution_duration_ms\n` +
      `FROM system.query.history\nWHERE statement_id IN (${list})`,
    []
  );
  const found = new Map();
  if (probe.columns == null) return found;
  const idIndex = probe.columns.indexOf('statement_id');
  const scannedIndex = probe.columns.indexOf('read_bytes');
  const shuffleIndex = probe.columns.indexOf('shuffle_read_bytes');
  const spillIndex = probe.columns.indexOf('spilled_local_bytes');
  for (const row of probe.dataArray ?? []) {
    found.set(row[idIndex], {
      // Data scanned, which is not `bytesRead` beside it in the record: that one is the result
      // manifest's `total_byte_count`, the size of the answer. This is the number every scan-count
      // probe from 36m to 36o was taken with.
      scannedBytes: row[scannedIndex] == null ? null : Number(row[scannedIndex]),
      shuffleReadBytes: row[shuffleIndex] == null ? null : Number(row[shuffleIndex]),
      spilledLocalBytes: row[spillIndex] == null ? null : Number(row[spillIndex]),
    });
  }
  return found;
}

const ENRICHMENT_POLL_MS = 60_000;
const ENRICHMENT_BUDGET_MS = 9 * 60_000;

/**
 * Best-effort shuffle/spill enrichment from system.query.history, polled rather than read once.
 *
 * A single read at a fixed delay was tried first and undershot badly: a run against labs recorded
 * zero of twenty-nine ids at 30s, five of twenty-nine at three minutes, and all twenty-nine only once
 * roughly seven to eight minutes had passed. `system.query.history`'s own ingestion latency is not
 * documented anywhere this script's authors could find, so this polls on a budget informed by that one
 * measurement — checking every minute, stopping the moment every id has landed, and giving up (leaving
 * whatever did not land null) at nine minutes so a run of this script still finishes in bounded time.
 */
async function enrichFromHistory(statementIds) {
  if (statementIds.length === 0) return new Map();
  const remaining = new Set(statementIds);
  let found = new Map();
  const deadline = Date.now() + ENRICHMENT_BUDGET_MS;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const wait = Math.min(ENRICHMENT_POLL_MS, Math.max(0, deadline - Date.now()));
      if (wait <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
    const snapshot = await historySnapshot([...remaining]);
    for (const [id, value] of snapshot) {
      found.set(id, value);
      remaining.delete(id);
    }
    console.log(`  query-history enrichment: ${String(found.size)} of ${String(statementIds.length)} landed so far.`);
    if (remaining.size === 0 || Date.now() >= deadline) break;
  }
  return found;
}

function loadStatement(path) {
  const raw = readFileSync(path, 'utf8');
  return expandFragments(raw.replace(/;\s*$/, '').trim());
}

/**
 * The statements whose own rows another statement is bound to, in the order that makes each available.
 *
 * `workspace_directory` produces the live workspace ids, mirroring collector.ts's `directoryOnce()`;
 * `serving_population` produces the assets the two reads beneath it are bound to, mirroring
 * `readiness-read.ts`. Both orderings are properties of the statements rather than of how a run was
 * asked for, which is why `dependenciesFirst` is applied to a partial run as well as a full one —
 * `ONLY=serving_asset_tags,serving_population` names both and reads correctly, and left in the order
 * given it would measure the first over an empty population.
 */
const BINDS_FOR_OTHERS = ['workspace_directory.sql', 'serving_population.sql'];

function dependenciesFirst(files) {
  return [
    ...BINDS_FOR_OTHERS.filter((one) => files.includes(one)),
    ...files.filter((one) => !BINDS_FOR_OTHERS.includes(one)),
  ];
}

/**
 * What a run of `ONLY` measures and what it keeps, or a thrown error where it cannot do either.
 *
 * Four things it refuses rather than works around, because each would produce a recording that reads like a
 * full one:
 *
 *  - a name that is not a statement, which is otherwise a run that measures nothing and reports success;
 *  - no committed recording to merge into, since there would be nothing to carry forward and the file would
 *    claim the estate was measured by a run that touched one statement;
 *  - a named statement that needs `live_workspace_ids` without `workspace_directory` in the same run. Those
 *    ids come out of that statement's own rows, so a run without it would bind an empty list and measure a
 *    statement filtered to no workspace — which succeeds, quickly, and is a reading of nothing;
 *  - a named statement that needs `serving_assets` without `serving_population`, for the same reason.
 *
 * Naming them is necessary and not sufficient: what they are bound to only exists once the statement that
 * produces it has run, so the files come back in `dependenciesFirst` order rather than the order they were
 * asked for.
 */
function merging(all) {
  const names = all.map((file) => file.replace(/\.sql$/, ''));
  const unknown = ONLY.filter((one) => !names.includes(one));
  if (unknown.length > 0) {
    throw new Error(`ONLY names ${unknown.join(', ')}, which ${unknown.length === 1 ? 'is not a statement' : 'are not statements'} in ${STATEMENTS_DIR}`);
  }
  if (!existsSync(OUT_FILE)) {
    throw new Error(`ONLY merges into ${OUT_FILE} and there is none, so run without ONLY to record the whole estate first`);
  }
  const recording = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  const needsDirectory = ONLY.filter((one) =>
    declaredParams(loadStatement(join(STATEMENTS_DIR, `${one}.sql`))).includes('live_workspace_ids')
  );
  if (needsDirectory.length > 0 && !ONLY.includes('workspace_directory')) {
    throw new Error(
      `${needsDirectory.join(', ')} filters on the live workspace ids that workspace_directory produces, ` +
        'so add workspace_directory to ONLY or the reading is of a statement bound to an empty list'
    );
  }
  const needsPopulation = ONLY.filter((one) =>
    declaredParams(loadStatement(join(STATEMENTS_DIR, `${one}.sql`))).includes('serving_assets')
  );
  if (needsPopulation.length > 0 && !ONLY.includes('serving_population')) {
    throw new Error(
      `${needsPopulation.join(', ')} reads the assets serving_population selected, ` +
        'so add serving_population to ONLY or the reading is of a statement bound to an empty population'
    );
  }
  return {
    files: dependenciesFirst(ONLY.map((one) => `${one}.sql`)),
    recording,
  };
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  mkdirSync(OUT_DIR, { recursive: true });

  const files = readdirSync(STATEMENTS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const all = dependenciesFirst(files);

  // What a partial run carries forward, read before anything runs so an unreadable recording fails here
  // rather than after the warehouse time is spent.
  const previous = ONLY.length === 0 ? null : merging(all);
  const ordered = previous == null ? all : previous.files;

  // The warehouse is started before anything is timed, because otherwise whichever statement runs
  // first is charged for starting it. Measured on labs 2026-08-10: workspace_directory, which is
  // always first, recorded 12.9s against a 12s class ceiling, and four direct readings on the same
  // warehouse minutes later were 4.0s, 4.3s, 5.1s and 5.8s. The recording was describing a cold
  // start, not a statement. This run's own reading is discarded and never published.
  console.log('warming the warehouse (this reading is discarded)...');
  const warmup = await runStatement('_warmup', 'SELECT 1', []);
  if (warmup.error != null) {
    // Said rather than swallowed. A warm-up that did not run leaves the first statement carrying the
    // start-up this exists to absorb, and the recording would look like every other one.
    throw new Error(`the warm-up did not run, so nothing after it is a warm reading: ${warmup.error}`);
  }
  console.log(`  warehouse ready after ${String(warmup.durationMs)}ms`);

  const statements = {};
  const statementIds = [];

  for (const file of ordered) {
    const name = file.replace(/\.sql$/, '');
    const text = loadStatement(join(STATEMENTS_DIR, file));
    const params = declaredParams(text);
    console.log(`running ${name} ${String(SAMPLES)}× (${params.join(', ') || 'no parameters'})...`);
    const result = await runStatement(name, text, params);
    // Whether that first execution succeeded, which is a different question from whether the sampling
    // below finished. The live workspace ids are read out of this statement's own rows, so they are
    // available whenever this is true, even where the sampling is not.
    const firstExecutionOk = result.error == null;

    // The samples after the first, for the distribution only. Everything else about the record — the id,
    // the row and byte counts, the sha, the time it was taken — belongs to the first execution, because a
    // record whose fields came from different runs cannot be traced to any of them.
    const extra = [];
    let sampleError = null;
    for (let sample = 1; sample < SAMPLES && result.error == null; sample += 1) {
      const again = await runStatement(name, text, params);
      if (again.error != null) {
        sampleError =
          `sample ${String(sample + 1)} of ${String(SAMPLES)} failed after ${String(sample)} succeeded, ` +
          `so this statement has no distribution: ${again.error}`;
        break;
      }
      extra.push(again.durationMs);
    }
    // A statement whose sampling did not finish is a failed measurement of it, even though its first
    // execution succeeded and its row and byte counts are real. This pack exists to publish budgets, a
    // budget is now a median, and a median of however many samples happened to land before an error is
    // not one — so the record carries the error and no distribution at all, which is what makes the gate
    // and `runtime-baseline.test.ts` refuse it rather than a later reader taking a short one for a full
    // recording.
    if (firstExecutionOk && sampleError != null) result.error = sampleError;
    if (result.error == null) result.durations = distribution([result.durationMs, ...extra]);
    if (result.error != null) {
      console.log(`  FAILED: ${result.error}`);
    } else {
      console.log(
        `  ok: ${String(result.rows)} rows, ${String(result.columnCount)} columns, ` +
          `${result.durations.readings.join(', ')} ms — median ${String(result.durations.median)}, ` +
          `spread ×${String(result.durations.spreadRatio)}, ${String(result.serializedBytes)} serialized bytes`
      );
      // A truncated result is a prefix of the answer, and publishing its duration as a budget would be
      // publishing the cost of a partial read. The collector treats truncation as fatal; this run has
      // nothing to abort, so it says so here and `runtime-baseline.test.ts` fails the recording.
      if (result.truncated === true) {
        console.log('  TRUNCATED: this reading is a prefix of the result and is not a budget. Re-measure.');
      }
      if (result.statementId != null) statementIds.push(result.statementId);
    }
    if (name === 'workspace_directory' && firstExecutionOk) {
      liveWorkspaceIds = liveWorkspaceIdsFrom(result);
      console.log(`  live workspaces: ${liveWorkspaceIds.split(',').filter((id) => id !== '').length}`);
    }
    if (name === 'serving_population' && firstExecutionOk) {
      servingAssets = servingAssetsFrom(result);
      const selected = servingAssets.split(',').filter((one) => one !== '').length;
      console.log(`  serving assets selected: ${String(selected)}`);
      // Said here rather than left to the reader of the file. Every reading below this point is of a
      // statement handed nothing, and the two that follow would come back in milliseconds looking like
      // fast statements. The declaration above is read off labs, so an empty answer means labs changed.
      if (selected === 0) {
        console.log(
          '  SELECTED NOTHING: the declaration above matches no relation this warehouse can see, so the\n' +
            '  two reads below are measured over an empty population and are not budgets. Re-read the\n' +
            '  tag keys and names in SERVING_DECLARATION against the estate before publishing this.'
        );
      }
    }
    statements[name] = stripInternal(result);
  }

  // The probes describe the estate rather than any statement, so a partial run keeps the ones it has instead
  // of re-reading seven populations to add a reading of one statement. They carry their own `measuredAt`, so
  // what they are of stays legible.
  console.log(
    previous == null
      ? '\nrunning correctness-population probes...'
      : '\nkeeping the recorded correctness populations: they are about the estate, not this statement.'
  );
  const populations = previous == null ? {} : { ...previous.recording.populations };
  const probeFiles = (previous != null ? [] : readdirSync(PROBES_DIR))
    .filter((name) => name.endsWith('.sql'))
    .sort();
  for (const file of probeFiles) {
    const name = file.replace(/\.sql$/, '').replaceAll('-', '_');
    const text = loadStatement(join(PROBES_DIR, file));
    const params = declaredParams(text);
    console.log(`running probe ${name} (${params.join(', ') || 'no parameters'})...`);
    const result = await runStatement(name, text, params);
    if (result.error != null) {
      console.log(`  FAILED: ${result.error}`);
      populations[name] = { error: result.error };
    } else {
      console.log(`  ok: ${String(result.rows)} rows, ${String(result.durationMs)}ms`);
      if (result.statementId != null) statementIds.push(result.statementId);
      populations[name] = {
        statementId: result.statementId,
        measuredAt: result.measuredAt,
        durationMs: result.durationMs,
        columns: result.columns,
        rows: result.dataArray,
      };
    }
  }

  console.log(`\nenriching from system.query.history (best-effort, polls up to ${String(ENRICHMENT_BUDGET_MS / 60_000)}m)...`);
  let enrichment;
  try {
    enrichment = await enrichFromHistory(statementIds);
  } catch (error) {
    console.log(
      `  enrichment query failed, leaving scanned/shuffle/spill null: ${String(error.message ?? error)}`
    );
    enrichment = new Map();
  }
  let enriched = 0;
  for (const entry of Object.values(statements)) {
    if (entry.statementId == null) continue;
    const found = enrichment.get(entry.statementId);
    if (found == null) continue;
    entry.scannedBytes = found.scannedBytes;
    entry.shuffleReadBytes = found.shuffleReadBytes;
    entry.spilledLocalBytes = found.spilledLocalBytes;
    enriched += 1;
  }
  console.log(`  matched ${String(enriched)} of ${String(statementIds.length)} statement ids in query history.`);

  const measured = liveWorkspaceIds.split(',').filter((id) => id !== '').length;
  const output = {
    // When this run finished, which is not when any single statement was measured — a run takes
    // minutes and the enrichment poll can add nine more. Each record carries its own `measuredAt` and
    // `warehouseId`, and nothing here is file-level that a reading could be attributed to wrongly. That is
    // what lets an `ONLY` run write this field about itself while keeping readings older than it.
    runFinishedAt: new Date().toISOString(),
    profile: PROFILE,
    lookbackDays: LOOKBACK_DAYS,
    workspaceId: WORKSPACE_ID,
    // The count this run saw, or the recorded one where this run did not run `workspace_directory` and so
    // did not see. Writing a zero there would report an account with no live workspaces in it.
    liveWorkspaceCount:
      previous == null || ONLY.includes('workspace_directory')
        ? measured
        : previous.recording.liveWorkspaceCount,
    // In the order a full run writes them — `workspace_directory` first, then the rest as the directory
    // lists them — whether this run measured all of them or one. A merge that appended instead would put a
    // new statement at the end and move nothing else, which reads as a smaller change than it is; a merge
    // that sorted would move every entry on the next full run.
    statements: Object.fromEntries(
      all
        .map((file) => file.replace(/\.sql$/, ''))
        .flatMap((name) => {
          const entry = statements[name] ?? previous?.recording.statements[name];
          return entry == null ? [] : [[name, entry]];
        })
    ),
    populations,
  };
  const failed = Object.entries(statements).filter(([, entry]) => entry.error != null);

  // A merge whose reading failed writes nothing. Its two alternatives are both worse: writing the failed entry
  // replaces a reading that worked with one that did not, and the recording then reports a statement as
  // unmeasurable on the strength of one bad run — while writing the *previous* entry beside a new
  // `runFinishedAt` would hide the failure behind a file that looks freshly measured. A full run still writes,
  // because there is no earlier reading in it to lose: its failed entries are that run's own answer, and
  // `runtime-baseline.test.ts` refuses them.
  if (previous != null && failed.length > 0) {
    console.log(`\n${String(failed.length)} statement(s) failed, so ${OUT_FILE} is unchanged:`);
    for (const [name, entry] of failed) console.log(`  ${name}: ${entry.error}`);
    process.exitCode = 1;
    return;
  }

  writeFileSync(OUT_FILE, `${JSON.stringify(output, null, 2)}\n`);
  console.log(`\nwrote ${OUT_FILE}`);

  if (failed.length > 0) {
    console.log(`\n${String(failed.length)} statement(s) failed:`);
    for (const [name, entry] of failed) console.log(`  ${name}: ${entry.error}`);
  }
}

/**
 * What several readings of one statement say together.
 *
 * The median rather than the mean, because the failure mode this exists for is one reading landing
 * somewhere the others do not — a cold cache, a resize mid-run — and a mean carries that reading into
 * the answer while a median does not. `spreadRatio` is max over min: the thing a class ceiling has to be
 * outside of before a change to a statement can be said to have moved anything.
 */
function distribution(readings) {
  const sorted = [...readings].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median =
    sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  return {
    // In the order they were taken, not sorted, because the order is what says whether a spread is
    // scatter or a step: `workload_warehouse_pressure` read 7.7s, 7.5s, then 12.5s, 12.3s, 12.5s.
    readings,
    samples: readings.length,
    min,
    median,
    max,
    spreadRatio: Math.round((max / min) * 100) / 100,
  };
}

/** Drops the raw row data from a statement record before it goes in labs.json; the schema stays. */
function stripInternal(result) {
  const { dataArray: _dataArray, columns: _columns, ...rest } = result;
  return rest;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
