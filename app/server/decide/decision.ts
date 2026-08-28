// What somebody decided to do about a finding.
//
// A pilot reader's first question about a failure is how to fix it, and the second is what to do
// about the ones they are not going to fix this quarter. Without an answer to the second, every
// run reports the same 148 unmet requirements in the same order for ever, the reader learns that
// the list does not respond to their work, and they stop opening it. A finding that has been
// looked at and consciously parked is not the same as one nobody has read, and an assessment that
// cannot tell those apart has no memory of the work done against it.
//
// Three properties matter more than the shape, and the first two are the same ones the attested
// answers turn on.
//
// It names who decided, and who is accountable. "The risk is accepted" with nobody's name against
// it is the sentence audit findings die of. Every record carries the identity that recorded it,
// taken from the forwarded token rather than a form field, and the owner answerable for the
// consequence — who is often not the same person.
//
// It expires. An acceptance with no review date is a decision that quietly becomes policy, and a
// deferral with no date is a decision not to decide. Both carry the date they stop standing, and
// how far away that may be is capped by how much the requirement matters: a critical failure may
// not be parked for a year without anybody looking at it again.
//
// It cannot move the score. This is the rule that makes the feature safe to have. Accepting a risk
// does not make the estate meet the requirement, so an accepted finding keeps failing, keeps
// costing its points and keeps appearing in the export. What a decision changes is the queue —
// what a reader is asked to look at first — and nothing else. A number that improved because
// somebody accepted a risk would be measuring paperwork.
//
// The one that earns its place is `fixed`. A claim that a fix has been applied is the only kind of
// decision this app can check: the next run either agrees or it does not, and a claim the estate
// contradicts is the most useful line in the whole assessment. See standing.ts.

import { cadenceDaysFor, DAY_MS } from '../attest/attestation.js';
import type { Severity } from '../resolve/finding.js';

/**
 * The four things a reader can do with a finding they have read.
 *
 * `fixed` is a claim about the estate and the others are statements about intent, which is why
 * only it is verifiable. `reopened` exists because a decision has to be withdrawable: without it
 * the only way back onto the queue is to wait for a date to pass, and a reader who accepted the
 * wrong requirement by mistake would have no way to say so.
 */
export type Disposition = 'accepted' | 'deferred' | 'fixed' | 'reopened';

export const DISPOSITIONS: readonly Disposition[] = ['accepted', 'deferred', 'fixed', 'reopened'];

/** The two that park a finding until a date, and therefore the two that need one. */
export function needsDate(disposition: Disposition): boolean {
  return disposition === 'accepted' || disposition === 'deferred';
}

export interface Decision {
  readonly id: string;
  readonly controlId: string;
  readonly disposition: Disposition;
  /**
   * Why, in the decider's words.
   *
   * Required, and this is the field that decides whether the record is worth keeping. "Accepted"
   * on its own is not a decision anybody can review; "accepted because the two clusters are in a
   * lab account with no customer data, and the account closes in November" is. The person who
   * reads this next is likely to be somebody else, months later, deciding whether it still holds.
   */
  readonly reason: string;
  /**
   * Who is answerable for the consequence, which is not always who recorded it.
   *
   * Absent only on `reopened`, where there is no consequence to own: putting a finding back on the
   * queue is undoing a decision rather than taking one.
   */
  readonly owner?: string;
  /**
   * When the decision stops standing: the date an acceptance is to be reviewed, or the date a
   * deferred fix is due. Absent on `fixed`, which the next run settles, and on `reopened`.
   */
  readonly until?: Date;
  /** The identity that recorded it, from the forwarded user token rather than a form field. */
  readonly decidedBy: string;
  readonly decidedAt: Date;
  /** The decision this replaced, so the sequence of decisions stays readable. */
  readonly supersedes?: string;
  /** The assessment this decision was recorded under. Absent means it named none. */
  readonly definitionId?: string;
}

/** The shortest reason worth recording. Below this it is a checkbox with extra steps. */
export const MIN_REASON = 20;

/**
 * How long a finding of this severity may be parked before somebody has to look again.
 *
 * The same intervals the attested answers renew on, and deliberately the same source rather than a
 * second copy of the numbers: both are answering "how long may a statement about this requirement
 * stand unexamined", and two tables that were meant to agree and drifted would be worse than one
 * that is occasionally the wrong shape for one of them.
 */
export function longestParkDays(severity: Severity): number {
  return cadenceDaysFor(severity);
}

