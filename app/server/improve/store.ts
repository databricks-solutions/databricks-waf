// Where plans and actions are kept.
//
// The same two-implementation shape the attestation store uses, and for the stronger version of the
// same reason. A lost scan can be re-run by pressing a button. A lost attestation is a paragraph
// somebody has to type again. A lost plan is a fortnight of agreements between people about who is
// doing what by when, and there is no way to reconstruct it from the estate — the estate only knows
// what is wrong, not what anybody decided to do about it. So the in-memory implementation is a
// fallback the UI warns about, never a reasonable place to run from.
//
// Both records are stored as versions rather than updated in place, keyed on the pair (id, revision),
// which is the shape assessment definitions use and it is here for the same reason spelled out
// there: two people acting on one action both read revision 4, both compute 5, and the database
// refusing the second is what turns a silently lost transition into a conflict its author can see.
// An `update ... where revision = $n` would need the driver's row count to notice the same thing,
// and a store that has to be told how many rows it changed in order to be correct is a store one
// wrapper away from being wrong.
//
// The revision is on the record, raised by whichever domain function produced the new version, and
// the store only reads it. It is deliberately not derived from the history: a correction that changes
// an owner or a slipped date is a new version of the record without being a transition, and a derived
// revision would have had the store telling that author their own edit had lost a race.
//
// ADR 0051.

import type { ImprovementAction } from './action.js';
import type { ImprovementPlan } from './plan.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

/**
 * A write that lost a race.
 *
 * Raised rather than absorbed, because the two writers wanted different things. Somebody moved an
 * action to `blocked` while somebody else moved it to `in-progress`; whichever arrives second is
 * about to describe a transition from a state the action is no longer in, and the honest answer is
 * to say so and let them re-read. Silently taking the newer write would leave the loser believing
 * a thing they did had happened.
 */
export class ConcurrentChangeError extends Error {
  constructor(
    readonly kind: 'plan' | 'action',
    readonly id: string
  ) {
    super(`This ${kind} changed while you were working on it. Re-read it and try again.`);
    this.name = 'ConcurrentChangeError';
  }
}

export interface ImprovementStore {
  /** True when records survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /** Every plan, newest first. Closed ones included: a closed plan is still the record of a period. */
  plans(scope?: AssessmentScope): Promise<readonly ImprovementPlan[]>;
  plan(id: string, scope?: AssessmentScope): Promise<ImprovementPlan | undefined>;
  /** Writes revision 0. Refuses an id already present. */
  addPlan(plan: ImprovementPlan): Promise<void>;
  /** Writes the next revision. Refuses if somebody else has already written it. */
  changePlan(plan: ImprovementPlan): Promise<void>;

  /** The actions of one plan, in no guaranteed order — the caller sorts by what it is showing. */
  actions(planId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]>;
  action(id: string, scope?: AssessmentScope): Promise<ImprovementAction | undefined>;
  /**
   * Actions naming one requirement, across every plan.
   *
   * What the findings view asks: this control is failing, is it already somebody's work? Answering
   * it needs every plan, because the plan a reader is looking at is rarely the one the action is in.
   */
  actionsFor(controlId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]>;
  /**
   * Every current action, across every plan.
   *
   * What the report asks: it renders every finding and used to call `actionsFor` once per control.
   * The newest revision of each action, same reduction `actionsFor` applies, without the control
   * filter. A page that needs one requirement still uses `actionsFor`.
   */
  actionsRaised(scope?: AssessmentScope): Promise<readonly ImprovementAction[]>;
  /**
   * Writes revision 0 of an action, in the context of the plan it belongs to.
   *
   * The plan is a parameter rather than something the store looks up, and it earns its place twice.
   * The durable store needs the plan's date to age an action with the plan it belongs to rather than
   * on its own clock — see `postgres-store.ts` for why that matters. And a caller that has to hold
   * the plan is a caller that has read it, which is the read it needed anyway to know the plan is
   * still open. Passing the id instead would have let a route add work to a closed plan.
   */
  addAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void>;
  changeAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void>;
}

/** A write of an action against a plan that is not the one it names. A programming mistake, not input. */
export class MismatchedPlanError extends Error {
  constructor(action: ImprovementAction, plan: ImprovementPlan) {
    super(`Action ${action.id} belongs to plan ${action.planId}, not ${plan.id}.`);
    this.name = 'MismatchedPlanError';
  }
}

/**
 * The revision a record is at, which the record carries.
 *
 * A function rather than a field read at four sites, so both implementations key on the same thing
 * and the reason is written down once. It was briefly derived — an action's revision was the length
 * of its history — and that was wrong as soon as a record could change without a transition: a
 * correction to an owner or a date computes the revision it already had, and the store answers a
 * lone author with somebody else's concurrency error. See `revision` on both records.
 */
