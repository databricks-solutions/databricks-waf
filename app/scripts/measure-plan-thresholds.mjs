// Measures the two thresholds `33ie` to `33ig` would otherwise pick, over the shapes the advisor ranks.
//
// Live and optional, like every other measurement here: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-plan-thresholds.mjs
//
// ## Why this row exists
//
// `33ia` probed five statements written to exercise the rules, and its own write-up says what that cannot
// answer. Every one of the five carried non-zero skew metrics with no skew designed into them; two runs of the
// *same* five statements twenty minutes apart put the widest skew ratio at 7 and then at 15, and the widest
// plan at 37 operators and then 23. A threshold read off that is a threshold read off two executions.
//
// So this reads the corpus instead — the shapes the advisor actually ranks, which is a different population
// from five hand-written probes in two ways that both matter. It is the estate's own work rather than queries
// written to produce a signal, so a metric that is non-zero here is non-zero on ordinary work. And it is a
// distribution rather than a sample, so "eight exchanges" can be checked against how many plans have eight.
//
// ## The apparatus decision this row turns on
//
// The corpus is obtained by **running the app's own statement**, `config/statements/workload_query_shapes.sql`,
// with the parameters the collector binds. Not by writing a similar query here. That walk now lives in
// `plan-corpus.mjs`, moved there by `33ifb` so the join measurement reads the same population; the reasoning is
// there and unchanged.
//
// ## What is measured
//
// **What an exchange boundary is.** The design document states eight exchanges over a minute (line 978), and
// `33ia` measured that Photon renders one shuffle boundary as two operators — `PHOTON_SHUFFLE_MAP_STAGE_EXEC`
// and `UNKNOWN.PhotonShuffleExchangeSink` in equal numbers on all five probes. Counting tags therefore doubles
// every plan. Four candidate readings are counted per plan and reported as distributions, so the question
// "which reading makes eight a threshold that fires on the tail rather than on everything or nothing" has an
// answer in the recording rather than in a rule.
//
// **Which skew metric carries a signal, and at what value.** Nine labels, each reported as how many plans
// carried it, how many carried a non-zero value, and the distribution of the per-plan maximum. A metric that
// is non-zero on most of the corpus cannot support a finding whatever its threshold; one that is zero almost
// everywhere and large in a few places can.
//
// **Whether a sort has a limiting reduction after it.** `LARGE_SORT`'s condition is a sort with no limit
// downstream, which is a statement about the graph and became answerable in `33ic`. Counted here because a
// condition that is true of nearly every sort is a rule that fires on nearly every plan, and that is a fact
// about the corpus rather than about the threshold.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, eachPlan, widestGraph } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, '..');
const OUT_DIR = join(APP, 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plan-thresholds.json');

/**
 * The tags of an exchange, grouped by what each one is, because the grouping is the thing being measured.
 *
 * `33ia` measured the first two appearing in equal numbers on all five probes, which is what a boundary
 * rendered as a producer and a consumer looks like. The third and fourth appeared once each on the heavier
 * probes. Kept as four groups rather than one list so a reading can count any subset of them.
 */
const EXCHANGE_TAGS = {
  mapStage: [/SHUFFLEMAPSTAGE/],
  sink: [/SHUFFLEEXCHANGESINK/],
  queryStage: [/SHUFFLEQUERYSTAGE/],
  reused: [/REUSEDEXCHANGE/],
};

/**
 * A tag with its underscores removed and folded to upper case, which is the only reliable way to match one.
 *
 * The response spells the same concept two ways — `PHOTON_SHUFFLE_MAP_STAGE_EXEC` and
 * `UNKNOWN.PhotonShuffleExchangeSink` — and the difference is *underscores*, not case, so a case-insensitive
 * pattern for one does not match the other. Every pattern here therefore had both spellings, and review read
 * the second of each pair as dead code. Deleting them took the sink count from 63 to zero and the pairing claim
 * with it, silently, because a group that matches nothing looks exactly like a group with nothing in it. One
 * spelling and one normalisation instead: `sink` cannot be quietly turned off by a pattern that stops matching.
 */
function spell(tag) {
  return tag.replace(/_/g, '').toUpperCase();
}

/**
 * Anything else naming itself an exchange, so a tag no probe produced is counted rather than missed.
 *
 * A named fallback rather than a fifth entry above, because as an entry it worked only by being declared last:
 * `/EXCHANGE/i` matches `UNKNOWN.PhotonShuffleExchangeSink` too, so a first-match-wins walk over the object
 * would have moved every sink into this group had somebody reordered the literal. Review caught that, and the
 * cost of a positional dependency nothing tests is the whole `pairs` reading silently becoming zero.
 */
const OTHER_EXCHANGE = [/EXCHANGE/];

/** The nine labels `33ia` matched as skew signals. `33ic` keeps six of them; all nine are measured. */
const SKEW_METRICS = [
  'MapStage - Skew max to non-empty median ratio',
  'MapStage - Skew num skewed partitions',
  'MapStage - Skew skewed data size ratio',
  'MapStage - Skew non-empty median partition size',
  'MapStage - Skew num empty partitions',
  'AQEShuffleRead - Skew handled by',
  'ShuffleQueryStage - Adp reduce-side skew threshold met',
  'AQEShuffleRead - Number of skewed partitions',
  'AQEShuffleRead - Number of skewed partition splits',
];

/** Tags that end a sort's usefulness, for the `LARGE_SORT` count. A top-k is a sort that already has one. */
const LIMITING = [/TOPK/, /LIMIT/, /TAKEORDERED/];

/**
 * A sort operator, narrowed to the two spellings a sort is actually tagged with.
 *
 * Not `/SORT/i`, which is what this was and which matches `SortMergeJoin`, `PhotonShuffledSortMergeJoin` and
 * `SortAggregate`. None of those appeared in this corpus so the reading was sound here, and on an estate with a
 * sort-merge join the loose pattern would have counted one as a sort in both readings below — where the design
 * document's line 1017 exists precisely because a sort-merge join is not evidence of anything. `sortTagsSeen`
 * is recorded so a re-run says what the narrow pattern caught rather than leaving it to this comment.
 */
const SORT_TAGS = [/SORTEXEC/, /PHOTONSORT/];

// Still exported from here because this row's tests read it from here, and `33ifb` moved it rather than
// changing it.
export { widestGraph };

/** Whether a tag belongs to a group, by any of its patterns, both normalised. See `spell`. */
function inGroup(tag, patterns) {
  const spelled = spell(tag);
  return patterns.some((pattern) => pattern.test(spelled));
}

/**
 * The four candidate readings of "how many exchange boundaries does this plan have", per plan.
 *
 * `tags` counts every operator whose tag names an exchange, which is the reading a rule would reach for first
 * and the one `33ia` showed double-counts. `pairs` counts a map stage and its sink as one. `mapStages` counts
 * only the producing half, which is the same number as `pairs` wherever they pair and differs where they do
 * not — so the two together say whether the pairing `33ia` measured on five probes holds over a corpus.
 * `stages` counts the query-stage operators, which is what the platform's own UI calls a stage.
 *
 * `pairs` deliberately leaves `otherExchange` out: an exchange tag none of the four groups recognises might be
 * either half of a boundary, and counting it as a whole one inflates the reading a threshold gets set on. The
 * consequence is that `pairs` is a reading of Photon's spellings, and `otherExchange` is recorded so the
 * corpus says how much sits outside them.
 */
/** Whether one of the four groups claims a tag, which is what the catch-all is the complement of. */
function classified(tag) {
  return Object.values(EXCHANGE_TAGS).some((patterns) => inGroup(tag, patterns));
}

export function exchangeReadings(tags) {
  const counts = { mapStage: 0, sink: 0, queryStage: 0, reused: 0, otherExchange: 0 };
  for (const tag of tags) {
    const group = Object.keys(EXCHANGE_TAGS).find((name) => inGroup(tag, EXCHANGE_TAGS[name]));
    if (group != null) counts[group] += 1;
    // The fallback is what is left over, tested rather than positional. See OTHER_EXCHANGE.
    else if (inGroup(tag, OTHER_EXCHANGE)) counts.otherExchange += 1;
  }
  return {
    counts,
    // Which tags they were, not only how many. `pairs` reads them as zero, so what they are decides whether a
    // rule can afford to: an exchange the four groups do not recognise is either a half-boundary Photon spells
    // differently or a whole one from another engine, and the two want opposite treatment. Recorded because
    // `33ie` has to choose and a count cannot tell it which.
    otherExchangeTags: [...new Set(tags.filter((tag) => !classified(tag) && inGroup(tag, OTHER_EXCHANGE)))],
    readings: {
      tags: counts.mapStage + counts.sink + counts.queryStage + counts.reused + counts.otherExchange,
      pairs: Math.max(counts.mapStage, counts.sink) + counts.queryStage + counts.reused,
      mapStages: counts.mapStage,
      stages: counts.queryStage,
    },
    // The pairing claim, per plan, so the corpus can disagree with the five probes.
    mapStagesEqualSinks: counts.mapStage === counts.sink,
  };
}

/**
 * Every metric in a plan, by label, as the widest reading *and* how many operators it came from.
 *
 * The maximum is the reading a threshold would use, and on its own it hides which plan it describes: a plan
 * whose twelve shuffles all read 3 and one whose eleven read 0 and one reads 19 both report their maximum.
 * That difference is what a reader of `33ifa`'s evidence figure would act on, so the operator counts come too.
 * For a metric that is zero everywhere the two agree by construction, which is why the trigger is safe to pick
 * off the maximum alone.
 */
export function metricsByLabel(nodes) {
  const byLabel = new Map();
  for (const node of nodes) {
    for (const metric of Array.isArray(node?.metrics) ? node.metrics : []) {
      const label = metric?.label;
      if (typeof label !== 'string') continue;
      const value = typeof metric.value === 'number' && Number.isFinite(metric.value) ? metric.value : null;
      if (value == null) continue;
      const before = byLabel.get(label) ?? { max: Number.NEGATIVE_INFINITY, operators: 0, nonZero: 0 };
      byLabel.set(label, {
        max: Math.max(before.max, value),
        operators: before.operators + 1,
        nonZero: before.nonZero + (value === 0 ? 0 : 1),
      });
    }
  }
  return byLabel;
}

/**
 * Sorts, and whether anything limiting is downstream of each.
 *
 * Downstream is along `from`, because `33ii` measured and `33ic` asserts that `from` is the consumer: an edge
 * points from the operator that consumes to the operator that produced. A walk in the other direction would
 * ask whether the sort's *input* was limited, which is a different question with a plausible-looking answer.
 */
export function sortsWithoutLimit(nodes, edges) {
  const { tagOf } = tagsById(nodes);
  const consumers = consumersOf(edges);
  const sorts = [...tagOf.entries()].filter(([, tag]) => inGroup(tag, SORT_TAGS) && !inGroup(tag, LIMITING));
  return sorts.map(([id, tag]) => {
    const seen = reachable(id, consumers);
    const limited = [...seen].some((at) => at !== id && inGroup(tagOf.get(at) ?? '', LIMITING));
    const node = nodes.find((one) => String(one?.id ?? '') === id);
    const key = node?.key_metrics ?? {};
    return {
      tag,
      downstreamOperators: seen.size - 1,
      limited,
      // What the sort cost, because a rule whose only condition is a graph shape fires on every sort. See
      // the write-up: the corpus has no sort with a limit after it, so the size is what has to separate them.
      rows: typeof key.rows_num === 'number' ? key.rows_num : null,
      peakMemoryBytes: typeof key.peak_memory_bytes === 'number' ? key.peak_memory_bytes : null,
      durationMs: typeof key.duration_ms === 'number' ? key.duration_ms : null,
      spilledBytes: spilled(node),
    };
  });
}

/**
 * Tags by operator id, over the nodes that have one.
 *
 * A node with no id is skipped rather than keyed on the empty string, which is what this did: two of them
 * collapsed into one entry, and a sort among them would have been dropped or read with its neighbour's tag.
 * `nodesWithoutAnId` counts them so a plan that has some says so.
 */
export function tagsById(nodes) {
  const tagOf = new Map();
  let nodesWithoutAnId = 0;
  for (const node of nodes) {
    const id = node?.id;
    if (typeof id !== 'string' && typeof id !== 'number') {
      nodesWithoutAnId += 1;
      continue;
    }
    tagOf.set(String(id), node?.tag ?? '(untagged)');
  }
  return { tagOf, nodesWithoutAnId };
}

/** Consumer ids by producer id: the adjacency a downstream walk needs, given `from` is the consumer. */
function consumersOf(edges) {
  const consumers = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = edge?.from_id == null ? null : String(edge.from_id);
    const to = edge?.to_id == null ? null : String(edge.to_id);
    if (from == null || to == null) continue;
    consumers.set(to, [...(consumers.get(to) ?? []), from]);
  }
  return consumers;
}

