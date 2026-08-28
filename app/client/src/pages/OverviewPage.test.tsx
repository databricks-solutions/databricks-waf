import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { Score } from '../api/types';
import type { Gap } from '../components/evidence-gaps';
import type { RankedFinding } from '../components/finding-rank';
import {
  DashboardActionQueue,
  DashboardChanges,
  DashboardMeasurementGaps,
  PartialScanStatus,
  PendingReviewStatus,
  DashboardPosture,
  DashboardPriority,
} from './OverviewPage';

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

const SCAN: Parameters<typeof DashboardPosture>[0]['scan'] = {
  finishedAt: '2026-08-21T04:46:00.000Z',
  score: SCORE,
};

const GAP: Gap = {
  id: 'attestation',
  title: 'Requirements only a person can confirm',
  blocked: 37,
  pillars: ['Reliability'],
  resolve: 'These practices need an accountable person to answer them.',
  counted: true,
  action: { label: 'View requirements', to: '/answers' },
};

const FINDING: NonNullable<Parameters<typeof DashboardPriority>[0]['first']> = {
  finding: {
    controlId: 'SEC-01-01',
    title: 'Restrict public network access',
    severity: 'critical',
    outcomeReason: 'Three workspaces permit public access.',
  },
  affected: 3,
  population: 3,
};

const RANKED: RankedFinding = {
  finding: {
    ...FINDING.finding,
    pillarId: 'security-compliance-and-privacy',
    principleId: 'secure-networking',
    outcome: 'fail',
    coverage: { mode: 'complete', examined: 3, population: 3 },
    evidence: [],
  },
  affected: 3,
  population: 3,
  confidence: 'thin',
  fix: 'documented',
};

