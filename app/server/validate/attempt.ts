// Checking whether the work was actually done.
//
// The lifecycle in `improve/action.ts` ends in `verified` and refuses to let a person put it there.
// What it says instead, in as many words, is that until this module exists "the next run agreed" is
// the whole of the verification. That is the gap this closes, and it is worth being precise about what
// was wrong with it, because the difference is not obvious: a run agreeing is a coincidence of timing
// and a validation attempt is a question somebody asked.
//
// The difference has three parts, each of which is a defect in the version without it.
//
// **A run that happened to be next is not evidence about a claim.** A scheduled scan finishing an hour
// after somebody clicked "done" measures an estate that in most cases has not changed yet — the
// deploy is queued, the policy propagates overnight, the signal is computed over a thirty-day window
// that still contains the old behaviour. Reading that as agreement is how a fix gets confirmed before
// it lands. An attempt names the earliest run that can answer it, and says why.
//
// **A human-only requirement cannot be verified by human evidence that predates the work.** Fifty-five
// requirements in this catalogue are answered by somebody's word (`measurability: 'attestation'`), and
// a run reports them as met because an attestation says so. If that attestation is from March and the
// work was claimed in July, the run "agrees" with a fix using evidence recorded before it started.
// That is precisely what AUD-DEC-107 means by refreshed attributed evidence, and it is enforced here
// and in `improve/progress.ts` rather than described: an attested outcome older than the claim is not
// an answer to it.
//
// **Every attempt is kept, including the ones that failed.** An action verified at the fourth attempt
// is a different story from one verified at the first, and the three failures are the part a reader
// wants: they say what was tried, what the estate said, and how long it took to hold. Nothing here
// updates an earlier attempt, and nothing deletes one.
//
// Two things this deliberately does not do.
//
// It does not choose the method. Whether a requirement is answered by measurement or by somebody's
// word is a property of the requirement, taken from the catalogue when the attempt is requested. A
// requester who could choose would be able to validate a measurable requirement by attesting to it,
// which is the defect one layer down from the one this row exists to fix.
//
// It does not move the score, and it does not decide anything about a finding. A passed attempt is
// what permits `verifiedBy`; the requirement's outcome is whatever the run measured, before and after.

import type { Measurability } from '../catalogue/catalogue.js';
import type { ImprovementAction } from '../improve/action.js';

/**
 * How one requirement in an attempt can be answered.
 *
 * Two values, from the catalogue rather than from the requester. `attested` is the one that carries
 * a rule of its own — see the freshness requirement in `answeredBy` — and it exists as a separate
 * word here so that the rule has something to be attached to rather than being a condition buried in
 * a comparison.
 */
export type AttemptMethod =
  /** The app reads it. A run measuring the requirement met, after the window, answers it. */
  | 'measured'
  /**
   * Somebody says it. A run reports it met because an attestation does, so the attestation itself has
   * to be newer than the claim being validated.
   */
  | 'attested';

export interface AttemptCheck {
  readonly controlId: string;
  readonly method: AttemptMethod;
}

/** Which method answers a requirement, from what the catalogue says about it. */
export function methodFor(measurability: Measurability): AttemptMethod {
  return measurability === 'attestation' ? 'attested' : 'measured';
}

export type AttemptResult =
  /** Every requirement was met, with evidence that postdates the claim. The only result that verifies. */
  | 'passed'
  /** At least one was still unmet. The action goes back to work, and this record says why. */
  | 'failed'
  /**
   * Nothing was unmet and the attempt could not be completed: something unreadable, human evidence
   * not refreshed, or a claim withdrawn before a run could answer.
   *
   * Not a mild failure and not a near-pass. `improve/progress.ts` keeps `unmeasured` apart from
   * `contradicted` for the same reason: an attempt the app could not finish says nothing about the
   * estate, and reading it either way is a lie in one direction or the other.
   */
  | 'incomplete';

