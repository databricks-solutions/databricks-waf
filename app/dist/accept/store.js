import { inScope } from "../store/assessment-scope.js";
import { newestFirst } from "./risk.js";
//#region server/accept/store.ts
/**
* Raised when an acceptance was revoked by somebody else first.
*
* Its own class rather than a generic conflict, so a route can answer 409 with the record's own words
* instead of a stack trace about a primary key.
*/
var AlreadyRevokedError = class extends Error {
	id;
	constructor(id) {
		super(`Accepted risk ${id} was revoked by something else first. Re-read it rather than revoking it again — the reason and the date on record are the ones that count.`);
		this.id = id;
		this.name = "AlreadyRevokedError";
	}
};
/**
* Raised when somebody else recorded the same acceptance of the same requirement first.
*
* The rule `riskFrom` enforces on read is enforced again here on write, by the database rather than by
* this app: two people accepting one requirement in the same second both read nothing standing and both
* write the first acceptance of it. Refusing the second is what keeps one requirement from carrying two
* acceptances with two owners, two reasons and two expiry dates, neither of which is the one in force.
*/
var AlreadyAcceptedError = class extends Error {
	controlId;
	constructor(controlId) {
		super(`Another acceptance of ${controlId} was recorded first, so this one was not. Read what is on record — the requirement may already be accepted by somebody else, with a different owner and a different date.`);
		this.controlId = controlId;
		this.name = "AlreadyAcceptedError";
	}
};
/**
* Raised when the acceptances could not be read at all.
*
* Its own failure rather than an empty list, and the distinction is load-bearing rather than tidy: the
* caller deciding whether a requirement may be accepted asks this store what is already on record, and
* an unreadable answer read as "nothing" is how a second acceptance gets written over a standing one.
* The register has the weaker version of the same problem — an estate with no exceptions and an estate
* whose exceptions cannot be read look identical, and only one of them is good news.
*/
var RisksUnreadableError = class extends Error {
	cause;
	constructor(operation, cause) {
		super(`The accepted risks could not be read (${operation}), so nothing here can say whether a requirement is already accepted. Try again once the database is reachable.`);
		this.cause = cause;
		this.name = "RisksUnreadableError";
	}
};
/**
* Acceptances in memory, for a demo and for tests.
*
* Keyed by id with the revoked row replacing the standing one, which is what the two Postgres rows
* amount to on read.
*/
var InMemoryRiskStore = class {
	durable = false;
	risks = /* @__PURE__ */ new Map();
	for(controlId, scope) {
		return Promise.resolve(newestFirst([...this.risks.values()].filter((risk) => risk.controlId === controlId && inScope(risk.definitionId, scope))));
	}
	all(scope) {
		return Promise.resolve(newestFirst([...this.risks.values()].filter((risk) => inScope(risk.definitionId, scope))));
	}
	record(risk) {
		if ([...this.risks.values()].some((one) => one.controlId === risk.controlId && one.ordinal === risk.ordinal && one.id !== risk.id && (one.definitionId ?? null) === (risk.definitionId ?? null))) return Promise.reject(new AlreadyAcceptedError(risk.controlId));
		this.risks.set(risk.id, risk);
		return Promise.resolve();
	}
	revoke(risk) {
		if (this.risks.get(risk.id)?.revoked != null) return Promise.reject(new AlreadyRevokedError(risk.id));
		this.risks.set(risk.id, risk);
		return Promise.resolve();
	}
};
//#endregion
export { AlreadyAcceptedError, AlreadyRevokedError, InMemoryRiskStore, RisksUnreadableError };
