import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
//#region server/shipped-config.ts
/**
* Absolute path to `config/<name>`, found by searching upwards from `moduleUrl`.
*
* Throws rather than returning a guess. A missing data directory is a packaging
* fault, and one loud failure naming the directory is worth more than a hundred
* controls each reporting that they could not be measured.
*/
function shippedConfigDirectory(name, moduleUrl) {
	const from = dirname(fileURLToPath(moduleUrl));
	let here = from;
	for (;;) {
		const candidate = join(here, "config", name);
		if (existsSync(candidate)) return candidate;
		const parent = resolve(here, "..");
		if (parent === here) throw new Error(`No config/${name} directory found above ${from}. This data ships alongside the bundle, so its absence means the deployed tree is incomplete rather than that the workspace is missing something.`);
		here = parent;
	}
}
//#endregion
export { shippedConfigDirectory };
