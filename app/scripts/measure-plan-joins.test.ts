import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { distinctly, isBroadcast, joinsIn, metaValues, metricsOf, readings } from './measure-plan-joins.mjs';
import type { JoinReading, JoinReadings } from './measure-plan-joins.d.mts';
import type { FixtureEdge, FixtureNode } from './plan-corpus.d.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline', 'labs-plan-joins.json');

const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as {
  readonly corpus: {
    readonly statement: string;
    readonly shapesReturned: number;
    readonly plansRead: number;
  };
  readonly readings: JoinReadings;
  readonly plansWithAJoin: number;
  readonly everyTag: readonly string[];
  readonly plans: readonly { readonly joins: readonly JoinReading[] }[];
};

/** An edge in the response's own direction: `from` consumes what `to` produced. */
function edge(from: string, to: string): FixtureEdge {
  return { from_id: from, to_id: to };
}

function joinNode(id: string, algorithm: string, side: string, sizes: Record<string, number> = {}): FixtureNode {
  return {
    id,
    tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC',
    meta_data: [
      { key: 'JOIN_ALGORITHM', value: algorithm },
      { key: 'JOIN_BUILD_SIDE', value: side },
    ],
    metrics: Object.entries(sizes).map(([label, value]) => ({ label, value })),
  };
}

describe('what a join operator carries', () => {
  it('reads the algorithm and the build side off meta_data', () => {
    const [found] = joinsIn([joinNode('1', 'Photon Broadcast Hash', 'Right')], []);
    expect(found.algorithm).toEqual(['Photon Broadcast Hash']);
    expect(found.buildSide).toEqual(['Right']);
  });

  it('drops an empty meta value rather than reading it as a named side', () => {
    // `33ih` left extracts whose `JOIN_BUILD_SIDE` is `['']` because the parser read the wrong spelling, and
    // "named no side" and "named the empty string" have to be the same reading here or the count is wrong.
    const node: FixtureNode = {
      id: '1',
      tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC',
      meta_data: [{ key: 'JOIN_BUILD_SIDE', value: '' }],
    };
    expect(metaValues(node, 'JOIN_BUILD_SIDE')).toEqual([]);
    expect(joinsIn([node], [])[0].buildSide).toEqual([]);
  });

  it('accepts a meta entry whose value is a list, which is one of the two spellings', () => {
    const node: FixtureNode = { id: '1', tag: 'JOIN', meta_data: [{ key: 'JOIN_ALGORITHM', value: ['A', 'B'] }] };
    expect(metaValues(node, 'JOIN_ALGORITHM')).toEqual(['A', 'B']);
  });

  it('keeps a size of zero, which is what two of the three metrics turned out to be', () => {
    // A metric present and zero is the finding, so reading it as absent would erase it. See `33ifa`.
    const [found] = joinsIn([joinNode('1', 'Photon Broadcast Hash', 'Right', { 'Aggressive BHJ Decision': 0 })], []);
    expect(found.sizes).toEqual({ 'Aggressive BHJ Decision': 0 });
  });

  it('skips a metric with no numeric value rather than recording it as a size', () => {
    const node: FixtureNode = {
      id: '1',
      tag: 'JOIN',
      metrics: [{ label: 'Hashed relation size', value: null }],
    };
    expect(metricsOf(node)).toEqual({});
    expect(joinsIn([node], [])[0].sizes).toEqual({});
  });

  it('finds a join by tag where the algorithm is missing, so a plan can say it named none', () => {
    const [found] = joinsIn([{ id: '1', tag: 'SORT_MERGE_JOIN_EXEC' }], []);
    expect(found.tag).toBe('SORT_MERGE_JOIN_EXEC');
    expect(found.algorithm).toEqual([]);
    expect(isBroadcast(found)).toBe(false);
  });
});

