// The words the decisions surface uses, in one place.
//
// Separated from the components for the same reason the other language modules are: most of these
// sentences are conditional on a date or on what the last run measured, and a date-dependent
// sentence written inline is a sentence nobody tests. "Due in 12 days" and "lapsed 12 days ago"
// differ by one comparison and mean opposite things to whoever has to act.
//
// What none of these words do is claim anything about the score. A decision changes which findings
// a reader is asked to look at first; it does not change what was measured, and the copy has to keep
// saying so or the feature becomes a way to make a number look better.

import {
  CalendarClock,
  CheckCircle2,
  CircleX,
  Hourglass,
  PauseCircle,
  Undo2,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import type { Decision, Disposition, Severity, Standing } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

export const DISPOSITIONS: readonly Disposition[] = ['fixed', 'deferred', 'accepted', 'reopened'];

/**
 * What each choice is called, in the reader's terms rather than the record's.
 *
 * `fixed` leads the list on the form because it is the one the app can check, and because it is
 * what a reader who has just done the work is looking for.
 *
 * `accepted` is not called "accepting the risk", though that is what the disposition is named. Those
 * words belong to the accepted-risk record in the same pane, and having both say them left a reader
 * choosing between two controls with one name that do different things: this one parks a finding, and
 * the record beside it is what the exceptions register — the page an auditor asks for — is built from.
 * A decision taken here under that name would have felt like going on the register and would not have.
 */
export const DISPOSITION_LABEL: Readonly<Record<Disposition, string>> = {
  fixed: 'Fixed it',
  deferred: 'Planned for later',
  accepted: 'Not fixing it for now',
  reopened: 'Back on the list',
};

/**
 * What each choice does, said next to it, including the part that is deliberately nothing.
 *
 * `accepted` says where it does *not* appear, which is the only effect text here that names an
 * absence. It has to: the two words a reader arrives with are "accept the risk", and the honest answer
 * is that this parks the work while the record beside it is what gets carried on the register.
 */
export const DISPOSITION_EFFECT: Readonly<Record<Disposition, string>> = {
  fixed: 'The next run checks it. If the requirement still fails, this says so rather than going quiet.',
  deferred: 'Comes back on the list on the date you give, whoever is looking at it then.',
  accepted:
    'Off the list until the review date. The requirement still fails and still costs its points. It does not go on ' +
    'the exceptions register — to carry it there, with what is holding the line instead, accept the risk below.',
  reopened: 'Withdraws the last decision and puts the finding back where it was.',
};

export const STANDING_LABEL: Readonly<Record<Standing, string>> = {
  contradicted: 'Still failing',
  lapsed: 'Lapsed',
  due: 'Due',
  unverified: 'Awaiting a run',
  current: 'Parked',
  confirmed: 'Fixed',
  settled: 'No longer failing',
  withdrawn: 'Withdrawn',
};

/**
 * What each standing means, for the pane and the register.
 *
 * `contradicted` is the one these exist for. A reader who marked something fixed and moved on needs
 * to be told, in words, that the estate disagrees — a red badge alone reads as a bug in the app.
 */
export const STANDING_DETAIL: Readonly<Record<Standing, string>> = {
  contradicted:
    'This was recorded as fixed, and a run since then still measures the requirement as unmet. Either the change ' +
    'did not take or it did not cover everything the check looks at.',
  lapsed:
    'The date on this decision has passed, so it no longer holds and the finding is back on the list. Decide ' +
    'again, or fix it.',
  due: 'The date on this decision is close. It still holds until then.',
  unverified:
    'Recorded as fixed. Nothing has measured the requirement since, so the claim stands until a run either ' +
    'confirms or contradicts it.',
  current: 'Held off the list until the date below.',
  confirmed: 'Recorded as fixed, and a run since agrees. Nothing further to do.',
  settled:
    'This was parked, and the estate now meets the requirement anyway. Nothing is being held off the list by it.',
  withdrawn: 'The previous decision was withdrawn, so the finding is on the list like any other.',
};

/** The badge tone for each standing. Only the two that call for work are coloured. */
export const STANDING_TONE: Readonly<Record<Standing, Tone>> = {
  contradicted: 'danger',
  lapsed: 'warning',
  due: 'warning',
  unverified: 'neutral',
  current: 'neutral',
  confirmed: 'success',
  settled: 'success',
  withdrawn: 'neutral',
};

/**
 * The shape beside the word, because three of these eight carry no fill at all.
 *
 * `Parked`, `Awaiting a run` and `Withdrawn` were text on a plain badge, which made them
 * indistinguishable at a glance from each other and from a neutral outcome. The silhouettes separate
 * what somebody undertook (a wrench, a calendar) from what has become of it (a tick, a cross, an
 * hourglass), so a register scanned quickly reads as states rather than as a column of grey pills.
 */
export const STANDING_ICON: Readonly<Record<Standing, LucideIcon>> = {
  contradicted: CircleX,
  lapsed: CalendarClock,
  due: CalendarClock,
  unverified: Hourglass,
  current: PauseCircle,
  confirmed: Wrench,
  settled: CheckCircle2,
  withdrawn: Undo2,
};

/**
 * The order somebody working through the register would choose.
 *
 * Contradicted first, because a fix that did not take is the most likely thing on the page to be
 * news. Withdrawn last: it is history rather than work.
 */
export const STANDING_RANK: Readonly<Record<Standing, number>> = {
  contradicted: 0,
  lapsed: 1,
  due: 2,
  unverified: 3,
  current: 4,
  settled: 5,
  confirmed: 6,
  withdrawn: 7,
};

/** Who decided and when, for a row and for the pane. */
export function decidedPhrase(decision: Pick<Decision, 'decidedBy' | 'decidedAt'>): string {
  return `${decision.decidedBy} on ${dateOf(decision.decidedAt)}`;
}

/**
 * What the decision's own date means now, in the words its disposition calls for.
 *
 * An acceptance is reviewed and a deferral is due, and using one word for both would tell half the
 * readers the wrong thing about what happens on the date.
 */
export function datePhrase(decision: Pick<Decision, 'disposition' | 'until' | 'standing'>, now = new Date()): string {
  if (decision.until == null) return '';
  const until = new Date(decision.until);
  if (Number.isNaN(until.getTime())) return 'The date on this decision could not be read.';

  const date = dateOf(decision.until);
  const days = Math.round(Math.abs(until.getTime() - now.getTime()) / 86_400_000);
  const noun = decision.disposition === 'accepted' ? 'Review' : 'Due';

  if (decision.standing === 'lapsed') {
    return days === 0 ? `${noun} date was today (${date}).` : `${noun} date passed ${plural(days, 'day')} ago, on ${date}.`;
  }
  if (decision.standing === 'due') return `${noun} in ${plural(days, 'day')}, on ${date}.`;
  return `${noun} ${date}.`;
}

/**
 * How many findings a decision is holding off the list, for the queue's own header.
 *
 * Said wherever the queue is shown, because a queue that quietly drops rows is a queue the reader
 * cannot trust. The count is the whole reason it stays trustworthy.
 */
export function parkedPhrase(count: number): string | undefined {
  if (count === 0) return undefined;
  return count === 1 ? '1 more is accepted, planned or claimed fixed' : `${String(count)} more are accepted, planned or claimed fixed`;
}

/**
 * The default date to offer, given how long this requirement may be parked.
 *
 * Offered rather than imposed, and deliberately short of the cap: a form that arrives with the
 * longest permitted date filled in is a form that teaches the reader to park everything for as long
 * as the app allows.
 */
export function suggestedDate(capDays: number, now = new Date()): string {
  const days = Math.max(7, Math.round(capDays / 3));
  return new Date(now.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * The furthest date the server will accept, as the value an input's `max` needs.
 *
 * A day inside the cap rather than on it. The date the reader picks means the end of that day — a
 * decision reviewed on the 30th holds through the 30th — and the end of the cap's own day is a few
 * hours past the cap, which the server would refuse. Losing a day at the far end of a ninety-day
 * window costs nothing; offering a date that comes back rejected costs the reader a second attempt
 * and teaches them the form cannot be trusted.
 */
export function latestDate(capDays: number, now = new Date()): string {
  return dayOf(now.getTime() + (capDays - 1) * 86_400_000);
}

/**
 * The nearest date worth offering, which is tomorrow.
 *
 * The server refuses a date that has already passed, and a date picker whose range starts today
 * invites exactly that: "review this by today" is a decision that lapses the moment it is recorded.
 */
export function earliestDate(now = new Date()): string {
  return dayOf(now.getTime() + 86_400_000);
}

/**
 * The moment a chosen day ends, in UTC, which is what a date on a decision means.
 *
 * Sent instead of the day's start because the two differ by a day for most of the world: a reader
 * west of UTC picking tomorrow would send a midnight that has already passed in UTC, and the server
 * would reject a date the form had just offered them.
 */
export function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/**
 * How long a requirement of this severity may be parked at a time.
 *
 * Read from the payload rather than from a table in here, because the server enforces it and two
 * copies of a rule that were meant to agree eventually do not. The fallback is the longest interval
 * the server has, so a payload that somehow arrives without the caps offers a date the server may
 * refuse rather than one it would have accepted and the form did not offer.
 */
export function parkDaysFor(severity: Severity | undefined, caps: Readonly<Record<Severity, number>> | undefined): number {
  if (severity == null || caps == null) return 365;
  return caps[severity] ?? 365;
}

function dateOf(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
