// The second path that reaches `verified`, and the only one an assessment has nothing to do with.
//
// `validate/resolve.ts` is the first, and reading the two together is the best way to see what this is:
// the same shape, over a different record, for the actions that surface cannot answer. An action raised
// from an advisor finding names no requirement, so no scan can agree with it however many run — the
// thing that can is the advisor reading the estate again and no longer finding the rule firing on that
// resource. ADR 0051 said a person may never mark their own work verified and named a run as the only
// thing that could; an advisory is the other kind of run, and this is where it says so.
//
// Four properties this shares with the validation pass, for the same reasons written down there.
//
// It runs **after** the advisory is saved rather than as part of producing one, and it cannot fail the
// run: the advice is real and worth keeping whatever happens to somebody's board, so nothing throws out
// of `settleAdvice` and what it could not do is counted and returned.
//
// It **verifies late rather than early**. Every advisor number is computed over a lookback window, so a
// job fixed today still shows last month's clusters until the window rolls past it — the rule keeps
// firing, the action stays claimed, and the advisory after that one clears it. That is the safe
// direction, and it is worth naming because the unsafe direction is available: reading a resource's
// absence from a ranked list as a fix would clear an action every time a worse resource appeared.
// `advice-reading.ts` is where that is refused.
//
// It **writes nothing when the answer is anything but cleared**. A rule that fired again is already
// visible — `progressOf` reads it as `contradicted` from the same two records — and a stored copy would
// be a field that drifts from the reading it came from.
//
// And it **loses a race to a person quietly**. An owner who took the work back between the advisory
// finishing and this pass has made the newer statement about the action, and their move stands.

import { clearedBy, type ImprovementAction } from './action.js';
import { adviceReadingOf } from './advice-reading.js';
import { claimedAtOf } from '../validate/attempt.js';
import { ConcurrentChangeError, type ImprovementStore } from './store.js';
import type { Advisory } from '../advise/advisory.js';

export interface SettleOptions {
  readonly improvements: ImprovementStore;
  readonly onError?: (operation: string, error: unknown) => void;
}

/**
 * What one pass did.
 *
 * `cleared` is the number a reader of a log wants: how many claims this advisory settled. The other
 * three are the reasons it settled no more than that, and they are counted separately because they
 * have different answers — `firing` is work that did not land, `unreadable` is an advisory that could
 * not see the resource, and `stalled` is a write somebody else won.
 */
export interface Settlement {
  readonly read: number;
  readonly cleared: number;
  readonly firing: number;
  readonly unreadable: number;
  readonly stalled: number;
}

const NOTHING: Settlement = { read: 0, cleared: 0, firing: 0, unreadable: 0, stalled: 0 };

/**
 * Verifies every claimed action whose advice this advisory no longer reports.
 *
 * Never rejects. A pass that cannot read the plans settles nothing, and the next advisory settles them
 * instead — late, which is the right way for this to fail.
 */
export async function settleAdvice(advisory: Advisory, options: SettleOptions): Promise<Settlement> {
  // The assessment the advisory ran under, so a run scoped to one assessment does not settle work
  // agreed under another. `null` is the unscoped estate, which is what an advisory with no definition
  // read, and `undefined` would be every assessment at once.
  const scope = advisory.definition?.id ?? null;

  let claimed: readonly ImprovementAction[];
  try {
    const plans = await options.improvements.plans(scope);
    const perPlan = await Promise.all(plans.map((plan) => options.improvements.actions(plan.id, scope)));
    claimed = perPlan.flat().filter(settleable);
  } catch (error) {
    options.onError?.('read the actions waiting on an advisory', error);
    return NOTHING;
  }
  if (claimed.length === 0) return NOTHING;

  const tally = { ...NOTHING };
  for (const action of claimed) {
    try {
      const one = await settle(action, advisory, options);
      tally.read += one.read;
      tally.cleared += one.cleared;
      tally.firing += one.firing;
      tally.unreadable += one.unreadable;
      tally.stalled += one.stalled;
    } catch (error) {
      // Per action rather than per pass, so one action whose plan cannot be read does not cost the
      // others their reading.
      options.onError?.(`settle action ${action.id}`, error);
    }
  }
  return tally;
}

/**
 * Whose claim this pass may answer, which is the same split `validate/attempt.ts` refuses on.
 *
 * An action naming a requirement is answered by a scan and by nothing else, even where it also carries
 * advice. Both are true of it and the assessment is the stronger reading: a requirement's answer
 * belongs to the requirement, and an advisory clearing one rule on one resource is not the framework
 * agreeing that the control is met. `attempt.ts` refuses a validation request for the other half of
 * the split, so between them every claimed action has exactly one thing entitled to answer it.
 */
function settleable(action: ImprovementAction): boolean {
  return action.state === 'ready-for-validation' && action.advice != null && action.controlIds.length === 0;
}

async function settle(
  action: ImprovementAction,
  advisory: Advisory,
  options: SettleOptions
): Promise<Settlement> {
  // Non-null: the caller filtered on it.
  const reading = adviceReadingOf(action.advice as NonNullable<ImprovementAction['advice']>, advisory);

  const claimedAt = claimedAtOf(action);
  // A claim with no date in the history cannot be measured against anything — the same refusal
  // `whyNotRequestable` makes, and for the same reason: an advisory accepted against no date would
  // settle a claim it may well predate.
  if (claimedAt == null || advisory.finishedAt.getTime() <= claimedAt.getTime()) return NOTHING;

  if (reading.standing === 'still-firing') return { ...NOTHING, read: 1, firing: 1 };
  if (reading.standing !== 'cleared') return { ...NOTHING, read: 1, unreadable: 1 };

  const written = await verify(action, advisory, options);
  return { ...NOTHING, read: 1, ...(written ? { cleared: 1 } : { stalled: 1 }) };
}

/**
 * Marks the action verified by this advisory, retrying once if somebody wrote it meanwhile.
 *
 * Once rather than in a loop, and reporting rather than raising, for the reasons `validate/resolve.ts`
 * gives about the same two decisions. The difference from that one is what a failure leaves behind:
 * there, a passed attempt sits on the record saying the work held. Here nothing is written at all, and
 * the action reads `agreed` from the same advisory on the next page load — so the visible state is
 * right and only the transition is missing, until the next advisory writes it.
 */
async function verify(action: ImprovementAction, advisory: Advisory, options: SettleOptions): Promise<boolean> {
  const scope = advisory.definition?.id ?? null;

  for (const remaining of [1, 0]) {
    try {
      const current = remaining === 1 ? action : await options.improvements.action(action.id, scope);
      // Somebody moved it between the reading and this write, or gave it a requirement, which moves it
      // to the other pass. Their change is the newer fact about the action, and the advisory beside it
      // is still readable by anybody who opens the action.
      if (current == null || !settleable(current)) return false;

      const plan = await options.improvements.plan(current.planId, scope);
      if (plan == null) {
        options.onError?.(
          `settle action ${current.id}`,
          new Error(`Action ${current.id} names plan ${current.planId}, which is not in the record.`)
        );
        return false;
      }

      await options.improvements.changeAction(clearedBy(current, advisory.id, advisory.finishedAt), plan);
      return true;
    } catch (error) {
      if (error instanceof ConcurrentChangeError && remaining > 0) continue;
      options.onError?.(`settle action ${action.id}`, error);
      return false;
    }
  }
  return false;
}
