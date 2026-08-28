import { shapeMapKey } from "../collect/sql/plans/retrieve.js";
//#region server/advise/plan-index.ts
const EMPTY = {
	for: () => void 0,
	size: 0
};
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
function planIndex(plans) {
	if (plans == null || plans.length === 0) return EMPTY;
	const byShape = /* @__PURE__ */ new Map();
	for (const plan of plans) {
		const key = shapeMapKey(plan);
		if (!byShape.has(key)) byShape.set(key, plan);
	}
	return {
		for: (key) => byShape.get(shapeMapKey(key)),
		size: byShape.size
	};
}
/** The empty index, for a run that retrieved no plans and for every caller that has none to give. */
function noPlans() {
	return EMPTY;
}
/** The reading for one shape, or nothing. What a condition is handed. */
function readingFor(index, key) {
	const plan = index.for(key);
	if (plan == null) return void 0;
	return { extract: plan.extract };
}
//#endregion
export { noPlans, planIndex, readingFor };
