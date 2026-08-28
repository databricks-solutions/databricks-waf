// The Version 2 final-assessment body.
//
// A review result written before this module existed is still a readable record of which run and
// pillar decisions completed. It is not a publishable assessment: it does not freeze the outcome,
// the definition version, the methodology identity or the evidence manifest needed to reproduce
// that outcome. Version 2 adds those facts without rewriting the old body. ADR 0104 records the
// stored boundary and why the row digest remains beside, rather than inside, this document.

import type { ExecutionMode } from '../collect/credentials.js';
import type { Finding } from '../resolve/finding.js';
import type { Confidence } from '../resolve/confidence.js';
import type { PillarScore, Score } from '../score/score.js';
import type { PublicMethodologyIdentity } from '../methodology/identity.js';
import { selectedPillarsOf, type AssessmentResult, type PillarReview } from './review.js';

export const FINAL_ASSESSMENT_SCHEMA_VERSION = 2 as const;

export type FinalAssessmentPublicationReason =
  | 'legacy-result'
  | 'unsupported-schema'
  | 'incomplete-contract'
  | 'methodology-not-released'
  | 'pillar-set-incomplete'
  | 'scope-mismatch'
  | 'evidence-manifest-mismatch'
  | 'disclosure-mismatch'
  | 'publication-mismatch';

export interface FinalAssessmentPublication {
  readonly eligible: boolean;
  readonly reasons: readonly FinalAssessmentPublicationReason[];
}

export interface FinalAssessmentDefinition {
  readonly id: string;
  readonly version: number;
  readonly fingerprint: string;
}

export type FinalAssessmentMethodology = PublicMethodologyIdentity;

export interface FinalAssessmentVersions {
  readonly methodology: FinalAssessmentMethodology;
  readonly catalogue: {
    readonly revision: string;
    readonly fingerprint: string;
  };
  /** Digest of the weighting and outcome-credit tables that produced the score. */
  readonly scoring: string;
}

export interface HumanEvidenceReference {
  readonly attestationId: string;
  readonly pillarId: string;
  readonly controlId: string;
  readonly selection: 'reused' | 'refreshed';
}

export interface PillarDecisionReference {
  readonly decisionId: string;
  readonly pillarId: string;
  readonly kind: PillarReview['kind'];
  readonly unresolvedControlIds: readonly string[];
}

export interface FrozenFinding {
  /** Stable inside this result; row 107b derives it deterministically from the finding identity. */
  readonly id: string;
  readonly finding: Finding;
  /** One stable id for each evidence item in `finding.evidence`, in the same order. */
  readonly evidenceIds: readonly string[];
  /** Frozen beside the finding rather than re-derived by a later build. */
  readonly confidence: Confidence;
}

export type FrozenPillarScore = Omit<PillarScore, 'worstFirst'>;

export interface FrozenScore extends Omit<Score, 'pillars'> {
  readonly pillars: readonly FrozenPillarScore[];
}

export interface FinalAssessmentDisclosure {
  readonly reusedAttestationIds: readonly string[];
  readonly refreshedAttestationIds: readonly string[];
  readonly skippedPillarIds: readonly string[];
  readonly unresolvedControlIds: readonly string[];
  readonly unmeasuredControlIds: readonly string[];
  readonly counts: {
    readonly reused: number;
    readonly refreshed: number;
    readonly skipped: number;
    readonly unresolved: number;
    readonly unmeasured: number;
  };
}

export interface FinalAssessmentContract {
  readonly definition: FinalAssessmentDefinition;
  readonly versions: FinalAssessmentVersions;
  readonly executionMode: ExecutionMode;
  readonly automatedEvidence: {
    /** Digest stored beside the immutable scan body. */
    readonly runDigest: string;
    readonly findingIds: readonly string[];
    readonly evidenceIds: readonly string[];
  };
  readonly humanEvidence: readonly HumanEvidenceReference[];
  readonly decisions: readonly PillarDecisionReference[];
  readonly outcome: {
    readonly findings: readonly FrozenFinding[];
    readonly score: FrozenScore;
    readonly coverage: {
      readonly answered: number;
      readonly total: number;
    };
  };
  readonly disclosure: FinalAssessmentDisclosure;
  readonly publication: FinalAssessmentPublication;
}

export interface FinalAssessmentResult extends AssessmentResult {
  readonly schemaVersion: typeof FINAL_ASSESSMENT_SCHEMA_VERSION;
  readonly finalAssessment: FinalAssessmentContract;
}

