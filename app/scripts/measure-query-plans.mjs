// Measures the premises `33b` is scheduled on, before the retrieval and the six rules decide what they are.
//
// Live and optional, like measure-shape-fingerprint.mjs: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-query-plans.mjs
//
// ## The premises
//
// `docs/plan/h6-workload-advisor.md` schedules `33b` on a table of fields it says were measured on a real
// workspace — `SCAN_IDENTIFIER`, `JOIN_ALGORITHM`, `JOIN_BUILD_SIDE`, `PARTITIONING_TYPE`, `IS_PHOTON`,
// `SCAN_PARTITIONS`, and `duration_ms` / `rows_num` / `peak_memory_bytes` per operator — plus four numbers
// for the response-size ladder, plus two instructions that rest on those numbers: end the ladder at
// `include_plans`, and persist the raw response so the parser can be run against captured samples in CI.
//
// The fields hold. What the measurement changes is everything about the shape of the response around them,
// and each of the five findings below moves a decision the build would otherwise have made from the
// document:
//
// **The plan is one graph among a variable number.** `plans` comes back keyed `0`..`n`, and all but one
// entry carry no plan at all — zero nodes or one. A parser that iterates the object and concatenates finds
// the plan once and the rest as fragments; it has to select, and the discriminator is node count with
// `source = QUERY_EXECUTION_END`. Nothing in the document says the field is plural.
//
// The count is not part of the contract, which took two captures to notice: this run recorded fourteen
// entries keyed `0`..`13`, and a later capture of a different statement had thirteen. This comment said
// "thirteen, keyed 0..12" until 33j, which was wrong about its own recording as well as about the API — so
// `widestGraph` selects on width and nothing anywhere asserts a number of entries.
//
// **The metrics are not in `meta_data`.** `SCAN_IDENTIFIER` and the rest are `meta_data[].key`, but
// `duration_ms`, `rows_num` and `peak_memory_bytes` are `node.key_metrics`, a separate object. Both were in
// one column of the document's table, which reads as one lookup and is two.
//
// **Absence has two spellings, and one of them is `0`.** Of the 123 operators on the statement recorded here,
// 103 carry measured metrics, 17 have no `key_metrics` field at all, and 3 have one whose three values are all
// zero; a longer statement probed while writing this had 54 all-zero of 335. The document asks that "rules
// never claim a metric that was absent" — so a rule reading `key_metrics.rows_num` has to treat a missing
// object and a zero differently, because an operator that emitted no rows and an operator nobody instrumented
// report the same number here. Which is why `extract` below reproduces the field rather than defaulting it.
//
// **The extract is two orders of magnitude smaller than the response.** 2,429,915 bytes of JSON reduce to
// 16,372 bytes of operators, tags and the fields the rules read: 148x. The document's instruction to persist
// the raw response is right for CI fixtures and expensive at runtime — at the shapes statement's own ceiling
// of forty shapes per workspace and the document's three retained executions, raw is 292 MB per workspace
// per scan against 2 MB of extract.
//
// **The richest rung does not fit the app's own ceiling.** The ladder measured 28,914 bytes with no
// parameters, 2.43 MB at `include_plans`, 4.66 MB adding `include_debug_info` and 9.22 MB adding
// `include_json_plans` — against the `MAX_PROFILE_BYTES` of 8 MB the document's own configuration sets, which
// is 110%. So the fallback ladder at the document's line 648, which tries the richest form first and
// degrades, breaches its own limit on the first attempt for a statement of this size. Ending at
// `include_plans` is 29% of the cap and carries every field in the table. The document's instruction was
// right; what the measurement adds is that it is not a preference.
//
// **A shape has more than one plan, in three of eight cases.** Over the eight most-repeated shapes on labs,
// three most recent executions each, three shapes produced more than one operator graph — 24/24/18, 45/45/51,
// and one that produced three distinct plans from three executions at 68, 36 and 77 operators. The document
// notes at its line 526 that a `plan_fingerprint` "is specified and was missed", on the reasoning that plans
// drift with statistics, runtime, warehouse size and data distribution. On this evidence it drifts within
// minutes, for 3 shapes in 8, which makes the second fingerprint load-bearing rather than a refinement.
//
// ## What it does not measure
//
// **Whether an Apps install can reach this endpoint.** It runs on a CLI profile's token, which is a user
// credential; `probes.ts` records a scope per REST call because the app's own service principal is refused
// differently, and no scope for SQL history is declared there today. That is the scope question the plan
// says row `33b` does not settle, and this measurement does not settle it either — it establishes that the
// data exists and what it costs to read, on a credential the app does not use.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-operator-plans.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
// Thirty days, which is what workload_query_shapes.sql reads at its own ceiling.
const LOOKBACK_DAYS = Number(process.env.LOOKBACK_DAYS ?? 30);

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

