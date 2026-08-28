// The words the exception register uses, in one place.
//
// Separated from the components for the reason the other language modules are, and for one more that
// is particular to this record: almost every sentence here is a comparison against a clock, and the
// two sides of that comparison mean opposite things to whoever has to act. "Expires in 9 days" is a
// diary entry; "expired 9 days ago" is a requirement that came back onto the queue and nobody
// noticed. A date-dependent sentence written inline is a sentence nobody tests.
//
// What none of these words do is call an acceptance a pass. The requirement is unmet, it still costs
// its points, and the copy has to keep saying so — the whole risk of this record is that it reads
// like the problem was solved rather than parked.

import {
  CalendarClock,
  CircleSlash,
  Hourglass,
  Layers,
  ShieldCheck,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type { AcceptedRisk, RiskStanding, Severity } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

/** The server's own minimum, repeated so the reader is told before they submit rather than after. */
export const MIN_PROSE = 20;

/**
 * The words the compensating-control field refuses, named here so the form can say so first.
 *
 * The same list the server holds, and the duplication is deliberate in this one direction: the server
 * is the authority and this is a courtesy, so a list that falls behind refuses less than the server
 * does rather than more. A form that refuses something the server would accept is a form that lies
 * about the rule; one that accepts something the server refuses costs a round trip and says why.
 */
const EMPTY_ANSWERS = ['none', 'n/a', 'na', 'nothing', 'no', 'not applicable', 'tbc', 'tbd'];

/**
 * Whether what was typed into the compensating-control field says nothing.
 *
 * A pure function rather than a comparison inside the form, because it is the only rule on that form
 * a rendered test cannot reach — it depends on what somebody typed — and it is the rule the whole
 * record rests on. Trailing punctuation and case are stripped first: "N/A." is the same answer as
 * "n/a", and a check that let the full stop through would refuse one and accept the other.
 */
export function saysNothing(control: string): boolean {
  const said = control.trim().toLowerCase().replace(/[.!\s]+$/, '');
  return EMPTY_ANSWERS.includes(said);
}

export const RISK_STANDINGS: readonly RiskStanding[] = [
  'active',
  'expiring',
  'expired',
  'pending',
  'revoked',
  'superseded',
];

export const STANDING_LABEL: Readonly<Record<RiskStanding, string>> = {
  pending: 'Not yet in force',
  active: 'In force',
  expiring: 'Expiring',
  expired: 'Expired',
  revoked: 'Ended early',
  superseded: 'Replaced',
};

/**
 * What each standing means, in the terms of what it does to the work.
 *
 * `expired` is the one these exist for. An expiry that passes is the moment the record stops holding
 * anything and the requirement comes back onto somebody's queue — silently, because nothing wakes up
 * and tells them. A badge alone reads as bookkeeping; this says the work is back.
 */
export const STANDING_DETAIL: Readonly<Record<RiskStanding, string>> = {
  pending:
    'Recorded, and its start date has not arrived. The requirement is still on the queue until then, ' +
    'which is what a future start date is for.',
  active: 'The requirement is held off the queue until the expiry below. It is still unmet and still costs its points.',
  expiring:
    'Still holding, and close enough to its expiry that somebody has to decide again: accept it for ' +
    'another period, or do the work.',
  expired:
    'This has stopped holding. The requirement is back on the queue as of the date below, whether or ' +
    'not anybody noticed at the time.',
  revoked: 'Ended before its expiry, with the reason below. The requirement went back on the queue then.',
  superseded: 'A later acceptance of the same requirement replaced this one. Kept, because it is how long the exposure has been carried.',
};

/**
 * The badge tone. Only the two that call for work are coloured.
 *
 * `active` is deliberately neutral rather than green. An exception in force is not a good state — it
 * is a requirement nobody has met — and a green pill against a register of exposures would read as
 * approval of every row on it.
 */
export const STANDING_TONE: Readonly<Record<RiskStanding, Tone>> = {
  pending: 'neutral',
  active: 'neutral',
  expiring: 'warning',
  expired: 'danger',
  revoked: 'neutral',
  superseded: 'neutral',
};

export const STANDING_ICON: Readonly<Record<RiskStanding, LucideIcon>> = {
  pending: Hourglass,
  active: ShieldCheck,
  expiring: CalendarClock,
  expired: CircleSlash,
  revoked: Undo2,
  superseded: Layers,
};

/**
 * The order somebody working through the register would choose.
 *
 * Expired first, because it is the only row on the page that is not being managed: everything else is
 * a decision somebody made that is still doing what they intended. Superseded last, being history.
 */
export const STANDING_RANK: Readonly<Record<RiskStanding, number>> = {
  expired: 0,
  expiring: 1,
  active: 2,
  pending: 3,
  revoked: 4,
  superseded: 5,
};

/** Whether the reader is owed a prompt about this one. Mirrors `needsAttention` on the server. */
export function needsAttention(standing: RiskStanding): boolean {
  return standing === 'expiring' || standing === 'expired';
}

/** Who accepted it and when, for a row and for the pane. */
export function acceptedPhrase(risk: Pick<AcceptedRisk, 'recordedBy' | 'recordedAt'>): string {
  return `${risk.recordedBy} on ${dateOf(risk.recordedAt)}`;
}

/**
 * What the expiry means now, said in the tense the standing calls for.
 *
 * The past tense is the point. An expired acceptance is the one case where the record has stopped
 * doing what whoever wrote it intended, and "Expired 12 days ago" is the sentence that says so —
 * where "Expires 4 August" reads, at a glance, like a date still ahead.
 */
export function expiryPhrase(
  risk: Pick<AcceptedRisk, 'expiresAt' | 'standing'>,
  now: Date = new Date()
): string {
  const expires = new Date(risk.expiresAt);
  if (Number.isNaN(expires.getTime())) return 'The expiry on this acceptance could not be read.';

  const date = dayNamed(risk.expiresAt);
  const days = Math.abs(daysBetween(now, expires));

  if (risk.standing === 'expired') {
    return days === 0 ? `Expired today, ${date}.` : `Expired ${plural(days, 'day')} ago, on ${date}.`;
  }
  if (risk.standing === 'revoked' || risk.standing === 'superseded') return `Would have expired ${date}.`;
  if (risk.standing === 'expiring') return `Expires in ${plural(days, 'day')}, on ${date}.`;
  return `Expires ${date}.`;
}

/** When it starts, said only while that is still ahead — a start date in the past is not news. */
export function startPhrase(risk: Pick<AcceptedRisk, 'effectiveFrom' | 'standing'>): string | undefined {
  if (risk.standing !== 'pending') return undefined;
  return `In force from ${dayNamed(risk.effectiveFrom)}.`;
}

/**
 * How much risk is left after the compensating control, against what the requirement carries.
 *
 * Both, always, and never the residual alone. "Residual: low" on a critical requirement is the
 * sentence this record exists to make checkable, and it is only checkable beside the severity it was
 * reduced from.
 */
export function residualPhrase(risk: Pick<AcceptedRisk, 'residual' | 'severity'>): string {
  if (risk.severity == null) return `Residual risk: ${risk.residual}.`;
  if (risk.severity === risk.residual) {
    return `Residual risk: ${risk.residual}, unchanged from the requirement's own severity.`;
  }
  return `Residual risk: ${risk.residual}, down from ${risk.severity} — on the strength of the control above.`;
}

/**
 * How long this requirement may be accepted for, from the server's own table.
 *
 * Read from the payload rather than from a table in here, because the server enforces it and two
 * copies of a rule that were meant to agree eventually do not.
 */
export function acceptanceDaysFor(
  severity: Severity | undefined,
  caps: Readonly<Record<Severity, number>> | undefined
): number {
  if (severity == null || caps == null) return 365;
  return caps[severity] ?? 365;
}

/**
 * The default expiry to offer: a third of the cap, and never less than a week.
 *
 * Offered short of the cap on purpose. A form that arrives with the longest permitted date filled in
 * teaches the reader that the longest permitted date is the normal one, and the cap then does nothing
 * except mark where the teaching stops.
 */
export function suggestedExpiry(capDays: number, now: Date = new Date()): string {
  const days = Math.max(7, Math.round(capDays / 3));
  return dayOf(now.getTime() + days * 86_400_000);
}

/**
 * The furthest date the input may offer, a day inside the cap.
 *
 * For the reason `latestDate` gives on a decision: the date means the end of that day, and the end of
 * the cap's own day is a few hours past the cap. Losing a day at the far end of a ninety-day window
 * costs nothing; offering a date that comes back refused teaches the reader the form cannot be
 * trusted.
 */
export function latestExpiry(capDays: number, now: Date = new Date()): string {
  return dayOf(now.getTime() + (capDays - 1) * 86_400_000);
}

/** Today, which is the earliest an acceptance may start. It cannot be backdated. */
export function earliestStart(now: Date = new Date()): string {
  return dayOf(now.getTime());
}

/** Tomorrow, which is the earliest an expiry worth recording can fall. */
export function earliestExpiry(now: Date = new Date()): string {
  return dayOf(now.getTime() + 86_400_000);
}

/** The end of a chosen day, in UTC, which is what an expiry date means. See `endOfDay` in decide-language. */
export function endOfDay(date: string): string {
  return `${date}T23:59:59.999Z`;
}

/** The start of a chosen day, in UTC, which is what a date an acceptance begins on means. */
export function startOfDay(date: string): string {
  return `${date}T00:00:00.000Z`;
}

/**
 * What a register of this size is, in one line, or nothing when it is empty.
 *
 * The count of what needs attention leads, because a register of forty acceptances where two have
 * expired is a page about those two.
 *
 * It ends by saying that none of this moves the score, which the page's own header comment claimed was
 * said here and nothing said anywhere. It belongs in this sentence rather than in a footnote for the
 * reason the comment gave: a list of accepted failures beside a number that has not fallen invites the
 * reading that accepting them is what holds the number down. It is dropped when the register is empty,
 * where there is nothing to be misread.
 */
export function registerPhrase(total: number, attention: number): string {
  if (total === 0) return 'Nothing has been accepted on this installation.';
  const carried = `${plural(total, 'requirement')} accepted`;
  const standing =
    attention === 0
      ? `${carried}, all of them in force and none expiring yet.`
      : `${carried}, ${String(attention)} of which ${attention === 1 ? 'needs' : 'need'} deciding again.`;
  return `${standing} None of it changes the score — each requirement is still unmet and still costs its points.`;
}

function dayOf(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

/** A moment something happened, in the reader's own timezone, which is where they were when it did. */
function dateOf(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * A day somebody chose, named back to them in the timezone they chose it in.
 *
 * Which is UTC: an acceptance runs to the end of its final day, and the form sends that as
 * `23:59:59.999Z`. Rendered in the reader's own timezone, every reader east of London is shown the day
 * after the one they typed, and the register disagrees with the form that filled it in.
 */
function dayNamed(iso: string): string {
  const when = new Date(iso);
  return Number.isNaN(when.getTime())
    ? 'an unrecorded date'
    : when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/**
 * Whole days from one instant to another, counted as the calendar counts them.
 *
 * Not as division counts them. An acceptance expiring at the end of today is half a day away, which
 * rounds to "expires in 0 days" — a sentence that reads as though it already had. The reader is asking
 * how many times they will see a new date before it lapses, and the answer to that is a subtraction of
 * days, not of hours.
 */
function daysBetween(from: Date, to: Date): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

function utcMidnight(at: Date): number {
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}