describe('the walk to a join’s inputs', () => {
  it('reaches both producers and reads what each carries', () => {
    const nodes: FixtureNode[] = [
      joinNode('1', 'Photon Broadcast Hash', 'Right'),
      { id: '2', tag: 'PHOTON_SCAN_EXEC', key_metrics: { rows_num: 3003 } },
      { id: '3', tag: 'UNKNOWN.PhotonShuffleExchangeSink', key_metrics: { rows_num: 2 } },
    ];
    const [found] = joinsIn(nodes, [edge('1', '2'), edge('1', '3')]);
    expect(found.producersFound).toBe(2);
    expect(found.inputs.map((input) => input.rows)).toEqual([3003, 2]);
  });

  it('takes the immediate producers only, not the whole subtree', () => {
    // A join's two inputs are its two producers, and the rule needs to size *one side*: a transitive walk
    // merges the sides and answers a question about the subtree that the sizing does not ask.
    const nodes: FixtureNode[] = [
      joinNode('1', 'Photon Broadcast Hash', 'Right'),
      { id: '2', tag: 'PHOTON_PROJECT_EXEC' },
      { id: '3', tag: 'PHOTON_SCAN_EXEC' },
    ];
    const [found] = joinsIn(nodes, [edge('1', '2'), edge('2', '3')]);
    expect(found.producersFound).toBe(1);
    expect(found.inputs[0].tag).toBe('PHOTON_PROJECT_EXEC');
  });

  it('says the walk did not arrive rather than that the inputs carry nothing', () => {
    const [found] = joinsIn([joinNode('1', 'Photon Broadcast Hash', 'Right')], []);
    expect(found.producersFound).toBe(0);
    expect(found.inputs).toEqual([]);
  });

  it('does not read a join’s consumer as one of its inputs', () => {
    // `from` is the consumer, measured in `33ii`. Reversed, this reads the operator the join feeds and would
    // report a plausible size for the wrong thing.
    const nodes: FixtureNode[] = [
      joinNode('1', 'Photon Broadcast Hash', 'Right'),
      { id: '2', tag: 'PHOTON_PROJECT_EXEC', key_metrics: { rows_num: 9 } },
    ];
    const [found] = joinsIn(nodes, [edge('2', '1')]);
    expect(found.producersFound).toBe(0);
  });

  it('names the labels on an input that could size it, rather than their values', () => {
    const nodes: FixtureNode[] = [
      joinNode('1', 'Photon Broadcast Hash', 'Right'),
      {
        id: '2',
        tag: 'PHOTON_SCAN_EXEC',
        metrics: [
          { label: 'Source - Num bytes read', value: 4096 },
          { label: 'Total time', value: 12 },
        ],
      },
    ];
    const [found] = joinsIn(nodes, [edge('1', '2')]);
    expect(found.inputs[0].sizeLabels).toEqual(['Source - Num bytes read']);
  });
});

describe('the readings, and the population behind each', () => {
  it('reports every count out of the population it came from', () => {
    const joins = joinsIn(
      [
        joinNode('1', 'Photon Broadcast Hash', 'Right', { 'Hashed relation size': 4325376 }),
        joinNode('2', 'Photon Shuffle Hash', 'Left'),
      ],
      [],
    );
    const found = readings(joins);
    expect(found.joins).toBe(2);
    expect(found.broadcastJoins).toBe(1);
    expect(found.otherJoins).toBe(1);
    // A share without its base is the reading that cannot be checked: 0 of 1 and 0 of 300 are different facts.
    expect(found.sizeOnOtherJoins['Hashed relation size']).toEqual({ of: 1, matching: 0 });
    expect(found.sizeOnBroadcasts['Hashed relation size']).toEqual({ of: 1, matching: 1 });
  });

  it('says a corpus with no non-broadcast join has none, rather than reporting a zero share', () => {
    const found = readings(joinsIn([joinNode('1', 'Photon Broadcast Hash', 'Right')], []));
    expect(found.otherJoins).toBe(0);
    expect(found.anySizeOnOtherJoins).toEqual({ of: 0, matching: 0 });
  });

  it('counts the joins that named no algorithm and those that named more than one', () => {
    expect(distinctly([['Photon Broadcast Hash'], [], ['A', 'B']])).toEqual({
      values: ['A', 'B', 'Photon Broadcast Hash'],
      withNone: 1,
      withMoreThanOne: 1,
    });
  });

  it('reads a broadcast off the algorithm’s own wording, either spelling of a broadcast join', () => {
    expect(isBroadcast({ algorithm: ['Photon Broadcast Nested Loop'] })).toBe(true);
    expect(isBroadcast({ algorithm: ['Photon Shuffle Hash'] })).toBe(false);
  });
});

