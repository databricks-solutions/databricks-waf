import { parsePlanResponse } from "./parse.js";
import { planCandidates } from "./retrievable.js";
import { PlanBreaker } from "./breaker.js";
//#region server/collect/sql/plans/retrieve.ts
/**
* The two fields together, as a map key. Neither can hold the separator: both are ids.
*
* Exported because `plan-index.ts` keys the same pair for the analysis, and a second spelling of a key is a
* second place for the reasoning above to be wrong.
*/
function shapeMapKey(row) {
	return `${row.workspaceId}\u0000${row.shape}`;
}
function summarise(retrieval) {
	const skipped = {};
	let available = 0;
	let withoutPlan = 0;
	let failed = 0;
	let abandoned = 0;
	let notRun = 0;
	for (const attempt of retrieval.attempts) if (attempt.kind === "skipped") skipped[attempt.reason] = (skipped[attempt.reason] ?? 0) + 1;
	else if (attempt.kind === "failed") failed += 1;
	else if (attempt.kind === "abandoned") abandoned += 1;
	else if (attempt.kind === "not-run") notRun += 1;
	else if (attempt.parsed.outcome === "available") available += 1;
	else withoutPlan += 1;
	return {
		available,
		withoutPlan,
		skipped,
		failed,
		abandoned,
		notRun,
		warehousesKnown: retrieval.warehousesKnown
	};
}
/**
* Fetches a plan per shape, bounded by the scheduler and pre-filtered by `retrievable.ts`.
*
* Every fetch goes through `scheduler.run` on the `plans` surface, which is what applies the concurrency
* bound, the budget, the retry policy and cancellation. Calling `fetcher.plan` directly would opt out of
* all four, which is the mistake `ADR 0010` exists to prevent.
*/
async function retrievePlans(options) {
	const { shapes, localWarehouseIds, warehousesKnown, fetcher, scheduler } = options;
	const { fetch: candidates, skipped } = planCandidates(shapes, localWarehouseIds);
	const attempts = /* @__PURE__ */ new Map();
	for (const { shape, reason } of skipped) {
		const at = {
			workspaceId: shape.workspaceId,
			shape: shape.shape
		};
		attempts.set(shapeMapKey(shape), !warehousesKnown && reason === "warehouse-outside-workspace" ? {
			kind: "not-run",
			...at,
			detail: "the workspace warehouse list was not read"
		} : {
			kind: "skipped",
			...at,
			reason
		});
	}
	const plans = [];
	const breaker = options.breaker ?? new PlanBreaker();
	const fetched = await Promise.all(candidates.map(async (shape) => {
		const outcome = await scheduler.run({
			surface: "plans",
			label: `plan ${shape.shape}`,
			skipWhen: () => breaker.open() ? "the query history endpoint stopped answering" : void 0,
			run: (signal) => fetcher.plan(shape.statementId, signal)
		});
		if (outcome.status === "ok") breaker.answered();
		else if (outcome.status === "failed") breaker.failed();
		return {
			shape,
			outcome
		};
	}));
	for (const { shape, outcome } of fetched) {
		const at = {
			workspaceId: shape.workspaceId,
			shape: shape.shape
		};
		if (outcome.status === "ok") {
			const parsed = parsePlanResponse(outcome.value.status, outcome.value.body);
			attempts.set(shapeMapKey(shape), {
				kind: "parsed",
				...at,
				parsed
			});
			if (parsed.outcome === "available") plans.push({
				...at,
				statementId: shape.statementId,
				extract: parsed.extract,
				...shape.representativeAt != null ? { observedAt: shape.representativeAt } : {}
			});
			continue;
		}
		if (outcome.status === "failed") {
			attempts.set(shapeMapKey(shape), {
				kind: "failed",
				...at,
				detail: outcome.failure.message
			});
			continue;
		}
		attempts.set(shapeMapKey(shape), outcome.reason === "precondition" ? {
			kind: "abandoned",
			...at
		} : {
			kind: "not-run",
			...at,
			detail: outcome.detail
		});
	}
	return {
		plans,
		attempts: shapes.flatMap((shape) => {
			const attempt = attempts.get(shapeMapKey(shape));
			return attempt == null ? [] : [attempt];
		}),
		warehousesKnown
	};
}
//#endregion
export { retrievePlans, shapeMapKey, summarise };
