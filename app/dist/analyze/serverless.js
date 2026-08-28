import { rowsOf } from "../collect/sql/shapes.js";
import { asJob, linksIn } from "../resolve/locate.js";
import { agreeing } from "../resolve/resolvers/helpers.js";
import { serverlessRules } from "./serverless-rules.js";
//#region server/analyze/serverless.ts
const READINESS = "sql:serverless.job_readiness";
const JOB_SPEND = "sql:serverless.job_spend";
const JOB_INVENTORY = "sql:jobs.inventory";
const WORKSPACES = "sql:estate.workspaces";
/**
* What this analysis needs collected.
*
* Exported so the scan can add them to its plan. No resolver reads these two signals — the
* spend-share resolver behind the four requirements reads the estate aggregate instead — so
* without this they would be filtered out of the plan and the analysis would find nothing.
*/
const SERVERLESS_ANALYZER_SIGNALS = [
	READINESS,
	JOB_SPEND,
	JOB_INVENTORY,
	WORKSPACES
];
/**
* The requirements this analysis stands behind.
*
* Named here rather than as a field on the catalogue entries, so the link between a finding
* and the analysis that elaborates it comes from the analyzer that produces it. A control
* cannot then claim an analysis that was never built.
*/
const EXPLAINS = [
	"CO-01-06",
	"PE-02-01",
	"REL-01-06",
	"IU-03-02"
];
/** The runtime major version below which a job has never run on a Spark serverless offers. */
const OLDEST_SERVERLESS_RUNTIME_MAJOR = 14;
/** The platform's ceiling on a single serverless workload. */
const SEVEN_DAYS_SECONDS = 10080 * 60;
/**
* How many jobs are listed.
*
* A cap rather than everything, because the list is a work queue and a queue of four
* hundred is not one. Sorted by classic spend, so the cut falls on the jobs whose migration
* is worth least, and the total is always reported beside the cut.
*/
const LISTED = 40;
/**
* The analysis, from the three signals it reads.
*
* Returns undefined when the readiness signal could not be read at all, because an empty
* analysis and an unread one are different claims and the caller shows different things for
* them. A readiness signal that was read and found no jobs returns a result with no jobs:
* an estate that ran nothing is a measurement.
*/
function analyseServerless(signals, lookbackDays) {
	const readiness = signals.get(READINESS);
	if (readiness == null) return void 0;
	if (readiness.status !== "observed") return {
		...empty(lookbackDays),
		unmeasured: readiness.unmeasurableReason ?? "The per-job compute history could not be read, so no job could be assessed for serverless."
	};
	const spend = signals.get(JOB_SPEND);
	const jobs = signals.get(JOB_INVENTORY);
	const workspaces = signals.get(WORKSPACES);
	const analysis = analyse({
		readiness: readiness.value,
		spend: spend?.status === "observed" ? spend.value : [],
		jobs: jobs?.status === "observed" ? jobs.value : [],
		lookbackDays,
		...workspaces?.status === "observed" ? { directory: workspaces.value } : {}
	});
	if (spend != null && spend.status !== "observed") return {
		...analysis,
		unmeasured: spend.unmeasurableReason ?? "Per-job billing could not be read, so the verdicts here carry no cost and no estimate."
	};
	return analysis;
}
function analyse(input) {
	const ruleset = serverlessRules();
	const rule = (id) => {
		const found = ruleset.rules.get(id);
		if (found == null) throw new Error(`The serverless ruleset has no rule ${id}.`);
		return found;
	};
	const named = new Map(input.jobs.map((job) => [key(job.workspaceId, job.jobId), job]));
	const spending = new Map(input.spend.map((row) => [key(row.workspaceId, row.jobId), row]));
	const link = linksIn(input.directory);
	const live = rowsOf(input.directory?.live);
	const known = rowsOf(input.directory?.workspaces);
	const workspaces = live.length > 1 ? new Map(known.map((workspace) => [workspace.workspaceId, workspace.name])) : void 0;
	const candidates = [];
	let alreadyServerless = 0;
	let onWarehouse = 0;
	for (const row of input.readiness) {
		if (row.classicUses === 0 && row.unclassifiedUses === 0) {
			if (row.serverlessUses > 0) alreadyServerless += 1;
			else if (row.warehouseUses > 0) onWarehouse += 1;
			continue;
		}
		const found = key(row.workspaceId, row.jobId);
		candidates.push({
			...assess(row, named.get(found), spending.get(found), rule),
			...optional("workspace", workspaces?.get(row.workspaceId)),
			...optional("link", link(asJob(row)))
		});
	}
	const ordered = [...candidates].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.runs - a.runs || a.jobId.localeCompare(b.jobId));
	const listed = ordered.slice(0, LISTED);
	const counts = {
		ready: 0,
		rework: 0,
		blocked: 0,
		unknown: 0
	};
	for (const job of ordered) counts[job.verdict] += 1;
	const currency = ordered.find((job) => job.currency != null)?.currency;
	const cost = ordered.reduce((total, job) => total + (job.cost ?? 0), 0);
	const priced = ordered.filter((job) => job.estimate != null && (job.verdict === "ready" || job.verdict === "rework"));
	const regions = new Set(priced.map((job) => job.estimate?.region));
	return {
		lookbackDays: input.lookbackDays,
		jobsRan: input.readiness.length,
		alreadyServerless,
		onWarehouse,
		jobs: listed,
		counts,
		...cost > 0 ? { cost: round(cost) } : {},
		...currency != null ? { currency } : {},
		...priced.length > 0 ? { estimate: {
			low: round(priced.reduce((total, job) => total + (job.estimate?.low ?? 0), 0)),
			high: round(priced.reduce((total, job) => total + (job.estimate?.high ?? 0), 0)),
			currency: priced[0]?.estimate?.currency ?? "USD",
			jobs: priced.length,
			...regions.size === 1 && priced[0]?.estimate?.region != null ? { region: priced[0].estimate.region } : {}
		} } : {},
		assumptions: ruleset.assumptions,
		caveat: reasonOf(rule("outside-metadata"), "Every verdict on this page is about compute, not code."),
		...ordered.length > listed.length ? { truncated: {
			listed: listed.length,
			found: ordered.length
		} } : {}
	};
}
/**
* One job's verdict.
*
* Each rule fires from a count rather than from a boolean, so the sentence the reader gets
* says how many clusters or runs were involved. "Two of this job's clusters run an init
* script" is actionable in a way that "init scripts: yes" is not.
*/
function assess(row, job, spend, rule) {
	const reasons = [];
	const add = (id, observed, evidence = []) => reasons.push(reasonOf(rule(id), observed, evidence));
	/** A count of clusters, which is what most of these rules fire on. */
	const of = (label, value) => [{
		label,
		value,
		unit: "count"
	}];
	if (row.gpuClusters > 0) add("gpu-cluster", `${clusters(row.gpuClusters)} this job ran on had GPU workers.`, of("Clusters with GPU workers", row.gpuClusters));
	if (row.longestTaskSeconds > SEVEN_DAYS_SECONDS) add("run-exceeds-seven-days", `Its longest task run took ${days(row.longestTaskSeconds)}, past the seven-day serverless ceiling.`, [{
		label: "Longest task run",
		value: row.longestTaskSeconds * 1e3,
		unit: "ms"
	}]);
	if (row.initScriptClusters > 0) add("init-script", `${clusters(row.initScriptClusters)} it ran on had at least one init script.`, of("Clusters running an init script", row.initScriptClusters));
	if (row.pooledClusters > 0) add("instance-pool", `${clusters(row.pooledClusters)} it ran on drew nodes from an instance pool.`, of("Clusters drawing from a pool", row.pooledClusters));
	if (row.cloudIdentityClusters > 0) add("cloud-identity", `${clusters(row.cloudIdentityClusters)} it ran on carried an instance profile or service account.`, of("Clusters carrying a cloud identity", row.cloudIdentityClusters));
	if (row.legacyAccessModeClusters > 0) add("legacy-access-mode", `${clusters(row.legacyAccessModeClusters)} it ran on used no-isolation or a pre-Unity-Catalog access mode.`, of("Clusters on a legacy access mode", row.legacyAccessModeClusters));
	if (row.mlRuntimeClusters > 0) add("ml-runtime", `${clusters(row.mlRuntimeClusters)} it ran on used an ML runtime.`, of("Clusters on an ML runtime", row.mlRuntimeClusters));
	if (row.oldestRuntimeMajor != null && row.oldestRuntimeMajor < OLDEST_SERVERLESS_RUNTIME_MAJOR) {
		const seen = row.runtimes.length > 0 ? ` (${row.runtimes.join(", ")})` : "";
		add("runtime-predates-serverless", `Its oldest runtime was version ${String(row.oldestRuntimeMajor)}${seen}, older than any serverless environment.`);
	}
	if (job?.continuous === true) add("continuous-trigger", "The job is configured to run continuously.");
	if (row.unclassifiedUses > 0) add("compute-unclassified", `${row.unclassifiedUses} of its ${row.computeUses} recorded compute uses could not be classified.`, [{
		label: "Compute uses not classified",
		value: row.unclassifiedUses,
		unit: "count"
	}, {
		label: "Compute uses recorded",
		value: row.computeUses,
		unit: "count"
	}]);
	if (row.unreadClusters > 0) add("cluster-unreadable", `${clusters(row.unreadClusters)} it used had no configuration on record.`, of("Clusters with no configuration on record", row.unreadClusters));
	const unwritten = row.unknownInitScriptClusters + row.unknownAccessModeClusters;
	if (unwritten > 0) add("configuration-unwritten", row.unknownInitScriptClusters > 0 && row.unknownAccessModeClusters > 0 ? `Init scripts and access mode were unrecorded on some of the clusters it used.` : row.unknownInitScriptClusters > 0 ? `Init scripts were unrecorded on ${clusters(row.unknownInitScriptClusters)} it used.` : `Access mode was unrecorded on ${clusters(row.unknownAccessModeClusters)} it used.`, of("Clusters with unrecorded configuration", unwritten));
	if (row.allPurposeClusters > 0) add("all-purpose-cluster", `${clusters(row.allPurposeClusters)} it ran on was interactive compute.`, of("Interactive clusters", row.allPurposeClusters));
	if (row.policyClusters > 0) add("policy-governed", `${clusters(row.policyClusters)} it ran on was created under a compute policy.`, of("Clusters created under a policy", row.policyClusters));
	const money = estimateFor(row, spend);
	return {
		workspaceId: row.workspaceId,
		jobId: row.jobId,
		name: job?.name ?? `Job ${row.jobId}`,
		verdict: verdictOf(reasons),
		runs: row.runs,
		classicClusters: row.classicClusters,
		reasons,
		clusters: row.clusterNames,
		...row.lastRun != null ? { lastRun: row.lastRun } : {},
		...money
	};
}
/**
* Blocked, then rework, then unknown, then ready.
*
* The precedence is the whole judgement of this function and the reasoning is in the file
* header: an unknown is a hole in the evidence, and a hole does not erase the actionable
* thing found beside it.
*/
function verdictOf(reasons) {
	if (reasons.some((reason) => reason.kind === "blocker")) return "blocked";
	if (reasons.some((reason) => reason.kind === "rework")) return "rework";
	if (reasons.some((reason) => reason.kind === "unknown")) return "unknown";
	return "ready";
}
/**
* What the job costs now and what it might cost on serverless.
*
* The range spans one measured quantity: the start-up time classic compute billed and
* serverless does not. Its width is therefore this job's own idle share rather than a
* confidence interval, and the assumptions list says so. Where the price list holds no
* serverless rate for the region, there is no estimate at all and the reason is carried,
* because a zero here would read as free.
*/
function estimateFor(row, spend) {
	if (spend == null || spend.classicDbus <= 0) return {};
	const base = {
		cost: spend.classicCost,
		...spend.currency != null ? { currency: spend.currency } : {}
	};
	if (spend.unpricedRecords > 0) return {
		...base,
		noEstimate: `${agreeing(spend.unpricedRecords, "usage record").noun} for this job ${agreeing(spend.unpricedRecords, "usage record").verb} no matching list price, so its serverless cost is not estimated rather than computed over an incomplete bill.`
	};
	if (spend.serverlessRate == null) return {
		...base,
		noEstimate: spend.serverlessRegion == null ? "This workspace has no serverless usage of any kind in the window, so which region’s published rate applies to it could not be established. Serverless SKUs name their region and classic ones do not, so there is nothing here to read it from and the cost is left unestimated rather than guessed at." : `Your price list holds no serverless jobs rate for this job’s tier in ${spend.serverlessRegion}, so its serverless cost is not estimated rather than guessed at.`
	};
	const measured = row.setupSeconds + row.executionSeconds;
	const startupShare = measured > 0 ? row.setupSeconds / measured : 0;
	const high = spend.classicDbus * spend.serverlessRate;
	return {
		...base,
		estimate: {
			low: round(high * (1 - startupShare)),
			high: round(high),
			currency: spend.currency ?? "USD",
			...spend.serverlessRegion != null ? { region: spend.serverlessRegion } : {}
		},
		...measured > 0 ? { startupShare } : {}
	};
}
function reasonOf(rule, observed, evidence = []) {
	return {
		ruleId: rule.id,
		kind: rule.kind,
		action: rule.action,
		headline: rule.headline,
		detail: rule.detail,
		docUrl: rule.docUrl,
		observed,
		evidence
	};
}
function empty(lookbackDays) {
	const ruleset = serverlessRules();
	const caveat = ruleset.rules.get("outside-metadata");
	if (caveat == null) throw new Error("The serverless ruleset has no rule outside-metadata.");
	return {
		lookbackDays,
		jobsRan: 0,
		alreadyServerless: 0,
		onWarehouse: 0,
		jobs: [],
		counts: {
			ready: 0,
			rework: 0,
			blocked: 0,
			unknown: 0
		},
		assumptions: ruleset.assumptions,
		caveat: reasonOf(caveat, "Every verdict on this page is about compute, not code.")
	};
}
function key(workspaceId, jobId) {
	return `${workspaceId}/${jobId}`;
}
/** A field only when there is one, so an absent value is absent rather than undefined. */
function optional(name, value) {
	return value == null ? {} : { [name]: value };
}
function clusters(count) {
	return count === 1 ? "One cluster" : `${count} clusters`;
}
function days(seconds) {
	return `${(seconds / 86400).toFixed(1)} days`;
}
function round(value) {
	return Math.round(value * 100) / 100;
}
//#endregion
export { EXPLAINS, JOB_INVENTORY, JOB_SPEND, READINESS, SERVERLESS_ANALYZER_SIGNALS, WORKSPACES, analyse, analyseServerless };
