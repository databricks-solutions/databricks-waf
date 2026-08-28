// Reading a number off a plan operator without inventing one.
//
// The advisor document asks at line 1438 that *"Rules emit evidence and do not claim missing metrics"*. What
// that costs in code is this file, because absence has two spellings in this response and one of them is a
// number:
//
//   - `key_metrics` missing entirely — 17 of 123 operators on the statement `33b` measured, and the operator
//     was never instrumented.
//   - `key_metrics` present with `duration_ms`, `rows_num` and `peak_memory_bytes` all zero — 3 of the same
//     123, and 54 of 335 on a longer statement. Either the operator did nothing or nothing was recorded, and
//     the response does not distinguish them.
//
// The parser reproduces the field rather than defaulting it (`parse.ts`), which is what makes the distinction
// available here. `metric` answers `undefined` for the first spelling and `0` for the second, and a rule that
// wants to say "no time was spent" from a zero is then making that claim itself rather than inheriting it
// from a missing object.
//
// # Why not a default
//
// Because a default reads as a measurement. `?? 0` on a missing duration produces evidence saying "0 ms" on
// an operator nobody timed, a reader concludes the step is free, and nothing in the finding says otherwise.
// The alternative is longer at every call site and the calls are few.

import {
  metaIsReadable,
  namedMetricsAreReadable,
  type KeyMetrics,
  type NamedMetricLabel,
  type PlanExtract,
  type PlanOperator,
} from '../collect/sql/plans/parse.js';

/**
 * A tag with its underscores removed and folded to upper case, which is the only reliable way to match one.
 *
 * The response spells the same operator two ways — `PHOTON_SHUFFLE_MAP_STAGE_EXEC` and
 * `UNKNOWN.PhotonShuffleExchangeSink` — and the difference between them is *underscores*, not case, so a
 * case-insensitive pattern written for one does not match the other. `33id` had a pattern per spelling and
 * measured what that costs: deleting one as apparent duplication took a count from 63 to zero while every
 * reading still returned a number, because a group whose pattern matches nothing is indistinguishable from a
 * group with nothing in it. Normalising once removes the question.
 */
function spelled(tag: string): string {
  return tag.replace(/_/g, '').toUpperCase();
}

/**
 * The five spellings of a shuffle boundary, and what each one is worth.
 *
 * Two of them are halves of one boundary: `33ia` measured, and `33id` confirmed over 28 plans that carry an
 * exchange, that Photon renders a shuffle as `PHOTON_SHUFFLE_MAP_STAGE_EXEC` *and*
 * `UNKNOWN.PhotonShuffleExchangeSink` in equal numbers. Counting tags therefore doubles every Photon plan,
 * which on the design document's threshold of eight selects a plan whose boundary count is five.
 *
 * `SHUFFLE_EXCHANGE_EXEC` is whole. One operator in `33id`'s corpus carried it, on a `MERGE` whose Photon pair
 * sat beside it unpaired, which is the reading a single non-Photon exchange in a mixed plan supports. That it
 * generalises to a classic-compute plan, where it would be the only spelling present, is an **assumption** —
 * one observation is not a distribution — and it fails in the safe direction: a boundary counted whole where
 * it was half over-counts a plan the rule then reports, which is why `unrecognisedExchanges` exists and why
 * the evidence carries the operator count beside the boundary count.
 */
const BOUNDARY_TAGS: Readonly<Record<'mapStage' | 'sink' | 'queryStage' | 'reused' | 'whole', RegExp>> = {
  mapStage: /SHUFFLEMAPSTAGE/,
  // Before `whole`, and the order is load-bearing: a sink's tag contains `SHUFFLEEXCHANGE` too. `classify`
  // walks these in declaration order and `plan-metrics.test.ts` holds the sink against both patterns, so the
  // dependency is tested rather than left to whoever next reformats the literal.
  sink: /SHUFFLEEXCHANGESINK/,
  whole: /SHUFFLEEXCHANGEEXEC/,
  queryStage: /SHUFFLEQUERYSTAGE/,
  reused: /REUSEDEXCHANGE/,
};

