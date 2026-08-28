// Measures the three things `33ic` would add to the plan extract, before it adds them.
//
// Live and optional, like its siblings: it needs a warehouse and a CLI profile, nothing in `npm run verify`
// runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-plan-extract-additions.mjs
//
// ## The premise being measured
//
// `33ic` reads "extend the extract with named metrics, `SORT_ORDER` and the graph's edges", and two of those
// three are a shape nobody has looked at. `33ia` counted edges — 10 to 33 per probe — and recorded nothing
// about what an edge *is*. The one committed fixture with a graph carries `"edges": []`, and
// `capture-plan-fixtures.mjs` filters them with `edge.source ?? edge.from`: two guesses at a field name,
// neither from a measurement, comparing endpoints against `node.id` whose type is also a guess. So the empty
// array cannot be read as "this plan had no edges between the kept nodes". It is equally consistent with the
// filter matching nothing, and nothing recorded the original count, so the fixture cannot settle it either.
//
// A parser written against the same two guesses, tested against a fixture the same guesses had already
// emptied, would pass and ship. `LARGE_SORT` would then look for a limiting reduction downstream of a sort in
// a graph with no edges in it, find none, and report every sort in the estate as pointless.
//
// So this script measures and writes no parser:
//
//   - **An edge.** Field names, a verbatim sample, the JavaScript type of each endpoint, and — per candidate
//     name pair — how many endpoints resolve to a node in the same graph, strictly and after coercion. The
//     count is already known and is not the question.
//   - **`SORT_ORDER`.** Which spelling it uses, on which operators, with what in it. `33ih` established that
//     the shape is fixed per key and that reading the wrong one of the two fields fails silently, so the key
//     `LARGE_SORT` needs is checked before a parser selects it.
//   - **What each addition costs.** The extract exists because the response is two orders of magnitude
//     larger, and `33ic`'s scope sentence — keep a few metrics by name rather than the vocabulary — rests on
//     that ratio. Measured as bytes, per addition, so `33ic` can drop whichever is not worth its weight.
//
// ## What the size arithmetic is, and is not
//
// `extractLike` below is a reimplementation of `parse.ts`'s `extractPlan` in JavaScript, because this file is
// `.mjs` and cannot import the TypeScript one. A reimplementation measuring its own baseline would be the
// apparatus defect `33ia` shipped and had to withdraw, so `measure-plan-extract-additions.test.ts` holds
// `extractLike(graph, {})` to be byte-identical to `extractPlan(graph)` on the committed capture. The claim
// this script makes is a ratio between its own variants; the test is what licenses reading the baseline as
// the parser's.

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plan-extract-additions.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';


/**
 * `parse.ts`'s three constants, copied because a `.mjs` file cannot import the TypeScript one.
 *
 * Copied rather than approximated: the test asserts `extractLike(graph, {})` is byte-identical to
 * `extractPlan(graph)`, so a copy that drifts fails there rather than quietly measuring a different baseline.
 */
const PARSER_VERSION = 'plan-parser-2';

const PROMISED_META_KEYS = [
  'SCAN_IDENTIFIER',
  'JOIN_ALGORITHM',
  'JOIN_BUILD_SIDE',
  'PARTITIONING_TYPE',
  'IS_PHOTON',
  'SCAN_PARTITIONS',
];

/**
 * The metric labels a rule would read by name, and why the name is a label rather than a key.
 *
 * `33ia` recorded 812 distinct labels across five probes and exactly five distinct `metric.key` values —
 * `CUMULATIVE_TIME`, `DURATION`, `EXCLUSIVE_TIME`, `NUMBER_OUTPUT_ROWS`, `PEAK_MEMORY_USAGE` — with every
 * other metric keyed `UNKNOWN_KEY`. Those five are the three `key_metrics` fields the extract already keeps
 * plus two times. So a rule reaching for a skew ratio or a build-side size has nothing to select it by except
 * the label string, which is display text: it is what this list is made of, and that is a fragility `33ic`
 * inherits rather than one it can design away.
 *
 * Chosen per deferred rule from `33ia`'s vocabulary, and deliberately narrow. Whether each one carries a
 * number is exactly what this script answers; a label present and zero on every probe is what `33ia` already
 * found for the skew metrics read as a set, and that is the finding a rule would have to be built around.
 */
