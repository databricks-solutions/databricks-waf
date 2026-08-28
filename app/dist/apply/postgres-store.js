import { digestOf } from "../records/digest.js";
import { applyScope } from "../store/assessment-scope.js";
import { newestFirst } from "./applicability.js";
import { AlreadyDecidedError, AlreadyRevokedError, DecisionIdReusedError, DecisionsUnreadableError } from "./store.js";
//#region server/apply/postgres-store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
var PostgresApplicabilityStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async for(controlId, scope) {
		const operation = `read applicability decisions for ${controlId}`;
		const scoped = applyScope("where control_id = $1 order by revision asc", [controlId], scope);
		const rows = await this.read(operation, `select body from ${this.options.db.schema}.applicability_decisions ${scoped.fragment}`, scoped.values);
		return newestFirst(this.highest(rows.map((row) => row.body), operation));
	}
	async all(scope) {
		const operation = "read applicability decisions";
		const scoped = applyScope("order by revision asc", [], scope);
		const rows = await this.read(operation, `select body from ${this.options.db.schema}.applicability_decisions ${scoped.fragment}`, scoped.values);
		return newestFirst(this.highest(rows.map((row) => row.body), operation));
	}
	record(decision) {
		return this.write(decision);
	}
	revoke(decision) {
		return this.write(decision);
	}
	async write(decision) {
		const { db } = this.options;
		const isRevoked = decision.revoked != null;
		const revision = isRevoked ? 1 : 0;
		try {
			await db.query(`insert into ${db.schema}.applicability_decisions
           (id, revision, control_id, lever, ordinal, owner, effective_from, expires_at, recorded_at,
            revoked, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`, [
				decision.id,
				revision,
				decision.controlId,
				decision.lever,
				decision.ordinal,
				decision.owner,
				decision.effectiveFrom,
				decision.expiresAt,
				decision.recordedAt,
				isRevoked,
				JSON.stringify(decision),
				digestOf(decision),
				decision.definitionId ?? null
			]);
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			if (!onTheKey(error)) throw new AlreadyDecidedError(decision.controlId);
			if (isRevoked) throw new AlreadyRevokedError(decision.id);
			throw new DecisionIdReusedError(decision.id);
		}
	}
	/**
	* A read, or a raised failure.
	*
	* Reported *and* raised, unlike the history stores here and for the reason the accepted-risk store
	* gives: a caller deciding whether a requirement may be excluded asks this store what is on record,
	* and an unreadable answer read as "nothing excluded" is how a second decision gets written over a
	* standing one — and, once 31f wires it, how a requirement a customer took out of their score gets put
	* back into it because a column would not read.
	*/
	async read(operation, text, values) {
		try {
			const { rows } = await this.options.db.query(text, values);
			return rows;
		} catch (error) {
			this.options.onError?.(operation, error);
			throw new DecisionsUnreadableError(operation, error);
		}
	}
	/**
	* The newest readable revision of each decision, with unreadable rows counted rather than thrown on.
	*
	* An unreadable revocation row leaves the decision reading as standing, which keeps a requirement out
	* of the score on a decision somebody has already ended. That is the wrong direction, so it is
	* reported: whoever reads the log gets a count, and dropping the decision instead would put the
	* requirement back into the score with no record it had ever been excluded, which is worse in the same
	* way but silently.
	*/
	highest(rows, operation) {
		const revived = rows.map(revive);
		const unreadable = revived.filter((decision) => decision == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored applicability-decision row(s) could not be read`));
		const newest = /* @__PURE__ */ new Map();
		for (const decision of revived) if (decision != null) newest.set(decision.id, decision);
		return [...newest.values()];
	}
};
const LEVERS = /* @__PURE__ */ new Set(["not-applicable", "disabled"]);
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.controlId !== "string") return void 0;
	if (typeof candidate.reason !== "string" || typeof candidate.owner !== "string") return void 0;
	if (typeof candidate.recordedBy !== "string") return void 0;
	if (!LEVERS.has(candidate.lever)) return void 0;
	const effectiveFrom = date(candidate.effectiveFrom);
	const expiresAt = date(candidate.expiresAt);
	const recordedAt = date(candidate.recordedAt);
	if (effectiveFrom == null || expiresAt == null || recordedAt == null) return void 0;
	if (candidate.revoked == null) return {
		...candidate,
		effectiveFrom,
		expiresAt,
		recordedAt
	};
	const revokedAt = date(candidate.revoked.at);
	if (revokedAt == null) return void 0;
	return {
		...candidate,
		effectiveFrom,
		expiresAt,
		recordedAt,
		revoked: {
			...candidate.revoked,
			at: revokedAt
		}
	};
}
function date(value) {
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? void 0 : parsed;
}
function isUniqueViolation(error) {
	return typeof error === "object" && error != null && error.code === UNIQUE_VIOLATION;
}
/**
* Whether the violation was the primary key rather than the one-at-a-time constraint.
*
* By name, which Postgres sends, rather than by parsing the message. Anything that does not name a key
* is read as the other constraint: a violation this app cannot attribute is better reported as a lost
* race, which asks the caller to look, than as a repeated id, which asks them to file a bug.
*/
function onTheKey(error) {
	const constraint = error.constraint;
	return typeof constraint === "string" && constraint.endsWith("_pkey");
}
//#endregion
export { PostgresApplicabilityStore };