export interface FinalAssessmentDraft {
  readonly definition: FinalAssessmentDefinition;
  readonly versions: FinalAssessmentVersions;
  readonly executionMode: ExecutionMode;
  readonly runDigest: string;
  readonly findings: readonly FrozenFinding[];
  readonly score: FrozenScore;
  readonly humanEvidence: readonly HumanEvidenceReference[];
  /** One entry for every skipped pillar, including an empty control list. */
  readonly unresolved: readonly {
    readonly pillarId: string;
    readonly controlIds: readonly string[];
  }[];
  readonly unmeasuredControlIds: readonly string[];
}

/**
 * Adds the complete Version 2 body to a result assembled from stored review decisions.
 *
 * This does no projection. Row 107b owns producing `findings` and `score`; this function owns the
 * record boundary, its internal agreement and the publication classification those facts support.
 */
export function versionedFinalAssessment(
  result: AssessmentResult,
  draft: FinalAssessmentDraft,
  knownPillars: readonly string[]
): FinalAssessmentResult {
  const unresolved = new Map(draft.unresolved.map((one) => [one.pillarId, canonicalIds(one.controlIds)]));
  const decisions = result.pillars.map((pillar) => ({
    decisionId: pillar.id,
    pillarId: pillar.pillarId,
    kind: pillar.kind,
    unresolvedControlIds: unresolved.get(pillar.pillarId) ?? [],
  }));
  const reused = canonicalIds(
    draft.humanEvidence.filter((one) => one.selection === 'reused').map((one) => one.attestationId)
  );
  const refreshed = canonicalIds(
    draft.humanEvidence.filter((one) => one.selection === 'refreshed').map((one) => one.attestationId)
  );
  const skipped = canonicalIds(result.pillars.filter((one) => one.kind === 'skipped').map((one) => one.pillarId));
  const unresolvedControls = canonicalIds(draft.unresolved.flatMap((one) => one.controlIds));
  const unmeasured = canonicalIds(draft.unmeasuredControlIds);
  const findingIds = draft.findings.map((one) => one.id);
  const evidenceIds = draft.findings.flatMap((one) => one.evidenceIds);
  const disclosure: FinalAssessmentDisclosure = {
    reusedAttestationIds: reused,
    refreshedAttestationIds: refreshed,
    skippedPillarIds: skipped,
    unresolvedControlIds: unresolvedControls,
    unmeasuredControlIds: unmeasured,
    counts: {
      reused: reused.length,
      refreshed: refreshed.length,
      skipped: skipped.length,
      unresolved: unresolvedControls.length,
      unmeasured: unmeasured.length,
    },
  };

  const withoutPublication: Omit<FinalAssessmentContract, 'publication'> = {
    definition: { ...draft.definition },
    versions: {
      methodology: { ...draft.versions.methodology },
      catalogue: { ...draft.versions.catalogue },
      scoring: draft.versions.scoring,
    },
    executionMode: draft.executionMode,
    automatedEvidence: {
      runDigest: draft.runDigest,
      findingIds: [...findingIds],
      evidenceIds: [...evidenceIds],
    },
    humanEvidence: draft.humanEvidence.map((one) => ({ ...one })),
    decisions,
    outcome: {
      findings: draft.findings.map((one) => ({
        ...one,
        evidenceIds: [...one.evidenceIds],
        confidence: { ...one.confidence, limitations: [...one.confidence.limitations] },
      })),
      score: frozenScore(draft.score),
      coverage: { answered: answered(draft.score), total: draft.score.totalControls },
    },
    disclosure,
  };
  const candidate = {
    ...result,
    schemaVersion: FINAL_ASSESSMENT_SCHEMA_VERSION,
    finalAssessment: {
      ...withoutPublication,
      publication: { eligible: false, reasons: [] },
    },
  } satisfies FinalAssessmentResult;
  const publication = contentPublication(candidate, knownPillars);
  return { ...candidate, finalAssessment: { ...candidate.finalAssessment, publication } };
}

/** The classification consumers use instead of trusting a stored boolean on its own. */
export function publicationOf(result: AssessmentResult, knownPillars: readonly string[]): FinalAssessmentPublication {
  if (result.schemaVersion == null) return { eligible: false, reasons: ['legacy-result'] };
  if (result.schemaVersion !== FINAL_ASSESSMENT_SCHEMA_VERSION) {
    return { eligible: false, reasons: ['unsupported-schema'] };
  }
  if (!isObject(result.finalAssessment)) return { eligible: false, reasons: ['incomplete-contract'] };

  let expected: FinalAssessmentPublication;
  try {
    expected = contentPublication(result as FinalAssessmentResult, selectedPillarsOf(result, knownPillars));
  } catch {
    // A Version 2-shaped body can still be partial or carry values of the wrong JSON type. It is a
    // stored record to diagnose, not permission to publish and not an exception a consumer has to
    // translate into eligibility.
    return { eligible: false, reasons: ['incomplete-contract'] };
  }
  const stored = (result as FinalAssessmentResult).finalAssessment.publication;
  if (!isPublication(stored) || !samePublication(stored, expected)) {
    const incomplete = isPublication(stored) ? [] : (['incomplete-contract'] as const);
    return {
      eligible: false,
      reasons: canonicalReasons([...expected.reasons, ...incomplete, 'publication-mismatch']),
    };
  }
  return expected;
}

