// The pre-result boundary on a raw run.
//
// These values are intentionally conspicuous. If `ReviewGate` ever starts rendering from
// `scan.score`, this test fails on the exact customer-facing numbers rather than on a class name or
// implementation detail.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { PartialRunStatus, ReviewGate } from './RunPage';
import type { Scan } from '../api/types';

function unfinishedRun(): Scan {
  return {
    id: 'run-exact-107c',
    startedAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:01:00.000Z',
    state: 'complete',
    stamp: {
      catalogueVersion: '16',
      catalogueFingerprint: 'catalogue-fingerprint',
      actor: 'ana@example.com',
      executionMode: 'on-behalf-of-user',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    measurement: [
      {
        pillarId: 'reliability',
        scanId: 'run-exact-107c',
        measuredAt: '2026-08-20T00:01:00.000Z',
        actor: 'ana@example.com',
        carriedForward: false,
      },
    ],
    score: {
      overall: 12.345,
      pillars: [
        {
          pillarId: 'reliability',
          score: 98.765,
          counts: {
            pass: 1,
            fail: 0,
            partial: 0,
            unmeasurable: 0,
            'not-applicable': 0,
            'satisfied-by-architecture': 0,
          },
          scored: 1,
          unmeasurable: 0,
          unmeasuredBy: { attestation: 0, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
          composition: { observed: 1, 'admin-collected': 0, attested: 0 },
          notApplicable: 0,
          total: 1,
          worstFirst: [],
        },
      ],
      scoredControls: 1,
      totalControls: 1,
      counts: {
        pass: 1,
        fail: 0,
        partial: 0,
        unmeasurable: 0,
        'not-applicable': 0,
        'satisfied-by-architecture': 0,
      },
      composition: { observed: 1, 'admin-collected': 0, attested: 0 },
    },
    findings: [],
    footprint: {
      surfaces: [],
      durationMs: 1000,
      cancelled: false,
      concurrencyReductions: 0,
    },
    spend: [],
    signals: [
      { id: 'sql:one', status: 'observed', coverage: { mode: 'complete' }, durationMs: 10 },
      {
        id: 'sql:two',
        status: 'unmeasurable',
        coverage: { mode: 'complete' },
        unmeasurableReason: 'The source could not be read.',
        durationMs: 10,
      },
    ],
    estate: { workspacesInAccount: 0, assessed: [], excluded: [] },
    finalisation: {
      reviewId: 'review-exact-107c',
      finalised: false,
      recorded: 2,
      expected: 7,
      confirmed: 2,
      skipped: [],
      cited: 0,
      refreshed: 0,
    },
  };
}

describe('an unfinished run', () => {
  it('announces a partial run as status rather than a load refusal', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PartialRunStatus reason="The scan was cancelled." />
      </MemoryRouter>
    );

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('This run is partial');
  });

  it('shows evidence and the exact review while withholding overall and pillar scores', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <ReviewGate scan={unfinishedRun()} pillarTitle={() => 'Reliability'} reviewId="review-exact-107c" />
      </MemoryRouter>
    );

    expect(markup).toContain('Review before results');
    expect(markup).toContain('1</dd>');
    expect(markup).toContain('2 of 7 pillars recorded');
    expect(markup).toContain('href="/review/review-exact-107c"');
    expect(markup).not.toContain('12.345');
    expect(markup).not.toContain('98.765');
    expect(markup).not.toContain('/ 100');
  });
});
