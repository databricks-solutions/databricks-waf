import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { load } from "js-yaml";
import { fileURLToPath } from "node:url";
//#region server/collect/rest/declared-scopes.ts
/**
* `app.yaml` as deployed, found by walking up from this module.
*
* Walking rather than a fixed relative path because the compiled layout and the source layout
* differ in depth, and a path correct in one is silently wrong in the other — silently,
* because a missing file here degrades to an empty list, which is the safe direction and also
* the invisible one.
*/
function appYaml(from) {
	let directory = dirname(fileURLToPath(from));
	for (let depth = 0; depth < 8; depth += 1) try {
		return readFileSync(join(directory, "app.yaml"), "utf8");
	} catch {
		const parent = dirname(directory);
		if (parent === directory) return void 0;
		directory = parent;
	}
}
/**
* The scopes `app.yaml` declares, or an empty list if it cannot be read.
*
* Empty is the honest answer for "cannot tell", and it is also the one that makes every scope
* refusal report as permanent. That is the right way round: telling someone their consent is
* stale, when the truth is that the file could not be read, sends them to re-authorise for a
* scope the app never wanted.
*/
function declaredScopes(from = import.meta.url) {
	const text = appYaml(from);
	if (text == null) return [];
	try {
		const parsed = load(text);
		if (typeof parsed !== "object" || parsed === null) return [];
		const scopes = parsed["user_api_scopes"];
		if (!Array.isArray(scopes)) return [];
		return scopes.filter((scope) => typeof scope === "string");
	} catch {
		return [];
	}
}
//#endregion
export { declaredScopes };
