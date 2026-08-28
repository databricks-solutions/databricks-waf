// Measures whether the plan carries what the six plan-reading rules need, before `33i` writes them.
//
// Live and optional, like measure-query-plans.mjs: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-plan-rule-inputs.mjs
//
// ## The premise being measured
//
// `docs/plan/h6-workload-advisor.md` schedules `33i` as "the six rules that read the plan" — `DATA_SKEW`,
// `EXCESSIVE_EXCHANGES`, `LARGE_SORT`, `BROADCAST_CANDIDATE`, `MISSING_OR_STALE_STATS` and
// `UDF_OR_PYTHON_BOUNDARY` — as one L-sized row, on the reading that the plan retrieved by `33ma` is the
// input all six of them need. `33b` measured that the plan exists and what it costs. Nobody has measured
// whether it *says* the six things.
//
// The question is not "is there a plan". It is, per rule: is the field the rule reads in the response, is it
// in the extract `33j` keeps, and — where it is in one and not the other — is that a parser decision or a
// platform one. Those are three different answers with three different consequences, and the row is written
// as though there were one.
//
// Two things already point at a split. The extract keeps six `meta_data` keys and the response carries
// twenty-five; and it keeps `nodes` while the graph also carries `edges` and `stage_data`. A rule about a
// sort with "no limiting reduction" is a statement about the *shape* of the graph, and the extract has no
// edges in it.
//
// ## What it probes with
//
// Purpose-built statements rather than whatever the estate happened to run, because the six rules fire on
// six different plan features and an arbitrary statement exercises two of them. Each probe below is chosen
// to force one operator into the plan; what is measured is what the response then says about it. A probe
// that fails is recorded as a probe that failed — an unbuildable rule and an unprobeable one are different
// findings, and the second is not evidence about the platform.
//
// It reads system tables and creates nothing, with one exception: the UDF probe needs a function to exist,
// so it creates one in a scratch schema and drops it. If that is refused the probe records the refusal.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';
import { settled } from './statement-wait.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plan-rule-inputs.json');

const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/+$/, '');
const WAREHOUSE = process.env.DATABRICKS_WAREHOUSE_ID?.trim() ?? '';
const PROFILE = process.env.DATABRICKS_CONFIG_PROFILE?.trim() || 'labs';
const SCRATCH = process.env.SCRATCH_SCHEMA?.trim() || 'main.default';

const POLL_INTERVAL_MS = 2000;
const MAX_POLLS = 150;

/** What the parser keeps today, so the recording can say "in the response and not in the extract". */
const EXTRACTED_META = [
  'SCAN_IDENTIFIER',
  'JOIN_ALGORITHM',
  'JOIN_BUILD_SIDE',
  'PARTITIONING_TYPE',
  'IS_PHOTON',
  'SCAN_PARTITIONS',
];

/**
 * What each rule reads, as a question this script can answer rather than as a description.
 *
 * `look` searches every string in the plan graph for a rule's tell — the graph, not the whole response, which
 * also carries a metrics summary and a debug payload a rule would not read. `needs` names the structures a
 * rule cannot be written without. Both are reported per probe, so a rule with a tell that never appears is
 * distinguishable from one whose tell appears on a statement that did not exercise it.
 */
/**
 * The two spellings a `meta_data` entry takes, and why reading one of them is the defect this found.
 *
 * An entry is either `{key, label, value}` with a scalar or `{key, label, values, meta_values}` with a list,
 * and which one a key takes is fixed per key: `JOIN_ALGORITHM`, `JOIN_BUILD_SIDE`, `SCAN_IDENTIFIER`,
 * `IS_PHOTON` and `PARTITIONING_TYPE` are scalar; `FILTERS`, `LEFT_KEYS`, `SORT_ORDER`, `SCAN_PARTITIONS` and
 * the rest of the expression-shaped keys are lists.
 *
 * The first pass of this script read `entry.values` only. That reports every scalar key as declared-and-empty
 * — which is what it wrote up, for the five keys the rules care about most — and the write-up read as a
 * finding about the platform. It was a finding about this function. The spelling is recorded per key now, so
 * the next reader can see that the distinction was measured rather than assumed.
 */
