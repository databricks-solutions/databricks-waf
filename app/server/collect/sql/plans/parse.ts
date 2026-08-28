/**
 * Reads an operator plan out of a Query History response, and says so when it cannot.
 *
 * The advisor document asks for a versioned parser tested against captured responses rather than against a
 * live workspace, because "the exact JSON response shape can vary across query-history service versions and
 * workload types". `fixtures/` holds those captures and `parse.test.ts` runs everything here against them.
 *
 * Three things measured before this was written decide its shape, and each is a case a straightforward
 * reading of the document gets wrong:
 *
 * **`plans` is a variable number of entries, one of which is the plan.** `33b` recorded fourteen entries
 * keyed `0`..`13` on one statement and a later capture had thirteen, of which one carried 335 nodes and the
 * rest zero or one. So the count is not part of the contract, the index of the real plan is undocumented,
 * and a parser that reads `plans['0']` or concatenates every entry is wrong in two different ways.
 * `selectGraph` picks the widest.
 *
 * **`plans_state` is not a statement about the response in hand.** The `include_metrics` rung returns
 * `plans_state: "EXISTS"` and no `plans` field at all — the capture in `fixtures/metrics-only.json` is that
 * response. So `EXISTS` cannot be read as "a plan is in this body", and `available` here means a graph was
 * found, not that the platform said one exists.
 *
 * **Absence has two spellings and one of them is `0`.** Of 123 operators on the statement `33b` measured,
 * 103 carried metrics, 17 had no `key_metrics` field, and 3 had one whose values were all zero. The document
 * asks that rules never claim a metric that was absent, so `keyMetrics` is reproduced as found — `undefined`
 * when the field was missing, zeros when they were zeros — and never defaulted. Collapsing the two is a
 * claim that an uninstrumented operator emitted nothing.
 */

import { createHash } from 'node:crypto';

/**
 * Bumped when a change here would produce a different extract from the same response.
 *
 * The document asks for this at line 1494, on the reasoning that a finding which cannot say which parser
 * version produced it cannot be compared with the same finding next month. It sits beside the advisor's
 * `rulesVersion` and `rankingVersion`, which already exist.
 *
 * `2` because `33ih` changed what the same response produces: five of the six promised keys came out empty
 * before it and carry their value after, so an extract stored by `1` cannot be compared with one stored now.
 * `3` because `33ic` added three fields — the graph's edges, `SORT_ORDER`, and the named metrics — and an
 * extract stored by `2` is silent about all three for a reason that is not the plan's.
 */
export const PARSER_VERSION = 'plan-parser-3';

/**
 * The `meta_data` keys the rules read, measured present with values on a real workspace by `33ia` and `33ii`.
 *
 * Kept as a list rather than read wholesale because a response carries twenty-odd keys per operator and
 * `OUTPUT` alone was 22 KB of one capture. Selecting is what made the extract 148x smaller than the response,
 * which is the measurement that decided the extract is persisted and the response is not. That multiple was
 * measured under `plan-parser-1` on `33b`'s statement and is an upper bound on this reader's: the scalar keys
 * carry their values since `33ih`, which grew the extract 5.6% on the committed capture, and `33ic`'s three
 * additions grew it a further 56% to 65% on `33ii`'s three plans, where the same ratio was 58x to 67x. The
 * decision survives every one of those numbers by more than an order of magnitude, which is why it is not
 * re-measured here.
 *
 * Most spell their content `value` and `SCAN_PARTITIONS` and `SORT_ORDER` spell it `values`, which is what
 * `metaValues` is for. `parse.test.ts` holds each key to a value from a committed capture rather than to its
 * presence, because asserting presence is what let five of them sit empty from `33j` landing this file to
 * `33ih` — one PR, only because `33ia` measured the plan next. Nothing yet reads these keys, so the cost was
 * the write-up `33ia` had to withdraw; a rule shipped in between would have reported every join as having no
 * build side.
 *
 * `SORT_ORDER` is on the list for `33ie`, and `33ii` measured the thing that makes it worth having: on an
 * `ORDER BY … LIMIT` the key is declared by a top-k operator, in a plan with nothing tagged as a sort at all.
 * So a rule selecting sorts by tag misses the case its own "no limiting reduction" clause is about, and the
 * extract keeps the key on whichever operator declared it rather than filtering by tag on the way in.
 */
