// The words the validation surface uses.
//
// Its own module like the other language files, and with a reason of its own: this surface has to say
// three things that a shorter vocabulary would collapse into two, and the collapse is what makes a
// board read as a list of things people ticked off.
//
// **Waiting is not failing.** An attempt nothing has answered yet says nothing about the estate. The
// words for it are about the run that will answer it — when, and why not before then — rather than
// about the work.
//
// **Incomplete is not a near miss.** A run that could not read a requirement, or that found human
// evidence older than the claim, has not disagreed with anybody. Calling that a failure sends an owner
// to redo work that may well be done; calling it a pass verifies work nothing measured.
//
// **A failed attempt is part of the record, not a mistake.** An action verified at the fourth attempt
// is a different story from one verified at the first, and the three failures are the interesting part.
// Nothing here apologises for them or hides them behind the one that held.

import { CircleCheck, CircleHelp, CircleX, Hourglass, type LucideIcon } from 'lucide-react';
import type { AttemptMethod, AttemptResult, ValidationAttempt } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

export const ATTEMPT_RESULTS: readonly AttemptResult[] = ['passed', 'failed', 'incomplete'];

/**
 * What each result is called on the badge.
 *
 * `passed` is "measured as met" rather than the shorter "held up", which was the first version and
 * read wrongly on a real board: on a page about work in progress, "held up" is what a reader takes for
 * delayed. It sat beside a green tick and an amber count of attempts and still read as a hold-up.
 */
export const RESULT_LABEL: Readonly<Record<AttemptResult, string>> = {
  passed: 'Measured as met',
  failed: 'Still failing',
  incomplete: 'Could not tell',
};

/**
 * What each result means, in the terms of what to do about it.
 *
 * `incomplete` is the one this vocabulary exists for. It is neither of the other two, and a reader who
 * takes it for either acts wrongly: as a pass, and work nothing measured is marked verified; as a
 * failure, and somebody redoes a change that landed.
 *
 * `passed` says what the pass does not settle rather than restating it. The sentence it replaced —
 * that a run measured every requirement as met after the claim — was true, and was also the third
 * time one panel said so: the state note and the estate reading both say it above, because an action
 * only reaches `verified` by a run agreeing. Measured against the deployed app, the three landed
 * within a few centimetres of each other and read as a stutter. What this one adds is the part
 * neither of the others carries: agreement is a reading on a date, and a later run can differ.
 */
export const RESULT_DETAIL: Readonly<Record<AttemptResult, string>> = {
  passed:
    'A run agreed on the date below. If a later run measures one of these as unmet, this attempt stays ' +
    'as it is and the estate reading turns to contradicted.',
  failed: 'A run measured at least one of these requirements as still unmet. Either the change did not take, or it did not cover everything the check looks at.',
  incomplete: 'The run could not answer. Nothing here says the work was not done — only that this run had nothing to say about it.',
};

export const RESULT_TONE: Readonly<Record<AttemptResult, Tone>> = {
  passed: 'success',
  failed: 'danger',
  incomplete: 'warning',
};

export const RESULT_ICON: Readonly<Record<AttemptResult, LucideIcon>> = {
  passed: CircleCheck,
  failed: CircleX,
  incomplete: CircleHelp,
};

/** What an attempt with no answer is called. Its own words, because waiting is not a fourth result. */
export const WAITING_LABEL = 'Waiting on a run';
export const WAITING_ICON = Hourglass;
export const WAITING_TONE: Tone = 'neutral';

export const METHOD_LABEL: Readonly<Record<AttemptMethod, string>> = {
  measured: 'the app reads it',
  attested: 'somebody answers it',
};

/**
 * Why the two methods are not interchangeable, for the pane where there is room to say it.
 *
 * The reader this is for is the one about to ask why their attested requirement came back
 * `incomplete` when the last run reported it met.
 */
export const METHOD_DETAIL: Readonly<Record<AttemptMethod, string>> = {
  measured: 'A run measures this one, so this run either agrees or does not.',
  attested:
    'Nothing can read this one, so it rests on somebody’s word — and the answer on record has to have been ' +
    'given after the work was claimed done. An answer from before then describes what was true beforehand.',
};

/**
 * How the badge on one attempt reads.
 *
 * The method is never in it. Which requirements are answered how is a property of the framework rather
 * than of the attempt, and putting it in the headline would suggest a requester chose it.
 */
export function attemptLabel(attempt: Pick<ValidationAttempt, 'answer'>): string {
  return attempt.answer == null ? WAITING_LABEL : RESULT_LABEL[attempt.answer.result];
}

/**
 * What is true of one attempt right now, as a sentence.
 *
 * The outstanding case is about the run that will answer it and not about the work, because there is
 * nothing yet to say about the work. `now` is a parameter so the phrase can be tested rather than
 * asserted around whatever today is.
 */
export function attemptStanding(attempt: ValidationAttempt, now = new Date()): string {
  if (attempt.answer != null) return RESULT_DETAIL[attempt.answer.result];

  const from = new Date(attempt.observeFrom);
  if (Number.isNaN(from.getTime())) return 'Waiting on the next run.';
  if (from.getTime() <= now.getTime()) {
    return 'Waiting on the next run. Any run that finishes from now on can answer this.';
  }
  return `Waiting until ${momentOf(attempt.observeFrom)}, which is the window that was asked for. A run before then would measure an estate that has not caught up.`;
}

/**
 * The observation window as a phrase, or nothing where there is none.
 *
 * Nothing rather than "0 days", because no window is the ordinary case and a line saying so on every
 * attempt is width spent on the absence of a decision.
 */
export function windowPhrase(observeDays: number): string | undefined {
  if (observeDays <= 0) return undefined;
  return `${plural(observeDays, 'day')} were allowed before any run could answer this.`;
}

/**
 * Why somebody would ask a run to wait, for the form that offers the field.
 *
 * The honest version rather than a recommendation: this app does not record which of its signals are
 * computed over a window, so the person asking is the only one who can know whether a change will
 * show up yet.
 */
export const WINDOW_PROMPT =
  'Days to wait before any run may answer this. Leave it at none unless the change needs time to show up — a ' +
  'setting read straight from an API is true the moment it is saved, while a rate computed over the last thirty ' +
  'days still contains a month of the old behaviour.';

/** Who asked for this and when, for the line under an attempt. */
export function askedPhrase(attempt: Pick<ValidationAttempt, 'requestedBy' | 'requestedAt'>): string {
  return `Asked by ${attempt.requestedBy} on ${momentOf(attempt.requestedAt)}`;
}

/**
 * When the work was claimed done, which is the line every date in an attempt is measured against.
 *
 * Said on every attempt rather than only where it differs, because it is the thing that makes the rest
 * of the panel mean anything: evidence older than this date is not evidence about this work.
 */
export function claimedPhrase(attempt: Pick<ValidationAttempt, 'claimedAt'>): string {
  return `Claimed done on ${momentOf(attempt.claimedAt)}`;
}

/** When a run answered it, and which run. */
export function answeredPhrase(answer: { readonly at: string; readonly scanId?: string }): string {
  const when = momentOf(answer.at);
  return answer.scanId == null ? `Closed on ${when}` : `Answered on ${when} by run ${answer.scanId}`;
}

/**
 * A moment in the reader's own locale, to the minute.
 *
 * To the minute because that is the resolution the decisions here are made at — whether a run finished
 * after a claim — and an unparseable date is shown as it arrived rather than as a plausible one.
 */
export function momentOf(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
