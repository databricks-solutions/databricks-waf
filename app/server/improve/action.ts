// A finding that has become somebody's work.
//
// The app can already say what is wrong, how to fix it, and what somebody decided to do about it.
// What it cannot say is who is doing which of those fixes, by when, with what "done" means, and
// whether the thing they said they would do is the thing the estate ended up agreeing with. That
// work happens today in a spreadsheet or a Jira board, and the cost is not inconvenience: it is that
// the evidence and the work drift apart. A remediation programme managed beside the assessment
// reports progress against its own list, and nothing holds that list to the run that produced it.
//
// A decision (see `decide/decision.ts`) is one sentence about one requirement — accept, defer, claim
// fixed, put back. That is deliberately small, and it is not a plan: it has no owner beyond the
// person answerable for the consequence, no steps, no dependency on anything else, and no definition
// of what would count as finished. An action is the larger thing, and the fields it adds are the
// ones a programme is run from rather than the ones an auditor reads.
//
// Four rules shape everything below, and each of them is a decision that could have gone the other
// way.
//
// **An action cannot move the score.** The same rule decisions live under, for the same reason.
// Planning to fix a requirement does not fix it, so a requirement with a beautifully specified
// action against it keeps failing, keeps costing its points, and keeps appearing in the export. What
// an action changes is who is doing what, and nothing else. A number that improved because somebody
// wrote a plan would be measuring paperwork, and this app would be the tool that rewards writing
// plans.
//
// **Nobody may declare their own work verified.** The lifecycle ends in `verified`, and the audit
// that asked for this lifecycle also asked, separately, for a validation workflow — because "claimed
// fixed" and "verified" being the same state is exactly the defect. So `verified` is not a state a
// person can set here. An owner's last word is `ready-for-validation`; the transition past it is
// made by the app, citing the run that agreed, through the same reasoning `decide/standing.ts` uses
// to settle a fix claim. Until the validation attempt records of `B2` exist, "the next run agreed"
// is the whole of the verification, and saying so is better than a button that means less than it
// looks like.
//
// **An action nobody can judge finished is not planned work.** A definition of done is required
// before an action may leave `draft`. This refuses something people will want to do — file the
// intention now, work out what done means later — and it refuses it because the alternative is a
// board of actions that can never be closed except by assertion, which is the state the spreadsheet
// was already in.
//
// **A dependency is a claim about order, not an excuse.** Depending on another action does not block
// a transition, because a rule that stopped an owner starting work would be a rule they route around
// by deleting the dependency. What is refused is a cycle, which is not a statement about order at
// all.
//
// ADR 0051.

import type { Severity } from '../resolve/finding.js';
import { ADVISORS, type AdviceProvenance, type AdviceReference, type Advisor } from './advice.js';

/**
 * The seven states an action moves through, and the only seven.
 *
 * From AUD-DEC-113, and the shape is worth reading as a sentence rather than a list: an action is
 * drafted, planned, worked on, possibly blocked, handed over for validation, and either verified or
 * cancelled. `blocked` is beside `in-progress` rather than after it because being blocked is not
 * progress, and an owner who has to move backwards to record a blocker will not record it.
 *
 * `cancelled` is terminal and `verified` is terminal, and they are the only two. An action that
 * turns out to be unnecessary is cancelled with a reason rather than deleted, because the fact that
 * somebody planned it and then decided against it is part of the record of what was considered.
 */
export type ActionState =
  /** Being written. Nothing is claimed about it, and it is not work anybody has taken on. */
  | 'draft'
  /** Agreed work with an owner, a definition of done and a date. Not started. */
  | 'planned'
  /** Somebody is doing it. */
  | 'in-progress'
  /** Stopped on something outside the owner's control, which is recorded rather than implied. */
  | 'blocked'
  /** The owner says the work is done. The estate has not agreed yet. */
  | 'ready-for-validation'
  /** A run measured every requirement this action names as met, after the owner said it was done. */
  | 'verified'
  /** Decided against, with a reason. Terminal, and kept. */
  | 'cancelled';

export const ACTION_STATES: readonly ActionState[] = [
  'draft',
  'planned',
  'in-progress',
  'blocked',
  'ready-for-validation',
  'verified',
  'cancelled',
];