export const PROMISED_META_KEYS = [
  'SCAN_IDENTIFIER',
  'JOIN_ALGORITHM',
  'JOIN_BUILD_SIDE',
  'PARTITIONING_TYPE',
  'IS_PHOTON',
  'SCAN_PARTITIONS',
  'SORT_ORDER',
] as const;

export type PromisedMetaKey = (typeof PROMISED_META_KEYS)[number];

/**
 * The metrics kept by name, and why the name is a display label.
 *
 * `33ia` measured the whole vocabulary — `labs-plan-rule-inputs.json`, 812 distinct labels across five probes
 * — and found exactly five distinct `metric.key` values: `CUMULATIVE_TIME`, `DURATION`, `EXCLUSIVE_TIME`,
 * `NUMBER_OUTPUT_ROWS` and `PEAK_MEMORY_USAGE`, with everything else keyed `UNKNOWN_KEY`. Those five are the
 * three `key_metrics` fields this file already keeps plus two times. So there is no stable identifier for a
 * skew ratio or a build-side size, and a rule that wants one selects on the label — which is text a service
 * upgrade may reword. That is a fragility this list inherits and cannot design away; what it can do is fail
 * visibly, and the assertion that makes it fail is in `parse.test.ts`: the labels the two graph captures carry
 * between them are held equal to this list, in both directions. A rewording drops the label from one side and
 * fails, where "some label matched" would not — that direction was the first thing written here and it could
 * not see the thing it was said to catch. `measure-plan-rule-inputs.test.ts` holds every name here against the
 * 812 the vocabulary carried, so a name that never existed fails too.
 *
 * Eighteen rather than the nine that `33ii` found carrying a value on any of its three probes, because `33id`'s
 * job is to measure thresholds from the retained corpus and it can only measure what was kept. Dropping the
 * nine that read zero on three small probes would decide from three probes what `33id` exists to decide from an
 * estate: the spill metrics in particular are zero because nothing spilled, which is a fact about the probes.
 *
 * The cost is measured, not assumed: keeping them grew the extract by 31% to 44% on `33ii`'s three plans,
 * against a response 58 to 67 times the extract's size. `33id` may shorten this list once it has measured which
 * of them carry a signal on a real estate.
 */
export const NAMED_METRICS = [
  // DATA_SKEW. `33ii` measured the max-to-median ratio carrying a value on all three probes, none of which had
  // skew designed into them, while the skewed-partition count and the skewed-size ratio read zero on all three.
  // So those two are the candidate signal and the max-to-median ratio is kept to be ruled out by `33id` rather
  // than thresholded.
  'MapStage - Skew max to non-empty median ratio',
  'MapStage - Skew num skewed partitions',
  'MapStage - Skew skewed data size ratio',
  'MapStage - Skew non-empty median partition size',
  'MapStage - Skew num empty partitions',
  'AQEShuffleRead - Skew handled by',
  // EXCESSIVE_EXCHANGES.
  'AQEShuffleRead - Number of partitions',
  'AQEShuffleRead - Number of coalesced partitions',
  'MapStage - Number of output rows',
  // LARGE_SORT.
  'Max batch size (rows) produced in the sort node',
  'Max column batch size (bytes) sort spilled',
  'Num bytes spilled to disk due to memory pressure',
  // BROADCAST_CANDIDATE. The first carried 4,325,376 on the broadcast joins of two of `33ii`'s probes.
  'Hashed relation size',
  'Aggressive BHJ Extrapolated Size',
  'Aggressive BHJ Decision',
  // MISSING_OR_STALE_STATS.
  'MapStage - EnsureRequirementsDP estimated NDV',
  'Scan - Size of a row of all columns in the relation (estimated)',
  'Scan - Size of a row of scanned columns (estimated)',
] as const;

/**
 * One of the labels above, as a type.
 *
 * So that a rule naming a metric names one of these and a misspelling is a compile error rather than a rule
 * that reads `undefined` and never fires. That failure has a precedent in this repository — `bounds.ts`
 * justified a silent skip by pointing at a test that could not see the thing it was said to catch — and a
 * label is exactly the shape of thing it happens to: 34 characters of prose with a hyphen in it, where a
 * lookup against the wrong one is indistinguishable from a plan that carried nothing.
 */
export type NamedMetricLabel = (typeof NAMED_METRICS)[number];

