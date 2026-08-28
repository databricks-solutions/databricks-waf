// The corpus every plan measurement is taken over: the shapes the advisor ranks, with their plans.
//
// Extracted from `measure-plan-thresholds.mjs` in `33ifb`, unchanged, because that row measures a second thing
// over the same population and the population is the apparatus. `33ii`'s lesson was that a measurement is only
// as good as the thing it was taken with, and two scripts each with their own sampler is two populations that
// look like one: a threshold measured over the app's own statement and a join reading measured over a similar
// query would be reported side by side and would not be about the same estate.
//
// So the corpus is obtained by **running the app's own statement**, `config/statements/workload_query_shapes.sql`,
// with the parameters the collector binds. That statement computes the shape fingerprint, applies the
// homogeneity guard, excludes this app's own statements and `REFRESH`, and nominates one representative
// execution per shape by the advisor document's own rule. Anything written here instead would differ from it in
// at least the fingerprint and the exclusions.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settled } from './statement-wait.mjs';

import { skipReason } from './measure-plan-reachability.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const SHAPES_SQL = join(APP, 'config', 'statements', 'workload_query_shapes.sql');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 15);
// The collector's own default. Raising it widens the corpus; it does not change which shapes are at the top.
const SHAPE_LIMIT = Number(process.env.SHAPE_LIMIT ?? 40);


/**
 * How many two-second polls a statement gets, at the budget every measurement has always used.
 *
 * A caller may raise it, because `45a` measures what a source *costs* and a budget is a limit on the
 * answer: a statement that runs for sixteen minutes reads as "did not finish in five" under this, which
 * is true and is not the number that decides whether a dimension can be collected. A caller that needs
 * more asks for it in its own source rather than in the environment — a budget that has to be exported
 * to reproduce a recording is a recording nobody can reproduce. Leave it alone everywhere else: on a
 * shared estate it is somebody else's warehouse the extra polls wait on.
 */
const POLLS = Number(process.env.STATEMENT_POLLS ?? 150);

/**
 * What a caller records beside its readings, so a recording says what it was taken over.
 *
 * `host` as well as `profile` because the two can disagree and the disagreement is silent: an environment
 * `DATABRICKS_HOST` beats the profile, so a recording labelled with the profile alone can name one estate and
 * hold another's numbers. `estates.md` records the round of re-authentication that cost.
 */
export const corpusSettings = {
  profile: PROFILE,
  host: HOST,
  warehouse: WAREHOUSE,
  lookbackDays: LOOKBACK_DAYS,
  shapeLimit: SHAPE_LIMIT,
};

// `hostTheProfileNames` used to live here and now lives in `recording-guards.mjs`, which is the only thing
// that ever wanted it: it is an input to a guard rather than a property of the corpus. `79` moved it,
// because leaving it here meant every recording script imported it from one module to hand to another —
// nineteen chances to pass the wrong thing, and one of them did.

/**
 * The token, held until shortly before it expires rather than fetched per request.
 *
 * A cache because the alternative was measuring the harness. `runStatement` polls every two seconds and
 * every poll called the CLI, which is a subprocess that takes about five seconds on a machine holding
 * several profiles — so a statement's recorded duration was its own time plus three and a half times
 * that in re-authentication, and `45a` read a seventeen-minute cost for a statement it could not
 * separate from its own poll loop. A recording of what a source costs has to be about the source.
 *
 * Refreshed a minute early, because a token that expires between the check and the call fails the run
 * with an authentication error a reader would spend the next hour attributing to the profile.
 *
 * The expiry is not the only way a token stops working, so a 401 discards the held one and the call is
 * made again — `measure-sql-baseline.mjs` already did that against the per-call path, and a cache that
 * did not would turn a single recoverable rejection into every remaining poll of a long statement
 * failing the same way.
 */
let held = null;
function tokenValue() {
  if (held != null && held.until > Date.now()) return held.token;
  const issued = JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' }));
  const expiry = Date.parse(issued.expiry ?? '');
  // A minute from now where the CLI said nothing readable, which is short enough to be safe and long
  // enough to take the subprocess out of a poll loop.
  const until = Number.isFinite(expiry) ? expiry - 60_000 : Date.now() + 60_000;
  held = { token: issued.access_token, until };
  return held.token;
}

/** Drops the held token, so the next call mints one. */
function forget() {
  held = null;
}

export async function fetchText(path) {
  let response = await fetch(`${HOST}${path}`, { headers: { Authorization: `Bearer ${tokenValue()}` } });
  if (response.status === 401) {
    forget();
    response = await fetch(`${HOST}${path}`, { headers: { Authorization: `Bearer ${tokenValue()}` } });
  }
  return { status: response.status, text: await response.text() };
}

