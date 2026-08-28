// The record that is not the run: a review of one completed scan, a record per pillar, and the
// result that later publication reads.
//
// A scan snapshots attestations when it starts and shows its score immediately. An answer given
// afterwards cannot change that run — correctly, because the run is immutable (ADR 0032). What was
// missing is the record that joins the automated half to the manual half: somebody confirming that
// a pillar's answers are still current, or skipping it, with their name on it. Only when every
// pillar has one of those records does a final result exist. GAP-033, 43a.
//
// Three properties, and each is a refusal of a cheaper shape.
//
// **A skip is a record, not an absence.** Actor, time, run and pillar. An empty cell cannot be
// counted by 43c, cannot appear in the trail, and cannot tell a skipped pillar from one nobody
// reached. The field is `kind: 'skipped'`, never "reviewed" — a skipped pillar was not reviewed,
// and its requirements were not answered.
//
// **A scheduled run arriving while a review is open does not discard that review, or the previous
// result.** Completing a scan opens a review of that scan and does nothing else. `current()` is the
// latest *finalised* result for the assessment, not the latest scan. Two open reviews of two runs
// can exist at once; the prior final assessment stays current until the new one is finalised.
//
// **Nothing here rewrites a run.** The result cites the scan it reviewed and the exact current
// attestations the reviewer accepted. The run remains the immutable automated half; the pillar
// record is the immutable human-evidence manifest joined to it.

import { stateOf, type Attestation } from '../attest/attestation.js';
import type { Scan } from '../scan/scan.js';

export class InvalidReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidReviewError';
  }
}

/**
 * A review of one completed scan.
 *
 * One per scan: a scan is of one assessment (or none), so unique on the scan id is unique on the
 * pair without needing the pair. Nulls do not collide, and two unscoped reviews of the same scan
 * would otherwise both exist.
 *
 * `open` is derived: a review is open while it has no result. Storing a state field that can
 * disagree with the result is the cheaper shape this refuses.
 */
export interface AssessmentReview {
  readonly id: string;
  /**
   * The completed scan this review is of.
   *
   * Named `runId` because the audit's model is an AutomatedRun; in this app that record is the
   * scan. The history page already has this id.
   */
  readonly runId: string;
  readonly openedBy: string;
  readonly openedAt: Date;
  /** The assessment this review is of. Absent means the scan named none. */
  readonly definitionId?: string;
  /** The exact immutable definition version the run carried. Absent on older/direct runs. */
  readonly definitionVersion?: number;
  /** The measurement fingerprint of that version. Absent where the version is absent. */
  readonly definitionFingerprint?: string;
  /**
   * The exact pillar set the immutable run requested, in its recorded order.
   *
   * Absent on legacy runs, whose historical meaning remains the full catalogue. This is copied
   * onto the review so completion never depends on a later, mutable scan read.
   */
  readonly selectedPillars?: readonly string[];
}

export type PillarReviewKind = 'confirmed' | 'skipped';

/**
 * An answer somebody gave from inside a review, joined to the pillar they were reading.
 *
 * Its own record rather than a third `PillarReviewKind`, and rather than a field on the confirm.
 * Both of those were tried on paper and both lose something:
 *
 * A third kind puts many records under one pillar, and two invariants are written on the assumption
 * that there is at most one. `complete` asks whether every named pillar has *a* record, so a pillar
 * answered and not yet decided would count as decided; `finalised` maps pillar id to record and
 * would silently keep whichever came last. Neither is hard to change and both are load-bearing —
 * the completion rule decides when a result exists.
 *
 * A field on the confirm cannot be written when the fact is true. An answer is given before the
 * pillar is confirmed, so the confirm would have to reconstruct what this review wrote by reading
 * the live attestation store back — and that is the read this file's header refuses, for a reason
 * that still holds: what the store says now is not what happened. Recorded here, the answer is
 * written by the request that caused it, from the actor who made it, at the moment it was true.
 *
 * `attestationId` is the join to the answer itself. This record carries no answer text: an
 * attestation is written the way every other answer is, and a second copy of its statement would be
 * a second thing to keep in step with the first.
 */
export interface ReviewAnswer {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly pillarId: string;
  /** The requirement answered, which the route has checked belongs to `pillarId`. */
  readonly controlId: string;
  /** The attestation this produced. One record per attestation; an attestation is written once. */
  readonly attestationId: string;
  readonly by: string;
  readonly at: Date;
}

