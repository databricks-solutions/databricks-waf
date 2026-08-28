// What one pillar of a review is made of, derived from fields the APIs already return.
//
// The audit's list is new, due, expired, changed, event-triggered or inconclusive. Two of those have
// no field: nothing on an attestation or a finding records that a question version moved, or that an
// event retriggered it. This module classifies from what exists — unanswered, due, expired, and
// unanswered-because-the-scan-could-not-tell — and refuses to invent the other two. A review that
// labelled a row "changed" without a version stamp would be the sentence-ahead-of-the-field failure
// this repository already paid for on the schedule panel.

import { stateOf, type RequirementState } from './attest-language';
import type { AssessmentReview, AttestableRequirement, Finding, PillarReview } from '../api/types';

/** Why this requirement is on the attention list. `current` is never a reason: those are reused. */
export type AttentionReason = Exclude<RequirementState, 'current'> | 'inconclusive';

export const ATTENTION_REASONS: readonly AttentionReason[] = ['expired', 'due', 'unanswered', 'inconclusive'];

export interface AttentionItem {
  readonly requirement: AttestableRequirement;
  readonly reason: AttentionReason;
}

export interface PillarSummary {
  readonly pillarId: string;
  readonly recorded?: PillarReview;
  /** Findings this run measured without asking a person. */
  readonly automatic: readonly Finding[];
  /** Answers that still count, with the author and date the attestation already carries. */
  readonly reused: readonly AttestableRequirement[];
  /** The only questions this review asks. */
  readonly attention: readonly AttentionItem[];
  /**
   * How many exact, current answer ids a confirm would freeze.
   *
   * Confirm is unavailable while attention remains, so at the decision boundary this is every
   * human-answerable requirement in the pillar and is the same manifest the server rechecks.
   */
  readonly cited: number;
}

/**
 * Why a requirement needs a person in this review, or null if it does not.
 *
 * `inconclusive` is a reason only when nobody has answered yet: that is the scan handing the question
 * over. A due or expired answer that was originally inconclusive is due or expired — the field that
 * moved is the attestation state, not the scan.
 */
export function attentionReason(requirement: AttestableRequirement): AttentionReason | null {
  const state = stateOf(requirement);
  if (state === 'current') return null;
  if (state === 'unanswered' && requirement.askedBecause === 'inconclusive') return 'inconclusive';
  return state;
}

export function recordedOf(review: AssessmentReview, pillarId: string): PillarReview | undefined {
  return review.pillars.find((one) => one.pillarId === pillarId);
}


/**
 * The pillar the URL names, or the first one that still has no record.
 *
 * Requested wins so a reload and a handed-over link land on the same pillar. Without one, resume is
 * the first unrecorded pillar, which is what arriving fresh means — a stored cursor would lag the
 * records the way a walk cursor would lag answers.
 */
export function resumePillar(summaries: readonly PillarSummary[], requested: string | null): string | undefined {
  if (requested != null && summaries.some((one) => one.pillarId === requested)) return requested;
  return summaries.find((one) => one.recorded == null)?.pillarId ?? summaries[0]?.pillarId;
}

/**
 * The pillar the address bar should name, or null when it already does.
 *
 * `resumePillar` ignores a value the catalogue does not name, so a URL that still carries that value
 * would hand the next reader a different selection than the one on screen.
 */
export function pillarToWrite(requested: string | null, currentId: string | undefined): string | null {
  if (currentId == null || requested === currentId) return null;
  return currentId;
}

export function summarisePillars(
  pillarIds: readonly string[],
  review: AssessmentReview,
  findings: readonly Finding[],
  requirements: readonly AttestableRequirement[]
): readonly PillarSummary[] {
  const attestable = new Set(requirements.map((one) => one.controlId));
  return pillarIds.map((pillarId) => {
    const recorded = recordedOf(review, pillarId);
    const ofPillar = requirements.filter((one) => one.pillarId === pillarId);
    const reused: AttestableRequirement[] = [];
    const attention: AttentionItem[] = [];
    for (const requirement of ofPillar) {
      const reason = attentionReason(requirement);
      if (reason == null) reused.push(requirement);
      else attention.push({ requirement, reason });
    }
    attention.sort(byUrgency);
    return {
      pillarId,
      ...(recorded != null ? { recorded } : {}),
      automatic: findings.filter((finding) => finding.pillarId === pillarId && !attestable.has(finding.controlId)),
      reused,
      attention,
      cited: reused.length,
    };
  });
}

function byUrgency(left: AttentionItem, right: AttentionItem): number {
  const rank = (reason: AttentionReason): number => ATTENTION_REASONS.indexOf(reason);
  const delta = rank(left.reason) - rank(right.reason);
  if (delta !== 0) return delta;
  return left.requirement.title.localeCompare(right.requirement.title);
}
