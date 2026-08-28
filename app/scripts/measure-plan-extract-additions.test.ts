import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  aroundSorts,
  costOf,
  edgeShape,
  endpointNames,
  extractLike,
  metaShape,
  namedMetrics,
  uncached,
} from './measure-plan-extract-additions.mjs';
import type { Cost, EdgeShape, Graph, MetaKeyShape, NamedMetric } from './measure-plan-extract-additions.d.mts';
import { extractPlan, selectGraph } from '../server/collect/sql/plans/parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURE = join(HERE, '..', 'server', 'collect', 'sql', 'plans', 'fixtures', 'json-plan.json');
const RECORDING = join(HERE, '..', 'server', 'collect', 'sql', 'runtime-baseline', 'labs-plan-extract-additions.json');

const SORTED = join(HERE, '..', 'server', 'collect', 'sql', 'plans', 'fixtures', 'sorted-plan.json');

interface Capture {
  readonly body: Parameters<typeof selectGraph>[0];
}

const capture = JSON.parse(readFileSync(CAPTURE, 'utf8')) as Capture;
const sorted = JSON.parse(readFileSync(SORTED, 'utf8')) as Capture;

interface Probe {
  readonly id: string;
  readonly edges: EdgeShape;
  readonly endpointNames: string | null;
  readonly sortMeta: Readonly<Record<string, MetaKeyShape>>;
  readonly namedMetrics: Readonly<Record<string, NamedMetric>>;
  readonly cost: Cost;
}

const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as {
  readonly candidateMetrics: Readonly<Record<string, readonly string[]>>;
  readonly endpointPairsTried: readonly string[];
  readonly probes: readonly Probe[];
};

/**
 * The recording held to the sentences written about it, because the write-up is where the numbers get quoted.
 *
 * `measure-plan-rule-inputs.test.ts` does the same for the same reason: a phase file saying "every endpoint
 * resolves" and a recording that has stopped saying so is how `33ia` came to publish a paragraph it had to
 * withdraw. These assert the shape of the claim rather than every figure — a re-run on a different estate will
 * move the byte counts, and a test that fails on that would be deleted rather than read — but each claim the
 * write-up rests a decision on has one here.
 */