function render(element: React.ReactNode): string {
  const router = createMemoryRouter([{ path: '*', element }], { initialEntries: ['/overview'] });
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('the Dashboard hierarchy', () => {
  it('announces a partial scan as status rather than a load refusal', () => {
    const markup = render(<PartialScanStatus reason="The scan was cancelled." />);

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('This scan is partial');
  });

  it('announces a pending review as status, not as a customer-action refusal', () => {
    const markup = render(<PendingReviewStatus to="/review/review-1" />);

    expect(markup).toContain('role="status"');
    expect(markup).not.toContain('role="alert"');
    expect(markup).toContain('href="/review/review-1"');
  });

  it('leads with measured coverage and subordinates a directional score', () => {
    const markup = render(<DashboardPosture scan={SCAN} resultId="result-1" />);

    expect(markup).toContain('42%');
    expect(markup).toContain('68 of 162 applicable requirements');
    expect(markup).toContain('Directional—close evidence gaps first');
    expect(markup).toContain('Application-defined');
    expect(markup).toContain('href="/report/result-1"');
  });

  it('makes evidence closure the first action when the score is too directional', () => {
    const markup = render(<DashboardPriority scan={SCAN} gaps={[GAP]} actions={[]} />);

    expect(markup).toContain('Do this first');
    expect(markup).toContain('Answer 37 practice requirements');
    expect(markup).toContain('href="/answers"');
    expect(markup).not.toContain('Restrict public network access');
  });

  it('keeps long implementation guidance behind disclosure and makes the workspace link the CTA', () => {
    const settled: Parameters<typeof DashboardPriority>[0]['scan'] = {
      ...SCAN,
      score: { ...SCORE, range: { low: 78, high: 84 } },
    };
    const control: NonNullable<Parameters<typeof DashboardPriority>[0]['control']> = {
      remediation: {
        summary:
          'Configure a long sequence of platform settings, document every exception and repeat the verification across every workspace in the account.',
        deepLink: 'https://example.cloud.databricks.com/settings/networking',
      },
    };
    const markup = render(
      <DashboardPriority scan={settled} gaps={[]} first={FINDING} control={control} actions={[]} />
    );

    expect(markup).toContain('<h2');
    expect(markup).toContain('Restrict public network access</h2>');
    expect(markup).toContain('Open in Databricks');
    expect(markup).toContain('href="https://example.cloud.databricks.com/settings/networking"');
    expect(markup).toContain('Implementation guidance:');
    expect(markup).toContain('<details');
  });

  it('routes an existing action through its plan id rather than its action id', () => {
    const markup = render(
      <DashboardPriority
        scan={{ ...SCAN, score: { ...SCORE, range: { low: 78, high: 84 } } }}
        gaps={[]}
        first={FINDING}
        actions={[
          {
            id: 'action-uuid-that-is-not-a-plan',
            planId: 'plan-customer-can-open',
            controlIds: ['SEC-01-01'],
            state: 'in-progress',
            owner: 'Platform team',
            definitionOfDone: 'A later assessment verifies the requirement.',
          },
        ]}
      />
    );

    expect(markup).toContain('Continue improvement');
    expect(markup).toContain('href="/improvements/plan-customer-can-open?control=SEC-01-01"');
    expect(markup).not.toContain('/improvements/action-uuid-that-is-not-a-plan');
  });

  it('renders a concise actionable queue with human titles before technical ids', () => {
    const markup = render(<DashboardActionQueue queue={[RANKED]} held={2} />);

    expect(markup).toContain('Next actions');
    expect(markup).toContain('Restrict public network access');
    expect(markup).toContain('3 of 3 resources');
    expect(markup).toContain('SEC-01-01');
    expect(markup).toContain('href="/investigate?control=SEC-01-01"');
    expect(markup).toContain('View all 3');
    expect(markup).not.toContain('Nothing unmet');
  });

  it('hides measurement-gap chrome when there is no actionable gap', () => {
    expect(render(<DashboardMeasurementGaps gaps={[]} />)).not.toContain('Review assessment coverage');
    expect(
      render(
        <DashboardMeasurementGaps
          gaps={[
            {
              id: GAP.id,
              title: GAP.title,
              blocked: GAP.blocked,
              pillars: GAP.pillars,
              resolve: GAP.resolve,
              counted: GAP.counted,
            },
          ]}
        />
      )
    ).not.toContain('Review assessment coverage');
  });

  it('does not warn a fully evaluated clean result about answers it does not need', () => {
    const markup = render(
      <DashboardPriority
        scan={{
          ...SCAN,
          score: {
            ...SCORE,
            counts: { ...SCORE.counts, fail: 0, partial: 0, unmeasurable: 0 },
            range: { low: 94, high: 94 },
          },
        }}
        gaps={[]}
        actions={[]}
      />
    );

    expect(markup).toContain('Every applicable requirement was evaluated');
    expect(markup).not.toContain('Review unanswered requirements');
  });

  it('links every actionable measurement gap to its exact workflow', () => {
    const markup = render(<DashboardMeasurementGaps gaps={[GAP]} />);

    expect(markup).toContain('Review assessment coverage');
    expect(markup).toContain('37 unanswered requirements have a next step.');
    expect(markup).toContain('Answer 37 practice requirements');
    expect(markup).toContain('href="/answers"');
  });

  it('counts only unanswered requirements in the coverage summary', () => {
    const markup = render(
      <DashboardMeasurementGaps
        gaps={[
          { ...GAP, blocked: 11 },
          {
            id: 'not-applicable',
            title: '8 requirements that do not apply to this estate',
            blocked: 8,
            pillars: ['Reliability'],
            resolve: 'These requirements are outside the score.',
            counted: false,
            action: { label: 'View requirements', to: '/investigate?outcome=not-applicable' },
          },
          {
            id: 'silent-signals',
            title: '5 collectors returned nothing',
            blocked: 5,
            pillars: [],
            resolve: 'The collectors produced no usable observation.',
            counted: false,
            action: { label: 'See the run record', to: '/history/run-1' },
          },
        ]}
      />
    );

    expect(markup).toContain('11 unanswered requirements have a next step.');
    expect(markup).not.toContain('24 unanswered requirements');
    expect(markup).toContain('2 separate assessment follow-ups are listed below.');
    expect(markup).toContain('Review 8 excluded requirements');
    expect(markup).toContain('Inspect 5 collectors that returned nothing');
    expect(markup).not.toContain('largest evidence gap');
  });

  it('does not call exclusions or silent collectors unanswered when those are the only follow-ups', () => {
    const markup = render(
      <DashboardMeasurementGaps
        gaps={[
          {
            id: 'not-applicable',
            title: 'One requirement that does not apply to this estate',
            blocked: 1,
            pillars: ['Reliability'],
            resolve: 'This requirement is outside the score.',
            counted: false,
            action: { label: 'View requirement', to: '/investigate?outcome=not-applicable' },
          },
        ]}
      />
    );

    expect(markup).toContain('1 assessment follow-up is listed below.');
    expect(markup).toContain('Review 1 excluded requirement');
    expect(markup).not.toContain('unanswered requirement');
    expect(markup).not.toContain('evidence gap');
  });

  it('keeps the material-change summary concise and linked to the run record', () => {
    const markup = render(
      <DashboardChanges
        scan={{ id: 'run-2' }}
        history={[{ id: 'run-2', finishedAt: '2026-08-21T04:46:00.000Z' }]}
        lines={['Coverage increased from 31% to 42% of applicable requirements.', 'Two risks were resolved.']}
        loading={false}
      />
    );

    expect(markup).toContain('What materially changed');
    expect(markup).toContain('Coverage increased from 31% to 42%');
    expect(markup).toContain('href="/history/run-2"');
  });
});
