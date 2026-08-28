// The first Dashboard shows what automated collection found without becoming a published assessment.
// These assertions hold both halves: indicative pillar scores and their limits are visible, while
// final-only findings, reports and exports remain behind review.

import { renderToStaticMarkup } from 'react-dom/server';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { describe, expect, it } from 'vitest';
import { UnpublishedSummary } from './UnpublishedSummary';
import type { AssessmentReview, AttestableRequirement, PillarScore, Score } from '../api/types';

const PILLARS = [
  { id: 'cost-optimization', title: 'Cost optimization' },
  { id: 'data-and-ai-governance', title: 'Data and AI governance' },
  { id: 'interoperability-and-usability', title: 'Interoperability and usability' },
  { id: 'operational-excellence', title: 'Operational excellence' },
  { id: 'performance-efficiency', title: 'Performance efficiency' },
  { id: 'reliability', title: 'Reliability' },
  { id: 'security-compliance-and-privacy', title: 'Security, compliance, and privacy' },
] as const;

function pillarScore(pillarId: string, index: number): PillarScore {
  const score = 61 + index;
  return {
    pillarId,
    score,
    range: index === 0 ? { low: 18, high: 82 } : { low: score, high: score },
    counts: {
      pass: 3,
      fail: 1,
      partial: 0,
      unmeasurable: 3,
      'not-applicable': 2,
      'satisfied-by-architecture': 0,
    },
    scored: 4,
    unmeasurable: 3,
    unmeasuredBy: { attestation: 3, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
    composition: { observed: 4, 'admin-collected': 0, attested: 0 },
    notApplicable: 2,
    total: 9,
    worstFirst: [],
  };
}

const SCORE: Score = {
  overall: 64,
  range: { low: 54, high: 73 },
  pillars: PILLARS.map((pillar, index) => pillarScore(pillar.id, index)),
  counts: {
    pass: 21,
    fail: 7,
    partial: 0,
    unmeasurable: 21,
    'not-applicable': 14,
    'satisfied-by-architecture': 0,
  },
  scoredControls: 28,
  composition: { observed: 28, 'admin-collected': 0, attested: 0 },
  totalControls: 63,
};

const SCAN = {
  id: 'run-1',
  state: 'complete' as const,
  measurement: PILLARS.map((pillar) => ({
    pillarId: pillar.id,
    scanId: 'run-1',
    measuredAt: '2026-08-20T00:00:00.000Z',
    actor: 'collector@example.com',
    carriedForward: false,
  })),
  estate: { assessed: Array.from({ length: 13 }, (_, index) => ({ id: String(index), name: `Workspace ${index}` })) },
  findings: [
    { title: 'A provisional result must stay private', outcome: 'fail' },
    { title: 'Another provisional result', outcome: 'pass' },
  ],
  score: SCORE,
};

function requirement(
  pillarId: string,
  index: number,
  askedBecause: AttestableRequirement['askedBecause'] = 'no-telemetry'
): AttestableRequirement {
  return {
    controlId: `${pillarId}-${String(index)}`,
    pillarId,
    principleId: `${pillarId}-principle`,
    title: `Question ${String(index)}`,
    severity: 'medium',
    askedBecause,
    question: 'What practice is in place?',
    cadenceDays: 90,
  };
}

const REQUIREMENTS: readonly AttestableRequirement[] = [
  ...PILLARS.flatMap((pillar) => [1, 2, 3].map((index) => requirement(pillar.id, index))),
  // The scan hands inconclusive checks to Review too. They are not in unmeasuredBy.attestation.
  requirement('cost-optimization', 4, 'inconclusive'),
];

const REVIEW: AssessmentReview = {
  id: 'review-1',
  runId: 'run-1',
  openedBy: 'reviewer@example.com',
  openedAt: '2026-08-20T00:00:00.000Z',
  pillars: [],
  answers: [],
  durable: true,
};

function render(over: Partial<Parameters<typeof UnpublishedSummary>[0]> = {}): string {
  const router = createMemoryRouter(
    [
      {
        path: '*',
        element: (
          <UnpublishedSummary
            scan={SCAN}
            pillars={PILLARS}
            review={REVIEW}
            reviewLoading={false}
            requirements={REQUIREMENTS}
            requirementsLoading={false}
            {...over}
          />
        ),
      },
    ],
    { initialEntries: ['/overview'] }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe('the unpublished Dashboard', () => {
  it('shows an indicative automated score and evidence gap for every pillar before review', () => {
    const markup = render();

    expect(markup).toContain('Your indicative results are ready');
    expect(markup).toContain('Indicative scores by pillar');
    expect(markup).toContain('Based on automated observations from this scan');
    expect(markup).toContain('13 workspaces');
    expect(markup).toContain('7 pillars');
    expect(markup).toContain('63 recorded');
    expect(markup).toContain('0 of 7 pillars recorded');
    expect(markup).toContain('href="/review/review-1"');
    expect(markup).toContain('href="/review/review-1?pillar=cost-optimization"');
    expect(markup).toContain('href="/history/run-1"');
    expect(markup.match(/Indicative score/g)).toHaveLength(8);
    expect(markup.match(/\/100/g)).toHaveLength(7);
    expect(markup).toContain('61');
    expect(markup).toContain('67');
    expect(markup).toContain('4 of 7 applicable evaluated');
    expect(markup).toContain('4 automated observations');
    expect(markup).toContain('3 human-evidence questions need attention');
    expect(markup).toContain('4 human-evidence questions need attention');
    expect(markup).toContain('Review 4 questions');
    expect(markup).toContain('Review 3 questions');
    expect(markup).toContain('Too little measured');
    expect(markup).toContain('18–82');
    expect(markup).toContain('not the published report');
    expect(markup).not.toContain('provisional result');
    expect(markup).not.toContain('Not met');
    expect(markup).not.toContain('Export');
    expect(markup).not.toContain('Priority findings');
  });

  it('states reused evidence instead of calling the whole score automated', () => {
    const first = SCORE.pillars[0];
    if (first == null) throw new Error('The score fixture has no first pillar.');
    const markup = render({
      scan: {
        ...SCAN,
        score: {
          ...SCORE,
          pillars: [
            { ...first, composition: { observed: 3, 'admin-collected': 0, attested: 1 } },
            ...SCORE.pillars.slice(1),
          ],
        },
      },
    });

    expect(markup).toContain('recorded evidence mix');
    expect(markup).toContain('3 automated observations · 1 human answer');
    expect(markup).not.toContain('Based on automated observations from this scan');
  });

  it('calls a still-valid due answer review work rather than missing human evidence', () => {
    const first = SCORE.pillars[0];
    if (first == null) throw new Error('The score fixture has no first pillar.');
    const due = {
      ...requirement('cost-optimization', 1),
      attestation: {
        id: 'answer-1',
        controlId: 'cost-optimization-1',
        answer: 'met' as const,
        statement: 'The practice is recorded.',
        owner: 'platform-owner@example.com',
        attestedBy: 'platform-owner@example.com',
        attestedAt: '2026-08-01T00:00:00.000Z',
        reviewBy: '2026-09-01T00:00:00.000Z',
        state: 'due' as const,
      },
    };
    const markup = render({
      scan: {
        ...SCAN,
        score: {
          ...SCORE,
          pillars: [
            { ...first, composition: { observed: 3, 'admin-collected': 0, attested: 1 } },
            ...SCORE.pillars.slice(1),
          ],
        },
      },
      requirements: [due],
    });

    expect(markup).toContain('3 automated observations · 1 human answer');
    expect(markup).toContain('1 human-evidence question needs attention');
    expect(markup).toContain('Review 1 question');
    expect(markup).not.toContain('needs human evidence');
  });

  it('shows each recorded pillar decision without turning a skip into a confirm', () => {
    const markup = render({
      review: {
        ...REVIEW,
        pillars: [
          {
            id: 'pillar-1',
            reviewId: 'review-1',
            runId: 'run-1',
            pillarId: 'cost-optimization',
            kind: 'confirmed',
            attestationIds: [],
            by: 'reviewer@example.com',
            at: '2026-08-20T00:01:00.000Z',
          },
          {
            id: 'pillar-2',
            reviewId: 'review-1',
            runId: 'run-1',
            pillarId: 'reliability',
            kind: 'skipped',
            unresolvedControlIds: ['RE-01-01'],
            by: 'reviewer@example.com',
            at: '2026-08-20T00:02:00.000Z',
          },
        ],
      },
    });

    expect(markup).toContain('2 of 7 pillars recorded');
    expect(markup).toContain('Confirmed');
    expect(markup).toContain('Skipped');
    expect(markup).toContain('href="/review/review-1?pillar=reliability"');
  });

  it('renders an unreadable review as unknown rather than zero progress', () => {
    const markup = render({ review: undefined, reviewIssue: 'The review store could not be read.' });

    expect(markup).toContain('Review status unavailable');
    expect(markup).toContain('The review store could not be read.');
    expect(markup).toContain('Status unavailable');
    expect(markup).not.toContain('0 of 7 pillars recorded');
  });

  it('qualifies scores from a partial run instead of calling collection complete', () => {
    const markup = render({
      scan: { ...SCAN, state: 'partial', incompleteReason: 'Two collection surfaces did not return.' },
    });

    expect(markup).toContain('Collection incomplete');
    expect(markup).toContain('Indicative results from the partial run');
    expect(markup).toContain('Two collection surfaces did not return.');
    expect(markup).not.toContain('Automated checks complete');
  });

  it('names the earlier run for a carried-forward pillar', () => {
    const [first, ...rest] = SCAN.measurement;
    if (first == null) throw new Error('The scan fixture has no pillar measurement.');
    const markup = render({
      scan: {
        ...SCAN,
        measurement: [
          {
            ...first,
            scanId: 'run-before',
            measuredAt: '2026-08-04T00:00:00.000Z',
            carriedForward: true,
          },
          ...rest,
        ],
      },
    });

    expect(markup).toContain('Carried-forward pillars name the earlier scan');
    expect(markup).toContain('Carried forward from');
    expect(markup).toContain('href="/history/run-before"');
    expect(markup).not.toContain('Based on automated observations from this scan');
  });

  it('does not turn an unreadable question set into no outstanding human evidence', () => {
    const markup = render({
      requirements: undefined,
      requirementsIssue: 'The human-evidence questions could not be read.',
    });

    expect(markup).toContain('The human-evidence questions could not be read.');
    expect(markup).toContain('Human-evidence questions unavailable');
    expect(markup).not.toContain('No human-evidence questions need attention');
  });
});
