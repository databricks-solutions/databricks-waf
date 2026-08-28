import { applyScope } from "../store/assessment-scope.js";
import { inPublishedOrder, parseMonth } from "./publication.js";
//#region server/monthly/store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
/**
* Raised when something else published at this position in the month first.
*
* Its own class rather than a generic conflict, so the endpoint answers 409 with a sentence a person can
* act on instead of a stack trace about an index. One class for both races it refuses, because the answer
* is the same in both: read the month again, because what you were working from is not what is on record.
*
* The rule it enforces was the endpoint's alone, and an endpoint that reads and then writes cannot enforce
* it: two first publications of one month both read a month with nothing in it and both wrote.
*/
var PublicationRaceError = class extends Error {
	month;
	constructor(month) {
		super(`Another publication of ${month} was recorded at this position first, so this one was not. Read the month again — what stands now is not what this was written against.`);
		this.month = month;
		this.name = "PublicationRaceError";
	}
};
var PostgresPublicationStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async publish(publication) {
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.month_publications
           (id, month, published_at, published_by, supersedes, reason, document_version, digest, json, csv,
            ordinal, definition_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (id) do nothing`, [
				publication.id,
				publication.month,
				publication.publishedAt,
				publication.publishedBy,
				publication.supersedes ?? null,
				publication.reason ?? null,
				publication.documentVersion,
				publication.digest,
				publication.json,
				publication.csv,
				publication.ordinal ?? null,
				publication.definitionId ?? null
			]);
		} catch (error) {
			if (!isUniqueViolation(error)) throw error;
			throw new PublicationRaceError(publication.month);
		}
	}
	async ofMonth(month, scope) {
		const operation = `read the publications of ${month}`;
		const scoped = applyScope("where month = $1 order by published_at asc", [month], scope);
		const rows = await this.read(operation, scoped.fragment, scoped.values);
		return inPublishedOrder(this.revived(rows, operation));
	}
	async byId(id, scope) {
		const operation = `read publication ${id}`;
		const scoped = applyScope("where id = $1", [id], scope);
		const rows = await this.read(operation, scoped.fragment, scoped.values);
		return this.revived(rows, operation)[0];
	}
	async months(scope) {
		const { db } = this.options;
		const operation = "list the months that have been published";
		try {
			const scoped = applyScope("order by month desc", [], scope);
			const { rows } = await db.query(`select month from ${db.schema}.month_publications ${scoped.fragment}`, scoped.values);
			const seen = /* @__PURE__ */ new Set();
			for (const row of rows) {
				const month = parseMonth(row.month);
				if (month != null) seen.add(month);
			}
			return [...seen];
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	async read(operation, where, values) {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select id, month, published_at, published_by, supersedes, reason, document_version, digest, json, csv,
                ordinal, definition_id
           from ${db.schema}.month_publications ${where}`, values);
			return rows;
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
	revived(rows, operation) {
		const publications = rows.map(revive);
		const unreadable = publications.filter((publication) => publication == null).length;
		if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored publication row(s) could not be read`));
		return publications.filter((publication) => publication != null);
	}
};
function isUniqueViolation(error) {
	return typeof error === "object" && error != null && error.code === UNIQUE_VIOLATION;
}
/**
* A stored row back into a `Publication`, or `undefined` when a field is not what it must be.
*
* Unreadable rather than guessed at, for the reason the other stores give: a row that cannot be
* proven is reported and skipped, not dated now or defaulted, because a publication with a wrong
* month or an unparseable instant is worse than one that is missing and has been logged.
*/
function revive(row) {
	const month = parseMonth(row.month);
	if (month == null) return void 0;
	if (typeof row.id !== "string" || typeof row.published_by !== "string") return void 0;
	if (typeof row.digest !== "string" || typeof row.json !== "string" || typeof row.csv !== "string") return void 0;
	if (typeof row.document_version !== "number") return void 0;
	const publishedAt = new Date(row.published_at);
	if (Number.isNaN(publishedAt.getTime())) return void 0;
	return {
		id: row.id,
		month,
		publishedAt,
		publishedBy: row.published_by,
		...typeof row.supersedes === "string" ? { supersedes: row.supersedes } : {},
		...typeof row.reason === "string" ? { reason: row.reason } : {},
		documentVersion: row.document_version,
		digest: row.digest,
		json: row.json,
		csv: row.csv,
		...typeof row.ordinal === "number" ? { ordinal: row.ordinal } : {},
		...typeof row.definition_id === "string" ? { definitionId: row.definition_id } : {}
	};
}
//#endregion
export { PostgresPublicationStore, PublicationRaceError };
