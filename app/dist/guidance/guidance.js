import { shippedConfigDirectory } from "../shipped-config.js";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadAll } from "js-yaml";
//#region server/guidance/guidance.ts
function guidanceDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("guidance", moduleUrl);
}
/**
* Every guidance file, read and keyed by control id.
*
* Nothing here validates against the schema: `npm run check:guidance` does that, and doing it again
* at boot would mean a content mistake takes the app down instead of showing up in CI. What this does
* instead is read defensively — a missing field is `undefined` and an entry that says nothing reads as
* a draft — so the worst a malformed file can do is leave a question without its guidance, which is
* the state every question is in until row 10 of the plan authors it anyway.
*/
function loadGuidance(directory = guidanceDirectory()) {
	const files = readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort();
	const entries = /* @__PURE__ */ new Map();
	for (const name of files) {
		const [raw] = loadAll(readFileSync(join(directory, name), "utf8"));
		if (raw?.entries == null) continue;
		for (const [controlId, entry] of Object.entries(raw.entries)) {
			if (entry == null) continue;
			entries.set(controlId, toGuidance(controlId, raw.pillar ?? name.replace(/\.yaml$/, ""), entry));
		}
	}
	const written = [...entries.values()].filter((one) => one.status === "authored");
	return {
		entries,
		authored: written.length,
		advised: written.filter((one) => one.advice != null).length
	};
}
/**
* The guidance a question should show, or nothing.
*
* A draft returns nothing on purpose. The panel's alternative to showing a draft is saying "no
* guidance has been written for this question yet", and that sentence is more useful than a heading
* with an empty body under it: one tells the reader to ask a colleague, the other reads as a bug.
*/
function authoredGuidance(library, controlId) {
	const found = library.entries.get(controlId);
	return found?.status === "authored" ? found : void 0;
}
const KINDS = [
	"ui",
	"sql",
	"cli",
	"api",
	"by-hand"
];
function toGuidance(controlId, pillarId, raw) {
	const examples = raw.examples?.strong != null && raw.examples.partial != null && raw.examples.weak != null ? {
		strong: raw.examples.strong,
		partial: raw.examples.partial,
		weak: raw.examples.weak
	} : void 0;
	return {
		controlId,
		pillarId,
		status: raw.status === "authored" ? "authored" : "draft",
		good: raw.good ?? [],
		verify: (raw.verify ?? []).flatMap((check) => check.where == null ? [] : [toCheck(check)]),
		pitfalls: raw.pitfalls ?? [],
		references: raw.references ?? [],
		...present("lastReviewed", raw.last_reviewed),
		...present("ownerRole", raw.owner_role),
		...present("means", raw.means),
		...present("matters", raw.matters),
		...present("examples", examples),
		...present("partialWhen", raw.partial_when),
		...present("notApplicableWhen", raw.not_applicable_when),
		...present("advice", toAdvice(raw.advice))
	};
}
/**
* Advice, or nothing — never some of it.
*
* `check:guidance` refuses a partial block, so a file in the tree has all six or none. This is what
* happens when one is edited out by hand between checks: the block is dropped rather than rendered
* with a gap, because the panel's headings would otherwise announce a trade-off nobody wrote.
*
* The types say `string` and `string[]`, and this checks anyway, because they describe YAML — the
* declared shape of a file the loader was pointed at, not a shape anything enforced. Two states get
* past a null check and neither is theoretical: `start_from:` with nothing after it parses as an
* empty string, which renders as a heading over nothing; and `depends_on: one factor` parses as a
* scalar, which has a `length` and would reach `.map` in the panel as a string and take the page
* down with it.
*/
function toAdvice(raw) {
	if (raw == null) return void 0;
	const { start_from: startFrom, depends_on: dependsOn, path, costs, retain, revisit } = raw;
	if (!written(startFrom) || !written(retain) || !written(revisit)) return void 0;
	if (!listed(dependsOn) || !listed(path) || !listed(costs)) return void 0;
	return {
		startFrom,
		dependsOn,
		path,
		costs,
		retain,
		revisit
	};
}
const written = (value) => typeof value === "string" && value.trim() !== "";
const listed = (value) => Array.isArray(value) && value.length > 0 && value.every(written);
function toCheck(raw) {
	return {
		how: KINDS.find((kind) => kind === raw.how) ?? "by-hand",
		where: raw.where ?? "",
		...present("expect", raw.expect),
		...present("caveat", raw.caveat)
	};
}
/** Absent stays absent, rather than becoming an explicit undefined on every entry. */
function present(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
//#endregion
export { authoredGuidance, guidanceDirectory, loadGuidance };
