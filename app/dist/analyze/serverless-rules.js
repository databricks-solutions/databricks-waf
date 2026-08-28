import { shippedConfigDirectory } from "../shipped-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
//#region server/analyze/serverless-rules.ts
/**
* The rule ids the analyzer fires, as a type.
*
* Declared here rather than inferred from the file so that a rule the code depends on
* cannot be deleted from the YAML without the load failing. The two sets are compared at
* load, which is what stops the file and the analyzer drifting apart silently.
*/
const RULE_IDS = [
	"gpu-cluster",
	"run-exceeds-seven-days",
	"init-script",
	"instance-pool",
	"cloud-identity",
	"legacy-access-mode",
	"ml-runtime",
	"runtime-predates-serverless",
	"continuous-trigger",
	"compute-unclassified",
	"cluster-unreadable",
	"configuration-unwritten",
	"all-purpose-cluster",
	"policy-governed",
	"outside-metadata"
];
const KINDS = [
	"blocker",
	"rework",
	"unknown",
	"note"
];
function rulesDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("analyze", moduleUrl);
}
let cached;
/**
* The ruleset, read once per process.
*
* Cached because it is static data read from the bundle, and re-reading it per scan would
* put a synchronous file read on the path of every run for no benefit.
*/
function serverlessRules(directory = rulesDirectory()) {
	cached ??= loadRules(directory);
	return cached;
}
function loadRules(directory) {
	const path = join(directory, "serverless-rules.yaml");
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`The serverless ruleset is missing from ${path}; the app bundle is incomplete.`, { cause });
	}
	const parsed = load(text);
	if (parsed == null || typeof parsed !== "object") throw new Error(`${path} is not a YAML document.`);
	if (typeof parsed.version !== "number") throw new Error(`${path} does not declare a numeric version.`);
	if (!Array.isArray(parsed.rules)) throw new Error(`${path} declares no rules.`);
	const rules = /* @__PURE__ */ new Map();
	for (const entry of parsed.rules) {
		const rule = validate(entry, path);
		if (rules.has(rule.id)) throw new Error(`${path} declares the rule ${rule.id} twice.`);
		rules.set(rule.id, rule);
	}
	const declared = [...rules.keys()].sort();
	const expected = [...RULE_IDS].sort();
	if (declared.join(",") !== expected.join(",")) {
		const missing = expected.filter((id) => !rules.has(id));
		const extra = declared.filter((id) => !expected.includes(id));
		throw new Error(`${path} and the analyzer disagree about which rules exist. ` + (missing.length > 0 ? `The analyzer fires ${missing.join(", ")}, which the file does not declare. ` : "") + (extra.length > 0 ? `The file declares ${extra.join(", ")}, which nothing fires. ` : "") + "A rule that exists in one place and not the other is either a sentence no reader will see or a verdict with no words to explain it.");
	}
	return {
		version: parsed.version,
		rules,
		assumptions: assumptionsOf(parsed.assumptions, path)
	};
}
function validate(entry, path) {
	const id = entry["id"];
	if (typeof id !== "string" || id === "") throw new Error(`${path} has a rule with no id.`);
	const kind = entry["kind"];
	if (typeof kind !== "string" || !KINDS.includes(kind)) throw new Error(`Rule ${id} in ${path} has kind ${String(kind)}, which is not one of ${KINDS.join(", ")}.`);
	const headline = entry["headline"];
	const action = entry["action"];
	const detail = entry["detail"];
	const docUrl = entry["doc_url"];
	if (typeof headline !== "string" || headline === "") throw new Error(`Rule ${id} in ${path} has no headline.`);
	if (typeof action !== "string" || action.length < 20) throw new Error(`Rule ${id} in ${path} has no concrete action. A recommendation must tell the reader what to do first, not only describe the condition.`);
	if (typeof detail !== "string" || detail.length < 40) throw new Error(`Rule ${id} in ${path} has no detail, or a detail too short to say anything. A reader deciding whether to migrate a job needs to know what specifically breaks.`);
	if (typeof docUrl !== "string" || !docUrl.startsWith("https://")) throw new Error(`Rule ${id} in ${path} cites no documentation. Every claim about what serverless cannot do has to link to the page that says so, because the page changes and the claim has to be checkable.`);
	return {
		id,
		kind,
		action,
		headline,
		detail,
		docUrl
	};
}
function assumptionsOf(raw, path) {
	if (!Array.isArray(raw)) throw new Error(`${path} declares no cost assumptions. The estimate is arithmetic on two observed numbers and one assumption; publishing the number without the assumption is the part that would be dishonest.`);
	return raw.map((entry) => {
		const id = entry["id"];
		const statement = entry["statement"];
		if (typeof id !== "string" || id === "") throw new Error(`${path} has a cost assumption with no id.`);
		if (typeof statement !== "string" || statement.length < 40) throw new Error(`Cost assumption ${id} in ${path} has no statement, or one too short to be one.`);
		const docUrl = entry["doc_url"];
		return {
			id,
			statement,
			...typeof docUrl === "string" ? { docUrl } : {}
		};
	});
}
//#endregion
export { RULE_IDS, loadRules, rulesDirectory, serverlessRules };
