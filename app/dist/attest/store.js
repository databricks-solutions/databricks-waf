import { counts } from "./attestation.js";
import { inScope } from "../store/assessment-scope.js";
import { newestFirstBy } from "../store/ordering.js";
//#region server/attest/store.ts
/** The current attestations that still count, by control id. What resolution reads. */
function effective(attestations, now = /* @__PURE__ */ new Date()) {
	const live = /* @__PURE__ */ new Map();
	for (const attestation of attestations) if (counts(attestation, now)) live.set(attestation.controlId, attestation);
	return live;
}
/** Newest first, breaking ties by the supersession chain. See `newestFirstBy`. */
function newestFirst(attestations) {
	return newestFirstBy(attestations, (attestation) => attestation.attestedAt);
}
var InMemoryAttestationStore = class {
	durable = false;
	events = [];
	current(scope) {
		const newest = /* @__PURE__ */ new Map();
		for (const attestation of newestFirst(this.events)) {
			if (!inScope(attestation.definitionId, scope)) continue;
			if (!newest.has(attestation.controlId)) newest.set(attestation.controlId, attestation);
		}
		return Promise.resolve([...newest.values()]);
	}
	get(id, scope) {
		return Promise.resolve(this.events.find((event) => event.id === id && inScope(event.definitionId, scope)));
	}
	historyFor(controlId, scope) {
		return Promise.resolve(newestFirst(this.events.filter((event) => event.controlId === controlId && inScope(event.definitionId, scope))));
	}
	record(attestation) {
		this.events.push(attestation);
		return Promise.resolve();
	}
};
//#endregion
export { InMemoryAttestationStore, effective, newestFirst };
