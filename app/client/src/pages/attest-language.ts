// The words this page uses, in one place.
//
// Separated from the page for the same reason the other language modules are: these are the
// sentences a customer reads about their own governance, several of them are conditional on a
// date, and a date-dependent sentence written inline is a sentence nobody tests. "Lapsed 3
// months ago" and "renew within 3 months" differ by one comparison and mean opposite things.

import type { AskedBecause, AttestableRequirement, AttestationState, AttestedAnswer } from '../api/types';

/** Where a requirement stands. `unanswered` is not an attestation state; it is the absence of one. */
export type RequirementState = 'unanswered' | AttestationState;

export const REQUIREMENT_STATES: readonly RequirementState[] = ['unanswered', 'expired', 'due', 'current'];

export function stateOf(requirement: AttestableRequirement): RequirementState {
  return requirement.attestation?.state ?? 'unanswered';
}

/** The value the pillar filter carries when it is not narrowing to one. */
export const EVERY_PILLAR = 'all';

/**
 * Whether a row is in the pillar this list is filtered to.
 *
 * Exported because two pages count the same slice and one of them used to count it from somewhere
 * else. `/checks` offered "Answer the 23 no check can reach" over a pillar whose answers page listed
 * 47, because the number came from the plan's buckets rather than from the set the link lands on.
 * The predicate lives here so the count and the list it promises cannot drift apart again.
 */
export function inPillar(requirement: AttestableRequirement, pillar: string): boolean {
  return pillar === EVERY_PILLAR || requirement.pillarId === pillar;
}

/**
 * Whether this answer counts toward the score right now.
 *
 * The same two states `progressPhrase` calls answered, and deliberately the same function: a second
 * definition of done is how one surface reports work outstanding that another reports finished.
 * `due` counts — the answer is inside its review window — and that is what separates this from the
 * walk's `isSettled`, which stops on `due` because bringing the set up to date is its whole job.
 */
export function counts(requirement: AttestableRequirement): boolean {
  const state = stateOf(requirement);
  return state === 'current' || state === 'due';
}

/**
 * The order somebody working through the list would choose.
 *
 * Lapsed above unanswered, because a lapsed answer is a requirement that was being managed and
 * has stopped being — which is a more urgent signal than one nobody has ever looked at.
 */
export const STATE_RANK: Readonly<Record<RequirementState, number>> = {
  expired: 0,
  due: 1,
  unanswered: 2,
  current: 3,
};

export const STATE_LABEL: Readonly<Record<RequirementState, string>> = {
  unanswered: 'Unanswered',
  expired: 'Lapsed',
  due: 'Due for review',
  current: 'Answered',
};

/** What each state means for the score, which is the part a reader acts on. */
export const STATE_DETAIL: Readonly<Record<RequirementState, string>> = {
  unanswered:
    'Nobody has answered this, so it is outside the score and counted as unmeasured. It is not a ' +
    'failure and not a pass.',
  expired:
    'The answer passed its review date, so it has stopped counting and the requirement is back to ' +
    'unmeasured. Confirming it again restores it.',
  due: 'The answer still counts, but its review date is close. Confirm it before then and it will not lapse.',
  current: 'Answered and counting toward the score, with a review date in the future.',
};

export const ANSWER_LABEL: Readonly<Record<AttestedAnswer, string>> = {
  met: 'In place',
  'partially-met': 'Partly in place',
  'not-met': 'Not in place',
  'not-applicable': 'Does not apply to us',
};

/** What each answer does to the score, said plainly next to the choice. */
export const ANSWER_EFFECT: Readonly<Record<AttestedAnswer, string>> = {
  met: 'Counts as met.',
  'partially-met': 'Counts as half met, so partial progress moves the score.',
  'not-met': 'Counts as not met.',
  'not-applicable': 'Leaves the score entirely, with your statement recorded as the reason.',
};

export const ANSWERS: readonly AttestedAnswer[] = ['met', 'partially-met', 'not-met', 'not-applicable'];

/**
 * Why the reader is being asked, in a phrase short enough for a row.
 *
 * The distinction is worth the words. A requirement about practice is one nobody's tool can
 * measure, so an answer here is the best evidence that will ever exist for it. A requirement
 * blocked by authorisation is one this app checks perfectly well and cannot be granted access to,
 * so an answer is a person reading a screen on the app's behalf — the weakest evidence in the
 * assessment, and worth saying so before somebody treats the two as equivalent.
 *
 * The third is the one a reader is most likely to query, because their own scan handed it to them:
 * the check ran and the reading does not separate the two cases it would have to. Labelled by what
 * the scan did rather than by what it lacked, since "the scan could not tell" is the fact the
 * reader needs and "unmeasurable" is jargon for it.
 */
export const ASKED_LABEL: Readonly<Record<AskedBecause, string>> = {
  'no-telemetry': 'Practice',
  'not-authorised': 'Setting the app cannot read',
  inconclusive: 'Scan could not tell',
};

/**
 * The same distinction as one line, for the pane.
 *
 * One line and not the paragraph it wants to be. This sits above three other pieces of guidance —
 * what the answer should rest on, what the current state means, and the form's own help — and four
 * stacked blocks of small grey text is a wall the reader skips, taking the useful two with it.
 */
export const ASKED_DETAIL: Readonly<Record<AskedBecause, string>> = {
  'no-telemetry': 'No API returns this, so your answer is the only evidence there will be.',
  'not-authorised':
    'This app has a working check for this and no installation can be authorised to run it, so your ' +
    'answer stands in for a reading.',
  inconclusive:
    'The check ran and the answer was ambiguous — the platform records the same thing either way. ' +
    'The question explains what it saw.',
};

/**
 * How often this has to be confirmed, in months where that reads better than days.
 *
 * Days is right for a fortnight and wrong for a year: "answer again every 365 days" is a number
 * the reader converts before it means anything.
 */
export function cadencePhrase(days: number): string {
  if (days % 365 === 0) {
    const years = days / 365;
    return years === 1 ? 'Confirm once a year' : `Confirm every ${String(years)} years`;
  }
  if (days >= 60 && days % 30 === 0) return `Confirm every ${String(days / 30)} months`;
  return `Confirm every ${String(days)} days`;
}

/** When the answer next has to be given, or how long ago it stopped counting. */
export function renewalPhrase(reviewBy: string, state: RequirementState, now: Date = new Date()): string {
  const due = new Date(reviewBy);
  if (Number.isNaN(due.getTime())) return 'The review date on this answer could not be read.';

  const date = due.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  const days = Math.round(Math.abs(due.getTime() - now.getTime()) / 86_400_000);

  if (state === 'expired') {
    return days === 0 ? `Lapsed today (${date}).` : `Lapsed ${plural(days, 'day')} ago, on ${date}.`;
  }
  if (state === 'due') return `Due for review in ${plural(days, 'day')}, on ${date}.`;
  return `Next review ${date}.`;
}

/** Who answered and when, for the row and the pane. */
export function attributionPhrase(by: string, at: string): string {
  const when = new Date(at);
  const date = Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return `${by} on ${date}`;
}

/**
 * What the set as a whole looks like, for the header.
 *
 * Leads with what is outstanding rather than with the total, because the total does not change
 * and is not why anyone opened the page.
 */
export function progressPhrase(requirements: readonly AttestableRequirement[]): string {
  const total = requirements.length;
  if (total === 0) return 'This build has no requirements that need answering.';

  const counted = requirements.filter(counts).length;

  return `${String(counted)} of ${String(total)} answered and counting toward the score.`;
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