/**
 * What somebody recorded about one pillar of one review.
 *
 * Confirm and skip are the same record with a different `kind`, so a list of pillar reviews is
 * the whole of what happened and a filter on kind is the only split. Two types would make "has
 * every pillar been recorded" a union the caller has to exhaust, and the one they forget is the
 * skip — which is the one 43c has to count.
 */
export interface PillarReview {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly pillarId: string;
  readonly kind: PillarReviewKind;
  /**
   * Attestation ids this confirm copied off the scan's findings for this pillar.
   *
   * Empty when the pillar had no attested findings, or when the findings predate the id field.
   * Absent on a skip: a skipped pillar cites nothing, and an empty array would read as "confirmed
   * with no attestations".
   */
  readonly attestationIds?: readonly string[];
  /** Every human-answerable control a skip deliberately leaves unaccepted. Absent on legacy skips. */
  readonly unresolvedControlIds?: readonly string[];
  readonly by: string;
  readonly at: Date;
}

/**
 * The result publication will later read.
 *
 * Written when every pillar the catalogue names has a confirm or a skip. Previous results are
 * kept: `current()` is the latest by `finalisedAt`, and a new scan does not delete this row.
 */
export interface AssessmentResult {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly finalisedBy: string;
  readonly finalisedAt: Date;
  readonly pillars: readonly PillarReview[];
  /**
   * Attestation ids the confirmed pillars cited, in pillar then finding order.
   *
   * Exact current ids accepted at confirm time. A skip contributes none. This is the field 43c
   * reads when it says what the score is made of; it is not a count of skipped pillars, and later
   * changes in the live store cannot change it.
   */
  readonly attestationIds: readonly string[];
  readonly definitionId?: string;
  readonly definitionVersion?: number;
  readonly definitionFingerprint?: string;
  /** The review's immutable selected pillar set. Absent on legacy full-catalogue results. */
  readonly selectedPillars?: readonly string[];
  /** Absent on the legacy result body. Version 2 is defined in `final-assessment.ts`. */
  readonly schemaVersion?: number;
  /** Absent on the legacy result body. Kept broad so a malformed Version 2 row remains readable. */
  readonly finalAssessment?: unknown;
}

export interface OpenedDraft {
  readonly id: string;
  readonly runId: string;
  readonly openedBy: string;
  readonly openedAt: Date;
  readonly definitionId?: string;
  readonly definitionVersion?: number;
  readonly definitionFingerprint?: string;
  readonly selectedPillars?: readonly string[];
}

export interface PillarDraft {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly pillarId: string;
  readonly by: string;
  readonly at: Date;
  readonly attestationIds?: readonly string[];
  readonly unresolvedControlIds?: readonly string[];
}

export interface FinalisedDraft {
  readonly id: string;
  readonly review: AssessmentReview;
  readonly pillars: readonly PillarReview[];
  readonly finalisedBy: string;
  readonly finalisedAt: Date;
}

/** A review of this scan, stamped with the scan's actor, time and assessment. */
export function openedFor(scan: Scan, draft: { readonly id: string; readonly openedAt?: Date }): AssessmentReview {
  return opened({
    id: draft.id,
    runId: scan.id,
    openedBy: scan.stamp.actor,
    openedAt: draft.openedAt ?? scan.finishedAt,
    ...(scan.stamp.definition != null ? { definitionId: scan.stamp.definition.id } : {}),
    ...(scan.stamp.definition != null ? { definitionVersion: scan.stamp.definition.version } : {}),
    ...(scan.stamp.definition != null ? { definitionFingerprint: scan.stamp.definition.fingerprint } : {}),
    ...(scan.requestedPillars != null ? { selectedPillars: scan.requestedPillars } : {}),
  });
}

export function opened(draft: OpenedDraft): AssessmentReview {
  if (draft.runId.trim() === '') {
    throw new InvalidReviewError('A review has to name the scan it is of.');
  }
  return {
    id: draft.id,
    runId: draft.runId,
    openedBy: draft.openedBy,
    openedAt: draft.openedAt,
    ...(draft.definitionId != null && draft.definitionId !== '' ? { definitionId: draft.definitionId } : {}),
    ...(draft.definitionVersion != null ? { definitionVersion: draft.definitionVersion } : {}),
    ...(draft.definitionFingerprint != null && draft.definitionFingerprint !== ''
      ? { definitionFingerprint: draft.definitionFingerprint }
      : {}),
    ...(draft.selectedPillars != null ? { selectedPillars: [...draft.selectedPillars] } : {}),
  };
}

