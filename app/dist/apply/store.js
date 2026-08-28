//#region server/apply/store.ts
/**
* Raised when a decision was revoked by somebody else first.
*
* Its own class rather than a generic conflict, so a route can answer 409 with the record's own words
* instead of a stack trace about a primary key.
*/
var AlreadyRevokedError = class extends Error {
	id;
	constructor(id) {
		super(`Applicability decision ${id} was revoked by something else first. Re-read it rather than revoking it again — the reason and the date on record are the ones that count.`);
		this.id = id;
		this.name = "AlreadyRevokedError";
	}
};
/**
* Raised when somebody else recorded the same decision on the same requirement first.
*
* The rule `applicabilityFrom` enforces on read is enforced again here on write, by the database: two
* people excluding one requirement in the same second both read nothing standing and both write the
* first decision on it. Refusing the second keeps one requirement from carrying two decisions with two
* owners and two expiry dates, neither of which is the one in force.
*/
var AlreadyDecidedError = class extends Error {
	controlId;
	constructor(controlId) {
		super(`Another applicability decision on ${controlId} was recorded first, so this one was not. Read what is on record — the requirement may already be excluded by somebody else, with a different owner and a different date.`);
		this.controlId = controlId;
		this.name = "AlreadyDecidedError";
	}
};
/**
* Raised when a decision is recorded under an id already on record.
*
* Nothing legitimate produces one: the id is minted server-side per request, so a retry mints a new one
* and a repeated id is a bug or a replayed write. It is refused rather than allowed to replace, because
* the record it would replace carries somebody's reason, owner and expiry — and the two stores disagreed
* about this, Postgres refusing on its primary key while the in-memory one overwrote, under a shared test
* that swallowed the difference.
*/
var DecisionIdReusedError = class extends Error {
	id;
	constructor(id) {
		super(`An applicability decision with id ${id} is already on record, so this write was refused rather than replacing it. Ids are minted per request, so this is a repeated write rather than a second decision.`);
		this.id = id;
		this.name = "DecisionIdReusedError";
	}
};
/**
* Raised when the decisions could not be read at all.
*
* Its own failure rather than an empty list, and the distinction is load-bearing rather than tidy: the
* caller deciding whether a requirement may be excluded asks this store what is already on record, and
* an unreadable answer read as "nothing" is how a second decision gets written over a standing one. It
* also decides what leaves the score, so an unreadable read taken for "nothing excluded" would put a
* requirement back into a figure a customer had deliberately taken it out of.
*/
var DecisionsUnreadableError = class extends Error {
	cause;
	constructor(operation, cause) {
		super(`The applicability decisions could not be read (${operation}), so nothing here can say whether a requirement is already excluded. Try again once the database is reachable.`);
		this.cause = cause;
		this.name = "DecisionsUnreadableError";
	}
};
//#endregion
export { AlreadyDecidedError, AlreadyRevokedError, DecisionIdReusedError, DecisionsUnreadableError };
