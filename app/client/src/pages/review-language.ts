// What the review surface may say, in one place because most of it is a refusal rather than a label.
//
// A skip is `kind: 'skipped'`. It may not be called a review of the pillar, and its requirements may
// not be called answered. Confirm freezes exact current attestation ids; it may not say the live
// store still matches later, or that the pillar has been reviewed in any stronger sense than the
// field. Changed and event-triggered have no field, so they are not reasons this page can name.
//
// The pattern is schedule-language.ts: the constraint sits beside the sentence, and a test holds it.

import type { AssessmentResult, AssessmentReview, PillarReview } from '../api/types';
import type { AttentionReason } from './review-summary';

export const KIND_LABEL: Readonly<Record<PillarReview['kind'], string>> = {
  confirmed: 'Confirmed',
  skipped: 'Skipped',
};

export const ATTENTION_LABEL: Readonly<Record<AttentionReason, string>> = {
  unanswered: 'Not yet answered',
  expired: 'Lapsed',
  due: 'Due for review',
  inconclusive: 'Scan could not tell',
};

export function attentionCountPhrase(count: number): string {
  if (count === 0) return 'None need attention';
  if (count === 1) return '1 needs attention';
  return `${String(count)} need attention`;
}

export function pillarCaption(recorded: PillarReview | undefined, attention: number): string {
  if (recorded != null) return KIND_LABEL[recorded.kind];
  return attentionCountPhrase(attention);
}

export function recordedPhrase(record: PillarReview): string {
  const when = onDate(record.at);
  if (record.kind === 'skipped') return `Skipped by ${record.by} on ${when}.`;
  const cited = record.attestationIds?.length ?? 0;
  if (cited === 0) return `Confirmed by ${record.by} on ${when}.`;
  return `Confirmed by ${record.by} on ${when}, freezing ${plural(cited, 'accepted answer')}.`;
}

export function progressPhrase(recorded: number, total: number): string {
  if (total === 0) return 'This build has no pillars to record.';
  if (recorded === total) return `Every selected pillar has a record (${String(total)}).`;
  return `${String(recorded)} of ${String(total)} pillars have a record.`;
}

export function waitingPhrase(reviews: readonly AssessmentReview[], pillarCount: number): string {
  if (reviews.length === 0) return 'No run is waiting to be reviewed.';
  if (reviews.length === 1) {
    const one = reviews[0];
    if (one == null) return 'No run is waiting to be reviewed.';
    return `A run is waiting: ${progressPhrase(one.pillars.length, reviewPillarCount(one, pillarCount))}`;
  }
  return `${String(reviews.length)} runs are waiting to be reviewed.`;
}

/** Exact selected scope when this review carries it; full catalogue only for a legacy review. */
export function reviewPillarCount(review: AssessmentReview, catalogueCount: number): number {
  return review.selectedPillars?.length ?? catalogueCount;
}

export function openedPhrase(review: AssessmentReview): string {
  return `Opened by ${review.openedBy} on ${onDate(review.openedAt)}.`;
}

export function finalisedPhrase(result: AssessmentResult): string {
  return `Every selected pillar has a record. Finalised by ${result.finalisedBy} on ${onDate(result.finalisedAt)}.`;
}

export function automaticPhrase(count: number): string {
  if (count === 0) return 'This run measured none of this pillar without asking a person.';
  return `${plural(count, 'requirement')} this run measured without asking a person.`;
}

/**
 * How many answers to this pillar are current in the store as it stands now.
 *
 * Read from `/api/attestations` for the reviewed run. The word this sentence turns on is "now":
 * the answer is current at the decision boundary, not merely something the earlier scan carried.
 */
export function reusedPhrase(count: number): string {
  if (count === 0) return 'No answer to this pillar is current on record now.';
  return `${plural(count, 'answer')} to this pillar ${count === 1 ? 'is' : 'are'} current on record now.`;
}

/**
 * What a confirm of this pillar would freeze, counted from current accepted evidence.
 *
 * Zero is a real answer for a pillar whose reviewed run handed no requirement to a person.
 */
export function citedPhrase(count: number): string {
  if (count === 0) {
    return 'This pillar has no current human answer to freeze, so a confirm records none.';
  }
  return `A confirm freezes the exact ${plural(count, 'current answer')} shown here.`;
}

/**
 * The confirm is written once. Naming the pillar is what tells a reader they had the wrong row.
 *
 * Says what the immutable record will contain. The server rechecks the same evidence at write time,
 * so a date boundary or concurrent change refuses the decision instead of accepting stale browser state.
 */
export function confirmNotice(pillarTitle: string, cited: number): string {
  return `Confirm ${pillarTitle}? ${citedPhrase(cited)} A confirm is written once.`;
}

/**
 * A skip is a record, not an absence, and it is not a review of the pillar.
 *
 * "Cannot be confirmed afterwards" restates the duplicate refusal. "Not a review of it" is the
 * field: `kind` is `skipped`.
 */
export function skipNotice(pillarTitle: string, unresolved: number): string {
  return (
    `Skip ${pillarTitle}? This leaves ${plural(unresolved, 'manual control')} unaccepted and unmeasured ` +
    'in the published report. A skip is written once, this pillar cannot be confirmed afterwards, and a skip is not a review of it.'
  );
}

/**
 * The review route's write contract: the seventh accepted pillar record creates the result in the
 * same transaction. This is about this application's own behaviour, not a prediction about a later
 * platform job, and is shown only when every other selected pillar already has a record.
 */
export function finalDecisionNotice(): string {
  return 'Because this completes the selected pillar review, an accepted choice also publishes the report.';
}

function onDate(value: string): string {
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return 'an unrecorded date';
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
