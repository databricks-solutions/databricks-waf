import { digestOf } from "../records/digest.js";
import { applyScope } from "../store/assessment-scope.js";
import { ServingVersionError, newestFirst, reviveDeclaration } from "./serving-store.js";
//#region server/foundation/serving-postgres-store.ts
/** Postgres's unique-violation SQLSTATE, spelled the same way the other four stores here spell it. */
const UNIQUE_VIOLATION = "23505";
function duplicate(error) {
	return typeof error === "object" && error != null && error.code === UNIQUE_VIOLATION;
}
var PostgresServingStore = class {
	options;
	durable = true;
	constructor(options) {
		this.options = options;
	}
	async declare(declaration) {
		const { db } = this.options;
		try {
			await db.query(`insert into ${db.schema}.serving_declarations
           (id, version, declared_at, declared_by, fingerprint, body, digest, definition_id)
           values ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)`, [
				declaration.id,
				declaration.version,
				declaration.declaredAt,
				declaration.declaredBy,
				declaration.definition.fingerprint,
				JSON.stringify(declaration),
				digestOf(declaration),
				declaration.definitionId ?? null
			]);
		} catch (cause) {
			if (!duplicate(cause)) throw cause;
			throw new ServingVersionError(`Version ${String(declaration.version)} of the serving declaration already exists. Re-read the current one and declare the next.`);
		}
	}
	async current(scope) {
		return (await this.history(scope))[0];
	}
	async history(scope) {
		const { db } = this.options;
		const operation = "read the serving declarations";
		try {
			const scoped = applyScope("", [], scope);
			const { rows } = await db.query(`select body from ${db.schema}.serving_declarations ${scoped.fragment} order by version desc`, scoped.values);
			const declarations = rows.map((row) => reviveDeclaration(row.body));
			const unreadable = declarations.filter((one) => one == null).length;
			if (unreadable > 0) this.options.onError?.(operation, /* @__PURE__ */ new Error(`${String(unreadable)} stored serving declaration(s) could not be read`));
			return newestFirst(declarations.filter((one) => one != null));
		} catch (error) {
			this.options.onError?.(operation, error);
			return [];
		}
	}
};
//#endregion
export { PostgresServingStore };