/** Anything else naming itself an exchange: counted, never added to the boundary count. See below. */
const ANY_EXCHANGE = /EXCHANGE/;

/**
 * A sort operator, narrowed to the two spellings `33id` measured a sort tagged with.
 *
 * Not `/SORT/`, which matches `SortMergeJoin`, `PhotonShuffledSortMergeJoin` and `SortAggregate`. The design
 * document's line 1017 exists precisely because a sort-merge join is not evidence of anything, and a
 * `LARGE_SORT` finding on one would be the confident nonsense that instruction is about. Every one of the 14
 * sorts in `33id`'s corpus was `PHOTON_SORT_EXEC`; `SORTEXEC` also catches Spark's own `SortExec`.
 */
const SORT_TAG = /SORTEXEC/;

/**
 * What ends a sort's usefulness, and what a top-k already is.
 *
 * A top-k *is* a sort with a limit applied — `33ii` measured that an `ORDER BY … LIMIT` is planned as a
 * `PhotonTopK` carrying no sort operator at all — so it is both the thing a walk looks for downstream and a
 * thing that is never itself an unreduced sort.
 */
const LIMITING_TAG = /TOPK|LIMIT|TAKEORDERED/;

/**
 * The four skew labels a reading is built from, and the one that is deliberately not here.
 *
 * `33id` measured all nine skew-named metrics over 36 plans and the split is not a matter of taste.
 * `partitions` is carried by 27 plans and **zero on all 60 operators of them**, which is the property a trigger
 * needs: a metric that is non-zero on ordinary work is a finding on every shape rather than a threshold to
 * tune. `maxToMedian` is non-zero on 23 of those 27 with a p90 of 4, so it is a figure to report beside a
 * finding and never the thing that fires one — which is what line 1048 of the design document asks too, since
 * its `max/median >= 10` is named there as an *initial screening value* to confirm against stage-level evidence
 * rather than a threshold to report from. It is reported as a multiple and not a share: 19 is the widest
 * reading in the corpus and as a percentage the surface would render it "1,900%".
 *
 * Three of the nine are left out, for two different reasons.
 *
 * `ShuffleQueryStage - Adp reduce-side skew threshold met` is left out of the evidence as well as the trigger.
 * It reads non-zero on 17 of the 36 plans — 2 on sixteen of them and 1 on one — so it is nearly the same value
 * on nearly half of the estate's costliest shapes. A reader shown that number beside a skew finding would
 * reasonably take it as part of the reason, and it is not.
 *
 * `AQEShuffleRead - Skew handled by` and `MapStage - Skew skewed data size ratio` are left out because nothing
 * has measured what their numbers mean. Both read zero on every operator that carried them, so the corpus
 * establishes that they are carried and nothing about their scale — and the surface has to choose a scale to
 * render a number at. The first reads like a choice of mechanism rather than a magnitude; the second is named a
 * ratio and a ratio is a share or a factor, which are the same number rendered ninefold apart at 0.09. There is
 * no reading of either that is not a guess, and a guess rendered beside a measured count is the more
 * believable of the two. Both stay in `NAMED_METRICS` so a measurement over an estate with skew in it can say.
 */
const SKEW: Readonly<Record<'partitions' | 'maxToMedian', NamedMetricLabel>> = {
  partitions: 'MapStage - Skew num skewed partitions',
  maxToMedian: 'MapStage - Skew max to non-empty median ratio',
};

/** The three names `key_metrics` carries. Spelled as the response spells them, not renamed. */
export type MetricName = keyof KeyMetrics;

/**
 * One metric off one operator, or `undefined` where the operator carried none.
 *
 * A zero comes back as `0`, because the response recorded a zero and this file reports what it read. The
 * caller decides what a zero means; see the header.
 */
