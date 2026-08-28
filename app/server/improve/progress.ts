// Where an action stands, once the estate has had its say.
//
// The same shape, and the same argument, as `decide/standing.ts`: an action is a set of statements
// somebody made on a date, a run is a measurement taken on a later one, and almost everything worth
// knowing comes from putting the two together. So this is a function of both rather than a field on
// the record. Nothing is written when a run disagrees with an action, because the run already says
// so, and a stored progress field would be a number that can drift from the actions under it.
//
// Two readings rather than one, and keeping them apart is the point.
//
// **What the estate says** is `Agreement`. An owner who has said the work is done is making a claim
// about a set of requirements, and the next run either agrees, disagrees, or could not tell. This is
// the reading that earns the feature: a fix that did not take, discovered here, is a fortnight rather
// than a quarter.
//
// **Whether it is late** is `Lateness`, and it has nothing to do with the estate. Folding the two
// into one word — the tempting move, since `decide/standing.ts` does fold its dates in — would make
// "overdue" and "contradicted" alternatives, and they are not: the worst action on a board is both.
//
// Neither reading moves the score. See the note at the top of `action.ts`, and ADR 0051.

import type { Finding, Outcome } from '../resolve/finding.js';
import { DAY_MS } from '../attest/attestation.js';
import type { ActionState, ImprovementAction } from './action.js';
import type { AdviceProvenance } from './advice.js';
import type { AdviceReading } from './advice-reading.js';

/**
 * How near a due date counts as due.
 *
 * A week, and deliberately not the thirty days an attestation renews inside (`DUE_WINDOW_DAYS`). The
 * two are answering the same question about different clocks: an attestation is due once a year, so
 * warning a month out leaves eleven months of quiet, while an action is often planned three weeks
 * ahead — and a thirty-day window would mark it due on the day it was agreed. A badge that is lit on
 * every row is furniture, and the first thing a reader learns is to stop seeing it.
 */
export const DUE_SOON_DAYS = 7;

/**
 * What the estate says about the requirements an action names.
 *
 * `unmeasured` is not a mild version of `contradicted`, and separating them is why the list is as long
 * as it is: a run that could not read a setting has not agreed with anything, and reporting that as
 * agreement would let an action be verified by the app losing a permission — the same trap
 * `standingOf` names for a fix claim. `unjudged` is the same argument about an action the assessment
 * was never asked about.
 */
export type Agreement =
  /** No claim has been made yet: the owner has not said the work is done. */
  | 'unclaimed'
  /** The owner says it is done, and no run has measured the requirements since. */
  | 'awaiting'
  /** Every requirement the action names is met, measured after the claim. The outcome to aim for. */
  | 'agreed'
  /** At least one is still unmet, measured after the claim. The loudest line on the board. */
  | 'contradicted'
  /** Nothing is unmet, and at least one could not be read. Not agreement. */
  | 'unmeasured'
  /**
   * The action names no requirement and nothing has read the estate again since.
   *
   * An action raised from an advisor finding is about a warehouse's size or a job's compute, and the
   * framework has no requirement that fails for either — so no assessment can speak to it, however
   * many run. What can is a later advisory, and `44c` made that reading: the four values above are
   * all reachable for one of these actions once an advisory later than the claim exists.
   *
   * This is what is left when none does. An install whose advisories are not kept, or one where
   * nobody has run the advisor since the work was claimed, has no measurement of any kind to offer,
   * and this says so. It is a fifth value rather than a weak `unmeasured`, which would report an
   * attempt that could not be read and so describe an attempt nobody made — and rather than `agreed`,
   * which is what the branches below answer on an empty set of requirements and is the one move the
   * action model exists to refuse.
   */
  | 'unjudged';

export type Lateness =
  /** No date to be late against: a draft, or an action that is finished either way. */
  | 'undated'
  | 'on-time'
  /** Its date is close. Worth raising before it passes rather than after. */
  | 'due'
  | 'overdue';