/**
 * Where an action may go from where it is, and who is allowed to take it there.
 *
 * A table rather than a chain of `if`s, because the interesting property of a lifecycle is the moves
 * it refuses and those are invisible in imperative code. `by` is the part that carries the argument:
 * `person` is a move an owner makes, `run` is a move only a measurement makes, and the two are
 * different columns so that no route can accidentally offer the second.
 */
interface Move {
  readonly to: ActionState;
  readonly by: 'person' | 'run';
}

const MOVES: Readonly<Record<ActionState, readonly Move[]>> = {
  draft: [
    { to: 'planned', by: 'person' },
    { to: 'cancelled', by: 'person' },
  ],
  planned: [
    { to: 'in-progress', by: 'person' },
    { to: 'blocked', by: 'person' },
    // Back to draft, because agreeing work and then finding the definition of done was wrong is
    // ordinary. Without it the only way to revise an agreed action is to cancel it and lose the
    // history, which is how a board fills up with cancelled duplicates.
    { to: 'draft', by: 'person' },
    { to: 'cancelled', by: 'person' },
  ],
  'in-progress': [
    { to: 'ready-for-validation', by: 'person' },
    { to: 'blocked', by: 'person' },
    { to: 'cancelled', by: 'person' },
  ],
  blocked: [
    { to: 'in-progress', by: 'person' },
    { to: 'cancelled', by: 'person' },
  ],
  'ready-for-validation': [
    // The only `run` move in the table, and the reason the column exists.
    { to: 'verified', by: 'run' },
    // Validation failing sends it back to work, which is AUD-DEC-113's own wording. A person may
    // also withdraw the claim: an owner who realises they tested the wrong workspace should be able
    // to say so without waiting for a run to contradict them.
    { to: 'in-progress', by: 'person' },
    { to: 'blocked', by: 'person' },
    { to: 'cancelled', by: 'person' },
  ],
  verified: [],
  cancelled: [],
};

/** The states from which a person can move an action, for a form that has to render buttons. */
export function movesFor(state: ActionState): readonly ActionState[] {
  return MOVES[state].filter((move) => move.by === 'person').map((move) => move.to);
}

/**
 * How much work this is, in the only units that survive being compared across teams.
 *
 * Deliberately not hours or story points. An hour estimate invites a schedule the app cannot keep,
 * and points are a local currency — one team's 5 is another's 2, and a report that adds them up is
 * arithmetic on a unit that does not exist. Four sizes, each defined by what it means for who does
 * it, so the only claim being made is about relative size within one estate.
 */
export type Effort =
  /** One person, one sitting. A setting flipped, a tag added. */
  | 'small'
  /** One person, several days. A change with a rollout, or one that needs somebody's approval. */
  | 'medium'
  /** More than one team, or a change that has to be staged. Weeks. */
  | 'large'
  /** Needs a project of its own. Recorded so it stops being confused with the ones above. */
  | 'programme';

export const EFFORTS: readonly Effort[] = ['small', 'medium', 'large', 'programme'];

/**
 * How much this matters, which is not the same as how bad the finding is.
 *
 * A requirement's severity is a property of the framework; the priority of the work is a judgement
 * about this estate, this quarter. They usually agree, and where they do not the disagreement is the
 * interesting part — an informational finding a customer treats as urgent is telling you something
 * about their business that the catalogue does not know. So it is a separate field, and `priorityFor`
 * only suggests a starting point.
 */
export type Priority = 'now' | 'next' | 'later';

export const PRIORITIES: readonly Priority[] = ['now', 'next', 'later'];

/** A starting point from the requirement's severity, which the owner is free to overrule. */
export function priorityFor(severity: Severity): Priority {
  if (severity === 'critical' || severity === 'high') return 'now';
  if (severity === 'medium') return 'next';
  return 'later';
}

/**
 * One step of the work, in the owner's words.
 *
 * A list of strings rather than sub-actions with their own states. Steps are how somebody hands the
 * work to a colleague, and a step with a lifecycle is an action — at which point the thing that
 * needs a definition of done is the step, and the tree goes down for ever. Where a step really is
 * separate work, it is a separate action with a dependency.
 */
export type Step = string;

