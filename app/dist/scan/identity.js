import { CREDIT, SEVERITY_WEIGHT } from "../score/score.js";
import "../shared/api/comparability.js";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
//#region server/scan/identity.ts
/**
* The identity entry for each requirement a run's decisions excluded, sorted.
*
* One function rather than the same `map` in the two places that write the field — a scan and the merge
* of a targeted rerun — because the two producing different spellings of the same fact would make every
* comparison across them refuse.
*/
function exclusionKeys(excluded) {
	return [...excluded].map((one) => `${one.controlId}:${one.lever}`).sort();
}
/**
* The digest of the two tables that decide how findings become a score.
*
* Computed once at module load. Both tables are frozen constants, so the digest cannot change while
* a process runs, and recomputing it per scan would suggest otherwise.
*
* Exported because the methodology surface serves the two tables and this identifier beside them: a
* reader holding a run whose `identity.methodology` does not match this is looking at a score
* computed by a weighting the app has since changed, and that is the whole reason the axis exists.
* Recomputing it there would be a second definition of the same digest.
*/
const METHODOLOGY = digest({
	credit: CREDIT,
	severityWeight: SEVERITY_WEIGHT
});
/**
* A digest over a value, with object keys sorted so the result depends on content and not on the
* order a literal happened to be written in.
*/
function digest(value) {
	return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}
function canonical(value) {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (value !== null && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : 1).map(([key, inner]) => `${JSON.stringify(key)}:${canonical(inner)}`).join(",")}}`;
	return JSON.stringify(value ?? null);
}
/**
* The app's version and the digest of the server bundle that ran.
*
* The bundle rather than the source tree, because the bundle is what the platform executes: a
* deploy-from-Git install runs `dist/server.js` and never compiles anything. That has one honest
* limitation, which is stated here so it is not discovered later — under `npm run dev` the process
* runs from `server/**` and this digest describes the committed bundle sitting beside it, which is
* the same file for anybody who has bundled and a stale one for anybody mid-change. It is a reason
* to qualify a comparison rather than refuse one, and `identityBarriers` treats it that way.
*
* The client bundle is deliberately not included. It decides what a reader sees and nothing about
* what a score is, so folding it in would qualify comparisons over a corrected label.
*/
function buildIdentity(moduleUrl = import.meta.url) {
	const root = appRoot(moduleUrl);
	if (root == null) return { unknown: "The app root could not be located, so the build that produced this run is not recorded." };
	const version = versionOf(join(root, "package.json"));
	const bundle = join(root, "dist", "server.js");
	if (!existsSync(bundle)) return { unknown: `No dist/server.js was found under ${root}, so the code that produced this run cannot be identified beyond version ${version ?? "unknown"}.` };
	const fingerprint = digestOfFile(bundle);
	return { id: `${version ?? "unknown"}+${fingerprint.slice(7, 19)}` };
}
function versionOf(path) {
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return typeof parsed.version === "string" ? parsed.version : void 0;
	} catch {
		return;
	}
}
function digestOfFile(path) {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}
/**
* The directory holding `package.json`, found by searching upwards.
*
* The same approach as `shipped-config.ts` and for the same reason: this module runs from
* `server/scan/` under tsx and from `dist/` in the bundle, so a path computed from a depth is
* correct in one of them and silently wrong in the other.
*/
function appRoot(moduleUrl) {
	let here = dirname(fileURLToPath(moduleUrl));
	for (;;) {
		if (existsSync(join(here, "package.json"))) return here;
		const parent = resolve(here, "..");
		if (parent === here) return void 0;
		here = parent;
	}
}
/**
* What produced this run, assembled from the readings it made.
*
* `sources` comes from the readings rather than from what was configured, because what a run could
* have read and what answered are different facts and only the second one is evidence.
*/
function runIdentity(signals, options = {}) {
	return {
		build: options.moduleUrl == null ? buildIdentity() : buildIdentity(options.moduleUrl),
		methodology: { id: METHODOLOGY },
		record: { id: `codec-${String(4)}` },
		sources: sourcesOf(signals),
		exclusions: [...options.exclusions ?? []].sort()
	};
}
/**
* The surfaces that produced a reading, sorted.
*
* Only readings that observed something. A refused probe still names the surface it would have read,
* and counting those would report every run as having read everything — which is the opposite of
* what this field is for.
*/
function sourcesOf(signals) {
	const found = /* @__PURE__ */ new Set();
	for (const signal of signals) {
		if (signal.status !== "observed") continue;
		const provenance = signal.provenance;
		if (provenance == null) continue;
		found.add(provenance.authority === "admin-cli" ? "import" : provenance.surface);
	}
	return [...found].sort();
}
//#endregion
export { METHODOLOGY, buildIdentity, exclusionKeys, runIdentity, sourcesOf };
