// The deterministic projection from an immutable automated run and one completed review into the
// customer-complete final assessment.
//
// Collection never happens here. The run's stored findings and signal statuses are the automated
// boundary; the review contributes only the exact attestation ids its pillar decisions cited. That
// keeps a refreshed answer capable of changing the new result without changing one byte of the run.

import type { Attestation } from '../attest/attestation.js';
import { counts } from '../attest/attestation.js';
import type { Catalogue } from '../catalogue/catalogue.js';
import { digestOf, hexOf } from '../records/digest.js';
import { confidenceOf } from '../resolve/confidence.js';
import type { Finding } from '../resolve/finding.js';
import { factFromAttestation, findingFromAttestation, type ResolverRegistry } from '../resolve/resolver.js';
import { scoreFindings, type Score } from '../score/score.js';
import { aliasLookup, type Scan } from '../scan/scan.js';
import {
  versionedFinalAssessment,
  type FinalAssessmentResult,
  type FrozenFinding,
  type FrozenScore,
  type HumanEvidenceReference,
} from './final-assessment.js';
import { selectedPillarsOf, type AssessmentResult, type ReviewAnswer } from './review.js';

export interface FinalAssessmentProjectionInput {
  /** The terminal review record before its Version 2 projection is attached. */
  readonly result: AssessmentResult;
  readonly scan: Scan;
  /** Digest stored beside the immutable encoded scan body. */
  readonly runDigest: string;
  /** Answers created inside this review, for classifying cited evidence as refreshed. */
  readonly answers: readonly ReviewAnswer[];
  /** Exactly the immutable attestation records named by `result.attestationIds`. */
  readonly attestations: readonly Attestation[];
}

export type FinalAssessmentProjector = (input: FinalAssessmentProjectionInput) => FinalAssessmentResult;

export class FinalAssessmentProjectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FinalAssessmentProjectionError';
  }
}

