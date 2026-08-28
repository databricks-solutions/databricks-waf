import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  extract as measuredExtract,
  planFingerprint as measuredFingerprint,
  widestGraph as measuredWidestGraph,
  type PlanGraph as MeasuredPlanGraph,
} from '../../../../scripts/measure-query-plans.mjs';
import {
  META_UNREADABLE_PARSER_VERSIONS,
  NAMED_METRICS,
  NAMED_METRICS_UNREADABLE_PARSER_VERSIONS,
  PARSER_VERSION,
  PROMISED_META_KEYS,
  extractPlan,
  interpretResponse,
  metaIsReadable,
  metaValues,
  namedMetricsAreReadable,
  parsePlanResponse,
  planFingerprint,
  selectGraph,
  type PlanGraph,
  type PlanMetaEntry,
  type PlanResponseBody,
  type PromisedMetaKey,
} from './parse.js';

interface Fixture {
  readonly _capture: {
    readonly synthetic?: boolean;
    readonly status: number;
    readonly trimmed?: boolean;
    readonly original?: {
      readonly graphEntries: number;
      readonly widestGraphKey: string;
      readonly widestGraphNodes: number;
      readonly distinctTags: readonly string[];
      readonly nodesKept: number;
      readonly edges: number;
      readonly edgesKept: number;
    };
  };
  readonly body: PlanResponseBody;
}

const load = (name: string): Fixture =>
  JSON.parse(readFileSync(join(__dirname, 'fixtures', `${name}.json`), 'utf8')) as Fixture;

const jsonPlan = load('json-plan');
const sortedPlan = load('sorted-plan');
const metricsOnly = load('metrics-only');
const emptyPlan = load('empty-plan');
const notRetrievable = load('not-retrievable');
const textOnly = load('text-only');

/**
 * The two captures that carry a graph, and what each is for.
 *
 * `json-plan` is the widest plan the estate ran, chosen by measuring rather than by assuming duration predicts
 * plan size. It has no sort in it, on every capture taken so far — so `sorted-plan` is produced by a statement
 * the capture script runs, sorting twice, because a promised key with no captured value is what let five of
 * them sit empty for a phase. Both are asserted over wherever the assertion is about the response's shape
 * rather than about one statement.
 */
const graphs = [
  { name: 'json-plan', fixture: jsonPlan, metaEntries: 55 },
  { name: 'sorted-plan', fixture: sortedPlan, metaEntries: 25 },
] as const;