export async function call(path, init) {
  let response = await send(path, init);
  if (response.status === 401) {
    forget();
    response = await send(path, init);
  }
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

function send(path, init) {
  return fetch(`${HOST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${tokenValue()}`, 'Content-Type': 'application/json' },
  });
}

/**
 * Any statement, on the corpus's warehouse, as rows keyed by column name.
 *
 * Split out of `runShapes` in `33iga`, which measures a *second* population — the tables the corpus's plans scan —
 * and has to reach it from the same warehouse under the same token. Two executors would be two authentications and
 * two poll loops, and the failure mode of the second one is a measurement that silently used a different session.
 */
export async function runStatement(statement, parameters = [], polls = POLLS) {
  let response = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement,
      warehouse_id: WAREHOUSE,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      wait_timeout: '50s',
      parameters,
    }),
  });
  response = await settled(response, { call, polls });
  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(`statement did not succeed: ${JSON.stringify(response.status).slice(0, 400)}`);
  }
  const columns = (response.manifest?.schema?.columns ?? []).map((column) => column.name);
  return (response.result?.data_array ?? []).map((row) =>
    Object.fromEntries(columns.map((name, index) => [name, row[index]])),
  );
}

/**
 * The app's statement, with the collector's parameters.
 *
 * `live_workspace_ids` is empty, which is `collector.ts`'s *degraded* binding rather than its normal one: with no
 * workspace directory to bind from, the statement reads every workspace on the metastore instead of the live set.
 * Deliberate here and stated in the write-ups, because a wider corpus is better for a measurement and because it
 * is why some representatives come back on a warehouse this workspace cannot see. It is not what a scan does.
 */
export async function runShapes() {
  return runStatement(readFileSync(SHAPES_SQL, 'utf8'), [
    { name: 'lookback_days', value: String(LOOKBACK_DAYS), type: 'INT' },
    { name: 'workspace_id', value: '', type: 'STRING' },
    { name: 'live_workspace_ids', value: '', type: 'STRING' },
    { name: 'shape_limit', value: String(SHAPE_LIMIT), type: 'INT' },
  ]);
}

/** The widest graph in a plan response, by node count, which is what `parse.ts` selects. */
export function widestGraph(body) {
  let widest = null;
  for (const value of Object.values(body?.plans ?? {})) {
    let graph = null;
    try {
      graph = typeof value === 'string' ? JSON.parse(value) : value;
    } catch {
      graph = null;
    }
    // The record guard is `parse.ts`'s, so `plans: {'0': '5'}` is not a graph of zero nodes here either.
    if (typeof graph !== 'object' || graph == null || Array.isArray(graph)) continue;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    if (widest == null || nodes > widest.nodes) widest = { graph, nodes };
  }
  return widest;
}

/**
 * Every shape of the corpus that has a readable plan, with the reasons the others had none.
 *
 * The skip tally is returned rather than logged because it is a reading in its own right: a corpus of 36 plans
 * out of 40 shapes and one of 4 out of 40 support very different sentences, and which it was belongs in the
 * recording next to whatever was measured.
 */
export async function eachPlan() {
  if (!HOST) throw new Error('DATABRICKS_HOST is required');
  if (!WAREHOUSE) throw new Error('DATABRICKS_WAREHOUSE_ID is required');

  const warehouses = await call('/api/2.0/sql/warehouses', { method: 'GET' });
  const local = new Set((warehouses.warehouses ?? []).map((warehouse) => warehouse.id).filter(Boolean));

  const shapes = await runShapes();
  const found = [];
  const skipped = {};
  const note = (reason) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  for (const shape of shapes) {
    const row = {
      computeType: shape.representative_compute_type,
      warehouseId: shape.representative_warehouse_id,
    };
    const skip = shape.statement_id == null ? 'no-representative' : skipReason(row, local);
    if (skip != null) {
      note(skip);
      continue;
    }
    const response = await fetchText(`/api/2.0/sql/history/queries/${shape.statement_id}?include_plans=true`);
    if (response.status !== 200) {
      note(`status-${String(response.status)}`);
      continue;
    }
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = null;
    }
    const widest = widestGraph(body);
    if (widest == null || widest.nodes === 0) {
      note(`no-graph-${typeof body?.plans_state === 'string' ? body.plans_state : 'unknown'}`);
      continue;
    }
    found.push({ shape, response, widest });
  }
  return { shapes, found, skipped };
}
