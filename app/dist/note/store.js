import { inScope } from "../store/assessment-scope.js";
import { threaded } from "./note.js";
//#region server/note/store.ts
/**
* Notes in memory, for a demo and for tests.
*
* Keyed by subject so `for` is a lookup rather than a scan, which matters not at all at this size and
* keeps the two implementations answering the same shape of question.
*/
var InMemoryNoteStore = class {
	durable = false;
	notes = /* @__PURE__ */ new Map();
	add(note) {
		if (!this.notes.has(note.id)) this.notes.set(note.id, note);
		return Promise.resolve();
	}
	for(subject, scope) {
		const mine = [...this.notes.values()].filter((note) => note.subject.kind === subject.kind && note.subject.id === subject.id && inScope(note.definitionId, scope));
		return Promise.resolve(threaded(mine));
	}
	counts(kind, scope) {
		const tally = {};
		for (const note of this.notes.values()) {
			if (note.subject.kind !== kind || !inScope(note.definitionId, scope)) continue;
			tally[note.subject.id] = (tally[note.subject.id] ?? 0) + 1;
		}
		return Promise.resolve(tally);
	}
	ofKind(kind, scope) {
		const mine = [...this.notes.values()].filter((note) => note.subject.kind === kind && inScope(note.definitionId, scope));
		return Promise.resolve(threaded(mine));
	}
};
//#endregion
export { InMemoryNoteStore };
