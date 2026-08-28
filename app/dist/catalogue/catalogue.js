import { shippedConfigDirectory } from "../shipped-config.js";
import { loadChangelog } from "./changelog.js";
import { NO_RECORD, recordedFrom } from "./methodology.js";
import { randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
//#region server/catalogue/catalogue.ts
/**
* Where the catalogue lives, found by walking up from this module.
*
* Searched rather than computed because this module runs from two different depths: from
* `server/catalogue/` under `tsx` in development, and from `dist/catalogue/` in the
* shipped bundle. A fixed number of `..` segments is right for one and wrong for the
* other, and the way that failure presents is an app that boots fine locally and dies on
* install with an ENOENT naming a path nobody wrote.
*/
function catalogueDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("controls", moduleUrl);
}
function loadCatalogue(directory = catalogueDirectory()) {
	const pillars = withSharedRemediation(readdirSync(directory).filter((name) => name.endsWith(".yaml")).sort().map((name) => readPillar(join(directory, name))));
	const controls = pillars.flatMap((pillar) => pillar.principles.flatMap((principle) => principle.controls));
	const aliasGroups = /* @__PURE__ */ new Map();
	for (const control of controls) {
		if (control.aliasGroup == null) continue;
		const group = aliasGroups.get(control.aliasGroup) ?? [];
		group.push(control);
		aliasGroups.set(control.aliasGroup, group);
	}
	const record = readVersionRecord(directory);
	return {
		version: record.version,
		changelog: loadChangelog(directory),
		recorded: record.recorded,
		pillars,
		controls,
		aliasGroups
	};
}
/**
* One fix per requirement, shared by every pillar that asks for it.
*
* An alias group is one requirement written down in several pillars — "use a data format that
* supports ACID transactions" in reliability is "use performance optimized data formats" in cost
* optimization, and converting the tables satisfies both. The group is already scored once. This
* makes it remediated once too, by giving the members that carry no `remediation` of their own the
* one their group carries.
*
* Resolved here rather than at each reader because there are several readers — the catalogue
* endpoint, the export, the finding pane — and a rule enforced in three places is a rule that
* holds in two. Resolved rather than copied into the YAML because two copies of the same
* instruction drift, and the drift shows up as one pillar telling a customer to do something the
* next pillar has stopped recommending.
*
* The whole `remediation` is inherited, not merged field by field. A summary from one control and
* a SQL snippet from another would read as one instruction and be two, which is worse than either.
*
* Nothing is inherited where the members that authored a fix do not agree on it, because sometimes
* they are right to disagree. `delta-history-retention` is the case: cost optimization asks for the
* retention window to be shortened and reliability asks for it to be long enough to recover from,
* and the catalogue states both, deliberately, with each caveat naming the other. That is one
* decision with two honest framings rather than a copy that drifted, and choosing a winner between
* them is not this function's judgement to make.
*/
function withSharedRemediation(pillars) {
	const authored = /* @__PURE__ */ new Map();
	for (const pillar of pillars) for (const principle of pillar.principles) for (const control of principle.controls) {
		if (control.aliasGroup == null || control.remediation == null) continue;
		authored.set(control.aliasGroup, [...authored.get(control.aliasGroup) ?? [], control.remediation]);
	}
	const inherited = /* @__PURE__ */ new Map();
	for (const [group, remediations] of authored) {
		const [first] = remediations;
		if (remediations.every((one) => same(one, first))) inherited.set(group, first);
	}
	if (inherited.size === 0) return pillars;
	const resolve = (control) => {
		if (control.remediation != null || control.aliasGroup == null) return control;
		const remediation = inherited.get(control.aliasGroup);
		return remediation == null ? control : {
			...control,
			remediation
		};
	};
	return pillars.map((pillar) => ({
		...pillar,
		principles: pillar.principles.map((principle) => ({
			...principle,
			controls: principle.controls.map(resolve)
		}))
	}));
}
/** Two remediations that say the same thing, whatever order the YAML listed their keys in. */
function same(a, b) {
	const flatten = (one) => JSON.stringify(Object.entries(one).sort(([x], [y]) => x.localeCompare(y)));
	return flatten(a) === flatten(b);
}
/**
* The version record, read once.
*
* Both halves come out of one parse because both come out of one file. Two readers of `version.json`
* is two places for a shipped install to disagree about which catalogue it has, which is the argument
* the changelog makes for living here rather than at its reader.
*/
function readVersionRecord(directory) {
	try {
		const parsed = JSON.parse(readFileSync(join(directory, "version.json"), "utf8"));
		const version = typeof parsed.version === "number" && Number.isFinite(parsed.version) ? String(parsed.version) : typeof parsed.version === "string" && parsed.version !== "" ? parsed.version : void 0;
		const fingerprint = typeof parsed.fingerprint === "string" && parsed.fingerprint !== "" ? parsed.fingerprint : void 0;
		return {
			version: version != null && fingerprint != null ? {
				version,
				fingerprint
			} : unknownVersion(),
			recorded: recordedFrom(parsed)
		};
	} catch {
		return {
			version: unknownVersion(),
			recorded: NO_RECORD
		};
	}
}
/**
* A version that compares equal to nothing, including another unknown one.
*
* Comparability keys on the fingerprint, so a fixed placeholder would make two scans
* with unreadable catalogues look like they asked the same questions. There is no
* evidence for that, and the trend view would draw a line across it. A unique value
* makes the absence behave like the uncertainty it represents.
*/
function unknownVersion() {
	return {
		version: "unknown",
		fingerprint: `unknown:${randomUUID()}`
	};
}
function readPillar(path) {
	const raw = load(readFileSync(path, "utf8"));
	const pillar = raw.pillar;
	return {
		id: pillar.id,
		code: pillar.code,
		title: pillar.title,
		page: pillar.page,
		principles: (raw.principles ?? []).map((principle) => ({
			id: principle.id,
			title: principle.title,
			sourceAnchor: principle.source_anchor,
			controls: (principle.controls ?? []).map((control) => toControl(control, pillar.id, principle.id))
		}))
	};
}
function toControl(raw, pillarId, principleId) {
	return {
		id: raw.id,
		pillarId,
		principleId,
		title: raw.title,
		severity: raw.severity,
		provenance: raw.provenance,
		measurability: raw.measurability,
		evaluatorStatus: raw.evaluator_status,
		coverageMode: raw.coverage_mode ?? "complete",
		clouds: raw.clouds ?? [
			"aws",
			"azure",
			"gcp"
		],
		dasf: raw.dasf ?? [],
		references: raw.references ?? [],
		...present("sourceAnchor", raw.source_anchor),
		...present("sourceRef", raw.source_ref),
		...present("rationale", raw.rationale),
		...present("collector", raw.collector),
		...present("criteria", raw.criteria),
		...present("aliasGroup", raw.alias_group),
		...present("thresholds", raw.thresholds),
		...present("remediation", raw.remediation == null ? void 0 : toRemediation(raw.remediation)),
		...present("attestation", raw.attestation == null ? void 0 : {
			question: raw.attestation.question,
			...present("evidenceGuidance", raw.attestation.evidence_guidance),
			...present("cadenceDays", raw.attestation.cadence_days),
			...present("proxySignal", raw.attestation.proxy_signal),
			...present("askedBecause", raw.attestation.asked_because == null ? void 0 : {
				verdict: raw.attestation.asked_because.verdict,
				why: raw.attestation.asked_because.why,
				...present("signal", raw.attestation.asked_because.signal)
			})
		}),
		...present("preconditions", raw.applicability?.preconditions?.map((precondition) => ({
			signal: precondition.signal,
			operator: precondition.operator,
			outcome: precondition.outcome,
			reason: precondition.reason,
			...present("value", precondition.value),
			...present("scope", precondition.scope)
		})))
	};
}
function toRemediation(raw) {
	return {
		...present("summary", raw.summary),
		...present("sql", raw.sql),
		...present("cli", raw.cli),
		...present("terraform", raw.terraform),
		...present("byHand", raw.by_hand),
		...present("deepLink", raw.deep_link),
		...present("docUrl", raw.doc_url),
		...present("caveat", raw.caveat)
	};
}
/**
* Include a key only when it has a value, so an absent catalogue field stays absent
* rather than becoming an explicit null in every API response and every stored scan.
*/
function present(key, value) {
	return value === void 0 ? {} : { [key]: value };
}
//#endregion
export { catalogueDirectory, loadCatalogue };