describe('what the committed recording says', () => {
  it('measured all three probes', () => {
    expect(recording.probes.map((probe) => probe.id)).toEqual([
      'join-and-sort',
      'sort-without-limit',
      'shuffle-heavy',
    ]);
  });

  it('resolves every edge under from_id/to_id and none under the names already in the tree', () => {
    // The finding the row exists for. `capture-plan-fixtures.mjs` filters edges with `edge.source ?? edge.from`,
    // so the empty `edges` in the committed fixture is that filter's output; if a re-run ever resolves those,
    // the sentence in the phase file about the fixture stops being true and this fails.
    for (const probe of recording.probes) {
      expect(probe.endpointNames, probe.id).toBe('from_id/to_id');
      expect(probe.edges.resolution['from_id/to_id'].resolvedStrictly, probe.id).toBe(probe.edges.edges);
      expect(probe.edges.edges, probe.id).toBeGreaterThan(0);
      expect(probe.edges.fields, probe.id).toEqual(['from_id', 'to_id']);
      expect(probe.edges.nodeIdTypes, probe.id).toEqual(['string']);
      for (const pair of ['source/target', 'from/to', 'fromId/toId']) {
        expect(probe.edges.resolution[pair].edgesCarryingBoth, `${probe.id} ${pair}`).toBe(0);
      }
    }
  });

  it('carries SORT_ORDER as a values key on every probe, and on a top-k with no sort operator', () => {
    for (const probe of recording.probes) {
      expect(probe.sortMeta.SORT_ORDER?.spellings, probe.id).toEqual(['values']);
    }
    // The case a tag-based rule misses, held to the probe that produced it rather than to a comment.
    const topK = recording.probes.find((probe) => probe.id === 'join-and-sort');

    expect(topK?.sortMeta.SORT_ORDER.tags).toEqual(['UNKNOWN.PhotonTopK']);
    expect(topK?.sortMeta.SORT_ORDER.tags.some((tag) => /sort/i.test(String(tag)))).toBe(false);
  });

  it('separates the skew signal from the skew ratio, which is what 33id would otherwise threshold', () => {
    // Three probes with no skew designed into them. The ratio carries a number on all three and the two
    // partition-counting metrics carry zero on all three, so only the second pair can distinguish skew from
    // an ordinary shuffle. A re-run where that stops holding invalidates the paragraph, not just the figure.
    for (const probe of recording.probes) {
      expect(probe.namedMetrics['MapStage - Skew max to non-empty median ratio'].nonZero, probe.id).toBeGreaterThan(0);
      expect(probe.namedMetrics['MapStage - Skew num skewed partitions'].nonZero, probe.id).toBe(0);
      expect(probe.namedMetrics['MapStage - Skew skewed data size ratio'].nonZero, probe.id).toBe(0);
    }
  });

  it('costs the three additions separately, and none of them is the whole extract', () => {
    // The write-up's ranges — edges 17-20%, SORT_ORDER 1-7%, named metrics 31-44% — are what `33ic`'s "nothing
    // forces a choice" rests on. Asserted as an ordering and a ceiling rather than as the four figures, so a
    // re-run on another estate moves the numbers without failing, and a doubling of any of them does fail.
    for (const probe of recording.probes) {
      const { edges, sortOrder, namedMetrics: named, all } = probe.cost.added;

      expect(sortOrder.addedPercent, probe.id).toBeLessThan(edges.addedPercent);
      expect(edges.addedPercent, probe.id).toBeLessThan(named.addedPercent);
      expect(all.addedPercent, probe.id).toBeLessThan(100);
      expect(probe.cost.responseOverBaseline, probe.id).toBeGreaterThan(10);
    }
  });

  it('tried every endpoint pair the helper knows about, so a pair resolving nothing was actually asked', () => {
    // Without this the "resolves nothing" row of the write-up's table could be a pair the run never tried.
    for (const probe of recording.probes) {
      expect(Object.keys(probe.edges.resolution).sort(), probe.id).toEqual([...recording.endpointPairsTried].sort());
    }
  });
});

/**
 * The check that makes the size arithmetic worth reading.
 *
 * `extractLike` is `extractPlan` written a second time in JavaScript, because a `.mjs` script cannot import
 * the TypeScript one, and a reimplementation measuring its own baseline is the apparatus defect `H1` shipped
 * and had to withdraw: a real, reproducible number about a thing that does not exist. So the baseline every
 * percentage in the recording is a percentage *of* is held here against the parser the app actually stores
 * with, on the committed captures, byte for byte.
 *
 * `33ic` then added the three things to `extractPlan`, so the parser is no longer the baseline — it is the
 * baseline plus the additions. Rather than retire the check, the additions are subtracted back off below, which
 * makes it say something the original could not: the difference between the measured baseline and what the app
 * now stores is the three fields the row was measuring and the version that names them, and nothing else came
 * along with them.
 */
const withoutAdditions = (extract: ReturnType<typeof extractPlan>): unknown => ({
  ...extract,
  parserVersion: 'plan-parser-2',
  operators: extract.operators.map((operator) => {
    const { named: _named, meta, ...rest } = operator;
    // `meta` is omitted rather than emptied when the sort order was its only key, because that is what the
    // parser did before the key was promised, and an empty `meta` is a shape it never wrote.
    const kept = Object.fromEntries(Object.entries(meta ?? {}).filter(([key]) => key !== 'SORT_ORDER'));
    return { ...rest, ...(Object.keys(kept).length > 0 ? { meta: kept } : {}) };
  }),
  edges: undefined,
  edgesWithUnknownEndpoint: undefined,
});

