import { summarise, summaryFrom } from "./summary.js";
//#region server/import/store.ts
/** Raised when the same probe set is imported twice, whether caught by the check or by the index. */
var ReplayedImportError = class extends Error {
	digest;
	constructor(digest) {
		super("These exact readings have already been imported. Nothing was recorded, because a second row for one collection would make a stale posture look like a maintained one.");
		this.digest = digest;
		this.name = "ReplayedImportError";
	}
};
/** The summary of one held import, for the store that keeps envelopes in memory anyway. */
function summaryOf(imported) {
	return {
		digest: imported.digest,
		importedAt: imported.importedAt,
		importedBy: imported.importedBy,
		summary: summarise(imported.envelope),
		cautions: imported.cautions
	};
}
/**
* Newest import first, ties broken by digest.
*
* Not `newestFirstBy`, which orders the append-only logs: those are keyed on a control id and a
* supersession chain, and an import supersedes nothing — a new collection is a new digest and both
* remain true of the day they were collected. The digest tiebreak is there so two imports recorded in
* the same millisecond come back in a stable order rather than whichever the database volunteered.
*/
function newestFirst(imports) {
	return [...imports].sort((left, right) => right.importedAt.getTime() - left.importedAt.getTime() || left.digest.localeCompare(right.digest));
}
var InMemoryEvidenceImportStore = class {
	durable = false;
	held = [];
	all() {
		return Promise.resolve(newestFirst(this.held));
	}
	summaries() {
		return Promise.resolve(newestFirst(this.held).map(summaryOf));
	}
	digests() {
		return Promise.resolve(new Set(this.held.map((imported) => imported.digest)));
	}
	record(imported) {
		if (this.held.some((held) => held.digest === imported.digest)) return Promise.reject(new ReplayedImportError(imported.digest));
		this.held.push(imported);
		return Promise.resolve();
	}
};
/** Postgres error code for a unique violation, which here means exactly one thing. */
const UNIQUE_VIOLATION = "23505";
var PostgresEvidenceImportStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async all() {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select digest, generated_at, imported_at, imported_by, body, cautions
           from ${db.schema}.imported_evidence
          order by imported_at desc`);
			return rows.map(revive).filter((one) => one != null);
		} catch (cause) {
			this.options.onError?.("read imported evidence", cause);
			return [];
		}
	}
	async summaries() {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select digest, imported_at, imported_by, summary, cautions
           from ${db.schema}.imported_evidence
          order by imported_at desc`);
			const held = rows.map(reviveSummary).filter((one) => one != null);
			const missing = rows.filter((row) => summaryFrom(row.summary) == null).map((row) => row.digest);
			return missing.length === 0 ? held : [...held, ...await this.repair(missing)].sort(newestSummaryFirst);
		} catch (cause) {
			this.options.onError?.("read imported evidence summaries", cause);
			return [];
		}
	}
	/**
	* Summarises the rows that have no summary, and writes the answers back.
	*
	* These are rows imported before the column existed. Recomputing rather than backfilling in SQL
	* keeps one definition of what a summary counts, in `summary.ts`, where a change to it is one edit;
	* the alternative puts the same claim in a migration where it can drift silently from the code that
	* renders it. Writing the answer back is what stops this being a permanent second read path — each
	* legacy row costs one detoast once, and an install with none never enters this method.
	*
	* A failed write is not raised. The summary in hand is correct either way, and the next call simply
	* recomputes it; refusing to render the list because a repair could not be persisted would turn a
	* slow page into a broken one.
	*/
	async repair(digests) {
		const { db } = this.options;
		const { rows } = await db.query(`select digest, generated_at, imported_at, imported_by, body, cautions
         from ${db.schema}.imported_evidence
        where digest = any($1::text[])`, [digests]);
		const repaired = [];
		for (const row of rows) {
			const one = revive(row);
			if (one == null) continue;
			const summary = summaryOf(one);
			repaired.push(summary);
			try {
				await db.query(`update ${db.schema}.imported_evidence set summary = $2::jsonb where digest = $1`, [row.digest, JSON.stringify(summary.summary)]);
			} catch (cause) {
				this.options.onError?.("summarise an import written before the summary column", cause);
			}
		}
		return repaired;
	}
	async digests() {
		const { db } = this.options;
		try {
			const { rows } = await db.query(`select digest from ${db.schema}.imported_evidence`);
			return new Set(rows.map((row) => row.digest));
		} catch (cause) {
			this.options.onError?.("read imported evidence digests", cause);
			return /* @__PURE__ */ new Set();
		}
	}
	async record(imported) {
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.imported_evidence
           (digest, generated_at, imported_at, imported_by, body, cautions, summary)
         values ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7::jsonb)`, [
				imported.digest,
				imported.generatedAt.toISOString(),
				imported.importedAt.toISOString(),
				imported.importedBy,
				JSON.stringify(imported.envelope),
				JSON.stringify(imported.cautions),
				JSON.stringify(summarise(imported.envelope))
			]);
		} catch (cause) {
			if (isUniqueViolation(cause)) throw new ReplayedImportError(imported.digest);
			throw cause;
		}
	}
};
function isUniqueViolation(cause) {
	return typeof cause === "object" && cause != null && cause.code === UNIQUE_VIOLATION;
}
/**
* A stored row back into a record, or nothing when it cannot be read.
*
* Dropped rather than guessed at, the same way the attestation store treats an unparseable date: an
* import whose `generatedAt` does not parse would age unpredictably depending on where it was read.
*/
function revive(row) {
	const generatedAt = new Date(row.generated_at);
	const importedAt = new Date(row.imported_at);
	if (Number.isNaN(generatedAt.getTime()) || Number.isNaN(importedAt.getTime())) return void 0;
	if (row.body == null || typeof row.body !== "object") return void 0;
	return {
		digest: row.digest,
		generatedAt,
		importedAt,
		importedBy: row.imported_by,
		envelope: row.body,
		cautions: Array.isArray(row.cautions) ? row.cautions : []
	};
}
/**
* A stored row into a summary, or nothing when the summary column cannot be read.
*
* Nothing covers two cases that behave identically here: a row written before the column existed, and
* one whose summary is not the shape `summary.ts` defines. Both are recomputed from the body, so
* neither needs distinguishing — and a summary this declined to read is the one case where reading
* the envelope is the cheaper mistake.
*/
function reviveSummary(row) {
	const importedAt = new Date(row.imported_at);
	if (Number.isNaN(importedAt.getTime())) return void 0;
	const summary = summaryFrom(row.summary);
	if (summary == null) return void 0;
	return {
		digest: row.digest,
		importedAt,
		importedBy: row.imported_by,
		summary,
		cautions: Array.isArray(row.cautions) ? row.cautions : []
	};
}
/** The order `newestFirst` gives, over summaries, for merging repaired rows back into the list. */
function newestSummaryFirst(left, right) {
	return right.importedAt.getTime() - left.importedAt.getTime() || left.digest.localeCompare(right.digest);
}
//#endregion
export { InMemoryEvidenceImportStore, PostgresEvidenceImportStore, ReplayedImportError, newestFirst, summaryOf };