/**
 * Per promised key, the parser versions whose silence about it is the parser's and not the plan's.
 *
 * `plan-parser-1` stored `[]` for five of the six keys it promised, because it read the wrong one of the two
 * spellings a `meta_data` entry takes. So an extract stored under it has an empty `JOIN_BUILD_SIDE` for a
 * reason that is not the platform's, and a rule reading that array cannot tell "the plan named no side" from
 * "the parser could not see the side it named". `SORT_ORDER` was not selected at all until `plan-parser-3`, so
 * for that key both earlier versions are silent the same way.
 *
 * Per key rather than per extract, because the two facts are different: an extract at version `2` can be
 * trusted about a join's build side and says nothing at all about a sort's order. A single answer for the
 * whole extract would have to be the stricter of the two, which would throw away every join `33ih` fixed.
 *
 * Deny-lists rather than comparisons, because the versions are opaque strings with no ordering to appeal to:
 * `'plan-parser-10' < 'plan-parser-2'` lexically, so a rule written as "newer than 1" would silently start
 * distrusting everything at version 10.
 *
 * Exported here rather than only described in the phase document, because the consequence of forgetting it is
 * a finding that reports an absent build side that was never absent — and a requirement living in the prose of
 * a phase nobody has started is a requirement the rule's author has to have read.
 */
export const META_UNREADABLE_PARSER_VERSIONS: Readonly<Record<PromisedMetaKey, readonly string[]>> = {
  SCAN_IDENTIFIER: ['plan-parser-1'],
  JOIN_ALGORITHM: ['plan-parser-1'],
  JOIN_BUILD_SIDE: ['plan-parser-1'],
  PARTITIONING_TYPE: ['plan-parser-1'],
  IS_PHOTON: ['plan-parser-1'],
  // The one list-shaped key of the original six, so `plan-parser-1` read it correctly by accident.
  SCAN_PARTITIONS: [],
  SORT_ORDER: ['plan-parser-1', 'plan-parser-2'],
};

/**
 * Whether an extract's silence about one promised key means the plan was silent.
 *
 * A rule that reads a key by name calls this first and says nothing when it answers false. Absence is not the
 * same as a parser that could not look.
 */
export function metaIsReadable(extract: Pick<PlanExtract, 'parserVersion'>, key: PromisedMetaKey): boolean {
  return !META_UNREADABLE_PARSER_VERSIONS[key].includes(extract.parserVersion);
}

/**
 * Parser versions that kept no named metrics, so an operator without them is not an operator without metrics.
 *
 * The same shape of gate as the meta one and a separate list, because a version could add one addition without
 * the other — `33ic` added both at once and a future one need not.
 *
 * `edges` needs no list of its own: it is absent from an extract stored before `plan-parser-3` and present,
 * possibly empty, on every extract stored since. So `extract.edges == null` already answers "an older parser
 * wrote this" and `[]` answers "the plan had no edges", which is the distinction a version list exists to
 * recover. That rests on two things `parse.test.ts` holds, because neither is self-evident: `extractPlan`
 * setting the field unconditionally, and the field being declared optional so a reader has to ask. A
 * non-optional declaration would make the `== null` branch unreachable to the type checker while the value it
 * tests for is exactly what a retained row from `plan-parser-2` revives as — `plan-store.ts` casts.
 */
export const NAMED_METRICS_UNREADABLE_PARSER_VERSIONS: readonly string[] = ['plan-parser-1', 'plan-parser-2'];

/** Whether an operator's absent `named` means the plan carried none of them. */
export function namedMetricsAreReadable(extract: Pick<PlanExtract, 'parserVersion'>): boolean {
  return !NAMED_METRICS_UNREADABLE_PARSER_VERSIONS.includes(extract.parserVersion);
}

/**
 * Why no graph came back, when the platform did not say a plan was absent.
 *
 * Two values rather than one because they need different reading: a missing `plans` field means the rung
 * asked for did not carry plans, and an unparsable one means it did and this parser could not read it. The
 * first is a request the app controls; the second is the platform-upgrade case the fixtures exist for.
 */
export type NoGraphReason = 'plans-field-absent' | 'no-parsable-graph';