export function valuesOf(entry) {
  if (entry == null) return { spelling: null, values: [] };
  if (entry.value != null) return { spelling: 'value', values: [String(entry.value)] };
  if (Array.isArray(entry.values)) return { spelling: 'values', values: entry.values.map(String) };
  return { spelling: null, values: [] };
}

const RULES = {
  DATA_SKEW: {
    look: /skew/i,
    needs: ['task-level durations or an AQE skew marker'],
  },
  EXCESSIVE_EXCHANGES: {
    look: /exchange|shuffle/i,
    needs: ['exchange operators countable from tags'],
  },
  LARGE_SORT: {
    look: /\bsort\b/i,
    needs: ['sort operators', 'the graph edges, to see what follows a sort'],
  },
  BROADCAST_CANDIDATE: {
    look: /broadcast/i,
    needs: ['JOIN_ALGORITHM and JOIN_BUILD_SIDE with values', 'row counts on the join inputs'],
  },
  MISSING_OR_STALE_STATS: {
    // The same expression `operators()` filters metrics with, so that a label counted as a tell here has its
    // value recorded there. They were two different expressions in the first pass — `estimat` here and
    // `estimated rows` there — and the narrower one hid the two `Size of a row … (estimated)` labels, which
    // are the closest thing in the plan to the signal this rule is about.
    look: /statistic|estimat|rowcount|stale/i,
    needs: ['a statistics signal of any kind'],
  },
  UDF_OR_PYTHON_BOUNDARY: {
    look: /udf|python|arrow.*eval|batch.*eval/i,
    needs: ['a UDF operator distinguishable from a projection'],
  },
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
  const response = await fetch(path.startsWith('http') ? path : `${HOST}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: ${String(response.status)} ${text.slice(0, 400)}`);
  return JSON.parse(text);
}

/**
 * Runs a statement and answers its id, or the failure, without throwing: a refused probe is a finding.
 *
 * The catch is the part that makes the sentence above true. `call` throws on any non-2xx, so before this a 403
 * on the UDF's `CREATE` — or a 429 during polling — threw out of the probe and past the `DROP`, leaving the
 * function behind and discarding every probe measured up to that point, because nothing was written until the
 * end. The recording is written after each probe now as well, so the two together mean a refusal costs the
 * probe that hit it. An HTTP refusal and a SQL refusal are both findings and neither is an exception.
 */
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
    response = await settled(response, { call, polls: MAX_POLLS, pollIntervalMs: POLL_INTERVAL_MS });
    return {
      statementId: response.statement_id ?? null,
      state: response.status?.state ?? null,
      error: response.status?.error?.message ?? null,
      rows: response.result?.data_array ?? [],
    };
  } catch (error) {
    return {
      statementId: null,
      state: 'HTTP_ERROR',
      error: error instanceof Error ? error.message : String(error),
      rows: [],
    };
  }
}

/**
 * The widest graph, for the reason `measure-query-plans.mjs` gives: `plans` is keyed and mostly empty.
 *
 * It cannot pick another statement's plan — the endpoint is per statement id and the body carries one
 * `query_id` — so "widest" chooses among this statement's own plans. An unparsable entry is counted rather
 * than thrown, because a throw here is uncaught and would end the run at the probe that hit it, leaving the
 * probes after it unmeasured, and `unparsable` is itself worth recording. `plans` is only walked when it is an
 * object, so a string-valued `plans` is reported as one unparsable entry rather than iterated character by
 * character.
 */
export function widestGraph(body) {
  const plans = body?.plans;
  if (plans == null || typeof plans !== 'object') {
    return { index: null, graph: null, nodes: 0, unparsable: typeof plans === 'string' ? 1 : 0, candidates: 0 };
  }
  let unparsable = 0;
  const graphs = [];
  for (const [index, value] of Object.entries(plans)) {
    let graph = value;
    if (typeof value === 'string') {
      try {
        graph = JSON.parse(value);
      } catch {
        unparsable += 1;
        continue;
      }
    }
    graphs.push({ index, graph, nodes: graph?.nodes?.length ?? 0 });
  }
  graphs.sort((a, b) => b.nodes - a.nodes);
  const widest = graphs[0] ?? { index: null, graph: null, nodes: 0 };
  return { ...widest, unparsable, candidates: graphs.length };
}