export function finalAssessmentProjector(options: {
  readonly catalogue: Catalogue;
  readonly registry: ResolverRegistry;
}): FinalAssessmentProjector {
  const controls = new Map(options.catalogue.controls.map((control) => [control.id, control]));
  const knownPillars = options.catalogue.pillars.map((pillar) => pillar.id);
  const aliasGroupOf = aliasLookup(options.catalogue);

  return (input) => {
    const { result, scan } = input;
    const selectedPillars = selectedPillarsOf(result, knownPillars);
    const selectedSet = new Set(selectedPillars);
    const definition = scan.stamp.definition;
    if (definition == null) {
      throw new FinalAssessmentProjectionError(
        'The reviewed run names no assessment definition, so a complete report cannot be published.'
      );
    }
    const methodology = scan.stamp.publicMethodology;
    if (methodology == null) {
      throw new FinalAssessmentProjectionError(
        'The reviewed run predates a public methodology release. Run the assessment again before finalising it.'
      );
    }
    const scoring = scan.stamp.identity?.methodology.id;
    if (scoring == null || scoring.trim() === '') {
      throw new FinalAssessmentProjectionError(
        'The reviewed run records no scoring identity, so its final score cannot be reproduced.'
      );
    }
    if (result.runId !== scan.id) {
      throw new FinalAssessmentProjectionError('The completed review and the automated run do not name the same run.');
    }
    if (
      result.definitionId !== definition.id ||
      result.definitionVersion !== definition.version ||
      result.definitionFingerprint !== definition.fingerprint
    ) {
      throw new FinalAssessmentProjectionError(
        'The completed review does not carry the same assessment definition snapshot as its run.'
      );
    }

    const cited = unique(result.attestationIds, 'The completed review cites one attestation more than once.');
    const byAttestation = new Map(input.attestations.map((one) => [one.id, one]));
    if (byAttestation.size !== input.attestations.length || cited.some((id) => !byAttestation.has(id))) {
      throw new FinalAssessmentProjectionError(
        'At least one attestation cited by the completed review could not be read exactly by id.'
      );
    }
    if (input.attestations.some((one) => !cited.includes(one.id))) {
      throw new FinalAssessmentProjectionError('The projection was given human evidence the review did not cite.');
    }

    const decisionByPillar = new Map(result.pillars.map((one) => [one.pillarId, one]));
    const findingByControl = new Map(scan.findings.map((one) => [one.controlId, one]));
    const refreshed = new Set(input.answers.map((one) => one.attestationId));
    const selectedByControl = new Map<string, Attestation>();
    const humanEvidence: HumanEvidenceReference[] = [];

    for (const id of cited) {
      const attestation = byAttestation.get(id);
      if (attestation == null) continue; // The completeness check above makes this unreachable.
      const finding = findingByControl.get(attestation.controlId);
      if (finding == null) {
        throw new FinalAssessmentProjectionError(
          `Attestation ${id} names ${attestation.controlId}, which is not a finding in the reviewed run.`
        );
      }
      const decision = decisionByPillar.get(finding.pillarId);
      if (decision?.kind !== 'confirmed' || !decision.attestationIds?.includes(id)) {
        throw new FinalAssessmentProjectionError(
          `Attestation ${id} is not cited by the confirmed ${finding.pillarId} decision.`
        );
      }
      if (attestation.definitionId !== definition.id) {
        throw new FinalAssessmentProjectionError(
          `Attestation ${id} belongs to a different assessment definition from the reviewed run.`
        );
      }
      if (!counts(attestation, result.finalisedAt)) {
        throw new FinalAssessmentProjectionError(
          `Attestation ${id} expired before the review completed, so that pillar must be reviewed again.`
        );
      }
      if (selectedByControl.has(attestation.controlId)) {
        throw new FinalAssessmentProjectionError(
          `The completed review cites more than one answer for ${attestation.controlId}.`
        );
      }
      selectedByControl.set(attestation.controlId, attestation);
      humanEvidence.push({
        attestationId: id,
        pillarId: finding.pillarId,
        controlId: finding.controlId,
        selection: refreshed.has(id) ? 'refreshed' : 'reused',
      });
    }

    const projected = scan.findings
      .filter((finding) => selectedSet.has(finding.pillarId))
      .map((finding) => {
        const decision = decisionByPillar.get(finding.pillarId);
        const selected = decision?.kind === 'confirmed' ? selectedByControl.get(finding.controlId) : undefined;
        const control = controls.get(finding.controlId);
        if (control == null) {
          throw new FinalAssessmentProjectionError(
            `The reviewed run contains ${finding.controlId}, which this build cannot place in the catalogue.`
          );
        }

        // A measured result stays measured: an answer may be recorded beside it and may never
        // overturn it. Human-answerable or previously attested outcomes are re-resolved from the
        // stored signal statuses and the exact selected answer, with no collector in the path.
        if (finding.outcome !== 'unmeasurable' && finding.attested?.bearing !== 'outcome') {
          const { attested: _was, ...automated } = finding;
          return selected == null ? automated : { ...automated, attested: factFromAttestation(selected, 'record') };
        }

        // An unmeasurable automated finding is the immutable run's answer. When the review selects
        // human evidence, settle that stored gap directly and retain the evidence the run recorded;
        // re-running its resolver can ask an older sparse payload to satisfy today's typed shape and
        // can throw while finalising an otherwise complete review. With no selected answer, the only
        // projection owed is removing an earlier outcome-bearing attestation from a skipped pillar.
        if (selected != null) return { ...findingFromAttestation(control, selected), evidence: finding.evidence };
        if (finding.attested?.bearing !== 'outcome') return finding;
        const { attested: _uncited, ...stored } = finding;
        return {
          ...stored,
          outcome: 'unmeasurable' as const,
          unmeasured: 'attestation' as const,
          outcomeReason:
            'The completed review cited no current answer for this requirement, so the published report records it as unmeasured.',
        };
      });

    const rescored: Score = {
      ...scoreFindings(projected, { aliasGroupOf }),
      ...(scan.score.exposure != null ? { exposure: scan.score.exposure } : {}),
    };
    const frozenFindings = projected.map((finding) => freezeFinding(scan, finding, result.finalisedAt));
    const skipped = new Map(result.pillars.filter((one) => one.kind === 'skipped').map((one) => [one.pillarId, one]));
    const unresolved = selectedPillars
      .filter((pillarId) => skipped.has(pillarId))
      .map((pillarId) => ({
        pillarId,
        // New skips freeze this list at decision time. Derivation remains only for legacy records.
        controlIds:
          skipped.get(pillarId)?.unresolvedControlIds ??
          projected
            .filter(
              (finding) =>
                finding.pillarId === pillarId &&
                finding.outcome === 'unmeasurable' &&
                (finding.unmeasured === 'attestation' || finding.unmeasured === 'unreachable')
            )
            .map((finding) => finding.controlId),
      }));

    return versionedFinalAssessment(
      result,
      {
        definition: {
          id: definition.id,
          version: definition.version,
          fingerprint: definition.fingerprint,
        },
        versions: {
          methodology: { ...methodology },
          catalogue: {
            revision: scan.stamp.catalogueVersion,
            fingerprint: scan.stamp.catalogueFingerprint,
          },
          scoring,
        },
        executionMode: scan.stamp.executionMode,
        runDigest: input.runDigest,
        findings: frozenFindings,
        score: freezeScore(rescored),
        humanEvidence,
        unresolved,
        unmeasuredControlIds: projected
          .filter((finding) => finding.outcome === 'unmeasurable')
          .map((finding) => finding.controlId),
      },
      selectedPillars
    );
  };
}

function freezeFinding(scan: Scan, finding: Finding, finalisedAt: Date): FrozenFinding {
  const id = stableId('finding', { runId: scan.id, controlId: finding.controlId });
  const measured = scan.measurement.find((one) => one.pillarId === finding.pillarId);
  return {
    id,
    finding,
    evidenceIds: finding.evidence.map((evidence, index) => stableId('evidence', { findingId: id, index, evidence })),
    confidence: confidenceOf(finding, {
      // Human evidence is accepted when the review completes, so its age and expiry are frozen at
      // that instant rather than at the earlier automated collection boundary.
      asOf: finalisedAt,
      ...(measured?.carriedForward === true ? { carriedForward: true } : {}),
    }),
  };
}

function freezeScore(score: Score): FrozenScore {
  return {
    ...score,
    pillars: score.pillars.map(({ worstFirst: _derived, ...pillar }) => ({ ...pillar })),
    counts: { ...score.counts },
    composition: { ...score.composition },
  };
}

function stableId(kind: 'finding' | 'evidence', value: unknown): string {
  return `${kind}-${hexOf(digestOf(value))}`;
}

function unique(ids: readonly string[], message: string): readonly string[] {
  const seen = new Set<string>();
  for (const id of ids) {
    if (id.trim() === '' || seen.has(id)) throw new FinalAssessmentProjectionError(message);
    seen.add(id);
  }
  return [...ids];
}
