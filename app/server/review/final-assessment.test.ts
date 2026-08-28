import { describe, expect, it } from 'vitest';
import type { Finding } from '../resolve/finding.js';
import { digestOf } from '../records/digest.js';
import { finalised, opened, confirmed, skipped, type AssessmentResult } from './review.js';
import {
  FINAL_ASSESSMENT_SCHEMA_VERSION,
  publicationOf,
  reviveFinalAssessment,
  versionedFinalAssessment,
  type FinalAssessmentDraft,
  type FrozenScore,
} from './final-assessment.js';

const AT = new Date('2026-08-19T10:00:00.000Z');
const REVIEW_BY = new Date('2026-11-19T10:00:00.000Z');
const PILLARS = ['security-compliance-and-privacy', 'reliability'] as const;

function legacy(): AssessmentResult {
  const review = opened({
    id: 'review-1',
    runId: 'scan-1',
    openedBy: 'priya@example.com',
    openedAt: AT,
    definitionId: 'definition-1',
    definitionVersion: 3,
    definitionFingerprint: 'sha256:definition',
  });
  return finalised(
    {
      id: 'result-1',
      review,
      pillars: [
        confirmed(
          {
            id: 'decision-security',
            reviewId: review.id,
            runId: review.runId,
            pillarId: PILLARS[0],
            by: 'priya@example.com',
            at: AT,
            attestationIds: ['attestation-1'],
          },
          PILLARS
        ),
        skipped(
          {
            id: 'decision-reliability',
            reviewId: review.id,
            runId: review.runId,
            pillarId: PILLARS[1],
            by: 'priya@example.com',
            at: AT,
          },
          PILLARS
        ),
      ],
      finalisedBy: 'priya@example.com',
      finalisedAt: AT,
    },
    PILLARS
  );
}

function finding(): Finding {
  return {
    controlId: 'SC-01-01',
    pillarId: PILLARS[0],
    principleId: 'security-1',
    title: 'Identity is reviewed',
    outcome: 'pass',
    severity: 'high',
    coverage: { mode: 'complete' },
    evidence: [
      {
        signal: 'rest:workspace:current-user',
        observed: 'Identity was readable.',
        coverage: { mode: 'complete' },
        collectedAt: AT,
      },
    ],
    attested: {
      id: 'attestation-1',
      bearing: 'record',
      by: 'priya@example.com',
      at: AT,
      statement: 'Reviewed.',
      owner: 'platform@example.com',
      reviewBy: REVIEW_BY,
    },
  };
}

function score(): FrozenScore {
  return {
    overall: 100,
    range: { low: 100, high: 100 },
    pillars: [
      {
        pillarId: PILLARS[0],
        score: 100,
        range: { low: 100, high: 100 },
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
      },
    ],
    counts: {
      pass: 1,
      fail: 0,
      partial: 0,
      unmeasurable: 0,
      'not-applicable': 0,
      'satisfied-by-architecture': 0,
    },
    scoredControls: 1,
    composition: { observed: 1, 'admin-collected': 0, attested: 0 },
    totalControls: 1,
  };
}

function draft(state: 'candidate' | 'released' = 'released'): FinalAssessmentDraft {
  return {
    definition: { id: 'definition-1', version: 3, fingerprint: 'sha256:definition' },
    versions: {
      methodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:manifest',
        state,
        ...(state === 'released' ? { effectiveDate: '2026-08-19' } : {}),
      },
      catalogue: { revision: '18', fingerprint: 'sha256:catalogue' },
      scoring: 'sha256:scoring',
    },
    executionMode: 'on-behalf-of-user',
    runDigest: 'sha256:run',
    findings: [
      {
        id: 'finding-security-1',
        finding: finding(),
        evidenceIds: ['evidence-security-1'],
        confidence: { standing: 'established', because: 'The evidence is complete.', limitations: [] },
      },
    ],
    score: score(),
    humanEvidence: [
      {
        attestationId: 'attestation-1',
        pillarId: PILLARS[0],
        controlId: 'SC-01-01',
        selection: 'reused',
      },
    ],
    unresolved: [{ pillarId: PILLARS[1], controlIds: ['REL-01-01'] }],
    unmeasuredControlIds: ['REL-01-01'],
  };
}

