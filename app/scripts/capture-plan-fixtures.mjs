// Captures the query-plan responses the parser is tested against, and trims them to a size this repo keeps.
//
// Live and optional, like the measure-* scripts: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/capture-plan-fixtures.mjs
//
// ## Why these are trimmed, and what that costs
//
// The advisor document asks at its line 705 that the parser be run in CI against captured samples rather
// than against a live workspace, because "the exact JSON response shape can vary across query-history
// service versions and workload types". A full capture of the `include_plans` rung is 2.0 MB on the
// statement used here and 2.4 MB on the one `33b` measured; the largest JSON this repository commits is
// 42 KB. Committing five full captures would be 6 MB of fixture for a parser that reads a few fields per
// operator.
//
// So the envelope is kept whole — every top-level field, every entry in `plans`, the graph's own keys —
// and only the widest graph's `nodes` list is trimmed. The trim keeps **every distinct `tag`** and fills
// the remainder up to a bound, so the parser still meets every operator kind the statement produced.
//
// What that costs is scale: node *counts* in a fixture are not the counts the API returned, and no test
// may read them as such. `_capture` in each file records the originals, and a test asserts that the set of
// tags in the fixture equals the set recorded — so a trim that drops an operator kind fails CI rather than
// quietly narrowing what the parser is proven against. This is the apparatus lesson from `33b`, where a
// fixture one column short of the statement it described produced a real, reproducible number about a
// statement that does not exist.
//
// ## What is captured, and the one the document names that does not exist
//
// The document names five fixtures: metrics-only, text plan, JSON plan, no profile, and a cache hit. Four
// map onto responses this endpoint returns. **A text plan does not.** The four rungs of the ladder return,
// on the statement probed: no plan field at all, a `metrics` object, a `plans` object of graphs, and a
// `json_query_plans` string that is base64 rather than text. Nothing in any rung is a text rendering of a
// plan. So the text-only case is written by hand as a synthetic fixture and labelled one, because the
// document also names it as a normalisation behaviour to survive (line 571: "JSON, JSON-as-a-string,
// text-only and unrecognised shapes") and surviving an encoding the API does not send is still worth
// asserting. What it is not is a capture, and the file says so.
//
// `plans-as-string` is likewise derived rather than captured: the values in `plans` arrived as objects on
// both statements measured, and the document names JSON-as-a-string as a shape to survive. It is the
// captured graph re-encoded, and it says that too.
//
// A sixth the document does not name is captured here: `sorted-plan`. Every capture of the widest plan the
// estate ran has carried no `SORT_ORDER`, and `33ic` promises that key. A promised key with no captured value
// is the hole `33ih` came out of, so this one is produced from a statement this script runs rather than found
// among the statements it did not choose. Its `_capture` carries the statement.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'plans', 'fixtures');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
/** Nodes kept in the widest graph. Every distinct tag is kept first; this bounds what follows. */
const MAX_NODES = Number(process.env.MAX_FIXTURE_NODES ?? 60);
/** Statements probed before choosing one to capture, because duration does not predict plan width. */
const CANDIDATES = Number(process.env.FIXTURE_CANDIDATES ?? 8);


/** Fields that name a person or a session. Replaced rather than dropped, so the shape is unchanged. */
const REDACT = {
  user_name: 'redacted@example.invalid',
  user_display_name: 'Redacted User',
  executed_as_user_name: 'redacted@example.invalid',
  executed_as_user_display_name: 'Redacted User',
  user_id: '000000000000000',
  executed_as_user_id: '000000000000000',
  session_id: '00000000-0000-0000-0000-000000000000',
  lookup_key: 'redacted',
};

function token() {
  return JSON.parse(execFileSync('databricks', ['auth', 'token', '-p', PROFILE], { encoding: 'utf8' }))
    .access_token;
}

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
  response = await settled(response, { call, polls: 150 });
  if (response.status?.state !== 'SUCCEEDED') throw new Error(JSON.stringify(response.status).slice(0, 400));
  return response.result?.data_array ?? [];
}

