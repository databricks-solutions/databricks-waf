import { randomUUID } from "node:crypto";
//#region server/decide/register.ts
async function registerDecision(options) {
	const now = options.now ?? /* @__PURE__ */ new Date();
	const previous = (await options.store.current(options.definitionId ?? null)).find((entry) => entry.controlId === options.draft.controlId);
	const decision = {
		id: randomUUID(),
		...options.draft,
		decidedBy: options.actor,
		decidedAt: now,
		...previous != null ? { supersedes: previous.id } : {},
		...options.definitionId != null ? { definitionId: options.definitionId } : {}
	};
	await options.store.record(decision);
	return decision;
}
//#endregion
export { registerDecision };
