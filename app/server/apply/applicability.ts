// A requirement a customer has said this app should stop scoring them against, on purpose, for a while.
//
// Two levers, one record. A customer may declare a requirement **not applicable** — it is about a thing
// their estate does not have — or **disable** its check — the measurement is off, whatever the reason.
// 31c measured that these are not the harmless "measured less" the plan once called them: disabling a
// failing check improves the figure exactly as marking it inapplicable does, and across an alias group a
// disable in one pillar moves a score in a pillar nobody touched. So both levers are the same kind of
// record — one that takes a requirement out of the denominator — and both are bounded the same way.
//
// This module is the record and its rules, and nothing else: no store (31d) and no HTTP surface (31e),
// and it does not itself move a score (31f). It has the shape `accept/risk.ts` has, and for the same
// reason — the rules are the hard part and they are testable without a database or a route in front of
// them.
//
// Four rules the record enforces rather than describes.
//
// **Neither lever may be used against a reading of `fail` or `partial`.** A failing measurement is
// direct evidence the estate has the thing the requirement is about — the app looked, found it, and
// found it wanting — so a claim it does not apply contradicts a reading rather than adding to it, and
// switching the check off to make the same claim is the same move with the evidence hidden instead of
// denied. The route for "we know, and we are living with it" already exists and is the better record:
// an accepted risk, with a compensating control, an owner and an expiry, which keeps the failure in the
// score where a reader can see it. The refusal is about the *reading* rather than the outcome showing on
// the day, and the reading is the one with every applicability decision in force on the requirement set
// aside — supplied by the caller, because only the caller can see the scan. That is what closes the
// dodge of disabling a check and then marking the now-unmeasurable requirement inapplicable: the reading
// underneath both is still the failure.
//
// **A decision in force lapses when the reading turns `fail` or `partial`.** Derived from the dates and
// the reading rather than written back, like a risk's expiry and for the same reason: a decision that
// stayed effective because nothing re-read it would be a score held down by a measurement that has since
// regressed. A lapsed decision is set aside — it stops taking the requirement out of the denominator —
// and it is a prompt, not a silent reversal.
//
// **It has effective dates, and it cannot be backdated.** A decision effective from last quarter claims
// the requirement was excluded during a period nothing recorded it, which is the one thing this record
// could manufacture. It may be dated forward, and until that date arrives the requirement is scored as
// usual. It expires, because an exclusion with no end date is a decision that becomes policy without
// anybody deciding it should.
//
// **One in force at a time, per requirement.** Two decisions excluding one requirement would expire on
// different days and neither would be the one in force. A renewal is a new record naming the one it
// replaces, so how long a requirement has been excluded stays readable — the argument `accept/risk.ts`
// makes, one record along.
//
// What it deliberately does not do is move the score. A decision recorded here is visible on its
// register; it does not leave the denominator until 31f wires it into scoring, with the removal exposed.
// Building the bounded record first and the number it moves last is the order C2 used and for the same
// reason: the half that moves a number is landed against the pieces below it already tested.

import { DAY_MS, DUE_WINDOW_DAYS } from '../attest/attestation.js';
import { longestAcceptanceDays } from '../accept/risk.js';
import type { Outcome, Severity } from '../resolve/finding.js';

/**
 * The two ways a customer takes a requirement out of their score.
 *
 * `not-applicable` is a claim about the estate: the requirement is about a thing they do not have.
 * `disabled` is a claim about the measurement: the check is off. 31c measured that they differ in how
 * they read on the coverage bar and in `confidenceOf`, but not in what they do to the figure — so they
 * are one record with a lever rather than two records, and the bound below applies to both.
 */
export type ApplicabilityLever = 'not-applicable' | 'disabled';

/**
 * The levers, written out here because the outcome vocabulary has no list of them and a constant a rule
 * reads is better next to the rule.
 */
export const LEVERS: readonly ApplicabilityLever[] = ['not-applicable', 'disabled'];