/**
 * Runs a statement and answers the `include_plans` response once a graph is in it, or nothing.
 *
 * Two things `33ia` measured, both of which this needs. The plan is written asynchronously, so a fetch the
 * moment the statement finishes returns `plans_state: EMPTY` on a statement that has a plan — hence the wait,
 * and the wait is on a node rather than on the state, because `EXISTS` is not a claim about the body in hand.
 * And the second execution of identical text is answered from the result cache, which has no plan at all, so
 * the text is made unique per run.
 */
async function runForPlan(statement) {
  const unique = `-- fixture ${new Date().toISOString()}\n${statement}`;
  const submitted = await call('/api/2.0/sql/statements', {
    method: 'POST',
    body: JSON.stringify({
      statement: unique,
      warehouse_id: WAREHOUSE,
      disposition: 'INLINE',
      format: 'JSON_ARRAY',
      wait_timeout: '50s',
    }),
  });
  const response = await settled(submitted, { call, polls: 150 });
  if (response.status?.state !== 'SUCCEEDED') {
    throw new Error(`the sorting statement did not succeed: ${JSON.stringify(response.status).slice(0, 400)}`);
  }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fetched = await fetchText(`/api/2.0/sql/history/queries/${response.statement_id}?include_plans=true`);
    if (fetched.status !== 200) return null;
    let nodes = 0;
    for (const value of Object.values(JSON.parse(fetched.text).plans ?? {})) {
      const graph = typeof value === 'string' ? JSON.parse(value) : value;
      nodes = Math.max(nodes, graph?.nodes?.length ?? 0);
    }
    if (nodes > 0) return { ...fetched, statement: statement.trim() };
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return null;
}

function redact(body) {
  const copy = { ...body };
  for (const [field, replacement] of Object.entries(REDACT)) {
    if (field in copy) copy[field] = replacement;
  }
  return copy;
}

/**
 * Fields on a node that the parser does not read, and which carry almost all of the bytes.
 *
 * `node.metrics` is 264 KB of a 350 KB node list on the statement captured — the full per-operator metrics
 * array, which is not `key_metrics` and is not any of the promised `meta_data` keys. `expressions` is a
 * further 39 KB. Both are capped to one entry so the field's shape survives and its bulk does not, because a
 * parser that started reading either should fail against a fixture that no longer proves anything about it
 * rather than pass by luck.
 *
 * `metrics` stopped being wholly unread in `33ic`: eighteen labels of the several hundred are now selected by
 * name, so those entries are kept and the cap applies to what is left. Capping first and selecting afterwards
 * is how a fixture comes to prove nothing about a field the parser reads — the same shape of defect as the
 * edge filter below, and the reason `capture-plan-fixtures.test.ts` holds the kept list against the parser's.
 */
const UNREAD_NODE_ARRAYS = ['metrics', 'expressions'];
const UNREAD_KEEP = 1;

/**
 * The metric labels the parser now selects, copied from `parse.ts`'s `NAMED_METRICS`.
 *
 * Copied because this file is `.mjs` and cannot import the TypeScript one;
 * `capture-plan-fixtures.test.ts` asserts the two lists are equal, so a label added there and not here fails
 * rather than producing fixtures that silently omit it.
 */
const NAMED_METRICS = [
  'MapStage - Skew max to non-empty median ratio',
  'MapStage - Skew num skewed partitions',
  'MapStage - Skew skewed data size ratio',
  'MapStage - Skew non-empty median partition size',
  'MapStage - Skew num empty partitions',
  'AQEShuffleRead - Skew handled by',
  'AQEShuffleRead - Number of partitions',
  'AQEShuffleRead - Number of coalesced partitions',
  'MapStage - Number of output rows',
  'Max batch size (rows) produced in the sort node',
  'Max column batch size (bytes) sort spilled',
  'Num bytes spilled to disk due to memory pressure',
  'Hashed relation size',
  'Aggressive BHJ Extrapolated Size',
  'Aggressive BHJ Decision',
  'MapStage - EnsureRequirementsDP estimated NDV',
  'Scan - Size of a row of all columns in the relation (estimated)',
  'Scan - Size of a row of scanned columns (estimated)',
];
/** Cap on the length of a `meta_data` value the parser does not read. `OUTPUT` alone is 22 KB. */
const UNREAD_VALUE_CHARS = 120;

