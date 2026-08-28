//#region server/define/setup-store.ts
/**
* The target half of the key, as a value a primary key can hold.
*
* A new assessment has no id, and a nullable column cannot be part of a primary key in Postgres, so
* the absent id is stored as the empty string. Kept in one function used by both implementations so
* the two cannot disagree about which draft is which — an in-memory store keying on `undefined` and
* a database keying on `''` would behave identically until something iterated one of them.
*/
function targetOf(definitionId) {
	return definitionId ?? "";
}
/** Newest first, which is the order somebody picking up abandoned work wants them in. */
function newestFirst(drafts) {
	return [...drafts].sort((a, b) => b.savedAt.getTime() - a.savedAt.getTime());
}
var InMemorySetupDraftStore = class {
	durable = false;
	drafts = /* @__PURE__ */ new Map();
	get(author, definitionId) {
		return Promise.resolve(this.drafts.get(keyOf(author, definitionId)));
	}
	mine(author) {
		return Promise.resolve(newestFirst([...this.drafts.values()].filter((draft) => draft.author === author)));
	}
	save(draft) {
		this.drafts.set(keyOf(draft.author, draft.definitionId), draft);
		return Promise.resolve();
	}
	discard(author, definitionId) {
		this.drafts.delete(keyOf(author, definitionId));
		return Promise.resolve();
	}
};
/**
* The composite key as one string.
*
* The separator is a newline rather than a colon, because an author is an email address and a
* definition id is a UUID and neither can contain one — where a colon appears in plenty of
* identities and would let two different pairs collide on one key.
*/
function keyOf(author, definitionId) {
	return `${author}\n${targetOf(definitionId)}`;
}
//#endregion
export { InMemorySetupDraftStore, newestFirst, targetOf };
