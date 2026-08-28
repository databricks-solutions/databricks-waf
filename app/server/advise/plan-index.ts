// This run's plans, by the shape they belong to.
//
// The advisory run has retrieved plans since `33ma` and the analysis has never seen them: `runner.ts`
// called `retrievePlans` and `analyseWorkload` as siblings, summarised the first onto the record as counts,
// and passed the second only the shape rows. So six of the thirteen rules the design document names had no
// input and the extract had no reader. This is the join, and it is the whole of the plumbing in `33ib`.
//
// # One execution, not the window
//
// A shape row aggregates every run of a normalised statement across the window; a plan is one execution of
// it, the representative `workload_query_shapes.sql` nominated. So a plan-fed rule is reading a sample of
// one, and what it may say is bounded by that — a rule that reads an operator's duration is reading that
// execution's duration and not the shape's, and the words it fires have to say so. `33id` measures over the
// retained corpus instead, which is three executions per shape and a different question.
//
// # This run's plans, not the retained ones
//
// `33n` keeps three executions per shape in `plan_extracts`, and a rule could read them. It does not, for
// two reasons. `analyseWorkload` is synchronous and pure, and reaching a store from inside it would make
// every caller async to reach a row the run already has in memory. And the retained set spans runs, so a
// finding drawn from it would be about an execution from a fortnight ago while every other number on the
// row is about this window. What the retained corpus is for is measuring a threshold over more than one
// execution, which is `33id`.

import { shapeMapKey, type ShapeKey, type ShapePlan } from '../collect/sql/plans/retrieve.js';
import type { PlanExtract } from '../collect/sql/plans/parse.js';

/**
 * The plans a shape's rules may read, looked up by workspace and shape.
 *
 * A map rather than a list because `findingsFor` is called per row and a scan per row is quadratic on an
 * estate with tens of thousands of shapes.
 */
export interface PlanIndex {
  /** The plan for one shape, or nothing where this run has none. */
  for: (key: ShapeKey) => ShapePlan | undefined;
  /** How many shapes have one. Reported so a test can tell an empty index from an unwired one. */
  readonly size: number;
}

const EMPTY: PlanIndex = { for: () => undefined, size: 0 };

/**
 * Indexes this run's plans.
 *
 * Keyed on the workspace as well as the shape, for the reason `ShapeKey` exists: the same statement text in
 * two workspaces is two rows sharing one `shape`, and `33k` measured that they end differently — the plan is
 * fetchable in the workspace that ran it and refused in its sibling. Keyed on the shape alone, a rule would
 * read the sibling's plan and report it against this workspace's row.
 *
 * A shape with two plans keeps the first. `retrievePlans` produces at most one per shape today, because the
 * SQL nominates one representative statement per row, so this is a tie-break nothing exercises rather than a
 * choice — and the alternative, overwriting, would make which plan a rule read depend on array order.
 */
export function planIndex(plans: readonly ShapePlan[] | undefined): PlanIndex {
  if (plans == null || plans.length === 0) return EMPTY;
  const byShape = new Map<string, ShapePlan>();
  for (const plan of plans) {
    const key = shapeMapKey(plan);
    if (!byShape.has(key)) byShape.set(key, plan);
  }
  return {
    for: (key) => byShape.get(shapeMapKey(key)),
    size: byShape.size,
  };
}

/** The empty index, for a run that retrieved no plans and for every caller that has none to give. */
export function noPlans(): PlanIndex {
  return EMPTY;
}

/**
 * What a rule reads off a plan.
 *
 * One field, and a named type rather than the extract itself, because the plan a rule reads is not only its
 * operators: which execution it was is on `ShapePlan` and does not come through here. That is deliberate and
 * narrow — nothing renders a date today (`Evidence` is a number and a unit), and a field passed to conditions
 * that none of them reads is a field whose justification cannot be checked. It goes in when a rule needs it
 * and a surface can show it.
 */
export interface PlanReading {
  readonly extract: PlanExtract;
}

/** The reading for one shape, or nothing. What a condition is handed. */
export function readingFor(index: PlanIndex, key: ShapeKey): PlanReading | undefined {
  const plan = index.for(key);
  if (plan == null) return undefined;
  return { extract: plan.extract };
}