export interface ActionProgress {
  readonly action: ImprovementAction;
  readonly agreement: Agreement;
  readonly lateness: Lateness;
  /**
   * The requirements behind the agreement, so a reader can check it rather than take it.
   *
   * Named per outcome rather than counted, because "2 of 5 still failing" sends somebody to look for
   * which two, and the reading is worthless if the next step is a search.
   */
  readonly unmet: readonly string[];
  readonly unreadable: readonly string[];
  /**
   * What the latest advisory says about the finding this was raised from, where it was raised from one.
   *
   * Carried on every action that has advice, including the ones that also name requirements — where it
   * is beside the agreement rather than behind it. An action that answers both a requirement and a
   * finding is judged by the assessment, because that is the stronger of the two readings and the one
   * the framework is for; the advisor's reading is still worth showing, and a reader comparing them is
   * the point of keeping both.
   */
  readonly advice?: AdviceReading;
}

export interface AgreementContext {
  /**
   * The findings from the run being read, whichever run that is.
   *
   * Narrowed to the three fields this needs, as `StandingContext` narrows to one. A caller holding
   * findings passes them straight in; a caller with a summary's per-requirement outcomes does not have
   * to build whole findings to ask the question — and a caller without `attested` gets the reading
   * this had before human evidence was checked, which is why the field is part of the `Pick` rather
   * than a separate argument.
   */
  readonly findings?: readonly Pick<Finding, 'controlId' | 'outcome' | 'attested'>[];
  /** When that run finished. A run that predates the claim cannot speak to it. */
  readonly measuredAt?: Date;
  /**
   * What the latest advisory says about an action's advice, for the actions a scan cannot speak to.
   *
   * A function rather than a reading, because the reading is per action and this context is built once
   * per response: the caller holds one advisory and every action carries its own finding out of a
   * different one. Absent where this install keeps no advisories or has none — which is `unjudged`,
   * and is why that is still a value.
   */
  readonly adviceReading?: (advice: AdviceProvenance) => AdviceReading;
  readonly now?: Date;
}

/** Outcomes that mean the requirement is not currently a problem. The same set `standing.ts` uses. */
function met(outcome: Outcome): boolean {
  return outcome === 'pass' || outcome === 'satisfied-by-architecture' || outcome === 'not-applicable';
}

/**
 * Whether a met requirement is met on evidence that postdates the claim.
 *
 * The one place a finding's outcome is not the whole answer. Fifty-five requirements in this catalogue
 * are answered by somebody's word, and a run reports them as met because an attestation says so — so
 * an action claiming "we now review access quarterly", validated by a run that agreed on the strength
 * of an attestation from March, is verified by evidence recorded before the work started. That is what
 * AUD-DEC-107 means by refreshed attributed evidence, and it is why this reading and
 * `validate/attempt.ts` share the rule rather than each having their own.
 *
 * Only where the answer *carries* the outcome. An attestation recorded beside a measurement
 * (`bearing: 'record'`) is a note next to a fact the app established itself, and treating that as
 * stale human evidence would refuse the stronger of the two answers. An absent `attested` is the
 * ordinary case — the app measured it — and says nothing about staleness.
 *
 * Unmeasured rather than unmet, which is the important half: stale human evidence is not the estate
 * disagreeing with the claim, it is nobody having been asked since. `contradicted` would put it on the
 * board beside genuine regressions and send somebody to look at a system that is fine.
 */
function refreshed(finding: Pick<Finding, 'attested'>, claimedAt: Date | undefined): boolean {
  const attested = finding.attested;
  if (attested == null || attested.bearing !== 'outcome') return true;
  if (claimedAt == null) return true;
  return attested.at.getTime() >= claimedAt.getTime();
}

function unmet(outcome: Outcome): boolean {
  return outcome === 'fail' || outcome === 'partial';
}

/** The states in which nothing has been claimed about the estate. */
function unclaimed(state: ActionState): boolean {
  return state === 'draft' || state === 'planned' || state === 'in-progress' || state === 'blocked';
}

/**
 * When the claim was made, which is what a run has to be later than to speak to it.
 *
 * The date the action reached `ready-for-validation`, from the history, rather than the date it was
 * created or the date it was verified. A run between the work starting and the owner finishing it is
 * evidence about a half-done change, and reading it as a contradiction would make every action that
 * spans a scheduled scan look like a failed fix.
 *
 * The last such transition rather than the first: an action sent back for more work and offered again
 * is making a new claim, and the run that contradicted the first one has already had its say.
 */