describe('the captured responses, which is what the document asks the parser be tested against', () => {
  it('reads a plan out of the rung the app will ask for', () => {
    const parsed = parsePlanResponse(jsonPlan._capture.status, jsonPlan.body);
    expect(parsed.outcome).toBe('available');
    if (parsed.outcome !== 'available') return;
    expect(parsed.extract.operatorCount).toBeGreaterThan(10);
    expect(parsed.extract.parserVersion).toBe(PARSER_VERSION);
    expect(parsed.extract.fingerprint).toMatch(/^[0-9a-f]{16}$/);
  });

  it('finds the plan without knowing how many entries plans has, because that varies', () => {
    const original = jsonPlan._capture.original;
    expect(original).toBeDefined();
    const selected = selectGraph(jsonPlan.body);
    // The recorded capture had one wide graph among many near-empty ones. Selection is on width.
    expect(selected.index).toBe(original?.widestGraphKey);
    expect(selected.entries).toBe(original?.graphEntries);
    expect(selected.nodes).toBeGreaterThan(1);
  });

  it('reads every promised meta_data key off the captured plans, with the value the capture holds', () => {
    // This asserted that at least one key was seen and that every key seen was promised. Both held while five
    // of the six were stored as empty arrays: `SCAN_PARTITIONS` was the only list-shaped key of the six, it
    // satisfied "at least one" on its own, and an empty array is still a key that was seen. So the assertion
    // is per entry and on the value.
    //
    // Across both captures rather than one, because no single statement declares all seven keys: the estate's
    // widest plan has the joins and no sort, and the sorting statement has the sorts and no join. Per-fixture
    // counts below, and the union at the end, so a capture refresh that lost a key fails rather than narrowing
    // what the parser is proven against.
    const expected: Readonly<Record<PromisedMetaKey, RegExp>> = {
      SCAN_IDENTIFIER: /^system\.\w+\.\w+$/,
      JOIN_ALGORITHM: /^Photon Broadcast (Hash|Nested Loop)$/,
      JOIN_BUILD_SIDE: /^(Left|Right)$/,
      PARTITIONING_TYPE: /^(Single|Hash)$/,
      IS_PHOTON: /^(true|false)$/,
      SCAN_PARTITIONS: /^\w+$/,
      // A qualified column either way round — `…total_duration_ms DESC NULLS LAST`, `…statement_type ASC NULLS
      // FIRST` — and an unqualified `ms DESC NULLS LAST` where the sort is over a projection's own alias. All
      // three are in the captures, and an expression rather than a column reference would fail here.
      SORT_ORDER: /^[\w.]+ (ASC|DESC) NULLS (FIRST|LAST)$/,
    };

    const seen = new Set<string>();
    for (const { name, fixture, metaEntries } of graphs) {
      const parsed = parsePlanResponse(fixture._capture.status, fixture.body);
      if (parsed.outcome !== 'available') throw new Error(`${name}: expected a plan`);

      // Per entry, not per key. Aggregating every operator's values into one list per key and asking whether
      // *some* of them match is the same hole one level up: `IS_PHOTON` is on 40 operators in the wider
      // capture, and 39 of them could come back empty tomorrow with a per-key assertion still passing.
      let entries = 0;
      for (const operator of parsed.extract.operators) {
        for (const [key, values] of Object.entries(operator.meta ?? {})) {
          seen.add(key);
          entries += 1;
          const where = `${name}: ${key} on ${operator.tag}`;
          expect(values.length, `${where} carried no value`).toBeGreaterThan(0);
          for (const value of values) {
            expect(expected[key as PromisedMetaKey].test(value), `${where} read ${value}`).toBe(true);
          }
        }
      }
      // The count as well as the set, because both loops are silent on an empty capture. 55 is what the wider
      // one holds — `IS_PHOTON` on 40 operators, `PARTITIONING_TYPE` on 9, the two joins twice each, and the
      // scan's identifier and partitions once — and 25 the sorting one, whose five `SORT_ORDER` entries are on
      // a top-k, two windows and two sorts.
      expect(entries, name).toBe(metaEntries);
    }
    expect([...seen].sort()).toEqual([...PROMISED_META_KEYS].sort());
  });

  it('reads the sort order off an operator no rule would select by tag, which is why the key is kept', () => {
    // `33ii`'s finding, on the capture that produced it: an `ORDER BY … LIMIT` is planned as a top-k, and a
    // rule reaching for sorts by tag would not see the sort order this operator declares.
    const parsed = parsePlanResponse(sortedPlan._capture.status, sortedPlan.body);
    if (parsed.outcome !== 'available') throw new Error('expected a plan');
    const declaring = parsed.extract.operators.filter((operator) => operator.meta?.SORT_ORDER != null);

    expect(declaring.map((operator) => operator.tag).sort()).toEqual([
      'PHOTON_SORT_EXEC',
      'PHOTON_SORT_EXEC',
      'UNKNOWN.PhotonTopK',
      'UNKNOWN.PhotonWindow',
      'UNKNOWN.PhotonWindow',
    ]);
    expect(declaring.some((operator) => !/sort/i.test(operator.tag))).toBe(true);
  });

  it('reads the graph between the operators, on both captures', () => {
    // The field `33ic` added and `33ie` will walk. Held on both captures because the empty `edges` that
    // preceded this was a filter in the capture script matching nothing, and one fixture would not have said
    // so — `33ii` had to measure the response to find out.
    for (const { name, fixture } of graphs) {
      const parsed = parsePlanResponse(fixture._capture.status, fixture.body);
      if (parsed.outcome !== 'available') throw new Error(`${name}: expected a plan`);
      const ids = new Set(parsed.extract.operators.map((operator) => operator.id));
      // Not `?? []`: the field is optional because an extract read back from the store may predate it, and a
      // default here would let this pass on a parser that had stopped setting it.
      const edges = parsed.extract.edges;
      expect(edges, name).toBeDefined();
      if (edges == null) return;

      expect(edges.length, name).toBe(fixture._capture.original?.edgesKept);
      expect(edges.length, name).toBeGreaterThan(10);
      expect(parsed.extract.edgesWithUnknownEndpoint, name).toBe(0);
      for (const edge of edges) {
        expect(ids.has(edge.from), `${name}: ${edge.from}`).toBe(true);
        expect(ids.has(edge.to), `${name}: ${edge.to}`).toBe(true);
      }
    }
  });

  it('points an edge at the operator that produced the rows, which is the direction 33ie walks', () => {
    // The claim `PlanEdge` makes, held to the capture rather than only recorded in `33ii`. It decides the walk:
    // read as dataflow, a rule looking for what happens after a sort would search the sort's own inputs.
    const parsed = parsePlanResponse(sortedPlan._capture.status, sortedPlan.body);
    if (parsed.outcome !== 'available') throw new Error('expected a plan');
    const tagOf = new Map(parsed.extract.operators.map((operator) => [operator.id, operator.tag]));
    const reach = (start: string, along: 'from' | 'to'): readonly string[] => {
      const other = along === 'from' ? 'to' : 'from';
      const seen = new Set([start]);
      for (let frontier = [start]; frontier.length > 0; ) {
        const next = (parsed.extract.edges ?? [])
          .filter((edge) => frontier.includes(edge[other]) && !seen.has(edge[along]))
          .map((edge) => edge[along]);
        for (const id of next) seen.add(id);
        frontier = next;
      }
      return [...seen].slice(1).map((id) => tagOf.get(id) ?? '(gone)');
    };

    const sorts = parsed.extract.operators.filter((operator) => operator.tag === 'PHOTON_SORT_EXEC');
    expect(sorts.length).toBeGreaterThan(0);
    for (const sort of sorts) {
      // `to` reaches the leaves: the file scan is down there, and no sort reads its input from a result stage.
      expect(reach(sort.id, 'to'), sort.id).toContain('PHOTON_PARQUET_FILE_SCAN_EXEC');
      expect(reach(sort.id, 'to'), sort.id).not.toContain('RESULT_QUERY_STAGE_EXEC');
      // `from` reaches the root, and the root of a query is what returns its rows.
      expect(reach(sort.id, 'from'), sort.id).toContain('RESULT_QUERY_STAGE_EXEC');
      expect(reach(sort.id, 'from'), sort.id).not.toContain('PHOTON_PARQUET_FILE_SCAN_EXEC');
    }
  });

  it('reads every named metric it selects, and the captures between them carry all of it', () => {
    // Both directions, because only one of them can see the failure that matters. A metric is selected by its
    // display label — `33ia` measured that there is no stable key to select on — so a service that rewords one
    // silently stops producing it, and an assertion that every label read is on the list cannot notice. The
    // union over both captures equalling the list can: the reworded label leaves one side and not the other.
    //
    // It also catches the trim. `node.metrics` is capped to one entry, so a capture that capped before
    // selecting would leave the parser reading almost nothing here — which is what a fixture proving nothing
    // looks like from inside a passing test.
    const labels = new Set<string>();
    for (const { name, fixture } of graphs) {
      const parsed = parsePlanResponse(fixture._capture.status, fixture.body);
      if (parsed.outcome !== 'available') throw new Error(`${name}: expected a plan`);
      for (const operator of parsed.extract.operators) {
        for (const [label, value] of Object.entries(operator.named ?? {})) {
          labels.add(label);
          expect(Number.isFinite(value), `${name}: ${operator.tag} read ${label} as ${String(value)}`).toBe(true);
        }
      }
    }

    expect([...labels].sort()).toEqual([...NAMED_METRICS].sort());
  });

  it('reads a metric that measured zero on every plan, which is the case a threshold needs', () => {
    // Nine of the eighteen read zero on all three of `33ii`'s probes, and they are on the list because `33id`
    // measures thresholds from what was retained. If the captures carried only the nine with values, the list
    // above would be asserting eighteen labels against a corpus that proves nine.
    const parsed = parsePlanResponse(sortedPlan._capture.status, sortedPlan.body);
    if (parsed.outcome !== 'available') throw new Error('expected a plan');
    const values = parsed.extract.operators.flatMap((operator) => Object.values(operator.named ?? {}));

    expect(values).toContain(0);
    expect(values.some((value) => value > 0)).toBe(true);
  });

  it('keeps a metric that read zero, and drops one that did not read a number', () => {
    // The zero is the signal: `33ii` measured that the skew metrics which read zero where there is no skew are
    // the only ones a rule can use, so collapsing zero into absence throws the signal away. A non-number is
    // dropped instead of reproduced, which is the one place this parser does not keep what it found — the
    // alternative is a string in a `Finding`'s `value: number`.
    const extract = extractPlan({
      nodes: [
        {
          id: '1',
          tag: 'SHUFFLE',
          metrics: [
            { label: 'MapStage - Skew num skewed partitions', value: 0 },
            { label: 'Hashed relation size', value: 'unknown' },
            { label: 'Aggressive BHJ Decision', value: Number.NaN },
            { label: 'Time spent sorting data (in-memory only)', value: 42 },
          ],
        },
      ],
    });

    expect(extract.operators[0]?.named).toEqual({ 'MapStage - Skew num skewed partitions': 0 });
  });

  it('counts an edge naming an operator it does not have, rather than storing the name', () => {
    // A trimmed graph is the ordinary case for a fixture and a plan the platform truncated is a possible one.
    // Either way a walk that follows an id nothing answers to reports "nothing follows this sort", so the
    // dropped ones are counted where a rule can see them.
    const extract = extractPlan({
      nodes: [{ id: '1', tag: 'A' }, { id: '2', tag: 'B' }],
      edges: [{ from_id: '1', to_id: '2' }, { from_id: '2', to_id: '9' }, { from_id: '1' }, {}],
    });

    expect(extract.edges).toEqual([{ from: '1', to: '2' }]);
    expect(extract.edgesWithUnknownEndpoint).toBe(3);
  });

  it('coerces an endpoint that did not arrive as a string, because an operator id is coerced too', () => {
    // The failure mode this whole row came out of, one layer down: the capture script compared a string id
    // against a number and matched nothing. Here it would store `1` as an edge endpoint and `'1'` as the
    // operator, and every walk would come back empty.
    const extract = extractPlan({
      nodes: [{ id: 1, tag: 'A' }, { id: 2, tag: 'B' }],
      edges: [{ from_id: 1, to_id: 2 }],
    });

    expect(extract.edges).toEqual([{ from: '1', to: '2' }]);
    expect(extract.edgesWithUnknownEndpoint).toBe(0);
  });

  it('counts an endpoint that is neither a string nor a number, rather than stringifying it', () => {
    // The two shapes an id takes are the two `operators` coerces. Anything else is counted, because
    // `'[object Object]'` in an extract looks like an operator id and is one nothing answers to.
    const arriving = (edges: readonly Record<string, unknown>[]): PlanGraph => ({
      nodes: [{ id: '1', tag: 'A' }],
      edges,
    });

    expect(extractPlan(arriving([{ from_id: { id: '1' }, to_id: '1' }])).edges).toEqual([]);
    expect(extractPlan(arriving([{ from_id: { id: '1' }, to_id: '1' }])).edgesWithUnknownEndpoint).toBe(1);
    expect(extractPlan(arriving([{ from_id: Number.NaN, to_id: '1' }])).edgesWithUnknownEndpoint).toBe(1);
  });

  it('says a plan had no edges by carrying none, and an older extract by carrying nothing', () => {
    // Why `edges` needs no version deny-list where `named` and `SORT_ORDER` do: the field is set on every
    // extract this parser writes, so `[]` means the plan carried none and `undefined` means an extract written
    // before `plan-parser-3`. That distinction only holds while it is unconditional, which is what this asserts.
    expect(extractPlan({ nodes: [{ id: '1', tag: 'A' }] }).edges).toEqual([]);
    expect(extractPlan(null).edges).toEqual([]);
    expect(extractPlan({ nodes: [] }).edgesWithUnknownEndpoint).toBe(0);
  });

  it('carries one spelling per entry and never both, which is what the precedence rests on', () => {
    // metaValues answers `value` before `values`. That is only safe while no entry carries both, and an entry
    // that did would be read as its scalar with the list dropped and nothing saying so.
    const perFixture: Record<string, number> = {};
    for (const name of ['json-plan', 'sorted-plan', 'metrics-only', 'empty-plan', 'not-retrievable', 'text-only']) {
      perFixture[name] = 0;
      const walk = (value: unknown): void => {
        if (Array.isArray(value)) {
          for (const one of value) walk(one);
          return;
        }
        if (value == null || typeof value !== 'object') return;
        const record = value as Record<string, unknown>;
        if (Array.isArray(record.meta_data)) {
          for (const entry of record.meta_data as Record<string, unknown>[]) {
            perFixture[name] += 1;
            const both = entry.value !== undefined && entry.values !== undefined;
            expect(both, `${name}: ${String(entry.key)} carries value and values`).toBe(false);
          }
        }
        for (const one of Object.values(record)) walk(one);
      };
      walk(load(name).body);
    }
    const checked = Object.values(perFixture).reduce((total, count) => total + count, 0);
    // Non-vacuous: a capture refresh that dropped `meta_data` or nested it differently would leave this
    // walking six bodies and asserting nothing, while `metaValues`' docstring cites it as the reason the
    // precedence is safe. Per fixture as well as in total, because `json-plan`'s 154 entries clear any total
    // on their own — which is how `sorted-plan`'s 66, every `SORT_ORDER` among them, went unwalked at first.
    expect(perFixture['json-plan']).toBeGreaterThan(100);
    expect(perFixture['sorted-plan']).toBeGreaterThan(50);
    expect(checked).toBeGreaterThan(200);
  });

  it('reads a scalar meta entry and a list one, which is the defect 33ih fixed', () => {
    // The unit of it, apart from the capture: `value` and `values` are two spellings of the same field, and
    // reading one of them stores the other as empty.
    const extract = extractPlan({
      nodes: [
        {
          id: '1',
          tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC',
          meta_data: [
            { key: 'JOIN_ALGORITHM', label: 'Join algorithm', value: 'Photon Broadcast Hash' },
            { key: 'JOIN_BUILD_SIDE', label: 'Build side', value: 'Right' },
            { key: 'SCAN_PARTITIONS', label: 'Partition attributes', values: ['account_id', 'metastore_id'] },
            { key: 'OUTPUT', label: 'Output', values: ['not promised, not kept'] },
          ],
        },
      ],
    });
    expect(extract.operators[0]?.meta).toEqual({
      JOIN_ALGORITHM: ['Photon Broadcast Hash'],
      JOIN_BUILD_SIDE: ['Right'],
      SCAN_PARTITIONS: ['account_id', 'metastore_id'],
    });
  });

  it('reads a value the declared type says cannot arrive, rather than passing it through', () => {
    // The header's reason for not throwing on an unfamiliar encoding, applied one level down. Neither shape
    // below occurs in any capture; both are what an upgrade would look like, and the fixtures exist for that.
    // Typed as the declaration allows and then widened, because what the platform sends is not what a
    // hand-written literal can express: the fields are `string`, and the point of these three cases is a
    // value that is not one.
    const arriving = (entry: Record<string, unknown>): PlanMetaEntry => entry;
    expect(metaValues(arriving({ key: 'IS_PHOTON', value: true }))).toEqual(['true']);
    expect(metaValues(arriving({ key: 'SCAN_PARTITIONS', values: 'account_id' }))).toEqual([]);
    expect(metaValues({ key: 'JOIN_TYPE' })).toEqual([]);
  });

  it('reproduces an empty value rather than reading it as an absent key', () => {
    // The decision the docstring records: "the key carried something" is a different question from "the key
    // was present", and a rule that renders a value to a reader asks the first.
    expect(metaValues({ key: 'JOIN_BUILD_SIDE', value: '' })).toEqual(['']);
    const extract = extractPlan({
      nodes: [{ id: '1', tag: 'A', meta_data: [{ key: 'JOIN_BUILD_SIDE', value: '' }] }],
    });
    expect(extract.operators[0]?.meta).toEqual({ JOIN_BUILD_SIDE: [''] });
  });

  it('names the parser versions whose promised keys are not evidence, per key', () => {
    // The gate 33ifc reads before it reads a key by name. plan-parser-1 stored five of the six as empty for a
    // reason that was not the platform's, so absence from one of its extracts means nothing.
    expect(metaIsReadable({ parserVersion: 'plan-parser-1' }, 'JOIN_ALGORITHM')).toBe(false);
    expect(metaIsReadable({ parserVersion: PARSER_VERSION }, 'JOIN_ALGORITHM')).toBe(true);

    // Per key rather than per version, because the two mistakes have different extents. `plan-parser-2` fixed
    // the empty-value read, so its joins are evidence — but it did not promise `SORT_ORDER` at all, so an
    // operator with no sort order in one of its extracts is an operator nobody looked at.
    expect(metaIsReadable({ parserVersion: 'plan-parser-2' }, 'JOIN_ALGORITHM')).toBe(true);
    expect(metaIsReadable({ parserVersion: 'plan-parser-2' }, 'SORT_ORDER')).toBe(false);

    // And the current version is on no key's list, which is the mistake a deny-list invites: the version that
    // reads a key correctly is the one most likely to be pasted into the list beside it.
    for (const key of PROMISED_META_KEYS) {
      expect(META_UNREADABLE_PARSER_VERSIONS[key], key).not.toContain(PARSER_VERSION);
      expect(metaIsReadable({ parserVersion: PARSER_VERSION }, key), key).toBe(true);
    }
    // Exhaustive over the promised keys, so a seventh cannot be added without deciding which versions read it.
    expect(Object.keys(META_UNREADABLE_PARSER_VERSIONS).sort()).toEqual([...PROMISED_META_KEYS].sort());
  });

  it('names the parser versions whose named metrics are not evidence, which is every version before them', () => {
    // The same gate for the metrics `33ic` added, and it has to exist separately: a rule asking "did this
    // shuffle report skewed partitions" reads absence as a no, and every extract written before `plan-parser-3`
    // is absent for a reason that is the parser's.
    expect(namedMetricsAreReadable({ parserVersion: 'plan-parser-1' })).toBe(false);
    expect(namedMetricsAreReadable({ parserVersion: 'plan-parser-2' })).toBe(false);
    expect(namedMetricsAreReadable({ parserVersion: PARSER_VERSION })).toBe(true);
    expect(NAMED_METRICS_UNREADABLE_PARSER_VERSIONS).not.toContain(PARSER_VERSION);
  });

  it('declines the metrics-only rung, which reads EXISTS and carries no plan', () => {
    // The reason interpretResponse is not a function of plans_state alone.
    expect(metricsOnly.body.plans_state).toBe('EXISTS');
    expect(metricsOnly.body.plans).toBeUndefined();
    const parsed = parsePlanResponse(metricsOnly._capture.status, metricsOnly.body);
    expect(parsed.outcome).toBe('no-graph');
    if (parsed.outcome !== 'no-graph') return;
    expect(parsed.reason).toBe('plans-field-absent');
  });

  it('reads a cache hit as the platform reporting no plan', () => {
    expect(emptyPlan._capture.status).toBe(200);
    expect(emptyPlan.body.plans_state).toBe('EMPTY');
    expect(parsePlanResponse(200, emptyPlan.body).outcome).toBe('no-plan');
  });

  it('reads a 404 as no plan record, which is not the same answer', () => {
    expect(notRetrievable._capture.status).toBe(404);
    const parsed = parsePlanResponse(404, notRetrievable.body);
    expect(parsed.outcome).toBe('not-retrievable');
    // The distinction 33k measured, asserted rather than described.
    expect(parsed.outcome).not.toBe(parsePlanResponse(200, emptyPlan.body).outcome);
  });

  it('declines a text plan rather than throwing, on the synthetic fixture', () => {
    // Synthetic by necessity: no rung of this endpoint returned a text plan. See the fixture's own note.
    expect(textOnly._capture.synthetic).toBe(true);
    const parsed = parsePlanResponse(textOnly._capture.status, textOnly.body);
    expect(parsed.outcome).toBe('no-graph');
    if (parsed.outcome !== 'no-graph') return;
    expect(parsed.reason).toBe('no-parsable-graph');
  });
});

