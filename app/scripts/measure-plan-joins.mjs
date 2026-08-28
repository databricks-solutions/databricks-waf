// Measures whether a plan can size the side of a join, which is `BROADCAST_CANDIDATE`'s premise.
//
// Live and optional, like every other measurement here: it needs a warehouse and a CLI profile, nothing in
// `npm run verify` runs it, and what it writes is committed by hand.
//
//   cd app && DATABRICKS_WAREHOUSE_ID=<id> DATABRICKS_CONFIG_PROFILE=your-profile node scripts/measure-plan-joins.mjs
//
// ## Why this row exists
//
// `BROADCAST_CANDIDATE` is specified as one condition — one join side small enough to broadcast — and nothing
// has measured whether a plan says how big a join's sides are. What is known is that `33ia` read
// `JOIN_BUILD_SIDE` as `Right` on three joins and `33ii` read `Hashed relation size` on the broadcast joins of
// two probes. Both readings are of joins that *already broadcast*, and the rule's question is the opposite one:
// what a join that is not a broadcast carries.
//
// That is H1's shape exactly — a rework designed on an unmeasured number — so this row measures first. Four
// readings, and each one can make the rule impossible to write as specified:
//
//   1. The distinct values of `JOIN_ALGORITHM`, per plan and per operator. Whether a non-broadcast join is
//      identifiable at all, and by what spelling.
//   2. The distinct values of `JOIN_BUILD_SIDE`, and how many joins carry one. Whether the side to size can be
//      named. `33ia` saw only `Right`, on three joins.
//   3. `Hashed relation size`, `Aggressive BHJ Extrapolated Size` and `Aggressive BHJ Decision`, split by join
//      algorithm. Whether a size exists on the joins that are *not* already broadcasts.
//   4. What a walk to a join's producers reaches, and what those operators carry. Whether the build side's input
//      can be sized when the join itself carries nothing.
//
// ## The apparatus
//
// The corpus is `plan-corpus.mjs`: the app's own shapes statement with the collector's parameters, the same
// population `33id` measured its thresholds over. `33ii`'s lesson was that a measurement is only as good as the
// thing it was taken with, and its first pass produced a real number about a statement that did not exist.
//
// So **the count of joins found is recorded beside every reading**. A measurement over three joins and one over
// three hundred are different evidence, and the number that says which is the first thing a reader of this
// recording needs. A reading with no joins behind it is reported as having none rather than as a zero.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { corpusSettings, eachPlan } from './plan-corpus.mjs';
import { refuseUnlessNamedForItsEstate } from './recording-guards.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline');
const OUT_FILE = join(OUT_DIR, 'labs-plan-joins.json');

/**
 * What counts as a join operator, by tag.
 *
 * Wide on purpose, and the opposite decision from `33id`'s `SORT_TAGS`, which was narrowed because `/SORT/`
 * matched `SortMergeJoin`. There the loose pattern would have counted a join as a sort — a false positive in a
 * reading about sorts. Here a join spelled in a way this misses is a join left out of a measurement whose whole
 * purpose is to say what joins carry, and `joinTagsSeen` records what the pattern caught so a reader can check
 * it against `everyTag` rather than trusting this comment.
 */
const JOIN_TAGS = [/JOIN/];

/** The three size metrics `33ic` stores, which are the candidates for "small enough to broadcast". */
const SIZE_METRICS = ['Hashed relation size', 'Aggressive BHJ Extrapolated Size', 'Aggressive BHJ Decision'];

/**
 * Metrics that might size an operator's output, for the producer walk.
 *
 * `rows_num` and `peak_memory_bytes` come from `key_metrics` and the rest are labels; all of them are read
 * rather than one, because which of them a scan carries is the question and `33id` measured that
 * `peak_memory_bytes` takes four distinct values across a whole corpus — a field that does not vary is not
 * sizing anything.
 */