function claimedAt(action: ImprovementAction): Date | undefined {
  const claims = action.history.filter((entry) => entry.to === 'ready-for-validation');
  return claims.length === 0 ? undefined : claims[claims.length - 1]?.at;
}

export function progressOf(action: ImprovementAction, context: AgreementContext = {}): ActionProgress {
  const now = context.now ?? new Date();
  const byControl = new Map((context.findings ?? []).map((finding) => [finding.controlId, finding]));

  const claimed = claimedAt(action);
  const since =
    claimed != null && context.measuredAt != null && context.measuredAt.getTime() > claimed.getTime();

  const outcomes = action.controlIds.map((id) => {
    const finding = byControl.get(id);
    return {
      id,
      outcome: finding?.outcome,
      // Met on evidence somebody gave before the work was claimed reads as unread rather than as met.
      // See `refreshed`.
      stale: finding != null && finding.outcome != null && met(finding.outcome) && !refreshed(finding, claimed),
    };
  });
  const unmetIds = outcomes.filter((entry) => entry.outcome != null && unmet(entry.outcome)).map((entry) => entry.id);
  const unreadable = outcomes
    .filter((entry) => entry.outcome == null || entry.stale || (!met(entry.outcome) && !unmet(entry.outcome)))
    .map((entry) => entry.id);

  const advice =
    action.advice != null && context.adviceReading != null ? context.adviceReading(action.advice) : undefined;

  return {
    action,
    agreement: agreementFor(action, {
      since,
      unmet: unmetIds,
      unreadable,
      ...(advice != null ? { advice } : {}),
      ...(claimed != null ? { claimedAt: claimed } : {}),
    }),
    lateness: latenessFor(action, now),
    unmet: unmetIds,
    unreadable,
    ...(advice != null ? { advice } : {}),
  };
}

/**
 * The agreement, decided in an order that puts the disagreement first.
 *
 * `cancelled` reads as `unclaimed` rather than as a fifth value, which is a judgement worth stating:
 * the action makes no claim about the estate, and the requirement it named is still measured by the
 * assessment itself. An action cancelled because the requirement was answered another way is not
 * evidence about anything, and a board that said "cancelled — agreed" would be inviting the reading
 * that cancelling counts as fixing.
 *
 * `verified` is read here like any other claimed state, and that is what answers the obvious question
 * about a terminal `verified`: an action a run agreed with in June, whose requirement fails again in
 * July, reads `contradicted`. The state records what happened — a run did agree, on a date, and the
 * history names it — and the agreement records what the estate says now. Moving the action back out of
 * `verified` instead would rewrite the record of a verification that genuinely occurred, and would add
 * a transition to somebody's history on every scan that disagreed.
 */
function agreementFor(
  action: ImprovementAction,
  reading: {
    readonly since: boolean;
    readonly unmet: readonly string[];
    readonly unreadable: readonly string[];
    readonly advice?: AdviceReading;
    readonly claimedAt?: Date;
  }
): Agreement {
  if (unclaimed(action.state) || action.state === 'cancelled') return 'unclaimed';
  // Before the run is looked at rather than after, and that ordering is the whole of it: an action
  // naming no requirement has nothing for a run to be later than, so every branch below would be
  // deciding on an empty set — and the last of them answers `agreed`.
  if (action.controlIds.length === 0) return advisedAgreement(reading.advice, reading.claimedAt);
  if (!reading.since) return 'awaiting';
  if (reading.unmet.length > 0) return 'contradicted';
  if (reading.unreadable.length > 0) return 'unmeasured';
  return 'agreed';
}

/**
 * The same four readings, taken from an advisory instead of a scan.
 *
 * The mapping is deliberately the assessment's own and not a softer version of it. A rule that fired
 * again is the estate disagreeing with the claim, which is `contradicted` and belongs on the board
 * beside a failing requirement. A rule that did not fire on a resource the run did read is `agreed`.
 * Everything else — a resource the run did not mention, an analysis it could not form, a rule this
 * build no longer has — is `unmeasured`, which is the value that exists for a measurement that was
 * attempted and could not be read, and `advice-reading.ts` is where each of those is refused.
 *
 * The claim date is checked here rather than in the reading because it is a fact about the action: the
 * reading knows whether the advisory is later than the *advice*, and only this knows whether it is
 * later than the day somebody said the work was done. An advisory in between measured a half-finished
 * change, which is the argument `validate/attempt.ts` opens with, and it holds identically here.
 */