/**
 * The pillars this review is allowed to decide, in catalogue order.
 *
 * A missing set is the explicit compatibility rule for runs written before requested scope was
 * stored. An empty, duplicate or unknown set is not widened to the catalogue: that would turn a
 * malformed narrow assessment into a valid full-estate report.
 */
export function selectedPillarsOf(
  record: Pick<AssessmentReview, 'selectedPillars'> | Pick<AssessmentResult, 'selectedPillars'>,
  known: readonly string[]
): readonly string[] {
  const selected = record.selectedPillars;
  if (selected == null) return [...known];
  if (selected.length === 0) {
    throw new InvalidReviewError('This review records an empty selected pillar set, so it cannot accept a decision.');
  }
  const wanted = new Set(selected);
  if (wanted.size !== selected.length || selected.some((id) => id.trim() === '' || !known.includes(id))) {
    throw new InvalidReviewError(
      'This review records a duplicate, blank or unknown selected pillar, so it cannot accept a decision.'
    );
  }
  return known.filter((id) => wanted.has(id));
}

/** Store-level defence that no decision can escape the review's immutable selected scope. */
export function assertReviewAccepts(
  review: AssessmentReview,
  pillarId: string,
  known: readonly string[]
): readonly string[] {
  const selected = selectedPillarsOf(review, known);
  if (!selected.includes(pillarId)) {
    throw new InvalidReviewError(
      `${pillarId} was not selected for this assessment, so Review cannot record a decision against it.`
    );
  }
  return selected;
}

/**
 * Confirm-current: this pillar's answers on the run still stand.
 *
 * The attestation ids are the ones the caller copied off the scan. This function does not look
 * them up, so a test can pass a synthetic list and a route can pass what the findings held.
 */
export function confirmed(draft: PillarDraft, known: readonly string[]): PillarReview {
  return recorded({ ...draft, kind: 'confirmed', attestationIds: draft.attestationIds ?? [] }, known);
}

/** An attributed skip. Actor, time, run and pillar — the four things an absence cannot carry. */
export function skipped(draft: PillarDraft, known: readonly string[]): PillarReview {
  return recorded({ ...draft, kind: 'skipped' }, known);
}

function recorded(draft: PillarDraft & { readonly kind: PillarReviewKind }, known: readonly string[]): PillarReview {
  if (!known.includes(draft.pillarId)) {
    throw new InvalidReviewError(
      `This installation has no pillar called ${draft.pillarId}, so a record about it is a record nothing can place.`
    );
  }
  if (draft.reviewId.trim() === '' || draft.runId.trim() === '') {
    throw new InvalidReviewError('A pillar record has to name the review and the scan it belongs to.');
  }

  return {
    id: draft.id,
    reviewId: draft.reviewId,
    runId: draft.runId,
    pillarId: draft.pillarId,
    kind: draft.kind,
    by: draft.by,
    at: draft.at,
    ...(draft.kind === 'confirmed' ? { attestationIds: [...(draft.attestationIds ?? [])] } : {}),
    ...(draft.kind === 'skipped' ? { unresolvedControlIds: [...(draft.unresolvedControlIds ?? [])] } : {}),
  };
}

export interface AnswerDraft {
  readonly id: string;
  readonly reviewId: string;
  readonly runId: string;
  readonly pillarId: string;
  readonly controlId: string;
  readonly attestationId: string;
  readonly by: string;
  readonly at: Date;
}

/**
 * An answer this review produced, against a pillar the catalogue names.
 *
 * The same pillar check `recorded` makes, for the same reason: a record about a pillar this
 * installation does not have is a record nothing can place, and `finalisationOf` filters to the
 * catalogue anyway — so an unplaceable record would be written, stored and then counted by nothing.
 */