describe('the baseline the additions are measured against', () => {
  it.each([['json-plan', capture], ['sorted-plan', sorted]] as const)(
    'is the parser’s own extract on %s, once 33ic’s three additions are taken back off',
    (_name, fixture) => {
      const graph = selectGraph(fixture.body).graph;

      // Through `JSON.parse(JSON.stringify(…))` on both sides: `undefined` is how a key is removed from a
      // spread, and it is dropped by serialisation rather than compared — which is the same operation the store
      // performs, so a field that survived here and not there would be caught by neither.
      expect(JSON.parse(JSON.stringify(extractLike(graph as Graph)))).toEqual(
        JSON.parse(JSON.stringify(withoutAdditions(extractPlan(graph)))),
      );
    },
  );

  it('grows for each addition and by their sum for all three together', () => {
    // Not a tautology: `all` is computed by one more call to the same builder rather than by adding the three
    // up, so a builder where an addition suppressed another — the `meta` key that only appears when non-empty
    // is the shape that could — would fail here.
    const graph = selectGraph(capture.body).graph as Graph;
    const cost = costOf(graph, 1_000_000, ['Hashed relation size']);
    const { edges, sortOrder, namedMetrics: named, all } = cost.added;

    expect(all.addedBytes).toBe(edges.addedBytes + sortOrder.addedBytes + named.addedBytes);
    expect(cost.baselineBytes).toBeGreaterThan(0);
    expect(cost.responseOverBaseline).toBeCloseTo(1_000_000 / cost.baselineBytes, 1);
  });
});

/**
 * What an edge is, on shapes the committed capture cannot show.
 *
 * The capture's `edges` is `[]`, which is the whole reason this row exists: `capture-plan-fixtures.mjs`
 * filtered them with `edge.source ?? edge.from` against `node.id`, and nothing recorded the count before the
 * filter, so the empty array is consistent with a wrong field name, a type mismatch on the ids, or a plan
 * with no edges. These fabricate each of the three, because the recording's `resolution` column is only
 * readable if the reading behind it distinguishes them.
 */
describe('reading an edge', () => {
  const nodes = [{ id: '1', tag: 'A' }, { id: '2', tag: 'B' }];

  it('separates a wrong field name from a type mismatch, which is the distinction the fixture cannot make', () => {
    const named: Graph = { nodes, edges: [{ source: '1', target: '2' }] };
    const numeric: Graph = { nodes, edges: [{ source: 1, target: 2 }] };

    expect(edgeShape(named).resolution['source/target']).toEqual({
      edgesCarryingBoth: 1,
      resolvedStrictly: 1,
      resolvedAfterCoercion: 1,
    });
    // The silent one. Both endpoints name a real operator, and a filter comparing them with `has` keeps
    // neither — which is how a fixture comes to carry no edges and say nothing about why.
    expect(edgeShape(numeric).resolution['source/target']).toEqual({
      edgesCarryingBoth: 1,
      resolvedStrictly: 0,
      resolvedAfterCoercion: 1,
    });
    expect(edgeShape(named).resolution['from/to']?.edgesCarryingBoth).toBe(0);
  });

  it('reports every field any edge carried, not the first edge’s', () => {
    const uneven: Graph = { nodes, edges: [{ source: '1', target: '2' }, { source: '2', target: '1', kind: 'shuffle' }] };

    expect(edgeShape(uneven).fields).toEqual(['kind', 'source', 'target']);
    expect(edgeShape(uneven).fieldTypes.kind).toEqual(['string']);
  });

  it('answers for a graph with no edges without claiming the names were wrong', () => {
    const none = edgeShape({ nodes, edges: [] });

    expect(none.edges).toBe(0);
    expect(none.resolution['source/target']).toEqual({
      edgesCarryingBoth: 0,
      resolvedStrictly: 0,
      resolvedAfterCoercion: 0,
    });
  });
});

/**
 * Which walk is which, on a graph small enough that the answer is arithmetic.
 *
 * The recording's own answer comes from a three-hop walk on a real plan and reads the same way: from a sort,
 * `alongTo` reaches a file scan and `alongFrom` reaches the result sink, so `from_id` points at the operator
 * that *produced* the rows. A rule that assumed the arrow was dataflow would read a sort's input as the thing
 * consuming it — which for `LARGE_SORT` means looking for a limiting reduction among the sort's own inputs.
 */
