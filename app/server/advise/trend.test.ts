import { describe, expect, it } from 'vitest';
import type { QueryShapeRow } from '../collect/sql/shapes.js';
import { classify } from './trend.js';

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
    worstMs: 1100,
    spilledBytes: 0,
    shuffleBytes: 0,
    readBytes: 0,
    writtenBytes: 0,
    readFiles: 0,
    prunedFiles: 0,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    coveredMs: 0,
    excludedMs: 0,
    coveredRuns: 0,
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

describe('trend classification', () => {
  it('calls a shape that doubled a regression', () => {
    const trend = classify(shape({ meanMsNow: 2000, meanMsBefore: 1000, medianMs: 2000, worstMs: 2200 }));

    expect(trend.kind).toBe('regression');
    expect(trend.ratio).toBe(2);
  });

  it('calls a shape that was always this expensive chronic', () => {
    // The distinction the four classes exist for. A reader told a query is slow has one question — is this
    // new — and "it has always taken four minutes" and "it broke on Tuesday" lead to different afternoons.
    expect(classify(shape()).kind).toBe('chronic');
  });

  it('reports an improvement rather than staying silent about it', () => {
    // A reader who changed something deserves to see that it worked, and a page that only ever reports
    // deterioration is one they stop believing.
    expect(classify(shape({ meanMsNow: 500, meanMsBefore: 1000, medianMs: 500, worstMs: 550 })).kind).toBe('improving');
  });

  it('is not moved by a difference smaller than a fortnight’s normal variation', () => {
    // Ten per cent between two windows of a production estate is the normal state of a healthy shape. A
    // rule that called it a regression would classify most of the estate as regressing every time anybody
    // looked, which is the same mistake as `mem_swap_percent > 0`.
    expect(classify(shape({ meanMsNow: 1100, meanMsBefore: 1000 })).kind).toBe('chronic');
  });

  it('calls a shape whose own runs vary more than its windows do volatile, not a regression', () => {
    // Checked before the direction, deliberately. Classifying first would report a confident regression on
    // a shape whose two windows differ by less than its runs differ from each other, and the reader would
    // go looking for a change that is not there.
    const trend = classify(shape({ meanMsNow: 2000, meanMsBefore: 1000, medianMs: 800, worstMs: 30_000 }));

    expect(trend.kind).toBe('volatile');
    // The ratio is still reported. Volatile does not mean unmeasured — it means the direction is not the
    // useful thing to say about it.
    expect(trend.ratio).toBe(2);
  });

  it('calls a shape with no prior window new rather than infinitely worse', () => {
    const trend = classify(shape({ runsBefore: 0, measuredBefore: 0, msBefore: 0, meanMsBefore: undefined }));

    expect(trend.kind).toBe('new');
    expect(trend.ratio).toBeUndefined();
  });

  it('distinguishes a shape that could not be timed from one that did not run', () => {
    // Every run failed or was served from cache, so there are counts and no timings. That is a caveat on
    // the numbers beside it, where `new` is a fact about the shape's history — different things, and only
    // one of them is about this window.
    const unmeasured = classify(shape({ measuredNow: 0, meanMsNow: undefined }));

    expect(unmeasured.kind).toBe('unmeasured');
    expect(unmeasured.runsNow).toBe(100);
  });

  it('carries both run counts, so a shape run twice as often is not read as slower', () => {
    const trend = classify(shape({ runsNow: 200, runsBefore: 100 }));

    expect(trend).toMatchObject({ runsNow: 200, runsBefore: 100, kind: 'chronic' });
  });
});