/**
 * What a response meant.
 *
 * `no-plan` and `not-retrievable` are separate because only the first is knowledge, which `33k` measured:
 * `200` with `plans_state: EMPTY` is the platform reporting that no plan was produced, and a `404` is the
 * platform having no plan record *for this workspace* — mostly a statement that ran in another workspace
 * sharing the metastore. Whether a plan exists is not in a 404, so nothing built on one may say a plan was
 * absent.
 */
export type PlanOutcome =
  | 'available'
  | 'no-plan'
  | 'no-graph'
  | 'not-retrievable'
  | 'error'
  | 'unknown-state';

/** Metrics exactly as found. Absent stays absent; zeros stay zeros. */
export interface KeyMetrics {
  readonly duration_ms?: number;
  readonly rows_num?: number;
  readonly peak_memory_bytes?: number;
}

export interface PlanOperator {
  readonly id: string;
  readonly tag: string;
  readonly meta?: Readonly<Partial<Record<PromisedMetaKey, readonly string[]>>>;
  /** Absent when the operator carried no `key_metrics` field. Never defaulted — see the header. */
  readonly keyMetrics?: KeyMetrics;
  /**
   * The metrics of `NAMED_METRICS` this operator carried, by label. Absent when it carried none of them,
   * which `namedMetricsAreReadable` is how a rule tells from an extract that predates them.
   */
  readonly named?: Readonly<Record<string, number>>;
}

/**
 * One edge of the operator graph, pointing at the operator whose output the other consumes.
 *
 * `33ii` measured the direction rather than assuming it, and `parse.test.ts` holds it against the `sorted-plan`
 * capture: from either sort in it, following `to` reaches a file scan and following `from` reaches the result
 * stage — a leaf one way and the root the other. So `from` consumes and `to` produces, and a rule asking what
 * happens *after* an operator follows `to`-to-`from`, which is the direction a reader of the field names would
 * not guess. Asserted rather than only recorded because it decides the walk `33ie` writes, and a walk that read
 * the arrow as dataflow would look for a sort's limiting reduction among the sort's own inputs.
 *
 * Renamed from the response's `from_id`/`to_id` for the reason every other field here is renamed: the extract
 * is this app's shape and `operators` already carries `id` rather than `node_id`.
 */
export interface PlanEdge {
  readonly from: string;
  readonly to: string;
}

export interface PlanExtract {
  readonly parserVersion: string;
  readonly fingerprint: string;
  readonly operatorCount: number;
  readonly operators: readonly PlanOperator[];
  /** Operators with no `key_metrics` field at all, which is not the same as three zeros. */
  readonly operatorsWithoutMetrics: number;
  /** Operators whose `key_metrics` were present and all zero. */
  readonly operatorsWithZeroMetrics: number;
  /**
   * The graph's edges, as found. Empty means the plan carried none; absent means an older parser wrote this
   * extract, which is why it has no entry in a version deny-list.
   *
   * Optional for that second reading rather than because `extractPlan` might not set it — it always does. A
   * retained row written by `plan-parser-2` is revived by a cast in `plan-store.ts`, so the value a rule gets
   * is `undefined` whatever the declaration says, and a non-optional one would hide that from the reader who
   * has to handle it.
   */
  readonly edges?: readonly PlanEdge[];
  /**
   * Edges this extract could not resolve to two of its own operators — absent, unreadable or unknown endpoint
   * alike. Absent for the same reason `edges` is.
   *
   * Every edge of all three plans `33ii` measured resolved, with no coercion needed. Counted rather than
   * trusted, because a walk that follows an id nothing answers to is the failure a rule would report as
   * "nothing follows this sort". The three causes are not counted apart because no rule distinguishes them:
   * each one means the same thing to a walk, which is that this edge leads nowhere.
   */
  readonly edgesWithUnknownEndpoint?: number;
}

export interface SelectedGraph {
  readonly index: string | null;
  readonly graph: PlanGraph | null;
  readonly nodes: number;
  /** Entries in `plans`. Recorded because it varies by statement and is not part of the contract. */
  readonly entries: number;
}

export interface PlanGraph {
  readonly nodes?: readonly PlanGraphNode[];
  readonly edges?: readonly PlanGraphEdge[];
  readonly source?: string;
}

/**
 * An edge as the response spells it, measured by `33ii` on three plans: these two fields and no others,
 * both strings.
 *
 * Typed as `unknown` on the way in for the reason `metaValues` gives about `value`: the declaration is a
 * description of a response nothing validates, and an id that arrived as a number and was stored as one would
 * never match an operator's `id`, which this file already coerces.
 */