/**
 * The readings that refuse either lever.
 *
 * `fail` and `partial` are the two where the app measured the requirement and found the estate wanting.
 * `unmeasurable` is not here on purpose: marking a requirement inapplicable when nothing measured it is
 * what the lever is for, and a customer with no streaming workloads should be able to exclude the
 * streaming requirements. See ADR 0059.
 */
export const REFUSED_READINGS: readonly Outcome[] = ['fail', 'partial'];

/** The shortest reason worth keeping. Below this it is a checkbox. */
export const MIN_PROSE = 20;

/**
 * The words that defeat the reason field, refused by name.
 *
 * A minimum length alone does not catch them: "none that apply here at present" is long enough and says
 * nothing. Naming them lets the refusal tell somebody who wrote "n/a" what the field is for, rather than
 * advising a longer non-answer.
 */
const EMPTY_ANSWERS = ['none', 'n/a', 'na', 'nothing', 'no', 'not applicable', 'tbc', 'tbd'];

export interface Revocation {
  /** The identity that revoked it, from the forwarded token rather than a form field. */
  readonly by: string;
  readonly at: Date;
  /** Why it was revoked, which is not the same as why it was recorded. Required. */
  readonly reason: string;
}

export interface ApplicabilityDecision {
  readonly id: string;
  /** The requirement being excluded. One per record. */
  readonly controlId: string;
  /** Which lever. Both take the requirement out of the denominator; they differ elsewhere, not here. */
  readonly lever: ApplicabilityLever;
  /**
   * How many times this requirement has carried a decision, this one included. 1 for the first.
   *
   * A field rather than a count of the records, so "one at a time" is a rule the database holds: two
   * people excluding the same requirement in the same second both read nothing standing and both compute
   * 1, and the unique constraint on the requirement and the ordinal refuses the second. The same
   * argument `accept/risk.ts` makes.
   */
  readonly ordinal: number;
  /**
   * Why the requirement does not apply, or why its check is off, in the customer's words.
   *
   * The reader is somebody else, months later, deciding whether this still holds — and an auditor asking
   * why a requirement left the score.
   */
  readonly reason: string;
  /** Who is answerable while this stands, which is often not who recorded it. */
  readonly owner: string;
  /**
   * When it starts standing. Now, ordinarily. A future date means the requirement is scored as usual
   * until then; a past one is refused.
   */
  readonly effectiveFrom: Date;
  /** When it stops standing, whatever else happens. */
  readonly expiresAt: Date;
  readonly recordedBy: string;
  readonly recordedAt: Date;
  /** The decision this renews, so how long the requirement has been excluded stays readable. */
  readonly supersedes?: string;
  /** Set once somebody ended it early. The record stays either way. */
  readonly revoked?: Revocation;
  /** The assessment this decision was recorded under. Absent means it named none. */
  readonly definitionId?: string;
}

/**
 * Where a decision stands, a function of its dates and the requirement's reading rather than a field.
 *
 * Derived for the reason a risk's standing is: a stored `expired` or `lapsed` would have to be written
 * by something that wakes up and looks, and a decision that stays effective because a sweep did not run
 * is a score held down by a cron failure.
 */
export type ApplicabilityStanding =
  /** Recorded, and its effective date has not arrived. The requirement is still scored as usual. */
  | 'pending'
  /** Effective, with its expiry comfortably ahead, and the reading does not contradict it. */
  | 'active'
  /** Effective, and its expiry is close enough that somebody has to decide again soon. */
  | 'expiring'
  /** Its expiry has passed. The requirement is back in the score and this says it was excluded. */
  | 'expired'
  /** Ended early, with a reason. */
  | 'revoked'
  /** Replaced by a later decision on the same requirement. */
  | 'superseded'
  /**
   * Effective by its dates, but the reading turned `fail` or `partial`. Set aside: it no longer takes
   * the requirement out of the denominator, and it is a prompt to look. The condition the exclusion was
   * written for has stopped being true, so the exclusion stops applying — without being deleted.
   */
  | 'lapsed';

