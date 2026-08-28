// Reading a metric off an operator, and the two ways it can be absent.
//
// The behaviour the advisor document asks for at line 1438 — *"Rules emit evidence and do not claim missing
// metrics"* — is a property of these three functions, because nothing above them can restore a distinction they
// collapse. `33b` measured both spellings on one statement: 17 operators of 123 with no `key_metrics` object,
// and 3 with one whose three values are zero.

import { describe, expect, it } from 'vitest';
import {
  NAMED_METRICS,
  PARSER_VERSION,
  type KeyMetrics,
  type PlanExtract,
  type PlanOperator,
} from '../collect/sql/plans/parse.js';
import {
  exchangeBoundaries,
  joinsIn,
  metric,
  namedMetric,
  operatorsAfter,
  operatorsBefore,
  operatorsMatching,
  skewIn,
  sortsIn,
  widest,
} from './plan-metrics.js';

function operator(overrides: Partial<PlanOperator> = {}): PlanOperator {
  return { id: '1', tag: 'PHOTON_PROJECT_EXEC', ...overrides };
}

/** Every tag here is one `33ia` or `33id` recorded off a real plan, not a plausible spelling of one. */
function tagged(id: string, tag: string, keyMetrics?: KeyMetrics): PlanOperator {
  return { id, tag, ...(keyMetrics == null ? {} : { keyMetrics }) };
}

function extract(
  operators: readonly PlanOperator[],
  edges: readonly { from: string; to: string }[] = []
): PlanExtract {
  return {
    parserVersion: PARSER_VERSION,
    fingerprint: 'ffffffffffffffff',
    operatorCount: operators.length,
    operators,
    operatorsWithoutMetrics: operators.filter((one) => one.keyMetrics == null).length,
    operatorsWithZeroMetrics: operators.filter(
      (one) => one.keyMetrics != null && Object.values(one.keyMetrics).every((value) => value === 0)
    ).length,
    edges,
    edgesWithUnknownEndpoint: 0,
  };
}

describe('one metric off one operator', () => {
  it('answers the number that was recorded', () => {
    expect(metric(operator({ keyMetrics: { duration_ms: 111_499 } }), 'duration_ms')).toBe(111_499);
  });

  it('answers a recorded zero as zero', () => {
    // Not folded into absence. An operator that emitted nothing and an operator nobody instrumented are the
    // same number in the response, and only one of them is a measurement this app can report.
    expect(metric(operator({ keyMetrics: { duration_ms: 0 } }), 'duration_ms')).toBe(0);
  });

  it('answers nothing where the operator carried no metrics at all', () => {
    expect(metric(operator(), 'duration_ms')).toBeUndefined();
  });

  it('answers nothing for a metric the object omits', () => {
    // A `key_metrics` present with two of its three fields is what `33ia` recorded on several operators. The
    // missing one is missing, not zero.
    expect(metric(operator({ keyMetrics: { duration_ms: 5 } }), 'peak_memory_bytes')).toBeUndefined();
  });

  it('answers nothing for a value the platform sent as something other than a finite number', () => {
    // The type says `number` and describes a response nothing validates. A string or a NaN reaching a
    // `Finding`'s `value: number` would be rendered to a reader as evidence. Typed through `unknown` on the
    // way in, because that is what the response is: the assertion is the arrival, not a claim about the field.
    const arriving: unknown = { duration_ms: '111499' };

    expect(metric(operator({ keyMetrics: arriving as KeyMetrics }), 'duration_ms')).toBeUndefined();
    expect(metric(operator({ keyMetrics: { rows_num: Number.NaN } }), 'rows_num')).toBeUndefined();
  });
});

describe('selecting operators', () => {
  it('matches on the tag and not on the display name', () => {
    // `name` is presentation — the UDF operator's reads `Scalar U D F`, spaced by whatever produced it — and a
    // rule keyed on it would break on a rendering change with no behaviour change behind it.
    const udf = operator({ id: '7', tag: 'UNKNOWN.PhotonScalarUDF' });

    expect(operatorsMatching(extract([operator(), udf]), /udf/i)).toEqual([udf]);
  });

  it('answers nothing rather than everything for a plan with no operators', () => {
    expect(operatorsMatching(extract([]), /udf/i)).toEqual([]);
  });
});