/**
 * The ceiling the advisor document sets on a profile response, at its own configuration.
 *
 * Reported against the ladder rather than enforced, because what it decides is which rung to ask for and
 * that decision belongs to the build. The margin is the finding: the richest rung is inside 3% of it.
 */
const MAX_PROFILE_BYTES = 8 * 1024 * 1024;

/** The fields the advisor document's table promises, by where they actually live in the response. */
const PROMISED = {
  meta_data: [
    'SCAN_IDENTIFIER',
    'JOIN_ALGORITHM',
    'JOIN_BUILD_SIDE',
    'PARTITIONING_TYPE',
    'IS_PHOTON',
    'SCAN_PARTITIONS',
  ],
  key_metrics: ['duration_ms', 'rows_num', 'peak_memory_bytes'],
};

/** The ladder, poorest rung first. The document's line 648 starts at the richest and degrades. */
const LADDER = {
  none: '',
  include_metrics: '?include_metrics=true',
  include_plans: '?include_plans=true',
  'include_plans+debug_info': '?include_plans=true&include_debug_info=true',
  'include_plans+debug_info+json_plans':
    '?include_plans=true&include_debug_info=true&include_json_plans=true',
};

function token() {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' }))
    .access_token;
}

/** Raw text and status, because a 404 here is a finding rather than an error to throw on. */
async function fetchText(path) {
  const response = await fetch(`${HOST}${path}`, {
    headers: { Authorization: `Bearer ${token()}` },
  });
  return { status: response.status, text: await response.text() };
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
  return response.result?.data_array ?? [];
}

/**
 * The plan among the thirteen, and the reason this function exists at all.
 *
 * `plans` is an object keyed `0`..`12`, not a list of alternatives and not a sequence to concatenate. On the
 * statement measured, one entry carries 335 nodes and the other twelve carry zero or one. Selecting the
 * widest graph rather than `plans['0']` is deliberate: the index that happens to hold the plan is not
 * documented, and a parser that hard-codes `0` would report a one-node plan the day the service reorders.
 */
export function widestGraph(body) {
  const graphs = Object.entries(body?.plans ?? {}).map(([index, value]) => {
    const graph = typeof value === 'string' ? JSON.parse(value) : value;
    return { index, graph, nodes: graph?.nodes?.length ?? 0 };
  });
  graphs.sort((a, b) => b.nodes - a.nodes);
  return graphs[0] ?? { index: null, graph: null, nodes: 0 };
}

/**
 * A fingerprint over the plan's operators, which is the second fingerprint the document says was missed.
 *
 * Operator tags, sorted, hashed. Sorted rather than in graph order because what the fingerprint has to
 * answer is "is this the same physical plan", and two executions that differ only in the order the service
 * serialised sibling nodes are the same plan. Tags rather than `name`, because `name` carries the scanned
 * relation — `Scan system.access.table_lineage` — and a fingerprint that changes when the table changes is
 * the shape fingerprint again, computed twice.
 */
export function planFingerprint(graph) {
  const tags = (graph?.nodes ?? []).map((node) => node.tag ?? '(untagged)').sort();
  return createHash('sha256').update(tags.join('|')).digest('hex').slice(0, 16);
}

/**
 * What the six rules read, and nothing else — the measurement of the 148x the header records.
 *
 * Deliberately generous: every operator, its tag, the promised `meta_data` keys with their values, and
 * `key_metrics` reproduced exactly as found so the absent-versus-zero distinction survives into the number.
 * A tighter extract would report a larger multiple and would be arguing for a conclusion.
 *
 * Both spellings of an entry's content, per `33ih`. This read `entry.values` only, and so did the parser it
 * was measuring the size of, which is why this script's own recording reported "no promised key absent" while
 * five of the six were coming out empty: the keys were there and the values were not, and nothing here looked
 * at a value. The extract's size is barely affected — five scalars against 22 KB of `OUTPUT` — but a
 * measurement taken with a reader that cannot see a field cannot be quoted about that field.
 */