export interface ApplicabilityStandingContext {
  readonly now?: Date;
  /**
   * True when a later decision on the same requirement replaced this one. Passed in rather than read
   * from the record, because being superseded is a fact about the set.
   */
  readonly superseded?: boolean;
  /**
   * The requirement's current reading, with in-force decisions on it set aside. Absent where the caller
   * has no scan to read — in which case a decision cannot lapse, because nothing says it should.
   */
  readonly reading?: Outcome;
}

export function standingOf(
  decision: ApplicabilityDecision,
  context: ApplicabilityStandingContext = {}
): ApplicabilityStanding {
  const now = context.now ?? new Date();

  // Terminal states first. Revoked before superseded: a revoked decision that was later replaced was
  // still revoked, and that is the fact somebody is looking for when they ask why the score changed.
  if (decision.revoked != null) return 'revoked';
  if (context.superseded === true) return 'superseded';
  if (decision.expiresAt.getTime() <= now.getTime()) return 'expired';
  if (decision.effectiveFrom.getTime() > now.getTime()) return 'pending';

  // Effective by its dates. A reading that has turned against it sets it aside before its expiry.
  if (context.reading != null && REFUSED_READINGS.includes(context.reading)) return 'lapsed';

  const remaining = decision.expiresAt.getTime() - now.getTime();
  return remaining <= DUE_WINDOW_DAYS * DAY_MS ? 'expiring' : 'active';
}

/**
 * Whether this decision takes the requirement out of the denominator.
 *
 * Only `active` and `expiring`. `pending` does not — the requirement is still scored until the effective
 * date. `expired` does not — that is what makes expiry mean something. `lapsed` does not — that is the
 * whole point of the lapse.
 */
export function effective(standing: ApplicabilityStanding): boolean {
  return standing === 'active' || standing === 'expiring';
}

/**
 * Whether the reader is owed a prompt about this one.
 *
 * `expiring`, `expired` and `lapsed`: a decision to make again, work that has silently come back, and a
 * reading that has turned against a standing exclusion.
 */
export function needsAttention(standing: ApplicabilityStanding): boolean {
  return standing === 'expiring' || standing === 'expired' || standing === 'lapsed';
}

export class InvalidApplicabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidApplicabilityError';
  }
}

/**
 * A submitted decision, before the parts only the server may decide are attached.
 *
 * No `recordedBy` and no dates of record: a client that could send them could attribute a decision to a
 * colleague.
 */
export interface ApplicabilityDraft {
  readonly controlId: string;
  readonly lever: ApplicabilityLever;
  readonly reason: string;
  readonly owner: string;
  readonly effectiveFrom: Date;
  readonly expiresAt: Date;
}

/**
 * A reading of one requirement, and where in the history it came from.
 *
 * `latest: false` means the most recent scan has no finding for this requirement and an earlier one did.
 * The outcome is that earlier scan's, and no field here says how much earlier — a sentence built on this
 * may say the reading was not the latest run's, and may not say when it was taken or which run took it.
 *
 * The flag is the whole of it: an absent finding was read as "nothing measured this requirement", which is
 * the case the lever exists for, and it is also what a targeted rerun leaves behind for every pillar it
 * could not carry forward. The refusal then saw no reading and admitted a requirement an earlier scan had
 * measured as failing.
 */
export interface MeasuredReading {
  readonly outcome: Outcome;
  readonly latest: boolean;
}