describe('the four normalisations the document names at line 571', () => {
  it('survives JSON', () => {
    expect(parsePlanResponse(200, jsonPlan.body).outcome).toBe('available');
  });

  it('survives JSON-as-a-string, derived here rather than captured as a second copy', () => {
    const plans = jsonPlan.body.plans ?? {};
    const asString: Record<string, string> = {};
    for (const [key, value] of Object.entries(plans)) asString[key] = JSON.stringify(value);
    const body: PlanResponseBody = { ...jsonPlan.body, plans: asString };

    const fromObject = parsePlanResponse(200, jsonPlan.body);
    const fromString = parsePlanResponse(200, body);
    expect(fromString.outcome).toBe('available');
    if (fromObject.outcome !== 'available' || fromString.outcome !== 'available') return;
    // The same plan in two encodings is the same extract, or the fingerprint is not about the plan.
    expect(fromString.extract).toStrictEqual(fromObject.extract);
  });

  it('survives text-only', () => {
    expect(parsePlanResponse(200, textOnly.body).outcome).toBe('no-graph');
  });

  it('survives shapes it does not recognise, without throwing', () => {
    const shapes: readonly unknown[] = [
      null,
      {},
      { plans_state: 'EXISTS' },
      { plans_state: 'EXISTS', plans: null },
      { plans_state: 'EXISTS', plans: {} },
      { plans_state: 'EXISTS', plans: { 0: 42 } },
      { plans_state: 'EXISTS', plans: { 0: [] } },
      { plans_state: 'EXISTS', plans: { 0: { nodes: 'not a list' } } },
      { plans_state: 'EXISTS', plans: { 0: '{"nodes":' } },
      { plans_state: 'WHAT_IS_THIS' },
    ];
    for (const shape of shapes) {
      expect(() => parsePlanResponse(200, shape as PlanResponseBody)).not.toThrow();
      expect(parsePlanResponse(200, shape as PlanResponseBody).outcome).not.toBe('available');
    }
  });

  it('survives a list field that arrived as something else, on a graph it otherwise reads', () => {
    // Separate from the list above, because those all fail to produce a graph and this one succeeds. `for…of`
    // over an object throws, and every one of these fields is declared as an array by a declaration that
    // describes a response nothing validates — which is the case the header rules out, since a parser that
    // throws on an upgrade takes the scan down with it.
    const shapes: readonly unknown[] = [
      { nodes: { id: '1' } },
      { nodes: [{ id: '1', tag: 'A' }], edges: { from_id: '1' } },
      { nodes: [{ id: '1', tag: 'A', metrics: { label: 'Hashed relation size', value: 1 } }] },
      { nodes: [{ id: '1', tag: 'A', meta_data: { key: 'IS_PHOTON', value: 'true' } }] },
      { nodes: [{ id: '1', tag: 'A', metrics: [null], meta_data: [null], }], edges: [null] },
    ];
    for (const shape of shapes) {
      const graph = shape as Parameters<typeof extractPlan>[0];
      expect(() => extractPlan(graph), JSON.stringify(shape)).not.toThrow();
      // And it reads the graph rather than bailing out of it: the unreadable field is the only thing lost.
      expect(extractPlan(graph).edges, JSON.stringify(shape)).toEqual([]);
    }
    expect(extractPlan({ nodes: [{ id: '1', tag: 'A' }], edges: [null] as never }).edgesWithUnknownEndpoint).toBe(1);
  });
});