export function extract(graph) {
  return (graph?.nodes ?? []).map((node) => {
    const meta = {};
    for (const entry of node.meta_data ?? []) {
      if (PROMISED.meta_data.includes(entry.key)) {
        // Guarded the same way `metaValues` in the parser is, and for the same reason the declaration in
        // `.d.mts` says `readonly string[]`: a `values` that arrived as a bare string would otherwise be
        // spread into this file as a string, and the drift test compares the two extracts for equality.
        if (entry.value != null) meta[entry.key] = [String(entry.value)];
        else meta[entry.key] = Array.isArray(entry.values) ? entry.values.map(String) : [];
      }
    }
    return {
      id: node.id,
      tag: node.tag,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      // Reproduced rather than defaulted: absent here is the 17 operators, three zeros is the 3.
      //
      // `== null` rather than `=== undefined`, and it has to be the same test `metricPresence` uses. With
      // the two spelled differently, a `key_metrics: null` counted as absent in the presence figures still
      // arrived as a present-but-empty object in the extract — the one distinction this measurement exists
      // to establish, contradicted between two functions twenty lines apart.
      ...(node.key_metrics == null ? {} : { key_metrics: node.key_metrics }),
    };
  });
}

/** How the response spells "no metric here", counted the two ways it spells it. */
export function metricPresence(graph) {
  let absent = 0;
  let allZero = 0;
  let measured = 0;
  for (const node of graph?.nodes ?? []) {
    if (node.key_metrics == null) {
      absent += 1;
      continue;
    }
    const values = PROMISED.key_metrics.map((key) => node.key_metrics[key] ?? 0);
    if (values.every((value) => value === 0)) allZero += 1;
    else measured += 1;
  }
  return { operators: absent + allZero + measured, absent, allZero, measured };
}

/**
 * The population the shapes statement groups, split by the compute that ran it.
 *
 * The split is the point. `GET /sql/history/queries/{id}` is a warehouse endpoint: a statement that ran on
 * serverless compute is a 404, not a plan, and the app can tell which from `compute.type` before spending
 * the call. Reproduces `is_covered`'s eight statement types so the denominator is the population `33b`
 * nominates from rather than everything the table holds.
 */
const REACHABILITY = String.raw`
  SELECT
    coalesce(compute.type, '(none)') AS compute_type,
    count(*)                         AS statements
  FROM system.query.history
  WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
    AND statement_text IS NOT NULL
    AND trim(statement_text) <> ''
    AND statement_type IN (
      'SELECT', 'INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE', 'CREATE'
    )
  GROUP BY 1
  ORDER BY 2 DESC`;

/** How many repeated shapes the stability probe covers. One shape is an anecdote. */
const STABILITY_SHAPES = Number(process.env.STABILITY_SHAPES ?? 8);

/**
 * Repeated shapes and their three most recent executions each — the fingerprint stability probe.
 *
 * **Several shapes rather than one, and that is the whole reliability of this number.** The first version
 * took the single most-repeated shape, and got `distinct plans: 1` from three executions that agreed — while
 * an ad-hoc probe minutes earlier, over a differently-chosen shape, had found three executions 14 seconds
 * apart producing 45, 45 and 51 operators. Both runs were correct about the shape they sampled and neither
 * measured what the row is scheduled on, which is whether plan drift is common enough that a `plan_fingerprint`
 * has to exist. A proportion over ${String(STABILITY_SHAPES)} shapes answers that; one shape answers whether
 * one shape drifted.
 *
 * Restricted to this app's own signal statements, which is the one corner of labs where the same text really
 * does run repeatedly, and to `WAREHOUSE` so every execution is fetchable. The shape here is deliberately
 * cruder than the shipped fingerprint: whether these are one shape under `36s`'s six passes does not matter
 * to the question, which is whether identical text produces identical plans.
 */
