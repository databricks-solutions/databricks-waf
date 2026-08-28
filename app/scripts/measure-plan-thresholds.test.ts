import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  directionCheck,
  distribution,
  exchangeReadings,
  metricsByLabel,
  sortsWithoutLimit,
  tagsById,
  widestGraph,
} from './measure-plan-thresholds.mjs';
import type { FixtureEdge, FixtureNode, Spread } from './measure-plan-thresholds.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline', 'labs-plan-thresholds.json');
const SORTED = join(HERE, '..', 'server', 'collect', 'sql', 'plans', 'fixtures', 'sorted-plan.json');

interface SkewReading {
  readonly carriedByPlans: number;
  readonly nonZeroPlans: number;
  readonly carryingOperators: number;
  readonly nonZeroOperators: number;
  readonly distinctNonZeroValues: readonly number[];
  readonly spread: Spread | null;
}

interface PlanReading {
  readonly operators: number;
  readonly msNow: number;
  readonly meanMs: number;
  readonly exchanges: {
    readonly counts: Readonly<Record<string, number>>;
    readonly readings: Readonly<Record<string, number>>;
    readonly mapStagesEqualSinks: boolean;
  };
  readonly skew: Readonly<Record<string, { readonly max: number; readonly nonZero: number }>>;
  readonly sorts: readonly { readonly limited: boolean; readonly peakMemoryBytes: number | null }[];
  readonly topKOperators: number;
  readonly direction: {
    readonly scanReachesAlongFrom: number | null;
    readonly sortReachesAlongFrom: number | null;
  };
}

const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as {
  readonly corpus: {
    readonly statement: string;
    readonly shapesReturned: number;
    readonly plansRead: number;
    readonly skipped: Readonly<Record<string, number>>;
  };
  readonly exchanges: Readonly<Record<string, Spread | null>>;
  readonly pairing: {
    readonly plansWithAnyExchange: number;
    readonly plansWhereMapStagesEqualSinks: number;
    readonly plansWithAnExchangeWhereMapStagesEqualSinks: number;
    readonly exchangeTagsOutsideTheFourGroups: number;
  };
  readonly jointly: Readonly<Record<string, number>>;
  readonly selectedByFloor: Readonly<Record<string, number>>;
  readonly shapesMeanOverAMinute: number;
  readonly shapesTotalOverAMinute: number;
  readonly longestMeanMs: number;
  readonly skewMetrics: Readonly<Record<string, SkewReading>>;
  readonly sorts: {
    readonly sorts: number;
    readonly plansWithASort: number;
    readonly sortsWithALimitDownstream: number;
    readonly sortsWithNothingDownstream: number;
    readonly sortsThatSpilled: number;
    readonly tagsSeen: readonly string[];
    readonly plansWithATopK: number;
    readonly topKOperators: number;
    readonly rows: Spread | null;
    readonly spilledBytes: Spread | null;
    readonly peakMemory: {
      readonly distinctAcrossSorts: readonly number[];
      readonly distinctAcrossEveryOperator: readonly number[];
      readonly smallestByRows: { readonly rows: number; readonly peak: number } | null;
      readonly largestByRows: { readonly rows: number; readonly peak: number } | null;
    };
  };
  readonly direction: {
    readonly plansWithAScanAndASort: number;
    readonly plansWhereScanReachesFurtherAlongFrom: number;
    readonly plansWhereSortReachesFurtherAlongFrom: number;
  };
  readonly plans: readonly PlanReading[];
};

const sorted = JSON.parse(readFileSync(SORTED, 'utf8')) as { readonly body: unknown };

/** A node with an id and a tag, which is all the readings here need. */
function node(id: string, tag: string, key?: Record<string, number>): FixtureNode {
  return key == null ? { id, tag } : { id, tag, key_metrics: key };
}