export function metric(operator: PlanOperator, name: MetricName): number | undefined {
  const metrics = operator.keyMetrics;
  if (metrics == null) return undefined;
  const value = metrics[name];
  // Guarded rather than asserted. The type says `number` and the type describes a response nothing
  // validates, so a string here would otherwise reach a `Finding`'s `value: number` and be rendered.
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * The operators whose tag matches, in plan order.
 *
 * By tag, because that is the only field every operator carries and the only one `33ia` measured as stable.
 * `name` is a display string — `Scalar U D F`, spaced by whatever produced it — and matching on it would be
 * matching on presentation.
 */
export function operatorsMatching(extract: PlanExtract, tag: RegExp): readonly PlanOperator[] {
  return extract.operators.filter((operator) => tag.test(operator.tag));
}

/**
 * The largest value of one metric across a set of operators, or `undefined` where none carried it.
 *
 * `undefined` rather than 0 for an empty set, and that is the whole reason this is a function rather than a
 * `Math.max` at the call site: `Math.max()` of nothing is `-Infinity`, and `Math.max(...[0])` and
 * `Math.max()` both reduce to a number that would be rendered as evidence.
 */
export function widest(operators: readonly PlanOperator[], name: MetricName): number | undefined {
  const values = operators.flatMap((operator) => {
    const value = metric(operator, name);
    return value == null ? [] : [value];
  });
  if (values.length === 0) return undefined;
  return values.reduce((largest, value) => (value > largest ? value : largest));
}

/**
 * One named metric off one operator, or `undefined` where the operator did not carry that label.
 *
 * The same absent-versus-zero discipline as `metric`, and it matters more here: a zero from a skew counter is
 * the platform saying it found no skew, and an absent one is a plan with nothing to shuffle. `parse.ts` keeps
 * a zero and drops a label whose value was not a finite number, so what arrives here is either a number the
 * response carried or nothing.
 */
export function namedMetric(operator: PlanOperator, label: NamedMetricLabel): number | undefined {
  const value = operator.named?.[label];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Every value of one named metric across a plan, in operator order, skipping the operators without it. */
function readings(extract: PlanExtract, label: NamedMetricLabel): readonly number[] {
  return extract.operators.flatMap((operator) => {
    const value = namedMetric(operator, label);
    return value == null ? [] : [value];
  });
}

/**
 * The largest of a set of numbers, or `undefined` for an empty set.
 *
 * The same reason `widest` exists rather than a `Math.max` at the call site: `Math.max()` of nothing is
 * `-Infinity`, which is a number and would be rendered to a reader as evidence. Line 1436 of the design
 * document asks that the percentile and skew calculations handle empty, single, null and zero-valued inputs,
 * and for the empty case that instruction is this function.
 */
function largest(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((most, value) => (value > most ? value : most));
}

/** The smallest of a set of numbers, or `undefined` for an empty set. `Math.min()` of nothing is `Infinity`. */
function narrowest(values: readonly number[]): number | undefined {
  return values.length === 0 ? undefined : values.reduce((least, value) => (value < least ? value : least));
}

/**
 * What a plan's operators reported about skew, or nothing where the question cannot be asked of this extract.
 *
 * Two `undefined` cases, and neither is a plan without skew. An extract written before `plan-parser-3` kept no
 * named metrics at all, so its silence is the parser's. An extract where nothing carried the counter is a plan
 * the platform did not report a skew counter for — on `33id`'s corpus that was 9 of 36 plans, **eight of which
 * have no exchange operator at all**, so the absence mostly follows from there being nothing to shuffle. On the
 * ninth the plan shuffles and the counter is missing, and that absence says nothing either way. Reporting zero
 * skew for either would be a measurement this app did not take.
 */
export interface SkewReading {
  /** Operators carrying the skewed-partition counter, whatever it said. Never zero — see above. */
  readonly carrying: number;
  /** The most skewed partitions any one operator reported. */
  readonly worstPartitions: number;
  /** How many operators reported any. Zero is the ordinary case and is why the counter is a trigger. */
  readonly reporting: number;
  /** The widest max-to-median partition ratio, where the plan carried one at all. */
  readonly worstMaxToMedian: number | undefined;
}

export function skewIn(extract: PlanExtract): SkewReading | undefined {
  if (!namedMetricsAreReadable(extract)) return undefined;
  const partitions = readings(extract, SKEW.partitions);
  // One guard rather than a length check and a fallback: `largest` answers nothing for an empty set, so the
  // absent case and the unreadable-number case are the same case, and a `?? 0` beside it would be a zero the
  // type demanded rather than a count anything reported.
  const worstPartitions = largest(partitions);
  if (worstPartitions == null) return undefined;
  return {
    carrying: partitions.length,
    worstPartitions,
    reporting: partitions.filter((value) => value > 0).length,
    worstMaxToMedian: largest(readings(extract, SKEW.maxToMedian)),
  };
}

/**
 * What a join operator's tag looks like, and why this one is wide where `SORT_TAG` is narrow.
 *
 * `SORT_TAG` was narrowed because `/SORT/` matches `SortMergeJoin`, and a `LARGE_SORT` finding on a join would
 * be a false positive. The failure direction here is the reverse: a join spelled in a way this misses is a join
 * left out, and the rule that reads it *declines* on the joins it recognises as broadcasts. So a missed join is
 * a missed finding, while a missed broadcast would be a wrong one — which is the case the narrow pattern would
 * cause. `33ifb` measured the two tags in the corpus, `PHOTON_BROADCAST_HASH_JOIN_EXEC` and
 * `PHOTON_BROADCAST_NESTED_LOOP_JOIN_EXEC`, and asserted that this pattern claims exactly the tags naming a
 * join and no others.
 */
const JOIN_TAG = /JOIN/;

/**
 * How a join says it is a broadcast, in either of the two places it can say so.
 *
 * Both, because they are different claims and a rule that may not fire on a broadcast needs the weaker
 * condition. `JOIN_ALGORITHM` is the platform's own words — `Photon Broadcast Hash` and `Photon Broadcast
 * Nested Loop` are the two values in `33ifb`'s corpus — and the tag says the same thing where the key is
 * missing. Both tags in that corpus carried the word too, so on it the two agree; the case they do not is a
 * join tagged as a hash join whose algorithm names a broadcast, and `plan-metrics.test.ts` holds each tell
 * against the case the other misses.
 *
 * The tag is checked against `JOIN_TAG` first, so a broadcast under a tag that does not name a join at all is
 * not reached here — it is not read as a non-broadcast join, it is not read as a join.
 */
const BROADCAST_WORDING = /BROADCAST/;

/** Which spelling of a boundary a tag is, if any, in `BOUNDARY_TAGS`' declaration order. */
function classify(tag: string): keyof typeof BOUNDARY_TAGS | undefined {
  const normalised = spelled(tag);
  return (Object.keys(BOUNDARY_TAGS) as (keyof typeof BOUNDARY_TAGS)[]).find((name) =>
    BOUNDARY_TAGS[name].test(normalised)
  );
}

/**
 * How many shuffle boundaries a plan has, and how many exchange operators went uncounted.
 *
 * `boundaries` folds the Photon pair into one, which is the reading `33id` measured and the reason the design
 * document's eight is roughly right rather than an order out: over 36 plans the pair reading is 0, 1, 2, one
 * plan at 5, then 9, 10, 10 — a floor of 6, 7, 8 or 9 selects the same three plans, so eight sits in a gap and
 * does not have to be exactly right. Counting tags instead selects a fourth plan whose boundary count is 5.
 *
 * `unrecognisedExchanges` is every other operator naming itself an exchange, and it is deliberately not part
 * of the count. A broadcast exchange is an exchange by name and is the *opposite* of this finding — it is what
 * a `BROADCAST_CANDIDATE` recommendation asks for — so a count wide enough to include one would fire on the
 * plan that took the advice. It is reported instead, so a reader of a plan full of spellings this app does not
 * know sees that rather than a confident count of zero.
 */
export interface ExchangeBoundaries {
  readonly boundaries: number;
  readonly unrecognisedExchanges: number;
}

export function exchangeBoundaries(extract: PlanExtract): ExchangeBoundaries {
  const counts = { mapStage: 0, sink: 0, whole: 0, queryStage: 0, reused: 0 };
  let unrecognisedExchanges = 0;
  for (const operator of extract.operators) {
    const group = classify(operator.tag);
    if (group != null) counts[group] += 1;
    else if (ANY_EXCHANGE.test(spelled(operator.tag))) unrecognisedExchanges += 1;
  }
  return {
    // The larger of the two halves rather than either one, so an unpaired sink is a boundary instead of a
    // rounding-down, and a plan whose halves are equal — every plan in `33id`'s corpus that had any — counts
    // each boundary once.
    boundaries: Math.max(counts.mapStage, counts.sink) + counts.whole + counts.queryStage + counts.reused,
    unrecognisedExchanges,
  };
}

/**
 * The operators downstream of one: everything that consumes its output, transitively.
 *
 * Along `from`, because `33ii` measured the direction and `33id` held it over a corpus — on all 14 plans with
 * both a scan and a sort, a scan reaches further this way and a sort reaches further the other. An edge points
 * *from* the operator that consumes *to* the operator that produced, which is not what the field names suggest,
 * and a walk in the other direction would answer whether the sort's own input was limited: a different question
 * with a plausible-looking answer.
 *
 * `undefined` where the extract carries no edges at all, which is an extract written before `plan-parser-3`
 * rather than a plan with no edges. A caller that read that as "nothing follows this operator" would report
 * every sort in the retained store as unreduced.
 */
export function operatorsAfter(extract: PlanExtract, id: string): readonly PlanOperator[] | undefined {
  if (extract.edges == null) return undefined;
  const consumers = new Map<string, string[]>();
  for (const edge of extract.edges) consumers.set(edge.to, [...(consumers.get(edge.to) ?? []), edge.from]);

  const seen = new Set<string>([id]);
  for (let frontier = [id]; frontier.length > 0; ) {
    const next: string[] = [];
    for (const at of frontier) {
      for (const other of consumers.get(at) ?? []) {
        // Guarded rather than assumed acyclic. A plan graph should be a DAG; a cycle here is an unbounded walk
        // inside a synchronous analysis, which is a hang rather than a wrong answer.
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return extract.operators.filter((operator) => operator.id !== id && seen.has(operator.id));
}

/**
 * The operators whose output one operator consumes, one step back.
 *
 * Immediate producers, not the transitive set, and that is the point: a join's two inputs are its two
 * producers, so one step back separates the sides where a walk of the whole subtree merges them. The direction
 * is `operatorsAfter`'s reversed — along `from`-to-`to` — for the reason recorded there and measured in `33ii`.
 *
 * `undefined` on an extract with no edges, same as `operatorsAfter`: a caller that read that as "this operator
 * has no inputs" would report every join in the retained store as unsizeable.
 */
export function operatorsBefore(extract: PlanExtract, id: string): readonly PlanOperator[] | undefined {
  if (extract.edges == null) return undefined;
  const producers = new Set(extract.edges.filter((edge) => edge.from === id).map((edge) => edge.to));
  return extract.operators.filter((operator) => operator.id !== id && producers.has(operator.id));
}

/** One join, what it said about itself, and what its inputs carried. */
export interface JoinReading {
  readonly operator: PlanOperator;
  /** `JOIN_ALGORITHM` as the plan spelled it. Empty where the plan named none. */
  readonly algorithm: readonly string[];
  /** Whether the plan says this join already broadcasts, by either tell. See `BROADCAST_WORDING`. */
  readonly broadcast: boolean;
  /** Its immediate producers, which are its sides. `33ifb` measured exactly two on 13 of 13 joins. */
  readonly inputs: readonly PlanOperator[];
  /**
   * Rows through the narrowest input, where every input carried a row count.
   *
   * Every input, not the narrowest of those that carried one: a join whose second side reported no rows has an
   * unknown side, and the smaller of one known side and one unknown is not the known one. `33ifb` measured
   * `rows_num` on 26 of 26 inputs, so this is the ordinary case rather than the lucky one.
   */
  readonly narrowestInputRows: number | undefined;
}

/**
 * Every join in a plan, or nothing where the extract cannot answer for one.
 *
 * Three `undefined` cases and each is the extract's silence rather than the plan's. `JOIN_ALGORITHM` is
 * unreadable before `plan-parser-2`, which `33ih` fixed and which matters here more than anywhere: an extract
 * from `plan-parser-1` reports every join as naming no algorithm, and a rule that may not fire on a broadcast
 * would then be reading a plan that cannot tell it which joins are broadcasts. The other two are `sortsIn`'s,
 * for `sortsIn`'s reason: no edges, or an edge leading to an operator this extract does not have.
 */
export function joinsIn(extract: PlanExtract): readonly JoinReading[] | undefined {
  if (!metaIsReadable(extract, 'JOIN_ALGORITHM')) return undefined;
  if (extract.edges == null || (extract.edgesWithUnknownEndpoint ?? 0) > 0) return undefined;
  const readings: JoinReading[] = [];
  for (const operator of extract.operators) {
    if (!JOIN_TAG.test(spelled(operator.tag))) continue;
    const algorithm = operator.meta?.JOIN_ALGORITHM ?? [];
    const inputs = operatorsBefore(extract, operator.id) ?? [];
    const rows = inputs.map((input) => metric(input, 'rows_num'));
    readings.push({
      operator,
      algorithm,
      broadcast:
        algorithm.some((value) => BROADCAST_WORDING.test(spelled(value))) ||
        BROADCAST_WORDING.test(spelled(operator.tag)),
      inputs,
      narrowestInputRows: rows.every((value) => value != null) ? narrowest(rows) : undefined,
    });
  }
  return readings;
}

/**
 * Every table a plan says it scanned, or nothing where this extract cannot answer.
 *
 * `SCAN_IDENTIFIER` is the platform's own fully-qualified name for the relation behind a scan, and `33iga`
 * measured it on labs: 57 values across 36 plans, **all three-part**, every one declared by
 * `PHOTON_PARQUET_FILE_SCAN_EXEC`, 12 distinct tables. It is the only thing in a plan that reaches the
 * catalogue, so it is the whole of the join between a query shape and anything read about a table.
 *
 * `undefined` where the key is unreadable, which is `plan-parser-1`. `33ih` records why that is not the same as
 * a plan that named no relation: the parser read the wrong one of two spellings and stored `[]` on every
 * extract, so a caller reading the empty array as "this query scans nothing" would report the bug.
 *
 * Not deduplicated, and not filtered by tag. A plan that scans one table twice returns it twice — the caller
 * decides whether that matters, and a distinct count computed here would be a different question silently
 * answered. The tag is left alone because the measurement found one, and selecting on one observation is how
 * `33ie` nearly missed the top-k case.
 */
export function scansIn(extract: PlanExtract): readonly string[] | undefined {
  if (!metaIsReadable(extract, 'SCAN_IDENTIFIER')) return undefined;
  return extract.operators.flatMap((operator) => operator.meta?.SCAN_IDENTIFIER ?? []);
}

/** One sort, and what the walk found after it. */
export interface SortReading {
  readonly operator: PlanOperator;
  /** How many operators consume its output, transitively. Zero means the walk found nothing to judge. */
  readonly downstream: number;
  readonly limitedDownstream: boolean;
}

/**
 * Every sort in a plan, with whether anything after it reduces the rows it produced.
 *
 * `undefined` where the walk cannot be trusted, which is two cases and both matter. An extract with no `edges`
 * predates them. An extract with an edge whose endpoint resolves to no operator has a walk that may stop short,
 * and a walk that stops short reports "nothing reduces this sort" for the one reason that is not a fact about
 * the query. Both cost silence; the alternative costs a finding a reader cannot check.
 *
 * A top-k is not in the list. It is a sort whose limit the planner already applied, so it is neither expensive
 * for the reason this rule is about nor unreduced.
 */
export function sortsIn(extract: PlanExtract): readonly SortReading[] | undefined {
  if (extract.edges == null || (extract.edgesWithUnknownEndpoint ?? 0) > 0) return undefined;
  const readings: SortReading[] = [];
  for (const operator of extract.operators) {
    const tag = spelled(operator.tag);
    if (!SORT_TAG.test(tag) || LIMITING_TAG.test(tag)) continue;
    const after = operatorsAfter(extract, operator.id) ?? [];
    readings.push({
      operator,
      downstream: after.length,
      limitedDownstream: after.some((one) => LIMITING_TAG.test(spelled(one.tag))),
    });
  }
  return readings;
}