const REPEATED = String.raw`
  WITH executions AS (
    SELECT
      statement_id,
      start_time,
      sha2(regexp_replace(lower(trim(statement_text)), '[ \\t\\n\\r]+', ' '), 256) AS shape
    FROM system.query.history
    WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
      AND compute.type = 'WAREHOUSE'
      AND execution_status = 'FINISHED'
      AND statement_text IS NOT NULL
      AND contains(statement_text, '-- Signal: sql:')
  ),
  counted AS (
    SELECT shape, count(*) AS runs FROM executions GROUP BY shape
  ),
  repeated AS (
    SELECT shape, runs FROM counted WHERE runs >= 3
    ORDER BY runs DESC LIMIT ${String(STABILITY_SHAPES)}
  ),
  ranked AS (
    SELECT
      executions.shape,
      executions.statement_id,
      CAST(executions.start_time AS STRING) AS started_at,
      ROW_NUMBER() OVER (PARTITION BY executions.shape ORDER BY executions.start_time DESC) AS pick
    FROM executions JOIN repeated USING (shape)
  )
  SELECT shape, statement_id, started_at FROM ranked WHERE pick <= 3
  ORDER BY shape, started_at DESC`;

/** The representative of the widest shape, chosen the way the shapes statement chooses it. */
const REPRESENTATIVE = String.raw`
  SELECT statement_id
  FROM system.query.history
  WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
    AND compute.type = 'WAREHOUSE'
    AND execution_status = 'FINISHED'
    AND statement_type IN (
      'SELECT', 'INSERT', 'MERGE', 'UPDATE', 'DELETE', 'COPY', 'REPLACE', 'CREATE'
    )
    AND read_bytes > 1000000
  ORDER BY total_duration_ms DESC
  LIMIT 1`;

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (HOST === '' || WAREHOUSE === '') {
    throw new Error('set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID');
  }

  const reachability = (await run(REACHABILITY)).map(([computeType, statements]) => ({
    computeType,
    statements: Number(statements),
  }));
  const total = reachability.reduce((sum, row) => sum + row.statements, 0);
  const warehouse = reachability.find((row) => row.computeType === 'WAREHOUSE')?.statements ?? 0;
  console.log('reachability by compute type:');
  for (const row of reachability) {
    console.log(`  ${row.computeType.padEnd(20)} ${String(row.statements).padStart(7)}`);
  }
  console.log(`  reachable: ${((warehouse / total) * 100).toFixed(2)}% of ${String(total)}`);

  // Refused rather than carried forward: with no representative every URL below reads `/queries/undefined`,
  // and what that writes is a recording of 404s and zero-byte ladders that reads like a finding about the
  // endpoint rather than a warehouse with nothing in its history window.
  const representative = (await run(REPRESENTATIVE))[0]?.[0];
  if (typeof representative !== 'string' || representative === '') {
    throw new Error(
      `no warehouse statement in the last ${String(LOOKBACK_DAYS)} days reads enough to carry a plan — widen LOOKBACK_DAYS or run something on the warehouse first`,
    );
  }

  // The ladder, on one statement, every rung.
  const ladder = {};
  for (const [rung, query] of Object.entries(LADDER)) {
    const response = await fetchText(`/api/2.0/sql/history/queries/${representative}${query}`);
    ladder[rung] = {
      status: response.status,
      bytes: response.text.length,
      ofCap: Number(((response.text.length / MAX_PROFILE_BYTES) * 100).toFixed(1)),
    };
    console.log(
      `  ${rung.padEnd(36)} ${String(response.status)} ${String(response.text.length).padStart(9)} bytes  ${String(ladder[rung].ofCap)}% of cap`,
    );
  }

  // A statement that did not run on a warehouse, to record how the endpoint refuses it.
  const offWarehouse = (
    await run(String.raw`
      SELECT statement_id FROM system.query.history
      WHERE start_time >= current_timestamp() - make_dt_interval(${String(LOOKBACK_DAYS)})
        AND compute.type <> 'WAREHOUSE'
      ORDER BY start_time DESC LIMIT 1`)
  )[0]?.[0];
  let refusal = null;
  if (offWarehouse != null) {
    const response = await fetchText(`/api/2.0/sql/history/queries/${offWarehouse}?include_plans=true`);
    let errorCode = null;
    try {
      errorCode = JSON.parse(response.text).error_code ?? null;
    } catch {
      errorCode = '(not json)';
    }
    refusal = { status: response.status, errorCode, bytes: response.text.length };
    console.log(`\noff-warehouse statement: ${String(response.status)} ${String(errorCode)}`);
  }

  // The plan itself: which graph, which fields, how absence is spelled, and how big the extract is.
  const full = await fetchText(`/api/2.0/sql/history/queries/${representative}?include_plans=true`);
  const body = JSON.parse(full.text);
  const chosen = widestGraph(body);
  const graphs = Object.entries(body.plans ?? {}).map(([index, value]) => {
    const graph = typeof value === 'string' ? JSON.parse(value) : value;
    return { index, nodes: graph?.nodes?.length ?? 0, source: graph?.source ?? null };
  });
  const extracted = JSON.stringify(extract(chosen.graph));
  const presence = metricPresence(chosen.graph);
  const metaKeys = new Set();
  for (const node of chosen.graph?.nodes ?? []) {
    for (const entry of node.meta_data ?? []) metaKeys.add(entry.key);
  }

  console.log(`\nplans: ${String(graphs.length)} entries, widest is plans[${String(chosen.index)}]`);
  console.log(`  graphs with a plan: ${String(graphs.filter((g) => g.nodes > 1).length)}`);
  console.log(
    `  key_metrics: ${String(presence.measured)} measured, ${String(presence.allZero)} all-zero, ${String(presence.absent)} absent, of ${String(presence.operators)}`,
  );
  console.log(
    `  raw ${String(full.text.length)} bytes -> extract ${String(extracted.length)} bytes (${(full.text.length / extracted.length).toFixed(0)}x)`,
  );
  const missing = PROMISED.meta_data.filter((key) => !metaKeys.has(key));
  console.log(`  promised meta_data keys absent: ${missing.length === 0 ? 'none' : missing.join(', ')}`);

  // Stability: several shapes, three executions each, and how many of them drifted.
  const byShape = new Map();
  for (const [shape, statementId, startedAt] of await run(REPEATED)) {
    if (!byShape.has(shape)) byShape.set(shape, []);
    byShape.get(shape).push({ statementId, startedAt });
  }
  const shapes = [];
  for (const [shape, wanted] of byShape) {
    const executions = [];
    for (const { statementId, startedAt } of wanted) {
      const response = await fetchText(
        `/api/2.0/sql/history/queries/${statementId}?include_plans=true`,
      );
      if (response.status !== 200) {
        executions.push({ statementId, startedAt, status: response.status });
        continue;
      }
      const graph = widestGraph(JSON.parse(response.text));
      executions.push({
        statementId,
        startedAt,
        status: response.status,
        bytes: response.text.length,
        nodes: graph.nodes,
        planFingerprint: planFingerprint(graph.graph),
      });
    }
    const fingerprints = new Set(
      executions.map((execution) => execution.planFingerprint).filter((f) => f != null),
    );
    shapes.push({
      shape: shape.slice(0, 12),
      executions,
      distinctPlans: fingerprints.size,
      distinctNodeCounts: new Set(executions.map((e) => e.nodes).filter((n) => n != null)).size,
    });
  }
  const drifted = shapes.filter((entry) => entry.distinctPlans > 1);
  console.log(`\nplan fingerprint over ${String(shapes.length)} repeated shapes, 3 executions each:`);
  for (const entry of shapes) {
    const nodes = entry.executions.map((e) => e.nodes ?? '-').join('/');
    console.log(
      `  ${entry.shape}  nodes=${nodes.padEnd(12)} distinct plans=${String(entry.distinctPlans)}`,
    );
  }
  console.log(
    `  shapes whose plan changed across three executions: ${String(drifted.length)} of ${String(shapes.length)}`,
  );

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        runFinishedAt: new Date().toISOString(),
        profile: PROFILE,
        lookbackDays: LOOKBACK_DAYS,
        maxProfileBytes: MAX_PROFILE_BYTES,
        reachability: { byComputeType: reachability, statements: total, warehouse, refusal },
        ladder,
        response: {
          statementId: representative,
          plansState: body.plans_state ?? null,
          graphs,
          widest: { index: chosen.index, nodes: chosen.nodes },
          metaDataKeys: [...metaKeys].sort(),
          promisedMetaDataAbsent: missing,
          keyMetrics: presence,
          rawBytes: full.text.length,
          extractBytes: extracted.length,
        },
        stability: { shapes, shapesMeasured: shapes.length, shapesDrifted: drifted.length },
      },
      null,
      2,
    )}\n`,
  );
  console.log(`\nwrote ${OUT_FILE}`);
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
