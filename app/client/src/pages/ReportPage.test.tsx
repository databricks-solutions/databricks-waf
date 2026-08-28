import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { ImprovementAction, Score } from '../api/types';
import type { Gap } from '../components/evidence-gaps';
import { PillarMatrix } from '../components/PillarMatrix';
import { reportPreviewFixture } from '../system/customer-preview-fixtures';
import { ExecutiveSummary, ReportAppendixTable, ReportMeasurementGaps } from './ReportPage';

const SCORE: Score = {
  overall: 81,
  totalControls: 184,
  scoredControls: 68,
  counts: {
    pass: 54,
    fail: 9,
    partial: 5,
    unmeasurable: 94,
    'not-applicable': 22,
    'satisfied-by-architecture': 0,
  },
  composition: { observed: 60, attested: 8, 'admin-collected': 0 },
  range: { low: 32, high: 96 },
  pillars: [],
};

const SCAN: Parameters<typeof ExecutiveSummary>[0]['scan'] = { score: SCORE };

const RISK: Parameters<typeof ExecutiveSummary>[0]['ranked'][number] = {
  finding: {
    controlId: 'SEC-01-01',
    title: 'Restrict public network access',
    severity: 'critical',
  },
};

const ACTION = (state: ImprovementAction['state']): Parameters<typeof ExecutiveSummary>[0]['actions'][number] => ({
  state,
});

describe('the executive and governance report summary', () => {
  it('answers posture, confidence, risk, progress and first action in one section', () => {
    const markup = renderToStaticMarkup(
      <ExecutiveSummary
        scan={SCAN}
        ranked={[RISK]}
        held={[RISK]}
        actions={[ACTION('in-progress'), ACTION('blocked'), ACTION('verified')]}
      />
    );

    expect(markup).toContain('Executive summary');
    expect(markup).toContain('42%');
    expect(markup).toContain('Low confidence');
    expect(markup).toContain('Directional—too little is measured for a settled score');
    expect(markup).toContain('2 active');
    expect(markup).toContain('1 verified · 1 blocked');
    expect(markup).toContain('Restrict public network access');
    expect(markup).toContain('href="#control-SEC-01-01"');
    expect(markup).toContain('94 requirements were unanswered');
    expect(markup).toContain('href="#measurement-gaps"');
    expect(markup).toContain('href="#governance-decisions"');
  });

  it('separates measurement assurance from the action queue and links its next steps', () => {
    const gap: Gap = {
      id: 'attestation',
      title: 'Requirements only a person can confirm',
      blocked: 37,
      pillars: ['Reliability'],
      resolve: 'These practices need an accountable person to answer them.',
      counted: true,
      action: { label: 'View requirements', to: '/answers' },
    };
    const router = createMemoryRouter(
      [{ path: '*', element: <ReportMeasurementGaps gaps={[gap]} unanswered={37} /> }],
      { initialEntries: ['/report/result-1'] }
    );
    const markup = renderToStaticMarkup(<RouterProvider router={router} />);

    expect(markup).toContain('37 unanswered requirements');
    expect(markup).toContain('Requirements only a person can confirm');
    expect(markup).toContain('These practices need an accountable person');
    expect(markup).toContain('href="/answers"');
  });

  it('gives every report table value a label when rows become mobile records', () => {
    const fixture = reportPreviewFixture('complete');
    const appendix = renderToStaticMarkup(<ReportAppendixTable rows={fixture.rows.slice(0, 1)} />);
    const router = createMemoryRouter(
      [{ path: '*', element: <PillarMatrix rows={fixture.pillarRows.slice(0, 1)} /> }],
      { initialEntries: ['/report/preview'] }
    );
    const pillars = renderToStaticMarkup(<RouterProvider router={router} />);

    for (const label of ['Requirement', 'Pillar', 'Outcome', 'Note']) {
      expect(appendix).toContain(`data-label="${label}"`);
    }
    for (const label of ['Pillar', 'Posture', 'Assessed', 'Unmet', 'Confidence', 'Change']) {
      expect(pillars).toContain(`data-label="${label}"`);
    }
  });
});