/**
 * The recording held to the sentences written about it, as `measure-plan-thresholds.test.ts` does: `33ifb`'s
 * write-up quotes these figures and `33ifc`'s whole design rests on the first of them. Asserted as the shape of
 * the claim rather than the exact number, because a re-run on another estate moves every count — but a claim
 * that has stopped holding fails here rather than being noticed a phase later.
 */
describe('what the committed recording says', () => {
  it('measured over the app’s own statement rather than a query written here', () => {
    expect(recording.corpus.statement).toBe('config/statements/workload_query_shapes.sql');
    expect(recording.corpus.plansRead).toBeGreaterThan(20);
    expect(recording.corpus.plansRead).toBeLessThanOrEqual(recording.corpus.shapesReturned);
  });

  it('found joins, and says how many, because a reading over none says nothing', () => {
    expect(recording.readings.joins).toBeGreaterThan(0);
    expect(recording.plansWithAJoin).toBeGreaterThan(0);
    expect(recording.plansWithAJoin).toBeLessThan(recording.corpus.plansRead);
  });

  it('found every join in the corpus already broadcasting, which is what `33ifc` cannot calibrate against', () => {
    // The finding the row exists for. A rule about a join that should broadcast has no instance here of a join
    // that does not, so its threshold cannot be read off this corpus at any value.
    expect(recording.readings.otherJoins).toBe(0);
    expect(recording.readings.broadcastJoins).toBe(recording.readings.joins);
  });

  it('found both build sides, so `33ia`’s “only Right” was its sample and not the field', () => {
    expect(recording.readings.buildSides.values).toEqual(['Left', 'Right']);
    expect(recording.readings.buildSides.withNone).toBe(0);
  });

  it('found the hashed relation size does not track the rows, so it is not sizing the data', () => {
    const sized = recording.plans
      .flatMap((plan) => plan.joins)
      .filter((one) => 'Hashed relation size' in one.sizes && typeof one.rows === 'number');
    expect(sized.length).toBeGreaterThan(2);
    const widest = sized.reduce((one, two) => ((two.rows ?? 0) > (one.rows ?? 0) ? two : one));
    const narrowest = sized.reduce((one, two) => ((two.rows ?? 0) < (one.rows ?? 0) ? two : one));
    // The anti-correlation, as an assertion: the widest join by rows reports a *smaller* hash table than the
    // narrowest. A field that shrinks as the data grows is an allocation, which is `33id`'s `peak_memory_bytes`
    // finding again — and it is why `33ifc` cannot read "small enough to broadcast" off this metric.
    expect(widest.rows).toBeGreaterThan(narrowest.rows ?? 0);
    expect(widest.sizes['Hashed relation size']).toBeLessThan(narrowest.sizes['Hashed relation size']);
    // And it takes a handful of values across the whole corpus rather than one per join.
    expect(recording.readings.sizeValues['Hashed relation size'].length).toBeLessThan(6);
  });

  it('found the two BHJ metrics present and zero everywhere', () => {
    for (const label of ['Aggressive BHJ Extrapolated Size', 'Aggressive BHJ Decision']) {
      expect(recording.readings.sizeOnBroadcasts[label].matching).toBeGreaterThan(0);
      expect(recording.readings.sizeValues[label]).toEqual([0]);
    }
  });

  it('found the input rows on every input the walk reached, which is the one size that exists', () => {
    const { producers } = recording.readings;
    expect(producers.joinsWhereTheWalkArrived.matching).toBe(producers.joinsWhereTheWalkArrived.of);
    expect(producers.joinsWithTwoProducers.matching).toBe(producers.joinsWithTwoProducers.of);
    expect(producers.inputsWithRows.matching).toBe(producers.inputsWithRows.of);
  });

  it('says what the wide join pattern caught, so a join it missed is findable', () => {
    for (const tag of recording.readings.joinTagsSeen) expect(tag).toMatch(/JOIN/i);
    const tagsNamingAJoin = recording.everyTag.filter((tag) => /join/i.test(tag));
    expect([...recording.readings.joinTagsSeen].sort()).toEqual([...tagsNamingAJoin].sort());
  });
});