describe('absence versus zero, which the rules of 33ib to 33ig are not allowed to conflate', () => {
  const graph = {
    nodes: [
      { id: '1', tag: 'SCAN', key_metrics: { duration_ms: 10, rows_num: 5, peak_memory_bytes: 100 } },
      { id: '2', tag: 'FILTER' },
      { id: '3', tag: 'PROJECT', key_metrics: { duration_ms: 0, rows_num: 0, peak_memory_bytes: 0 } },
      { id: '4', tag: 'SORT', key_metrics: null },
    ],
  };

  it('counts a missing field and three zeros separately', () => {
    const result = extractPlan(graph);
    expect(result.operatorsWithoutMetrics).toBe(2); // FILTER has no field, SORT has null.
    expect(result.operatorsWithZeroMetrics).toBe(1); // PROJECT measured zero.
  });

  it('leaves keyMetrics absent when the field was absent, rather than defaulting it', () => {
    const byTag = new Map(extractPlan(graph).operators.map((operator) => [operator.tag, operator]));
    expect(byTag.get('FILTER')?.keyMetrics).toBeUndefined();
    expect(byTag.get('SORT')?.keyMetrics).toBeUndefined();
    expect(byTag.get('PROJECT')?.keyMetrics).toStrictEqual({
      duration_ms: 0,
      rows_num: 0,
      peak_memory_bytes: 0,
    });
  });
});