export interface AttemptAnswer {
  readonly result: AttemptResult;
  /**
   * The run that answered it.
   *
   * Absent only where nothing measured it — a claim withdrawn while the attempt was outstanding. An
   * answer with a result and no run is therefore always `incomplete`, which `answeredBy` and
   * `abandoned` are the only two producers of.
   */
  readonly scanId?: string;
  readonly at: Date;
  /** The requirements that were still unmet, by id, so the result can be checked rather than taken. */
  readonly unmet: readonly string[];
  /**
   * The requirements that could not be read, or whose human evidence was not refreshed.
   *
   * One list rather than two, and the reason is what a reader does next: both mean the attempt has no
   * answer for that requirement, and `why` names which kind it was in the sentence beside it.
   */
  readonly unreadable: readonly string[];
  /** Why it is incomplete, in the app's words. Absent on a pass or a fail, which speak for themselves. */
  readonly why?: string;
}

export interface ValidationAttempt {
  readonly id: string;
  /**
   * The plan, copied from the action.
   *
   * So an attempt ages with the plan it belongs to, as an action does. Retention reads the plan's date
   * for all three, because an attempt swept out from under a verified action would leave a
   * verification citing evidence nobody can find.
   */
  readonly planId: string;
  readonly actionId: string;
  /**
   * The requirements this attempt checks and how each is answered, as at the request.
   *
   * Copied rather than read from the action when the answer arrives. An action's requirements cannot
   * change once it has left `draft`, so the copy will usually agree — but the attempt is the record of
   * what was checked, and a record that resolves its own subject through another mutable record is a
   * record of whatever that one says today.
   */
  readonly checks: readonly AttemptCheck[];
  /**
   * When the owner said the work was done, from the action's history.
   *
   * The line everything here is measured against: a run before it saw a half-finished change, and an
   * attestation before it was given about the practice as it was. Copied for the reason `checks` is,
   * and because an action sent back and offered again makes a new claim that needs its own attempt.
   */
  readonly claimedAt: Date;
  readonly requestedBy: string;
  readonly requestedAt: Date;
  /**
   * The earliest run that may answer this, and how many days that is from the request.
   *
   * Both, rather than the date alone, because the number is the thing a reader is judging — "we gave
   * it three days" is a defensible sentence and a bare date is not.
   */
  readonly observeFrom: Date;
  readonly observeDays: number;
  /** The answer, once something answered it. Absent means outstanding. */
  readonly answer?: AttemptAnswer;
}

export class InvalidAttemptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidAttemptError';
  }
}

/**
 * The longest a validation may be told to wait before anything can answer it.
 *
 * Ninety days, which is far longer than any propagation delay and is not the number's purpose: it is
 * a bound on a field that would otherwise let somebody park a claim indefinitely while the action sat
 * in `ready-for-validation` looking like work in hand. A window that long is visible in the record and
 * has to be justified to whoever reads it, which is the useful part.
 */
export const MAX_OBSERVE_DAYS = 90;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AttemptDraft {
  readonly planId: string;
  readonly actionId: string;
  readonly checks: readonly AttemptCheck[];
  readonly claimedAt: Date;
  readonly observeDays: number;
}

export interface AttemptContext {
  /** What the catalogue says about a requirement, or undefined where it has none. */
  readonly measurabilityOf: (controlId: string) => Measurability | undefined;
  /** Attempts already made against this action, so an outstanding one refuses a second. */
  readonly existing: readonly ValidationAttempt[];
}

/**
 * Why a validation of this action cannot be asked for, or undefined while it can be.
 *
 * The same four checks `draftFrom` refuses on, in one function that returns prose rather than throwing,
 * because both callers want the same sentences and only one of them wants an exception. A surface
 * showing an action needs to know whether to offer the button and what to say instead — and a second
 * copy of these rules in the client would be a button that offers what the server refuses.
 */