export interface ImprovementAction {
  readonly id: string;
  readonly planId: string;
  /**
   * The requirements this action is about, by catalogue id.
   *
   * Requirement ids rather than finding ids, and that is a constraint rather than a shortcut: a
   * finding belongs to a run, so an action naming one would be an action about a measurement taken
   * on a Tuesday. The requirement is the thing that stays the same across runs, which is what makes
   * "did the next run agree" a question with an answer. The run the action was raised from is kept
   * separately, as provenance.
   *
   * More than one, because a single change often answers several requirements and splitting it into
   * one action per requirement produces a board where four rows are the same afternoon's work.
   *
   * Empty only on an action raised from advice. See `advice`, and `progress.ts` for what an action
   * with nothing measurable under it reads as.
   */
  readonly controlIds: readonly string[];
  /**
   * The advisor finding this was raised from, as the record said it at the time.
   *
   * The optimisation advisors do not answer requirements — a warehouse that is the wrong size fails
   * nothing in the framework — so an action raised from one names no `controlId`, and this is what it
   * has instead. Assembled by the server from the stored advisory rather than accepted from a client;
   * `advice.ts` says why, and what each of the four fields is for.
   *
   * Frozen, like the rest of what an action is about. The advisor's opinion changes every run, and
   * provenance that moved with it would leave every action describing the latest advice rather than
   * the advice somebody acted on.
   */
  readonly advice?: AdviceProvenance;
  /** What changes for the business when this is done, in outcome terms rather than task terms. */
  readonly outcome: string;
  /**
   * What would have to be true for this to be finished, written before the work starts.
   *
   * The field this whole module is built around. It is checked by a person, not by the app — the
   * app's own opinion arrives later, as the run that agrees or does not — and it is required before
   * an action may be planned, because an action nobody can judge finished cannot be finished, only
   * abandoned or asserted.
   */
  readonly definitionOfDone: string;
  /** The Databricks user or group answerable for doing it. */
  readonly owner: string;
  readonly priority: Priority;
  readonly effort: Effort;
  /** When the owner expects it done. Absent while an action is still a draft. */
  readonly due?: Date;
  readonly steps: readonly Step[];
  /** Other actions in the same plan that have to happen first. */
  readonly dependsOn: readonly string[];
  readonly state: ActionState;
  /** The run this was raised from, so the evidence behind it can still be found. */
  readonly raisedFrom?: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  /**
   * Every state this action has been in, oldest first, append-only.
   *
   * Kept rather than derived because the record of what somebody said and when is the point: an
   * action that spent three weeks blocked on a change window is a different story from one that was
   * planned and verified on the same afternoon, and a single `state` field tells neither.
   */
  readonly history: readonly Transition[];
  /**
   * Which version of this action this is: 0 as raised, and one higher for every change since.
   *
   * Not the length of the history, which is what this was first: a correction — a new owner, a date
   * that slipped — changes the record without being a transition, and a revision derived from the
   * history would have made every one of those a write at a revision already taken. The store would
   * have reported the author's own edit as somebody else's race, which is the worst kind of wrong
   * answer: it is about a concurrency problem that did not happen.
   */
  readonly revision: number;
}

export interface Transition {
  readonly from: ActionState;
  readonly to: ActionState;
  readonly at: Date;
  /**
   * Who moved it: an identity for a person's move, or the record's id for a measurement's.
   *
   * One field rather than two nullable ones, with `by` naming which kind it is, because a row where
   * both are empty is a transition nobody can attribute and the type should not permit it.
   *
   * Three values where the table below has two, and the extra one is not a widening of what may move
   * an action. `MOVES` answers whether a person may make the move and reads `run` for every move only
   * a measurement makes; this answers which measurement, because `who` is an id and a reader told
   * `run 6f2a…` will look for it among the scans. An advisory is the other kind of run, and an action
   * raised from advisor advice is settled by one — see `advice-reading.ts`.
   */
  readonly by: 'person' | 'run' | 'advisor';
  readonly who: string;
  /** Why, where the move is one that needs a reason. See `needsReason`. */
  readonly reason?: string;
}

export class InvalidActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidActionError';
  }
}

/** The shortest definition of done, outcome or reason worth recording. Below this it is a label. */
export const MIN_PROSE = 20;

