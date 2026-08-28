// A requirement somebody has decided not to meet, on purpose, for a while.
//
// `decide/decision.ts` already has an `accepted` disposition, and it is not this. The difference is
// what the record can be reviewed against, and it is the whole reason for a second record rather than
// a field added to the first.
//
// A decision says why the finding is parked and until when. That is enough to keep a queue honest and
// it is not enough to answer the question an auditor actually asks, which is: while this requirement is
// unmet, what is holding the line instead? A parked finding with no answer to that is an exposure
// nobody is watching, recorded in a way that reads like it is being managed. So this record cannot be
// written without naming the compensating control, and it cannot be written without saying what risk
// is left after that control is taken into account.
//
// Four rules the record enforces rather than describes.
//
// **It cannot be written without a compensating control.** Not a checkbox and not a reference to the
// requirement it is compensating for — prose somebody else can check. The honest case where nothing is
// holding the line is writable, and it has to be written as a sentence saying so, which is exactly the
// sentence a reviewer needs to see. What is refused is "none" and "n/a", which are that sentence with
// the reasoning removed.
//
// **It expires, and expiry puts the work back.** An acceptance with no end date is a decision that
// became policy without anybody deciding it should. How far away the end may be is capped by how much
// the requirement matters — the same cap a parked decision gets, from the same table — and it is keyed
// off the requirement's own severity rather than off the residual risk claimed here, because a cap
// keyed off a number the requester supplies is a cap the requester sets.
//
// **It cannot be backdated.** An acceptance effective from last quarter claims the exposure was
// covered during a period when nothing was recorded, which is the one thing this record could be used
// to manufacture. It may be dated forward — accepting a risk from the day a mitigation lands is real
// work — and until that date arrives the finding stays where it was, on the queue.
//
// **It does not move the score, and it does not make the requirement met.** The same rule the
// decisions carry, and it is worth restating here because this record is the one somebody would reach
// for to make a number go up. An accepted risk keeps failing, keeps costing its points and keeps
// appearing in the export. What it changes is what a reader is asked to look at first, and what an
// auditor is shown when they ask why.
//
// Two things it deliberately does not have.
//
// No second approver. AUD-DEC-114 settled that: a mandatory second signature on every acceptance
// produces a queue of unsigned exceptions and a habit of signing them in batches, which is worse than
// one accountable owner named in a record that expires. Who recorded it and who owns it are both kept,
// and they are often not the same person.
//
// No extension. A risk carried for another quarter is a new record naming the one it replaces, so how
// long the exposure has actually been carried stays readable. An expiry date somebody could push out
// would make a two-year acceptance indistinguishable from a fresh one.

import { cadenceDaysFor, DAY_MS, DUE_WINDOW_DAYS } from '../attest/attestation.js';
import type { Severity } from '../resolve/finding.js';

/**
 * What is left once the compensating control is taken into account.
 *
 * The same scale the findings use, so it can be compared with the severity of the requirement being
 * accepted rather than read as a private word. A residual above that severity is refused: a
 * compensating control cannot leave more risk than the unmet requirement carried in the first place,
 * and a record claiming it does is describing something other than an acceptance.
 */
export type ResidualRisk = Severity;

/**
 * The scale, most severe first, because the order is what the ceiling below compares.
 *
 * Written out here rather than imported: the outcome vocabulary has no list of the five, and a
 * constant whose order carries a rule is better next to the rule than three modules away where the
 * next person to alphabetise it would not know what they had changed.
 */
export const RESIDUAL_RISKS: readonly ResidualRisk[] = ['critical', 'high', 'medium', 'low', 'informational'];

export interface Revocation {
  /** The identity that revoked it, from the forwarded token rather than a form field. */
  readonly by: string;
  readonly at: Date;
  /**
   * Why it was revoked, which is not the same as why it was accepted.
   *
   * Required, unlike the reason on a withdrawn validation. A revocation puts a requirement back on
   * somebody's queue ahead of the date they were told to expect, and "revoked" with nothing beside it
   * leaves the owner to guess whether the control failed, the scope changed, or somebody disagreed.
   */
  readonly reason: string;
}