/** Every id reachable from one, including itself, over the adjacency given. */
function reachable(id, adjacency) {
  const seen = new Set([id]);
  for (let frontier = [id]; frontier.length > 0; ) {
    const next = [];
    for (const at of frontier) {
      for (const other of adjacency.get(at) ?? []) {
        if (seen.has(other)) continue;
        seen.add(other);
        next.push(other);
      }
    }
    frontier = next;
  }
  return seen;
}

/**
 * The check that the walk above is going the way it thinks it is.
 *
 * `33ii` measured the direction and `33ic` asserts it on one fixture, and a rule reading the graph backwards
 * would answer a different question with a plausible number rather than fail. A scan is the deepest thing in a
 * plan and a sort is near the top, so if `from` is the consumer, scans reach many operators downstream and
 * sorts reach few. Reversed, the two swap. Reported per plan so the recording carries the evidence rather than
 * the assumption.
 */
export function directionCheck(nodes, edges) {
  const consumers = consumersOf(edges);
  const producers = new Map();
  for (const [to, froms] of consumers) for (const from of froms) {
    producers.set(from, [...(producers.get(from) ?? []), to]);
  }
  const { tagOf } = tagsById(nodes);
  const idsTagged = (patterns) =>
    [...tagOf.entries()].filter(([, tag]) => inGroup(tag, patterns)).map(([id]) => id);
  const deepest = (ids, adjacency) =>
    ids.length === 0 ? null : Math.max(...ids.map((id) => reachable(id, adjacency).size - 1));
  const scans = idsTagged([/SCAN/]);
  const sorts = idsTagged(SORT_TAGS);
  return {
    scans: scans.length,
    sorts: sorts.length,
    scanReachesAlongFrom: deepest(scans, consumers),
    sortReachesAlongFrom: deepest(sorts, consumers),
    scanReachesAlongTo: deepest(scans, producers),
    sortReachesAlongTo: deepest(sorts, producers),
  };
}