export function revisionOf(record: ImprovementPlan | ImprovementAction): number {
  return record.revision;
}

/** Newest first by creation, which is the only order a list of plans has. */
export function newestFirst(plans: readonly ImprovementPlan[]): ImprovementPlan[] {
  return [...plans].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}

/**
 * The in-memory fallback.
 *
 * Keeps every revision like the durable one, rather than only the latest, so the two implementations
 * refuse the same second write. A version that overwrote would let a test pass here and a race land
 * in production.
 */
export class InMemoryImprovementStore implements ImprovementStore {
  readonly durable = false;

  private readonly planRevisions = new Map<string, ImprovementPlan>();
  private readonly actionRevisions = new Map<string, ImprovementAction>();

  plans(scope?: AssessmentScope): Promise<readonly ImprovementPlan[]> {
    return Promise.resolve(
      newestFirst(
        latest(this.planRevisions.values(), (plan) => plan.id).filter((plan) =>
          inScope(plan.assessment?.definitionId, scope)
        )
      )
    );
  }

  plan(id: string, scope?: AssessmentScope): Promise<ImprovementPlan | undefined> {
    const plan = latest(this.planRevisions.values(), (p) => p.id).find((one) => one.id === id);
    if (plan == null || !inScope(plan.assessment?.definitionId, scope)) return Promise.resolve(undefined);
    return Promise.resolve(plan);
  }

  addPlan(plan: ImprovementPlan): Promise<void> {
    return this.write('plan', this.planRevisions, plan.id, plan);
  }

  changePlan(plan: ImprovementPlan): Promise<void> {
    return this.write('plan', this.planRevisions, plan.id, plan);
  }

  actions(planId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    return this.plan(planId, scope).then((plan) => {
      if (plan == null && scope !== undefined) return [];
      return this.currentActions().filter((action) => action.planId === planId);
    });
  }

  action(id: string, scope?: AssessmentScope): Promise<ImprovementAction | undefined> {
    const action = this.currentActions().find((one) => one.id === id);
    if (action == null) return Promise.resolve(undefined);
    if (scope === undefined) return Promise.resolve(action);
    return this.plan(action.planId).then((plan) => {
      if (plan == null) return action;
      return inScope(plan.assessment?.definitionId, scope) ? action : undefined;
    });
  }

  actionsFor(controlId: string, scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    const named = this.currentActions().filter((action) => action.controlIds.includes(controlId));
    if (scope === undefined) return Promise.resolve(named);
    const allowed = new Set(
      latest(this.planRevisions.values(), (plan) => plan.id)
        .filter((plan) => inScope(plan.assessment?.definitionId, scope))
        .map((plan) => plan.id)
    );
    return Promise.resolve(named.filter((action) => allowed.has(action.planId)));
  }

  actionsRaised(scope?: AssessmentScope): Promise<readonly ImprovementAction[]> {
    const current = this.currentActions();
    if (scope === undefined) return Promise.resolve(current);
    const allowed = new Set(
      latest(this.planRevisions.values(), (plan) => plan.id)
        .filter((plan) => inScope(plan.assessment?.definitionId, scope))
        .map((plan) => plan.id)
    );
    return Promise.resolve(current.filter((action) => allowed.has(action.planId)));
  }

  // The plan is checked and then unused: nothing here ages out, so there is no date to copy off it.
  // Checked anyway, because an implementation that accepted a mismatch would let a test pass against
  // this store and write a mis-parented row against the other one.
  addAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    if (action.planId !== plan.id) return Promise.reject(new MismatchedPlanError(action, plan));
    return this.write('action', this.actionRevisions, action.id, action);
  }

  changeAction(action: ImprovementAction, plan: ImprovementPlan): Promise<void> {
    if (action.planId !== plan.id) return Promise.reject(new MismatchedPlanError(action, plan));
    return this.write('action', this.actionRevisions, action.id, action);
  }

  private currentActions(): ImprovementAction[] {
    return latest(this.actionRevisions.values(), (action) => action.id);
  }

  private write<T extends ImprovementPlan | ImprovementAction>(
    kind: 'plan' | 'action',
    revisions: Map<string, T>,
    id: string,
    record: T
  ): Promise<void> {
    const key = `${id}\u0000${String(revisionOf(record))}`;
    if (revisions.has(key)) return Promise.reject(new ConcurrentChangeError(kind, id));
    revisions.set(key, record);
    return Promise.resolve();
  }
}

/** The highest revision of each record, out of every revision of all of them. */
function latest<T extends ImprovementPlan | ImprovementAction>(
  revisions: Iterable<T>,
  idOf: (record: T) => string
): T[] {
  const newest = new Map<string, T>();
  for (const record of revisions) {
    const id = idOf(record);
    const held = newest.get(id);
    if (held == null || revisionOf(record) > revisionOf(held)) newest.set(id, record);
  }
  return [...newest.values()];
}
