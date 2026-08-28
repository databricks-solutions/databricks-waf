import { describe, expect, it } from 'vitest';
import type { QueryShapeRow } from '../collect/sql/shapes.js';
import { analyseWorkload, SHOWN } from './workload.js';

function shape(overrides: Partial<QueryShapeRow> = {}): QueryShapeRow {
  return {
    workspaceId: 'w1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementType: 'SELECT',
    kinds: 1,
    runsNow: 1000,
    runsBefore: 1000,
    measuredNow: 1000,
    measuredBefore: 1000,
    msNow: 1_000_000,
    msBefore: 1_000_000,
    meanMsNow: 1000,
    meanMsBefore: 1000,
    medianMs: 1000,
    worstMs: 1100,
    spilledBytes: 0,
    shuffleBytes: 0,
    readBytes: 1_000_000_000,
    writtenBytes: 0,
    prunedPercent: 90,
    readFiles: 100,
    prunedFiles: 900,
    parallelism: 4,
    compilationPercent: 2,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    coveredMs: 3_000_000,
    excludedMs: 7_000_000,
    coveredRuns: 5000,
    excludedRuns: 3000,
    selfMs: 0,
    selfRuns: 0,
    ambiguousMs: 0,
    ambiguousRuns: 0,
    ambiguousShapes: 0,
    representativeMeasured: true,
    ...overrides,
  };
}

describe('the workload analysis', () => {
  it('reports nothing rather than an empty estate when the shapes could not be read', () => {
    // The distinction that matters most in this module. An estate with no expensive queries is a real
    // finding; a window whose query history could not be read is not, and rendering the second as the
    // first is the most flattering possible lie about a workspace the app could not see.
    expect(analyseWorkload([], 14)).toBeUndefined();
  });

  it('shows twelve however many it considered', () => {
    // The statement returns forty so the composite has something to reorder, and a page shows twelve. Both
    // documents say the same thing: an advisor reporting forty findings is one a reader closes.
    const rows = Array.from({ length: 40 }, (_, index) =>
      shape({ shape: `shape${String(index).padStart(3, '0')}`, msNow: 1_000_000 * (index + 1) })
    );

    const analysis = analyseWorkload(rows, 14);

    expect(analysis?.top).toHaveLength(SHOWN);
    expect(analysis?.considered).toBe(40);
  });

  it('states what fraction of query time it covers', () => {
    // Excluding REFRESH removes 62.9% of query time on the calibrated estate, so a page headed "your
    // costliest queries" would be describing about a third of the workspace. The figure is part of the
    // analysis rather than a note on the surface: a reader who is not told will assume the list is the
    // estate, and will catch the app out the moment they compare it to a bill.
    const analysis = analyseWorkload([shape()], 14);

    expect(analysis?.coverage).toMatchObject({ coveredMs: 3_000_000, excludedMs: 7_000_000, percent: 30 });
  });

  it('reads the coverage off one row rather than summing it', () => {
    // The statement cross-joins one coverage row onto every result row, so summing would multiply the
    // estate's query time by the number of shapes returned — a number that grows as the page gets longer.
    const analysis = analyseWorkload([shape({ shape: 'a' }), shape({ shape: 'b' }), shape({ shape: 'c' })], 14);

    expect(analysis?.coverage.coveredMs).toBe(3_000_000);
  });

  /*
   * The assessment's own queries are excluded from the ranking and kept in the denominator.
   *
   * Both halves matter and they pull opposite ways. Ranking them put this app in eight of the top twelve
   * shapes on the first workspace it ran against, which is the tool advising the reader to optimise the
   * tool. Dropping them from the denominator too would report near-total coverage of an estate the
   * analysis had described half of — on that workspace, ours was 51.8% of query time.
   */
  it('counts what the assessment spent against coverage without ranking it', () => {
    const analysis = analyseWorkload(
      [shape({ coveredMs: 3_000_000, excludedMs: 1_000_000, selfMs: 4_000_000, selfRuns: 3048 })],
      14
    );

    expect(analysis?.coverage).toMatchObject({ selfMs: 4_000_000, selfRuns: 3048, percent: 37.5 });
  });

  it('reports no coverage percentage for a window that ran nothing', () => {
    // Complete coverage of nothing is true and misleading, which is the thing this disclosure exists to
    // avoid rather than to commit.
    const analysis = analyseWorkload([shape({ coveredMs: 0, excludedMs: 0 })], 14);

    expect(analysis?.coverage.percent).toBeUndefined();
  });

  it('caps the window it claims at fifteen days per half', () => {
    // The statement caps its own lookback and so must the figure the surface shows, or the page implies a
    // comparison the data cannot support. A quarter-over-quarter trend is not available at this bound.
    expect(analyseWorkload([shape()], 90)?.windowDays).toBe(15);
    expect(analyseWorkload([shape()], 7)?.windowDays).toBe(7);
  });

  it('lists failing shapes separately from the ranked ones', () => {
    // A shape that only ever fails has no measured time, so the composite ranks it last while it is the
    // most actionable row on the page. On the calibrated estate the costliest shape in the window failed
    // 1,496 of 7,091 runs.
    const doomed = shape({ shape: 'doomed', runsNow: 50, measuredNow: 0, msNow: 0, failures: 50 });
    const rows = [
      doomed,
      ...Array.from({ length: 20 }, (_, index) => shape({ shape: `ok${index}`, msNow: 5_000_000 })),
    ];

    const analysis = analyseWorkload(rows, 14);

    expect(analysis?.top.map((one) => one.shape)).not.toContain('doomed');
    expect(analysis?.failing.map((one) => one.shape)).toEqual(['doomed']);
  });

  it('names the ranking and rules versions it was produced under', () => {
    // Two runs a month apart under different coefficients are two different questions, and a page that
    // presented them as a trend would report the tuning as a change in the estate.
    const analysis = analyseWorkload([shape()], 14);

    expect(analysis?.rankingVersion).toBe('advisor-1');
    expect(analysis?.rulesVersion).toBe(1);
  });

  it('attaches the findings and the trend to each shape it shows', () => {
    const analysis = analyseWorkload([shape({ compilationPercent: 85, meanMsNow: 2000, medianMs: 2000 })], 14);
    const first = analysis?.top[0];

    expect(first?.findings.map((one) => one.rule)).toEqual(['COMPILATION_DOMINATED']);
    expect(first?.trend.kind).toBe('regression');
    expect(analysis?.findingCount).toBe(1);
  });

  it('counts findings across every considered shape, not only the shown ones', () => {
    // Otherwise the count agrees with the page and disagrees with the estate, which is the wrong direction
    // for a number a reader might use to decide whether to look further.
    const rows = Array.from({ length: 20 }, (_, index) =>
      shape({ shape: `s${index}`, compilationPercent: 85, msNow: 1_000_000 * (index + 1) })
    );

    expect(analyseWorkload(rows, 14)?.findingCount).toBe(20);
  });
});