/** Every string the graph carries, so a rule's tell can be looked for without guessing where it lives. */
export function strings(graph) {
  const found = [];
  const walk = (value) => {
    if (typeof value === 'string') found.push(value);
    else if (Array.isArray(value)) for (const one of value) walk(one);
    else if (value != null && typeof value === 'object') for (const one of Object.values(value)) walk(one);
  };
  walk(graph);
  return found;
}

/** What the graph says about itself, at the level the rules would read it. */
export function inventory(graph) {
  const nodes = graph?.nodes ?? [];
  const metaKeys = new Set();
  const metaWithValues = new Set();
  const metaSpelling = {};
  const metricLabels = new Set();
  const metricKeys = new Set();
  for (const node of nodes) {
    for (const entry of node.meta_data ?? []) {
      metaKeys.add(entry.key);
      const { spelling, values } = valuesOf(entry);
      if (spelling != null) metaSpelling[entry.key] = spelling;
      if (values.some((value) => value.trim() !== '')) metaWithValues.add(entry.key);
    }
    for (const metric of node.metrics ?? []) {
      metricLabels.add(metric.label);
      if (metric.key != null && metric.key !== 'UNKNOWN_KEY') metricKeys.add(metric.key);
    }
  }
  const stages = graph?.stage_data ?? [];
  return {
    nodes: nodes.length,
    tags: [...new Set(nodes.map((node) => node.tag))].sort(),
    // How many operators carry each tag, not just which tags appear. `EXCESSIVE_EXCHANGES` counts exchanges,
    // and a distinct list cannot say whether a plan has one shuffle or six — which is the whole of what the
    // rule's threshold is about.
    tagCounts: Object.fromEntries(
      [...nodes.reduce((counts, node) => counts.set(node.tag, (counts.get(node.tag) ?? 0) + 1), new Map())].sort(
        ([a], [b]) => String(a).localeCompare(String(b))
      )
    ),
    nodeFields: [...new Set(nodes.flatMap((node) => Object.keys(node)))].sort(),
    metaKeys: [...metaKeys].sort(),
    metaKeysWithValues: [...metaWithValues].sort(),
    metaKeysOutsideExtract: [...metaKeys].filter((key) => !EXTRACTED_META.includes(key)).sort(),
    // Which of the two spellings each key came back under. The extract's parser reads only `values`, so this
    // is the list that says which of the keys it promises it can never populate.
    metaSpelling: Object.fromEntries(Object.entries(metaSpelling).sort(([a], [b]) => a.localeCompare(b))),
    metricLabels: [...metricLabels].sort(),
    metricKeys: [...metricKeys].sort(),
    edges: graph?.edges?.length ?? 0,
    stages: stages.length,
    stageFields: [...new Set(stages.flatMap((stage) => Object.keys(stage)))].sort(),
    // Stage-level task counts are the closest thing to a task distribution the response is known to carry.
    // Reported as the numbers themselves: what a skew rule needs is a spread, and one number per stage is
    // not one, so the recording has to show what is actually there rather than that a field exists.
    stageTasks: stages.map((stage) => ({
      tasks: stage.num_tasks ?? null,
      failed: stage.num_failed_tasks ?? null,
      spilledBytes: stage.disk_bytes_spilled ?? null,
      runMs: stage.executor_run_time_ms ?? null,
      name: typeof stage.name === 'string' ? stage.name.slice(0, 60) : null,
    })),
    insightIds: [...new Set(nodes.flatMap((node) => node.insight_ids ?? []))],
  };
}

/**
 * The operators each rule would read, with the values beside them.
 *
 * The inventory above answers "does the field exist", and that turned out to be the wrong question twice
 * over. A metric *label* mentioning skew is present on every probe including the ones with no skew in them,
 * so what a rule reads is the value; and the join algorithm is not where the plan document's table says it
 * is. Both are only visible with the values in hand, so they are recorded here per operator.
 */