/**
 * The whole table, for the form to read.
 *
 * Sent to the client rather than restated there: the form has to be able to refuse a date before the
 * reader presses the button, and the only way to do that without a second copy of the rule is for
 * the rule to travel.
 */
export function parkDays(): Readonly<Record<Severity, number>> {
  return {
    critical: longestParkDays('critical'),
    high: longestParkDays('high'),
    medium: longestParkDays('medium'),
    low: longestParkDays('low'),
    informational: longestParkDays('informational'),
  };
}

/**
 * A submitted decision, before the parts only the server may decide are attached.
 *
 * The identity and the timestamp are not in here on purpose. A client that could send `decidedBy`
 * could attribute an accepted risk to a colleague.
 */
export interface DecisionDraft {
  readonly controlId: string;
  readonly disposition: Disposition;
  readonly reason: string;
  readonly owner?: string;
  readonly until?: Date;
}

export class InvalidDecisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDecisionError';
  }
}

export interface DraftContext {
  readonly knownControl: (id: string) => boolean;
  /** For the cap on how far away `until` may be. */
  readonly severityOf: (id: string) => Severity | undefined;
  readonly now?: Date;
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * Validated here rather than at the route so the same rules apply to any caller, and so the
 * messages can be written once. Every message says what to do, because the person who sees it is
 * filling in a form and "invalid request" tells them nothing about which part of it.
 */
export function draftFrom(body: unknown, context: DraftContext): DecisionDraft {
  const raw = (body ?? {}) as Record<string, unknown>;
  const now = context.now ?? new Date();

  const controlId = text(raw.controlId);
  if (controlId == null) throw new InvalidDecisionError('Name the requirement being decided, as controlId.');
  if (!context.knownControl(controlId)) {
    throw new InvalidDecisionError(`This framework has no requirement with the id ${controlId}.`);
  }

  const disposition = text(raw.disposition);
  if (disposition == null || !DISPOSITIONS.includes(disposition as Disposition)) {
    throw new InvalidDecisionError(`The decision must be one of ${DISPOSITIONS.join(', ')}.`);
  }
  const settled = disposition as Disposition;

  const reason = text(raw.reason);
  if (reason == null || reason.length < MIN_REASON) {
    throw new InvalidDecisionError(
      `Say why, in at least ${String(MIN_REASON)} characters. A decision with no reason behind it cannot be ` +
        'reviewed by whoever inherits it.'
    );
  }

  const owner = text(raw.owner);
  if (owner == null && settled !== 'reopened') {
    throw new InvalidDecisionError('Name who is answerable for this decision, as owner.');
  }

  return {
    controlId,
    disposition: settled,
    reason,
    ...(owner != null ? { owner } : {}),
    ...untilFor(settled, raw.until, controlId, context, now),
  };
}

/**
 * The date part, which is the only field whose rules differ per disposition.
 *
 * A date on a `fixed` claim is refused rather than ignored, because the two mean different things
 * and silently dropping it would let a reader believe they had set a reminder. What settles a fix
 * claim is the next run, not a date.
 */
function untilFor(
  disposition: Disposition,
  raw: unknown,
  controlId: string,
  context: DraftContext,
  now: Date
): { until?: Date } {
  const supplied = text(raw);

  if (!needsDate(disposition)) {
    if (supplied != null) {
      throw new InvalidDecisionError(
        disposition === 'fixed'
          ? 'A fix claim takes no date: the next run is what confirms or contradicts it.'
          : 'Putting a requirement back on the list takes no date.'
      );
    }
    return {};
  }

  if (supplied == null) {
    throw new InvalidDecisionError(
      disposition === 'accepted'
        ? 'Give the date this acceptance is to be reviewed, as until. An acceptance with no review date becomes policy.'
        : 'Give the date the fix is due, as until. A deferral with no date is a decision not to decide.'
    );
  }

  const until = new Date(supplied);
  if (Number.isNaN(until.getTime())) {
    throw new InvalidDecisionError('The date must be an ISO date, such as 2026-09-30.');
  }
  if (until.getTime() <= now.getTime()) {
    throw new InvalidDecisionError('The date has to be in the future, or the decision is already lapsed.');
  }

  const severity = context.severityOf(controlId);
  const cap = severity == null ? undefined : longestParkDays(severity);
  if (cap != null && until.getTime() - now.getTime() > cap * DAY_MS) {
    throw new InvalidDecisionError(
      `A ${severity ?? ''} requirement can be parked for at most ${String(cap)} days at a time, so this date is too ` +
        'far away. Choose a nearer one and decide again when it arrives — the point is that somebody looks, not ' +
        'that the fix lands by then.'
    );
  }

  return { until };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