describe('the fingerprint', () => {
  const graph = (tags: readonly string[]) => ({ nodes: tags.map((tag, index) => ({ id: String(index), tag })) });

  it('ignores the order the service serialised siblings in', () => {
    expect(planFingerprint(graph(['A', 'B', 'C']))).toBe(planFingerprint(graph(['C', 'A', 'B'])));
  });

  it('changes when the operator set changes', () => {
    expect(planFingerprint(graph(['A', 'B']))).not.toBe(planFingerprint(graph(['A', 'C'])));
  });

  it('counts duplicates, because two hash joins are not one', () => {
    expect(planFingerprint(graph(['JOIN', 'JOIN']))).not.toBe(planFingerprint(graph(['JOIN'])));
  });

  it('does not move when only the scanned relation moves', () => {
    // Why the fingerprint is over `tag` and not `name`: otherwise it is the query-shape fingerprint twice.
    const left = { nodes: [{ id: '1', tag: 'SCAN', name: 'Scan main.a' }] };
    const right = { nodes: [{ id: '1', tag: 'SCAN', name: 'Scan main.b' }] };
    expect(planFingerprint(left)).toBe(planFingerprint(right));
  });
});

describe('outcomes', () => {
  it('separates a transport failure from every kind of missing plan', () => {
    expect(interpretResponse(500, null)).toBe('error');
    expect(interpretResponse(429, null)).toBe('error');
    expect(interpretResponse(404, null)).toBe('not-retrievable');
    expect(interpretResponse(200, { plans_state: 'EMPTY' })).toBe('no-plan');
    expect(interpretResponse(200, { plans_state: 'PENDING' })).toBe('unknown-state');
  });
});