export function operators(graph) {
  const nodes = graph?.nodes ?? [];
  const metaOf = (node, wanted) =>
    Object.fromEntries(
      (node.meta_data ?? [])
        .filter((entry) => wanted.test(entry.key))
        .map((entry) => [entry.key, valuesOf(entry).values.map((value) => value.slice(0, 60))])
    );
  const metricsMatching = (node, look) =>
    (node.metrics ?? [])
      .filter((metric) => look.test(String(metric.label)))
      .map((metric) => ({ label: metric.label, value: metric.value, key: metric.key }));

  return {
    // Every skew-labelled metric with its value. A label present and zero is the ordinary case; the rule
    // needs to know which of these ever carries a number, and on which operator.
    skew: nodes.flatMap((node) => {
      const metrics = metricsMatching(node, /skew/i);
      return metrics.length === 0 ? [] : [{ tag: node.tag, name: node.name, metrics }];
    }),
    joins: nodes
      .filter((node) => /join/i.test(String(node.tag)))
      .map((node) => ({
        tag: node.tag,
        name: node.name,
        meta: metaOf(node, /^JOIN_/),
        keyMetrics: node.key_metrics ?? null,
      })),
    sorts: nodes
      .filter((node) => /sort/i.test(String(node.tag)) || /sort/i.test(String(node.name)))
      .map((node) => ({
        tag: node.tag,
        name: node.name,
        meta: metaOf(node, /SORT/),
        keyMetrics: node.key_metrics ?? null,
      })),
    udfs: nodes
      .filter((node) => /udf|python/i.test(`${String(node.tag)} ${String(node.name)}`))
      .map((node) => ({ tag: node.tag, name: node.name, keyMetrics: node.key_metrics ?? null })),
    // Anything that could carry a statistics signal, values included, because "estimated NDV" is a metric
    // about a shuffle and not a statement about whether the table has statistics.
    statistics: nodes.flatMap((node) => {
      const metrics = metricsMatching(node, RULES.MISSING_OR_STALE_STATS.look);
      const meta = metaOf(node, /STATISTIC|STALE|ROW_COUNT/);
      return metrics.length === 0 && Object.keys(meta).length === 0
        ? []
        : [{ tag: node.tag, metrics, meta }];
    }),
  };
}

/** Per rule, what this probe's response said about the fields it reads. */
export function tells(graph) {
  const all = strings(graph);
  const answer = {};
  for (const [rule, { look }] of Object.entries(RULES)) {
    const hits = [...new Set(all.filter((value) => look.test(value)))];
    answer[rule] = { matched: hits.length, samples: hits.slice(0, 8).map((hit) => hit.slice(0, 90)) };
  }
  return answer;
}

/**
 * The probes, one per plan feature the six rules fire on.
 *
 * Small on purpose: each reads a bounded slice of a system table, and what is being measured is the shape of
 * the response rather than the size of the workload. A probe that has to be large to produce its operator
 * says so in its comment.
 */
