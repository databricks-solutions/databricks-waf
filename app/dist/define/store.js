import { currentVersion } from "./definition.js";
//#region server/define/store.ts
/**
* Somebody else revised this definition first.
*
* Its own error because the caller can do something specific about it — re-read, show what changed,
* and let the author decide — which is not true of a failed connection.
*/
var DefinitionConflict = class extends Error {
	definitionId;
	version;
	constructor(definitionId, version) {
		super(`Version ${String(version)} of assessment ${definitionId} already exists, so somebody revised it first. Re-read it and decide against what they changed.`);
		this.definitionId = definitionId;
		this.version = version;
	}
};
/** Newest first by when the definition was created, which is its first version's date. */
function newestFirst(definitions) {
	return [...definitions].sort((a, b) => createdAt(b).getTime() - createdAt(a).getTime());
}
function createdAt(definition) {
	return definition.versions[0]?.createdAt ?? currentVersion(definition).createdAt;
}
var InMemoryDefinitionStore = class {
	durable = false;
	definitions = /* @__PURE__ */ new Map();
	all() {
		return Promise.resolve(newestFirst([...this.definitions.values()]));
	}
	get(id) {
		return Promise.resolve(this.definitions.get(id));
	}
	create(definition) {
		if (this.definitions.get(definition.id) != null) return Promise.reject(new DefinitionConflict(definition.id, currentVersion(definition).version));
		this.definitions.set(definition.id, definition);
		return Promise.resolve();
	}
	appendVersion(id, version) {
		const existing = this.definitions.get(id);
		if (existing == null) return Promise.reject(/* @__PURE__ */ new Error(`No assessment ${id} to revise.`));
		if (existing.versions.some((one) => one.version === version.version)) return Promise.reject(new DefinitionConflict(id, version.version));
		this.definitions.set(id, {
			...existing,
			versions: [...existing.versions, version]
		});
		return Promise.resolve();
	}
	archive(id, at) {
		const existing = this.definitions.get(id);
		if (existing == null) return Promise.reject(/* @__PURE__ */ new Error(`No assessment ${id} to archive.`));
		if (existing.archivedAt != null) return Promise.resolve();
		this.definitions.set(id, {
			...existing,
			archivedAt: at
		});
		return Promise.resolve();
	}
	unarchive(id) {
		const existing = this.definitions.get(id);
		if (existing == null) return Promise.reject(/* @__PURE__ */ new Error(`No assessment ${id} to reopen.`));
		if (existing.archivedAt == null) return Promise.resolve();
		const { archivedAt: _was, ...rest } = existing;
		this.definitions.set(id, rest);
		return Promise.resolve();
	}
};
//#endregion
export { DefinitionConflict, InMemoryDefinitionStore, newestFirst };
