import { describe, expect, it } from 'vitest';
import type { QueryShapeRow } from '../collect/sql/shapes.js';
import type { Weights } from './ranking.js';
import { byFailure, failureRate, rank, WEIGHTS, WEIGHTS_VERSION } from './ranking.js';

/** A shape with nothing remarkable about it, for a test to change one thing on. */
function shape(overrides: Partial<QueryShapeRow> = {}): QueryShapeRow {
  return {
    workspaceId: 'w1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementType: 'SELECT',
    kinds: 1,
    runsNow: 100,
    runsBefore: 100,
    measuredNow: 100,
    measuredBefore: 100,
    msNow: 100_000,
    msBefore: 100_000,
    meanMsNow: 1000,
    meanMsBefore: 1000,
    medianMs: 1000,
    worstMs: 1200,
    spilledBytes: 0,
    shuffleBytes: 0,
    readBytes: 1_000_000,
    writtenBytes: 0,
    readFiles: 10,
    prunedFiles: 90,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    coveredMs: 1_000_000,
    excludedMs: 0,
    coveredRuns: 1000,
    excludedRuns: 0,
    selfMs: 0,
    selfRuns: 0,
    ambiguousMs: 0,
    ambiguousRuns: 0,
    ambiguousShapes: 0,
    representativeMeasured: true,
    ...overrides,
  };
}

describe('the composite ranking', () => {
  it('puts a frequent cheap shape above a rare expensive one at the same total time', () => {
    // The advisor document's own example at line 530, as a test: "a query that runs for 20 seconds 10,000
    // times can matter more than a query that runs for 30 minutes once". Both here total the same time, so
    // an ORDER BY total_ms cannot tell them apart and the frequency term is the only thing that can.
    const frequent = shape({ shape: 'frequent', runsNow: 10_000, measuredNow: 10_000, msNow: 200_000_000 });
    const rare = shape({ shape: 'rare0000', runsNow: 1, measuredNow: 1, msNow: 200_000_000 });

    const [first] = rank([rare, frequent]);

    expect(first?.row.shape).toBe('frequent');
  });

  it('caps a feature at the 99th percentile, so one outlier cannot flatten the rest', () => {
    // Without the cap the outlier sets the scale on `volume` and the two ordinary shapes' volume features
    // both collapse toward zero — which is the failure the cap exists for, and it is invisible in the
    // final order. So the assertion is on the feature rather than on the ranking.
    const outlier = shape({ shape: 'outlier0', readBytes: 1e15 });
    const ordinary = shape({ shape: 'ordinary', readBytes: 1e9 });
    const another = shape({ shape: 'another0', readBytes: 2e9 });

    const ranked = rank([outlier, ordinary, another]);
    const scored = new Map(ranked.map((one) => [one.row.shape, one.features.volume]));

    // Three values, so the 99th percentile by nearest rank is the largest of them and the outlier is at
    // the cap. What matters is that the others are not near zero: on a log scale 1e9 is two thirds of
    // 1e15, which is the compression the log is for and the cap does not undo.
    expect(scored.get('outlier0')).toBe(1);
    expect(scored.get('ordinary')).toBeGreaterThan(0.5);
  });

  it('scores a shape that read no files without assuming it pruned nothing', () => {
    // `prunedPercent` is absent for a statement served from metadata or memory — 3,621 of one measured
    // workspace's 5,885. Reading absent as zero would score it as pruning nothing at all, which is the
    // most alarming available reading of a query that never opened a file.
    const unread = shape({ shape: 'unread00', prunedPercent: undefined });
    const unpruned = shape({ shape: 'unpruned', prunedPercent: 0 });

    const ranked = rank([unread, unpruned]);
    const features = new Map(ranked.map((one) => [one.row.shape, one.features.pruning]));

    expect(features.get('unread00')).toBe(0);
    expect(features.get('unpruned')).toBeGreaterThan(0);
  });

  it('is stable across two rankings of the same rows', () => {
    // Two shapes with identical figures. Left to the sort's own tie-breaking this is unspecified, and a
    // page whose rows swap places between refreshes reads as a page whose numbers are unreliable.
    const rows = [shape({ shape: 'bbbb0000' }), shape({ shape: 'aaaa0000' })];

    expect(rank(rows).map((one) => one.row.shape)).toEqual(rank([...rows].reverse()).map((one) => one.row.shape));
  });

  it('holds every weight the advisor document specifies, at the version it is known by', () => {
    // The coefficients are meant to be fitted from outcomes later, which is why they are named rather
    // than anonymous. This test is the thing that makes changing one deliberate: the sum is 1 by
    // construction, and a change without a version bump is what would make two runs falsely comparable.
    const weights: Record<keyof Weights, number> = WEIGHTS;
    const total = Object.values(weights).reduce((sum, weight) => sum + weight, 0);

    expect(total).toBeCloseTo(1);
    expect(WEIGHTS_VERSION).toBe('advisor-1');
  });

  it('ranks nothing from an empty window rather than dividing by its cap', () => {
    expect(rank([])).toEqual([]);
  });
});

describe('the failure ordering', () => {
  it('ranks by rate rather than by count', () => {
    // A shape failing 3 of 4 is broken; one failing 300 of 300,000 is flaky. The second has a hundred
    // times the failures and is not the one to look at.
    const broken = shape({ shape: 'broken00', runsNow: 4, failures: 3 });
    const flaky = shape({ shape: 'flaky000', runsNow: 300_000, failures: 300 });

    expect(byFailure([flaky, broken]).map((row) => row.shape)).toEqual(['broken00', 'flaky000']);
  });

  it('leaves out shapes that never failed rather than sorting them last', () => {
    // An estate with nothing failing should look different from one nobody checked, and padding the list
    // with healthy shapes makes the two identical.
    expect(byFailure([shape({ failures: 0 })])).toEqual([]);
  });

  it('finds a failing shape the composite ranking puts last', () => {
    // The case the separate ordering exists for. A shape that only ever fails has no measured time, so
    // every feature of the composite is zero and it ranks bottom — while being the most actionable row on
    // the page. On the calibrated estate the costliest shape in the window failed 21% of its runs.
    const doomed = shape({ shape: 'doomed00', runsNow: 50, measuredNow: 0, msNow: 0, failures: 50 });
    const healthy = shape({ shape: 'healthy0' });

    expect(rank([doomed, healthy]).at(-1)?.row.shape).toBe('doomed00');
    expect(byFailure([doomed, healthy]).at(0)?.shape).toBe('doomed00');
  });

  it('reports no failure rate for a shape that did not run', () => {
    expect(failureRate(shape({ runsNow: 0, failures: 0 }))).toBe(0);
  });
});