/** An edge in the response's own direction: `from` consumes what `to` produced. */
function edge(from: string, to: string): FixtureEdge {
  return { from_id: from, to_id: to };
}

describe('the four readings of an exchange boundary', () => {
  it('counts a Photon shuffle boundary once as a pair and twice as tags', () => {
    const reading = exchangeReadings([
      'PHOTON_SHUFFLE_MAP_STAGE_EXEC',
      'UNKNOWN.PhotonShuffleExchangeSink',
      'PHOTON_SCAN_EXEC',
    ]);
    expect(reading.readings.tags).toBe(2);
    expect(reading.readings.pairs).toBe(1);
    expect(reading.readings.mapStages).toBe(1);
    expect(reading.mapStagesEqualSinks).toBe(true);
  });

  it('counts a query stage and a reused exchange once under both readings', () => {
    const reading = exchangeReadings(['SHUFFLE_QUERY_STAGE_EXEC', 'REUSED_EXCHANGE_EXEC']);
    expect(reading.readings.tags).toBe(2);
    expect(reading.readings.pairs).toBe(2);
    expect(reading.readings.stages).toBe(1);
  });

  it('counts an exchange tag no probe produced rather than dropping it', () => {
    const reading = exchangeReadings(['SOMETHING_ELSE_EXCHANGE_EXEC']);
    expect(reading.counts.otherExchange).toBe(1);
    expect(reading.readings.tags).toBe(1);
    // Not in `pairs`: an unfamiliar exchange tag might be either half of a boundary, and counting it as a
    // whole one would inflate the reading the threshold is set on.
    expect(reading.readings.pairs).toBe(0);
  });

  it('recognises both spellings of the same operator, which differ by underscores and not by case', () => {
    // `/SHUFFLE_EXCHANGE_SINK/i` does not match `PhotonShuffleExchangeSink`, so a pattern per spelling was
    // needed until the tag was normalised — and dropping the second as duplicated case took the sink count to
    // zero while every reading still returned a number. See `spell`.
    expect(exchangeReadings(['UNKNOWN.PhotonShuffleExchangeSink']).counts.sink).toBe(1);
    expect(exchangeReadings(['PHOTON_SHUFFLE_EXCHANGE_SINK_EXEC']).counts.sink).toBe(1);
    expect(exchangeReadings(['UNKNOWN.PhotonShuffleMapStage']).counts.mapStage).toBe(1);
    expect(exchangeReadings(['UNKNOWN.ReusedExchange']).counts.reused).toBe(1);
    expect(exchangeReadings(['UNKNOWN.ShuffleQueryStage']).counts.queryStage).toBe(1);
    // And none of them falls through to the catch-all, which is what a first-match-wins object once decided.
    for (const tag of [
      'UNKNOWN.PhotonShuffleExchangeSink',
      'UNKNOWN.ReusedExchange',
      'UNKNOWN.ShuffleQueryStage',
    ]) {
      expect(exchangeReadings([tag]).counts.otherExchange).toBe(0);
    }
  });

  it('says a plan whose sinks outnumber its map stages is not paired', () => {
    const reading = exchangeReadings([
      'PHOTON_SHUFFLE_MAP_STAGE_EXEC',
      'UNKNOWN.PhotonShuffleExchangeSink',
      'UNKNOWN.PhotonShuffleExchangeSink',
    ]);
    expect(reading.mapStagesEqualSinks).toBe(false);
    // `pairs` takes the larger of the two, so an unpaired sink is a boundary rather than a rounding-down.
    expect(reading.readings.pairs).toBe(2);
  });
});

