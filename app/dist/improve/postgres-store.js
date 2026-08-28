import { digestOf } from "../records/digest.js";
import { applyScope, inScope } from "../store/assessment-scope.js";
import { ConcurrentChangeError, MismatchedPlanError, newestFirst, revisionOf } from "./store.js";
//#region server/improve/postgres-store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
var PostgresImprovementStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async plans(scope) {
		const scoped = applyScope("", [], scope);
		return newestFirst(highest((await this.read("read every plan", "improvement_plans", scoped.fragment, scoped.values)).map(revivePlan), (plan) => plan.id, this.reporter("read every plan")));
	}
	async plan(id, scope) {
		const scoped = applyScope("where id = $1", [id], scope);
		return highest((await this.read(`read plan ${id}`, "improvement_plans", scoped.fragment, scoped.values)).map(revivePlan), (plan) => plan.id, this.reporter(`read plan ${id}`))[0];
	}
	addPlan(plan) {
		return this.writePlan(plan);
	}
	changePlan(plan) {
		return this.writePlan(plan);
	}
	async actions(planId, scope) {
		if (scope !== void 0) {
			if (await this.plan(planId, scope) == null) return [];
		}
		const operation = `read actions of plan ${planId}`;
		return highest((await this.read(operation, "improvement_actions", "where plan_id = $1", [planId])).map(reviveAction), (action) => action.id, this.reporter(operation));
	}
	async action(id, scope) {
		const action = highest((await this.read(`read action ${id}`, "improvement_actions", "where id = $1", [id])).map(reviveAction), (action) => action.id, this.reporter(`read action ${id}`))[0];
		if (action == null || scope === void 0) return action;
		const plan = await this.plan(action.planId);
		if (plan == null) return action;
		return inScope(plan.assessment?.definitionId, scope) ? action : void 0;
	}
	async actionsFor(controlId, scope) {
		const operation = `read actions naming ${controlId}`;
		const candidates = await this.naming(operation, controlId);
		if (candidates.length === 0) return [];
		const named = highest((await this.read(operation, "improvement_actions", "where id = any($1::text[])", [candidates])).map(reviveAction), (action) => action.id, this.reporter(operation)).filter((action) => action.controlIds.includes(controlId));
		if (scope === void 0) return named;
		const plans = await this.plans(scope);
		const allowed = new Set(plans.map((plan) => plan.id));
		return named.filter((action) => allowed.has(action.planId));
	}
	async actionsRaised(scope) {
		const plans = await this.plans(scope);
		return (await Promise.all(plans.map((plan) => this.actions(plan.id, scope)))).flat();
	}
	addAction(action, plan) {
		return this.writeAction(action, plan);
	}
	changeAction(action, plan) {
		return this.writeAction(action, plan);
	}
	async writePlan(plan) {
		const { db } = this.options;
		const revision = revisionOf(plan);
		const changedAt = plan.closed?.at ?? plan.createdAt;
		await this.insert("plan", plan.id, () => db.query(`insert into ${db.schema}.improvement_plans
           (id, revision, created_at, changed_at, body, digest, definition_id)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7)`, [
			plan.id,
			revision,
			plan.createdAt,
			changedAt,
			JSON.stringify(plan),
			digestOf(plan),
			plan.assessment?.definitionId ?? null
		]));
	}
	async writeAction(action, plan) {
		if (action.planId !== plan.id) throw new MismatchedPlanError(action, plan);
		const { db } = this.options;
		const revision = revisionOf(action);
		const changedAt = action.history.at(-1)?.at ?? action.createdAt;
		await this.insert("action", action.id, () => db.query(`insert into ${db.schema}.improvement_actions
           (id, revision, plan_id, plan_created_at, created_at, changed_at, body, digest)
           values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)`, [
			action.id,
			revision,
			action.planId,
			plan.createdAt,
			action.createdAt,
			changedAt,
			JSON.stringify(action),
			digestOf(action)
		]));
	}
	async insert(kind, id, write) {
		try {
			await write();
		} catch (error) {
			if (isUniqueViolation(error)) throw new ConcurrentChangeError(kind, id);
			throw error;
		}
	}
	/**
	* The ids of the actions any revision of which names this requirement.
	*
	* Answered from `improvement_actions_by_control`, and a failure reads as none — the same shape as
	* `read` below, for the same reason: a requirement page missing its actions and saying so is
	* better than one that will not render.
	*/
	async naming(operation, controlId) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select distinct id from ${db.schema}.improvement_actions
           where body -> 'controlIds' @> to_jsonb($1::text)`, [controlId]);
			return rows.map((row) => row.id);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async read(operation, table, where, values) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select body from ${db.schema}.${table} ${where} order by revision asc`, values);
			return rows.map((row) => row.body);
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	reporter(operation) {
		return (unreadable, noun) => {
			this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored ${noun} row(s) could not be read`));
		};
	}
};
/**
* The highest revision of each record, with unreadable rows counted rather than thrown on.
*
* A row that will not revive is skipped, which for a record with several revisions means the newest
* readable one is used. That is the right failure: a plan whose closure row is unreadable reads as
* open, which is visible and wrong in the safe direction, where dropping the plan entirely would
* lose the actions hanging off it.
*/
function highest(revived, idOf, report) {
	const unreadable = revived.filter((record) => record == null).length;
	if (unreadable > 0) report(unreadable, "improvement");
	const newest = /* @__PURE__ */ new Map();
	for (const record of revived) {
		if (record == null) continue;
		newest.set(idOf(record), record);
	}
	return [...newest.values()];
}
function revivePlan(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.title !== "string") return void 0;
	if (typeof candidate.revision !== "number") return void 0;
	const createdAt = date(candidate.createdAt);
	if (createdAt == null) return void 0;
	if (candidate.closed == null) return {
		...candidate,
		createdAt
	};
	const closedAt = date(candidate.closed.at);
	if (closedAt == null) return void 0;
	return {
		...candidate,
		createdAt,
		closed: {
			...candidate.closed,
			at: closedAt
		}
	};
}
function reviveAction(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.planId !== "string") return void 0;
	if (typeof candidate.revision !== "number") return void 0;
	if (!Array.isArray(candidate.history)) return void 0;
	const stored = candidate.history;
	const createdAt = date(candidate.createdAt);
	if (createdAt == null) return void 0;
	const history = [];
	for (const transition of stored) {
		const at = date(transition.at);
		if (at == null) return void 0;
		history.push({
			...transition,
			at
		});
	}
	const due = candidate.due == null ? void 0 : date(candidate.due);
	if (candidate.due != null && due == null) return void 0;
	const advice = reviveAdvice(candidate.advice);
	if (candidate.advice != null && advice == null) return void 0;
	return {
		...candidate,
		createdAt,
		history,
		...due == null ? {} : { due },
		...advice == null ? {} : { advice }
	};
}
function reviveAdvice(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.advisoryId !== "string" || typeof candidate.rule !== "string") return void 0;
	const measuredAt = date(candidate.measuredAt);
	if (measuredAt == null) return void 0;
	return {
		...candidate,
		measuredAt
	};
}
function date(value) {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? void 0 : parsed;
}
function isUniqueViolation(error) {
	return typeof error === "object" && error != null && error.code === UNIQUE_VIOLATION;
}
//#endregion
export { PostgresImprovementStore };
