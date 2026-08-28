import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { inventory, operators, tells, uncached, widestGraph } from './measure-plan-rule-inputs.mjs';
import type { Operators, RecordedInventory, Tells } from './measure-plan-rule-inputs.d.mts';
import { NAMED_METRICS, PROMISED_META_KEYS } from '../server/collect/sql/plans/parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(
  HERE,
  '..',
  'server',
  'collect',
  'sql',
  'runtime-baseline',
  'labs-plan-rule-inputs.json'
);

interface Probe {
  readonly id: string;
  readonly of: readonly string[];
  readonly rungs?: {
    readonly awaited?: {
      readonly waitedMs: number;
      readonly plansState?: string | null;
      readonly nodes?: number;
      readonly timedOut?: boolean;
    };
    readonly include_plans?: {
      readonly bytes: number;
      readonly widest: { readonly nodes: number };
      readonly inventory: RecordedInventory;
      readonly tells: Tells;
      readonly operators: Operators;
    };
    readonly 'include_plans+debug_info'?: { readonly bytes: number };
  };
}

interface Recording {
  readonly extractedMetaKeys: readonly string[];
  readonly metricLabels: readonly string[];
  readonly probes: readonly Probe[];
}

const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;

/** The probes that came back with a plan. A probe with none is evidence about the apparatus, not the plan. */
const withPlans = recording.probes.filter((probe) => (probe.rungs?.include_plans?.widest.nodes ?? 0) > 0);

/**
 * How the helpers read a response, on shapes the live one does not currently take.
 *
 * Fabricated rather than live, for the reason measure-query-plans.test.ts gives: what these assert is the
 * distinction each finding rests on, and the finding is only a finding if the reading that produced it is
 * the reading a rule would do.
 */
