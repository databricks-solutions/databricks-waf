// Measures what a 404 from the query-plan endpoint means, and how much of the history is reachable at all.
//
// Live and optional, like measure-query-plans.mjs: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-plan-reachability.mjs
//
// ## The premise this replaces
//
// `33b` measured the endpoint and found that 0.11% of statements 404 because they did not run on a warehouse,
// and recorded that as the one predictable class of miss — small enough that the retrieval policy could call
// and absorb the failure. `33j` was scheduled on that number.
//
// The number is right and the attribution was wrong, and the attribution is what the policy turns on.
//
// **A 404 is overwhelmingly a statement from another workspace.** `system.query.history` is a system table on
// the metastore and carries every workspace that shares it; the plan endpoint is scoped to one workspace. Of
// 21,689 statements over fifteen days on labs, 20,992 (96.79%) ran on one of the two warehouses this
// workspace can see and return a plan; 673 (3.10%) ran on one of four warehouse ids it cannot see and 404
// every time; 24 (0.11%) ran on something other than a warehouse and 404 every time. Asking the warehouses
// API which ids are local turns 3.21% of the calls from failures into calls never made.
//
// **Age is not a factor, over the window the shapes statement reads.** A statement 601 hours old — 25 days,
// past the 15-day window `workload_query_shapes.sql` uses and past the 15 prior it compares against —
// returned `plans_state: EXISTS`. Nothing in the sample expired. So "retain the latest three executions" has
// no retention ceiling to design around, which is what the fourth probe here was looking for and did not find.
//
// **Neither is statement type, and the correlation that suggested it was the warehouse.** A first pass took
// one statement per type and read 404 for `DESCRIBE`, `INSERT`, `MERGE`, `SHOW` and eight others while
// `ALTER`, `REVOKE` and `SELECT` returned plans — a clean-looking table with type as the discriminator. Every
// 404 in it ran on a warehouse in another workspace, and `SHOW` appeared on both sides of the split. The
// apparatus was reading the error body as a fact about the statement when it was a fact about the caller.
//
// **A cache hit has a plan record; it is empty, not missing.** The same first pass read three 404s on
// `from_result_cache = true` statements and had "cache hits are not retrievable" written down before the
// warehouse column was printed. Six cache hits on a local warehouse return `200` with `plans_state: EMPTY`.
// Caching produces an empty plan; it does not produce a 404.
//
// ## Which leaves two spellings of "no plan", and only one of them is knowledge
//
// `200` with `plans_state: EMPTY` is the platform saying this statement produced no plan — a cache hit, or a
// failure or cancellation before planning. The app read that and may report it.
//
// `404` is the platform saying it has nothing under that id *for this workspace*. Whether a plan exists is
// not in the response. So the record for a 404 cannot be the same record as for `EMPTY`, and no sentence
// built on it may say a plan was absent — which is `AGENTS.md`'s rule about prose being no more specific than
// the field beneath it, arriving here as a rule about which of two enum values to persist.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plan-reachability.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
// Fifteen days, which is the window workload_query_shapes.sql reads for its current period.
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 15);
// How many statements to probe per class. Small: the classes are decided by the census, not by the probe.
const PROBE_PER_CLASS = Number(process.env.PROBE_PER_CLASS ?? 6);

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

/**
 * Whether the app should call the plan endpoint for a statement, decided before spending the call.
 *
 * `compute.type` and `compute.warehouse_id` are both in the shapes statement's own source table, and the set
 * of local warehouse ids is one call to the warehouses API per scan. So every predictable 404 is predictable
 * without asking: 3.21% of labs' statements over fifteen days, and on an estate whose metastore is shared by
 * more workspaces than labs', more.
 *
 * Returns the reason it would be skipped, or `null` to call.
 */
export function skipReason(row, localWarehouseIds) {
  if (row?.computeType !== 'WAREHOUSE') return 'not-warehouse-compute';
  const id = row?.warehouseId;
  if (typeof id !== 'string' || id.length === 0) return 'no-warehouse-id';
  if (!localWarehouseIds.has(id)) return 'warehouse-outside-workspace';
  return null;
}

/**
 * What a response means, kept as three outcomes because the third is not the second.
 *
 * `available` carries a plan. `no-plan` is the platform reporting that none was produced, which the app read
 * and may repeat. `not-retrievable` is the absence of an answer: the id is not under this workspace, and
 * whether a plan exists is unknown here. Collapsing the last two into one "missing" is the mistake the
 * measurement above made twice, and it would put a claim in the app that no field supports.
 */
