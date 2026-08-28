// The customer result assembled from one immutable final assessment and its source run.
//
// The run remains the technical evidence envelope: timestamps, scope, measurements, signals and
// estate facts all came from it. Findings and score never do. They are replaced wholesale by the
// frozen Version 2 outcome, so a component handed `assessment` cannot accidentally read the latest
// raw scan's arithmetic while labelling it as the current customer result.

import type { AssessmentResult, Finding, Scan } from './types';

export interface CustomerResult {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly finalisedBy: string;
  readonly finalisedAt: string;
  readonly assessment: Scan;
  readonly record: AssessmentResult;
}

const SEVERITY: Readonly<Record<Finding['severity'], number>> = {
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  informational: 1,
};

/** Nothing for a legacy result or for a source run that does not match the result it is said to support. */
export function customerResult(
  result: AssessmentResult | undefined,
  run: Scan | undefined
): CustomerResult | undefined {
  const final = result?.finalAssessment;
  if (result == null || final == null || run == null || result.runId !== run.id) return undefined;

  const findings: Finding[] = final.outcome.findings.map((frozen) => ({
    ...frozen.finding,
    confidence: frozen.confidence,
  }));
  const score = {
    ...final.outcome.score,
    pillars: final.outcome.score.pillars.map((pillar) => ({
      ...pillar,
      worstFirst: findings
        .filter(
          (finding) =>
            finding.pillarId === pillar.pillarId && (finding.outcome === 'fail' || finding.outcome === 'partial')
        )
        .sort(
          (left, right) =>
            Number(left.outcome === 'partial') - Number(right.outcome === 'partial') ||
            SEVERITY[right.severity] - SEVERITY[left.severity] ||
            left.controlId.localeCompare(right.controlId)
        ),
    })),
  };

  return {
    id: result.id,
    reviewId: result.reviewId,
    runId: result.runId,
    finalisedBy: result.finalisedBy,
    finalisedAt: result.finalisedAt,
    record: result,
    assessment: {
      ...run,
      stamp: {
        ...run.stamp,
        publicMethodology: final.versions.methodology,
        catalogueVersion: final.versions.catalogue.revision,
        catalogueFingerprint: final.versions.catalogue.fingerprint,
        executionMode: final.executionMode,
        definition: final.definition,
      },
      findings,
      score,
    },
  };
}