const SIZE_LABELS = [/SIZE/, /BYTES/, /ROWS/, /FILES/];

/** A tag or label with its underscores removed and folded to upper case. `33id`'s `spell`, and the same reason. */
function spell(text) {
  return text.replace(/_/g, '').toUpperCase();
}

function inGroup(text, patterns) {
  const spelled = spell(text);
  return patterns.some((pattern) => pattern.test(spelled));
}

/** Every `meta_data` value on an operator for one key, as strings, however the response spelled the entry. */
export function metaValues(node, key) {
  const entries = Array.isArray(node?.meta_data) ? node.meta_data : [];
  return entries
    .filter((entry) => entry?.key === key)
    .flatMap((entry) => {
      const value = entry.value ?? entry.values;
      if (Array.isArray(value)) return value.map((one) => String(one));
      return value == null ? [] : [String(value)];
    })
    .filter((value) => value !== '');
}

/** Every metric on an operator, by label, as a number where it is one. */
export function metricsOf(node) {
  const found = {};
  for (const metric of Array.isArray(node?.metrics) ? node.metrics : []) {
    if (typeof metric?.label !== 'string') continue;
    if (typeof metric.value !== 'number' || !Number.isFinite(metric.value)) continue;
    found[metric.label] = metric.value;
  }
  return found;
}

/** Producer ids by consumer id. `from` is the consumer, measured in `33ii` and asserted in `33ic`. */
function producersOf(edges) {
  const producers = new Map();
  for (const edge of Array.isArray(edges) ? edges : []) {
    const from = edge?.from_id == null ? null : String(edge.from_id);
    const to = edge?.to_id == null ? null : String(edge.to_id);
    if (from == null || to == null) continue;
    producers.set(from, [...(producers.get(from) ?? []), to]);
  }
  return producers;
}

/**
 * The joins of one plan, each with what it carries and what its immediate producers carry.
 *
 * Immediate producers rather than every operator upstream, because a join's two inputs are its two producers
 * and the rule needs to size *one side*: a transitive walk merges the sides back together and answers a
 * question about the whole subtree, which is the question the sizing does not need. Where a plan's edges do not
 * reach the join at all, `producers` is empty and that is the reading — the fourth of the four is whether the
 * walk arrives.
 */
export function joinsIn(nodes, edges) {
  const producers = producersOf(edges);
  const byId = new Map(
    nodes
      .filter((node) => node?.id != null)
      .map((node) => [String(node.id), node]),
  );
  return nodes
    .filter((node) => inGroup(String(node?.tag ?? ''), JOIN_TAGS))
    .map((node) => {
      const id = node?.id == null ? null : String(node.id);
      const metrics = metricsOf(node);
      const inputs = (id == null ? [] : (producers.get(id) ?? [])).map((producerId) => {
        const producer = byId.get(producerId);
        const producerMetrics = metricsOf(producer);
        return {
          tag: producer?.tag ?? '(untagged)',
          rows: producer?.key_metrics?.rows_num ?? null,
          peakMemoryBytes: producer?.key_metrics?.peak_memory_bytes ?? null,
          // Which labels on this producer name a size, rather than the values: the reading is whether anything
          // here could size a side, and the labels are what says so across a corpus of different operators.
          sizeLabels: Object.keys(producerMetrics).filter((label) => inGroup(label, SIZE_LABELS)),
        };
      });
      return {
        tag: node?.tag ?? '(untagged)',
        algorithm: metaValues(node, 'JOIN_ALGORITHM'),
        buildSide: metaValues(node, 'JOIN_BUILD_SIDE'),
        // The three candidates, present or absent, so "no size on a non-broadcast join" is a countable claim.
        sizes: Object.fromEntries(
          SIZE_METRICS.filter((label) => label in metrics).map((label) => [label, metrics[label]]),
        ),
        rows: node?.key_metrics?.rows_num ?? null,
        inputs,
        // Whether the walk reached this join's inputs at all, which is a different finding from a join whose
        // inputs carry nothing, and would otherwise be counted as one.
        producersFound: inputs.length,
      };
    });
}