describe('reading what a rule would read', () => {
  it('reads both spellings a meta entry takes, which is the defect this measurement made and then found', () => {
    // The whole of the correction. A scalar key puts its content in `value`; a list key puts it in `values`.
    // Reading only the second reports every scalar key as declared-and-empty — which is what the first pass
    // of this script did, and what parse.ts still does, and it is why 33ih exists.
    const graph = {
      nodes: [
        {
          id: '1',
          tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC',
          meta_data: [
            { key: 'JOIN_ALGORITHM', label: 'Join algorithm', value: 'Photon Broadcast Hash' },
            { key: 'JOIN_BUILD_SIDE', label: 'Build side', value: 'Right' },
            { key: 'SORT_ORDER', label: 'Sort order', values: ['a DESC NULLS LAST'] },
            { key: 'FILTERS', label: 'Filters', values: [] },
          ],
        },
      ],
    };
    const seen = inventory(graph);
    // An empty list still declares the list spelling — the spelling is a property of the key, and separate
    // from whether anything was behind it on this operator.
    expect(seen.metaSpelling).toEqual({
      FILTERS: 'values',
      JOIN_ALGORITHM: 'value',
      JOIN_BUILD_SIDE: 'value',
      SORT_ORDER: 'values',
    });
    expect(seen.metaKeysWithValues).toEqual(['JOIN_ALGORITHM', 'JOIN_BUILD_SIDE', 'SORT_ORDER']);
    // A declared key with nothing behind it is still separable from one carrying a value, which is the
    // distinction the first pass was trying to draw and drew across the wrong boundary.
    expect(seen.metaKeys).toContain('FILTERS');
    expect(seen.metaKeysWithValues).not.toContain('FILTERS');
    expect(operators(graph).joins[0]?.meta).toEqual({
      JOIN_ALGORITHM: ['Photon Broadcast Hash'],
      JOIN_BUILD_SIDE: ['Right'],
    });
  });

  it('counts operators per tag, because a distinct list cannot say how many exchanges a plan has', () => {
    const graph = {
      nodes: [
        { id: '1', tag: 'PHOTON_SHUFFLE_MAP_STAGE_EXEC' },
        { id: '2', tag: 'PHOTON_SHUFFLE_MAP_STAGE_EXEC' },
        { id: '3', tag: 'UNKNOWN.PhotonShuffleExchangeSink' },
      ],
    };
    expect(inventory(graph).tagCounts).toEqual({
      'PHOTON_SHUFFLE_MAP_STAGE_EXEC': 2,
      'UNKNOWN.PhotonShuffleExchangeSink': 1,
    });
  });

  it('reads a skew metric by its value, because every plan carries the label', () => {
    // The trap this measurement exists to catch. Both operators declare the same metric; one is skewed.
    const graph = {
      nodes: [
        {
          id: '1',
          tag: 'A',
          metrics: [{ label: 'MapStage - Skew num skewed partitions', value: 0, key: 'UNKNOWN_KEY' }],
        },
        {
          id: '2',
          tag: 'B',
          metrics: [{ label: 'MapStage - Skew num skewed partitions', value: 4, key: 'UNKNOWN_KEY' }],
        },
      ],
    };
    const seen = operators(graph);
    expect(seen.skew).toHaveLength(2);
    expect(seen.skew.flatMap((one) => one.metrics ?? []).map((metric) => metric.value)).toEqual([0, 4]);
    // Whereas the tell — a search for the word — cannot tell the two apart, which is why it is not a rule.
    expect(tells(graph).DATA_SKEW?.matched).toBe(1);
  });

  it('names the operators a rule fires on, from the tag and the name together', () => {
    const graph = {
      nodes: [
        { id: '1', tag: 'UNKNOWN.PhotonScalarUDF', name: 'Scalar U D F' },
        { id: '2', tag: 'PHOTON_SORT_EXEC', name: 'Sort' },
        { id: '3', tag: 'PHOTON_PROJECT_EXEC', name: 'Project' },
      ],
    };
    const seen = operators(graph);
    expect(seen.udfs.map((one) => one.tag)).toEqual(['UNKNOWN.PhotonScalarUDF']);
    expect(seen.sorts.map((one) => one.tag)).toEqual(['PHOTON_SORT_EXEC']);
  });

  it('selects the graph that carries the plan rather than the first key', () => {
    const body = {
      plans: {
        '0': { nodes: [{ id: '1', tag: 'RESULT_QUERY_STAGE_EXEC' }] },
        '1': { nodes: [{ id: '2', tag: 'A' }, { id: '3', tag: 'B' }] },
      },
    };
    expect(widestGraph(body).index).toBe('1');
    expect(widestGraph(body).candidates).toBe(2);
  });

  it('counts an unparsable plan rather than throwing, so one bad entry does not lose the run', () => {
    const body = { plans: { '0': '{not json', '1': JSON.stringify({ nodes: [{ id: '1', tag: 'A' }] }) } };
    const chosen = widestGraph(body);
    expect(chosen.unparsable).toBe(1);
    expect(chosen.nodes).toBe(1);
    // A string-valued `plans` is one unparsable entry, not an iteration over its characters.
    expect(widestGraph({ plans: 'nonsense' })).toMatchObject({ nodes: 0, unparsable: 1, candidates: 0 });
  });

  it('makes a probe unique, because an identical statement is answered from the cache and has no plan', () => {
    expect(uncached('SELECT 1')).not.toBe(uncached('SELECT 1'));
    expect(uncached('SELECT 1')).toContain('SELECT 1');
  });
});

/**
 * The recording, held to the six claims `33ia` reports from it.
 *
 * These fail when the file is replaced by a run that says something else, which is the point: the split of
 * `33i` into rows rests on these numbers, and a re-run that contradicts them should stop the build rather
 * than leave the plan describing a platform that has changed underneath it.
 */