/** The keys the parser reads out of `meta_data`, whose values are kept whole. Also held by the test. */
const PROMISED_META = [
  'SCAN_IDENTIFIER',
  'JOIN_ALGORITHM',
  'JOIN_BUILD_SIDE',
  'PARTITIONING_TYPE',
  'IS_PHOTON',
  'SCAN_PARTITIONS',
  'SORT_ORDER',
];

/**
 * Caps the fields the parser does not read, and records what it capped.
 *
 * `meta_data` keeps every key, because selecting the promised six out of the twenty-odd present is the
 * behaviour under test. Only the values of unread keys are shortened.
 */
function capUnread(node, capped) {
  const copy = { ...node };
  for (const field of UNREAD_NODE_ARRAYS) {
    const value = copy[field];
    if (Array.isArray(value) && value.length > UNREAD_KEEP) {
      // Named metrics first, then the cap over what is left, so the count reported is the number dropped and
      // the entries the parser reads are never among them.
      const named = field === 'metrics' ? value.filter((metric) => NAMED_METRICS.includes(metric?.label)) : [];
      const rest = value.filter((entry) => !named.includes(entry));
      const kept = [...named, ...rest.slice(0, UNREAD_KEEP)];
      capped[field] = (capped[field] ?? 0) + (value.length - kept.length);
      copy[field] = kept;
    }
  }
  if (Array.isArray(copy.meta_data)) copy.meta_data = copy.meta_data.map((entry) => capEntry(entry, capped));
  return copy;
}

/**
 * Caps one unread `meta_data` value, in whichever of the two spellings it arrives in.
 *
 * Both spellings, per `33ih`: an entry holds a scalar in `value` or a list in `values`, fixed per key, and
 * this read only the second. In the committed capture that left nine unread entries on eight distinct keys —
 * `JOIN_TYPE` on both joins, and `SCAN_DATABASE`, `SCAN_TABLE`, `IS_DELTA`, `SCAN_CATALOG_TABLE_TYPE`,
 * `SCAN_FILE_INDEX_NAME`, `SCAN_RELATION_NAME` and `SCAN_RELATION_DESC` on the one scan — taking the
 * `return entry` path uncapped, while the fixture's own note said unread values were capped. The longest of
 * them is 28 characters against a 120 cap, so no committed fixture is wrong; the sentence it wrote about
 * itself was.
 *
 * A non-string in either spelling is returned untouched rather than coerced, because this file's output is a
 * fixture: `parse.test.ts` asserts that the parser survives a boolean `value`, and a capture step that
 * rewrote one into `'true'` would make that shape uncapturable. The parser coerces; the capture reproduces.
 */
function capEntry(entry, capped) {
  if (PROMISED_META.includes(entry.key)) return entry;
  const count = () => {
    capped.meta_data_values = (capped.meta_data_values ?? 0) + 1;
  };
  if (entry.value != null) {
    if (typeof entry.value !== 'string') return entry;
    const shortened = cap(entry.value);
    if (shortened !== entry.value) count();
    return { ...entry, value: shortened };
  }
  const values = entry.values;
  if (!Array.isArray(values)) return entry;
  const shortened = values.map((value) => (typeof value === 'string' ? cap(value) : value));
  if (JSON.stringify(shortened) !== JSON.stringify(values)) count();
  return { ...entry, values: shortened };
}

function cap(value) {
  return value.length > UNREAD_VALUE_CHARS ? `${value.slice(0, UNREAD_VALUE_CHARS)}…[capped]` : value;
}

