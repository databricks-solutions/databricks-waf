/**
 * Saying so when this run could read plans and the last one could not, or the reverse.
 *
 * `33m` asked for an "alert when profile capability drops from the customer's baseline, because silently
 * degrading to system-table signals looks identical to having fewer findings". That is the whole reason
 * this exists: plan-level advice disappearing looks exactly like an estate with less to advise about.
 *
 * **There is deliberately no percentage threshold here, and that is the honest limit rather than a
 * simplification.** A rule of the form "alert when reach drops by more than a fifth" needs to know how much
 * run-to-run variation is normal, and nothing has measured that — the shapes themselves change between runs,
 * `shapeLimit` truncates a different 40 of them, and `33k` measured the reachable share on one estate on one
 * day. Picking a figure now would produce an alert whose threshold nobody could defend, on a surface where a
 * false alarm teaches the reader to ignore the true one. So this reports only the two transitions that need
 * no distribution to interpret: the fetch gave up part-way, or reach went from something to nothing.
 *
 * A measured distribution of normal variation is what a proportional alert waits for. It is a row of its own.
 */

import type { PlanCapabilityPayload } from '../../shared/api/contract.js';
import type { PlanRetrievalSummary } from '../collect/sql/plans/retrieve.js';

/**
 * What the alert compares against: the newest earlier run that established a baseline at all.
 *
 * A run whose warehouse list was refused is not a baseline. Its `available` is zero for a reason that is
 * about this app's permissions rather than about the estate, and taking it as normal would set a floor the
 * next run reads as unchanged — which is the failure mode the row named when it was split out.
 */
export interface PlanBaseline {
  readonly advisoryId: string;
  readonly plans: PlanRetrievalSummary;
}

/**
 * The alert, defined once in the contract and aliased here rather than declared twice.
 *
 * It is passed to the client verbatim — `advisoryPayload` spreads it without presenting it — so a second
 * declaration would be a copy of the same shape kept in step by hand. The compiler would catch it drifting:
 * a member added to one side and not the other fails `npm run typecheck` at `advisory-routes.ts`, checked by
 * doing exactly that. One declaration is for the simpler reason that there is nothing here to translate.
 */
export type PlanCapabilityAlert = PlanCapabilityPayload;

/**
 * How many shapes a request was actually issued for.
 *
 * Deliberately excludes `abandoned` and `notRun`. Those are shapes nothing was asked about — the first by
 * the breaker, the second by cancellation or a spent budget — and counting them as asked was how a
 * cancelled run came to look like an endpoint answering nothing.
 */
function asked(plans: PlanRetrievalSummary): number {
  return plans.available + plans.withoutPlan + plans.failed;
}

/**
 * True where this summary is fit to be a later run's baseline.
 *
 * Reach, not merely activity. A run that read no plans establishes no floor to fall from, and taking one as
 * the baseline would silence the alert for the run after it while the older run that did have reach is never
 * reached — the same floor a refused warehouse list would set, arriving by a different cause.
 */
export function isBaseline(plans: PlanRetrievalSummary): boolean {
  return plans.warehousesKnown && plans.available > 0;
}

/**
 * The one thing worth saying about this run's plan reach, or nothing.
 *
 * Ordered by what a reader can act on. `cannot-tell` comes first because it makes every other reading
 * uninformative, and `gave-up` outranks `lost-reach` because it names the cause of whatever was not read.
 * It does not imply nothing was read: the branch fires whenever any shape was abandoned, and a run can
 * abandon some shapes and still return plans for others.
 */
export function planCapability(
  plans: PlanRetrievalSummary | undefined,
  baseline: PlanBaseline | undefined
): PlanCapabilityAlert | undefined {
  if (plans == null) return undefined;
  if (!plans.warehousesKnown) return { kind: 'cannot-tell' };
  if (plans.abandoned > 0) return { kind: 'gave-up', failed: plans.failed, abandoned: plans.abandoned };

  if (baseline == null || baseline.plans.available === 0) return undefined;
  if (plans.available > 0 || asked(plans) === 0) return undefined;
  return { kind: 'lost-reach', baselineAdvisoryId: baseline.advisoryId, baselineAvailable: baseline.plans.available };
}
