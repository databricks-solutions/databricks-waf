import { shippedConfigDirectory } from "../shipped-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
//#region server/methodology/identity.ts
function record(path) {
	return JSON.parse(readFileSync(path, "utf8"));
}
function object(value, label) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is not a JSON object.`);
	return value;
}
function nonblank(value, label) {
	if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is missing.`);
	return value;
}
function publicVersion(value, label) {
	if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error(`${label} must be a positive integer.`);
	return value;
}
function state(value, label) {
	if (value !== "candidate" && value !== "released") throw new Error(`${label} must be candidate or released.`);
	return value;
}
function nullableDate(value, label) {
	if (value == null) return void 0;
	return nonblank(value, label);
}
function same(left, right, label) {
	if (left !== right) throw new Error(`The methodology release and manifest disagree about ${label}.`);
}
/**
* Parse the two shipped records as one release identity.
*
* Exported for the negative tests. Production calls it once below, so a damaged or half-updated
* deployment fails at startup instead of stamping a plausible-looking identity assembled from two
* records that disagree.
*/
function publicMethodologyFrom(releaseValue, manifestValue) {
	const release = object(releaseValue, "The methodology release record");
	const manifest = object(manifestValue, "The methodology manifest");
	const manifestRelease = object(manifest.release, "The methodology manifest release");
	same(release.public_version, manifest.public_version, "the public version");
	same(release.name, manifest.name, "the release name");
	same(release.state, manifestRelease.state, "the release state");
	same(release.candidate_started_at, manifestRelease.candidate_started_at, "the candidate start date");
	same(release.effective_date, manifestRelease.effective_date, "the effective date");
	same(release.release_commit, manifestRelease.commit, "the release source commit");
	same(release.approved_by, manifestRelease.approved_by, "the release approver");
	const parsedState = state(release.state, "The methodology release state");
	const effectiveDate = nullableDate(release.effective_date, "The methodology effective date");
	const releaseCommit = nullableDate(release.release_commit, "The methodology release source commit");
	const approvedBy = nullableDate(release.approved_by, "The methodology release approver");
	if (parsedState === "released" && effectiveDate == null) throw new Error("A released methodology must record its effective date.");
	if (parsedState === "released" && (releaseCommit == null || approvedBy == null)) throw new Error("A released methodology must record its source commit and approver.");
	return {
		publicVersion: publicVersion(release.public_version, "The public methodology version"),
		name: nonblank(release.name, "The methodology release name"),
		manifestDigest: nonblank(manifest.manifest_digest, "The methodology manifest digest"),
		state: parsedState,
		candidateStartedAt: nonblank(release.candidate_started_at, "The methodology candidate start date"),
		...effectiveDate != null ? { effectiveDate } : {},
		...releaseCommit != null ? { releaseCommit } : {},
		...approvedBy != null ? { approvedBy } : {}
	};
}
function load(moduleUrl) {
	const directory = shippedConfigDirectory("methodology", moduleUrl);
	return publicMethodologyFrom(record(join(directory, "version-1.release.json")), record(join(directory, "version-1.manifest.json")));
}
const PUBLIC_METHODOLOGY = load(import.meta.url);
//#endregion
export { PUBLIC_METHODOLOGY, publicMethodologyFrom };