export function answered(draft: AnswerDraft, known: readonly string[]): ReviewAnswer {
  if (!known.includes(draft.pillarId)) {
    throw new InvalidReviewError(
      `This installation has no pillar called ${draft.pillarId}, so a record about it is a record nothing can place.`
    );
  }
  if (draft.reviewId.trim() === '' || draft.runId.trim() === '') {
    throw new InvalidReviewError('An answer record has to name the review and the scan it belongs to.');
  }
  if (draft.controlId.trim() === '' || draft.attestationId.trim() === '') {
    throw new InvalidReviewError('An answer record has to name the requirement and the attestation it produced.');
  }

  return {
    id: draft.id,
    reviewId: draft.reviewId,
    runId: draft.runId,
    pillarId: draft.pillarId,
    controlId: draft.controlId,
    attestationId: draft.attestationId,
    by: draft.by,
    at: draft.at,
  };
}

/**
 * Attestations this review wrote, against pillars the catalogue names, deduplicated.
 *
 * Deduplicated on the attestation rather than counted as records, because the two differ and the
 * word is about the answers. Answering the same requirement twice inside one review supersedes the
 * first answer — the second attestation is a new id, so both are counted; re-recording the *same*
 * attestation cannot happen through the route and is filtered here rather than trusted not to.
 */
export function refreshedIn(answers: readonly ReviewAnswer[], known: readonly string[]): readonly string[] {
  const named = new Set(known);
  const seen = new Set<string>();
  for (const one of answers) {
    if (named.has(one.pillarId)) seen.add(one.attestationId);
  }
  return [...seen];
}

/** Whether every selected pillar has a record. */
export function complete(known: readonly string[], recorded: readonly PillarReview[]): boolean {
  if (known.length === 0) return false;
  const have = new Set(recorded.map((one) => one.pillarId));
  return known.every((pillar) => have.has(pillar));
}

/**
 * The result of a completed review.
 *
 * Pillars are stored in catalogue order, so two results of the same catalogue compare without
 * depending on the order somebody clicked. Attestation ids follow that order, then the order
 * they were copied off the findings.
 */
export function finalised(draft: FinalisedDraft, known: readonly string[]): AssessmentResult {
  if (!complete(known, draft.pillars)) {
    throw new InvalidReviewError(
      'A report is published when every selected pillar has been confirmed or skipped, and this review is still short of that.'
    );
  }

  const byPillar = new Map(draft.pillars.map((one) => [one.pillarId, one]));
  const pillars = known.map((id) => {
    const one = byPillar.get(id);
    if (one == null) throw new InvalidReviewError(`A result is missing a record for ${id}.`);
    return one;
  });

  return {
    id: draft.id,
    reviewId: draft.review.id,
    runId: draft.review.runId,
    finalisedBy: draft.finalisedBy,
    finalisedAt: draft.finalisedAt,
    pillars,
    attestationIds: pillars.flatMap((one) => one.attestationIds ?? []),
    ...(draft.review.definitionId != null ? { definitionId: draft.review.definitionId } : {}),
    ...(draft.review.definitionVersion != null ? { definitionVersion: draft.review.definitionVersion } : {}),
    ...(draft.review.definitionFingerprint != null
      ? { definitionFingerprint: draft.review.definitionFingerprint }
      : {}),
    ...(draft.review.selectedPillars != null ? { selectedPillars: [...draft.review.selectedPillars] } : {}),
  };
}

/**
 * The human-answerable control set derived from the reviewed run, in catalogue order.
 */
export interface ReviewableControl {
  readonly id: string;
  readonly pillarId: string;
}

export interface PillarEvidenceManifest {
  readonly attestationIds: readonly string[];
  readonly attentionControlIds: readonly string[];
  readonly unresolvedControlIds: readonly string[];
}

/** The exact human-evidence decision visible for one reviewed-run pillar at one instant. */
export function pillarEvidenceManifest(
  controls: readonly ReviewableControl[],
  attestations: readonly Attestation[],
  pillarId: string,
  now: Date = new Date()
): PillarEvidenceManifest {
  const current = new Map(attestations.map((one) => [one.controlId, one]));
  const manual = controls.filter((one) => one.pillarId === pillarId);
  const accepted: string[] = [];
  const attention: string[] = [];

  for (const control of manual) {
    const answer = current.get(control.id);
    if (answer != null && stateOf(answer, now) === 'current') accepted.push(answer.id);
    else attention.push(control.id);
  }

  return {
    attestationIds: accepted,
    attentionControlIds: attention,
    unresolvedControlIds: manual.map((one) => one.id),
  };
}