export interface PlanGraphEdge {
  readonly from_id?: unknown;
  readonly to_id?: unknown;
}

/**
 * A `meta_data` entry, in both the shapes the platform uses.
 *
 * Declaring only `values` is how this parser came to store five of its six promised keys as empty arrays on
 * every plan it read — see `metaValues` below. Both are optional because an entry uses one or the other,
 * never both.
 */
export interface PlanMetaEntry {
  readonly key?: string;
  readonly label?: string;
  readonly value?: string;
  readonly values?: readonly string[];
}

export interface PlanGraphNode {
  readonly id?: string | number;
  readonly tag?: string;
  readonly meta_data?: readonly PlanMetaEntry[];
  readonly key_metrics?: KeyMetrics | null;
  readonly metrics?: readonly PlanMetric[];
}

/** A metric as the response spells it. `key` is `UNKNOWN_KEY` on all but five of them — see `NAMED_METRICS`. */
export interface PlanMetric {
  readonly label?: string;
  readonly value?: unknown;
  readonly key?: string;
}

export interface PlanResponseBody {
  readonly plans_state?: string | null;
  readonly plans?: Readonly<Record<string, unknown>> | null;
}

export type ParsedPlan =
  | { readonly outcome: 'available'; readonly extract: PlanExtract; readonly selected: SelectedGraph }
  | { readonly outcome: 'no-graph'; readonly reason: NoGraphReason; readonly selected: SelectedGraph }
  | { readonly outcome: Exclude<PlanOutcome, 'available' | 'no-graph'> };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The widest graph in `plans`, tolerating both encodings and neither.
 *
 * Values arrive as objects on every statement measured; the document names JSON-as-a-string as a shape to
 * survive, so a string is parsed and a string that is not JSON is skipped rather than thrown on. Width is
 * the discriminator because the index that holds the plan is undocumented — a parser hard-coding `0` reports
 * a one-node plan the day the service reorders, with no test to say so.
 */
export function selectGraph(body: PlanResponseBody | null | undefined): SelectedGraph {
  const plans = body?.plans;
  if (!isRecord(plans)) return { index: null, graph: null, nodes: 0, entries: 0 };
  const entries = Object.entries(plans);
  let best: SelectedGraph = { index: null, graph: null, nodes: 0, entries: entries.length };
  for (const [index, value] of entries) {
    let graph: unknown = value;
    if (typeof graph === 'string') {
      try {
        graph = JSON.parse(graph);
      } catch {
        // A text plan, or an encoding this parser has not met. Skipped, not thrown on.
        continue;
      }
    }
    if (!isRecord(graph)) continue;
    const nodes = Array.isArray(graph.nodes) ? graph.nodes.length : 0;
    if (best.index === null || nodes > best.nodes) {
      best = { index, graph, nodes, entries: entries.length };
    }
  }
  return best;
}

/**
 * A fingerprint over the plan's operators, which `33b` made load-bearing rather than a refinement.
 *
 * Three of eight repeated shapes on labs produced more than one operator graph across three executions
 * minutes apart, so without this a shape whose plan changed reads as a shape that got slower.
 *
 * Tags rather than `name`, because `name` carries the scanned relation — `Scan system.access.table_lineage`
 * — and a fingerprint that moves when the table moves is the query-shape fingerprint computed twice. Sorted
 * rather than in graph order, because two executions differing only in the order the service serialised
 * sibling nodes are the same physical plan. Duplicates are kept: two hash joins are not one.
 */
export function planFingerprint(graph: PlanGraph | null | undefined): string {
  const tags = listOf(graph?.nodes)
    .map((node) => node?.tag ?? '(untagged)')
    .sort();
  return createHash('sha256').update(tags.join('|')).digest('hex').slice(0, 16);
}