const CANDIDATE_METRICS = {
  DATA_SKEW: [
    'MapStage - Skew max to non-empty median ratio',
    'MapStage - Skew num skewed partitions',
    'MapStage - Skew skewed data size ratio',
    'MapStage - Skew non-empty median partition size',
    'MapStage - Skew num empty partitions',
    'AQEShuffleRead - Skew handled by',
  ],
  EXCESSIVE_EXCHANGES: [
    'AQEShuffleRead - Number of partitions',
    'AQEShuffleRead - Number of coalesced partitions',
    'MapStage - Number of output rows',
  ],
  LARGE_SORT: [
    'Max batch size (rows) produced in the sort node',
    'Max column batch size (bytes) sort spilled',
    'Num bytes spilled to disk due to memory pressure',
  ],
  BROADCAST_CANDIDATE: ['Hashed relation size', 'Aggressive BHJ Extrapolated Size', 'Aggressive BHJ Decision'],
  MISSING_OR_STALE_STATS: [
    'MapStage - EnsureRequirementsDP estimated NDV',
    'Scan - Size of a row of all columns in the relation (estimated)',
    'Scan - Size of a row of scanned columns (estimated)',
  ],
};

const WANTED_LABELS = [...new Set(Object.values(CANDIDATE_METRICS).flat())];

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

/** A comment nobody reads except the result cache — `33ia`'s finding, and the same reason. */
export function uncached(statement) {
  return `-- probe ${String(Date.now())}-${String(Math.round(Math.random() * 1e6))}\n${statement}`;
}

async function run(statement) {
  try {
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
    return {
      statementId: response.statement_id ?? null,
      state: response.status?.state ?? null,
      error: response.status?.error?.message ?? null,
    };
  } catch (error) {
    return { statementId: null, state: 'HTTP_ERROR', error: error instanceof Error ? error.message : String(error) };
  }
}

/** The widest graph in `plans`, for the reason `parse.ts` gives: the index holding the plan is undocumented. */
export function widestGraph(body) {
  const plans = body?.plans;
  if (plans == null || typeof plans !== 'object') return { index: null, graph: null, nodes: 0 };
  let best = { index: null, graph: null, nodes: 0 };
  for (const [index, value] of Object.entries(plans)) {
    let graph = value;
    if (typeof value === 'string') {
      try {
        graph = JSON.parse(value);
      } catch {
        continue;
      }
    }
    const nodes = graph?.nodes?.length ?? 0;
    if (best.index === null || nodes > best.nodes) best = { index, graph, nodes };
  }
  return best;
}

/**
 * The candidate endpoint names, every one a guess until this runs.
 *
 * The first three are the guesses already in the tree: `capture-plan-fixtures.mjs` filters edges with
 * `edge.source ?? edge.from`, and `fromId`/`toId` is the camel-cased spelling a reader of that would try
 * next. They are kept in the list after the answer is known, because a pair resolving nothing is the finding
 * about the capture script and not noise.
 */
const ENDPOINT_PAIRS = [
  ['source', 'target'],
  ['from', 'to'],
  ['fromId', 'toId'],
  ['from_id', 'to_id'],
];

/**
 * What an edge is, answered rather than assumed.
 *
 * The fields are reported as a union across edges, because a graph whose edges do not all carry the same keys
 * is a shape a parser has to handle and a sample of one would hide. `resolution` is the part the fixture
 * cannot answer: per candidate name pair, how many of this graph's edges have both endpoints matching a
 * `node.id`, compared strictly and again after `String()` on both sides. A pair that resolves nothing is a
 * wrong guess; a pair that resolves only after coercion is the defect that empties a fixture silently, and
 * the two are worth telling apart because the fix is different.
 */
