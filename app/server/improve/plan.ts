// The thing a set of actions belongs to.
//
// A plan is deliberately thin. Almost everything with a rule in it is on the action — the lifecycle,
// the definition of done, the owner, the dependency — and what is left here is the two things an
// action cannot carry: what the whole of the work is for, and which assessment it was written
// against. Everything else a reader wants to know about a plan is a function of its actions, and is
// computed rather than stored (see `progress.ts`).
//
// That thinness is the design rather than a first pass. The failure mode of a plan record is that it
// grows fields which duplicate its actions — a status, a percentage, a count of what is done — and
// each of those is a number that can disagree with the actions under it. The app already refused that
// once, in `A6b`: a finding's confidence is derived on read because a stored one can drift from the
// finding it describes. A plan whose stored status says `on-track` while four of its five actions are
// blocked is the same defect with more people looking at it.
//
// Two things the audit asks for are deliberately not here, and both for the same reason.
//
// **A target.** AUD-DEC-115 and the H5 row ask for a baseline and a target — "get security to 80 by
// March". The baseline is a fact and is here, as the run the plan was raised from: the score can be
// recomputed from that run, and storing a copy of the number would be a second copy that is allowed
// to disagree with it. The target is not a fact, and how the product judges one is now decided and not
// yet built: a target is per pillar per definition, and a date that passes unmet reports the gap
// rather than flagging a miss, because a tool that shames people for their own commitments is a tool
// people stop setting commitments in. Row 30b builds it. Until then a plan carrying a target the
// product cannot judge would be exactly the invented benchmark H5 refuses.
//
// **A publication state.** The audit wants plans published as immutable, hashed, versioned
// artefacts. That is `C3`, it applies to every published output rather than to plans alone, and the
// record digests it rests on already exist (`A3c`). Adding a private version of it here would be the
// second implementation of a thing that has to be one implementation to be worth anything.

import type { ImprovementAction } from './action.js';

export interface ImprovementPlan {
  readonly id: string;
  readonly title: string;
  /**
   * What the whole plan is for, in outcome terms.
   *
   * Required, and required to be a sentence rather than a label, because a plan titled "Q3 security
   * work" whose outcome field is empty is a folder. The question this answers is the one an executive
   * asks about a plan they are being shown: what is different when this is finished.
   */
  readonly outcome: string;
  /**
   * The Databricks users or groups answerable for the plan as a whole, which is not the same set as
   * the owners of its actions.
   *
   * A list, because a plan that crosses two teams has two people who have to agree it is finished,
   * and naming one of them makes the other's agreement invisible.
   */
  readonly owners: readonly string[];
  /**
   * The assessment this plan answers, at the version it was written against.
   *
   * The version matters for the reason ADR 0037 gave it a fingerprint: a plan written against an
   * assessment whose scope has since widened is a plan about a smaller estate than the one now being
   * measured, and a reader comparing the plan's progress to the current score is owed that.
   */
  readonly assessment?: PlanAssessment;
  /**
   * The run the plan was raised from. This is the baseline.
   *
   * A reference rather than a copy of the score, so the two cannot disagree. Absent on a plan written
   * before any run, which is a real case: somebody planning from a workshop rather than from a scan.
   */
  readonly raisedFrom?: string;
  readonly createdBy: string;
  readonly createdAt: Date;
  /** When it was closed, and by whom. A plan is closed rather than deleted, for the usual reason. */
  readonly closed?: PlanClosure;
  /**
   * Which version of this plan this is: 0 as opened, and one higher for every change since.
   *
   * On the record rather than worked out by the store, because it is what the store's key is made of
   * and a number the store derived would be a number two writers could compute the same way from
   * different records. Every function here that returns a changed plan raises it, and the store
   * refuses a revision already written — see `store.ts`.
   */
  readonly revision: number;
}

export interface PlanAssessment {
  readonly definitionId: string;
  readonly version: number;
}

export interface PlanClosure {
  readonly at: Date;
  readonly by: string;
  readonly reason: string;
}

export class InvalidPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPlanError';
  }
}

/** The shortest outcome or closing reason worth recording. The same floor the action uses. */
export const MIN_PROSE = 20;

export interface PlanDraft {
  readonly title: string;
  readonly outcome: string;
  readonly owners: readonly string[];
  readonly assessment?: PlanAssessment;
  readonly raisedFrom?: string;
}

export interface PlanDraftContext {
  /** Whether the named assessment exists, so a plan cannot cite one that does not. */
  readonly knownAssessment?: (definitionId: string, version: number) => boolean;
}

/**
 * A draft from an untrusted body, or an error naming the field to fix.
 *
 * The identity and the timestamp are absent on purpose, as they are on a decision draft: a client
 * that could send `createdBy` could attribute a plan to a colleague.
 */
