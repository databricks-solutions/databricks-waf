import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { extract, metricPresence, planFingerprint, widestGraph } from './measure-query-plans.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORDING = join(
  HERE,
  '..',
  'server',
  'collect',
  'sql',
  'runtime-baseline',
  'labs-operator-plans.json',
);

interface Recording {
  readonly reachability: {
    readonly byComputeType: readonly { readonly computeType: string; readonly statements: number }[];
    readonly refusal: { readonly status: number; readonly errorCode: string } | null;
  };
  readonly ladder: Record<string, { readonly bytes: number; readonly ofCap: number }>;
  readonly maxProfileBytes: number;
  readonly response: {
    readonly plansState: string | null;
    readonly graphs: readonly { readonly index: string; readonly nodes: number }[];
    readonly widest: { readonly index: string; readonly nodes: number };
    readonly promisedMetaDataAbsent: readonly string[];
    readonly keyMetrics: { readonly absent: number; readonly measured: number };
    readonly rawBytes: number;
    readonly extractBytes: number;
  };
  readonly stability: {
    readonly shapesMeasured: number;
    readonly shapesDrifted: number;
    readonly shapes: readonly { readonly distinctPlans: number }[];
  };
}

const recording = JSON.parse(readFileSync(RECORDING, 'utf8')) as Recording;

/**
 * The three parsing rules the measurement established, held against fabricated responses.
 *
 * Fixtures rather than the live response, because what these assert is behaviour on shapes the live response
 * does not currently take — an empty plan, a plan serialised as a string, a missing `key_metrics`. The
 * advisor document asks for exactly this at its line 705: the parser is proven against captured samples,
 * because "the exact JSON response shape can vary across query-history service versions".
 */
describe('reading a query-history plan', () => {
  it('selects the graph that carries the plan rather than the first key', () => {
    // The measured case: thirteen siblings, one of which is the plan and sits at an index nothing documents.
    const body = {
      plans: {
        '0': { nodes: [{ id: '1', tag: 'RESULT_QUERY_STAGE_EXEC' }] },
        '1': { nodes: [] },
        '2': { nodes: [{ id: '2', tag: 'A' }, { id: '3', tag: 'B' }, { id: '4', tag: 'C' }] },
      },
    };
    expect(widestGraph(body).index).toBe('2');
    expect(widestGraph(body).nodes).toBe(3);
  });

  it('reads a graph the service sent as a JSON string', () => {
    const body = { plans: { '0': JSON.stringify({ nodes: [{ id: '1', tag: 'A' }] }) } };
    expect(widestGraph(body).nodes).toBe(1);
  });

  it('survives a response with no plan at all rather than throwing', () => {
    for (const body of [{}, { plans: {} }, { plans: { '0': { nodes: [] } } }]) {
      expect(widestGraph(body).nodes).toBe(0);
      expect(extract(widestGraph(body).graph)).toEqual([]);
    }
  });

  it('fingerprints the operators, not the tables they read', () => {
    // Same physical plan over a different relation. A fingerprint that moves here is the shape fingerprint
    // computed a second time, which is what `36s` already owns.
    const one = { nodes: [{ tag: 'PHOTON_AGG_EXEC', name: 'Scan alpha' }, { tag: 'PHOTON_FILTER_EXEC' }] };
    const other = { nodes: [{ tag: 'PHOTON_AGG_EXEC', name: 'Scan beta' }, { tag: 'PHOTON_FILTER_EXEC' }] };
    expect(planFingerprint(one)).toBe(planFingerprint(other));
  });

  it('fingerprints sibling order out, and a changed operator set in', () => {
    const forward = { nodes: [{ tag: 'A' }, { tag: 'B' }] };
    const reversed = { nodes: [{ tag: 'B' }, { tag: 'A' }] };
    const broadcast = { nodes: [{ tag: 'A' }, { tag: 'PHOTON_BROADCAST_HASH_JOIN_EXEC' }] };
    expect(planFingerprint(forward)).toBe(planFingerprint(reversed));
    expect(planFingerprint(forward)).not.toBe(planFingerprint(broadcast));
  });

  it('keeps an absent metric distinguishable from a zero one', () => {
    // The trap the measurement found: 17 operators carry no `key_metrics` and 3 carry three zeros. A rule
    // that cannot tell them apart claims an operator emitted no rows when nobody instrumented it.
    const graph = {
      nodes: [
        { id: '1', tag: 'A', key_metrics: { duration_ms: 12, rows_num: 40, peak_memory_bytes: 8 } },
        { id: '2', tag: 'B', key_metrics: { duration_ms: 0, rows_num: 0, peak_memory_bytes: 0 } },
        { id: '3', tag: 'C' },
      ],
    };
    expect(metricPresence(graph)).toEqual({ operators: 3, measured: 1, allZero: 1, absent: 1 });
    const extracted = extract(graph);
    expect(extracted[1]).toHaveProperty('key_metrics');
    expect(extracted[2]).not.toHaveProperty('key_metrics');
  });

  it('counts and extracts a null metric the same way, not two ways', () => {
    // The two functions spelled this test differently at first — `== null` counting it absent while
    // `=== undefined` let it through as a present-but-empty object. Both are the reading a rule takes, so a
    // disagreement between them is the absent-versus-zero distinction quietly failing in the one place it
    // was built to hold.
    const graph = { nodes: [{ id: '1', tag: 'A', key_metrics: null }] };
    expect(metricPresence(graph).absent).toBe(1);
    expect(extract(graph)[0]).not.toHaveProperty('key_metrics');
  });
});

/**
 * What the recording has to keep saying for the premises of `33b` to stand as measured.
 *
 * Held against the committed recording rather than the warehouse: the measurement is live and optional, and
 * a premise that only holds while somebody has a profile configured is a premise nothing checks. Re-run the
 * script to move these.
 */
describe('the recorded premises', () => {
  it('reaches the plan for a warehouse statement and refuses the rest by 404', () => {
    expect(recording.response.plansState).toBe('EXISTS');
    expect(recording.reachability.refusal?.status).toBe(404);
    const types = recording.reachability.byComputeType.map((row) => row.computeType);
    expect(types).toContain('WAREHOUSE');
  });

  it('carries every field the advisor document promised', () => {
    expect(recording.response.promisedMetaDataAbsent).toEqual([]);
    expect(recording.response.keyMetrics.measured).toBeGreaterThan(0);
  });

  it('finds one graph carrying the plan among many', () => {
    expect(recording.response.graphs.length).toBeGreaterThan(1);
    expect(recording.response.graphs.filter((graph) => graph.nodes > 1)).toHaveLength(1);
    expect(recording.response.widest.nodes).toBeGreaterThan(1);
  });

  it('puts the richest rung of the ladder past the cap and include_plans well inside it', () => {
    const richest = recording.ladder['include_plans+debug_info+json_plans'];
    const plans = recording.ladder.include_plans;
    expect(richest.bytes).toBeGreaterThan(recording.maxProfileBytes);
    expect(plans.bytes).toBeLessThan(recording.maxProfileBytes);
  });

  it('extracts what the rules read in a fraction of the response', () => {
    expect(recording.response.extractBytes * 50).toBeLessThan(recording.response.rawBytes);
  });

  it('finds a shape whose plan changed between executions', () => {
    // The premise behind the second fingerprint. If a re-run ever reports zero drifted shapes, the
    // `plan_fingerprint` is answering a question this estate does not ask, and that is worth knowing before
    // it is built rather than after.
    expect(recording.stability.shapesMeasured).toBeGreaterThanOrEqual(4);
    expect(recording.stability.shapesDrifted).toBeGreaterThan(0);
  });
});
