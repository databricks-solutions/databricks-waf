import { digestOf } from "../records/digest.js";
import { DefinitionConflict, newestFirst } from "./store.js";
//#region server/define/postgres-store.ts
/** Postgres' code for a unique or primary key violation. */
const UNIQUE_VIOLATION = "23505";
var PostgresDefinitionStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async all() {
		const { db } = this.options;
		try {
			const [definitions, versions] = await Promise.all([db.query(`select id, archived_at from ${db.schema}.assessment_definitions`), db.query(`select definition_id, body from ${db.schema}.assessment_definition_versions`)]);
			const byDefinition = /* @__PURE__ */ new Map();
			let unreadable = 0;
			for (const row of versions.rows) {
				const version = revive(row.body);
				if (version == null) {
					unreadable += 1;
					continue;
				}
				byDefinition.set(row.definition_id, [...byDefinition.get(row.definition_id) ?? [], version]);
			}
			if (unreadable > 0) this.options.onError?.("read every assessment definition", /* @__PURE__ */ new Error(`${String(unreadable)} stored definition versions could not be read and were skipped.`));
			const assembled = [];
			for (const row of definitions.rows) {
				const stored = byDefinition.get(row.id)?.sort((a, b) => a.version - b.version);
				if (stored == null || stored.length === 0) continue;
				const archivedAt = row.archived_at == null ? void 0 : new Date(row.archived_at);
				assembled.push({
					id: row.id,
					versions: stored,
					...archivedAt != null && !Number.isNaN(archivedAt.getTime()) ? { archivedAt } : {}
				});
			}
			return newestFirst(assembled);
		} catch (error) {
			this.options.onError?.("read every assessment definition", error);
			throw error;
		}
	}
	async get(id) {
		return (await this.all()).find((definition) => definition.id === id);
	}
	async create(definition) {
		const { db } = this.options;
		const first = definition.versions[0];
		if (first == null) throw new Error(`Assessment ${definition.id} has no version to store.`);
		try {
			await db.query(`insert into ${db.schema}.assessment_definitions (id, created_at, archived_at)
           values ($1, $2, $3)
         on conflict (id) do nothing`, [
				definition.id,
				first.createdAt,
				definition.archivedAt ?? null
			]);
			await this.insertVersion(definition.id, first);
		} catch (error) {
			this.options.onError?.(`create assessment definition ${definition.id}`, error);
			throw error;
		}
	}
	async appendVersion(id, version) {
		try {
			await this.insertVersion(id, version);
		} catch (error) {
			if (!(error instanceof DefinitionConflict)) this.options.onError?.(`revise assessment definition ${id}`, error);
			throw error;
		}
	}
	async archive(id, at) {
		const { db } = this.options;
		try {
			await db.query(`update ${db.schema}.assessment_definitions set archived_at = $2 where id = $1 and archived_at is null`, [id, at]);
		} catch (error) {
			this.options.onError?.(`archive assessment definition ${id}`, error);
			throw error;
		}
	}
	async unarchive(id) {
		const { db } = this.options;
		try {
			await db.query(`update ${db.schema}.assessment_definitions set archived_at = null where id = $1 and archived_at is not null`, [id]);
		} catch (error) {
			this.options.onError?.(`reopen assessment definition ${id}`, error);
			throw error;
		}
	}
	async insertVersion(definitionId, version) {
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.assessment_definition_versions
           (definition_id, version, fingerprint, created_at, body, digest)
         values ($1, $2, $3, $4, $5::jsonb, $6)`, [
				definitionId,
				version.version,
				version.fingerprint,
				version.createdAt,
				JSON.stringify(version),
				digestOf(version)
			]);
		} catch (error) {
			if (isUniqueViolation(error)) throw new DefinitionConflict(definitionId, version.version);
			throw error;
		}
	}
};
function isUniqueViolation(error) {
	return typeof error === "object" && error !== null && error.code === UNIQUE_VIOLATION;
}
/**
* A stored version back into a domain object, with its date restored.
*
* Typed as `unknown` on the way in and checked field by field, because what arrives is whatever is
* in the column. A row written by an older build, or edited in `psql`, is not a `DefinitionVersion`
* because the type says so — and a version whose number or fingerprint is missing would be compared
* against other versions and stamped on a run.
*/
function revive(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	const { version, fingerprint, createdBy, measurement, attribution, note } = candidate;
	if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return void 0;
	if (typeof fingerprint !== "string" || !fingerprint.startsWith("sha256:")) return void 0;
	if (typeof createdBy !== "string") return void 0;
	if (typeof measurement !== "object" || measurement === null) return void 0;
	if (typeof attribution !== "object" || attribution === null) return void 0;
	const createdAt = new Date(candidate.createdAt);
	if (Number.isNaN(createdAt.getTime())) return void 0;
	return {
		version,
		fingerprint,
		createdAt,
		createdBy,
		measurement,
		attribution,
		...targetsFrom(candidate.targets),
		...typeof note === "string" && note !== "" ? { note } : {}
	};
}
/**
* The stored targets, with their dates back as dates.
*
* Its own function because targets are the one part of a version that does not survive `JSON.parse`
* as itself: `by` is a `Date` in the domain and a string in the column, and a surface comparing a
* string to `now` gets an answer that is wrong without being an error.
*
* A target that does not survive the check is dropped rather than failing the whole version. That is
* the opposite of the choice made above for `version` and `fingerprint`, and for the opposite reason:
* those decide what a run is compared against, so a bad one has to stop the row being used, while a
* malformed target is a commitment that cannot be reported against. Losing the assessment because one
* date is unreadable would take the customer's scope, owners and history with it.
*/
function targetsFrom(raw) {
	if (!Array.isArray(raw)) return {};
	const targets = raw.flatMap((entry) => {
		if (entry == null || typeof entry !== "object") return [];
		const { pillar, atLeast, by } = entry;
		if (typeof pillar !== "string" || pillar === "") return [];
		if (typeof atLeast !== "number" || !Number.isInteger(atLeast)) return [];
		const when = new Date(by);
		if (Number.isNaN(when.getTime())) return [];
		return [{
			pillar,
			atLeast,
			by: when
		}];
	});
	return targets.length > 0 ? { targets } : {};
}
//#endregion
export { PostgresDefinitionStore };
