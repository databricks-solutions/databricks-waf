// The page renders against an advisory an older build wrote.
//
// Measured on labs, 2026-08-12: with the app deployed from `main` at `be4c393` and the estate's latest
// advisory dated 2026-08-07, `/workloads` rendered React's error boundary — `Cannot read properties of
// undefined (reading 'toLocaleString')` — while the other seventeen pages the sweep visits rendered.
// `coverage.ambiguousMs` and `ambiguousShapes` arrived with `36d`, merged three days after that run
// finished, and the coverage sentence read both before testing whether they were there.
//
// So the payload here is the shape of the one that crashed it: every field this page had before `36d`
// and neither of the two it gained. ADR 0079 says what is owed such a record — a page that survives it,
// not a rendering of its coverage — so what is asserted is that the page renders, that it says which
// figures are missing, and that it does not put a coverage claim over a window it cannot measure.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { AdvisorContext, type AdvisorValue } from '../api/advisor-context';
import { WorkloadsPage } from './WorkloadsPage';
import { coverageSentence } from './workload-language';
import type { Advisory, Workload, WorkloadCoverage } from '../api/types';

/**
 * The coverage a run stored before `36d`: `ambiguousMs` and `ambiguousShapes` are the two it lacks.
 *
 * Asserted rather than declared, because the contract says both fields are `readonly … : number` and the
 * whole finding is that a stored payload can lack them anyway. The type is what stopped anyone looking.
 */
const OLDER_COVERAGE = {
  coveredMs: 16_370_558,
  excludedMs: 1_432_777,
  selfMs: 16_370_558,
  coveredRuns: 400,
  excludedRuns: 25,
  selfRuns: 120,
  ambiguousRuns: 0,
  percent: 91.9,
} as WorkloadCoverage;

function workload(coverage: WorkloadCoverage): Workload {
  return {
    top: [],
    failing: [],
    coverage,
    considered: 42,
    findingCount: 0,
    rankingVersion: 'v1',
    rulesVersion: 1,
    windowDays: 14,
  };
}

function advisor(workloadPayload: Workload): AdvisorValue {
  const advisory: Advisory = {
    id: 'advisory-1',
    runId: 'run-1',
    finishedAt: '2026-08-07T09:52:00.000Z',
    state: 'complete',
    scope: 'workspace',
    lookbackDays: 14,
    actor: 'analyst@example.com',
    sighted: true,
    workload: workloadPayload,
  };
  return { advisory, loading: false, advising: false, runAdvisor: () => undefined, reload: () => undefined };
}

function page(coverage: WorkloadCoverage): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <AdvisorContext.Provider value={advisor(workload(coverage))}>
        <WorkloadsPage />
      </AdvisorContext.Provider>
    </MemoryRouter>
  );
}

describe('an advisory stored before the fields this page reads existed', () => {
  it('renders the page rather than an error boundary', () => {
    const markup = page(OLDER_COVERAGE);

    expect(markup).toContain('The last 14 days of query history');
  });

  it('says which figures are missing instead of a share it cannot compute', () => {
    const markup = page(OLDER_COVERAGE);

    expect(markup).toContain('missing 2 of the 5 figures');
    expect(markup).toContain('Run the advisor again');
    // The share, the covered duration, and the "all of it" sentence are the three claims the absent
    // fields would have been read into. `Math.max(0, coveredMs - ambiguousMs)` is `NaN` on this payload
    // and the clamp does not catch it, so a fix that only guarded the plural call would have printed
    // "Covers 92% of query time in this window — NaN".
    expect(markup).not.toContain('Covers');
    expect(markup).not.toContain('NaN');
    expect(markup).not.toContain('92%');
  });

  it('still says the share where the run carries every figure', () => {
    const markup = page({ ...OLDER_COVERAGE, ambiguousMs: 0, ambiguousShapes: 0 });

    expect(markup).toContain('Covers 92% of query time in this window');
  });

  it('does not render an empty workbench when there is no recommendation to select', () => {
    const markup = page({ ...OLDER_COVERAGE, ambiguousMs: 0, ambiguousShapes: 0 });

    expect(markup).toContain('query groups without a recommendation are not listed');
    expect(markup).not.toContain('Query opportunities');
    expect(markup).not.toContain('Nothing selected');
  });
});

describe('the sentence on its own', () => {
  it('counts the absent figures rather than naming a number of them it did not check', () => {
    // One absent field reads "1 of the 5", which is the case a hard-coded plural would have got wrong
    // and the one a payload from a build between `36d` and this row would produce.
    expect(coverageSentence({ ...OLDER_COVERAGE, ambiguousMs: 0 })).toContain('missing 1 of the 5 figures');
    expect(coverageSentence({ ...OLDER_COVERAGE, ambiguousMs: 0, ambiguousShapes: 0 })).not.toContain('missing');
  });

  it('does not mistake a legitimate zero for an absent figure', () => {
    // Every figure at zero is a real reading — a window whose whole coverage is describable — and the
    // check is `Number.isFinite` rather than falsiness for exactly this row.
    const sentence = coverageSentence({
      coveredMs: 3_600_000,
      excludedMs: 0,
      selfMs: 0,
      coveredRuns: 400,
      excludedRuns: 0,
      selfRuns: 0,
      ambiguousMs: 0,
      ambiguousRuns: 0,
      ambiguousShapes: 0,
      percent: 100,
    });

    expect(sentence).toBe('Covers all 1 h of query time recorded in this window.');
  });
});