describe('the drift guard', () => {
  it('agrees with the measurement script that 33b recorded its numbers with', () => {
    // 33b's findings are premises this build rests on — the 148x that decided the extract is persisted
    // rather than the response, and the operator counts behind absent-versus-zero. Those numbers describe
    // the measurement script's parser. If this one drifts from it, they stop describing what shipped, and
    // nothing else in the repository would notice.
    const selected = selectGraph(jsonPlan.body);
    const measured = measuredWidestGraph(jsonPlan.body) as { index: string | null; nodes: number };
    expect(selected.index).toBe(measured.index);
    expect(selected.nodes).toBe(measured.nodes);

    // The two modules declare the response independently — the script's `id` is a string, the parser's is
    // whatever JSON carried. Crossing that boundary is the point of the guard, so it is cast here once.
    const asMeasured = selected.graph as MeasuredPlanGraph | null;
    expect(planFingerprint(selected.graph)).toBe(measuredFingerprint(asMeasured));

    const mine = extractPlan(selected.graph);
    const theirs = measuredExtract(asMeasured) as readonly {
      id: string;
      tag: string;
      meta?: Record<string, readonly string[]>;
      key_metrics?: unknown;
    }[];

    // Non-vacuous: agreeing on nothing is not agreement.
    expect(mine.operatorCount).toBeGreaterThan(10);
    expect(theirs).toHaveLength(mine.operatorCount);

    for (const [index, operator] of mine.operators.entries()) {
      const other = theirs[index];
      expect(operator.id).toBe(other?.id);
      expect(operator.tag).toBe(other?.tag);
      expect(operator.meta ?? undefined).toStrictEqual(other?.meta ?? undefined);
      expect(operator.keyMetrics ?? undefined).toStrictEqual(other?.key_metrics ?? undefined);
    }
  });
});