export interface AcceptedRisk {
  readonly id: string;
  /** The requirement being accepted. One per record: see `riskFrom` for why not a list. */
  readonly controlId: string;
  /**
   * How many times this requirement has been accepted, this one included. 1 for the first.
   *
   * A field rather than a count of the records, and it is what makes "one at a time" a rule the
   * database holds rather than a check this app performs. Two people accepting the same requirement in
   * the same second both read no acceptance and both compute 1, and the unique constraint on the
   * requirement, the ordinal and the revision refuses the second — which turns a duplicated exception
   * with two owners into a message its author can act on. The same argument ADR 0051 makes for an
   * action's revision, one record along.
   *
   * It is also the number a reader wants: a requirement being accepted for the fourth time is the
   * sentence a register exists to make visible.
   */
  readonly ordinal: number;
  /**
   * Why the requirement is not being met, in the accepter's words.
   *
   * The same field a decision carries and the same standard: the reader is somebody else, months
   * later, deciding whether this still holds.
   */
  readonly reason: string;
  /**
   * What is holding the line while the requirement is unmet.
   *
   * The field this record exists for. It has to say what is in place instead — a narrower network
   * path, a manual review, a compensating alert — in terms a reviewer can check against the estate. A
   * restatement of the reason is refused, because the reason is why nothing was done and this is what
   * was done anyway.
   */
  readonly compensatingControl: string;
  /** What is left after that control, on the findings' own scale. */
  readonly residual: ResidualRisk;
  /** Who is answerable while this stands, which is often not who recorded it. */
  readonly owner: string;
  /**
   * When it starts standing.
   *
   * Now, ordinarily. A future date is allowed and means the finding stays on the queue until then; a
   * past one is refused, because an acceptance cannot cover a period nothing recorded.
   */
  readonly effectiveFrom: Date;
  /** When it stops standing, whatever else happens. Capped by the requirement's severity. */
  readonly expiresAt: Date;
  readonly recordedBy: string;
  readonly recordedAt: Date;
  /** The acceptance this renews, so how long the exposure has been carried stays readable. */
  readonly supersedes?: string;
  /** Set once somebody ended it early. The record stays either way. */
  readonly revoked?: Revocation;
  /** The assessment this acceptance was recorded under. Absent means it named none. */
  readonly definitionId?: string;
}

/** The shortest reason or compensating control worth keeping. Below this it is a checkbox. */
export const MIN_PROSE = 20;

/**
 * The words that defeat the compensating-control field, refused by name.
 *
 * A minimum length alone does not catch them: "none that apply here at present" is long enough and
 * says nothing. These are the ones worth naming in the refusal, with the sentence the writer should
 * write instead, because somebody typing "n/a" is usually not hiding anything — they have read the
 * field as paperwork and need telling what it is for.
 */
const EMPTY_ANSWERS = ['none', 'n/a', 'na', 'nothing', 'no', 'not applicable', 'tbc', 'tbd'];

/**
 * How long a requirement of this severity may be accepted for at a time.
 *
 * The parked-decision cap, from the same table, for the reason that table gives: both are answering
 * "how long may a statement about this requirement stand unexamined". A record that could be written
 * for longer than the same requirement could be deferred for would make this the way around the cap.
 */
export function longestAcceptanceDays(severity: Severity): number {
  return cadenceDaysFor(severity);
}

/** The whole table, so the form can refuse a date before the reader presses the button. */
export function acceptanceDays(): Readonly<Record<Severity, number>> {
  return {
    critical: longestAcceptanceDays('critical'),
    high: longestAcceptanceDays('high'),
    medium: longestAcceptanceDays('medium'),
    low: longestAcceptanceDays('low'),
    informational: longestAcceptanceDays('informational'),
  };
}