/**
 * A `meta_data` entry's content, whichever of the two fields it came back in.
 *
 * The shape is fixed per key and splits along what the key holds. A scalar — `JOIN_ALGORITHM`,
 * `JOIN_BUILD_SIDE`, `SCAN_IDENTIFIER`, `PARTITIONING_TYPE`, `IS_PHOTON` — arrives as `{key, label, value}`.
 * A list of expressions — `SCAN_PARTITIONS`, `SORT_ORDER`, `FILTERS`, `LEFT_KEYS` — arrives as
 * `{key, label, values, meta_values}`.
 *
 * This read `entry.values ?? []`, so five of the six keys it promises were stored as `[]` on every plan and
 * only `SCAN_PARTITIONS`, the one list-shaped key of the six, ever carried anything. `33ia` measured it, after
 * its own probe made the same mistake and reported the platform as returning empty joins. Nothing read the
 * keys yet, so no finding was ever wrong in front of a user; the rule that reads them is `33ifc`.
 *
 * Answered as an array either way, because a caller that has to ask which spelling it got is the same defect
 * one layer up.
 *
 * Two decisions a caller can rely on. `value` wins over `values`, which is safe only because no entry carries
 * both — asserted over the captures in `parse.test.ts` rather than stated here, since it is the precondition
 * the precedence rests on. And an empty `value` is answered as `['']`, not `[]`: the file reproduces what it
 * found, as it does for `keyMetrics`. So "the key carried something" is not the same question as "the key was
 * present", and a rule that renders a value to a reader tests the value.
 */
export function metaValues(entry: PlanMetaEntry): readonly string[] {
  // Coerced, and guarded on the array. The type says `value` is a string and `values` is an array, and the
  // type is a description of a response nothing validates — the header's reason for not throwing on an
  // unfamiliar encoding is the same reason for not trusting one. A numeric `value` put through unchanged
  // would sit in a `readonly string[]`, be persisted as one, and be compared against a string by a rule.
  //
  // `String` on a list element turns a null into `'null'` and an object into `'[object Object]'`, which is a
  // token a reader could be shown. Left as-is rather than filtered, because no element in any capture is a
  // non-string, so a filter would be a guess about a shape nobody has seen — and a rule rendering
  // `'[object Object]'` is a visible defect, while one rendering a silently shortened list is not.
  if (entry.value != null) return [String(entry.value)];
  return Array.isArray(entry.values) ? entry.values.map(String) : [];
}

function allZero(metrics: KeyMetrics): boolean {
  const values = [metrics.duration_ms, metrics.rows_num, metrics.peak_memory_bytes].filter(
    (value): value is number => typeof value === 'number',
  );
  return values.length > 0 && values.every((value) => value === 0);
}

/**
 * The named metrics this operator carried, or nothing.
 *
 * Only finite numbers, for the reason `plan-metrics.ts` gives about `key_metrics`: the declaration says
 * `number` and describes a response nothing validates, and a string or a NaN reaching a `Finding`'s
 * `value: number` would be rendered to a reader as evidence. A label present with an unreadable value is
 * therefore dropped rather than kept as-is — the one place this file does not reproduce what it found, because
 * the alternative is a rule that cannot tell a number from the word "unknown".
 *
 * A zero is kept. `33ii` measured that the metrics which read zero where there is nothing to report are the
 * ones a rule can use, so collapsing zero into absence would throw away the signal.
 */
function namedMetricsOf(node: PlanGraphNode): Record<string, number> | undefined {
  const named: Record<string, number> = {};
  for (const metric of listOf(node.metrics)) {
    const label = metric?.label;
    if (label == null || !(NAMED_METRICS as readonly string[]).includes(label)) continue;
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    named[label] = metric.value;
  }
  return Object.keys(named).length > 0 ? named : undefined;
}

/**
 * A response field declared as a list, as a list.
 *
 * Four fields this file walks — `nodes`, `edges`, `meta_data`, `metrics` — are arrays in every capture and are
 * declared as arrays, and the declaration describes a response nothing validates. `for…of` over an object
 * throws, which the header of this file rules out: a parser that throws on an encoding it has not seen takes a
 * scan down for a platform upgrade, and the fixtures exist because that upgrade is expected rather than
 * hypothetical. `selectGraph` guards `nodes` this way already, which is why nothing had noticed that
 * `extractPlan` and `planFingerprint` did not — they are reachable without it, and a test calls them that way.
 */
function listOf<T>(value: readonly T[] | undefined): readonly T[] {
  // Not `Array.isArray`, which narrows a `readonly T[]` to `any[]` and hands every caller an unchecked value
  // back. What is being tested is the runtime shape of something the type already claims is a list.
  return value instanceof Array ? value : [];
}

