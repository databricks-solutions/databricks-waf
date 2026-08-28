//#region server/catalogue/methodology.ts
const NO_RECORD = {
	shapes: /* @__PURE__ */ new Map(),
	unavailable: "This build could not read the catalogue version record, so what the methodology holds cannot be shown. Runs still record which version they were scored against."
};
/**
* The recorded shapes out of a parsed `version.json`.
*
* Takes the parsed object rather than a directory so that `loadCatalogue` reads the file once. Two
* readers of one file is two places for a shipped install to disagree about which catalogue it has,
* which is the argument the changelog loader makes one directory over.
*/
function recordedFrom(parsed) {
	const record = parsed ?? {};
	const controls = record.controls;
	if (controls == null || typeof controls !== "object" || Array.isArray(controls)) return {
		shapes: /* @__PURE__ */ new Map(),
		unavailable: "The catalogue version record for this build holds no per-requirement shapes, so what this version covers cannot be listed. It was written before the record held them.",
		...typeof record.scored_units === "number" ? { scoredUnits: record.scored_units } : {}
	};
	const shapes = /* @__PURE__ */ new Map();
	for (const [id, raw] of Object.entries(controls)) shapes.set(id, shape(id, raw));
	return {
		shapes,
		...typeof record.scored_units === "number" ? { scoredUnits: record.scored_units } : {}
	};
}
function shape(id, raw) {
	const one = raw ?? {};
	return {
		id,
		pillar: text(one.pillar) ?? "",
		principle: text(one.principle) ?? "",
		title: text(one.title) ?? "",
		provenance: text(one.provenance) ?? "",
		severity: text(one.severity) ?? "",
		measurability: text(one.measurability) ?? "",
		coverage_mode: text(one.coverage_mode) ?? "complete",
		alias_group: text(one.alias_group) ?? null,
		clouds: Array.isArray(one.clouds) ? one.clouds.filter((cloud) => typeof cloud === "string") : [],
		thresholds: one.thresholds != null && typeof one.thresholds === "object" && !Array.isArray(one.thresholds) ? one.thresholds : null,
		...text(one.continues) != null ? { continues: text(one.continues) } : {},
		preconditions: Array.isArray(one.preconditions) ? one.preconditions.map(precondition) : []
	};
}
function precondition(raw) {
	const one = raw ?? {};
	return {
		signal: text(one.signal) ?? "",
		operator: text(one.operator) ?? "",
		...one.value !== void 0 ? { value: one.value } : {},
		outcome: text(one.outcome) ?? "",
		scope: text(one.scope) ?? "segment"
	};
}
function text(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
const NO_DRIFT = {
	changed: [],
	missing: [],
	unrecorded: []
};
function driftBetween(recorded, live) {
	if (recorded.shapes.size === 0) return NO_DRIFT;
	const byId = new Map(live.map((one) => [one.id, one]));
	const changed = [];
	const missing = [];
	for (const [id, was] of recorded.shapes) {
		const now = byId.get(id);
		if (now == null) {
			missing.push(id);
			continue;
		}
		const fields = differing(was, now);
		if (fields.length > 0) changed.push({
			id,
			fields
		});
	}
	return {
		changed: changed.sort((a, b) => a.id.localeCompare(b.id)),
		missing: missing.sort(),
		unrecorded: live.map((one) => one.id).filter((id) => !recorded.shapes.has(id)).sort()
	};
}
function differing(was, now) {
	const fields = [];
	for (const field of [
		"pillar",
		"principle",
		"title",
		"provenance",
		"severity",
		"measurability",
		"coverage_mode"
	]) if (was[field] !== now[field]) fields.push(field);
	if (was.alias_group !== now.alias_group) fields.push("alias_group");
	if (canonical([...was.clouds].sort()) !== canonical([...now.clouds].sort())) fields.push("clouds");
	if (canonical(was.thresholds) !== canonical(now.thresholds)) fields.push("thresholds");
	if (canonical(was.preconditions) !== canonical(now.preconditions)) fields.push("preconditions");
	return fields;
}
/**
* A value as a string that depends on its content and not on key order.
*
* The bump script's own `canonical`, restated because that script is deliberately standalone — it has
* to run without the server build, so nothing here can be imported into it and importing it here
* would make a check the repository depends on depend on a compiled bundle. The two are held together
* by `methodology-agreement.test.ts`, which drives the real script and reads the result back through
* this module, on the same reasoning as `changelog-agreement.test.ts` next door.
*/
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value != null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}
//#endregion
export { NO_DRIFT, NO_RECORD, driftBetween, recordedFrom };