/** Whether a join's algorithm names a broadcast, which is the split every size reading is reported across. */
export function isBroadcast(join) {
  return join.algorithm.some((value) => /broadcast/i.test(value));
}

/** How many of a list satisfy a predicate, and out of how many, so no share is reported without its base. */
function outOf(items, predicate) {
  return { of: items.length, matching: items.filter(predicate).length };
}

/** Every distinct value in a list of lists, sorted, with how many entries had none. */
export function distinctly(lists) {
  return {
    values: [...new Set(lists.flat())].sort(),
    withNone: lists.filter((one) => one.length === 0).length,
    withMoreThanOne: lists.filter((one) => one.length > 1).length,
  };
}

/** The readings, over however many joins the corpus had. Separated from `main` so a test can drive it. */
export function readings(joins) {
  const broadcasts = joins.filter((join) => isBroadcast(join));
  const others = joins.filter((join) => !isBroadcast(join));
  const sizedBy = (label) => (join) => label in join.sizes;
  const anySize = (join) => SIZE_METRICS.some((label) => label in join.sizes);
  return {
    joins: joins.length,
    // Reading 1 and 2: whether a join can be identified and its side named.
    algorithms: distinctly(joins.map((join) => join.algorithm)),
    buildSides: distinctly(joins.map((join) => join.buildSide)),
    joinTagsSeen: [...new Set(joins.map((join) => join.tag))].sort(),
    // The split the rule turns on. A corpus of only broadcasts cannot answer the rule's question at all, and
    // that outcome is recorded as a number rather than as an absence.
    broadcastJoins: broadcasts.length,
    otherJoins: others.length,
    // Reading 3: whether a size exists on the joins that are not already broadcasts.
    sizeOnBroadcasts: Object.fromEntries(
      SIZE_METRICS.map((label) => [label, outOf(broadcasts, sizedBy(label))]),
    ),
    sizeOnOtherJoins: Object.fromEntries(SIZE_METRICS.map((label) => [label, outOf(others, sizedBy(label))])),
    anySizeOnOtherJoins: outOf(others, anySize),
    // The values, for the joins that have one, because a threshold needs a scale and not only a presence.
    sizeValues: Object.fromEntries(
      SIZE_METRICS.map((label) => [
        label,
        [...new Set(joins.filter(sizedBy(label)).map((join) => join.sizes[label]))].sort(
          (one, two) => one - two,
        ),
      ]),
    ),
    // Reading 4: whether the producers of a join can be reached, and whether they carry a size.
    producers: {
      joinsWhereTheWalkArrived: outOf(joins, (join) => join.producersFound > 0),
      joinsWithTwoProducers: outOf(joins, (join) => join.producersFound === 2),
      producerTags: [...new Set(joins.flatMap((join) => join.inputs.map((input) => input.tag)))].sort(),
      producerSizeLabels: [
        ...new Set(joins.flatMap((join) => join.inputs.flatMap((input) => input.sizeLabels))),
      ].sort(),
      inputsWithRows: outOf(
        joins.flatMap((join) => join.inputs),
        (input) => typeof input.rows === 'number',
      ),
    },
  };
}

