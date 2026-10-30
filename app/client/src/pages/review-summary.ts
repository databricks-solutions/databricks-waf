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

/**
 * Why this requirement is on the attention list. `current` and `due` are never reasons: both still
 * count, so they are reused.
 */
export type AttentionReason = Exclude<RequirementState, 'current' | 'due'> | 'inconclusive';

export const ATTENTION_REASONS: readonly AttentionReason[] = ['expired', 'unanswered', 'inconclusive'];

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
   * How many exact answer ids a confirm would freeze: the answers that still count, current or due.
   *
   * Confirm is unavailable while attention remains, so at the decision boundary this is every
   * human-answerable requirement in the pillar and is the same manifest the server rechecks.
   */
  readonly cited: number;
}

/**
 * Why a requirement needs a person in this review, or null if it does not.
 *
 * A due answer still counts until its review date, so it is reused and cited like a current one, as
 * the server counts it (decision D6 in docs/decisions.md). `inconclusive` is a reason only when
 * nobody has answered yet: that is the scan handing the question over. An expired answer that was
 * originally inconclusive is expired — the field that moved is the attestation state, not the scan.
 */
export function attentionReason(requirement: AttestableRequirement): AttentionReason | null {
  const state = stateOf(requirement);
  if (state === 'current' || state === 'due') return null;
  // A measurement that stopped at its cap stands without an answer, and a lapsed one simply stands
  // again. Neither is something the review has to deal with before confirming (decision D2 in
  // docs/decisions.md).
  if (optional(requirement) && (state === 'unanswered' || state === 'expired')) return null;
  if (state === 'unanswered' && requirement.askedBecause === 'inconclusive') return 'inconclusive';
  return state;
}

/**
 * The earliest review date among the due answers a confirm would cite, if any.
 *
 * A due answer counts until that date; a report that cites one after it is refused, so this is the
 * deadline for recording every selected pillar. Given the whole review it reads every pillar that
 * was not skipped, because the deadline is the report's and the pillar on screen is only one of the
 * pillars whose answers it cites; a skipped pillar cites none.
 */
export function earliestDueBy(target: PillarSummary | readonly PillarSummary[]): string | undefined {
  const summaries = 'pillarId' in target ? [target] : target.filter((one) => one.recorded?.kind !== 'skipped');
  const dates = summaries
    .flatMap((one) => one.reused)
    .filter((one) => stateOf(one) === 'due')
    .flatMap((one) => (one.attestation != null ? [one.attestation.reviewBy] : []));
  return dates.sort((left, right) => new Date(left).getTime() - new Date(right).getTime())[0];
}

/**
 * Whether a requirement calls for work from a person, counting the renewal of a due answer.
 *
 * Wider than `attentionReason`: a review does not wait on a due answer, which still counts, but a
 * reader looking over the estate should still see that its review date is near.
 */
export function needsWork(requirement: AttestableRequirement): boolean {
  return attentionReason(requirement) != null || stateOf(requirement) === 'due';
}

/**
 * Whether the measurement already stands for this requirement, so an answer only lifts a cap on it.
 *
 * Mirrors `ReviewableControl.optional` on the server, which freezes the same set: an answer that
 * counts is cited, and one that does not is not asked for.
 */
function optional(requirement: AttestableRequirement): boolean {
  return requirement.askedBecause === 'capped';
}

/** Whether a requirement has an answer this review would cite. */
function answered(requirement: AttestableRequirement): boolean {
  const state = stateOf(requirement);
  return state === 'current' || state === 'due';
}

/**
 * How many requirements a skip leaves unaccepted and unmeasured.
 *
 * A capped requirement is left out: its measured `partial` outcome stands whether or not the pillar
 * is skipped, so a skip does not leave it unmeasured.
 */
export function skippedUnresolved(summary: PillarSummary): number {
  return summary.reused.filter((one) => !optional(one)).length + summary.attention.length;
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
  // Without an answer that counts, a capped requirement is a finding the app measured and not a
  // question this review asks, so it is counted with the automatic ones and cites nothing.
  const asked = requirements.filter((one) => !optional(one) || answered(one));
  const attestable = new Set(asked.map((one) => one.controlId));
  return pillarIds.map((pillarId) => {
    const recorded = recordedOf(review, pillarId);
    const ofPillar = asked.filter((one) => one.pillarId === pillarId);
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