describe('a sort and what follows it', () => {
  it('finds no limit where the sort feeds a write', () => {
    const nodes = [node('1', 'PHOTON_SORT_EXEC'), node('2', 'PHOTON_WRITE_EXEC')];
    const [sort] = sortsWithoutLimit(nodes, [edge('2', '1')]);
    expect(sort.limited).toBe(false);
    expect(sort.downstreamOperators).toBe(1);
  });

  it('finds the limit where one is downstream, two operators away', () => {
    const nodes = [
      node('1', 'PHOTON_SORT_EXEC'),
      node('2', 'PHOTON_PROJECT_EXEC'),
      node('3', 'UNKNOWN.PhotonLimit'),
    ];
    const [sort] = sortsWithoutLimit(nodes, [edge('2', '1'), edge('3', '2')]);
    expect(sort.limited).toBe(true);
  });

  it('does not read a limit that is upstream of the sort as one that follows it', () => {
    const nodes = [node('1', 'PHOTON_SORT_EXEC'), node('2', 'UNKNOWN.PhotonLimit')];
    // The limit consumes the sort's *input*, so the sort still produces every row it was given.
    const [sort] = sortsWithoutLimit(nodes, [edge('1', '2')]);
    expect(sort.limited).toBe(false);
  });

  it('does not count a top-k as a sort with no limit, because it is a sort that already has one', () => {
    expect(sortsWithoutLimit([node('1', 'UNKNOWN.PhotonTopK')], [])).toEqual([]);
  });

  it('reads the sort’s own size off key_metrics, and null where it carries none', () => {
    const withKey = sortsWithoutLimit(
      [node('1', 'PHOTON_SORT_EXEC', { rows_num: 17010, peak_memory_bytes: 29360128, duration_ms: 4 })],
      [],
    );
    expect(withKey[0].rows).toBe(17010);
    expect(withKey[0].peakMemoryBytes).toBe(29360128);
    const without = sortsWithoutLimit([node('1', 'PHOTON_SORT_EXEC')], []);
    expect(without[0].rows).toBeNull();
    expect(without[0].peakMemoryBytes).toBeNull();
  });

  it('survives a cycle rather than walking it forever', () => {
    const nodes = [node('1', 'PHOTON_SORT_EXEC'), node('2', 'PHOTON_PROJECT_EXEC')];
    const [sort] = sortsWithoutLimit(nodes, [edge('2', '1'), edge('1', '2')]);
    expect(sort.downstreamOperators).toBe(1);
  });
});

