import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import type { AssessmentResult, AssessmentReview, PillarReview } from '../api/types';
import { AssessStatePage, AssessmentDefinitionRequired, PublishedReview } from './ReviewPage';

const PILLARS: readonly PillarReview[] = [
  {
    id: 'pillar-confirmed',
    reviewId: 'review-complete',
    runId: 'run-complete',
    pillarId: 'reliability',
    kind: 'confirmed',
    attestationIds: ['answer-1'],
    by: 'reviewer@example.com',
    at: '2026-08-20T00:00:00.000Z',
  },
  {
    id: 'pillar-skipped',
    reviewId: 'review-complete',
    runId: 'run-complete',
    pillarId: 'cost-optimization',
    kind: 'skipped',
    unresolvedControlIds: ['CO-01'],
    by: 'reviewer@example.com',
    at: '2026-08-20T00:01:00.000Z',
  },
];

function completed(eligible: boolean): AssessmentReview {
  const counts = {
    pass: 0,
    fail: 0,
    partial: 0,
    unmeasurable: 0,
    'not-applicable': 0,
    'satisfied-by-architecture': 0,
  } as const;
  const result: AssessmentResult = {
    id: 'result-complete',
    reviewId: 'review-complete',
    runId: 'run-complete',
    finalisedBy: 'reviewer@example.com',
    finalisedAt: '2026-08-20T00:02:00.000Z',
    pillars: PILLARS,
    attestationIds: ['answer-1'],
    finalAssessment: {
      schemaVersion: 2,
      definition: { id: 'definition-1', version: 1, fingerprint: 'definition-fingerprint' },
      versions: {
        methodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
        catalogue: { revision: 'revision-1', fingerprint: 'catalogue-fingerprint' },
        scoring: 'scoring-fingerprint',
      },
      executionMode: 'on-behalf-of-user',
      automatedEvidence: { runDigest: 'sha256:run', findingIds: [], evidenceIds: [] },
      humanEvidence: [],
      decisions: [],
      outcome: {
        findings: [],
        score: {
          pillars: [],
          counts,
          scoredControls: 0,
          composition: { observed: 0, 'admin-collected': 0, attested: 0 },
          totalControls: 0,
        },
        coverage: { answered: 0, total: 0 },
      },
      disclosure: {
        reusedAttestationIds: [],
        refreshedAttestationIds: [],
        skippedPillarIds: eligible ? [] : ['cost-optimization'],
        unresolvedControlIds: eligible ? [] : ['CO-01'],
        unmeasuredControlIds: eligible ? [] : ['CO-01'],
        counts: {
          reused: 0,
          refreshed: 0,
          skipped: eligible ? 0 : 1,
          unresolved: eligible ? 0 : 1,
          unmeasured: eligible ? 0 : 1,
        },
      },
      publication: { eligible, reasons: eligible ? [] : ['methodology-not-released'] },
    },
  };
  return {
    id: 'review-complete',
    runId: 'run-complete',
    openedBy: 'reviewer@example.com',
    openedAt: '2026-08-20T00:00:00.000Z',
    pillars: PILLARS,
    answers: [],
    result,
    durable: true,
  };
}

describe('the completed review handoff', () => {
  it('makes the exact setup action dominant when an ad-hoc run cannot enter human review', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AssessmentDefinitionRequired runId="run-ad-hoc" />
      </MemoryRouter>
    );

    expect(markup).toContain('Review needs a saved assessment');
    expect(markup).toContain('indicative automated result');
    expect(markup).toContain('href="/definitions/setup"');
    expect(markup).toContain('Define an assessment');
    expect(markup).toContain('href="/history/run-ad-hoc"');
    expect(markup).toContain('View automated result');
    expect(markup.indexOf('Define an assessment')).toBeLessThan(markup.indexOf('View automated result'));
  });

  it('keeps the Assess stage, recovery action and Dashboard route in one semantic hierarchy', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <AssessStatePage
          title="Review the collected evidence"
          summary="The review could not be read."
          heading="The review could not be read"
          detail="The store did not answer."
          technicalDetail="No scan with id 00000000-0000-0000-0000-000000000000."
          reason="collector-failed"
          action={<button type="button">Try again</button>}
        />
      </MemoryRouter>
    );

    expect(markup).toContain('<h2 class="wa-type-page">Review the collected evidence</h2>');
    expect(markup).toContain('Prepare → Collect → Review → Publish');
    expect(markup).toContain('href="/overview"');
    expect(markup.indexOf('The review could not be read')).toBeLessThan(markup.indexOf('Try again'));
    expect(markup).toContain('<details class="wa-technical-disclosure">');
    expect(markup).toContain('For support and diagnostics');
  });

  it('makes the Dashboard the dominant destination for an eligible result', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PublishedReview review={completed(true)} />
      </MemoryRouter>
    );
    expect(markup).toContain('Your Dashboard is ready');
    expect(markup).toContain('href="/overview"');
    expect(markup).toContain('Open Dashboard');
    expect(markup).toContain('Pillars recorded');
    expect(markup).toContain('Skipped');
  });

  it('opens the Dashboard while keeping a separate external-publication hold visible', () => {
    const markup = renderToStaticMarkup(
      <MemoryRouter>
        <PublishedReview review={completed(false)} />
      </MemoryRouter>
    );
    expect(markup).toContain('Your Dashboard is ready');
    expect(markup).toContain('Open Dashboard');
    expect(markup).toContain('Methodology Version 1 is not released');
    expect(markup).toContain('monthly publication remains held');
    expect(markup).not.toContain('methodology-not-released');
    expect(markup).not.toContain('not eligible to appear on the Dashboard');
  });
});