/**
 * The moves that mean nothing without a sentence beside them.
 *
 * Both are moves away from the work happening: blocked is a claim about somebody else, and cancelled
 * is a decision that the requirement is not going to be answered this way. Each is the kind of thing
 * a colleague inherits and cannot interpret. The moves *towards* work — planned, in progress, ready
 * — do not need one, because the state itself is the whole statement and demanding prose for every
 * move is how a lifecycle acquires a field full of "as discussed".
 */
export function needsReason(to: ActionState): boolean {
  return to === 'blocked' || to === 'cancelled';
}

export interface MoveRequest {
  readonly to: ActionState;
  /** The identity making the move, from the forwarded token rather than the body. */
  readonly who: string;
  readonly reason?: string;
  readonly at?: Date;
}

/**
 * The action after a person's move, or an error naming what is wrong with it.
 *
 * Returns a new action rather than mutating, so a caller that refuses to persist the result leaves
 * the record as it was. Every refusal names both states, because "invalid transition" in a log tells
 * whoever reads it nothing about which of the two ends was the surprise.
 */
export function moved(action: ImprovementAction, request: MoveRequest): ImprovementAction {
  const at = request.at ?? new Date();
  const permitted = MOVES[action.state].find((move) => move.to === request.to);

  if (permitted == null) {
    throw new InvalidActionError(refusalFor(action.state, request.to));
  }
  if (permitted.by === 'run') {
    throw new InvalidActionError(
      'Nobody can mark their own work verified. An action becomes verified when a run measures every ' +
        'requirement it names as met, after the owner said it was done — see the improvement progress reading.'
    );
  }

  if (request.to === 'planned' && action.definitionOfDone.trim().length < MIN_PROSE) {
    throw new InvalidActionError(
      `Say what would have to be true for this to be finished, in at least ${String(MIN_PROSE)} characters, ` +
        'before planning it. An action nobody can judge finished can only be abandoned or asserted.'
    );
  }
  if (request.to === 'planned' && action.due == null) {
    throw new InvalidActionError('Give the date this is expected by, as due, before planning it.');
  }

  const reason = request.reason?.trim();
  if (needsReason(request.to) && (reason == null || reason.length < MIN_PROSE)) {
    throw new InvalidActionError(
      request.to === 'blocked'
        ? `Say what it is blocked on, in at least ${String(MIN_PROSE)} characters. A blocker nobody named is a ` +
          'blocker nobody can clear.'
        : `Say why this is being cancelled, in at least ${String(MIN_PROSE)} characters. Cancelling without a reason ` +
          'loses the fact that somebody considered it.'
    );
  }

  return {
    ...action,
    revision: action.revision + 1,
    state: request.to,
    history: [
      ...action.history,
      {
        from: action.state,
        to: request.to,
        at,
        by: 'person',
        who: request.who,
        ...(reason != null ? { reason } : {}),
      },
    ],
  };
}

/**
 * The action after a run agreed with it.
 *
 * Separate from `moved` rather than a flag on it, so that no handler holding a request body can
 * reach this path. The caller is the code that has just read a run, and `scanId` is what makes the
 * claim checkable afterwards: a verification citing no measurement is somebody's word again.
 */
export function verifiedBy(action: ImprovementAction, scanId: string, at: Date): ImprovementAction {
  if (action.state !== 'ready-for-validation') {
    throw new InvalidActionError(
      `Only an action whose owner has said the work is done can be verified by a run, and this one is ` +
        `${action.state}.`
    );
  }

  return {
    ...action,
    revision: action.revision + 1,
    state: 'verified',
    history: [...action.history, { from: action.state, to: 'verified', at, by: 'run', who: scanId }],
  };
}

/**
 * The action after a later advisory stopped finding what it was raised from.
 *
 * The counterpart of `verifiedBy` for the actions no scan can speak to. An action about a warehouse's
 * size names no requirement in the framework, so the assessment has nothing to agree with; what agrees
 * is the advisor reading the estate again and not finding the rule firing on that resource.
 *
 * Separate from `verifiedBy` rather than a parameter on it for the reason `verifiedBy` is separate from
 * `moved`: the two have different callers, and a shared function with a flag is one a future caller can
 * pass the wrong way. The stricter half of it is here — an action with no advice may not reach
 * `verified` this way, because the only evidence this path has is a finding that has stopped firing,
 * and an action that names requirements has requirements that were never measured.
 *
 * What counts as "stopped finding" is not this function's judgement. `adviceReadingOf` decides it, and
 * refuses every reading that could be mistaken for one: a resource the run did not mention, an analysis
 * it could not form, a rule this build no longer has.
 */
