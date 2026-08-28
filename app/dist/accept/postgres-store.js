import { digestOf } from "../records/digest.js";
import { applyScope } from "../store/assessment-scope.js";
import { newestFirst } from "./risk.js";
import { AlreadyAcceptedError, AlreadyRevokedError, RisksUnreadableError } from "./store.js";
//#region server/accept/postgres-store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
var PostgresRiskStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async for(controlId, scope) {
		const operation = `read accepted risks for ${controlId}`;
		const scoped = applyScope("where control_id = $1 order by revision asc", [controlId], scope);
		const rows = await this.read(operation, `select body from ${this.options.db.schema}.accepted_risks ${scoped.fragment}`, scoped.values);
		return newestFirst(this.highest(rows.map((row) => row.body), operation));
	}
	async all(scope) {
		const operation = "read accepted risks";
		const scoped = applyScope("order by revision asc", [], scope);
		const rows = await this.read(operation, `select body from ${this.options.db.schema}.accepted_risks ${scoped.fragment}`, scoped.values);
		return newestFirst(this.highest(rows.map((row) => row.body), operation));
	}
	record(risk) {
		return this.write(risk);
	}
	revoke(risk) {
		return this.write(risk);
	}
	async write(risk) {
		const { db } = this.options;
		const isRevoked = risk.revoked != null;
		const revision = isRevoked ? 1 : 0;
		try {
			await db.query(`insert into ${db.schema}.accepted_risks
           (id, revision, control_id, ordinal, owner, residual, effective_from, expires_at, recorded_at,
            revoked, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb, $12, $13)`, [
				risk.id,
				revision,
				risk.controlId,
				risk.ordinal,
				risk.owner,
				risk.residual,
				risk.effectiveFrom,
				risk.expiresAt,
				risk.recordedAt,
				isRevoked,
				JSON.stringify(risk),
				digestOf(risk),
				risk.definitionId ?? null
			]);
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			if (!onTheKey(error)) throw new AlreadyAcceptedError(risk.controlId);
			if (isRevoked) throw new AlreadyRevokedError(risk.id);
			throw error;
		}
	}
	/**
	* A read, or a raised failure.
	*
	* Reported *and* raised, which is not how the other stores here behave and is deliberate. Every one of
	* them answers a failed read as an empty list, on the argument that a degraded history is better than
	* a broken page. That argument does not survive this record: a caller deciding whether a requirement
	* may be accepted asks this store what is already on record, and an unreadable answer read as
	* "nothing is accepted" is how a second acceptance gets written over a standing one — with a different
	* owner, a different reason and a different expiry, neither of them the one in force.
	*
	* The register has the weaker version of the same problem. An estate with no live exceptions and an
	* estate whose exceptions cannot be read look identical, and only one of them is good news.
	*/
	async read(operation, text, values) {
		try {
			const { rows } = await this.options.db.query(text, values);
			return rows;
		} catch (error) {
			this.options.onError?.(operation, error);
			throw new RisksUnreadableError(operation, error);
		}
	}
	/**
	* The newest readable revision of each acceptance, with unreadable rows counted rather than thrown on.
	*
	* An unreadable revocation row leaves the acceptance reading as standing, which is wrong in the
	* direction that keeps a finding parked. That is the wrong direction, so it is reported: whoever reads
	* the log gets a count, and the alternative — dropping the acceptance — would put the requirement back
	* on the queue with no record that it had ever been accepted, which is worse in the same way but
	* silently.
	*/
	highest(rows, operation) {
		const revived = rows.map(revive);
		const unreadable = revived.filter((risk) => risk == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored accepted-risk row(s) could not be read`));
		const newest = /* @__PURE__ */ new Map();
		for (const risk of revived) if (risk != null) newest.set(risk.id, risk);
		return [...newest.values()];
	}
};
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.controlId !== "string") return void 0;
	if (typeof candidate.reason !== "string" || typeof candidate.compensatingControl !== "string") return void 0;
	if (typeof candidate.owner !== "string" || typeof candidate.recordedBy !== "string") return void 0;
	if (typeof candidate.residual !== "string") return void 0;
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
export { PostgresRiskStore };