/**
 * Where an acceptance stands, which is a function of its dates and not a field on it.
 *
 * Derived rather than stored, like a decision's standing and for the same reason plus one more: a
 * stored `expired` would have to be written by something that wakes up and looks, and an acceptance
 * that stays effective because a sweep did not run is an exposure kept off the queue by a cron
 * failure.
 */
export type RiskStanding =
  /** Recorded, and its effective date has not arrived. The finding is still on the queue. */
  | 'pending'
  /** Effective, with its expiry comfortably ahead. */
  | 'active'
  /** Effective, and its expiry is close enough that somebody has to decide again soon. */
  | 'expiring'
  /** Its expiry has passed. The requirement is back on the queue and this says it was accepted. */
  | 'expired'
  /** Ended early, with a reason. */
  | 'revoked'
  /** Replaced by a later acceptance of the same requirement. */
  | 'superseded';

export interface RiskStandingContext {
  /**
   * The instant to read the standing at. Defaults to now, and a past instant answers as of then.
   *
   * Every date on the record is compared against this one, the revocation included. A published month
   * asks where an acceptance stood when the month closed, and an acceptance revoked in October covered
   * the requirement for all of August — reading the revocation regardless of `now` made August's record
   * depend on when it was published, which is the one thing a frozen month may not do.
   */
  readonly now?: Date;
  /**
   * True when a later acceptance of the same requirement replaced this one.
   *
   * Passed in rather than read from the record, because being superseded is a fact about the set: the
   * record cannot know that something newer was written, and a `supersededBy` field on it would have
   * to be written back — which is the mutable-state problem this type exists to avoid.
   *
   * The one part of this that `now` does not reach: the caller decides what the set is, so a caller
   * reading a past instant has to hand it the set as it stood then. `inForce` does not pass this at all.
   */
  readonly superseded?: boolean;
}

export function standingOf(risk: AcceptedRisk, context: RiskStandingContext = {}): RiskStanding {
  const now = context.now ?? new Date();

  // Revocation first, and before supersession: a revoked acceptance that was later replaced was still
  // revoked, and that is the fact somebody is looking for when they ask why the queue changed. From the
  // instant it was revoked, though, and not before: a revocation is an event with a date like the
  // others, so reading a past instant reads the acceptance as it stood then. At the default `now` every
  // revocation is already in the past, so the live queue reads exactly as it did.
  if (risk.revoked != null && risk.revoked.at.getTime() <= now.getTime()) return 'revoked';
  if (context.superseded === true) return 'superseded';

  if (risk.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (risk.effectiveFrom.getTime() > now.getTime()) return 'pending';

  const remaining = risk.expiresAt.getTime() - now.getTime();
  return remaining <= DUE_WINDOW_DAYS * DAY_MS ? 'expiring' : 'active';
}

/**
 * Whether this acceptance takes the finding off the work queue.
 *
 * Only while it is effective. `pending` does not park — the whole point of a future effective date is
 * that the work is still expected until then — and neither does `expired`, which is what makes expiry
 * mean something rather than being a date in a record nobody reads.
 */
export function effective(standing: RiskStanding): boolean {
  return standing === 'active' || standing === 'expiring';
}

/**
 * Whether the reader is owed a prompt about this one.
 *
 * `expiring` and `expired` both, and they are different prompts: one is a decision to make, the other
 * is work that has silently come back.
 */
export function needsAttention(standing: RiskStanding): boolean {
  return standing === 'expiring' || standing === 'expired';
}

export class InvalidRiskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRiskError';
  }
}

/**
 * A submitted acceptance, before the parts only the server may decide are attached.
 *
 * No `recordedBy` and no dates of record, for the reason the decision draft gives: a client that could
 * send them could attribute an accepted risk to a colleague.
 */