export function clearedBy(action: ImprovementAction, advisoryId: string, at: Date): ImprovementAction {
  if (action.state !== 'ready-for-validation') {
    throw new InvalidActionError(
      `Only an action whose owner has said the work is done can be verified by an advisory, and this one is ` +
        `${action.state}.`
    );
  }
  if (action.advice == null) {
    throw new InvalidActionError(
      'This action was not raised from advisor advice, so an advisory has no finding of its own to stop ' +
        'reporting. It is verified by a run measuring the requirements it names.'
    );
  }

  return {
    ...action,
    revision: action.revision + 1,
    state: 'verified',
    history: [...action.history, { from: action.state, to: 'verified', at, by: 'advisor', who: advisoryId }],
  };
}

/**
 * Why a particular move is refused, in terms of what the reader was trying to do.
 *
 * Written out per terminal state rather than as one generic sentence, because the two terminal
 * states are refused for opposite reasons and a reader told "cannot move from verified" will assume
 * the app has lost their action.
 */
function refusalFor(from: ActionState, to: ActionState): string {
  if (!ACTION_STATES.includes(to)) {
    return `An action can be ${ACTION_STATES.join(', ')}, and nothing else. There is no state called ${to}.`;
  }
  if (from === 'verified') {
    return (
      'A verified action is finished, and a run said so. If the requirement has come back, that is a new ' +
      'finding and a new action rather than a reopening of this one — the history of what was fixed and ' +
      'confirmed has to stay readable.'
    );
  }
  if (from === 'cancelled') {
    return 'A cancelled action is kept as a record of what was considered, and cannot be restarted. Raise a new one.';
  }
  return `An action that is ${from} can only become ${movesFor(from).join(' or ')}, not ${to}.`;
}

export interface ActionDraft {
  readonly planId: string;
  readonly controlIds: readonly string[];
  readonly outcome: string;
  readonly definitionOfDone: string;
  readonly owner: string;
  readonly priority: Priority;
  readonly effort: Effort;
  readonly due?: Date;
  readonly steps: readonly Step[];
  readonly dependsOn: readonly string[];
  readonly raisedFrom?: string;
  readonly advice?: AdviceProvenance;
}