describe('the Version 2 final-assessment contract', () => {
  it('keeps an old body readable and explicitly ineligible', () => {
    const old = legacy();
    expect(old.runId).toBe('scan-1');
    expect(old.schemaVersion).toBeUndefined();
    expect(publicationOf(old, PILLARS)).toEqual({ eligible: false, reasons: ['legacy-result'] });
  });

  it('freezes every identity, evidence class, decision, disclosure and calculated outcome', () => {
    const result = versionedFinalAssessment(legacy(), draft(), PILLARS);

    expect(result.schemaVersion).toBe(FINAL_ASSESSMENT_SCHEMA_VERSION);
    expect(result.finalAssessment).toMatchObject({
      definition: { id: 'definition-1', version: 3, fingerprint: 'sha256:definition' },
      versions: {
        methodology: { publicVersion: 1, state: 'released' },
        catalogue: { revision: '18', fingerprint: 'sha256:catalogue' },
        scoring: 'sha256:scoring',
      },
      executionMode: 'on-behalf-of-user',
      automatedEvidence: {
        runDigest: 'sha256:run',
        findingIds: ['finding-security-1'],
        evidenceIds: ['evidence-security-1'],
      },
      disclosure: {
        reusedAttestationIds: ['attestation-1'],
        skippedPillarIds: ['reliability'],
        unresolvedControlIds: ['REL-01-01'],
        unmeasuredControlIds: ['REL-01-01'],
        counts: { reused: 1, refreshed: 0, skipped: 1, unresolved: 1, unmeasured: 1 },
      },
      publication: { eligible: true, reasons: [] },
    });
    expect(publicationOf(result, PILLARS)).toEqual({ eligible: true, reasons: [] });
  });

  it('revalidates a narrow report against its immutable selected set, not the full catalogue', () => {
    const full = legacy();
    const narrow: AssessmentResult = {
      ...full,
      selectedPillars: [PILLARS[0]],
      pillars: full.pillars.filter((one) => one.pillarId === PILLARS[0]),
    };
    const result = versionedFinalAssessment(narrow, { ...draft(), unresolved: [], unmeasuredControlIds: [] }, [
      PILLARS[0],
    ]);

    expect(result.finalAssessment.decisions.map((one) => one.pillarId)).toEqual([PILLARS[0]]);
    expect(publicationOf(result, PILLARS)).toEqual({ eligible: true, reasons: [] });
  });

  it('puts the complete Version 2 body under the existing canonical record digest', () => {
    const result = versionedFinalAssessment(legacy(), draft(), PILLARS);
    const storedDigest = digestOf(result);
    const throughJson = JSON.parse(JSON.stringify(result)) as AssessmentResult;

    expect(digestOf(throughJson)).toBe(storedDigest);
    expect(
      digestOf({
        ...throughJson,
        finalAssessment: {
          ...(throughJson.finalAssessment as typeof result.finalAssessment),
          versions: {
            ...result.finalAssessment.versions,
            scoring: 'sha256:changed-after-write',
          },
        },
      })
    ).not.toBe(storedDigest);
  });

  it('does not call a candidate methodology publishable', () => {
    const result = versionedFinalAssessment(legacy(), draft('candidate'), PILLARS);
    expect(result.finalAssessment.publication).toEqual({
      eligible: false,
      reasons: ['methodology-not-released'],
    });
    expect(publicationOf(result, PILLARS)).toEqual(result.finalAssessment.publication);
  });

  it('recomputes publication and refuses a stored eligible boolean when required evidence is missing', () => {
    const valid = versionedFinalAssessment(legacy(), draft(), PILLARS);
    const incomplete: AssessmentResult = {
      ...valid,
      finalAssessment: {
        ...valid.finalAssessment,
        automatedEvidence: { ...valid.finalAssessment.automatedEvidence, runDigest: '' },
        publication: { eligible: true, reasons: [] },
      },
    };

    expect(publicationOf(incomplete, PILLARS)).toEqual({
      eligible: false,
      reasons: ['incomplete-contract', 'publication-mismatch'],
    });
  });

  it('classifies a partial Version 2 body instead of throwing while a consumer asks eligibility', () => {
    const valid = versionedFinalAssessment(legacy(), draft(), PILLARS);
    const { publication: _missing, ...withoutPublication } = valid.finalAssessment;
    const incomplete: AssessmentResult = { ...valid, finalAssessment: withoutPublication };

    expect(publicationOf(incomplete, PILLARS)).toEqual({
      eligible: false,
      reasons: ['incomplete-contract', 'publication-mismatch'],
    });
  });

  it('refuses evidence and disclosure that no longer agree with the frozen result', () => {
    const valid = versionedFinalAssessment(legacy(), draft(), PILLARS);
    const changed: AssessmentResult = {
      ...valid,
      attestationIds: ['another-attestation'],
    };
    expect(publicationOf(changed, PILLARS).reasons).toEqual(['evidence-manifest-mismatch', 'publication-mismatch']);
  });

  it('revives dates inside the frozen outcome without inventing dates on a legacy row', () => {
    const result = versionedFinalAssessment(legacy(), draft(), PILLARS);
    const throughJson = JSON.parse(JSON.stringify(result)) as AssessmentResult;
    const revived = reviveFinalAssessment(throughJson);
    const frozen = (revived.finalAssessment as typeof result.finalAssessment).outcome.findings[0]?.finding;

    expect(frozen?.evidence[0]?.collectedAt).toBeInstanceOf(Date);
    expect(frozen?.attested?.at).toBeInstanceOf(Date);
    expect(frozen?.attested?.reviewBy).toBeInstanceOf(Date);
    expect(reviveFinalAssessment(legacy())).toEqual(legacy());
  });
});