export interface RiskDraft {
  readonly controlId: string;
  readonly reason: string;
  readonly compensatingControl: string;
  readonly residual: ResidualRisk;
  readonly owner: string;
  readonly effectiveFrom: Date;
  readonly expiresAt: Date;
}

export interface RiskContext {
  readonly knownControl: (id: string) => boolean;
  /** For the cap on the expiry, and for the ceiling on the residual risk claimed. */
  readonly severityOf: (id: string) => Severity | undefined;
  /** The acceptances already recorded against this requirement, so a second effective one is refused. */
  readonly existing?: readonly AcceptedRisk[];
  readonly now?: Date;
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * One requirement per record rather than a list, which is the shape decision on this record worth
 * arguing for. An acceptance covering nine requirements has one reason and one compensating control
 * for nine different exposures, and it expires for all nine on the same day — so the ninth is reviewed
 * on the schedule of the first. Nine records is more typing and it is nine things somebody can review,
 * revoke and renew separately, which is what the record is for.
 */
export function riskFrom(body: unknown, context: RiskContext): RiskDraft {
  const raw = (body ?? {}) as Record<string, unknown>;
  const now = context.now ?? new Date();

  const controlId = text(raw.controlId);
  if (controlId == null) throw new InvalidRiskError('Name the requirement being accepted, as controlId.');
  if (!context.knownControl(controlId)) {
    throw new InvalidRiskError(`This framework has no requirement with the id ${controlId}.`);
  }

  const standing = alreadyAccepted(context.existing ?? [], now);
  if (standing != null) {
    throw new InvalidRiskError(
      `This requirement is already accepted until ${dayNamed(standing.expiresAt)}, by ${standing.owner}. Two ` +
        'acceptances of one requirement would expire on different days and neither would be the one in force. ' +
        'Revoke that one, or renew it when it expires.'
    );
  }

  const reason = text(raw.reason);
  if (reason == null || reason.length < MIN_PROSE) {
    throw new InvalidRiskError(
      `Say why this requirement is not being met, in at least ${String(MIN_PROSE)} characters. Whoever inherits ` +
        'this has to be able to judge whether it still holds.'
    );
  }

  const compensatingControl = compensatingControlFrom(raw.compensatingControl, reason);
  const severity = context.severityOf(controlId);
  const residual = residualFrom(raw.residual, controlId, severity);
  const owner = text(raw.owner);
  if (owner == null) {
    throw new InvalidRiskError(
      'Name who is answerable while this stands, as owner. An accepted risk with nobody against it is the sentence ' +
        'audit findings die of.'
    );
  }

  const effectiveFrom = effectiveFromFor(raw.effectiveFrom, now);
  const expiresAt = expiryFor(raw.expiresAt, effectiveFrom, severity, now);

  return { controlId, reason, compensatingControl, residual, owner, effectiveFrom, expiresAt };
}

/**
 * The acceptance as recorded, with who wrote it, when, and where it sits in the requirement's history.
 *
 * `previous` is every acceptance already recorded against this requirement, and both facts derived from
 * it are derived here rather than taken from the request. What this renews is the last of them: a body
 * that could name it could point a renewal at somebody else's acceptance, and the chain of how long an
 * exposure has been carried would be the requester's to write. The ordinal is their count, which is what
 * the database refuses a second write of.
 */
export function recorded(
  draft: RiskDraft,
  by: string,
  id: string,
  at: Date,
  previous: readonly AcceptedRisk[] = []
): AcceptedRisk {
  // The most recent one, which `riskFrom` has already established is no longer standing. Nothing where
  // the requirement has never been accepted, which is the ordinary case.
  const supersedes = newestFirst(previous)[0]?.id;
  return {
    id,
    controlId: draft.controlId,
    ordinal: previous.length + 1,
    reason: draft.reason,
    compensatingControl: draft.compensatingControl,
    residual: draft.residual,
    owner: draft.owner,
    effectiveFrom: draft.effectiveFrom,
    expiresAt: draft.expiresAt,
    recordedBy: by,
    recordedAt: at,
    ...(supersedes != null ? { supersedes } : {}),
  };
}

/**
 * The acceptance after somebody ended it early.
 *
 * A second version of the record rather than a new one, unlike a renewal: nothing about the acceptance
 * changed, it stopped. Revoking twice is refused rather than ignored, because the second revocation
 * would otherwise replace the first one's reason and date with its own — and who ended this, when, is
 * the part of a revocation anybody comes back for.
 */
export function revoked(risk: AcceptedRisk, by: string, reason: string, at: Date): AcceptedRisk {
  if (risk.revoked != null) {
    throw new InvalidRiskError('This acceptance has already been revoked, and a revocation is not rewritten.');
  }
  const why = text(reason);
  if (why == null || why.length < MIN_PROSE) {
    throw new InvalidRiskError(
      `Say why this is being revoked, in at least ${String(MIN_PROSE)} characters. This puts the requirement back ` +
        'on somebody’s queue before the date they were told to expect, and they are owed the reason.'
    );
  }

  return { ...risk, revoked: { by, at, reason: why } };
}

/**
 * The one acceptance of a requirement that is in force at an instant, where there is one.
 *
 * Newest first, so a renewal recorded while the previous one is still running is what a reader sees —
 * although `riskFrom` refuses that case, so in practice this finds the only effective one.
 *
 * `now` is the instant asked about and a past one is a real question: a published month asks which
 * acceptances stood when it closed. Every date on the record is read against it, so an acceptance
 * revoked or renewed after that instant is the acceptance that stood at it.
 */
export function inForce(risks: readonly AcceptedRisk[], now = new Date()): AcceptedRisk | undefined {
  return newestFirst(risks).find((risk) => effective(standingOf(risk, { now })));
}

/** Acceptances newest first, because the last decision about a requirement is the one being read. */
export function newestFirst(risks: readonly AcceptedRisk[]): readonly AcceptedRisk[] {
  return [...risks].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}

/**
 * An acceptance already standing, counting one that has not started yet.
 *
 * `pending` counts, and that is the answer to a real question: somebody accepting the same requirement
 * twice, once from today and once from next month, has written two records where the second silently
 * takes over from the first with a different owner and a different reason. One at a time, and a renewal
 * when the first ends.
 */
function alreadyAccepted(existing: readonly AcceptedRisk[], now: Date): AcceptedRisk | undefined {
  return newestFirst(existing).find((risk) => {
    const standing = standingOf(risk, { now });
    return effective(standing) || standing === 'pending';
  });
}

/**
 * A date in a sentence a person reads, rather than the timestamp it is stored as.
 *
 * The refusal above quoted `2026-10-03T23:59:59.999Z` at somebody being told why their acceptance was
 * declined. It is the correct instant and it reads as a fault in the app: the milliseconds and the zone
 * are the record's business, and the reader's question is which day the requirement comes back.
 *
 * UTC, because the stored expiry is the end of a day in UTC and rendering it in the server's zone would
 * name the day after it west of Greenwich.
 */
function dayNamed(when: Date): string {
  return when.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function compensatingControlFrom(raw: unknown, reason: string): string {
  const control = text(raw);

  // Before the length check, and that order is the whole reason the list exists. Every word in it is
  // shorter than the minimum, so a reader who wrote "n/a" would otherwise be told to write more
  // characters — advice they can follow to "n/a for now, see above" without ever learning what the
  // field is for.
  if (control != null && EMPTY_ANSWERS.includes(control.toLowerCase().replace(/[.\s]+$/, ''))) {
    throw new InvalidRiskError(
      `A compensating control of “${control}” says nothing a reviewer can check. If nothing is holding the line, ` +
        'write that in a sentence with the reason the exposure is tolerable anyway.'
    );
  }
  if (control == null || control.length < MIN_PROSE) {
    throw new InvalidRiskError(
      `Say what is holding the line while this requirement is unmet, as compensatingControl, in at least ` +
        `${String(MIN_PROSE)} characters. If nothing is, write that and say why the exposure is tolerable — that ` +
        'sentence is the one a reviewer needs.'
    );
  }
  if (control.toLowerCase() === reason.toLowerCase()) {
    throw new InvalidRiskError(
      'The compensating control is the reason repeated. They are different things: the reason is why the ' +
        'requirement is not met, and the compensating control is what is in place instead.'
    );
  }
  return control;
}

/**
 * The residual risk, refused above the severity of the requirement it is left over from.
 *
 * A compensating control cannot leave more risk than the unmet requirement carried, so a record
 * claiming it does is either a mistake about which requirement is being accepted or a different kind
 * of record — an escalation, which this app does not have and should not have under this name.
 */
function residualFrom(raw: unknown, controlId: string, severity: Severity | undefined): ResidualRisk {
  const supplied = text(raw);
  if (supplied == null || !RESIDUAL_RISKS.includes(supplied as Severity)) {
    throw new InvalidRiskError(
      `Say what risk is left after the compensating control, as residual, one of ${RESIDUAL_RISKS.join(', ')}.`
    );
  }
  const residual = supplied as Severity;

  if (severity != null && RESIDUAL_RISKS.indexOf(residual) < RESIDUAL_RISKS.indexOf(severity)) {
    throw new InvalidRiskError(
      `${controlId} is a ${severity} requirement, so the risk left after a compensating control cannot be ` +
        `${residual}. Either the compensating control is not the one being described, or this is not the ` +
        'requirement being accepted.'
    );
  }

  return residual;
}

function effectiveFromFor(raw: unknown, now: Date): Date {
  const supplied = text(raw);
  if (supplied == null) return now;

  const from = new Date(supplied);
  if (Number.isNaN(from.getTime())) {
    throw new InvalidRiskError('The effective date must be an ISO date, such as 2026-09-30.');
  }
  // A minute's grace, because a form that sends "today" as a midnight in the reader's own zone is
  // sending a date the server may already be past by an hour. Anything further back is a backdated
  // acceptance, which is refused.
  if (from.getTime() < now.getTime() - DAY_MS) {
    throw new InvalidRiskError(
      'An acceptance cannot be backdated: a record effective from before today would claim the exposure was ' +
        'covered during a period when nothing was recorded. Leave the date out to accept it from now.'
    );
  }
  return from;
}

function expiryFor(raw: unknown, effectiveFrom: Date, severity: Severity | undefined, now: Date): Date {
  const supplied = text(raw);
  if (supplied == null) {
    throw new InvalidRiskError(
      'Give the date this acceptance ends, as expiresAt. An acceptance with no end date is a decision that becomes ' +
        'policy without anybody deciding it should.'
    );
  }

  const expiresAt = new Date(supplied);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new InvalidRiskError('The expiry must be an ISO date, such as 2026-09-30.');
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new InvalidRiskError('The expiry has to be in the future, or the acceptance has ended before it began.');
  }
  if (expiresAt.getTime() <= effectiveFrom.getTime()) {
    throw new InvalidRiskError('The expiry has to be after the date this becomes effective.');
  }

  const cap = severity == null ? undefined : longestAcceptanceDays(severity);
  // Measured from now rather than from the effective date, so a future start cannot buy a longer run:
  // the cap is how long a requirement may stand unexamined, and a record dated to start in three
  // months and end nine months after that leaves it unexamined for a year.
  if (cap != null && expiresAt.getTime() - now.getTime() > cap * DAY_MS) {
    throw new InvalidRiskError(
      `A ${String(severity)} requirement can be accepted for at most ${String(cap)} days at a time, so this expiry ` +
        'is too far away. Choose a nearer one and renew it when it arrives — the point is that somebody looks again, ' +
        'not that the acceptance is short.'
    );
  }

  return expiresAt;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