/** What the trim did, written once so the two graph fixtures cannot describe themselves differently. */
const TRIM_RULE =
  `every distinct tag kept, then filled to ${String(MAX_NODES)} nodes in original order; edges filtered to ` +
  `kept nodes on from_id/to_id; stage_data to one entry; of the node arrays ${UNREAD_NODE_ARRAYS.join(' and ')}, ` +
  `the ${String(NAMED_METRICS.length)} metrics the parser reads by label are kept and the rest capped to ` +
  `${String(UNREAD_KEEP)} entries; meta_data keeps every key, and values of keys the parser does not read are ` +
  `capped at ${String(UNREAD_VALUE_CHARS)} characters`;

/** Keeps one node per distinct tag first, then fills to the bound in original order. */
function trimNodes(nodes) {
  const byTag = new Map();
  for (const node of nodes) {
    const tag = node.tag ?? '(untagged)';
    if (!byTag.has(tag)) byTag.set(tag, node);
  }
  const kept = [...byTag.values()];
  const keptIds = new Set(kept.map((node) => node.id));
  for (const node of nodes) {
    if (kept.length >= MAX_NODES) break;
    if (!keptIds.has(node.id)) {
      kept.push(node);
      keptIds.add(node.id);
    }
  }
  return kept;
}

/** Trims the widest graph in place, leaving every other entry and the envelope untouched. */
function trimPlans(body) {
  const entries = Object.entries(body.plans ?? {});
  let widest = null;
  for (const [key, value] of entries) {
    const graph = typeof value === 'string' ? JSON.parse(value) : value;
    const count = graph?.nodes?.length ?? 0;
    if (!widest || count > widest.count) widest = { key, graph, count };
  }
  if (!widest || widest.count === 0) return { body, original: null };
  const originalTags = [...new Set(widest.graph.nodes.map((node) => node.tag ?? '(untagged)'))].sort();
  const capped = {};
  const trimmed = trimNodes(widest.graph.nodes).map((node) => capUnread(node, capped));
  // Compared as strings, because that is what `extractPlan` compares: an operator's `id` is `String(node.id)`
  // and an endpoint that arrived as a number would match nothing here while matching everything there.
  const keptIds = new Set(trimmed.map((node) => String(node.id)));
  const stages = widest.graph.stage_data;
  const originalEdges = widest.graph.edges ?? [];
  // Filtered to the kept nodes so the graph stays internally consistent, on the field names `33ii` measured.
  //
  // This read `edge.source ?? edge.from` against `edge.target ?? edge.to` — two guesses at a name, neither
  // from a measurement. An edge is `{from_id, to_id}`, so the filter matched nothing on every plan and every
  // committed fixture carried `edges: []` under a note saying edges were filtered to the kept nodes. Nothing
  // recorded the count before the filter, so the fixture could not say which had happened, and `33ic` would
  // have shipped an edge parser tested against a graph with no edges in it.
  const keptEdges = originalEdges.filter(
    (edge) => keptIds.has(String(edge.from_id)) && keptIds.has(String(edge.to_id)),
  );
  const plans = { ...body.plans };
  plans[widest.key] = {
    ...widest.graph,
    nodes: trimmed,
    edges: keptEdges,
    ...(Array.isArray(stages) && stages.length > 1 ? { stage_data: stages.slice(0, 1) } : {}),
  };
  return {
    body: { ...body, plans },
    original: {
      graphEntries: entries.length,
      widestGraphKey: widest.key,
      widestGraphNodes: widest.count,
      distinctTags: originalTags,
      nodesKept: trimmed.length,
      // Both counts, so an empty `edges` in a fixture says which of the two things happened. Its absence is
      // what let the filter above go unnoticed from the first capture to `33ii`.
      edges: originalEdges.length,
      edgesKept: keptEdges.length,
      stageDataEntries: Array.isArray(stages) ? stages.length : 0,
      cappedUnreadFields: capped,
    },
  };
}