export function whyNotRequestable(action: ImprovementAction, context: AttemptContext): string | undefined {
  if (action.state !== 'ready-for-validation') {
    return (
      `Validation checks a claim that the work is done, and this action is ${action.state}. ` +
      (action.state === 'verified'
        ? 'It has already been verified by a run.'
        : 'Its owner has not said it is finished yet.')
    );
  }

  if (claimedAtOf(action) == null) {
    // Only reachable through a record written by something other than `moved`, which appends the
    // transition. Refused rather than dated now: an attempt measured against this moment would accept
    // any run and any attestation, which is the failure this module exists to stop.
    return (
      'This action is ready for validation but its history does not record when that was claimed, so there ' +
      'is no date for the evidence to be newer than. Move it back to in progress and offer it again.'
    );
  }

  const outstanding = outstandingIn(context.existing);
  if (outstanding != null) {
    return (
      `A validation of this action is already outstanding, waiting for a run after ` +
      `${outstanding.observeFrom.toISOString()}. Two would be answered by the same run and neither would be ` +
      'the claim. Wait for it, or withdraw the claim and offer the work again.'
    );
  }

  if (action.controlIds.length === 0) {
    // An action raised from an advisor finding, which names a warehouse or a job rather than a
    // requirement. Refused here because the answer this module computes from an empty set of checks is
    // `passed`: no requirement was measured as failing, none was unreadable, and the action would be
    // written `verified` by a run that read nothing about it — which is verification on its owner's
    // word, wearing a run's name. `progress.ts` reports the same action `unjudged` for the same reason.
    return (
      'This action names no requirement — it was raised from an advisor finding, and the framework has no ' +
      'requirement that a run could answer for it. A later advisory is what says whether the advice still ' +
      'fires. Name a requirement this work also answers if there is one, and offer it again.'
    );
  }

  const unknown = action.controlIds.filter((id) => context.measurabilityOf(id) == null);
  if (unknown.length > 0) {
    return (
      `This framework no longer has ${unknown.join(', ')}, which this action names, so a run cannot answer for ` +
      'it. The requirement was withdrawn from the catalogue: cancel the action with that as the reason.'
    );
  }

  return undefined;
}

/**
 * A draft from an action and an untrusted body, or an error naming what is wrong.
 *
 * The action rather than an id, because every field but the window comes from it and a request that
 * could name its own requirements would be a request to validate something else. What the body
 * supplies is one number.
 */
export function draftFrom(action: ImprovementAction, body: unknown, context: AttemptContext): AttemptDraft {
  const refusal = whyNotRequestable(action, context);
  if (refusal != null) throw new InvalidAttemptError(refusal);

  // Non-null: an action with no claim in its history was refused above.
  const claimedAt = claimedAtOf(action) as Date;

  return {
    planId: action.planId,
    actionId: action.id,
    checks: action.controlIds.map((controlId) => ({
      controlId,
      // Non-null: the unknown ones were refused above.
      method: methodFor(context.measurabilityOf(controlId) as Measurability),
    })),
    claimedAt,
    observeDays: observeDaysFrom(body),
  };
}

/** The attempt as requested, with who asked and when. */
export function requested(draft: AttemptDraft, by: string, id: string, at: Date): ValidationAttempt {
  return {
    id,
    planId: draft.planId,
    actionId: draft.actionId,
    checks: draft.checks,
    claimedAt: draft.claimedAt,
    requestedBy: by,
    requestedAt: at,
    observeFrom: new Date(at.getTime() + draft.observeDays * DAY_MS),
    observeDays: draft.observeDays,
  };
}

/** The one attempt still waiting for an answer, where there is one. */
export function outstandingIn(attempts: readonly ValidationAttempt[]): ValidationAttempt | undefined {
  return attempts.find((attempt) => attempt.answer == null);
}

/** The attempts against one action, newest first, because the last one is the one being read. */
export function newestFirst(attempts: readonly ValidationAttempt[]): readonly ValidationAttempt[] {
  return [...attempts].sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime());
}

/**
 * When the owner last said the work was done.
 *
 * The last such transition rather than the first, for the reason `improve/progress.ts` gives: an
 * action sent back for more work and offered again is making a new claim, and the run that
 * contradicted the first one has already had its say.
 */
export function claimedAtOf(action: ImprovementAction): Date | undefined {
  const claims = action.history.filter((entry) => entry.to === 'ready-for-validation');
  return claims.length === 0 ? undefined : claims[claims.length - 1]?.at;
}

