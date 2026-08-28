import { inScope } from "../store/assessment-scope.js";
import { defineServing } from "./serving-asset.js";
//#region server/foundation/serving-store.ts
var ServingVersionError = class extends Error {};
/**
* The next declaration over a draft, checked and numbered.
*
* Here rather than in the route so the two stores and the route agree on what "the next one" means:
* the version is read from what is stored rather than sent by the caller. A caller that sent its own
* would be sending a number it read some time ago, which is the lost-update it cannot see.
*/
function nextDeclaration(draft, previous, by, at, definitionId) {
	const version = (previous?.version ?? 0) + 1;
	return {
		id: `serving-${String(version)}`,
		version,
		declaredAt: at,
		declaredBy: by,
		definition: defineServing(draft, version),
		...definitionId != null ? { definitionId } : {}
	};
}
/**
* A stored row back into a declaration, or undefined where it cannot be trusted.
*
* The definition is rebuilt through `defineServing` rather than taken from the row, and then the
* fingerprint it computes is compared with the stored one. That is two checks in one: a row edited in
* the database, and a row written by a build whose rules have since changed. Both read as unreadable,
* because a readiness outcome carries this fingerprint as the thing it is a reading of, and a
* definition that no longer means what its fingerprint says is worse than no definition at all.
*/
function reviveDeclaration(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	if (typeof candidate.id !== "string" || typeof candidate.declaredBy !== "string") return void 0;
	if (!Number.isInteger(candidate.version) || candidate.version < 1) return void 0;
	const at = new Date(candidate.declaredAt);
	if (Number.isNaN(at.getTime())) return void 0;
	const stored = candidate.definition;
	if (stored == null || typeof stored !== "object") return void 0;
	let definition;
	try {
		definition = defineServing(stored, candidate.version);
	} catch {
		return;
	}
	if (definition.fingerprint !== stored.fingerprint) return void 0;
	return {
		id: candidate.id,
		version: candidate.version,
		declaredAt: at,
		declaredBy: candidate.declaredBy,
		definition,
		...typeof candidate.definitionId === "string" ? { definitionId: candidate.definitionId } : {}
	};
}
/** Newest first, by version, which is the order a history is read in and the order `current` needs. */
function newestFirst(declarations) {
	return [...declarations].sort((one, other) => other.version - one.version);
}
/** Declarations in memory, for a demo and for tests. */
var InMemoryServingStore = class {
	durable = false;
	declarations = [];
	declare(declaration) {
		if (this.declarations.find((one) => one.version === declaration.version && one.definitionId === declaration.definitionId) != null) return Promise.reject(new ServingVersionError(`Version ${String(declaration.version)} of the serving declaration already exists. Re-read the current one and declare the next.`));
		this.declarations.push(declaration);
		return Promise.resolve();
	}
	current(scope) {
		return Promise.resolve(newestFirst(this.mine(scope))[0]);
	}
	history(scope) {
		return Promise.resolve(newestFirst(this.mine(scope)));
	}
	mine(scope) {
		return this.declarations.filter((one) => inScope(one.definitionId, scope));
	}
};
//#endregion
export { InMemoryServingStore, ServingVersionError, newestFirst, nextDeclaration, reviveDeclaration };