const PROBES = [
  {
    id: 'join-and-sort',
    of: ['BROADCAST_CANDIDATE', 'LARGE_SORT', 'EXCESSIVE_EXCHANGES'],
    // A wide table joined to a handful of literal rows: the small side is broadcastable by any planner, so
    // if the response ever names a build side it names one here.
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
    of: ['LARGE_SORT'],
    // A sort whose result is aggregated rather than limited, so nothing downstream reduces it. This is the
    // case the rule's "no obvious limiting reduction" clause is about, and it needs the graph's edges to
    // tell it from the probe above.
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
    of: ['EXCESSIVE_EXCHANGES', 'DATA_SKEW'],
    // Several grouping stages over a skewed key. `statement_type` is heavily unbalanced on any estate, so if
    // stage-level or task-level numbers can show a spread, they can show one here.
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
  {
    id: 'unanalysed-scan',
    of: ['MISSING_OR_STALE_STATS'],
    // A scan of a table this app never analyses, joined and grouped rather than counted.
    //
    // The first version was `SELECT count(*) … WHERE …`, and it came back with no `plans` field at all — so
    // the recording said "no statistics signal" about the one rule it was built for, from a probe that had
    // no plan to look in, and the write-up read that as a fact about the platform. A statement whose whole
    // result is one number gives the planner nothing to describe. This one forces a join and two aggregates,
    // so a graph exists to be absent of statistics.
    statement: String.raw`
      WITH events AS (
        SELECT service_name, action_name, count(*) AS calls
        FROM system.access.audit
        WHERE event_date >= current_date() - 2
        GROUP BY 1, 2
      ),
      services AS (SELECT service_name, sum(calls) AS calls FROM events GROUP BY 1)
      SELECT events.service_name, events.action_name, events.calls, services.calls AS service_calls
      FROM events JOIN services USING (service_name)
      ORDER BY events.calls DESC
      LIMIT 50`,
  },
];

/**
 * The UDF probe, separately because it writes.
 *
 * A Python UDF is the operator `UDF_OR_PYTHON_BOUNDARY` is about, and no estate runs one on request. It is
 * created in a scratch schema and dropped. Every step's refusal is recorded rather than thrown: an
 * unprobeable rule is a different finding from an unbuildable one.
 */
async function udfProbe() {
  const name = `${SCRATCH}.waf_plan_probe_udf`;
  const created = await run(
    `CREATE OR REPLACE FUNCTION ${name}(value STRING) RETURNS STRING LANGUAGE PYTHON AS $$
  return None if value is None else value.lower()
$$`
  );
  if (created.state !== 'SUCCEEDED') {
    return { id: 'python-udf', of: ['UDF_OR_PYTHON_BOUNDARY'], skipped: created.error ?? created.state };
  }
  // The drop runs whether the use succeeded, failed or was refused. It used to run only on the happy path,
  // so an HTTP failure anywhere in between left a function in someone else's schema — and the outcome of the
  // drop is recorded, because "it was dropped" is a claim this script can either check or not make.
  const statement = `SELECT ${name}(statement_type) AS lowered, count(*) AS runs
       FROM system.query.history
       WHERE start_time >= current_timestamp() - INTERVAL 2 DAYS
       GROUP BY 1`;
  let used = { statementId: null, state: 'NOT_ATTEMPTED', error: null, rows: [] };
  try {
    used = await run(uncached(statement));
  } finally {
    const dropped = await run(`DROP FUNCTION IF EXISTS ${name}`);
    used = { ...used, droppedState: dropped.state, droppedError: dropped.error };
    console.log(`  dropped ${name}: ${String(dropped.state)}${dropped.error == null ? '' : ` — ${dropped.error}`}`);
  }
  return { id: 'python-udf', of: ['UDF_OR_PYTHON_BOUNDARY'], statement, ...used };
}

/**
 * Waits for the plan to exist, and reports how long it took.
 *
 * The first run of this script measured four rules as having no tell in the response, from four statements
 * whose `plans_state` was `EMPTY` — the plan is written asynchronously and is not there the moment the
 * statement finishes. A probe that fetches immediately measures the delay, not the platform, and reads as a
 * finding about the fields. `33ma` already treats `EMPTY` as no plan rather than as an error, which is right;
 * what this adds is that a statement's own plan is not immediately readable, so the wait belongs to the
 * apparatus and not to the app.
 */
async function awaitPlan(statementId) {
  const startedAt = Date.now();
  let state = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const response = await fetchText(`/api/2.0/sql/history/queries/${statementId}?include_plans=true`);
    if (response.status !== 200) {
      return { waitedMs: Date.now() - startedAt, status: response.status, plansState: state };
    }
    const body = JSON.parse(response.text);
    state = body.plans_state ?? null;
    // Gated on a graph rather than on `plans_state`, because `33j` measured that `EXISTS` is not a claim
    // about the body: a response carries that state and no `plans` field. Waiting on the state returns the
    // moment the platform sets it, which on such a response is immediately, and the probe then records an
    // absence of fields as a finding about the fields. Waiting on a node cannot make that mistake.
    const widest = widestGraph(body);
    if (widest.nodes > 0) return { waitedMs: Date.now() - startedAt, plansState: state, nodes: widest.nodes };
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  // The last state observed, not a literal. Writing `EMPTY` here reported a value the run never saw, and
  // `IGNORED_LARGE_PLANS` and `UNKNOWN` both reach this line.
  return { waitedMs: Date.now() - startedAt, plansState: state, nodes: 0, timedOut: true };
}

/**
 * The same statement at two rungs, because where a field lives decides what it costs to read.
 *
 * Only the cheaper rung is inspected. The debug rung was inspected too in the first pass, and its inventory,
 * tells and operators came back byte-identical on every probe while its bytes were 40% to 66% larger: the
 * extra payload lives outside `plans`, and everything measured here is computed from the graph. Recording it
 * twice made half the file a duplicate and implied the two rungs had been compared on the fields, which they
 * had not been. What the debug rung is for is its size, so its size is what it contributes.
 */
async function atRungs(statementId) {
  const rungs = { awaited: await awaitPlan(statementId) };
  for (const [rung, query] of Object.entries({
    include_plans: '?include_plans=true',
    'include_plans+debug_info': '?include_plans=true&include_debug_info=true',
  })) {
    const response = await fetchText(`/api/2.0/sql/history/queries/${statementId}${query}`);
    if (response.status !== 200) {
      rungs[rung] = { status: response.status, bytes: response.text.length };
      continue;
    }
    const body = JSON.parse(response.text);
    if (rung !== 'include_plans') {
      rungs[rung] = { status: response.status, bytes: response.text.length, plansState: body.plans_state ?? null };
      continue;
    }
    const chosen = widestGraph(body);
    rungs[rung] = {
      status: response.status,
      bytes: response.text.length,
      plansState: body.plans_state ?? null,
      bodyKeys: Object.keys(body).sort(),
      // The statement's own result size, beside the operator counts, so that a sentence about "a query
      // returning n rows" has a field to rest on. `key_metrics.rows_num` is an operator's output and was
      // read as the query's result once already.
      rowsProduced: body.rows_produced ?? null,
      widest: { index: chosen.index, nodes: chosen.nodes, unparsable: chosen.unparsable, candidates: chosen.candidates },
      inventory: inventory(chosen.graph),
      tells: tells(chosen.graph),
      operators: operators(chosen.graph),
    };
  }
  return rungs;
}

/**
 * A comment nobody reads except the result cache.
 *
 * Two runs of this script an hour apart measured the same probe as having a plan and as having none, and the
 * difference was the cache: the second execution of identical text is answered from the result cache, and a
 * cached execution has no plan to fetch — `plans_state` comes back `EMPTY`, not an error. So each probe is
 * made unique per run. This is a finding about the app as well as about the apparatus: a shape whose
 * representative execution was a cache hit is a shape with no plan, on a statement that succeeded.
 */
export function uncached(statement) {
  return `-- probe ${String(Date.now())}-${String(Math.round(Math.random() * 1e6))}\n${statement}`;
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, PROFILE, HOST);

  if (HOST === '' || WAREHOUSE === '') throw new Error('set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID');

  const probes = [];
  for (const probe of [...PROBES.map((one) => ({ ...one, statement: uncached(one.statement) })), await udfProbe()]) {
    if (probe.skipped != null) {
      console.log(`\n${probe.id}: skipped — ${String(probe.skipped).slice(0, 200)}`);
      probes.push({ id: probe.id, of: probe.of, skipped: String(probe.skipped).slice(0, 400) });
      continue;
    }
    const executed = probe.statementId != null ? probe : await run(probe.statement);
    if (executed.state !== 'SUCCEEDED' || executed.statementId == null) {
      console.log(`\n${probe.id}: failed — ${String(executed.error ?? executed.state).slice(0, 200)}`);
      probes.push({ id: probe.id, of: probe.of, failed: String(executed.error ?? executed.state).slice(0, 400) });
      continue;
    }

    const rungs = await atRungs(executed.statementId);
    const plans = rungs.include_plans;
    console.log(`\n${probe.id} (${probe.of.join(', ')}) — ${String(plans?.widest?.nodes ?? 0)} operators`);
    if (plans?.inventory != null) {
      console.log(`  edges: ${String(plans.inventory.edges)}  stages: ${String(plans.inventory.stages)}`);
      console.log(`  meta keys with values: ${plans.inventory.metaKeysWithValues.join(', ') || '(none)'}`);
      for (const [rule, tell] of Object.entries(plans.tells)) {
        if (!probe.of.includes(rule) && tell.matched === 0) continue;
        console.log(`  ${rule.padEnd(24)} ${String(tell.matched)} matches  ${tell.samples.slice(0, 2).join(' | ')}`);
      }
      const seen = plans.operators;
      const skewed = seen.skew.flatMap((one) => one.metrics).filter((metric) => Number(metric.value) > 0);
      console.log(
        `  operators: ${String(seen.joins.length)} join, ${String(seen.sorts.length)} sort, ${String(seen.udfs.length)} udf; ` +
          `skew metrics above zero: ${String(skewed.length)}${skewed.length === 0 ? '' : ` (${skewed.map((m) => `${String(m.label)}=${String(m.value)}`).slice(0, 3).join(', ')})`}`
      );
      for (const join of seen.joins.slice(0, 3)) {
        console.log(`    join ${String(join.tag)} name=${String(join.name)} meta=${JSON.stringify(join.meta)}`);
      }
    }
    // The statement beside its measurements. A `statementId` only resolves inside the workspace that ran it,
    // so without the text a reader cannot confirm that a recorded plan belongs to the probe it is filed
    // under — and every claim in the write-up rests on the probes being the purpose-built ones above.
    probes.push({
      id: probe.id,
      of: probe.of,
      statementId: executed.statementId,
      statement: probe.statement.replace(/^\s*-- probe [^\n]*\n/, '').trim(),
      rungs,
    });
    write(probes);
  }

  write(probes);
  console.log(`\nwrote ${OUT_FILE}`);
}