export interface DraftContext {
  readonly knownControl: (id: string) => boolean;
  /**
   * The advisory finding a reference names, as the record holds it, or a throw saying it names none.
   *
   * A function rather than the provenance itself, so that the only way a body can put provenance on an
   * action is by naming a finding that is in a stored advisory. Absent on an install whose advisories
   * are not kept, and then a body carrying a reference is refused rather than stored without one — an
   * action that says it came from advice nobody can look up is the thing this whole field is against.
   */
  readonly adviceFor?: (reference: AdviceReference) => AdviceProvenance;
  /**
   * The provenance this action already has, kept as it was.
   *
   * Only set when revising, and it is what makes an advice-raised action editable at all: the body of
   * a revision carries no reference, so without this the draft would have neither a requirement nor
   * advice and be refused for being about nothing. Re-resolving the reference instead would be worse
   * than refusing — the advisory it named is a record of one run, and a correction to an owner's name
   * would silently re-read whatever that run says today.
   */
  readonly existingAdvice?: AdviceProvenance;
  /** Actions already in this plan, for the dependency checks. */
  readonly siblings: readonly Pick<ImprovementAction, 'id' | 'dependsOn'>[];
  /**
   * The action being revised, where this draft replaces one rather than adding one.
   *
   * Absent when the draft is new, and that absence is what makes the cycle check cheap: an action
   * with no id yet cannot be reached from anything, so a new action cannot close a circle. A revision
   * can, which is the only reason the walk in `dependenciesFrom` exists.
   */
  readonly self?: string;
  readonly now?: Date;
  /**
   * The date this action already had, which is allowed to be in the past.
   *
   * Only set when revising. A new action's date has to be in the future — an action born late tells
   * its owner nothing — but an action that has since gone overdue must still be editable, and without
   * this the rule would refuse a request that only changed the owner because the date it was not
   * touching had passed. So the past is permitted for exactly one value: the one already stored.
   */
  readonly existingDue?: Date;
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * Validated here rather than at the route, so the same rules hold for any caller and the messages
 * are written once. Every message says what to do with the form the reader is looking at, because
 * "invalid request" is a sentence that has never helped anybody fill one in.
 */
export function draftFrom(body: unknown, context: DraftContext): ActionDraft {
  const raw = (body ?? {}) as Record<string, unknown>;
  const now = context.now ?? new Date();

  const planId = text(raw.planId);
  if (planId == null) throw new InvalidActionError('Name the plan this action belongs to, as planId.');

  const advice = adviceFrom(raw.advice, context);

  // Deduplicated rather than refused. A repeated id is a slip in whatever built the form, and
  // refusing it teaches nobody anything; two identical ids in the list would make "the requirements
  // this answers" a count that reads high.
  const controlIds = [...new Set(list(raw.controlIds, 'controlIds'))];
  if (controlIds.length === 0 && advice == null) {
    throw new InvalidActionError(
      'Name at least one requirement this action is about, as controlIds, or the advisor finding it came ' +
        'from, as advice. An action about neither cannot be found from anything, and nothing can ever say ' +
        'whether it helped.'
    );
  }
  const unknown = controlIds.filter((id) => !context.knownControl(id));
  if (unknown.length > 0) {
    throw new InvalidActionError(`This framework has no requirement with the id ${unknown.join(', ')}.`);
  }

  const outcome = prose(raw.outcome, 'outcome', 'Say what changes for the business when this is done');
  const definitionOfDone = prose(
    raw.definitionOfDone,
    'definitionOfDone',
    'Say what would have to be true for this to be finished'
  );

  const owner = text(raw.owner);
  if (owner == null) throw new InvalidActionError('Name who is doing this, as owner.');

  const raisedFrom = text(raw.raisedFrom);

  const priority = text(raw.priority);
  if (priority == null || !PRIORITIES.includes(priority as Priority)) {
    throw new InvalidActionError(`The priority must be one of ${PRIORITIES.join(', ')}.`);
  }

  const effort = text(raw.effort);
  if (effort == null || !EFFORTS.includes(effort as Effort)) {
    throw new InvalidActionError(`The effort must be one of ${EFFORTS.join(', ')}.`);
  }

  return {
    planId,
    controlIds,
    outcome,
    definitionOfDone,
    owner,
    priority: priority as Priority,
    effort: effort as Effort,
    steps: list(raw.steps, 'steps'),
    dependsOn: dependenciesFrom(list(raw.dependsOn, 'dependsOn'), context),
    ...dueFrom(raw.due, now, context.existingDue),
    ...(raisedFrom != null ? { raisedFrom } : {}),
    ...(advice != null ? { advice } : {}),
  };
}

/**
 * The provenance a reference in the body resolves to, or nothing where the body named no finding.
 *
 * Four strings in and a whole provenance out, and everything between the two comes from the stored
 * advisory: what a client sends is which finding, never what the finding said. `advice.ts` sets out
 * why, and it is the reason this returns the resolver's answer rather than merging it with the body's.
 */
function adviceFrom(raw: unknown, context: DraftContext): AdviceProvenance | undefined {
  if (raw == null) return context.existingAdvice;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new InvalidActionError(
      'The advice this came from is named by an object with an advisoryId, an advisor, a resource and a rule.'
    );
  }

  const supplied = raw as Record<string, unknown>;
  const advisoryId = text(supplied.advisoryId);
  const advisor = text(supplied.advisor);
  const resource = text(supplied.resource);
  const rule = text(supplied.rule);

