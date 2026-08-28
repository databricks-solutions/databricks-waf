//#region server/import/summary.ts
/** What the readings in a file speak to, counted rather than listed, for the page's summary line. */
function summarise(envelope) {
	const requirements = /* @__PURE__ */ new Set();
	let observed = 0;
	let refused = 0;
	for (const probe of envelope.probes) {
		for (const control of probe.controls) requirements.add(control);
		if (probe.status === "observed") observed += 1;
		if (probe.status === "denied" || probe.status === "error") refused += 1;
	}
	const collectedBy = envelope.tiers.workspace.identity?.username;
	return {
		generatedAt: envelope.generatedAt,
		...collectedBy != null ? { collectedBy } : {},
		workspaceTier: envelope.tiers.workspace.ran,
		accountTier: envelope.tiers.account.ran,
		observed,
		refused,
		requirements: requirements.size,
		scriptVersion: envelope.script.version
	};
}
/**
* A stored summary back into one, or nothing when the column holds something else.
*
* Nothing rather than a partial record, because the caller's fallback is to recompute from the body
* and a half-read summary would suppress it. Every field is checked for that reason: a row written by
* a version that counted fewer things is a row this should decline, not one it should pad with zeroes
* and render as though the count were real.
*/
function summaryFrom(value) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) return void 0;
	const { generatedAt, collectedBy, workspaceTier, accountTier, observed, refused, requirements, scriptVersion } = value;
	if (typeof generatedAt !== "string" || generatedAt === "") return void 0;
	if (typeof workspaceTier !== "boolean" || typeof accountTier !== "boolean") return void 0;
	if (!Number.isInteger(observed) || !Number.isInteger(refused) || !Number.isInteger(requirements)) return void 0;
	if (typeof scriptVersion !== "string") return void 0;
	if (collectedBy != null && typeof collectedBy !== "string") return void 0;
	return {
		generatedAt,
		...typeof collectedBy === "string" ? { collectedBy } : {},
		workspaceTier,
		accountTier,
		observed,
		refused,
		requirements,
		scriptVersion
	};
}
//#endregion
export { summarise, summaryFrom };