/** Restores dates nested inside the frozen findings after JSONB has returned plain strings. */
export function reviveFinalAssessment(result: AssessmentResult): AssessmentResult {
  if (result.schemaVersion !== FINAL_ASSESSMENT_SCHEMA_VERSION) return result;
  if (!isRevivableContract(result.finalAssessment)) throw new TypeError('The Version 2 outcome cannot be revived.');
  const contract = result.finalAssessment;

  const findings = contract.outcome.findings.map((snapshot) => ({
    ...snapshot,
    finding: reviveFinding(snapshot.finding),
  }));
  return {
    ...result,
    finalAssessment: {
      ...contract,
      outcome: { ...contract.outcome, findings },
    },
  };
}

function contentPublication(
  result: FinalAssessmentResult,
  knownPillars: readonly string[]
): FinalAssessmentPublication {
  const reasons: FinalAssessmentPublicationReason[] = [];
  const contract = result.finalAssessment;
  const nonblank = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '';

  if (
    !isObject(contract) ||
    !isObject(contract.definition) ||
    !isObject(contract.versions) ||
    !isObject(contract.versions.methodology) ||
    !isObject(contract.versions.catalogue) ||
    !isObject(contract.automatedEvidence) ||
    !isObject(contract.outcome) ||
    !isObject(contract.disclosure) ||
    !Array.isArray(contract.humanEvidence) ||
    !Array.isArray(contract.decisions) ||
    !Array.isArray(contract.outcome.findings) ||
    !isObject(contract.outcome.score) ||
    !isObject(contract.outcome.coverage) ||
    !nonblank(contract.definition.id) ||
    !Number.isInteger(contract.definition.version) ||
    contract.definition.version < 1 ||
    !nonblank(contract.definition.fingerprint) ||
    !Number.isInteger(contract.versions.methodology.publicVersion) ||
    contract.versions.methodology.publicVersion < 1 ||
    !nonblank(contract.versions.methodology.manifestDigest) ||
    !nonblank(contract.versions.catalogue.revision) ||
    !nonblank(contract.versions.catalogue.fingerprint) ||
    !nonblank(contract.versions.scoring) ||
    !nonblank(contract.automatedEvidence.runDigest) ||
    !Array.isArray(contract.automatedEvidence.findingIds) ||
    !Array.isArray(contract.automatedEvidence.evidenceIds) ||
    contract.outcome.findings.length === 0 ||
    !Number.isInteger(contract.outcome.score.totalControls) ||
    contract.outcome.score.totalControls < 1
  ) {
    reasons.push('incomplete-contract');
  }

  if (contract.versions?.methodology?.state !== 'released') reasons.push('methodology-not-released');

  const wanted = canonicalIds(knownPillars);
  const recorded = canonicalIds(result.pillars.map((one) => one.pillarId));
  const decided = canonicalIds(contract.decisions?.map((one) => one.pillarId) ?? []);
  if (!sameIds(wanted, recorded) || !sameIds(wanted, decided)) reasons.push('pillar-set-incomplete');

  if (
    result.definitionId == null ||
    result.definitionId !== contract.definition?.id ||
    result.definitionVersion == null ||
    result.definitionVersion !== contract.definition?.version ||
    result.definitionFingerprint == null ||
    result.definitionFingerprint !== contract.definition?.fingerprint
  ) {
    reasons.push('scope-mismatch');
  }

  const cited = canonicalIds(result.attestationIds);
  const manifested = canonicalIds(contract.humanEvidence?.map((one) => one.attestationId) ?? []);
  const findingIds = contract.outcome?.findings?.map((one) => one.id) ?? [];
  const evidenceIds = contract.outcome?.findings?.flatMap((one) => one.evidenceIds) ?? [];
  const evidenceLengthsAgree =
    contract.outcome?.findings?.every((one) => one.evidenceIds.length === one.finding.evidence.length) ?? false;
  if (
    !sameIds(cited, manifested) ||
    !uniqueNonblank(findingIds) ||
    !uniqueNonblank(evidenceIds) ||
    !sameIds(canonicalIds(findingIds), canonicalIds(contract.automatedEvidence?.findingIds ?? [])) ||
    !sameIds(canonicalIds(evidenceIds), canonicalIds(contract.automatedEvidence?.evidenceIds ?? [])) ||
    !evidenceLengthsAgree
  ) {
    reasons.push('evidence-manifest-mismatch');
  }

  const skipped = canonicalIds(result.pillars.filter((one) => one.kind === 'skipped').map((one) => one.pillarId));
  const decisionByPillar = new Map(contract.decisions?.map((one) => [one.pillarId, one]) ?? []);
  const decisionsAgree = result.pillars.every((pillar) => {
    const decision = decisionByPillar.get(pillar.pillarId);
    if (decision == null || decision.decisionId !== pillar.id || decision.kind !== pillar.kind) return false;
    return pillar.kind === 'skipped' || decision.unresolvedControlIds.length === 0;
  });
  const disclosure = contract.disclosure;
  const reused = canonicalIds(
    contract.humanEvidence?.filter((one) => one.selection === 'reused').map((one) => one.attestationId) ?? []
  );
  const refreshed = canonicalIds(
    contract.humanEvidence?.filter((one) => one.selection === 'refreshed').map((one) => one.attestationId) ?? []
  );
  const unresolved = canonicalIds(contract.decisions?.flatMap((one) => one.unresolvedControlIds) ?? []);
  if (
    !decisionsAgree ||
    !isObject(disclosure?.counts) ||
    !sameIds(reused, canonicalIds(disclosure?.reusedAttestationIds ?? [])) ||
    !sameIds(refreshed, canonicalIds(disclosure?.refreshedAttestationIds ?? [])) ||
    !sameIds(skipped, canonicalIds(disclosure?.skippedPillarIds ?? [])) ||
    !sameIds(unresolved, canonicalIds(disclosure?.unresolvedControlIds ?? [])) ||
    disclosure?.counts?.reused !== reused.length ||
    disclosure?.counts?.refreshed !== refreshed.length ||
    disclosure?.counts?.skipped !== skipped.length ||
    disclosure?.counts?.unresolved !== unresolved.length ||
    disclosure?.counts?.unmeasured !== (disclosure?.unmeasuredControlIds?.length ?? -1)
  ) {
    reasons.push('disclosure-mismatch');
  }

  const unique = canonicalReasons(reasons);
  return { eligible: unique.length === 0, reasons: unique };
}