describe('walking the edges', () => {
  const chain: Graph = {
    nodes: [
      { id: '1', tag: 'Sink' },
      { id: '2', tag: 'PHOTON_SORT_EXEC' },
      { id: '3', tag: 'Filter' },
      { id: '4', tag: 'Scan' },
    ],
    edges: [
      { from_id: '1', to_id: '2' },
      { from_id: '2', to_id: '3' },
      { from_id: '3', to_id: '4' },
    ],
  };

  it('picks the endpoint pair that resolves rather than the first one tried', () => {
    expect(endpointNames(edgeShape(chain))).toBe('from_id/to_id');
  });

  it('reaches the producers one way and the consumers the other', () => {
    const [sort] = aroundSorts(chain, 'from_id/to_id');

    expect(sort.alongTo).toEqual(['Filter', 'Scan']);
    expect(sort.alongFrom).toEqual(['Sink']);
  });

  it('answers nothing rather than guessing when no pair resolved', () => {
    expect(endpointNames(edgeShape({ nodes: chain.nodes, edges: [{ source: 'a', target: 'b' }] }))).toBeNull();
    expect(aroundSorts(chain, null)).toEqual([]);
  });

  it('stops at the hop limit, so a deep plan does not report its whole self as adjacent', () => {
    const [sort] = aroundSorts(chain, 'from_id/to_id', 1);

    expect(sort.alongTo).toEqual(['Filter']);
  });
});

/** `33ih`'s finding, held to: which of the two fields carried the content is what gets recorded. */
describe('reading a SORT meta key', () => {
  it('records the spelling the content arrived in', () => {
    const graph: Graph = {
      nodes: [
        { id: '1', tag: 'Sort', meta_data: [{ key: 'SORT_ORDER', values: ['a ASC', 'b DESC'] }] },
        { id: '2', tag: 'Sort', meta_data: [{ key: 'SORT_IS_GLOBAL', value: 'true' }] },
        { id: '3', tag: 'Scan', meta_data: [{ key: 'SCAN_IDENTIFIER', value: 'main.t' }] },
      ],
    };

    const shape = metaShape(graph, /SORT/);

    expect(Object.keys(shape)).toEqual(['SORT_IS_GLOBAL', 'SORT_ORDER']);
    expect(shape.SORT_ORDER).toMatchObject({ spellings: ['values'], operators: 1, entries: 2 });
    expect(shape.SORT_IS_GLOBAL).toMatchObject({ spellings: ['value'], entries: 1 });
  });

  it('records the tags that carried it, because the key and the tag are different selectors', () => {
    // The case the recording found on labs: an `ORDER BY` with a `LIMIT` is planned as a top-k, which declares
    // a sort order and is not tagged as a sort. A rule selecting sorts by tag would not see this operator.
    const topK: Graph = {
      nodes: [{ id: '1', tag: 'UNKNOWN.PhotonTopK', meta_data: [{ key: 'SORT_ORDER', values: ['ms DESC'] }] }],
    };

    expect(metaShape(topK, /SORT/).SORT_ORDER.tags).toEqual(['UNKNOWN.PhotonTopK']);
  });
});

/**
 * The distinction `33ia` had to learn twice: a metric's label is present on plans with none of the thing it
 * names, so what decides whether a rule can be built is the value.
 */
describe('reading a named metric', () => {
  const graph: Graph = {
    nodes: [
      { id: '1', tag: 'Shuffle', metrics: [{ label: 'Hashed relation size', value: 0, key: 'UNKNOWN_KEY' }] },
      { id: '2', tag: 'Join', metrics: [{ label: 'Hashed relation size', value: 4096, key: 'UNKNOWN_KEY' }] },
    ],
  };

  it('counts the label and the value separately', () => {
    expect(namedMetrics(graph, ['Hashed relation size'])['Hashed relation size']).toMatchObject({
      carried: 2,
      nonZero: 1,
    });
  });

  it('says nothing about a label no operator carried', () => {
    expect(namedMetrics(graph, ['Aggressive BHJ Decision'])).toEqual({});
  });
});

describe('the apparatus', () => {
  it('makes each probe unique, because a cached execution has no plan', () => {
    const one = uncached('SELECT 1');
    const two = uncached('SELECT 1');

    expect(one).not.toBe(two);
    expect(one.endsWith('SELECT 1')).toBe(true);
  });
});