/**
 * One endpoint, as an operator id, or nothing.
 *
 * A string and a number are the two shapes an id takes here — `operators` coerces `node.id` the same way, and
 * `33ii` measured the response sending both fields as strings. Anything else answers nothing rather than being
 * coerced: `String` of an object is `'[object Object]'` and of a missing field is `'undefined'`, either of
 * which would sit in the extract looking like an id and match no operator, silently.
 */
function endpoint(value: unknown): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** The graph's edges, as the ids `operators` carries, and a count of the ones that named something else. */
function edgesOf(graph: PlanGraph | null | undefined, ids: ReadonlySet<string>): {
  readonly edges: readonly PlanEdge[];
  readonly unknown: number;
} {
  const edges: PlanEdge[] = [];
  let unknown = 0;
  for (const edge of listOf(graph?.edges)) {
    const from = endpoint(edge?.from_id);
    const to = endpoint(edge?.to_id);
    if (from == null || to == null || !ids.has(from) || !ids.has(to)) unknown += 1;
    else edges.push({ from, to });
  }
  return { edges, unknown };
}

/** The operators, their tags, the promised keys, the metrics as found, and the graph between them. */
export function extractPlan(graph: PlanGraph | null | undefined): PlanExtract {
  const operators: PlanOperator[] = [];
  let withoutMetrics = 0;
  let zeroMetrics = 0;

  for (const node of listOf(graph?.nodes)) {
    const meta: Partial<Record<PromisedMetaKey, readonly string[]>> = {};
    for (const entry of listOf(node.meta_data)) {
      const key = entry?.key;
      if (key != null && (PROMISED_META_KEYS as readonly string[]).includes(key)) {
        meta[key as PromisedMetaKey] = metaValues(entry);
      }
    }
    // `== null` rather than `=== undefined`: the field comes back null as well as missing, and counting
    // those two differently would be a distinction with no meaning behind it.
    const hasMetrics = node.key_metrics != null;
    if (!hasMetrics) withoutMetrics += 1;
    else if (allZero(node.key_metrics)) zeroMetrics += 1;
    const named = namedMetricsOf(node);

    operators.push({
      id: String(node.id ?? ''),
      tag: node.tag ?? '(untagged)',
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
      ...(hasMetrics ? { keyMetrics: node.key_metrics } : {}),
      ...(named == null ? {} : { named }),
    });
  }

  const { edges, unknown } = edgesOf(graph, new Set(operators.map((operator) => operator.id)));

  return {
    parserVersion: PARSER_VERSION,
    fingerprint: planFingerprint(graph),
    operatorCount: operators.length,
    operators,
    operatorsWithoutMetrics: withoutMetrics,
    operatorsWithZeroMetrics: zeroMetrics,
    edges,
    edgesWithUnknownEndpoint: unknown,
  };
}

/**
 * What the response was, before anything tries to read a plan out of it.
 *
 * Deliberately not a function of `plans_state` alone: the `metrics-only` capture reads `EXISTS` and carries
 * no plans, so `EXISTS` is a claim about the statement rather than about this body.
 *
 * Cannot return `no-graph`, and the type says so: deciding that needs the body's `plans` inspected, which is
 * `parsePlanResponse`'s job.
 */
export function interpretResponse(
  status: number,
  body: PlanResponseBody | null,
): Exclude<PlanOutcome, 'no-graph'> {
  if (status === 404) return 'not-retrievable';
  if (status !== 200) return 'error';
  const state = body?.plans_state;
  if (state === 'EMPTY') return 'no-plan';
  if (state !== 'EXISTS') return 'unknown-state';
  return 'available';
}

/**
 * The whole read: outcome first, extract only when a graph was actually found.
 *
 * Never throws on a response. A parser that throws on an encoding it has not seen takes a scan down for a
 * platform upgrade, and the fixtures exist because that upgrade is expected rather than hypothetical.
 */
export function parsePlanResponse(status: number, body: PlanResponseBody | null): ParsedPlan {
  const outcome = interpretResponse(status, body);
  if (outcome !== 'available') return { outcome };

  const selected = selectGraph(body);
  if (selected.graph === null || selected.nodes === 0) {
    const reason: NoGraphReason = isRecord(body?.plans) ? 'no-parsable-graph' : 'plans-field-absent';
    return { outcome: 'no-graph', reason, selected };
  }
  return { outcome: 'available', extract: extractPlan(selected.graph), selected };
}