/** The largest spill any metric on an operator reports, or null where none names one. */
function spilled(node) {
  let most = null;
  for (const metric of Array.isArray(node?.metrics) ? node.metrics : []) {
    if (typeof metric?.label !== 'string' || !/spill/i.test(metric.label)) continue;
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    most = Math.max(most ?? 0, metric.value);
  }
  return most;
}

/** Percentiles over a list of numbers, nearest-rank, so every reported figure is a value that occurred. */
export function distribution(values) {
  const sorted = [...values].sort((one, two) => one - two);
  if (sorted.length === 0) return null;
  const at = (fraction) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
  return {
    n: sorted.length,
    min: sorted[0],
    p50: at(0.5),
    p90: at(0.9),
    p99: at(0.99),
    max: sorted[sorted.length - 1],
    // How many plans a threshold of eight would fire on, since eight is the number in the document.
    atOrAboveEight: sorted.filter((value) => value >= 8).length,
  };
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, corpusSettings.profile, corpusSettings.host);

  const { shapes, found, skipped } = await eachPlan();
  console.log(
    `${String(shapes.length)} shapes from the app's own statement over ` +
      `${String(corpusSettings.lookbackDays)} days`,
  );

  const plans = [];
  for (const { shape, response, widest } of found) {
    const nodes = widest.graph.nodes;
    const tags = nodes.map((node) => node?.tag ?? '(untagged)');
    const metrics = metricsByLabel(nodes);
    plans.push({
      // The workspace as well as the shape, because `33k` measured that one shape spans workspaces: without it
      // two plans from different estates would be one row here.
      workspaceId: shape.workspace_id,
      shape: shape.shape,
      statementType: shape.statement_type,
        msNow: Number(shape.ms_now ?? 0),
        meanMs: Number(shape.mean_ms_now ?? 0),
        // The representative's own duration, which is the field `33ie` ended up using: the statement nominates
        // the longest measurable execution of the window, and `worst_ms` is the longest measurable execution of
        // the window, so where `representative_measured` holds the two are the same run — the one whose plan
        // every count above was read from. Recorded here because that identity is the argument for the choice,
        // and an argument about a field needs the field.
        worstMs: shape.worst_ms == null ? null : Number(shape.worst_ms),
        medianMs: shape.median_ms == null ? null : Number(shape.median_ms),
        representativeMeasured: shape.representative_measured === true || shape.representative_measured === 'true',
        runs: Number(shape.runs_now ?? 0),
      operators: nodes.length,
      // Characters of the JSON rather than bytes of the wire, which is the same thing only for ASCII.
      responseTextLength: response.text.length,
      exchanges: exchangeReadings(tags),
      skew: Object.fromEntries(
        SKEW_METRICS.filter((label) => metrics.has(label)).map((label) => [label, metrics.get(label)]),
      ),
      sorts: sortsWithoutLimit(nodes, widest.graph.edges),
      // Why a sort might have no limit after it, rather than only that it does not. A top-k is the planner
      // having applied the limit already, and `33ii` measured that an `ORDER BY … LIMIT` produces one with no
      // sort operator at all — so a corpus of sorts with no limit downstream is partly a count of this.
      topKOperators: tags.filter((tag) => inGroup(tag, LIMITING)).length,
      sortTagsSeen: [...new Set(tags.filter((tag) => inGroup(tag, SORT_TAGS)))],
      // Every operator's peak memory, not just the sorts', so "this field is an allocation" has the
      // observation that would falsify it. See the write-up.
      peakMemoryValues: [
        ...new Set(
          nodes
            .map((node) => node?.key_metrics?.peak_memory_bytes)
            .filter((value) => typeof value === 'number' && Number.isFinite(value)),
        ),
      ].sort((one, two) => one - two),
      direction: directionCheck(nodes, widest.graph.edges),
      edges: Array.isArray(widest.graph.edges) ? widest.graph.edges.length : 0,
    });
  }

  console.log(`\n${String(plans.length)} plans read; skipped ${JSON.stringify(skipped)}`);
  if (plans.length === 0) throw new Error('no plans were read; there is nothing to measure a threshold from');

  // The exchange question: one distribution per reading, so the document's eight can be checked against each.
  const exchanges = {};
  for (const reading of ['tags', 'pairs', 'mapStages', 'stages']) {
    exchanges[reading] = distribution(plans.map((plan) => plan.exchanges.readings[reading]));
  }
  /*
   * The pairing claim, and the population it is a claim about.
   *
   * A plan with no exchange satisfies `mapStages === sinks` at zero, so the two counts have to be reported
   * together: "equal on every plan" is worth nothing if most of the plans have none. Review caught this reading
   * as 36 of 36 when eight of the 36 were vacuous.
   */
  const withAnExchange = plans.filter((plan) => plan.exchanges.readings.tags > 0);
  const pairing = {
    plansWithAnyExchange: withAnExchange.length,
    plansWhereMapStagesEqualSinks: plans.filter((plan) => plan.exchanges.mapStagesEqualSinks).length,
    plansWithAnExchangeWhereMapStagesEqualSinks: withAnExchange.filter(
      (plan) => plan.exchanges.mapStagesEqualSinks,
    ).length,
    // How much sits outside the four groups `pairs` is built from, since `pairs` reads zero for it.
    exchangeTagsOutsideTheFourGroups: plans.reduce(
      (total, plan) => total + plan.exchanges.counts.otherExchange,
      0,
    ),
    // And what they were, which is the fact `33ie` needs rather than the count. See exchangeReadings.
    tagsOutsideTheFourGroups: [...new Set(plans.flatMap((plan) => plan.exchanges.otherExchangeTags))].sort(),
  };

  /*
   * Both halves of line 978's threshold, together, because the rule applies both and either alone
   * overstates how much of the corpus it selects. The duration is the shape's mean rather than one
   * execution's: a shape row carries a total and a count, and `33ie` restates the threshold on that basis.
   */
  const overAMinute = plans.filter((plan) => plan.meanMs >= 60000);
  const jointly = Object.fromEntries(
    ['tags', 'pairs', 'mapStages', 'stages'].map((reading) => [
      reading,
      // Only the joint count: how many a threshold of eight alone selects is already `exchanges[reading]`'s
      // `atOrAboveEight`, and the same number recorded twice is a number that can disagree with itself.
      overAMinute.filter((plan) => plan.exchanges.readings[reading] >= 8).length,
    ]),
  );

  /*
   * Whether a threshold has to be exactly right, which is the whole argument for accepting the design's eight.
   *
   * A floor sitting inside a gap in the distribution selects the same plans as any other floor in that gap, so
   * being approximately right is enough. Recorded per candidate floor rather than asserted, because "there is a
   * gap" is a claim about the data and this is the data saying it.
   */
  const selectedByFloor = Object.fromEntries(
    [4, 5, 6, 7, 8, 9, 10].map((floor) => [
      String(floor),
      plans.filter((plan) => plan.exchanges.readings.pairs >= floor).length,
    ]),
  );

  console.log('\nexchange boundaries per plan, by reading');
  for (const [reading, spread] of Object.entries(exchanges)) {
    if (spread == null) continue;
    console.log(
      `  ${reading.padEnd(10)} p50 ${String(spread.p50).padStart(3)}  p90 ${String(spread.p90).padStart(3)}` +
        `  p99 ${String(spread.p99).padStart(3)}  max ${String(spread.max).padStart(3)}` +
        `  >=8 on ${String(spread.atOrAboveEight)}/${String(spread.n)} plans`,
    );
  }
  console.log(
    `  map stages equal sinks on ${String(pairing.plansWithAnExchangeWhereMapStagesEqualSinks)}/` +
      `${String(pairing.plansWithAnyExchange)} plans that have an exchange, and vacuously on the other ` +
      `${String(plans.length - pairing.plansWithAnyExchange)}`,
  );
  console.log(
    `  ${String(pairing.exchangeTagsOutsideTheFourGroups)} exchange tags fell outside the four groups: ` +
      pairing.tagsOutsideTheFourGroups.join(', '),
  );
  console.log(
    `  plans selected by a floor on pairs: ` +
      Object.entries(selectedByFloor)
        .map(([floor, count]) => `${floor}→${String(count)}`)
        .join('  '),
  );
  console.log(
    `  ${String(overAMinute.length)}/${String(plans.length)} shapes mean over a minute; with >=8 boundaries: ` +
      Object.entries(jointly)
        .map(([reading, count]) => `${reading} ${String(count)}`)
        .join(', '),
  );
  console.log(
    `  over a minute by other readings of the duration: ` +
      `${String(plans.filter((plan) => plan.msNow >= 60000).length)} on the window total, ` +
      `${String(plans.filter((plan) => (plan.worstMs ?? 0) >= 60000).length)} on the representative's own run ` +
      `(longest ${String(Math.max(...plans.map((plan) => plan.worstMs ?? 0)))} ms)`,
  );

  // The skew question: presence, non-zero share and the spread of the per-plan maximum, per label.
  const skew = {};
  for (const label of SKEW_METRICS) {
    const carried = plans.filter((plan) => label in plan.skew);
    const values = carried.map((plan) => plan.skew[label].max);
    skew[label] = {
      carriedByPlans: carried.length,
      nonZeroPlans: values.filter((value) => value !== 0).length,
      // The operators behind the plans, because a per-plan maximum is one operator's reading and the write-up
      // makes claims about how ordinary a value is. See metricsByLabel.
      carryingOperators: carried.reduce((total, plan) => total + plan.skew[label].operators, 0),
      nonZeroOperators: carried.reduce((total, plan) => total + plan.skew[label].nonZero, 0),
      // Every distinct non-zero value, so "its every non-zero value is 2" is a checkable sentence rather than
      // an inference from a p50 and a max that happen to agree. Review found that claim false on one plan.
      distinctNonZeroValues: [...new Set(values.filter((value) => value !== 0))].sort((one, two) => one - two),
      spread: distribution(values),
    };
  }

  console.log('\nskew metrics: plans carried / non-zero, operators carried / non-zero, then p50 / p90 / max');
  for (const [label, one] of Object.entries(skew)) {
    if (one.carriedByPlans === 0) {
      console.log(`  ${label.padEnd(56)} carried by no plan`);
      continue;
    }
    console.log(
      `  ${label.padEnd(56)} ${String(one.carriedByPlans).padStart(3)} / ` +
        `${String(one.nonZeroPlans).padStart(3)}  ops ${String(one.carryingOperators).padStart(4)} / ` +
        `${String(one.nonZeroOperators).padStart(4)}  ${String(one.spread?.p50)} / ${String(one.spread?.p90)} / ` +
        `${String(one.spread?.max)}  values ${one.distinctNonZeroValues.slice(0, 6).join(',')}`,
    );
  }

  const allSorts = plans.flatMap((plan) => plan.sorts);
  const sorts = {
    plansWithASort: plans.filter((plan) => plan.sorts.length > 0).length,
    sorts: allSorts.length,
    sortsWithALimitDownstream: allSorts.filter((sort) => sort.limited).length,
    // A sort with nothing downstream at all is a sort in a plan whose edges did not reach the root, which is
    // a different finding from a sort with no limit — and would otherwise be counted as one.
    sortsWithNothingDownstream: allSorts.filter((sort) => sort.downstreamOperators === 0).length,
    rows: distribution(allSorts.map((sort) => sort.rows).filter((value) => value != null)),
    peakMemoryBytes: distribution(
      allSorts.map((sort) => sort.peakMemoryBytes).filter((value) => value != null),
    ),
    spilledBytes: distribution(allSorts.map((sort) => sort.spilledBytes).filter((value) => value != null)),
    sortsThatSpilled: allSorts.filter((sort) => (sort.spilledBytes ?? 0) > 0).length,
    // What a sort is tagged, so the narrow SORT_TAGS says what it caught rather than being trusted.
    tagsSeen: [...new Set(plans.flatMap((plan) => plan.sortTagsSeen))].sort(),
    // The other reason a sort might have no limit after it. See the per-plan field.
    plansWithATopK: plans.filter((plan) => plan.topKOperators > 0).length,
    topKOperators: plans.reduce((total, plan) => total + plan.topKOperators, 0),
  };
  console.log(
    `\nsorts: ${String(sorts.sorts)} in ${String(sorts.plansWithASort)} plans, ` +
      `${String(sorts.sortsWithALimitDownstream)} with a limit downstream, ` +
      `${String(sorts.sortsWithNothingDownstream)} with nothing downstream, ` +
      `${String(sorts.sortsThatSpilled)} that spilled`,
  );
  console.log(
    `  tagged ${sorts.tagsSeen.join(', ')}; ${String(sorts.topKOperators)} top-k or limit operators in ` +
      `${String(sorts.plansWithATopK)} plans`,
  );
  console.log(
    `  rows p50 ${String(sorts.rows?.p50)} p90 ${String(sorts.rows?.p90)} max ${String(sorts.rows?.max)}; ` +
      `peak memory p50 ${String(sorts.peakMemoryBytes?.p50)} p90 ${String(sorts.peakMemoryBytes?.p90)} ` +
      `max ${String(sorts.peakMemoryBytes?.max)}`,
  );

  /*
   * What `peak_memory_bytes` does across the corpus, sorts and everything else, because the interesting claim is
   * about the field rather than about the sorts.
   *
   * The sorts' own spread cannot tell a buffer allocation from a quantised measurement — for that, the question
   * is whether the field varies at all elsewhere in the same responses. `largestByRows` and `smallestByRows`
   * report the field beside the row count on the widest and narrowest sort, which is where the anti-correlation
   * shows: a size that does not grow with the rows is not reporting the rows.
   */
  const bySize = [...allSorts]
    .filter((sort) => sort.rows != null && sort.peakMemoryBytes != null)
    .sort((one, two) => one.rows - two.rows);
  const peaks = {
    distinctAcrossSorts: [
      ...new Set(allSorts.map((sort) => sort.peakMemoryBytes).filter((value) => value != null)),
    ].sort((one, two) => one - two),
    distinctAcrossEveryOperator: [...new Set(plans.flatMap((plan) => plan.peakMemoryValues))].sort(
      (one, two) => one - two,
    ),
    smallestByRows: bySize.at(0) == null ? null : { rows: bySize[0].rows, peak: bySize[0].peakMemoryBytes },
    largestByRows:
      bySize.at(-1) == null ? null : { rows: bySize.at(-1).rows, peak: bySize.at(-1).peakMemoryBytes },
  };
  console.log(
    `  peak memory takes ${String(peaks.distinctAcrossSorts.length)} values across ${String(allSorts.length)} ` +
      `sorts and ${String(peaks.distinctAcrossEveryOperator.length)} across every operator in the corpus`,
  );
  console.log(
    `  the narrowest sort: ${String(peaks.smallestByRows?.rows)} rows at ${String(peaks.smallestByRows?.peak)}; ` +
      `the widest: ${String(peaks.largestByRows?.rows)} rows at ${String(peaks.largestByRows?.peak)}`,
  );

  // The apparatus check, aggregated: the direction the walk assumes, held against every plan that has a
  // scan and a sort. See directionCheck.
  const bothEnds = plans.filter(
    (plan) => plan.direction.scanReachesAlongFrom != null && plan.direction.sortReachesAlongFrom != null,
  );
  const direction = {
    plansWithAScanAndASort: bothEnds.length,
    plansWhereScanReachesFurtherAlongFrom: bothEnds.filter(
      (plan) => plan.direction.scanReachesAlongFrom > plan.direction.sortReachesAlongFrom,
    ).length,
    plansWhereSortReachesFurtherAlongFrom: bothEnds.filter(
      (plan) => plan.direction.sortReachesAlongFrom > plan.direction.scanReachesAlongFrom,
    ).length,
  };
  console.log(
    `\ndirection: of ${String(direction.plansWithAScanAndASort)} plans with both, a scan reaches further along ` +
      `\`from\` on ${String(direction.plansWhereScanReachesFurtherAlongFrom)}, a sort on ` +
      String(direction.plansWhereSortReachesFurtherAlongFrom),
  );

  const payload = {
    runFinishedAt: new Date().toISOString(),
    ...corpusSettings,
    // What the corpus is, named as the file it came from, because that is the apparatus claim.
    corpus: {
      statement: 'config/statements/workload_query_shapes.sql',
      shapesReturned: shapes.length,
      plansRead: plans.length,
      skipped,
    },
    exchangeTagGroups: Object.fromEntries(
      Object.entries(EXCHANGE_TAGS).map(([name, patterns]) => [name, patterns.map(String)]),
    ),
    exchanges,
    pairing,
    jointly,
    selectedByFloor,
    // Three floors, because they select very different parts of this corpus and `33ie` had to pick one. The
    // mean is line 978's read as an average; a total over the window is what four of the shipped rules use;
    // the worst is the representative's own run, which is the execution the plan came from.
    shapesMeanOverAMinute: overAMinute.length,
    shapesTotalOverAMinute: plans.filter((plan) => plan.msNow >= 60000).length,
    shapesWorstOverAMinute: plans.filter((plan) => (plan.worstMs ?? 0) >= 60000).length,
    longestMeanMs: Math.max(...plans.map((plan) => plan.meanMs)),
    longestWorstMs: Math.max(...plans.map((plan) => plan.worstMs ?? 0)),
    // How many of the corpus the rule `33ie` shipped would actually select, on the fields it reads. Recorded
    // rather than argued: a rule selecting most of a corpus is a census whatever its threshold says.
    boundaryAndWorstOverAMinute: plans.filter(
      (plan) => plan.exchanges.readings.pairs >= 8 && (plan.worstMs ?? 0) >= 60000,
    ).length,
    plansWhereWorstIsTheRepresentative: plans.filter((plan) => plan.representativeMeasured).length,
    skewMetrics: skew,
    sorts: { ...sorts, peakMemory: peaks },
    direction,
    plans,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(`\nwrote ${OUT_FILE}`);
}

// Guarded so the tests can import the readings without running a scan.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main();
}