describe('the widest value across operators', () => {
  it('answers the largest recorded', () => {
    const operators = [
      operator({ keyMetrics: { duration_ms: 10 } }),
      operator({ keyMetrics: { duration_ms: 400 } }),
      operator({ keyMetrics: { duration_ms: 7 } }),
    ];

    expect(widest(operators, 'duration_ms')).toBe(400);
  });

  it('skips the operators that carried nothing, and answers from the ones that did', () => {
    expect(widest([operator(), operator({ keyMetrics: { duration_ms: 3 } })], 'duration_ms')).toBe(3);
  });

  it('answers nothing for an empty set, rather than negative infinity', () => {
    // `Math.max()` of nothing is `-Infinity`, which is a number, would pass a finiteness check nowhere, and
    // would reach a reader as evidence. This is the whole reason the function exists.
    expect(widest([], 'duration_ms')).toBeUndefined();
    expect(widest([operator()], 'duration_ms')).toBeUndefined();
  });

  it('answers a zero where zero is what every operator recorded', () => {
    expect(widest([operator({ keyMetrics: { duration_ms: 0 } })], 'duration_ms')).toBe(0);
  });
});

describe('counting shuffle boundaries', () => {
  it('reads the two operators of a Photon boundary as one', () => {
    // The measurement the count rests on: `33id` found map stages and sinks equal in number on all 28 plans of
    // its corpus that carry an exchange at all, so the pair is one boundary rendered twice.
    const plan = extract([
      tagged('m', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
      tagged('s', 'UNKNOWN.PhotonShuffleExchangeSink'),
      tagged('p', 'PHOTON_PROJECT_EXEC'),
    ]);

    expect(exchangeBoundaries(plan)).toEqual({ boundaries: 1, unrecognisedExchanges: 0 });
  });

  it('matches both spellings of the sink, which differ by underscores and not by case', () => {
    // The fault `33id` found by deleting what looked like a duplicated pattern: `/SHUFFLE_EXCHANGE_SINK/i` does
    // not match `PhotonShuffleExchangeSink`, and a group whose pattern matches nothing looks exactly like a
    // group with nothing in it. Normalising removes the question, and this is what would notice its return.
    for (const tag of ['UNKNOWN.PhotonShuffleExchangeSink', 'PHOTON_SHUFFLE_EXCHANGE_SINK_EXEC']) {
      expect(exchangeBoundaries(extract([tagged('m', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'), tagged('s', tag)]))).toEqual({
        boundaries: 1,
        unrecognisedExchanges: 0,
      });
    }
  });

  it('takes the larger of the two halves, so an unpaired sink is a boundary rather than a rounding down', () => {
    const plan = extract([
      tagged('m', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
      tagged('s1', 'UNKNOWN.PhotonShuffleExchangeSink'),
      tagged('s2', 'UNKNOWN.PhotonShuffleExchangeSink'),
    ]);

    expect(exchangeBoundaries(plan).boundaries).toBe(2);
  });

  it('counts a query stage and a reused exchange once each', () => {
    const plan = extract([tagged('q', 'SHUFFLE_QUERY_STAGE_EXEC'), tagged('r', 'REUSED_EXCHANGE_EXEC')]);

    expect(exchangeBoundaries(plan).boundaries).toBe(2);
  });

  it('counts the non-Photon shuffle exchange whole, and not as a sink', () => {
    // `SHUFFLE_EXCHANGE_EXEC` is the one exchange tag in `33id`'s corpus that matched none of Photon's four
    // spellings, and the sink's pattern contains it as a prefix — so the classification order is load-bearing
    // and this is what holds it. Read as a sink, seven pairs and one of these would count as seven.
    const plan = extract([tagged('x', 'SHUFFLE_EXCHANGE_EXEC')]);

    expect(exchangeBoundaries(plan)).toEqual({ boundaries: 1, unrecognisedExchanges: 0 });
    expect(
      exchangeBoundaries(
        extract([
          tagged('m', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
          tagged('s', 'UNKNOWN.PhotonShuffleExchangeSink'),
          tagged('x', 'SHUFFLE_EXCHANGE_EXEC'),
        ])
      ).boundaries
    ).toBe(2);
  });

  it('counts a broadcast exchange apart, because it is the opposite of this finding', () => {
    // A broadcast is what a `BROADCAST_CANDIDATE` recommendation asks for. Folded into the boundary count, the
    // rule would fire on the plan that took the advice.
    const plan = extract([tagged('b', 'PHOTON_BROADCAST_EXCHANGE_EXEC'), tagged('c', 'UNKNOWN.PhotonBroadcastExchange')]);

    expect(exchangeBoundaries(plan)).toEqual({ boundaries: 0, unrecognisedExchanges: 2 });
  });

  it('reads a plan with no exchanges as none rather than as unknown', () => {
    expect(exchangeBoundaries(extract([operator()]))).toEqual({ boundaries: 0, unrecognisedExchanges: 0 });
    expect(exchangeBoundaries(extract([]))).toEqual({ boundaries: 0, unrecognisedExchanges: 0 });
  });
});

describe('walking the graph after an operator', () => {
  /*
   * A chain of four in the response's own direction: `from` consumes, `to` produced.
   *
   * `33ii` measured it and `33id` held it over 36 plans — from a scan, following this direction reaches the
   * root, and from a sort it reaches almost nothing. A walk the other way answers a different question with a
   * plausible number, which is why the direction is a test rather than a comment.
   */
  const chain = extract(
    [
      tagged('scan', 'PHOTON_SCAN_EXEC'),
      tagged('shuffle', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
      tagged('sort', 'PHOTON_SORT_EXEC'),
      tagged('result', 'PHOTON_RESULT_STAGE_EXEC'),
    ],
    [
      { from: 'shuffle', to: 'scan' },
      { from: 'sort', to: 'shuffle' },
      { from: 'result', to: 'sort' },
    ]
  );

  it('reaches everything downstream of a scan and little downstream of a sort', () => {
    expect(operatorsAfter(chain, 'scan')?.map((one) => one.id)).toEqual(['shuffle', 'sort', 'result']);
    expect(operatorsAfter(chain, 'sort')?.map((one) => one.id)).toEqual(['result']);
  });

  it('does not include the operator itself', () => {
    expect(operatorsAfter(chain, 'result')).toEqual([]);
  });

  it('answers nothing at all where the extract carries no edges', () => {
    // An extract written before `plan-parser-3`, which is `undefined` rather than `[]`. A caller reading that as
    // "nothing follows" would report every sort in the retained store as unreduced.
    const older: PlanExtract = { ...chain, edges: undefined };

    expect(operatorsAfter(older, 'sort')).toBeUndefined();
  });

  it('answers an empty walk for a plan whose edges are empty', () => {
    expect(operatorsAfter(extract([operator()]), '1')).toEqual([]);
  });

  it('terminates on a cycle rather than walking it forever', () => {
    // A plan graph should be a DAG. A cycle here is an unbounded walk inside a synchronous analysis, which is a
    // hang rather than a wrong answer, so the guard is not a formality.
    const cyclic = extract([tagged('a', 'PHOTON_SORT_EXEC'), tagged('b', 'PHOTON_PROJECT_EXEC')], [
      { from: 'b', to: 'a' },
      { from: 'a', to: 'b' },
    ]);

    expect(operatorsAfter(cyclic, 'a')?.map((one) => one.id)).toEqual(['b']);
  });
});

describe('the sorts in a plan', () => {
  const sorted = (rows: number, after: readonly PlanOperator[], edges: readonly { from: string; to: string }[]) =>
    sortsIn(extract([tagged('so', 'PHOTON_SORT_EXEC', { rows_num: rows }), ...after], edges));

  it('finds a sort and says nothing limits it', () => {
    const readings = sorted(2_000_000, [tagged('r', 'PHOTON_RESULT_STAGE_EXEC')], [{ from: 'r', to: 'so' }]);

    expect(readings).toHaveLength(1);
    expect(readings?.[0].limitedDownstream).toBe(false);
    expect(readings?.[0].downstream).toBe(1);
  });

  it('finds the limit two operators downstream', () => {
    const readings = sorted(
      2_000_000,
      [tagged('p', 'PHOTON_PROJECT_EXEC'), tagged('l', 'UNKNOWN.PhotonLimit')],
      [
        { from: 'p', to: 'so' },
        { from: 'l', to: 'p' },
      ]
    );

    expect(readings?.[0].limitedDownstream).toBe(true);
  });

  it('does not read a limit that feeds the sort as one that follows it', () => {
    const readings = sorted(2_000_000, [tagged('l', 'UNKNOWN.PhotonLimit')], [{ from: 'so', to: 'l' }]);

    expect(readings?.[0].limitedDownstream).toBe(false);
  });

  it('excludes a top-k, which is a sort whose limit the planner already applied', () => {
    expect(sortsIn(extract([tagged('t', 'UNKNOWN.PhotonTopK')]))).toEqual([]);
    expect(sortsIn(extract([tagged('t', 'PHOTON_TAKE_ORDERED_AND_PROJECT_EXEC')]))).toEqual([]);
  });

  it('excludes a sort-merge join and a sort aggregate, whose tags contain the word', () => {
    // The design document's line 1017 is about exactly this trap for skew, and a `LARGE_SORT` finding on a
    // sort-merge join is the same mistake: it is a legitimate strategy, not evidence of anything.
    const plan = extract([
      tagged('j', 'PHOTON_SHUFFLED_SORT_MERGE_JOIN_EXEC'),
      tagged('a', 'UNKNOWN.PhotonSortAggregate'),
    ]);

    expect(sortsIn(plan)).toEqual([]);
  });

  it('answers nothing at all where the extract predates edges', () => {
    const plan = extract([tagged('so', 'PHOTON_SORT_EXEC')]);

    expect(sortsIn({ ...plan, edges: undefined })).toBeUndefined();
  });

  it('answers nothing at all where an edge led somewhere the extract has no operator', () => {
    // A walk that stops short reports "nothing reduces this sort" for a reason that is not a fact about the
    // query, so the whole plan is unreadable rather than partly readable. `parse.ts` counts them for this.
    const plan = extract([tagged('so', 'PHOTON_SORT_EXEC')]);

    expect(sortsIn({ ...plan, edgesWithUnknownEndpoint: 1 })).toBeUndefined();
  });
});

describe('one named metric off one operator', () => {
  const label = 'MapStage - Skew num skewed partitions';

  it('answers the number the response carried, including a zero', () => {
    // A zero here is the platform reporting no skewed partitions, which is the reading `DATA_SKEW` is built on.
    // Collapsing it into absence would throw away the signal — see `parse.ts` on why zeros are kept.
    expect(namedMetric(operator({ named: { [label]: 0 } }), label)).toBe(0);
    expect(namedMetric(operator({ named: { [label]: 3 } }), label)).toBe(3);
  });

  it('answers nothing where the operator carried no named metrics or not this one', () => {
    expect(namedMetric(operator(), label)).toBeUndefined();
    expect(namedMetric(operator({ named: { 'MapStage - Number of output rows': 5 } }), label)).toBeUndefined();
  });
});

describe('what a plan reported about skew', () => {
  const label = 'MapStage - Skew num skewed partitions';
  const ratio = 'MapStage - Skew max to non-empty median ratio';
  const size = 'MapStage - Skew skewed data size ratio';

  /**
   * Every label `plan-metrics.ts` selects on has to be one the parser keeps.
   *
   * The failure this catches is the one `bounds.ts` had: a name that never matches is indistinguishable from a
   * plan carrying nothing, so the rule loads, runs, never fires and never says why. The constants in
   * `plan-metrics.ts` are typed to `NamedMetricLabel`, which makes a misspelling a compile error there — this
   * asserts the same for the literals in this file, which are not.
   */
  it('reads labels the parser keeps', () => {
    for (const name of [label, ratio, size]) expect(NAMED_METRICS as readonly string[]).toContain(name);
  });

  const stage = (id: string, named: Readonly<Record<string, number>>): PlanOperator => ({
    id,
    tag: 'PHOTON_SHUFFLE_MAP_STAGE_EXEC',
    named,
  });

  it('reads the widest of each figure across the steps that carried it', () => {
    const reading = skewIn(
      extract([
        stage('m0', { [label]: 2, [ratio]: 4 }),
        stage('m1', { [label]: 7 }),
        // The size ratio is carried here and is not in the reading: zero on all 60 operators of `33id`'s
        // corpus says the platform sends it and nothing about its scale, and there is no honest way to render
        // a number that may be a share or may be a factor.
        stage('m2', { [label]: 0, [ratio]: 19, [size]: 0.5 }),
      ])
    );

    // Each figure is a separate maximum, so they may come off different steps — which is why the rule labels
    // each one as a widest rather than attributing the set of them to one step.
    expect(reading).toEqual({
      carrying: 3,
      worstPartitions: 7,
      reporting: 2,
      worstMaxToMedian: 19,
    });
  });

  it('reads zero on every step as carried and reporting nothing', () => {
    // The corpus as measured: 27 of 36 plans carry the counter, zero on all 60 operators of them. The reading
    // has to distinguish this from a plan that carried nothing, because only one of them is a measurement.
    expect(skewIn(extract([stage('m0', { [label]: 0 })]))).toEqual({
      carrying: 1,
      worstPartitions: 0,
      reporting: 0,
      worstMaxToMedian: undefined,
    });
  });

  it('answers nothing where no step carried the counter', () => {
    expect(skewIn(extract([tagged('p', 'PHOTON_PROJECT_EXEC')]))).toBeUndefined();
    // Carrying a different skew metric is not carrying this one: a plan reporting only the ratio has not been
    // told anything by adaptive execution about partitions, and the ratio is not the trigger.
    expect(skewIn(extract([stage('m0', { [ratio]: 19 })]))).toBeUndefined();
  });

  it('answers nothing where the extract predates named metrics', () => {
    // `plan-parser-2` kept none of them, so its silence is the parser's rather than the plan's — the same
    // distinction `metaIsReadable` draws for the promised keys, and for the same reason.
    const plan = extract([stage('m0', { [label]: 3 })]);

    expect(skewIn({ ...plan, parserVersion: 'plan-parser-2' })).toBeUndefined();
    expect(skewIn({ ...plan, parserVersion: 'plan-parser-1' })).toBeUndefined();
  });
});

describe('walking the graph before an operator', () => {
  it('reaches the immediate producers only, so a join’s two sides stay apart', () => {
    // The whole reason this is a separate walk from `operatorsAfter`. A transitive walk merges a join's two
    // subtrees, and the rule that reads it has to size *one side*.
    const plan = extract(
      [
        tagged('j', 'PHOTON_SHUFFLED_HASH_JOIN_EXEC'),
        tagged('a', 'PHOTON_SCAN_EXEC'),
        tagged('b', 'PHOTON_PROJECT_EXEC'),
        tagged('c', 'PHOTON_SCAN_EXEC'),
      ],
      [
        { from: 'j', to: 'a' },
        { from: 'j', to: 'b' },
        // `c` produces what `b` consumes, which is two steps from the join and not a side of it.
        { from: 'b', to: 'c' },
      ]
    );

    expect(operatorsBefore(plan, 'j')?.map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('does not read the operator an operator feeds as one that feeds it', () => {
    // The direction, as a test. `33ii` measured that `from` is the consumer, so a producer of `j` is an edge
    // whose `from` is `j`. Reversed, this returns the result stage and every row count would be the wrong one.
    const plan = extract(
      [tagged('j', 'PHOTON_SHUFFLED_HASH_JOIN_EXEC'), tagged('r', 'PHOTON_RESULT_STAGE_EXEC')],
      [{ from: 'r', to: 'j' }]
    );

    expect(operatorsBefore(plan, 'j')).toEqual([]);
  });

  it('answers nothing where the extract carries no edges at all', () => {
    const plan = extract([tagged('j', 'PHOTON_SHUFFLED_HASH_JOIN_EXEC')]);

    expect(operatorsBefore({ ...plan, edges: undefined }, 'j')).toBeUndefined();
  });
});

describe('the joins in a plan', () => {
  /** The two tags and two algorithm values `33ifb` measured over 13 joins. */
  const BROADCAST_TAG = 'PHOTON_BROADCAST_HASH_JOIN_EXEC';
  const BROADCAST_ALGORITHM = 'Photon Broadcast Hash';

  function join(
    tag: string,
    sides: readonly (number | undefined)[],
    algorithm?: readonly string[]
  ): PlanExtract {
    const operators: PlanOperator[] = [
      { id: 'j', tag, ...(algorithm == null ? {} : { meta: { JOIN_ALGORITHM: algorithm } }) },
      ...sides.map((rows, index) => ({
        id: `i${String(index)}`,
        tag: 'PHOTON_SCAN_EXEC',
        ...(rows == null ? {} : { keyMetrics: { rows_num: rows } }),
      })),
    ];
    return extract(
      operators,
      sides.map((_, index) => ({ from: 'j', to: `i${String(index)}` }))
    );
  }

  it('reads the narrower side off the inputs, which is the only size a plan carries here', () => {
    const [found] = joinsIn(join('PHOTON_SHUFFLED_HASH_JOIN_EXEC', [9, 4_000_000])) ?? [];

    expect(found?.narrowestInputRows).toBe(9);
    expect(found?.inputs).toHaveLength(2);
    expect(found?.broadcast).toBe(false);
  });

  it('answers no narrower side where one input carried no row count', () => {
    // The smaller of one known side and one unknown is not the known one. `33ifb` measured `rows_num` on 26 of
    // 26 inputs, so this is the guard rather than the case.
    const [found] = joinsIn(join('PHOTON_SHUFFLED_HASH_JOIN_EXEC', [9, undefined])) ?? [];

    expect(found?.narrowestInputRows).toBeUndefined();
  });

  it('reads a broadcast off the algorithm and off the tag, either alone', () => {
    // Two tells because they are two claims, and neither is redundant. A tag naming a join but not a broadcast,
    // whose algorithm says broadcast, is the case the tag alone misses — every join tag in `33ifb`'s corpus
    // happened to carry the word, and `PHOTON_HASH_JOIN_EXEC` is Photon's spelling of the one that does not.
    // A plan whose algorithm is missing is the case the algorithm alone misses.
    const byAlgorithm = joinsIn(join('PHOTON_HASH_JOIN_EXEC', [9, 9], [BROADCAST_ALGORITHM]));
    const byTag = joinsIn(join(BROADCAST_TAG, [9, 9]));

    expect(byAlgorithm?.[0]?.broadcast).toBe(true);
    expect(byTag?.[0]?.broadcast).toBe(true);
    // And a join that says neither is not one, which is what makes the two above worth asserting.
    expect(joinsIn(join('PHOTON_HASH_JOIN_EXEC', [9, 9], ['Photon Hash']))?.[0]?.broadcast).toBe(false);
  });

  it('claims every tag naming a join and nothing else, over the corpus’s own vocabulary', () => {
    // The wide pattern held against what it must and must not catch. A sort-merge join is a join and belongs
    // here — where `SORT_TAG` had to exclude it — and the operators around one do not.
    const found = joinsIn(
      extract([
        tagged('j0', BROADCAST_TAG),
        tagged('j1', 'PHOTON_BROADCAST_NESTED_LOOP_JOIN_EXEC'),
        tagged('j2', 'PHOTON_SHUFFLED_SORT_MERGE_JOIN_EXEC'),
        tagged('p', 'PHOTON_PROJECT_EXEC'),
        tagged('s', 'PHOTON_SORT_EXEC'),
        tagged('m', 'PHOTON_SHUFFLE_MAP_STAGE_EXEC'),
      ])
    );

    expect(found?.map((one) => one.operator.id)).toEqual(['j0', 'j1', 'j2']);
  });

  it('answers nothing where the extract predates the readable join keys', () => {
    // `plan-parser-1` stored `JOIN_ALGORITHM` as `[]` on every plan it read, so a caller that may not fire on a
    // broadcast cannot tell a broadcast from a join that named nothing.
    const plan = join('PHOTON_SHUFFLED_HASH_JOIN_EXEC', [9, 4_000_000]);

    expect(joinsIn({ ...plan, parserVersion: 'plan-parser-1' })).toBeUndefined();
    // And `plan-parser-2` is readable for this key, which is exactly what `33ih` changed.
    expect(joinsIn({ ...plan, parserVersion: 'plan-parser-2' })).toHaveLength(1);
  });

  it('answers nothing where the walk cannot be trusted', () => {
    const plan = join('PHOTON_SHUFFLED_HASH_JOIN_EXEC', [9, 4_000_000]);

    expect(joinsIn({ ...plan, edges: undefined })).toBeUndefined();
    expect(joinsIn({ ...plan, edgesWithUnknownEndpoint: 1 })).toBeUndefined();
  });

  it('answers an empty list for a plan with no join, rather than nothing', () => {
    // Distinct from the three refusals above: a plan with no join is a measurement, and a caller counting
    // "joins in the plan" needs the zero.
    expect(joinsIn(extract([tagged('p', 'PHOTON_PROJECT_EXEC')]))).toEqual([]);
  });
});