  if (advisoryId == null || advisor == null || resource == null || rule == null) {
    throw new InvalidActionError(
      'Name all four of advisoryId, advisor, resource and rule in advice. Three of them find the finding and ' +
        'the fourth says which advisory said it, and a reference short of one names a set rather than a thing.'
    );
  }
  if (!ADVISORS.includes(advisor as Advisor)) {
    throw new InvalidActionError(`The advisor must be one of ${ADVISORS.join(', ')}.`);
  }
  if (context.adviceFor == null) {
    throw new InvalidActionError(
      'This installation is not keeping advisories, so there is nothing to check this reference against. An ' +
        'action recording advice that cannot be looked up reads as checkable and is not.'
    );
  }

  return context.adviceFor({ advisoryId, advisor: advisor as Advisor, resource, rule });
}

/**
 * The fields a revision may not touch once the action has left `draft`.
 *
 * What an action is *about* — which requirements, what outcome, what would count as done — is the part
 * colleagues agreed to and the part a run is later measured against. Editing it in place would make
 * every earlier reading of this action a reading of something else: a board that showed three weeks of
 * work against a definition of done nobody worked to, and a `verified` further down that cited a run
 * which agreed with different criteria.
 *
 * So while an action is a draft, all of it is editable, and afterwards these three are not. The way to
 * change them is the way the lifecycle already provides: `planned` moves back to `draft`, and work
 * further along is cancelled with a reason and raised again — which keeps the fact that the first
 * version existed.
 */
const SETTLED_BY_AGREEMENT = ['controlIds', 'outcome', 'definitionOfDone'] as const;

/**
 * The action after somebody corrected it, or an error naming what may not be corrected.
 *
 * A whole replacement rather than a patch, and the body is validated by `draftFrom` — the same rules,
 * the same sentences, one place. A patch would have to decide what an absent `steps` means, and both
 * answers are wrong often enough to lose somebody's work.
 *
 * The identity of the action survives: id, plan, state, history, and who raised it when. A revision is
 * not a transition, so nothing is appended to `history`; what changed and who changed it is in the
 * audit log, where `action.revise` names it.
 */
export function revised(action: ImprovementAction, body: unknown, context: DraftContext): ImprovementAction {
  if (action.state === 'verified' || action.state === 'cancelled') {
    throw new InvalidActionError(
      action.state === 'verified'
        ? 'A verified action is the record of work a run agreed with, and editing it would leave that agreement ' +
          'describing something else. If more is needed, raise a new action.'
        : 'A cancelled action is kept as a record of what was considered, and cannot be edited. Raise a new one.'
    );
  }

  const draft = draftFrom(
    {
      ...(body != null && typeof body === 'object' && !Array.isArray(body) ? body : {}),
      // None of the three is the caller's to move. An action changing plans would take its
      // dependencies out of the plan that reports on them, and its provenance — the run it was raised
      // from, and the advisor finding — is a fact about a measurement rather than a field.
      planId: action.planId,
      ...(action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {}),
      advice: undefined,
    },
    {
      ...context,
      self: action.id,
      ...(action.due != null ? { existingDue: action.due } : {}),
      ...(action.advice != null ? { existingAdvice: action.advice } : {}),
    }
  );

  if (action.state !== 'draft') {
    const changed = SETTLED_BY_AGREEMENT.filter((field) => !same(action[field], draft[field]));
    if (changed.length > 0) {
      throw new InvalidActionError(
        `An action that is ${action.state} cannot have its ${changed.join(', ')} changed, because that is what ` +
          'people agreed to and what a run will be measured against. Move it back to draft if it is still only ' +
          'planned, or cancel it with a reason and raise the replacement.'
      );
    }
  }

  // The date is dropped before the spread rather than overwritten by it, because a spread cannot clear
  // an absent optional: an action whose revision removes its date would otherwise keep the old one.
  const { due: _replaced, ...kept } = action;
  return {
    ...kept,
    ...draft,
    id: action.id,
    planId: action.planId,
    state: action.state,
    createdBy: action.createdBy,
    createdAt: action.createdAt,
    history: action.history,
    revision: action.revision + 1,
  };
}

/** Whether a revisable field is unchanged, comparing lists by their members in order. */
function same(before: string | readonly string[], after: string | readonly string[]): boolean {
  if (typeof before === 'string' || typeof after === 'string') return before === after;
  return before.length === after.length && before.every((entry, index) => entry === after[index]);
}