function frozenScore(score: FrozenScore): FrozenScore {
  return {
    ...score,
    pillars: score.pillars.map((pillar) => ({ ...pillar })),
    counts: { ...score.counts },
    composition: { ...score.composition },
  };
}

function answered(score: FrozenScore): number {
  return score.counts.pass + score.counts['satisfied-by-architecture'] + score.counts.partial + score.counts.fail;
}

function reviveFinding(finding: Finding): Finding {
  return {
    ...finding,
    evidence: finding.evidence.map((one) => ({ ...one, collectedAt: new Date(one.collectedAt) })),
    ...(finding.attested != null
      ? {
          attested: {
            ...finding.attested,
            at: new Date(finding.attested.at),
            reviewBy: new Date(finding.attested.reviewBy),
          },
        }
      : {}),
  };
}

function canonicalIds(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function canonicalReasons(values: readonly FinalAssessmentPublicationReason[]): FinalAssessmentPublicationReason[] {
  return [...new Set(values)].sort();
}

function sameIds(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function uniqueNonblank(values: readonly string[]): boolean {
  return values.every((value) => value.trim() !== '') && new Set(values).size === values.length;
}

function samePublication(left: FinalAssessmentPublication, right: FinalAssessmentPublication): boolean {
  return left.eligible === right.eligible && sameIds([...left.reasons].sort(), [...right.reasons].sort());
}

function isPublication(value: unknown): value is FinalAssessmentPublication {
  return (
    isObject(value) &&
    typeof value.eligible === 'boolean' &&
    Array.isArray(value.reasons) &&
    value.reasons.every((reason) => typeof reason === 'string')
  );
}

interface RevivableFindingSnapshot extends Record<string, unknown> {
  readonly finding: Finding;
}

interface RevivableContract extends Record<string, unknown> {
  readonly outcome: Record<string, unknown> & {
    readonly findings: readonly RevivableFindingSnapshot[];
  };
}

function isRevivableContract(value: unknown): value is RevivableContract {
  if (!isObject(value) || !isObject(value.outcome) || !Array.isArray(value.outcome.findings)) return false;
  return value.outcome.findings.every((snapshot) => {
    if (!isObject(snapshot) || !isObject(snapshot.finding) || !Array.isArray(snapshot.finding.evidence)) return false;
    if (!snapshot.finding.evidence.every((evidence) => isObject(evidence) && isDateInput(evidence.collectedAt))) {
      return false;
    }
    return (
      snapshot.finding.attested == null ||
      (isObject(snapshot.finding.attested) &&
        isDateInput(snapshot.finding.attested.at) &&
        isDateInput(snapshot.finding.attested.reviewBy))
    );
  });
}

function isDateInput(value: unknown): value is string | Date {
  return typeof value === 'string' || value instanceof Date;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value != null;
}