function advisedAgreement(advice: AdviceReading | undefined, claimedAt: Date | undefined): Agreement {
  if (advice == null) return 'unjudged';
  if (claimedAt == null || advice.measuredAt.getTime() <= claimedAt.getTime()) return 'awaiting';
  if (advice.standing === 'still-firing') return 'contradicted';
  if (advice.standing === 'cleared') return 'agreed';
  return 'unmeasured';
}

/**
 * Whether the date has passed, for the states where a date still means something.
 *
 * A verified or cancelled action is `undated` however far past its date it is, because "overdue" on
 * finished work is a count nobody can act on and it would put every historical action permanently in
 * the worst bucket on the board.
 */
function latenessFor(action: ImprovementAction, now: Date): Lateness {
  if (action.state === 'verified' || action.state === 'cancelled') return 'undated';
  if (action.due == null) return 'undated';

  const remaining = action.due.getTime() - now.getTime();
  if (remaining <= 0) return 'overdue';
  return remaining <= DUE_SOON_DAYS * DAY_MS ? 'due' : 'on-time';
}

/**
 * Whether a run agrees with an action's claim, which is the question `verifiedBy` is asked after.
 *
 * Separate from `progressOf` so the code that moves an action to `verified` reads one predicate rather
 * than matching on a word, and so that the condition for writing the transition is the same condition
 * the reading shows. Two implementations of "the run agreed" is one more than the number that can be
 * right.
 */
export function agreed(action: ImprovementAction, context: AgreementContext): boolean {
  return progressOf(action, context).agreement === 'agreed';
}

/** Whether the reader is owed a prompt about this one. Contradiction first: it is the news. */
export function needsAttention(progress: ActionProgress): boolean {
  return progress.agreement === 'contradicted' || progress.lateness === 'overdue' || progress.action.state === 'blocked';
}

export interface PlanProgress {
  readonly planId: string;
  /** How many actions are in each state, so nothing is a percentage of an unstated denominator. */
  readonly states: Readonly<Record<ActionState, number>>;
  /** Actions whose claim the estate contradicts. The reason to read this rollup at all. */
  readonly contradicted: readonly string[];
  readonly overdue: readonly string[];
  readonly blocked: readonly string[];
  /**
   * Whether every action has reached a terminal state.
   *
   * Not "finished": a plan whose every action was cancelled is settled and has achieved nothing, and
   * a word that covered both would be the one quoted in a status report.
   */
  readonly settled: boolean;
  /** The nearest date anything in the plan is expected by, for a rollup that has to sort. */
  readonly nextDue?: Date;
}

/**
 * The plan's progress, which is a count of its actions and never a judgement about the plan.
 *
 * No percentage and no traffic light, deliberately. Five actions of which three are verified is not
 * 60% of an outcome — the remaining two are usually the hard ones — and a single figure over a plan
 * is the number that ends up in a slide with nothing underneath it. What is here instead is the three
 * lists somebody running the plan actually asks for, by id, plus the counts.
 */
export function planProgress(
  planId: string,
  actions: readonly ImprovementAction[],
  context: AgreementContext = {}
): PlanProgress {
  const mine = actions.filter((action) => action.planId === planId);
  const readings = mine.map((action) => progressOf(action, context));

  const states: Record<ActionState, number> = {
    draft: 0,
    planned: 0,
    'in-progress': 0,
    blocked: 0,
    'ready-for-validation': 0,
    verified: 0,
    cancelled: 0,
  };
  for (const action of mine) states[action.state] += 1;

  const live = mine.filter((action) => action.state !== 'verified' && action.state !== 'cancelled');
  const dates = live.map((action) => action.due).filter((due): due is Date => due != null);

  return {
    planId,
    states,
    contradicted: readings.filter((reading) => reading.agreement === 'contradicted').map((reading) => reading.action.id),
    overdue: readings.filter((reading) => reading.lateness === 'overdue').map((reading) => reading.action.id),
    blocked: mine.filter((action) => action.state === 'blocked').map((action) => action.id),
    settled: live.length === 0,
    ...(dates.length > 0
      ? { nextDue: new Date(Math.min(...dates.map((date) => date.getTime()))) }
      : {}),
  };
}
