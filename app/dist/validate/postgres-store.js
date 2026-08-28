import { digestOf } from "../records/digest.js";
import { newestFirst } from "./attempt.js";
import { AlreadyAnsweredError } from "./store.js";
//#region server/validate/postgres-store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
var PostgresValidationStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async for(actionId) {
		const operation = `read validations of action ${actionId}`;
		const rows = await this.read(operation, `select body from ${this.options.db.schema}.validation_attempts where action_id = $1 order by revision asc`, [actionId]);
		if (rows == null) return [];
		return newestFirst(this.highest(rows.map((row) => row.body), operation));
	}
	async outstanding() {
		const operation = "read outstanding validations";
		const { schema } = this.options.db;
		const requested = await this.read(operation, `select a.body
         from ${schema}.validation_attempts a
        where a.answered = $1
          and not exists (
                select 1
                  from ${schema}.validation_attempts b
                 where b.id = a.id
                   and b.answered = $2
              )
        order by a.revision asc`, [false, true]);
		if (requested == null) return [];
		return newestFirst(this.highest(requested.map((row) => row.body), operation).filter((attempt) => attempt.answer == null));
	}
	add(attempt) {
		return this.write(attempt);
	}
	answer(attempt) {
		return this.write(attempt);
	}
	async write(attempt) {
		const { db } = this.options;
		const answered = attempt.answer != null;
		const revision = answered ? 1 : 0;
		const planCreatedAt = await this.options.planCreatedAt?.(attempt.planId) ?? attempt.requestedAt;
		try {
			await db.query(`insert into ${db.schema}.validation_attempts
           (id, revision, action_id, plan_id, plan_created_at, requested_at, answered, body, digest)
           values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`, [
				attempt.id,
				revision,
				attempt.actionId,
				attempt.planId,
				planCreatedAt,
				attempt.requestedAt,
				answered,
				JSON.stringify(attempt),
				digestOf(attempt)
			]);
		} catch (error) {
			if (answered && isUniqueViolation(error)) throw new AlreadyAnsweredError(attempt.id);
			throw error;
		}
	}
	/**
	* A read, or undefined where it failed.
	*
	* Undefined rather than an empty list, because the two mean different things to the caller here:
	* `outstanding` reads twice and a failure of either has to stop the pass, where an empty result is
	* an answer. A failed read is reported through `onError` and nothing throws, as every other store
	* here behaves — the consequence being that a resolution pass which cannot read answers nothing and
	* the next run answers instead. Late is the right way for this to fail; the alternative is a scan's
	* own completion path holding an error about validations.
	*/
	async read(operation, text, values) {
		try {
			const { rows } = await this.options.db.query(text, values);
			return rows;
		} catch (error) {
			this.options.onError?.(operation, error);
			return;
		}
	}
	/**
	* The newest readable revision of each attempt, with unreadable rows counted rather than thrown on.
	*
	* An unreadable answer row leaves the attempt reading as outstanding, which is visible and wrong in
	* the safe direction: it will be offered to the next run, and answering it again writes the row that
	* would not revive. Dropping the attempt entirely would lose the record that a claim was ever
	* checked.
	*/
	highest(rows, operation) {
		const revived = rows.map(revive);
		const unreadable = revived.filter((attempt) => attempt == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored validation row(s) could not be read`));
		const newest = /* @__PURE__ */ new Map();
		for (const attempt of revived) if (attempt != null) newest.set(attempt.id, attempt);
		return [...newest.values()];
	}
};
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.actionId !== "string") return void 0;
	if (typeof candidate.planId !== "string" || typeof candidate.requestedBy !== "string") return void 0;
	if (typeof candidate.observeDays !== "number") return void 0;
	if (!Array.isArray(candidate.checks)) return void 0;
	if (candidate.checks.some((check) => typeof check.controlId !== "string" || typeof check.method !== "string")) return;
	const claimedAt = date(candidate.claimedAt);
	const requestedAt = date(candidate.requestedAt);
	const observeFrom = date(candidate.observeFrom);
	if (claimedAt == null || requestedAt == null || observeFrom == null) return void 0;
	if (candidate.answer == null) return {
		...candidate,
		claimedAt,
		requestedAt,
		observeFrom
	};
	const answeredAt = date(candidate.answer.at);
	if (answeredAt == null) return void 0;
	return {
		...candidate,
		claimedAt,
		requestedAt,
		observeFrom,
		answer: {
			...candidate.answer,
			at: answeredAt
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
//#endregion
export { PostgresValidationStore };