describe('what the plan carries, as measured on labs', () => {
  it('measured every probe with a plan, including the one built for the statistics rule', () => {
    // Not `>= 4`. The statistics probe was the one that came back without a plan, its absence was written up
    // as a finding about the platform, and a test that tolerates four probes tolerates that again.
    expect(withPlans).toHaveLength(recording.probes.length);
    expect(withPlans.map((probe) => probe.id)).toContain('unanalysed-scan');
  });

  it('found every join naming its algorithm and its build side', () => {
    const joins = withPlans.flatMap((probe) => probe.rungs?.include_plans?.operators.joins ?? []);
    expect(joins.length).toBeGreaterThan(0);
    for (const join of joins) {
      // Both, with values. The reversal of the first pass, and what BROADCAST_CANDIDATE's remedy text rests
      // on: a finding that names the built side needs a field that names the built side.
      expect(join.meta?.JOIN_ALGORITHM?.[0]).toMatch(/broadcast|hash|sort.?merge|nested/i);
      expect(join.meta?.JOIN_BUILD_SIDE?.[0]).toMatch(/^(Left|Right)$/);
    }
  });

  it('records which spelling each promised meta key uses, and five of the six are the scalar one', () => {
    // The defect 33ih fixes, held as a number: parse.ts reads `values`, so every key spelled `value` is
    // stored empty. If a future platform change moves them, this fails and the row's premise is stale.
    const spellings = new Map<string, string>();
    for (const probe of withPlans) {
      for (const [key, spelling] of Object.entries(probe.rungs?.include_plans?.inventory.metaSpelling ?? {})) {
        spellings.set(key, spelling);
      }
    }
    const promised = recording.extractedMetaKeys.map((key) => [key, spellings.get(key)] as const);
    expect(promised.filter(([, spelling]) => spelling === 'value').map(([key]) => key).sort()).toEqual([
      'IS_PHOTON',
      'JOIN_ALGORITHM',
      'JOIN_BUILD_SIDE',
      'PARTITIONING_TYPE',
      'SCAN_IDENTIFIER',
    ]);
    expect(promised.filter(([, spelling]) => spelling === 'values').map(([key]) => key)).toEqual([
      'SCAN_PARTITIONS',
    ]);
  });

  it('found skew metrics carrying values on probes with no skew designed in, which is why the threshold is measured', () => {
    const skew = withPlans.flatMap((probe) => probe.rungs?.include_plans?.operators.skew ?? []);
    const metrics = skew.flatMap((one) => one.metrics ?? []);
    const nonZero = new Set(metrics.filter((metric) => Number(metric.value) > 0).map((metric) => metric.label));
    expect(nonZero).toContain('MapStage - Skew max to non-empty median ratio');
    expect(nonZero).toContain('ShuffleQueryStage - Adp reduce-side skew threshold met');
    // The claim that decides 33id: none of these probes was built to be skewed, and the markers fire anyway.
    const skewedByDesign = withPlans.filter((probe) => probe.of.includes('DATA_SKEW')).map((probe) => probe.id);
    expect(skewedByDesign).toEqual(['shuffle-heavy']);
    const elsewhere = withPlans
      .filter((probe) => !probe.of.includes('DATA_SKEW'))
      .flatMap((probe) => probe.rungs?.include_plans?.operators.skew ?? [])
      .flatMap((one) => one.metrics ?? [])
      .filter((metric) => Number(metric.value) > 0);
    expect(elsewhere.length).toBeGreaterThan(0);
    // And every one of them lives in `metrics`, which the extract does not read at all: none of the six keys
    // it selects is one of these labels, so no amount of fixing 33ih makes DATA_SKEW writable without 33ic.
    for (const label of nonZero) expect(recording.extractedMetaKeys).not.toContain(label);
  });

  it('found a shuffle boundary rendered as two operators in equal numbers, so counting tags double-counts', () => {
    // What makes the design document's "eight exchanges" a count of something else, and 33id necessary.
    for (const probe of withPlans) {
      const counts = probe.rungs?.include_plans?.inventory.tagCounts ?? {};
      expect(counts['PHOTON_SHUFFLE_MAP_STAGE_EXEC']).toBe(counts['UNKNOWN.PhotonShuffleExchangeSink']);
      expect(counts['PHOTON_SHUFFLE_MAP_STAGE_EXEC']).toBeGreaterThan(0);
      // Nowhere near eight, on any reading of what one boundary is.
      expect(counts['PHOTON_SHUFFLE_MAP_STAGE_EXEC']).toBeLessThan(8);
    }
  });

  it('found no statistics signal, on a probe that scanned a table nothing analyses', () => {
    const probe = withPlans.find((one) => one.id === 'unanalysed-scan');
    const statistics = probe?.rungs?.include_plans?.operators.statistics ?? [];
    expect(statistics.length).toBeGreaterThan(0);
    for (const one of statistics) {
      for (const metric of one.metrics ?? []) {
        // Timings, a shuffle's NDV estimate, and two row-width estimates. A row width is not a row count and
        // says nothing about whether statistics were computed, which is the whole of 33ig's premise.
        expect(String(metric.label)).toMatch(/time spent|estimated executor time|estimated NDV|Size of a row/i);
      }
      expect(Object.keys(one.meta ?? {})).toHaveLength(0);
    }
  });

  it('found the graph edges the extract dropped at the time, on every probe that had a plan', () => {
    // `33ic` added them, so this is now a claim about the recording rather than about the parser: the edges were
    // in the response before anything read them, which is what made adding them a selection rather than a
    // request for more data.
    for (const probe of withPlans) {
      expect(probe.rungs?.include_plans?.inventory.edges ?? 0).toBeGreaterThan(0);
    }
  });

  it('found a sort declaring an order the extract did not keep, which is the gap 33ic closed', () => {
    // `extractedMetaKeys` is what `parse.ts` selected when the run was taken, not what it selects now — the
    // recording measures a commit. Held to, because it is the before-figure the addition is justified against.
    const sorts = withPlans.flatMap((probe) => probe.rungs?.include_plans?.operators.sorts ?? []);
    const ordered = sorts.filter((sort) => (sort.meta?.SORT_ORDER ?? []).length > 0);
    expect(ordered.length).toBeGreaterThan(0);
    expect(recording.extractedMetaKeys).not.toContain('SORT_ORDER');
    expect(PROMISED_META_KEYS as readonly string[]).toContain('SORT_ORDER');
  });

  it('found five metric keys for eight hundred labels, which is why NAMED_METRICS selects on the label', () => {
    // The claim `parse.ts` rests that list on. A stable enumerated key would be the thing to select on and
    // there is not one: everything outside these five is `UNKNOWN_KEY`, so a rule wanting a skew ratio has to
    // name display text a service upgrade may reword. Asserted here so the sentence in `parse.ts` fails with
    // the recording rather than drifting from it.
    expect(recording.metricLabels.length).toBeGreaterThan(500);
    for (const probe of withPlans) {
      expect(probe.rungs?.include_plans?.inventory.metricKeys, probe.id).toEqual([
        'CUMULATIVE_TIME',
        'DURATION',
        'EXCLUSIVE_TIME',
        'NUMBER_OUTPUT_ROWS',
        'PEAK_MEMORY_USAGE',
      ]);
    }
    // And every metric `NAMED_METRICS` names was one of the labels the vocabulary carried, so the list selects
    // things that exist rather than things a rule's author hoped for.
    const labels = new Set(recording.metricLabels);
    for (const metric of NAMED_METRICS) expect(labels.has(metric), metric).toBe(true);
  });

  it('waited for a graph rather than for a state, and every probe answered within the wait', () => {
    for (const probe of withPlans) {
      const awaited = probe.rungs?.awaited;
      expect(awaited?.timedOut ?? false).toBe(false);
      expect(awaited?.nodes ?? 0).toBeGreaterThan(0);
    }
  });
});