describe('the fixtures themselves, because a trimmed capture that lost an operator kind proves less', () => {
  it.each(graphs.map(({ name, fixture }) => [name, fixture] as const))(
    'keeps every operator kind the captured statement produced, on %s',
    (name, fixture) => {
      // The apparatus lesson from 33b, where a fixture one column short of the statement it described
      // produced a real, reproducible number about a statement that does not exist. A trim that drops a tag
      // narrows what the parser is proven against, silently, so it fails here instead. Over both captures,
      // because the trim's node bound applies to both and only one of them is near it today.
      const original = fixture._capture.original;
      expect(original, name).toBeDefined();
      const selected = selectGraph(fixture.body);
      const tags = [...new Set((selected.graph?.nodes ?? []).map((node) => node.tag ?? '(untagged)'))].sort();
      expect(tags, name).toStrictEqual([...(original?.distinctTags ?? [])]);
    },
  );

  it('says it is trimmed, so no test reads its node count as the statement\u2019s', () => {
    // `json-plan` only. `sorted-plan` records `nodesTrimmed: false` — its statement produced fewer nodes than
    // the bound — and asserting a trim happened there would be asserting the bound rather than the capture.
    expect(jsonPlan._capture.trimmed).toBe(true);
    const original = jsonPlan._capture.original;
    expect(original?.widestGraphNodes).toBeGreaterThan(original?.nodesKept ?? 0);
  });

  it('says how many edges the trim dropped, so an empty one could not be read as a plan with none', () => {
    // The count that did not exist. Both graph captures carried `edges: []` under a note saying the edges had
    // been filtered to the kept nodes, and there was no way to tell that from a plan that had none.
    for (const { name, fixture } of graphs) {
      const original = fixture._capture.original;
      expect(original?.edges, name).toBeGreaterThan(0);
      expect(original?.edgesKept, name).toBeGreaterThan(0);
      expect(original?.edgesKept, name).toBeLessThanOrEqual(original?.edges ?? 0);
    }
  });
});