/** What a run says about one requirement, which is all this module needs of a finding. */
export interface Observation {
  readonly controlId: string;
  /** Absent where the run did not measure this requirement at all. */
  readonly outcome?: 'pass' | 'fail' | 'partial' | 'unmeasurable' | 'not-applicable' | 'satisfied-by-architecture';
  /**
   * When the human answer behind this outcome was given, where a person's answer is what decided it.
   *
   * Absent means no answer decided it: either the app measured it, or an attestation is recorded
   * beside a measurement rather than carrying it (`AttestedFact.bearing === 'record'`). Absence
   * therefore cannot be read as stale evidence, only as evidence that is not a person's word.
   */
  readonly attestedAt?: Date;
}

export interface RunReading {
  readonly scanId: string;
  /** When the run finished, which is what has to be after the window and after the claim. */
  readonly measuredAt: Date;
  readonly observations: readonly Observation[];
}

/**
 * Whether this run is allowed to answer this attempt.
 *
 * Two conditions and they are not the same one: after the claim, because a run before it measured a
 * half-finished change, and after the window, because that is the delay somebody asked for on the
 * grounds that the estate would not show the change yet. A run in between is a real measurement of an
 * estate that has not caught up, and reading it as a failed validation is how a correct fix gets
 * reported as one that did not take.
 */
export function answerable(attempt: ValidationAttempt, run: Pick<RunReading, 'measuredAt'>): boolean {
  if (attempt.answer != null) return false;
  return (
    run.measuredAt.getTime() >= attempt.observeFrom.getTime() &&
    run.measuredAt.getTime() > attempt.claimedAt.getTime()
  );
}

/**
 * The attempt after a run answered it.
 *
 * The order of the three results is the argument. Unmet first, because a requirement the run says is
 * still failing is the answer whatever else is true of the others — an attempt that reported
 * `incomplete` while one of its requirements was measured as failing would be hiding the news behind
 * the bookkeeping. Then unreadable, which includes human evidence that was not refreshed. A pass is
 * what is left, and it is the only result that has nothing to explain.
 */
export function answeredBy(attempt: ValidationAttempt, run: RunReading): ValidationAttempt {
  if (attempt.answer != null) {
    throw new InvalidAttemptError('This validation has already been answered, and an answer is not rewritten.');
  }
  if (!answerable(attempt, run)) {
    throw new InvalidAttemptError(
      `This run finished at ${run.measuredAt.toISOString()}, which is before this validation can be answered: ` +
        `the claim was made at ${attempt.claimedAt.toISOString()} and the observation window runs to ` +
        `${attempt.observeFrom.toISOString()}.`
    );
  }

  if (attempt.checks.length === 0) {
    // Unreachable through `draftFrom`, which refuses an action naming no requirement, and here anyway
    // because this is where a pass is computed: the loop below finds nothing unmet and nothing
    // unreadable, and every empty attempt would answer `passed`. Loud rather than silent, since a
    // record that could reach this was written by something other than this module.
    throw new InvalidAttemptError(
      'This validation checks no requirement, so no run can answer it. An attempt with nothing to measure ' +
        'would read as passed while measuring nothing.'
    );
  }

  const seen = new Map(run.observations.map((observation) => [observation.controlId, observation]));
  const unmet: string[] = [];
  const unreadable: string[] = [];
  const stale: string[] = [];

  for (const check of attempt.checks) {
    const observation = seen.get(check.controlId);
    const outcome = observation?.outcome;

    if (outcome === 'fail' || outcome === 'partial') {
      unmet.push(check.controlId);
      continue;
    }
    if (outcome == null || outcome === 'unmeasurable') {
      unreadable.push(check.controlId);
      continue;
    }
    // Met, so the only question left is whether the evidence for it postdates the claim. It can only
    // fail to for an attested requirement: everything else was measured by this run, and this run is
    // after the claim by the check above.
    if (check.method === 'attested' && !refreshed(observation, attempt.claimedAt)) {
      stale.push(check.controlId);
      unreadable.push(check.controlId);
    }
  }

  return {
    ...attempt,
    answer: {
      result: unmet.length > 0 ? 'failed' : unreadable.length > 0 ? 'incomplete' : 'passed',
      scanId: run.scanId,
      at: run.measuredAt,
      unmet,
      unreadable,
      ...(unmet.length === 0 && unreadable.length > 0
        ? { why: whyIncomplete(unreadable, stale) }
        : {}),
    },
  };
}

