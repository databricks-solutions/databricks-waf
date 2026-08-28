import { inScope } from "../store/assessment-scope.js";
//#region server/improve/store.ts
/**
* A write that lost a race.
*
* Raised rather than absorbed, because the two writers wanted different things. Somebody moved an
* action to `blocked` while somebody else moved it to `in-progress`; whichever arrives second is
* about to describe a transition from a state the action is no longer in, and the honest answer is
* to say so and let them re-read. Silently taking the newer write would leave the loser believing
* a thing they did had happened.
*/
var ConcurrentChangeError = class extends Error {
	kind;
	id;
	constructor(kind, id) {
		super(`This ${kind} changed while you were working on it. Re-read it and try again.`);
		this.kind = kind;
		this.id = id;
		this.name = "ConcurrentChangeError";
	}
};
/** A write of an action against a plan that is not the one it names. A programming mistake, not input. */
var MismatchedPlanError = class extends Error {
	constructor(action, plan) {
		super(`Action ${action.id} belongs to plan ${action.planId}, not ${plan.id}.`);
		this.name = "MismatchedPlanError";
	}
};
/**
* The revision a record is at, which the record carries.
*
* A function rather than a field read at four sites, so both implementations key on the same thing
* and the reason is written down once. It was briefly derived — an action's revision was the length
* of its history — and that was wrong as soon as a record could change without a transition: a
* correction to an owner or a date computes the revision it already had, and the store answers a
* lone author with somebody else's concurrency error. See `revision` on both records.
*/
function revisionOf(record) {
	return record.revision;
}
/** Newest first by creation, which is the only order a list of plans has. */
function newestFirst(plans) {
	return [...plans].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime());
}
/**
* The in-memory fallback.
*
* Keeps every revision like the durable one, rather than only the latest, so the two implementations
* refuse the same second write. A version that overwrote would let a test pass here and a race land
* in production.
*/
var InMemoryImprovementStore = class {
	durable = false;
	planRevisions = /* @__PURE__ */ new Map();
	actionRevisions = /* @__PURE__ */ new Map();
	plans(scope) {
		return Promise.resolve(newestFirst(latest(this.planRevisions.values(), (plan) => plan.id).filter((plan) => inScope(plan.assessment?.definitionId, scope))));
	}
	plan(id, scope) {
		const plan = latest(this.planRevisions.values(), (p) => p.id).find((one) => one.id === id);
		if (plan == null || !inScope(plan.assessment?.definitionId, scope)) return Promise.resolve(void 0);
		return Promise.resolve(plan);
	}
	addPlan(plan) {
		return this.write("plan", this.planRevisions, plan.id, plan);
	}
	changePlan(plan) {
		return this.write("plan", this.planRevisions, plan.id, plan);
	}
	actions(planId, scope) {
		return this.plan(planId, scope).then((plan) => {
			if (plan == null && scope !== void 0) return [];
			return this.currentActions().filter((action) => action.planId === planId);
		});
	}
	action(id, scope) {
		const action = this.currentActions().find((one) => one.id === id);
		if (action == null) return Promise.resolve(void 0);
		if (scope === void 0) return Promise.resolve(action);
		return this.plan(action.planId).then((plan) => {
			if (plan == null) return action;
			return inScope(plan.assessment?.definitionId, scope) ? action : void 0;
		});
	}
	actionsFor(controlId, scope) {
		const named = this.currentActions().filter((action) => action.controlIds.includes(controlId));
		if (scope === void 0) return Promise.resolve(named);
		const allowed = new Set(latest(this.planRevisions.values(), (plan) => plan.id).filter((plan) => inScope(plan.assessment?.definitionId, scope)).map((plan) => plan.id));
		return Promise.resolve(named.filter((action) => allowed.has(action.planId)));
	}
	actionsRaised(scope) {
		const current = this.currentActions();
		if (scope === void 0) return Promise.resolve(current);
		const allowed = new Set(latest(this.planRevisions.values(), (plan) => plan.id).filter((plan) => inScope(plan.assessment?.definitionId, scope)).map((plan) => plan.id));
		return Promise.resolve(current.filter((action) => allowed.has(action.planId)));
	}
	addAction(action, plan) {
		if (action.planId !== plan.id) return Promise.reject(new MismatchedPlanError(action, plan));
		return this.write("action", this.actionRevisions, action.id, action);
	}
	changeAction(action, plan) {
		if (action.planId !== plan.id) return Promise.reject(new MismatchedPlanError(action, plan));
		return this.write("action", this.actionRevisions, action.id, action);
	}
	currentActions() {
		return latest(this.actionRevisions.values(), (action) => action.id);
	}
	write(kind, revisions, id, record) {
		const key = `${id}\u0000${String(revisionOf(record))}`;
		if (revisions.has(key)) return Promise.reject(new ConcurrentChangeError(kind, id));
		revisions.set(key, record);
		return Promise.resolve();
	}
};
/** The highest revision of each record, out of every revision of all of them. */
function latest(revisions, idOf) {
	const newest = /* @__PURE__ */ new Map();
	for (const record of revisions) {
		const id = idOf(record);
		const held = newest.get(id);
		if (held == null || revisionOf(record) > revisionOf(held)) newest.set(id, record);
	}
	return [...newest.values()];
}
//#endregion
export { ConcurrentChangeError, InMemoryImprovementStore, MismatchedPlanError, newestFirst, revisionOf };