export function draftFrom(body: unknown, context: PlanDraftContext = {}): PlanDraft {
  const raw = (body ?? {}) as Record<string, unknown>;

  const title = text(raw.title);
  if (title == null) throw new InvalidPlanError('Give the plan a title, as title.');

  const outcome = text(raw.outcome);
  if (outcome == null || outcome.length < MIN_PROSE) {
    throw new InvalidPlanError(
      `Say what is different when this plan is finished, as outcome, in at least ${String(MIN_PROSE)} ` +
        'characters. A plan with a title and no outcome is a folder.'
    );
  }

  const owners = [...new Set(list(raw.owners, 'owners'))];
  if (owners.length === 0) {
    throw new InvalidPlanError(
      'Name who is answerable for this plan, as owners. A plan nobody owns is a list somebody wrote once.'
    );
  }

  const raisedFrom = text(raw.raisedFrom);

  return {
    title,
    outcome,
    owners,
    ...assessmentFrom(raw.assessment, context),
    ...(raisedFrom != null ? { raisedFrom } : {}),
  };
}

/**
 * The assessment reference, refused rather than dropped when it names nothing.
 *
 * A plan citing an assessment that does not exist is worse than one citing none: the citation is what
 * a reader uses to decide whether the plan is about the estate they are looking at, so a dangling one
 * answers that question wrongly rather than leaving it open.
 */
function assessmentFrom(raw: unknown, context: PlanDraftContext): { assessment?: PlanAssessment } {
  if (raw == null) return {};
  const supplied = raw as Record<string, unknown>;

  const definitionId = text(supplied.definitionId);
  const version = typeof supplied.version === 'number' ? supplied.version : Number.NaN;
  if (definitionId == null || !Number.isInteger(version) || version < 1) {
    throw new InvalidPlanError(
      'An assessment reference needs both a definitionId and a whole version number. Leave it out entirely if ' +
        'this plan is not written against an assessment.'
    );
  }
  if (context.knownAssessment != null && !context.knownAssessment(definitionId, version)) {
    throw new InvalidPlanError(`There is no version ${String(version)} of the assessment ${definitionId}.`);
  }

  return { assessment: { definitionId, version } };
}

/**
 * The plan after somebody closed it, or an error saying why it cannot be closed yet.
 *
 * Closing is refused while any action is still live, and that refusal is the only rule a plan has of
 * its own. A closed plan whose actions are still in progress is the state a programme review is
 * misled by: the plan reads finished, the work is not, and the actions are the ones that were
 * forgotten. Cancelling the actions is the honest way to close a plan whose work is not going to
 * happen, and it leaves a record of that decision on each of them.
 */
export function closed(
  plan: ImprovementPlan,
  actions: readonly ImprovementAction[],
  closure: { readonly by: string; readonly reason: string; readonly at?: Date }
): ImprovementPlan {
  if (plan.closed != null) {
    throw new InvalidPlanError('This plan is already closed.');
  }

  const reason = closure.reason.trim();
  if (reason.length < MIN_PROSE) {
    throw new InvalidPlanError(
      `Say why the plan is being closed, in at least ${String(MIN_PROSE)} characters. Whoever reads this next is ` +
        'deciding whether the work it described still needs doing.'
    );
  }

  // Narrowed to this plan's own actions rather than trusting the caller to have narrowed them, which is
  // the same thing `planProgress` does and for a sharper reason here: handed a wider set, an unfiltered
  // check refuses a closure because of live work in some other plan, and handed the wrong plan's set it
  // closes a plan with live work under it. Filtering is correct under both.
  const live = actions.filter(
    (action) => action.planId === plan.id && action.state !== 'verified' && action.state !== 'cancelled'
  );
  if (live.length > 0) {
    throw new InvalidPlanError(
      `${String(live.length)} action${live.length === 1 ? '' : 's'} in this plan ${live.length === 1 ? 'is' : 'are'} ` +
        'still live. Verify or cancel each of them first — a closed plan with live actions under it reads as ' +
        'finished work in every rollup that counts plans.'
    );
  }

  return {
    ...plan,
    revision: plan.revision + 1,
    closed: { at: closure.at ?? new Date(), by: closure.by, reason },
  };
}

function text(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

/**
 * Strings from an untrusted array. A blank is dropped; anything that is not a string is refused.
 *
 * Same rule and same reasoning as `action.ts`: a blank row is somebody who has not typed yet, and a
 * value of the wrong type is a caller that is wrong about the shape. Dropping the second silently
 * would store a plan owned by fewer people than whoever created it believes, which is the field this
 * record exists to make answerable.
 */
function list(value: unknown, field: string): readonly string[] {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new InvalidPlanError(`${field} has to be a list of text values.`);

  const entries: string[] = [];
  for (const entry of value as readonly unknown[]) {
    if (typeof entry !== 'string') {
      throw new InvalidPlanError(`Every entry in ${field} has to be text, and one of them is not.`);
    }
    const trimmed = text(entry);
    if (trimmed != null) entries.push(trimmed);
  }
  return entries;
}