/**
 * Writes a fixture only if it is the shape its own note claims, and leaves the committed one alone if not.
 *
 * Each fixture stands for one response class and its `_capture.note` says which. Nothing in `fetchText`
 * enforces that: a `statement_id` still in `system.query.history` whose plan the endpoint no longer serves
 * comes back 404, and a re-run would overwrite the cache-hit fixture with a 404 body under a note saying it
 * is a 200 with `plans_state: EMPTY`. `parse.test.ts` would fail on it, which is the safety net working, but
 * the file would already be gone and the failure would point at the test rather than at the capture.
 *
 * So the expectation is declared here and checked before the write. This is the same class of defect as the
 * two the measurements in `33b` and `33k` shipped: an apparatus that reports what it received as though it
 * were what it went looking for.
 */
function write(name, payload, expect) {
  const status = payload._capture.status;
  if (status !== expect.status) {
    throw new Error(
      `${name}: expected HTTP ${String(expect.status)} and got ${String(status)}; the committed fixture is left as it was. ` +
        `This fixture stands for "${expect.because}".`,
    );
  }
  if (expect.plansState !== undefined) {
    const actual = payload.body?.plans_state;
    if (actual !== expect.plansState) {
      throw new Error(
        `${name}: expected plans_state ${String(expect.plansState)} and got ${String(actual)}; the committed fixture is left as it was. ` +
          `This fixture stands for "${expect.because}".`,
      );
    }
  }
  const file = join(OUT_DIR, `${name}.json`);
  writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`);
  const bytes = JSON.stringify(payload).length;
  console.log(`  ${name.padEnd(20)} ${String(bytes).padStart(8)} bytes  (${String(status)} ${String(payload.body?.plans_state ?? '-')})`);
}

async function main() {
  if (!HOST) throw new Error('DATABRICKS_HOST is required');
  if (!WAREHOUSE) throw new Error('DATABRICKS_WAREHOUSE_ID is required');
  mkdirSync(OUT_DIR, { recursive: true });

  const warehouses = await call('/api/2.0/sql/warehouses', { method: 'GET' });
  const localIds = (warehouses.warehouses ?? []).map((warehouse) => warehouse.id).filter(Boolean);
  const localList = localIds.map((id) => `'${id}'`).join(',');

  // The widest plan among the slowest statements, chosen by measuring rather than by assuming duration
  // predicts plan size. It does not: the slowest statement in the window had a 31-node plan while a
  // mid-duration one had 335, and a fixture whose node count equals its distinct-tag count exercises
  // neither selection nor the trim it claims to have applied.
  const candidates = await run(`
    SELECT statement_id FROM system.query.history
    WHERE start_time >= current_timestamp() - INTERVAL 7 DAYS
      AND compute.type = 'WAREHOUSE' AND CAST(compute.warehouse_id AS STRING) IN (${localList})
      AND execution_status = 'FINISHED' AND statement_type = 'SELECT'
      AND coalesce(from_result_cache, false) = false AND total_duration_ms > 3000
    ORDER BY total_duration_ms DESC LIMIT ${String(CANDIDATES)}`);
  if (candidates.length === 0) throw new Error('no local statement with a plan in the last 7 days');

  let widestCandidate = null;
  for (const [candidateId] of candidates) {
    const probe = await fetchText(`/api/2.0/sql/history/queries/${String(candidateId)}?include_plans=true`);
    if (probe.status !== 200) continue;
    let parsed = null;
    try {
      parsed = JSON.parse(probe.text);
    } catch {
      continue;
    }
    let nodes = 0;
    for (const value of Object.values(parsed.plans ?? {})) {
      const graph = typeof value === 'string' ? JSON.parse(value) : value;
      nodes = Math.max(nodes, graph?.nodes?.length ?? 0);
    }
    if (!widestCandidate || nodes > widestCandidate.nodes) {
      widestCandidate = { id: String(candidateId), nodes };
    }
  }
  if (!widestCandidate || widestCandidate.nodes === 0) {
    throw new Error(`none of the ${String(candidates.length)} candidates returned a plan with nodes`);
  }
  const richId = widestCandidate.id;
  console.log(
    `widest plan among ${String(candidates.length)} candidates: ${String(widestCandidate.nodes)} nodes`,
  );

  // A cache hit, which 33k measured as 200 with plans_state EMPTY rather than a 404.
  const [cached] = await run(`
    SELECT statement_id FROM system.query.history
    WHERE start_time >= current_timestamp() - INTERVAL 15 DAYS
      AND compute.type = 'WAREHOUSE' AND CAST(compute.warehouse_id AS STRING) IN (${localList})
      AND from_result_cache = true
    ORDER BY start_time DESC LIMIT 1`);

  // A statement from another workspace, which 33k measured as the dominant cause of a 404.
  const [foreign] = await run(`
    SELECT statement_id FROM system.query.history
    WHERE start_time >= current_timestamp() - INTERVAL 15 DAYS
      AND compute.type = 'WAREHOUSE' AND CAST(compute.warehouse_id AS STRING) NOT IN (${localList})
    ORDER BY start_time DESC LIMIT 1`);

  const provenance = (note) => ({
    capturedAt: new Date().toISOString(),
    profile: PROFILE,
    script: 'scripts/capture-plan-fixtures.mjs',
    note,
  });

  console.log(`capturing from ${richId}`);

  // 1. metrics-only: the rung that carries `metrics` and no `plans`.
  const metrics = await fetchText(`/api/2.0/sql/history/queries/${richId}?include_metrics=true`);
  const metricsBody = redact(JSON.parse(metrics.text));
  write('metrics-only', {
    _capture: {
      ...provenance(
        'The include_metrics rung. Carries a metrics object and no plans field, while plans_state still reads EXISTS — so plans_state is not a statement about the response in hand.',
      ),
      request: '?include_metrics=true',
      status: metrics.status,
      responseBytes: metrics.text.length,
      trimmed: false,
    },
    body: metricsBody,
  }, {
    status: 200,
    plansState: 'EXISTS',
    because: 'the include_metrics rung, which reads EXISTS and still carries no plans field',
  });

  // 2. json-plan: the rung the app will actually ask for, trimmed.
  const plans = await fetchText(`/api/2.0/sql/history/queries/${richId}?include_plans=true`);
  const { body: trimmedBody, original } = trimPlans(redact(JSON.parse(plans.text)));
  if (!original) throw new Error('the include_plans capture carried no graph to trim');
  write('json-plan', {
    _capture: {
      ...provenance(
        'The include_plans rung. Node counts here are NOT the counts the API returned — the widest graph is trimmed. Read original.widestGraphNodes for that, and see the header of capture-plan-fixtures.mjs for why.',
      ),
      request: '?include_plans=true',
      status: plans.status,
      responseBytes: plans.text.length,
      trimmed: true,
      nodesTrimmed: original.widestGraphNodes > original.nodesKept,
      trimRule: TRIM_RULE,
      fingerprintWarning:
        'A fingerprint computed from this fixture is not the fingerprint of the statement it came from: planFingerprint hashes the tag list including duplicates, and trimming removes duplicates. Fixtures prove the fingerprint is stable and sensitive, not what it equals in production.',
      original,
    },
    body: trimmedBody,
  }, {
    status: 200,
    plansState: 'EXISTS',
    because: 'the include_plans rung, the one the app will ask for, carrying a graph',
  });

  // 3. sorted-plan: a statement this script runs, because the estate's widest plan has no sort in it.
  //
  // `json-plan` is chosen by width from what the workspace happened to run, and on every capture so far that
  // has been a plan with no `SORT_ORDER` anywhere in it. `33ic` added that key and `33ie` will read it, and a
  // promised key with no fixture carrying a value is exactly the hole `33ih` climbed out of: `parse.test.ts`
  // asserted presence, five keys sat empty for a whole phase, and only a live probe found it.
  //
  // So this one is produced rather than found. The statement sorts twice over — a window function's sort with
  // an aggregate above it, and an `ORDER BY … LIMIT` that the planner turns into a top-k — because `33ii`
  // measured that those are two different operators and only one of them is tagged as a sort.
  const sorted = await runForPlan(`
    WITH ranked AS (
      SELECT statement_id, statement_type, total_duration_ms,
             row_number() OVER (PARTITION BY statement_type ORDER BY total_duration_ms DESC) AS rank
      FROM system.query.history
      WHERE start_time >= current_timestamp() - INTERVAL 2 DAYS
    )
    SELECT statement_type, count(*) AS runs, sum(total_duration_ms) AS ms
    FROM ranked WHERE rank <= 100
    GROUP BY 1 ORDER BY ms DESC LIMIT 20`);
  if (sorted == null) {
    console.log('  (the sorting statement produced no graph; sorted-plan not refreshed)');
  } else {
    const { body: sortedBody, original: sortedOriginal } = trimPlans(redact(JSON.parse(sorted.text)));
    if (!sortedOriginal) throw new Error('the sorting statement carried no graph to trim');
    write('sorted-plan', {
      _capture: {
        ...provenance(
          'A statement this script runs, sorting twice: a window function’s sort and an ORDER BY … LIMIT the planner turns into a top-k. It exists because the estate’s widest plan carries no SORT_ORDER, and a promised key with no captured value is the hole 33ih came out of. Node counts here are NOT the counts the API returned.',
        ),
        request: '?include_plans=true',
        status: sorted.status,
        responseBytes: sorted.text.length,
        trimmed: true,
        nodesTrimmed: sortedOriginal.widestGraphNodes > sortedOriginal.nodesKept,
        trimRule: TRIM_RULE,
        statement: sorted.statement,
        original: sortedOriginal,
      },
      body: sortedBody,
    }, {
      status: 200,
      plansState: 'EXISTS',
      because: 'a plan with a sort and a top-k in it, which the estate’s widest plan does not have',
    });
  }

  // The JSON-as-a-string shape is not captured: the values in `plans` arrived as objects on both
  // statements measured, and a second copy of this fixture re-encoded would be 116 KB to assert one
  // `typeof`. The parser's test derives it from `json-plan.json` instead.

  // 4. empty-plan: a cache hit, 200 with plans_state EMPTY.
  if (cached) {
    const empty = await fetchText(`/api/2.0/sql/history/queries/${String(cached[0])}?include_plans=true`);
    write('empty-plan', {
      _capture: {
        ...provenance(
          'A cache hit on a local warehouse. 33k measured these as 200 with plans_state EMPTY: a plan record reporting no plan, which is what licenses the app to say a plan was absent.',
        ),
        request: '?include_plans=true',
        status: empty.status,
        responseBytes: empty.text.length,
        trimmed: false,
      },
      body: redact(JSON.parse(empty.text)),
    }, {
      status: 200,
      plansState: 'EMPTY',
      because: 'a cache hit: a plan record reporting no plan, which is not a 404',
    });
  } else {
    console.log('  (no local cache hit in 15 days; empty-plan not refreshed)');
  }

  // 5. not-retrievable: a 404, which has a body but no plan record.
  if (foreign) {
    const missing = await fetchText(`/api/2.0/sql/history/queries/${String(foreign[0])}?include_plans=true`);
    write('not-retrievable', {
      _capture: {
        ...provenance(
          'A statement from another workspace sharing the metastore. 33k measured this as the dominant cause of a 404: no plan record for this workspace, and whether a plan exists is not in the response. Distinct from empty-plan, and the app may not report it the same way.',
        ),
        request: '?include_plans=true',
        status: missing.status,
        responseBytes: missing.text.length,
        trimmed: false,
      },
      body: JSON.parse(missing.text),
    }, {
      status: 404,
      because: 'a statement from another workspace: no plan record, which is not an empty one',
    });
  } else {
    console.log('  (no foreign-warehouse statement in 15 days; not-retrievable not refreshed)');
  }

  console.log(`\nwrote fixtures to ${OUT_DIR}`);
  console.log('text-only.json is written by hand and is not refreshed here — see its own _capture note.');
  console.log('The JSON-as-a-string shape is derived in the parser test, not captured.');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}

export { NAMED_METRICS, PROMISED_META, capEntry, capUnread, trimNodes, trimPlans, redact };