export function interpret(status, body) {
  if (status === 404) return 'not-retrievable';
  if (status !== 200) return 'error';
  const state = body?.plans_state;
  if (state === 'EXISTS') return 'available';
  if (state === 'EMPTY') return 'no-plan';
  return 'unknown-state';
}

function token() {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' }))
    .access_token;
}

/** Raw text and status, because a 404 here is the subject rather than an error to throw on. */
async function fetchText(path) {
  const response = await fetch(`${HOST}${path}`, { headers: { Authorization: `Bearer ${token()}` } });
  return { status: response.status, text: await response.text() };
}

async function call(path, init) {
  const response = await fetch(`${HOST}${path}`, {
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
  return response.result?.data_array ?? [];
}

/** The census: every statement in the window by compute, so the three classes carry counts and not samples. */
const CENSUS = `
  SELECT
    CASE WHEN compute.type = 'WAREHOUSE' THEN 'WAREHOUSE' ELSE coalesce(compute.type, '(null)') END AS kind,
    coalesce(CAST(compute.warehouse_id AS STRING), '(none)') AS warehouse_id,
    count(*) AS statements
  FROM system.query.history
  WHERE start_time >= current_timestamp() - INTERVAL ${String(LOOKBACK_DAYS)} DAYS
  GROUP BY 1, 2`;

/**
 * Statements to probe, one batch per class, with the columns the classifier reads.
 *
 * `from_result_cache` is selected because it was the second wrong attribution and the probe should show it
 * being wrong: cache hits appear here as their own class and come back 200.
 */
const SAMPLES = (localIds) => `
  WITH candidates AS (
    SELECT
      statement_id,
      CASE WHEN compute.type = 'WAREHOUSE' THEN 'WAREHOUSE' ELSE coalesce(compute.type, '(null)') END AS kind,
      coalesce(CAST(compute.warehouse_id AS STRING), '(none)') AS warehouse_id,
      coalesce(from_result_cache, false) AS cached,
      coalesce(statement_type, '(null)') AS statement_type,
      execution_status,
      datediff(HOUR, start_time, current_timestamp()) AS age_hours,
      CASE
        WHEN compute.type <> 'WAREHOUSE' THEN 'not-warehouse-compute'
        WHEN CAST(compute.warehouse_id AS STRING) NOT IN (${localIds.map((id) => `'${id}'`).join(',')})
          THEN 'warehouse-outside-workspace'
        WHEN coalesce(from_result_cache, false) THEN 'local-cache-hit'
        WHEN execution_status <> 'FINISHED' THEN 'local-not-finished'
        ELSE 'local-finished'
      END AS probe_class
    FROM system.query.history
    WHERE start_time >= current_timestamp() - INTERVAL ${String(LOOKBACK_DAYS)} DAYS
  ),
  ranked AS (
    SELECT *, ROW_NUMBER() OVER (PARTITION BY probe_class ORDER BY age_hours) AS pick FROM candidates
  )
  SELECT probe_class, statement_id, kind, warehouse_id, cached, statement_type, execution_status, age_hours
  FROM ranked
  WHERE pick <= ${String(PROBE_PER_CLASS)}
  ORDER BY probe_class, age_hours`;

/** The oldest statement in the window that ran here, to look for a retention ceiling. */
const OLDEST = (localIds) => `
  SELECT statement_id, datediff(HOUR, start_time, current_timestamp()) AS age_hours
  FROM system.query.history
  WHERE start_time >= current_timestamp() - INTERVAL ${String(LOOKBACK_DAYS * 2)} DAYS
    AND compute.type = 'WAREHOUSE'
    AND CAST(compute.warehouse_id AS STRING) IN (${localIds.map((id) => `'${id}'`).join(',')})
    AND execution_status = 'FINISHED'
  ORDER BY start_time ASC
  LIMIT 1`;

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (!HOST) throw new Error('DATABRICKS_HOST is required');
  if (!WAREHOUSE) throw new Error('DATABRICKS_WAREHOUSE_ID is required');

  const warehouses = await call('/api/2.0/sql/warehouses', { method: 'GET' });
  const localIds = (warehouses.warehouses ?? []).map((warehouse) => warehouse.id).filter(Boolean);
  if (localIds.length === 0) throw new Error('this workspace reports no warehouses; nothing would be reachable');
  const local = new Set(localIds);
  console.log(`warehouses visible in this workspace: ${String(local.size)}`);

  // The census, which is the number the policy is built on.
  const census = { inWorkspace: 0, outsideWorkspace: 0, notWarehouse: 0 };
  const outsideIds = new Set();
  for (const [kind, warehouseId, statements] of await run(CENSUS)) {
    const count = Number(statements);
    if (kind !== 'WAREHOUSE') census.notWarehouse += count;
    else if (local.has(warehouseId)) census.inWorkspace += count;
    else {
      census.outsideWorkspace += count;
      outsideIds.add(warehouseId);
    }
  }
  const total = census.inWorkspace + census.outsideWorkspace + census.notWarehouse;
  if (total === 0) throw new Error(`no statements in the last ${String(LOOKBACK_DAYS)} days; nothing to measure`);
  const share = (count) => Number(((count / total) * 100).toFixed(2));

  console.log(`\n${String(total)} statements over ${String(LOOKBACK_DAYS)} days`);
  console.log(`  warehouse in this workspace   ${String(census.inWorkspace).padStart(7)}  ${String(share(census.inWorkspace))}%`);
  console.log(`  warehouse in another          ${String(census.outsideWorkspace).padStart(7)}  ${String(share(census.outsideWorkspace))}%  (${String(outsideIds.size)} ids)`);
  console.log(`  not warehouse compute         ${String(census.notWarehouse).padStart(7)}  ${String(share(census.notWarehouse))}%`);

  // The probe, which is what attributes the census to an outcome.
  const probes = [];
  for (const [
    probeClass,
    statementId,
    kind,
    warehouseId,
    cached,
    statementType,
    executionStatus,
    ageHours,
  ] of await run(SAMPLES(localIds))) {
    const row = { computeType: kind, warehouseId };
    const skip = skipReason(row, local);
    const response = await fetchText(`/api/2.0/sql/history/queries/${statementId}?include_plans=true`);
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = null;
    }
    probes.push({
      probeClass,
      statementType,
      executionStatus,
      cached: cached === 'true' || cached === true,
      ageHours: Number(ageHours),
      warehouseIsLocal: local.has(warehouseId),
      skipReason: skip,
      status: response.status,
      plansState: typeof body?.plans_state === 'string' ? body.plans_state : null,
      outcome: interpret(response.status, body),
      bytes: response.text.length,
    });
  }

  console.log('\nprobe_class                   n  status  outcome          plans_state');
  const byClass = new Map();
  for (const probe of probes) {
    const key = `${probe.probeClass}|${String(probe.status)}|${probe.outcome}|${probe.plansState ?? '-'}`;
    byClass.set(key, (byClass.get(key) ?? 0) + 1);
  }
  for (const [key, count] of byClass) {
    const [probeClass, status, outcome, state] = key.split('|');
    console.log(
      `${probeClass.padEnd(28)} ${String(count).padStart(2)}  ${status.padEnd(6)} ${outcome.padEnd(16)} ${state}`,
    );
  }

  // The retention question, asked over twice the window so an expiry inside it would show.
  const [oldestRow] = await run(OLDEST(localIds));
  let oldest = null;
  if (oldestRow) {
    const [statementId, ageHours] = oldestRow;
    const response = await fetchText(`/api/2.0/sql/history/queries/${statementId}?include_plans=true`);
    let body = null;
    try {
      body = JSON.parse(response.text);
    } catch {
      body = null;
    }
    oldest = {
      ageHours: Number(ageHours),
      status: response.status,
      plansState: typeof body?.plans_state === 'string' ? body.plans_state : null,
      outcome: interpret(response.status, body),
    };
    console.log(
      `\noldest local statement probed: ${String(oldest.ageHours)}h -> ${String(oldest.status)} ${oldest.outcome}`,
    );
  }

  const payload = {
    runFinishedAt: new Date().toISOString(),
    profile: PROFILE,
    lookbackDays: LOOKBACK_DAYS,
    warehousesVisible: local.size,
    census: {
      statements: total,
      inWorkspace: census.inWorkspace,
      outsideWorkspace: census.outsideWorkspace,
      notWarehouse: census.notWarehouse,
      outsideWarehouseIds: outsideIds.size,
      shareRetrievablePct: share(census.inWorkspace),
      shareSkippableWithoutACallPct: Number(
        (share(census.outsideWorkspace) + share(census.notWarehouse)).toFixed(2),
      ),
    },
    probes,
    oldestLocalStatement: oldest,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${OUT_FILE}`);
}

// Guarded so the tests can import the classifiers without running a scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
