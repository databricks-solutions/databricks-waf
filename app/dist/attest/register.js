import { cadenceDaysFor, reviewDateFrom } from "./attestation.js";
import { randomUUID } from "node:crypto";
//#region server/attest/register.ts
async function registerAttestation(options) {
	const now = options.now ?? /* @__PURE__ */ new Date();
	const cadence = cadenceDaysFor(options.severity, options.cadenceDays);
	const previous = (await options.store.current(options.definitionId ?? null)).find((entry) => entry.controlId === options.draft.controlId);
	const attestation = {
		id: randomUUID(),
		...options.draft,
		attestedBy: options.actor,
		attestedAt: now,
		reviewBy: reviewDateFrom(now, cadence),
		...previous != null ? { supersedes: previous.id } : {},
		...options.definitionId != null ? { definitionId: options.definitionId } : {}
	};
	await options.store.record(attestation);
	return attestation;
}
//#endregion
export { registerAttestation };
