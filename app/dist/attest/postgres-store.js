import { PostgresEventLog } from "../store/event-log.js";
//#region server/attest/postgres-store.ts
var PostgresAttestationStore = class {
	durable = true;
	log;
	constructor(options) {
		this.log = new PostgresEventLog({
			db: options.db,
			table: "attestations",
			stampColumn: "attested_at",
			stampOf: (attestation) => attestation.attestedAt,
			revive: reviveStoredAttestation,
			noun: "attestation",
			...options.onError ? { onError: options.onError } : {}
		});
	}
	current(scope) {
		return this.log.current(scope);
	}
	get(id, scope) {
		return this.log.get(id, scope);
	}
	historyFor(controlId, scope) {
		return this.log.historyFor(controlId, scope);
	}
	record(attestation) {
		return this.log.append(attestation);
	}
};
/** A stored record back into a domain object, with its two dates restored. */
function reviveStoredAttestation(raw) {
	if (raw == null || typeof raw !== "object") return void 0;
	const candidate = raw;
	const attestedAt = new Date(candidate.attestedAt);
	const reviewBy = new Date(candidate.reviewBy);
	if (Number.isNaN(attestedAt.getTime()) || Number.isNaN(reviewBy.getTime())) return void 0;
	if (typeof candidate.controlId !== "string" || typeof candidate.statement !== "string") return void 0;
	return {
		...candidate,
		attestedAt,
		reviewBy
	};
}
//#endregion
export { PostgresAttestationStore, reviveStoredAttestation };