export interface ApplicabilityContext {
  readonly knownControl: (id: string) => boolean;
  /**
   * The requirement's severity, for the cap on how long a decision may run.
   *
   * Absent means the caller cannot say, and the term is then uncapped — the same tolerance
   * `accept/risk.ts` has, since a build that cannot read a severity has a worse problem than a long
   * exclusion.
   */
  readonly severityOf: (id: string) => Severity | undefined;
  /**
   * The requirement's reading, with every decision in force on it set aside, so the refusal reads the
   * underlying measurement rather than one a decision already softened. Absent means the caller has no
   * scan — the refusal cannot fire, and a decision recorded against an unmeasured requirement is exactly
   * the case the lever is for.
   */
  readonly reading: (id: string) => MeasuredReading | undefined;
  /** The decisions already recorded against this requirement, so a second effective one is refused. */
  readonly existing?: readonly ApplicabilityDecision[];
  readonly now?: Date;
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * One requirement per record rather than a list, the shape decision `accept/risk.ts` argues for: a
 * decision covering nine requirements has one reason for nine different exclusions and expires for all
 * nine on one day, so the ninth is reviewed on the schedule of the first.
 */
export function applicabilityFrom(body: unknown, context: ApplicabilityContext): ApplicabilityDraft {
  const raw = (body ?? {}) as Record<string, unknown>;
  const now = context.now ?? new Date();

  const controlId = text(raw.controlId);
  if (controlId == null) throw new InvalidApplicabilityError('Name the requirement, as controlId.');
  if (!context.knownControl(controlId)) {
    throw new InvalidApplicabilityError(`This framework has no requirement with the id ${controlId}.`);
  }

  const lever = leverFrom(raw.lever);

  // The refusal, read against the requirement rather than the outcome on the day. Set aside every
  // decision in force is the caller's job — the reading it hands back is the underlying one.
  const reading = context.reading(controlId);

  const already = alreadyDecided(context.existing ?? [], now, reading?.outcome);
  if (already != null) {
    throw new InvalidApplicabilityError(
      `${controlId} ${situation(already)}, recorded by ${already.decision.recordedBy} with ` +
        `${already.decision.owner} answerable. Two decisions on one requirement would expire on different days ` +
        'and neither would be the one in force. Revoke that one, or renew it when it expires.'
    );
  }

  if (reading != null && REFUSED_READINGS.includes(reading.outcome)) {
    // Which run read it, because an earlier run's reading is not what the estate reads now and the
    // sentence may not imply it is. What it does not say is when: nothing here carries that.
    const when = reading.latest
      ? `is reading ${reading.outcome}`
      : `was read as ${reading.outcome} by a run before the most recent one, which has no reading for it`;
    throw new InvalidApplicabilityError(
      `${controlId} ${when}: the requirement has been judged unmet, which is evidence it applies rather ` +
        'than that it does not. If you know and are living with it, accept the risk instead — with a ' +
        'compensating control, an owner and an expiry — so the failure stays in the score where a reader ' +
        'can see it.'
    );
  }

  const reason = reasonFrom(raw.reason);
  const owner = text(raw.owner);
  if (owner == null) {
    throw new InvalidApplicabilityError(
      'Name who is answerable while this stands, as owner. A requirement taken out of the score with nobody ' +
        'against it is the sentence audit findings die of.'
    );
  }

  const effectiveFrom = effectiveFromFor(raw.effectiveFrom, now);
  const expiresAt = expiryFor(raw.expiresAt, effectiveFrom, now, context.severityOf(controlId));

  return { controlId, lever, reason, owner, effectiveFrom, expiresAt };
}

/**
 * The decision as recorded, with who wrote it, when, and where it sits in the requirement's history.
 *
 * `previous` is every decision already recorded against this requirement. What this renews is the last
 * of them, derived here rather than taken from the request: a body that could name it could point a
 * renewal at somebody else's decision. The ordinal is their count, which is what the database refuses a
 * second write of.
 */
export function recorded(
  draft: ApplicabilityDraft,
  by: string,
  id: string,
  at: Date,
  previous: readonly ApplicabilityDecision[] = []
): ApplicabilityDecision {
  const supersedes = newestFirst(previous)[0]?.id;
  return {
    id,
    controlId: draft.controlId,
    lever: draft.lever,
    ordinal: previous.length + 1,
    reason: draft.reason,
    owner: draft.owner,
    effectiveFrom: draft.effectiveFrom,
    expiresAt: draft.expiresAt,
    recordedBy: by,
    recordedAt: at,
    ...(supersedes != null ? { supersedes } : {}),
  };
}

/**
 * The decision after somebody ended it early.
 *
 * A second version of the record rather than a new one, unlike a renewal: nothing about the decision
 * changed, it stopped. Revoking twice is refused rather than ignored, because the second revocation
 * would replace the first one's reason and date with its own.
 */
export function revoked(
  decision: ApplicabilityDecision,
  by: string,
  reason: string,
  at: Date
): ApplicabilityDecision {
  if (decision.revoked != null) {
    throw new InvalidApplicabilityError('This decision has already been revoked, and a revocation is not rewritten.');
  }
  const why = text(reason);
  if (why == null || why.length < MIN_PROSE) {
    throw new InvalidApplicabilityError(
      `Say why this is being revoked, in at least ${String(MIN_PROSE)} characters. This puts the requirement back ` +
        'into the score, and whoever reads the change is owed the reason.'
    );
  }
  return { ...decision, revoked: { by, at, reason: why } };
}

/**
 * The one decision on a requirement that is in force, where there is one.
 *
 * Newest first, and it takes the reading so a decision the reading has set aside is not returned as in
 * force. `applicabilityFrom` refuses a second effective decision, so in practice this finds the only
 * effective one.
 */
export function inForce(
  decisions: readonly ApplicabilityDecision[],
  reading: Outcome | undefined,
  now = new Date()
): ApplicabilityDecision | undefined {
  return newestFirst(decisions).find((decision) => effective(standingOf(decision, { now, reading })));
}

/** Decisions newest first, because the last one about a requirement is the one being read. */
export function newestFirst(decisions: readonly ApplicabilityDecision[]): readonly ApplicabilityDecision[] {
  return [...decisions].sort((a, b) => b.recordedAt.getTime() - a.recordedAt.getTime());
}

/**
 * A decision already standing, counting one that has not started yet and one the reading has set aside.
 *
 * `pending` counts, so a decision from today and one from next month are not both writable. `lapsed`
 * counts too, deliberately: a decision the reading has set aside is still on the record for this
 * requirement, and the way back is to revoke it and record afresh, not to write a second one beside it.
 */
function alreadyDecided(
  existing: readonly ApplicabilityDecision[],
  now: Date,
  reading: Outcome | undefined
): { readonly decision: ApplicabilityDecision; readonly standing: ApplicabilityStanding } | undefined {
  // With the reading, so `lapsed` is the standing this returns rather than one `standingOf` could not
  // reach. It counted before only because a lapsed decision reads as `active` when nothing passes the
  // reading in — the right answer for the wrong reason, and it made the refusal call a lapsed decision
  // an exclusion in force.
  for (const decision of newestFirst(existing)) {
    const standing = standingOf(decision, { now, ...(reading != null ? { reading } : {}) });
    if (standing === 'active' || standing === 'expiring' || standing === 'pending' || standing === 'lapsed') {
      return { decision, standing };
    }
  }
  return undefined;
}

/**
 * What the decision in the way is doing, in the refusal's own words.
 *
 * Per standing, because "is already excluded until X" was true of one of the three this refuses on. A
 * pending decision excludes nothing yet — the module says so itself, two hundred lines up — and a lapsed
 * one has stopped excluding, which is the state a reader is most likely to be trying to replace.
 */
function situation(already: {
  readonly decision: ApplicabilityDecision;
  readonly standing: ApplicabilityStanding;
}): string {
  const until = dayNamed(already.decision.expiresAt);
  if (already.standing === 'pending') {
    return `already has a decision recorded, taking effect ${dayNamed(already.decision.effectiveFrom)} and ` +
      `running to ${until}`;
  }
  if (already.standing === 'lapsed') {
    return `already has a decision recorded to ${until}, which this reading has set aside`;
  }
  return `is already excluded until ${until}`;
}

function leverFrom(raw: unknown): ApplicabilityLever {
  const supplied = text(raw);
  if (supplied == null || !LEVERS.includes(supplied as ApplicabilityLever)) {
    throw new InvalidApplicabilityError(`Say which lever, as lever, one of ${LEVERS.join(', ')}.`);
  }
  return supplied as ApplicabilityLever;
}

function reasonFrom(raw: unknown): string {
  const reason = text(raw);
  if (reason != null && EMPTY_ANSWERS.includes(reason.toLowerCase().replace(/[.\s]+$/, ''))) {
    throw new InvalidApplicabilityError(
      `A reason of “${reason}” says nothing a reviewer can check. Say why the requirement does not apply, or why ` +
        'its check is off, in a sentence somebody else can weigh months from now.'
    );
  }
  if (reason == null || reason.length < MIN_PROSE) {
    throw new InvalidApplicabilityError(
      `Say why this requirement is being taken out of the score, as reason, in at least ${String(MIN_PROSE)} ` +
        'characters. Whoever inherits this has to be able to judge whether it still holds.'
    );
  }
  return reason;
}

function effectiveFromFor(raw: unknown, now: Date): Date {
  const supplied = text(raw);
  if (supplied == null) return now;

  const from = new Date(supplied);
  if (Number.isNaN(from.getTime())) {
    throw new InvalidApplicabilityError('The effective date must be an ISO date, such as 2026-09-30.');
  }
  // A day's grace, because a form sending "today" as a midnight in the reader's own zone is sending a
  // date the server may already be past. Anything further back is a backdated exclusion, which is
  // refused.
  if (from.getTime() < now.getTime() - DAY_MS) {
    throw new InvalidApplicabilityError(
      'A decision cannot be backdated: a record effective from before today would claim the requirement was ' +
        'excluded during a period nothing recorded it. Leave the date out to start it from now.'
    );
  }
  return from;
}

/**
 * The expiry, capped by the requirement's severity.
 *
 * The cap is `longestAcceptanceDays`, the same table an acceptance is held to, because both answer "how
 * long may a statement about this requirement stand unexamined" — and this lever does strictly more to a
 * score than an acceptance does: an acceptance leaves the failure visible, and this takes the
 * requirement out of the denominator. Without the cap, a decision could be written until 2199, and
 * marking a critical requirement not applicable for a century is the way around the cap that the cap
 * exists for.
 */
function expiryFor(raw: unknown, effectiveFrom: Date, now: Date, severity: Severity | undefined): Date {
  const supplied = text(raw);
  if (supplied == null) {
    throw new InvalidApplicabilityError(
      'Give the date this decision ends, as expiresAt. A requirement excluded with no end date is a decision that ' +
        'becomes policy without anybody deciding it should.'
    );
  }

  const expiresAt = new Date(supplied);
  if (Number.isNaN(expiresAt.getTime())) {
    throw new InvalidApplicabilityError('The expiry must be an ISO date, such as 2026-09-30.');
  }
  if (expiresAt.getTime() <= now.getTime()) {
    throw new InvalidApplicabilityError('The expiry has to be in the future, or the decision has ended before it began.');
  }
  if (expiresAt.getTime() <= effectiveFrom.getTime()) {
    throw new InvalidApplicabilityError('The expiry has to be after the date this becomes effective.');
  }

  const cap = severity == null ? undefined : longestAcceptanceDays(severity);
  // Measured from now rather than from the effective date, for the reason `accept/risk.ts` gives: a
  // record dated to start in three months and end nine months after that leaves the requirement
  // unexamined for a year.
  if (cap != null && expiresAt.getTime() - now.getTime() > cap * DAY_MS) {
    throw new InvalidApplicabilityError(
      `A ${severity} requirement can be taken out of the score for at most ${String(cap)} days at a time, so ` +
        'this expiry is too far away. Choose a nearer one and renew it when it arrives — the point is that ' +
        'somebody looks again at whether it still does not apply.'
    );
  }

  return expiresAt;
}

/**
 * A date in a sentence a person reads, rather than the timestamp it is stored as.
 *
 * UTC, because the stored expiry is the end of a day in UTC and rendering it in the server's zone would
 * name the day after it west of Greenwich.
 */
function dayNamed(when: Date): string {
  return when.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}