/**
 * Whether the human evidence behind a met requirement was given after the claim.
 *
 * An absent date is not stale — see `Observation.attestedAt`. It means nothing about this outcome
 * rested on somebody's word, which for a requirement the catalogue marks as attestation-only happens
 * when the app measured it after all, or when the answer is recorded beside a measurement rather than
 * carrying it. Both are stronger evidence than an attestation, so refusing them would be refusing the
 * better answer.
 */
function refreshed(observation: Observation | undefined, claimedAt: Date): boolean {
  const at = observation?.attestedAt;
  return at == null || at.getTime() >= claimedAt.getTime();
}

/**
 * Why an attempt could not be finished, naming the two kinds separately.
 *
 * They read the same in a list of ids and they are different problems with different next steps: one
 * is the app not being able to see something, the other is a colleague needing to answer again. A
 * single sentence about "requirements that could not be read" would send somebody to check a
 * permission that is not the issue.
 */
function whyIncomplete(unreadable: readonly string[], stale: readonly string[]): string {
  const unread = unreadable.filter((id) => !stale.includes(id));
  const parts: string[] = [];

  if (unread.length > 0) {
    parts.push(
      `this run could not read ${unread.join(', ')}, so it cannot say whether the work landed`
    );
  }
  if (stale.length > 0) {
    parts.push(
      `${stale.join(', ')} ${stale.length === 1 ? 'is answered' : 'are answered'} by somebody's word, and the ` +
        'answer on record was given before this work was claimed — it says what was true beforehand. Somebody ' +
        'has to attest to it again'
    );
  }

  return `${parts.join('; and ')}.`;
}

/**
 * The attempt after the claim it was testing went away.
 *
 * An owner who withdraws a claim — realising they tested the wrong workspace, say — leaves an attempt
 * waiting for a run to answer a question nobody is asking. It is closed as `incomplete` with no run,
 * rather than deleted, because the fact that somebody offered work for validation and took it back is
 * part of the story of the action, and a board that showed nothing would show four attempts where
 * there had been five.
 */
export function abandoned(attempt: ValidationAttempt, why: string, at: Date): ValidationAttempt {
  if (attempt.answer != null) {
    throw new InvalidAttemptError('This validation has already been answered, and an answer is not rewritten.');
  }

  return {
    ...attempt,
    answer: {
      result: 'incomplete',
      at,
      unmet: [],
      unreadable: attempt.checks.map((check) => check.controlId),
      why,
    },
  };
}

/** Whether this attempt is what permits an action to become verified. Nothing else does. */
export function verifies(attempt: ValidationAttempt): boolean {
  return attempt.answer?.result === 'passed';
}

/**
 * The window from an untrusted body: a whole number of days, none by default.
 *
 * Zero by default rather than a guess at a propagation delay, and that is a decision worth naming
 * because it is the weaker half of this module. The right default would come from how each signal is
 * computed — a setting read straight from an API is true the moment it is changed, while a rate
 * computed over a thirty-day lookback still contains a month of the old behaviour and cannot support
 * a fix claim for a month. This app does not record which of its signals are windowed, so the choice
 * is between a default that is wrong for one kind and a default of nothing plus a field the requester
 * can set. Nothing is the honest one: a validation answered too early reports `failed`, which sends
 * somebody to look, and a window invented on their behalf would report `passed` late without anybody
 * knowing why they waited.
 */
function observeDaysFrom(body: unknown): number {
  const raw = (body ?? {}) as Record<string, unknown>;
  if (raw.observeDays == null) return 0;

  const days = typeof raw.observeDays === 'number' ? raw.observeDays : Number(raw.observeDays);
  if (!Number.isFinite(days) || !Number.isInteger(days)) {
    throw new InvalidAttemptError('The observation window has to be a whole number of days, as observeDays.');
  }
  if (days < 0) {
    throw new InvalidAttemptError('An observation window cannot be negative. Leave it out to accept the next run.');
  }
  if (days > MAX_OBSERVE_DAYS) {
    throw new InvalidAttemptError(
      `The longest observation window is ${String(MAX_OBSERVE_DAYS)} days. A claim waiting longer than that is ` +
        'work in hand that nothing is measuring — withdraw it and offer it again when the estate will show the change.'
    );
  }
  return days;
}