export function edgeShape(graph) {
  const edges = graph?.edges ?? [];
  const nodes = graph?.nodes ?? [];
  const ids = nodes.map((node) => node.id);
  const strict = new Set(ids);
  const coerced = new Set(ids.map((id) => String(id)));

  const fields = [...new Set(edges.flatMap((edge) => (edge == null ? [] : Object.keys(edge))))].sort();
  const fieldTypes = {};
  for (const edge of edges) {
    for (const [field, value] of Object.entries(edge ?? {})) {
      (fieldTypes[field] ??= new Set()).add(value === null ? 'null' : typeof value);
    }
  }

  const resolution = {};
  for (const [left, right] of ENDPOINT_PAIRS) {
    const present = edges.filter((edge) => edge?.[left] !== undefined && edge?.[right] !== undefined);
    resolution[`${left}/${right}`] = {
      edgesCarryingBoth: present.length,
      resolvedStrictly: present.filter((edge) => strict.has(edge[left]) && strict.has(edge[right])).length,
      resolvedAfterCoercion: present.filter(
        (edge) => coerced.has(String(edge[left])) && coerced.has(String(edge[right])),
      ).length,
    };
  }

  return {
    edges: edges.length,
    nodes: nodes.length,
    fields,
    fieldTypes: Object.fromEntries(
      Object.entries(fieldTypes)
        .map(([field, types]) => [field, [...types].sort()])
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
    nodeIdTypes: [...new Set(ids.map((id) => (id === null ? 'null' : typeof id)))].sort(),
    nodeIdsUnique: coerced.size === ids.length,
    resolution,
    // Verbatim, capped. What a parser is written against, and short enough that a reader of the recording can
    // see the field names in context rather than take the union above on trust.
    sample: edges.slice(0, 5),
  };
}

/**
 * The endpoint pair that actually resolves, or nothing.
 *
 * Chosen by how many of the graph's edges land on two of its own operators rather than by preference, so the
 * walk below is written against the measurement instead of against the same guess twice. Ties go to the
 * earlier pair and a graph with no edges answers `null`, which the caller reports rather than working around.
 */
export function endpointNames(shape) {
  const ranked = Object.entries(shape.resolution)
    .map(([pair, resolved]) => ({ pair, resolved: resolved.resolvedAfterCoercion }))
    .filter((one) => one.resolved > 0)
    .sort((a, b) => b.resolved - a.resolved);
  return ranked[0]?.pair ?? null;
}

/**
 * What sits either side of a sort, which is the whole of what `LARGE_SORT` needs and cannot get from a node
 * list.
 *
 * Both directions, because the field names do not say which way an edge points and a rule that assumes wrong
 * reads the sort's input as its output. A `Scan` appearing on one side and nothing on the other is what
 * settles it; the recording carries both so the next reader does not have to trust this file's reading of it.
 *
 * Three hops rather than one: the reduction `LARGE_SORT` looks for is a `LIMIT` or an aggregate, and a plan
 * puts a projection or an exchange between the sort and it.
 */
export function aroundSorts(graph, pair, hops = 3) {
  if (pair == null) return [];
  const [left, right] = pair.split('/');
  const nodes = graph?.nodes ?? [];
  const tagOf = new Map(nodes.map((node) => [String(node.id), node.tag]));
  const forward = new Map();
  const backward = new Map();
  for (const edge of graph?.edges ?? []) {
    const from = String(edge?.[left]);
    const to = String(edge?.[right]);
    (forward.get(from) ?? forward.set(from, []).get(from)).push(to);
    (backward.get(to) ?? backward.set(to, []).get(to)).push(from);
  }
  const reach = (start, adjacency) => {
    const seen = new Set();
    let frontier = [start];
    for (let hop = 0; hop < hops; hop += 1) {
      frontier = frontier.flatMap((id) => adjacency.get(id) ?? []).filter((id) => !seen.has(id));
      for (const id of frontier) seen.add(id);
    }
    return [...seen].map((id) => tagOf.get(id) ?? '(unknown id)');
  };

  return nodes
    .filter((node) => /sort/i.test(String(node.tag)))
    .map((node) => ({
      id: String(node.id),
      tag: node.tag,
      alongTo: reach(String(node.id), forward),
      alongFrom: reach(String(node.id), backward),
    }));
}

/**
 * Every `meta_data` key matching a pattern, with its spelling and its content.
 *
 * `33ih`'s finding is that the spelling is fixed per key and that reading the wrong field returns an empty
 * array rather than an error, so this reports which field carried the content rather than only the content.
 *
 * `tags` is recorded beside it because `LARGE_SORT` would select its operators by tag while the sort order is
 * a `meta_data` key, and the two are not the same selector: the first probe here declares `SORT_ORDER` on two
 * operators and has no operator tagged as a sort at all, an `ORDER BY` with a `LIMIT` being planned as a
 * top-k. A rule reaching for sorts by tag would not see it.
 */
export function metaShape(graph, pattern) {
  const found = {};
  for (const node of graph?.nodes ?? []) {
    for (const entry of node.meta_data ?? []) {
      if (entry.key == null || !pattern.test(entry.key)) continue;
      const spelling = entry.value != null ? 'value' : Array.isArray(entry.values) ? 'values' : null;
      const values = spelling === 'value' ? [String(entry.value)] : (entry.values ?? []).map(String);
      const seen = (found[entry.key] ??= { spellings: new Set(), tags: new Set(), operators: 0, entries: 0, samples: [] });
      if (spelling != null) seen.spellings.add(spelling);
      seen.tags.add(node.tag);
      seen.operators += 1;
      seen.entries += values.length;
      for (const value of values) if (seen.samples.length < 6) seen.samples.push(value.slice(0, 120));
    }
  }
  return Object.fromEntries(
    Object.entries(found)
      .map(([key, seen]) => [
        key,
        { ...seen, spellings: [...seen.spellings].sort(), tags: [...seen.tags].sort() },
      ])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Per candidate label: which operators carry it, and whether it ever carries a number.
 *
 * The distinction the recording has to keep is `33ia`'s: a label is present on plans with none of the thing
 * it names, so a rule reads the value. `nonZero` is therefore the column that decides whether a rule can be
 * built, and `carried` only says the label exists to be read.
 */
export function namedMetrics(graph, labels) {
  const wanted = new Set(labels);
  const found = {};
  for (const node of graph?.nodes ?? []) {
    for (const metric of node.metrics ?? []) {
      if (!wanted.has(metric.label)) continue;
      const seen = (found[metric.label] ??= { carried: 0, nonZero: 0, keys: new Set(), samples: [] });
      seen.carried += 1;
      if (Number(metric.value) > 0) seen.nonZero += 1;
      seen.keys.add(metric.key ?? null);
      if (seen.samples.length < 4) seen.samples.push({ tag: node.tag, value: metric.value });
    }
  }
  return Object.fromEntries(
    Object.entries(found)
      .map(([label, seen]) => [label, { ...seen, keys: [...seen.keys].sort() }])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function fingerprintOf(graph) {
  const tags = (graph?.nodes ?? []).map((node) => node.tag ?? '(untagged)').sort();
  return createHash('sha256').update(tags.join('|')).digest('hex').slice(0, 16);
}

function metaValues(entry) {
  if (entry.value != null) return [String(entry.value)];
  return Array.isArray(entry.values) ? entry.values.map(String) : [];
}

function allZero(metrics) {
  const values = [metrics.duration_ms, metrics.rows_num, metrics.peak_memory_bytes].filter(
    (value) => typeof value === 'number',
  );
  return values.length > 0 && values.every((value) => value === 0);
}

/**
 * `extractPlan`, reimplemented, with the three additions switchable.
 *
 * Byte-identical to the TypeScript one when `additions` is empty — asserted against the committed capture in
 * `measure-plan-extract-additions.test.ts`, which is the only thing that makes the baseline below the
 * parser's baseline rather than this file's opinion of it. Field order matters to that assertion, so the keys
 * here are in `parse.ts`'s order and the additions go last.
 */
export function extractLike(graph, additions = {}) {
  const { edges = false, sortOrder = false, metrics = [] } = additions;
  const wanted = new Set(metrics);
  const keys = sortOrder ? [...PROMISED_META_KEYS, 'SORT_ORDER'] : PROMISED_META_KEYS;

  const operators = [];
  let withoutMetrics = 0;
  let zeroMetrics = 0;
  for (const node of graph?.nodes ?? []) {
    const meta = {};
    for (const entry of node.meta_data ?? []) {
      if (entry.key != null && keys.includes(entry.key)) meta[entry.key] = metaValues(entry);
    }
    const hasMetrics = node.key_metrics != null;
    if (!hasMetrics) withoutMetrics += 1;
    else if (allZero(node.key_metrics)) zeroMetrics += 1;
    const named = (node.metrics ?? [])
      .filter((metric) => wanted.has(metric.label))
      .map((metric) => [metric.label, metric.value]);

    operators.push({
      id: String(node.id ?? ''),
      tag: node.tag ?? '(untagged)',
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(hasMetrics ? { keyMetrics: node.key_metrics } : {}),
      ...(named.length > 0 ? { named: Object.fromEntries(named) } : {}),
    });
  }

  return {
    parserVersion: PARSER_VERSION,
    fingerprint: fingerprintOf(graph),
    operatorCount: operators.length,
    operators,
    operatorsWithoutMetrics: withoutMetrics,
    operatorsWithZeroMetrics: zeroMetrics,
    ...(edges ? { edges: [...(graph?.edges ?? [])] } : {}),
  };
}

/**
 * What each addition costs, in bytes of stored JSON, and each alone rather than only together.
 *
 * Alone because `33ic`'s decision is per addition: the row can keep the edges and drop the metrics, or the
 * reverse, and a combined figure cannot support either choice. `responseBytes` is beside them because the
 * extract exists at all on the strength of a ratio to the response, and a percentage of the extract is not
 * that ratio.
 */
export function costOf(graph, responseBytes, labels = WANTED_LABELS) {
  const bytes = (additions) => JSON.stringify(extractLike(graph, additions)).length;
  const baseline = bytes({});
  const variants = {
    edges: bytes({ edges: true }),
    sortOrder: bytes({ sortOrder: true }),
    namedMetrics: bytes({ metrics: labels }),
    all: bytes({ edges: true, sortOrder: true, metrics: labels }),
  };
  return {
    responseBytes,
    baselineBytes: baseline,
    responseOverBaseline: Number((responseBytes / baseline).toFixed(1)),
    added: Object.fromEntries(
      Object.entries(variants).map(([name, size]) => [
        name,
        { bytes: size, addedBytes: size - baseline, addedPercent: Number((((size - baseline) / baseline) * 100).toFixed(1)) },
      ]),
    ),
  };
}

/**
 * The probes: the three of `33ia`'s five that produce a sort, a shuffle or both.
 *
 * Reused verbatim rather than rewritten, so a difference between the two recordings is a difference in what
 * was read and not in what was run. The UDF and unanalysed-scan probes are left out: neither sorts, and what
 * this measures is the graph's structure.
 */
const PROBES = [
  {
    id: 'join-and-sort',
    statement: String.raw`
      SELECT h.statement_id, h.total_duration_ms, small.label
      FROM system.query.history h
      JOIN (VALUES ('a', 'SELECT'), ('b', 'INSERT')) AS small(label, kind)
        ON h.statement_type = small.kind
      WHERE h.start_time >= current_timestamp() - INTERVAL 2 DAYS
      ORDER BY h.total_duration_ms DESC
      LIMIT 50`,
  },
  {
    id: 'sort-without-limit',
    statement: String.raw`
      SELECT count(*) FROM (
        SELECT statement_id, row_number() OVER (ORDER BY total_duration_ms DESC) AS rank
        FROM system.query.history
        WHERE start_time >= current_timestamp() - INTERVAL 7 DAYS
      ) ranked
      WHERE rank > 0`,
  },
  {
    id: 'shuffle-heavy',
    statement: String.raw`
      WITH per_user AS (
        SELECT executed_by, statement_type, count(*) AS runs, sum(total_duration_ms) AS ms
        FROM system.query.history
        WHERE start_time >= current_timestamp() - INTERVAL 7 DAYS
        GROUP BY 1, 2
      ),
      per_type AS (
        SELECT statement_type, count(DISTINCT executed_by) AS users, sum(runs) AS runs
        FROM per_user GROUP BY 1
      )
      SELECT per_type.statement_type, per_type.users, per_type.runs, sum(per_user.ms) AS ms
      FROM per_type JOIN per_user USING (statement_type)
      GROUP BY 1, 2, 3
      ORDER BY ms DESC`,
  },
];

/** Waits for the graph rather than for `plans_state`, which `33ia` measured is not a claim about the body. */
async function awaitPlan(statementId) {
  let state = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetchText(`/api/2.0/sql/history/queries/${statementId}?include_plans=true`);
    if (response.status !== 200) return { status: response.status, plansState: state, body: null };
    const body = JSON.parse(response.text);
    state = body.plans_state ?? null;
    if (widestGraph(body).nodes > 0) {
      return { status: 200, plansState: state, body, bytes: response.text.length };
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  return { status: 200, plansState: state, body: null, timedOut: true };
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (HOST === '' || WAREHOUSE === '') throw new Error('set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID');

  const probes = [];
  for (const probe of PROBES) {
    const statement = uncached(probe.statement);
    const executed = await run(statement);
    if (executed.state !== 'SUCCEEDED' || executed.statementId == null) {
      console.log(`\n${probe.id}: failed — ${String(executed.error ?? executed.state).slice(0, 200)}`);
      probes.push({ id: probe.id, failed: String(executed.error ?? executed.state).slice(0, 400) });
      write(probes);
      continue;
    }
    const fetched = await awaitPlan(executed.statementId);
    if (fetched.body == null) {
      console.log(`\n${probe.id}: no graph — status ${String(fetched.status)}, plans_state ${String(fetched.plansState)}`);
      probes.push({ id: probe.id, statementId: executed.statementId, plansState: fetched.plansState, noGraph: true });
      write(probes);
      continue;
    }

    const { graph } = widestGraph(fetched.body);
    const edges = edgeShape(graph);
    const measured = {
      id: probe.id,
      statementId: executed.statementId,
      statement: statement.replace(/^\s*-- probe [^\n]*\n/, '').trim(),
      plansState: fetched.plansState,
      edges,
      endpointNames: endpointNames(edges),
      aroundSorts: aroundSorts(graph, endpointNames(edges)),
      sortMeta: metaShape(graph, /SORT/),
      namedMetrics: namedMetrics(graph, WANTED_LABELS),
      cost: costOf(graph, fetched.bytes),
    };
    probes.push(measured);
    write(probes);

    console.log(`\n${probe.id} — ${String(edges.nodes)} operators, ${String(edges.edges)} edges`);
    console.log(`  edge fields: ${edges.fields.join(', ') || '(none)'}  node id types: ${edges.nodeIdTypes.join(', ')}`);
    for (const [pair, resolved] of Object.entries(edges.resolution)) {
      console.log(
        `  ${pair.padEnd(14)} both present on ${String(resolved.edgesCarryingBoth)}; resolved strictly ${String(resolved.resolvedStrictly)}, after coercion ${String(resolved.resolvedAfterCoercion)}`,
      );
    }
    console.log(`  endpoints: ${measured.endpointNames ?? '(none resolved)'}`);
    for (const sort of measured.aroundSorts) {
      console.log(`    sort ${String(sort.tag)} to→ ${sort.alongTo.join(', ') || '(none)'}`);
      console.log(`    sort ${String(sort.tag)} from→ ${sort.alongFrom.join(', ') || '(none)'}`);
    }
    for (const [key, seen] of Object.entries(measured.sortMeta)) {
      console.log(`  ${key} as ${seen.spellings.join('/')} on ${seen.tags.join(', ')}`);
    }
    const withValues = Object.entries(measured.namedMetrics).filter(([, seen]) => seen.nonZero > 0);
    console.log(`  candidate metrics carried: ${String(Object.keys(measured.namedMetrics).length)} of ${String(WANTED_LABELS.length)}, above zero on ${String(withValues.length)}`);
    for (const [name, added] of Object.entries(measured.cost.added)) {
      console.log(`  +${name.padEnd(13)} ${String(added.addedBytes).padStart(8)} bytes  ${String(added.addedPercent)}%`);
    }
  }

  write(probes);
  console.log(`\nwrote ${OUT_FILE}`);
}

/** Written after every probe, for the reason `measure-plan-rule-inputs.mjs` gives: a throw used to cost the run. */
export function write(probes) {
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        runFinishedAt: new Date().toISOString(),
        profile: PROFILE,
        candidateMetrics: CANDIDATE_METRICS,
        endpointPairsTried: ENDPOINT_PAIRS.map((pair) => pair.join('/')),
        probes,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
