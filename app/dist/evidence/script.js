import { shippedConfigDirectory } from "../shipped-config.js";
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
//#region server/evidence/script.ts
/** The file, as it ships. One file so an admin can read all of it before running it. */
const SCRIPT_NAME = "collect-evidence.py";
/**
* Where the script lives, found the same way the catalogue is.
*
* Searched upwards rather than computed from a depth, because this module runs from
* `server/evidence/` under tsx and from `dist/evidence/` in the bundle. Getting that wrong is a
* fault that only shows up in a deployed workspace, and it has happened here once already.
*/
function evidenceDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("evidence", moduleUrl);
}
/**
* The two declarations the app has to agree with the script about.
*
* Read out of the source rather than duplicated in TypeScript, because a copy would be a second
* place for the truth to live and the first place for it to go stale. Anchored to a line start so a
* mention in the docstring cannot be mistaken for the declaration — the repository's
* `check:evidence-script` fails if either stops matching, so this cannot quietly start guessing.
*/
const SCHEMA = /^SCHEMA = "([^"]+)"$/m;
const VERSION = /^SCRIPT_VERSION = "([^"]+)"$/m;
function loadEvidenceScript(directory = evidenceDirectory()) {
	const path = join(directory, SCRIPT_NAME);
	const bytes = readFileSync(path);
	const source = bytes.toString("utf8");
	const schema = SCHEMA.exec(source)?.[1];
	const version = VERSION.exec(source)?.[1];
	if (schema == null || version == null) throw new Error(`${path} does not declare both SCHEMA and SCRIPT_VERSION at the top level. The app reads them from the script so there is one source of truth, and it will not guess at either.`);
	return {
		name: SCRIPT_NAME,
		source,
		digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
		bytes: bytes.byteLength,
		schema,
		version,
		modifiedAt: statSync(path).mtime
	};
}
function evidenceScriptPayload(script, href) {
	const expected = script.digest.replace(/^sha256:/, "");
	return {
		name: script.name,
		digest: script.digest,
		bytes: script.bytes,
		schema: script.schema,
		version: script.version,
		modifiedAt: script.modifiedAt,
		href,
		verify: [
			`shasum -a 256 ${script.name}`,
			`sha256sum ${script.name}`,
			`expected: ${expected}`
		]
	};
}
//#endregion
export { SCRIPT_NAME, evidenceDirectory, evidenceScriptPayload, loadEvidenceScript };