describe('the direction check', () => {
  it('says a scan reaches further than a sort when `from` is the consumer', () => {
    const nodes = [
      node('1', 'PHOTON_SCAN_EXEC'),
      node('2', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
      node('3', 'PHOTON_SORT_EXEC'),
      node('4', 'PHOTON_RESULT_EXEC'),
    ];
    const edges = [edge('2', '1'), edge('3', '2'), edge('4', '3')];
    const check = directionCheck(nodes, edges);
    expect(check.scanReachesAlongFrom).toBe(3);
    expect(check.sortReachesAlongFrom).toBe(1);
    // Walked the other way the two swap, which is the whole point of reporting both.
    expect(check.scanReachesAlongTo).toBe(0);
    expect(check.sortReachesAlongTo).toBe(2);
  });

  it('reports null rather than a number where a plan has no scan', () => {
    const check = directionCheck([node('1', 'PHOTON_SORT_EXEC')], []);
    expect(check.scanReachesAlongFrom).toBeNull();
    expect(check.sortReachesAlongFrom).toBe(0);
  });
});

describe('the distribution', () => {
  it('reports values that occurred, and how many are at or above eight', () => {
    const spread = distribution([1, 1, 2, 5, 9, 10, 10]);
    expect(spread?.n).toBe(7);
    expect(spread?.min).toBe(1);
    expect(spread?.max).toBe(10);
    expect(spread?.atOrAboveEight).toBe(3);
    // Nearest-rank and exact, because every figure in the write-up's tables is one of these and an off-by-one
    // in the index is the one error a membership check could not see.
    expect(spread?.p50).toBe(5);
    expect(spread?.p90).toBe(10);
  });

  it('is null over nothing, rather than reporting -Infinity as a maximum', () => {
    expect(distribution([])).toBeNull();
  });
});

describe('the metric aggregation', () => {
  it('reports the widest reading and the operators it came from', () => {
    const nodes: FixtureNode[] = [
      { id: '1', tag: 'A', metrics: [{ label: 'ratio', value: 0 }] },
      { id: '2', tag: 'B', metrics: [{ label: 'ratio', value: 19 }] },
      { id: '3', tag: 'C', metrics: [{ label: 'ratio', value: 0 }] },
    ];
    const ratio = metricsByLabel(nodes).get('ratio');
    expect(ratio).toEqual({ max: 19, operators: 3, nonZero: 1 });
  });

  it('skips a metric with no numeric value rather than counting it as an operator', () => {
    const nodes: FixtureNode[] = [
      { id: '1', tag: 'A', metrics: [{ label: 'ratio', value: null }] },
      { id: '2', tag: 'B', metrics: [{ label: 'ratio', value: 2 }] },
    ];
    expect(metricsByLabel(nodes).get('ratio')).toEqual({ max: 2, operators: 1, nonZero: 1 });
  });
});

describe('the tag index', () => {
  it('counts the nodes with no id rather than collapsing them onto one key', () => {
    const { tagOf, nodesWithoutAnId } = tagsById([
      { id: '1', tag: 'PHOTON_SORT_EXEC' },
      { tag: 'PHOTON_PROJECT_EXEC' },
      { tag: 'PHOTON_FILTER_EXEC' },
    ]);
    expect(tagOf.size).toBe(1);
    expect(nodesWithoutAnId).toBe(2);
  });

  it('accepts a numeric id, which is what the response uses in places', () => {
    const { tagOf } = tagsById([{ id: 98, tag: 'PHOTON_SORT_EXEC' }]);
    expect(tagOf.get('98')).toBe('PHOTON_SORT_EXEC');
  });
});

describe('the graph selection', () => {
  it('reads the widest graph out of a real capture, as the parser does', () => {
    const widest = widestGraph(sorted.body);
    expect(widest?.nodes).toBeGreaterThan(0);
    expect(widest?.graph.nodes?.length).toBe(widest?.nodes);
  });

  it('returns null rather than throwing on a body with no plans', () => {
    expect(widestGraph({})).toBeNull();
    expect(widestGraph(null)).toBeNull();
    expect(widestGraph({ plans: { one: 'not json' } })).toBeNull();
  });
});

/**
 * The recording held to the sentences written about it, for the reason `measure-plan-extract-additions.test.ts`
 * gives: the phase file quotes these figures and a decision rests on each. Asserted as the shape of the claim
 * rather than the exact number, because a re-run on another estate moves every count — but a claim that has
 * stopped holding fails here rather than being noticed a phase later.
 */
describe('what the committed recording says', () => {
  it('measured over the app’s own statement rather than a query written here', () => {
    expect(recording.corpus.statement).toBe('config/statements/workload_query_shapes.sql');
    expect(recording.corpus.plansRead).toBeGreaterThan(20);
    expect(recording.corpus.plansRead).toBeLessThanOrEqual(recording.corpus.shapesReturned);
  });

  it('found map stages and sinks equal on every plan that has an exchange, and says how many that is', () => {
    // Not `plansRead`: a plan with no exchange satisfies "equal" at zero, so the wider number is vacuous on
    // exactly the plans that carry no evidence either way. Review found this reading asserted as 36 of 36.
    expect(recording.pairing.plansWithAnExchangeWhereMapStagesEqualSinks).toBe(
      recording.pairing.plansWithAnyExchange,
    );
    expect(recording.pairing.plansWithAnyExchange).toBeGreaterThan(recording.corpus.plansRead / 2);
  });

  it('found one exchange tag outside the four groups, which is what `pairs` cannot see', () => {
    // Small, and not zero: `pairs` is a reading of Photon's spellings and the write-up says so.
    expect(recording.pairing.exchangeTagsOutsideTheFourGroups).toBeGreaterThan(0);
    expect(recording.pairing.exchangeTagsOutsideTheFourGroups).toBeLessThan(5);
  });

  it('found the tag reading selects a plan the pair reading does not, at a threshold of eight', () => {
    // The double-count, as a number: eight tags is four or five boundaries.
    expect(recording.exchanges.tags?.atOrAboveEight ?? 0).toBeGreaterThan(
      recording.exchanges.pairs?.atOrAboveEight ?? 0,
    );
    // And the plan it adds is under the threshold on the reading the write-up recommends.
    const added = recording.plans.filter(
      (plan) => plan.exchanges.readings.tags >= 8 && plan.exchanges.readings.pairs < 8,
    );
    expect(added).toHaveLength(1);
    expect(added[0].exchanges.readings.pairs).toBe(5);
  });

  it('found a gap around eight, so a floor of six through nine selects the same plans', () => {
    // The whole argument for accepting the design's number rather than deriving one. A floor inside a gap does
    // not have to be exactly right, and this is the sentence that says the gap is there.
    const floors = recording.selectedByFloor;
    expect(floors['6']).toBe(floors['9']);
    expect(floors['7']).toBe(floors['9']);
    expect(floors['8']).toBe(floors['9']);
    expect(floors['5']).toBeGreaterThan(floors['8']);
    expect(floors['10']).toBeLessThan(floors['8']);
    expect(floors['8']).toBe(recording.exchanges.pairs?.atOrAboveEight);
  });

  it('found eight pairs selects the top of the distribution rather than none of it or most of it', () => {
    const pairs = recording.exchanges.pairs;
    expect(pairs).not.toBeNull();
    expect(pairs?.atOrAboveEight).toBeGreaterThan(0);
    expect(pairs?.atOrAboveEight).toBeLessThan(Math.ceil((pairs?.n ?? 0) / 4));
    // And the reading the platform's own stage count would give is unusable: zero on all but one plan.
    expect(recording.exchanges.stages?.atOrAboveEight).toBe(0);
    expect(recording.exchanges.stages?.max).toBe(1);
    expect(recording.plans.filter((plan) => plan.exchanges.readings.stages > 0)).toHaveLength(1);
  });

  it('found no shape whose mean run is over a minute, so the duration half is unexercised here', () => {
    expect(recording.shapesMeanOverAMinute).toBe(0);
    expect(recording.longestMeanMs).toBeLessThan(60000);
    // The floor the shipped rules use selects a real part of the corpus, which is why `33ie` uses that one.
    expect(recording.shapesTotalOverAMinute).toBeGreaterThan(0);
    // So the joint count is zero on every reading, and that is a limit of the estate rather than of the rule.
    for (const count of Object.values(recording.jointly)) expect(count).toBe(0);
  });

  it('skipped only the two classes 33h measured as predictable', () => {
    expect(Object.keys(recording.corpus.skipped).sort()).toEqual([
      'not-warehouse-compute',
      'warehouse-outside-workspace',
    ]);
  });

  it('found exactly three skew metrics zero on every plan and operator that carried one', () => {
    const zeroEverywhere = Object.entries(recording.skewMetrics)
      .filter(([, one]) => one.carriedByPlans > 0 && one.nonZeroPlans === 0)
      .map(([label]) => label);
    expect(zeroEverywhere).toEqual([
      'MapStage - Skew num skewed partitions',
      'MapStage - Skew skewed data size ratio',
      'AQEShuffleRead - Skew handled by',
    ]);
    // Per operator as well as per plan, which is what makes the per-plan maximum safe to trigger on.
    for (const label of zeroEverywhere) expect(recording.skewMetrics[label].nonZeroOperators).toBe(0);
  });

  it('found the pair 33ii named carried by the same plans, which is why both are the trigger', () => {
    const one = recording.skewMetrics['MapStage - Skew num skewed partitions'];
    const two = recording.skewMetrics['MapStage - Skew skewed data size ratio'];
    expect(two.carriedByPlans).toBe(one.carriedByPlans);
    // And the corroborating third is a subset rather than an equal, which is why it is not the condition.
    expect(recording.skewMetrics['AQEShuffleRead - Skew handled by'].carriedByPlans).toBeLessThan(
      one.carriedByPlans,
    );
  });

  it('found the trigger absent from nine plans, eight of which have no exchange at all', () => {
    const label = 'MapStage - Skew num skewed partitions';
    const without = recording.plans.filter((plan) => !(label in plan.skew));
    expect(without).toHaveLength(recording.corpus.plansRead - recording.skewMetrics[label].carriedByPlans);
    // The distinction the write-up rests on: absence follows from having nothing to shuffle, except once.
    expect(without.filter((plan) => plan.exchanges.readings.tags === 0)).toHaveLength(without.length - 1);
  });

  it('found the marker `33ia` warned about non-zero on most of the plans that carry it, at 1 and 2', () => {
    const adp = recording.skewMetrics['ShuffleQueryStage - Adp reduce-side skew threshold met'];
    expect(adp.carriedByPlans).toBeGreaterThan(0);
    expect(adp.nonZeroPlans * 2).toBeGreaterThan(adp.carriedByPlans);
    // Not "every non-zero value is 2", which is what the write-up said until this assertion existed.
    expect(adp.distinctNonZeroValues).toEqual([1, 2]);
  });

  it('found the ratio non-zero on most plans and operators, which is why it is not the trigger', () => {
    const ratio = recording.skewMetrics['MapStage - Skew max to non-empty median ratio'];
    expect(ratio.nonZeroPlans * 2).toBeGreaterThan(ratio.carriedByPlans);
    expect(ratio.nonZeroOperators * 2).toBeGreaterThan(ratio.carryingOperators);
    // The design's screening value is 10, and the corpus reaches it rarely rather than never.
    expect(ratio.spread?.max).toBeGreaterThanOrEqual(10);
    expect(ratio.spread?.p90).toBeLessThan(10);
    expect(ratio.distinctNonZeroValues.filter((value) => value >= 10)).toHaveLength(1);
  });

  it('found two labels absent from the corpus altogether', () => {
    const absent = Object.entries(recording.skewMetrics)
      .filter(([, one]) => one.carriedByPlans === 0)
      .map(([label]) => label);
    expect(absent).toEqual([
      'AQEShuffleRead - Number of skewed partitions',
      'AQEShuffleRead - Number of skewed partition splits',
    ]);
  });

  it('found no sort with a limit after it, so the graph condition alone selects every sort', () => {
    expect(recording.sorts.sorts).toBeGreaterThan(0);
    expect(recording.sorts.plansWithASort).toBeGreaterThan(0);
    expect(recording.sorts.sortsWithALimitDownstream).toBe(0);
    // And none with nothing after it, so the count above is a reading of the graph rather than of an edge list
    // that stopped early.
    expect(recording.sorts.sortsWithNothingDownstream).toBe(0);
    // Every sort is one tag, which is what the narrowed SORT_TAGS caught. A second tag here means the pattern
    // now matches something else and the counts above are about a different population.
    expect(recording.sorts.tagsSeen).toEqual(['PHOTON_SORT_EXEC']);
  });

  it('found top-k operators in the same corpus, which is why that zero is partly the planner', () => {
    expect(recording.sorts.topKOperators).toBeGreaterThan(0);
    expect(recording.sorts.plansWithATopK).toBeGreaterThan(0);
    expect(recording.plans.reduce((total, plan) => total + plan.topKOperators, 0)).toBe(
      recording.sorts.topKOperators,
    );
  });

  it('found nothing spilled, so spill cannot narrow the sorts either', () => {
    expect(recording.sorts.sortsThatSpilled).toBe(0);
    // Over every sort rather than over the ones that happened to carry a spill metric: a recording where the
    // metric went missing would otherwise report no spill for the wrong reason.
    expect(recording.sorts.spilledBytes?.n).toBe(recording.sorts.sorts);
  });

  it('found a sort’s peak memory takes two values while its rows span four orders of magnitude', () => {
    const peak = recording.sorts.peakMemory;
    expect(peak.distinctAcrossSorts).toHaveLength(2);
    // Not merely unrelated to the rows: inverted. The narrowest sort reads the larger of the two values.
    expect(peak.smallestByRows?.peak).toBe(peak.distinctAcrossSorts[1]);
    expect(peak.largestByRows?.peak).toBe(peak.distinctAcrossSorts[0]);
    expect(recording.sorts.rows?.max ?? 0).toBeGreaterThan((recording.sorts.rows?.p50 ?? 0) * 100);
    // And the field is not flat in general, which is what stops "an allocation" being asserted of the field.
    expect(peak.distinctAcrossEveryOperator.length).toBeGreaterThan(50);
  });

  it('confirmed the edge direction the walk assumes, on every plan with both ends', () => {
    expect(recording.direction.plansWithAScanAndASort).toBeGreaterThan(0);
    expect(recording.direction.plansWhereScanReachesFurtherAlongFrom).toBe(
      recording.direction.plansWithAScanAndASort,
    );
    expect(recording.direction.plansWhereSortReachesFurtherAlongFrom).toBe(0);
  });

  it('kept a per-plan row for every plan it read, so a figure above can be traced to one', () => {
    expect(recording.plans).toHaveLength(recording.corpus.plansRead);
    for (const plan of recording.plans) expect(plan.operators).toBeGreaterThan(0);
  });

  /*
   * The apparatus check on the recording itself: every summary block recomputed from the rows it was summarised
   * from, with the script's own `distribution`.
   *
   * The last test says the per-plan rows are there so a figure can be traced to one, and until this existed
   * nothing traced anything. A hand-edited summary, a mis-aggregation, or a re-run that wrote one half of the
   * file would all have passed. `runtime-baseline.test.ts` recomputes its medians for the same reason.
   */
  it('summarises the rows it shipped, recomputed rather than trusted', () => {
    for (const reading of ['tags', 'pairs', 'mapStages', 'stages']) {
      expect(distribution(recording.plans.map((plan) => plan.exchanges.readings[reading]))).toEqual(
        recording.exchanges[reading],
      );
    }
    expect(recording.plans.filter((plan) => plan.exchanges.readings.tags > 0)).toHaveLength(
      recording.pairing.plansWithAnyExchange,
    );
    expect(recording.plans.filter((plan) => plan.exchanges.mapStagesEqualSinks)).toHaveLength(
      recording.pairing.plansWhereMapStagesEqualSinks,
    );
    for (const [floor, count] of Object.entries(recording.selectedByFloor)) {
      expect(recording.plans.filter((plan) => plan.exchanges.readings.pairs >= Number(floor))).toHaveLength(
        count,
      );
    }
    for (const [label, one] of Object.entries(recording.skewMetrics)) {
      const carried = recording.plans.filter((plan) => label in plan.skew);
      expect(carried).toHaveLength(one.carriedByPlans);
      expect(carried.filter((plan) => plan.skew[label].max !== 0)).toHaveLength(one.nonZeroPlans);
      expect(distribution(carried.map((plan) => plan.skew[label].max))).toEqual(one.spread);
    }
    const allSorts = recording.plans.flatMap((plan) => plan.sorts);
    expect(allSorts).toHaveLength(recording.sorts.sorts);
    expect(allSorts.filter((sort) => sort.limited)).toHaveLength(recording.sorts.sortsWithALimitDownstream);
  });
});
