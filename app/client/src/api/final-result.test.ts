import { describe, expect, it } from 'vitest';
import { customerResult } from './final-result';
import type { AssessmentResult, Scan } from './types';

const counts = {
  pass: 0,
  fail: 1,
  partial: 0,
  unmeasurable: 0,
  'not-applicable': 0,
  'satisfied-by-architecture': 0,
} as const;

function source(): Scan {
  return {
    id: 'run-raw',
    startedAt: '2026-08-20T00:00:00.000Z',
    finishedAt: '2026-08-20T00:01:00.000Z',
    state: 'complete',
    stamp: {
      catalogueVersion: 'raw-revision',
      catalogueFingerprint: 'raw-fingerprint',
      actor: 'reader@example.com',
      executionMode: 'on-behalf-of-user',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    measurement: [],
    score: {
      overall: 99,
      pillars: [],
      counts: { ...counts, pass: 1, fail: 0 },
      scoredControls: 1,
      composition: { observed: 1, 'admin-collected': 0, attested: 0 },
      totalControls: 1,
    },
    findings: [],
    footprint: { surfaces: [], durationMs: 1, cancelled: false, concurrencyReductions: 0 },
    spend: [],
    signals: [],
    estate: { workspacesInAccount: 0, assessed: [], excluded: [] },
  };
}

function result(): AssessmentResult {
  return {
    id: 'result-customer',
    reviewId: 'review-1',
    runId: 'run-raw',
    finalisedBy: 'reviewer@example.com',
    finalisedAt: '2026-08-20T00:05:00.000Z',
    pillars: [],
    attestationIds: [],
    finalAssessment: {
      schemaVersion: 2,
      definition: { id: 'definition-1', version: 3, fingerprint: 'definition-fingerprint' },
      versions: {
        methodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'released' },
        catalogue: { revision: 'released-revision', fingerprint: 'released-fingerprint' },
        scoring: 'sha256:scoring',
      },
      executionMode: 'service-principal',
      automatedEvidence: { runDigest: 'sha256:run', findingIds: ['finding-1'], evidenceIds: [] },
      humanEvidence: [],
      decisions: [],
      outcome: {
        findings: [
          {
            id: 'finding-1',
            evidenceIds: [],
            confidence: { standing: 'established', because: 'The final result froze it.', limitations: [] },
            finding: {
              controlId: 'RE-01-01',
              pillarId: 'reliability',
              principleId: 'reliability-one',
              title: 'Keep the service available',
              outcome: 'fail',
              severity: 'high',
              coverage: { mode: 'complete' },
              evidence: [],
            },
          },
        ],
        score: {
          overall: 12,
          pillars: [
            {
              pillarId: 'reliability',
              score: 12,
              counts,
              scored: 1,
              unmeasurable: 0,
              unmeasuredBy: { attestation: 0, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
              composition: { observed: 1, 'admin-collected': 0, attested: 0 },
              notApplicable: 0,
              total: 1,
            },
          ],
          counts,
          scoredControls: 1,
          composition: { observed: 1, 'admin-collected': 0, attested: 0 },
          totalControls: 1,
        },
        coverage: { answered: 1, total: 1 },
      },
      disclosure: {
        reusedAttestationIds: [],
        refreshedAttestationIds: [],
        skippedPillarIds: [],
        unresolvedControlIds: [],
        unmeasuredControlIds: [],
        counts: { reused: 0, refreshed: 0, skipped: 0, unresolved: 0, unmeasured: 0 },
      },
      publication: { eligible: true, reasons: [] },
    },
  };
}

describe('the customer result boundary', () => {
  it('keeps the source run facts and replaces every provisional outcome with the frozen final assessment', () => {
    const final = customerResult(result(), source());

    expect(final?.id).toBe('result-customer');
    expect(final?.assessment.id).toBe('run-raw');
    expect(final?.assessment.score.overall).toBe(12);
    expect(final?.assessment.findings[0]?.outcome).toBe('fail');
    expect(final?.assessment.score.pillars[0]?.worstFirst[0]?.controlId).toBe('RE-01-01');
    expect(final?.assessment.stamp.publicMethodology?.publicVersion).toBe(1);
    expect(final?.assessment.stamp.catalogueVersion).toBe('released-revision');
    expect(final?.assessment.stamp.executionMode).toBe('service-principal');
  });

  it('refuses a result joined to any run except the one it names', () => {
    expect(customerResult(result(), { ...source(), id: 'run-other' })).toBeUndefined();
  });
});
