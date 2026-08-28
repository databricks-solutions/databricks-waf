import { inScope } from "../store/assessment-scope.js";
import { newestFirstBy } from "../store/ordering.js";
import { PostgresEventLog } from "../store/event-log.js";
//#region server/decide/store.ts
/** Newest first, breaking ties by the supersession chain. See `newestFirstBy`. */
function newestFirst(decisions) {
	return newestFirstBy(decisions, (decision) => decision.decidedAt);
}
var InMemoryDecisionStore = class {
	durable = false;
	events = [];
	current(scope) {
		const newest = /* @__PURE__ */ new Map();
		for (const decision of newestFirst(this.events)) {
			if (!inScope(decision.definitionId, scope)) continue;
			if (!newest.has(decision.controlId)) newest.set(decision.controlId, decision);
		}
		return Promise.resolve([...newest.values()]);
	}
	historyFor(controlId, scope) {
		return Promise.resolve(newestFirst(this.events.filter((event) => event.controlId === controlId && inScope(event.definitionId, scope))));
	}
	record(decision) {
		this.events.push(decision);
		return Promise.resolve();
	}
};
var PostgresDecisionStore = class {
	durable = true;
	log;
	constructor(options) {
		this.log = new PostgresEventLog({
			db: options.db,
			table: "decisions",
			stampColumn: "decided_at",
			stampOf: (decision) => decision.decidedAt,
			revive,
			noun: "decision",
			...options.onError ? { onError: options.onError } : {}
		});
	}
	current(scope) {
		return this.log.current(scope);
	}
	historyFor(controlId, scope) {
		return this.log.historyFor(controlId, scope);
	}
	record(decision) {
		return this.log.append(decision);
	}
};
/**
* A stored record back into a domain object, with its dates restored.
*
* `until` is optional and its absence is meaningful — a fix claim has no date — so a missing one
* passes and an unparseable one fails. A record whose dates do not parse would be current or
* lapsed depending on where it was read, so it is treated as unreadable rather than guessed at.
*/
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	const decidedAt = new Date(candidate.decidedAt);
	if (Number.isNaN(decidedAt.getTime())) return void 0;
	if (typeof candidate.controlId !== "string" || typeof candidate.reason !== "string") return void 0;
	if (candidate.until == null) return {
		...candidate,
		decidedAt,
		until: void 0
	};
	const until = new Date(candidate.until);
	if (Number.isNaN(until.getTime())) return void 0;
	return {
		...candidate,
		decidedAt,
		until
	};
}
//#endregion
export { InMemoryDecisionStore, PostgresDecisionStore, newestFirst };