/**
 * The date, which is optional on a draft and required to plan one.
 *
 * Optional here on purpose: an action being written down in a workshop does not yet have a date, and
 * refusing the draft would send people back to the spreadsheet for the part of the process this is
 * meant to replace. `moved` is where it becomes required, because that is where the action stops
 * being a note and becomes work somebody has agreed to.
 */
function dueFrom(raw: unknown, now: Date, existing?: Date): { due?: Date } {
  const supplied = text(raw);
  if (supplied == null) return {};

  const due = new Date(supplied);
  if (Number.isNaN(due.getTime())) {
    throw new InvalidActionError('The date must be an ISO date, such as 2026-09-30.');
  }
  // The date it already had, kept as it was. See `existingDue`.
  if (due.getTime() === existing?.getTime()) return { due };
  if (due.getTime() <= now.getTime()) {
    throw new InvalidActionError(
      'The date has to be in the future. An action that is already late on the day it is written tells the ' +
        'owner nothing, and makes every overdue count meaningless.'
    );
  }
  return { due };
}

/**
 * The dependencies, refusing the two that cannot mean anything.
 *
 * A dependency on an action outside this plan is refused because a plan whose completeness depends
 * on work it does not contain cannot report progress — and reporting progress is what a plan is for.
 * Where the dependency is real and cross-plan, the honest answer is that the two plans are one, and
 * a refusal that says so is better than a field that quietly makes every rollup wrong.
 *
 * A cycle is refused because it is not a statement about order. Nothing else about a dependency is
 * enforced: it does not block a transition, and an owner who starts work early is not doing anything
 * this app should have an opinion about.
 */
function dependenciesFrom(supplied: readonly string[], context: DraftContext): readonly string[] {
  const known = new Map(context.siblings.map((sibling) => [sibling.id, sibling.dependsOn]));
  const wanted = [...new Set(supplied)];

  if (context.self != null && wanted.includes(context.self)) {
    throw new InvalidActionError('An action cannot depend on itself.');
  }

  const foreign = wanted.filter((id) => !known.has(id));
  if (foreign.length > 0) {
    throw new InvalidActionError(
      `An action can only depend on another action in the same plan, and this plan has nothing with the id ` +
        `${foreign.join(', ')}. If the dependency really is on other work, the two plans are one plan.`
    );
  }

  // Reachability from the dependencies back to this action, which is the only way a cycle can appear:
  // a new action is reachable from nothing, so `self` being absent makes this a no-op. `seen` guards
  // the walk rather than detecting the cycle — two dependencies that meet further down are a diamond,
  // which is a perfectly ordinary order, and reading that as a circle would refuse it.
  if (context.self != null) {
    const seen = new Set<string>();
    const pending = [...wanted];
    while (pending.length > 0) {
      const next = pending.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      const onward = known.get(next) ?? [];
      if (onward.includes(context.self)) {
        throw new InvalidActionError(
          `These dependencies run in a circle: ${next} already waits on this action. A circle is not an order, ` +
            'so nothing in it could ever be first.'
        );
      }
      pending.push(...onward);
    }
  }

  return wanted;
}

function prose(value: unknown, field: string, instruction: string): string {
  const supplied = text(value);
  if (supplied == null || supplied.length < MIN_PROSE) {
    throw new InvalidActionError(`${instruction}, as ${field}, in at least ${String(MIN_PROSE)} characters.`);
  }
  return supplied;
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Strings from an untrusted array. An empty one is dropped; anything that is not a string is refused.
 *
 * The two are treated differently because they mean different things. A blank row in a form is a
 * person who has not filled it in, and refusing the whole submission over it would be a rule about
 * typing. A number where a requirement id belongs is a caller that is wrong about the shape, and
 * dropping it silently is the failure that matters here: an action built from `['DG-02-01', 42]` would
 * be stored as answering one requirement while whoever sent it believes it answers two, and nothing
 * anywhere would ever say so.
 */
function list(value: unknown, field: string): readonly string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidActionError(`${field} has to be a list of text values.`);

  const entries: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') {
      throw new InvalidActionError(`Every entry in ${field} has to be text, and one of them is not.`);
    }
    const trimmed = text(entry);
    if (trimmed != null) entries.push(trimmed);
  }
  return entries;
}
