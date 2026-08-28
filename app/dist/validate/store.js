import { newestFirst } from "./attempt.js";
//#region server/validate/store.ts
/**
* Raised when something else answered an attempt first.
*
* Its own class rather than a generic conflict, because the caller's response is specific: the
* resolution path treats it as somebody else's success and moves on, where a route surfaces it. Named
* for what happened rather than for the constraint that caught it — "duplicate key on
* validation_attempts" tells whoever reads the log nothing about validations.
*/
var AlreadyAnsweredError = class extends Error {
	id;
	constructor(id) {
		super(`Validation ${id} was answered by something else first. Re-read it rather than answering again.`);
		this.id = id;
		this.name = "AlreadyAnsweredError";
	}
};
/**
* Attempts in memory, for a demo and for tests.
*
* Keyed by id with the answered row replacing the outstanding one, which is what the two Postgres rows
* amount to on read. The revision is not modelled here for the same reason it is not stored: there are
* two states and the record shows which it is in.
*/
var InMemoryValidationStore = class {
	durable = false;
	attempts = /* @__PURE__ */ new Map();
	for(actionId) {
		return Promise.resolve(newestFirst([...this.attempts.values()].filter((attempt) => attempt.actionId === actionId)));
	}
	outstanding() {
		return Promise.resolve(newestFirst([...this.attempts.values()].filter((attempt) => attempt.answer == null)));
	}
	add(attempt) {
		this.attempts.set(attempt.id, attempt);
		return Promise.resolve();
	}
	answer(attempt) {
		if (this.attempts.get(attempt.id)?.answer != null) return Promise.reject(new AlreadyAnsweredError(attempt.id));
		this.attempts.set(attempt.id, attempt);
		return Promise.resolve();
	}
};
//#endregion
export { AlreadyAnsweredError, InMemoryValidationStore };