/**
 * Writes what has been measured so far.
 *
 * Called after every probe rather than once at the end, because a run is fifteen minutes and one throw in the
 * last probe used to discard the four before it. A partial recording is a partial recording; nothing is a
 * fifteen-minute repeat.
 */
export function write(probes) {
  // The label vocabulary once rather than per probe. Six hundred labels repeated five times is four fifths
  // of the file and none of the findings: what a rule reads is a named label's value, and the union says
  // which names exist to be read. The per-plan count stays, because the union is not a per-plan number and
  // was quoted as one.
  const metricLabels = [
    ...new Set(
      probes.flatMap((probe) =>
        Object.values(probe.rungs ?? {}).flatMap((rung) => rung?.inventory?.metricLabels ?? [])
      )
    ),
  ].sort();
  // Copied rather than edited in place. Deleting the labels from the probes themselves worked when this ran
  // once at the end and would have emptied the union on the second call now that it runs after every probe.
  const written = probes.map((probe) => ({
    ...probe,
    rungs:
      probe.rungs == null
        ? probe.rungs
        : Object.fromEntries(
            Object.entries(probe.rungs).map(([rung, measured]) => {
              if (measured?.inventory == null) return [rung, measured];
              const { metricLabels: labels, ...inventoryRest } = measured.inventory;
              return [rung, { ...measured, inventory: { ...inventoryRest, metricLabelCount: labels.length } }];
            })
          ),
  }));

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(
    OUT_FILE,
    `${JSON.stringify(
      {
        runFinishedAt: new Date().toISOString(),
        profile: PROFILE,
        extractedMetaKeys: EXTRACTED_META,
        metricLabels,
        // `String(look)` rather than `look.source`, so the recorded tell reproduces the match that produced
        // the counts. The flags were dropped before, and every one of these is case-insensitive.
        rules: Object.fromEntries(
          Object.entries(RULES).map(([rule, { look, needs }]) => [rule, { tell: String(look), needs }])
        ),
        probes: written,
      },
      null,
      2
    )}\n`
  );
}

if (process.argv[1] != null && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
