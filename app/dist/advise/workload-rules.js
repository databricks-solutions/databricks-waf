import { shippedConfigDirectory } from "../shipped-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
//#region server/advise/workload-rules.ts
/**
* The rule ids the analyzer fires, as a type.
*
* Declared here rather than inferred from the file, so a rule the code depends on cannot be deleted from
* the YAML without the load failing. The two sets are compared at load.
*
* Seven of these are the seven of the thirteen reachable from `system.query.history` alone, and two more are
* extensions the measured estate put at the top of the page. `UDF_OR_PYTHON_BOUNDARY` is the tenth and the
* first that reads an operator plan (`33ib`); `EXCESSIVE_EXCHANGES` and `LARGE_SORT` are the eleventh and
* twelfth, and the first to read the graph's edges and a threshold measured over a corpus rather than picked
* (`33ie`). `DATA_SKEW` is the thirteenth (`33ifa`), and it is the one this phase most needed to not guess at:
* its evidence in the design document is an AQE marker or a task p99/p50 ratio, `system.query.history` has
* neither, and `33id` measured the plan's own max-to-median ratio non-zero on 23 of the 27 plans that carry it.
* A skew finding wired to that above zero would report skew on most of the estate; the counter it is wired to
* instead read zero on all 60 operators that carried it.
*
* `BROADCAST_CANDIDATE` is the fourteenth (`33ifc`) and the only one whose threshold is an assumption twice
* over. `33ifb` measured that no metric a plan carries sizes a join's side in bytes — the two named for the
* broadcast decision read zero on every join that carries them, and `Hashed relation size` moves the wrong way
* against the rows — so the rule reads the row count on the join's inputs instead of a byte size. And all 13
* joins in that corpus already broadcast, so there was no instance of the thing the rule fires on to calibrate
* against.
*
* `MISSING_OR_STALE_STATS` is the fifteenth (`33igb`) and completes the design document's thirteen. It is the
* only rule here that reads something other than the shape and its plan — the estate's own maintenance history
* — and the only one that answers half of its own name: `33iga` measured that a table with no statistics is
* indistinguishable from a table the automatic maintenance has not reached, so it fires on stale and is silent
* on missing. The rule's comment in `rules.ts` says what that silence does and does not mean.
*/
const WORKLOAD_RULE_IDS = [
	"FAILURE_RATE",
	"SERIAL_EXECUTION",
	"COMPILATION_DOMINATED",
	"CAPACITY_WAIT",
	"DATA_SPILL",
	"HIGH_SHUFFLE",
	"LOW_FILE_PRUNING",
	"SMALL_FILES",
	"UDF_OR_PYTHON_BOUNDARY",
	"EXCESSIVE_EXCHANGES",
	"LARGE_SORT",
	"DATA_SKEW",
	"BROADCAST_CANDIDATE",
	"MISSING_OR_STALE_STATS",
	"CACHE_HIT"
];
/**
* Which thresholds each rule must declare.
*
* The other half of the drift check. Comparing rule *ids* catches a deleted rule; this catches a renamed
* or deleted threshold inside a rule that still exists, which is the failure that does not announce
* itself: `row.spilledBytes > undefined` is `false`, so the rule loads, runs, never fires, and reports an
* estate with no spill.
*/
const REQUIRED = {
	FAILURE_RATE: [
		"failure_rate",
		"min_runs",
		"critical_failure_rate"
	],
	SERIAL_EXECUTION: [
		"parallelism",
		"min_ms",
		"mean_ms",
		"min_runs"
	],
	COMPILATION_DOMINATED: [
		"compilation_percent",
		"critical_compilation_percent",
		"min_runs"
	],
	CAPACITY_WAIT: [
		"queue_ms",
		"queue_to_execution",
		"critical_queue_to_execution"
	],
	DATA_SPILL: [
		"spill_ratio",
		"spill_bytes",
		"critical_spill_bytes"
	],
	HIGH_SHUFFLE: ["shuffle_ratio", "shuffle_bytes"],
	LOW_FILE_PRUNING: [
		"pruned_percent",
		"min_read_files",
		"critical_pruned_percent",
		"min_read_bytes"
	],
	SMALL_FILES: ["mean_file_bytes", "min_read_files"],
	UDF_OR_PYTHON_BOUNDARY: ["min_ms", "min_runs"],
	EXCESSIVE_EXCHANGES: [
		"exchanges",
		"min_ms",
		"min_runs"
	],
	LARGE_SORT: [
		"sort_rows",
		"min_ms",
		"min_runs"
	],
	DATA_SKEW: ["skewed_partitions"],
	BROADCAST_CANDIDATE: [
		"build_side_rows",
		"min_ms",
		"min_runs"
	],
	MISSING_OR_STALE_STATS: [
		"stale_hours",
		"min_ms",
		"min_runs"
	],
	CACHE_HIT: ["cache_rate", "min_runs"]
};
/**
* The sizing rule ids, as a type, for the same reason the query ones are declared here.
*
* Five, and each answers a different question about the same warehouse — concurrency, memory, idle
* uptime, cold starts and headroom. The file says why they cannot be collapsed: they look identical in a
* bill and take opposite actions.
*/
const SIZING_RULE_IDS = [
	"WAREHOUSE_QUEUEING",
	"WAREHOUSE_SPILL",
	"WAREHOUSE_IDLE_UPTIME",
	"WAREHOUSE_COLD_STARTS",
	"WAREHOUSE_HEADROOM"
];
const SIZING_REQUIRED = {
	WAREHOUSE_QUEUEING: [
		"queue_percent",
		"critical_queue_percent",
		"days_queued",
		"min_runs"
	],
	WAREHOUSE_SPILL: [
		"spill_bytes",
		"critical_spill_bytes",
		"days_spilled",
		"min_runs"
	],
	WAREHOUSE_IDLE_UPTIME: [
		"execution_percent",
		"min_up_ms",
		"min_days"
	],
	WAREHOUSE_COLD_STARTS: [
		"starts_per_day",
		"min_starts",
		"min_days"
	],
	WAREHOUSE_HEADROOM: [
		"p95_ms",
		"min_runs",
		"min_days"
	]
};
/**
* The job rule ids, as a type, for the same reason the other two families are declared here.
*
* Ten, and the arithmetic is in `job-rules.yaml`. The first four are the document's four discovery
* queries, which it lists as inputs to its rules rather than as rules, and none of them says anything about
* compute. The next four are its rules A, B, C and G, which do: they read `job_compute_utilisation.sql` and
* were ledger row `33ce`, held while `33ca`'s all-serverless estate returned no node timeline rows at all.
* `41b` measured the distributions on one that does and `47` decided what each may say.
*
* The last two are the document's D and E, and **neither is the document's rule**. `50` measured D's five
* conditions and found three unusable — low CPU selects 98.4% of pairs, CPU wait's p95 is 1.28%, and the two
* comparing traffic with data processed need a denominator `system.query.history` names no classic job
* cluster on. So `JOB_NETWORK_HEAVY` fires on the one condition that discriminates and is named for it: the
* words *I/O-bound* imply the comparison this app cannot make. `JOB_PHOTON_OFF` reads the billing record
* rather than the cluster configuration the document's own engine reads, which is what moved its reach from
* 8.7% to 96.6%.
*/
const JOB_RULE_IDS = [
	"JOB_LONG_RUNNING",
	"JOB_DOMINATED_BY_ONE_TASK",
	"JOB_RUNS_NOT_SUCCEEDING",
	"JOB_TASKS_RUN_AGAIN",
	"JOB_WORKERS_UNDERUSED",
	"JOB_MEMORY_BOUND",
	"JOB_COMPUTE_BOUND",
	"JOB_STARTUP_OVERHEAD",
	"JOB_NETWORK_HEAVY",
	"JOB_PHOTON_OFF"
];
const JOB_REQUIRED = {
	JOB_LONG_RUNNING: ["p95_seconds", "min_runs"],
	JOB_DOMINATED_BY_ONE_TASK: [
		"busiest_share",
		"min_tasks",
		"min_runs"
	],
	JOB_RUNS_NOT_SUCCEEDING: [
		"unsuccessful_share",
		"critical_unsuccessful_share",
		"min_resolved_runs"
	],
	JOB_TASKS_RUN_AGAIN: ["repeating_share", "min_runs"],
	JOB_WORKERS_UNDERUSED: [
		"cpu_percent",
		"memory_percent",
		"swap_percent",
		"cpu_wait_percent",
		"p95_seconds",
		"min_runs",
		"min_sampled_pairs"
	],
	JOB_MEMORY_BOUND: [
		"memory_percent",
		"peak_memory_percent",
		"min_runs",
		"min_sampled_pairs"
	],
	JOB_COMPUTE_BOUND: [
		"cpu_percent",
		"memory_percent",
		"cpu_wait_percent",
		"min_runs",
		"min_sampled_pairs"
	],
	JOB_STARTUP_OVERHEAD: [
		"setup_share",
		"setup_seconds",
		"min_runs"
	],
	JOB_NETWORK_HEAVY: [
		"median_multiple",
		"min_bytes_per_node_minute",
		"min_sampled_pairs",
		"min_estate_pairs",
		"min_runs"
	],
	JOB_PHOTON_OFF: ["photon_off_share", "min_photon_records"]
};
/**
* The write rule ids, as a type, for the same reason the other three families are declared here.
*
* Two, and they are the pair `33g` was left carrying after `41d` answered its other three: a table rewritten
* whole over and over, and a load that arrives in pieces too small to be worth a file each. Neither is in
* either design document, so both are extensions and both carry a rationale.
*
* The thing both rules must not do is in their own words rather than in a threshold. Whether a rewrite could
* have been a `MERGE`, and whether a load could have been Auto Loader, are properties of the code that
* produced the statement, and this app reads `system.query.history` — which holds what ran and not what
* could have run instead. So each names a pattern and offers the remedy as the thing to look at.
*/
const WRITE_RULE_IDS = ["TABLE_REWRITTEN_WHOLE", "INGEST_IN_SMALL_PIECES"];
const WRITE_REQUIRED = {
	TABLE_REWRITTEN_WHOLE: [
		"min_runs",
		"min_days",
		"median_write_bytes",
		"critical_written_bytes"
	],
	INGEST_IN_SMALL_PIECES: [
		"max_median_write_bytes",
		"min_runs",
		"min_days",
		"min_runs_per_day"
	]
};
let cachedWrites;
function writeRules(directory = workloadRulesDirectory()) {
	cachedWrites ??= loadWriteRules(directory);
	return cachedWrites;
}
function loadWriteRules(directory) {
	const path = join(directory, "write-rules.yaml");
	const parsed = document(path, "write ruleset");
	const rules = ruleMap(parsed["rules"], path);
	agree(rules, WRITE_RULE_IDS, path);
	declares(rules, WRITE_REQUIRED, path);
	return {
		version: version(parsed, path),
		rules
	};
}
let cachedJobs;
function jobRules(directory = workloadRulesDirectory()) {
	cachedJobs ??= loadJobRules(directory);
	return cachedJobs;
}
function loadJobRules(directory) {
	const path = join(directory, "job-rules.yaml");
	const parsed = document(path, "job ruleset");
	const rules = ruleMap(parsed["rules"], path);
	agree(rules, JOB_RULE_IDS, path);
	declares(rules, JOB_REQUIRED, path);
	return {
		version: version(parsed, path),
		rules
	};
}
let cachedSizing;
function sizingRules(directory = workloadRulesDirectory()) {
	cachedSizing ??= loadSizingRules(directory);
	return cachedSizing;
}
function loadSizingRules(directory) {
	const path = join(directory, "sizing-rules.yaml");
	const parsed = document(path, "sizing ruleset");
	const rules = ruleMap(parsed["rules"], path);
	agree(rules, SIZING_RULE_IDS, path);
	declares(rules, SIZING_REQUIRED, path);
	return {
		version: version(parsed, path),
		rules
	};
}
const SEVERITIES = [
	"critical",
	"high",
	"medium",
	"info"
];
const PROVENANCES = ["design-document", "extension"];
function workloadRulesDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("analyze", moduleUrl);
}
let cached;
/** The ruleset, read once per process: static data from the bundle. */
function workloadRules(directory = workloadRulesDirectory()) {
	cached ??= loadWorkloadRules(directory);
	return cached;
}
function loadWorkloadRules(directory) {
	const path = join(directory, "workload-rules.yaml");
	const parsed = document(path, "workload ruleset");
	const ranking = parsed["ranking_version"];
	if (typeof ranking !== "string" || ranking === "") throw new Error(`${path} does not name the ranking coefficient set. A ruleset and a ranking are only comparable across runs if both say which version produced them.`);
	const rules = ruleMap(parsed["rules"], path);
	agree(rules, WORKLOAD_RULE_IDS, path);
	declares(rules, REQUIRED, path);
	return {
		version: version(parsed, path),
		rankingVersion: ranking,
		rules
	};
}
/** The file as a YAML mapping, or an error naming which ruleset is unreadable. */
function document(path, what) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (cause) {
		throw new Error(`The ${what} is missing from ${path}; the app bundle is incomplete.`, { cause });
	}
	const parsed = load(text);
	if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a YAML document.`);
	return parsed;
}
function version(parsed, path) {
	const declared = parsed["version"];
	if (typeof declared !== "number") throw new Error(`${path} does not declare a numeric version.`);
	return declared;
}
function ruleMap(raw, path) {
	if (!Array.isArray(raw)) throw new Error(`${path} declares no rules.`);
	const rules = /* @__PURE__ */ new Map();
	for (const entry of raw) {
		const rule = validate(entry, path);
		if (rules.has(rule.id)) throw new Error(`${path} declares the rule ${rule.id} twice.`);
		rules.set(rule.id, rule);
	}
	return rules;
}
/** The file and the code have to name the same rules. Either alone is a rule nobody sees fire. */
function agree(rules, ids, path) {
	const declared = [...rules.keys()].sort();
	const expected = [...ids].sort();
	if (declared.join(",") === expected.join(",")) return;
	const missing = expected.filter((id) => !rules.has(id));
	const extra = declared.filter((id) => !ids.includes(id));
	throw new Error(`${path} and the advisor disagree about which rules exist. ` + (missing.length > 0 ? `The advisor fires ${missing.join(", ")}, which the file does not declare. ` : "") + (extra.length > 0 ? `The file declares ${extra.join(", ")}, which nothing fires. ` : "") + "A rule that exists in one place and not the other is either a sentence no reader will see or a finding with no words to explain it.");
}
/**
* Every threshold a condition reads has to be in the file.
*
* The other half of the drift check, and the half that catches the failure that does not announce itself:
* `row.spilledBytes > undefined` is `false`, so a rule missing a threshold loads, runs, never fires, and
* reports an estate with no spill.
*/
function declares(rules, required, path) {
	for (const [id, names] of Object.entries(required)) {
		const rule = rules.get(id);
		const absent = names.filter((name) => rule?.thresholds[name] == null);
		if (absent.length > 0) throw new Error(`Rule ${id} in ${path} does not declare ${absent.join(", ")}, which its condition reads. A threshold the code compares against and the file omits is a rule that never fires and never says why.`);
	}
}
function validate(entry, path) {
	const id = entry["id"];
	if (typeof id !== "string" || id === "") throw new Error(`${path} has a rule with no id.`);
	const severity = entry["severity"];
	if (typeof severity !== "string" || !SEVERITIES.includes(severity)) throw new Error(`Rule ${id} in ${path} has severity ${String(severity)}, not one of ${SEVERITIES.join(", ")}.`);
	const provenance = entry["provenance"];
	if (typeof provenance !== "string" || !PROVENANCES.includes(provenance)) throw new Error(`Rule ${id} in ${path} has provenance ${String(provenance)}, not one of ${PROVENANCES.join(", ")}.`);
	const headline = entry["headline"];
	const action = entry["action"];
	const detail = entry["detail"];
	const docUrl = entry["doc_url"];
	if (typeof headline !== "string" || headline === "") throw new Error(`Rule ${id} in ${path} has no headline.`);
	if (typeof action !== "string" || action.length < 20) throw new Error(`Rule ${id} in ${path} has no concrete action. A recommendation must tell the reader what to do first, not only describe the problem.`);
	if (typeof detail !== "string" || detail.length < 80) throw new Error(`Rule ${id} in ${path} has no detail, or a detail too short to say anything. A reader shown a finding needs to know what causes it and what to do, not that something is slow.`);
	if (typeof docUrl !== "string" || !docUrl.startsWith("https://")) throw new Error(`Rule ${id} in ${path} cites no documentation. Every recommendation has to link to the page behind it, because the page changes and the claim has to be checkable.`);
	const rationale = entry["rationale"];
	if (provenance === "extension" && (typeof rationale !== "string" || rationale.length < 80)) throw new Error(`Rule ${id} in ${path} is an extension and carries no rationale. A rule no design document names owes an explanation where an anchored rule carries its anchor.`);
	return {
		id,
		provenance,
		severity,
		action,
		headline,
		detail,
		docUrl,
		...typeof rationale === "string" ? { rationale } : {},
		thresholds: thresholdsOf(entry["thresholds"], id, path)
	};
}
function thresholdsOf(raw, id, path) {
	if (raw == null || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`Rule ${id} in ${path} declares no thresholds.`);
	const entries = Object.entries(raw).map(([name, value]) => {
		if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Threshold ${name} of rule ${id} in ${path} is ${String(value)} rather than a number.`);
		return [name, value];
	});
	return Object.fromEntries(entries);
}
//#endregion
export { JOB_RULE_IDS, SIZING_RULE_IDS, WORKLOAD_RULE_IDS, WRITE_RULE_IDS, jobRules, loadJobRules, loadSizingRules, loadWorkloadRules, loadWriteRules, sizingRules, workloadRules, workloadRulesDirectory, writeRules };
