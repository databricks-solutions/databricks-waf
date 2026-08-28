// Whether a query shape got worse, or was always like this.
//
// Four named classes, from `docs/plans/high-value-gaps.md` Part B. Naming them is the point: a reader
// told a query is slow has one question, and it is whether this is new. "It regressed on Tuesday" and
// "it has always taken four minutes" lead to completely different afternoons, and a page that says
// "slow" to both is making the reader go and find out which.
//
// # The window this can see is fifteen days at most, and the surface must not imply more
//
// The advisor reads at most thirty days, enforced in the statement's own `WHERE`. The prior window comes
// out of the same thirty, so the comparison is at most fifteen days against fifteen — fourteen against
// fourteen by default. A quarter-over-quarter trend is not available at this bound. `classify` is
// therefore about a fortnight and nothing longer, and `Trend.window` is not a parameter it has: the
// caller knows the lookback and the surface says it.

import type { QueryShapeRow } from '../collect/sql/shapes.js';

/**
 * How a shape's cost is moving.
 *
 * `regression` — measurably worse than the prior window. The one that wants attention today.
 * `chronic` — as expensive before as now. Nothing broke; this is what it costs.
 * `volatile` — moving in both directions between windows, so a single comparison does not describe it.
 * `improving` — measurably better. Reported because a reader who changed something deserves to see it.
 * `new` — no prior window at all, so there is nothing to compare against.
 * `unmeasured` — the current window has no measured run, which happens when every run failed or was
 *   served from cache. Distinct from `new`, because "it did not run" and "it ran and we could not time
 *   it" are different facts and only the second is a caveat on the numbers beside it.
 */
export type TrendClass = 'regression' | 'chronic' | 'volatile' | 'improving' | 'new' | 'unmeasured';

export interface Trend {
  readonly kind: TrendClass;
  /** Mean duration now over mean duration before. Absent where either window has no measured run. */
  readonly ratio?: number;
  readonly meanMsNow?: number;
  readonly meanMsBefore?: number;
  /** Run counts, because a shape run twice as often is not a shape that got slower. */
  readonly runsNow: number;
  readonly runsBefore: number;
}

/**
 * How much the mean has to move to count as a change.
 *
 * Twenty-five per cent, and generous on purpose. The comparison is a fortnight of a production estate
 * against the fortnight before it, where the data volume, the concurrent load and the warehouse's own
 * scaling all move underneath the query — so a ten per cent difference between two windows is the normal
 * state of a healthy shape, and a rule that called it a regression would classify most of the estate as
 * regressing every time anybody looked.
 */
const CHANGE = 0.25;

/**
 * How unstable the shape has to be, run to run, before a single comparison stops describing it.
 *
 * The worst run over the median, within the current window. A shape whose slowest execution is eight
 * times its typical one is not usefully described by "its mean went up 30%": the mean moved because the
 * spread is enormous, and the reader should be told that rather than given a direction.
 *
 * Checked before the direction, which is the ordering that matters. Classifying first and testing
 * stability second would report a confident regression on a shape whose two windows differ by less than
 * its own runs differ from each other.
 */
const SPREAD = 8;

export function classify(row: QueryShapeRow): Trend {
  const counts = { runsNow: row.runsNow, runsBefore: row.runsBefore };

  if (row.measuredNow === 0) return { kind: 'unmeasured', ...counts };
  if (row.runsBefore === 0 || row.measuredBefore === 0) return { kind: 'new', ...counts };

  const now = row.meanMsNow;
  const before = row.meanMsBefore;
  if (now == null || before == null || before <= 0) return { kind: 'new', ...counts };

  const ratio = now / before;
  const measured = { ratio: round(ratio), meanMsNow: now, meanMsBefore: before, ...counts };

  // Before the direction, deliberately. See SPREAD.
  if (unstable(row)) return { kind: 'volatile', ...measured };
  if (ratio >= 1 + CHANGE) return { kind: 'regression', ...measured };
  if (ratio <= 1 - CHANGE) return { kind: 'improving', ...measured };
  return { kind: 'chronic', ...measured };
}

/**
 * Whether the shape's own runs vary more than its windows do.
 *
 * Needs both the median and the worst, and both are absent on a shape with no measured run — which
 * `classify` has already returned for by the time this is called, so the guard here is for a shape the
 * platform recorded a count for and no timings, rather than dead code.
 */
function unstable(row: QueryShapeRow): boolean {
  const median = row.medianMs;
  const worst = row.worstMs;
  if (median == null || worst == null || median <= 0) return false;
  return worst / median >= SPREAD;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