async function main() {
  // Before the probes, not after: a run that ends in a refusal to write is a read taken off a
  // warehouse for nothing. `79` is why this is here at all.
  refuseUnlessNamedForItsEstate(OUT_FILE, corpusSettings.profile, corpusSettings.host);

  const { shapes, found, skipped } = await eachPlan();
  console.log(
    `${String(shapes.length)} shapes from the app's own statement over ` +
      `${String(corpusSettings.lookbackDays)} days; ${String(found.length)} with a plan`,
  );

  const plans = [];
  for (const { shape, widest } of found) {
    const nodes = widest.graph.nodes ?? [];
    plans.push({
      workspaceId: shape.workspace_id,
      shape: shape.shape,
      statementType: shape.statement_type,
      operators: nodes.length,
      edges: Array.isArray(widest.graph.edges) ? widest.graph.edges.length : 0,
      joins: joinsIn(nodes, widest.graph.edges),
      // Every tag in the plan, so the wide JOIN_TAGS pattern can be checked against what it did not claim.
      everyTag: [...new Set(nodes.map((node) => node?.tag ?? '(untagged)'))].sort(),
      // The meta keys the plan actually carried, because `33ih` left extracts whose JOIN_BUILD_SIDE is empty
      // for a parser reason rather than a plan reason, and this reads the response rather than the extract.
      metaKeysSeen: [
        ...new Set(
          nodes.flatMap((node) =>
            (Array.isArray(node?.meta_data) ? node.meta_data : [])
              .map((entry) => entry?.key)
              .filter((key) => typeof key === 'string'),
          ),
        ),
      ].sort(),
    });
  }

  const joins = plans.flatMap((plan) => plan.joins);
  const summary = readings(joins);
  console.log(`\n${String(joins.length)} joins in ${String(plans.filter((one) => one.joins.length > 0).length)} of ${String(plans.length)} plans`);
  console.log(`  tagged ${summary.joinTagsSeen.join(', ') || '(none)'}`);
  console.log(
    `  algorithms ${summary.algorithms.values.join(' | ') || '(none)'}; ` +
      `${String(summary.algorithms.withNone)} joins named none`,
  );
  console.log(
    `  build sides ${summary.buildSides.values.join(' | ') || '(none)'}; ` +
      `${String(summary.buildSides.withNone)} joins named none`,
  );
  console.log(
    `  ${String(summary.broadcastJoins)} broadcast joins, ${String(summary.otherJoins)} others; a size on ` +
      `${String(summary.anySizeOnOtherJoins.matching)}/${String(summary.anySizeOnOtherJoins.of)} of the others`,
  );
  for (const label of SIZE_METRICS) {
    const onBroadcast = summary.sizeOnBroadcasts[label];
    const onOther = summary.sizeOnOtherJoins[label];
    console.log(
      `    ${label.padEnd(34)} broadcasts ${String(onBroadcast.matching)}/${String(onBroadcast.of)}  ` +
        `others ${String(onOther.matching)}/${String(onOther.of)}  ` +
        `values ${summary.sizeValues[label].slice(0, 6).join(', ') || '(none)'}`,
    );
  }
  console.log(
    `  the walk reached the inputs of ${String(summary.producers.joinsWhereTheWalkArrived.matching)}/` +
      `${String(summary.producers.joinsWhereTheWalkArrived.of)} joins, two inputs on ` +
      `${String(summary.producers.joinsWithTwoProducers.matching)}; rows on ` +
      `${String(summary.producers.inputsWithRows.matching)}/${String(summary.producers.inputsWithRows.of)} inputs`,
  );
  console.log(`  producer size labels: ${summary.producers.producerSizeLabels.join(', ') || '(none)'}`);

  const payload = {
    runFinishedAt: new Date().toISOString(),
    ...corpusSettings,
    corpus: {
      statement: 'config/statements/workload_query_shapes.sql',
      shapesReturned: shapes.length,
      plansRead: plans.length,
      skipped,
    },
    joinTagPatterns: JOIN_TAGS.map(String),
    readings: summary,
    plansWithAJoin: plans.filter((plan) => plan.joins.length > 0).length,
    // Every tag across the corpus, so a join spelled in a way JOIN_TAGS missed is findable rather than absent.
    everyTag: [...new Set(plans.flatMap((plan) => plan.everyTag))].sort(),
    metaKeysSeen: [...new Set(plans.flatMap((plan) => plan.metaKeysSeen))].sort(),
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
