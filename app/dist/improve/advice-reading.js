import { jobRules, sizingRules, workloadRules } from "../advise/workload-rules.js";
import { serverlessRules } from "../analyze/serverless-rules.js";
//#region server/improve/advice-reading.ts
/**
* What a later advisory says about one action's advice.
*
* A pure function of the two records, called wherever an action is read rather than stored beside it.
* The same argument `progress.ts` opens with: the advisory already says this, and a stored copy would
* be a field that drifts from the two records it was derived from.
*/
function adviceReadingOf(advice, advisory) {
	const common = {
		advisoryId: advisory.id,
		measuredAt: advisory.finishedAt,
		lookbackDays: advisory.lookbackDays,
		unmatched: []
	};
	const nothing = {
		...common,
		movements: []
	};
	if (advisory.finishedAt.getTime() <= advice.measuredAt.getTime()) return {
		...nothing,
		standing: "not-later"
	};
	if (!known(advice.advisor, advice.rule)) return {
		...nothing,
		standing: "rule-withdrawn"
	};
	const found = locate(advisory, advice);
	if (found.analysis == null) return {
		...nothing,
		standing: "advisor-unread"
	};
	if (!found.analysis.resource) return {
		...nothing,
		standing: "resource-absent"
	};
	if (found.analysis.evidence == null) return {
		...nothing,
		standing: "cleared"
	};
	const incomparable = whyIncomparable(advice, advisory, found.analysis.versions);
	if (incomparable != null) return {
		...nothing,
		standing: "still-firing",
		incomparable
	};
	const later = new Map(found.analysis.evidence.map((one) => [one.label, one]));
	const movements = [];
	const unmatched = [];
	for (const before of advice.baseline) {
		const after = later.get(before.label);
		if (after == null || after.unit !== before.unit) {
			unmatched.push(before.label);
			continue;
		}
		movements.push({
			label: before.label,
			unit: before.unit,
			before: before.value,
			after: after.value
		});
	}
	return {
		...common,
		standing: "still-firing",
		movements,
		unmatched
	};
}
/** Whether this build still has the rule, which is what decides `rule-withdrawn`. */
function known(advisor, rule) {
	if (advisor === "workload") return workloadRules().rules.has(rule);
	if (advisor === "sizing") return sizingRules().rules.has(rule);
	if (advisor === "jobs") return jobRules().rules.has(rule);
	return serverlessRules().rules.has(rule);
}
function locate(advisory, advice) {
	if (advice.advisor === "workload") {
		const analysis = advisory.workload;
		if (analysis == null) return {};
		const versions = [{
			name: "rulesVersion",
			value: String(analysis.rulesVersion)
		}, {
			name: "rankingVersion",
			value: analysis.rankingVersion
		}];
		const shape = [...analysis.top, ...analysis.failing].find((one) => one.shape === advice.resource.id);
		if (shape == null) return { analysis: {
			resource: false,
			versions
		} };
		const finding = shape.findings.find((one) => one.rule === advice.rule);
		return { analysis: {
			resource: true,
			versions,
			...finding == null ? {} : { evidence: finding.evidence }
		} };
	}
	if (advice.advisor === "sizing") {
		const analysis = advisory.sizing;
		if (analysis == null) return {};
		const versions = [{
			name: "rulesVersion",
			value: String(analysis.rulesVersion)
		}];
		const warehouse = analysis.warehouses.find((one) => one.warehouseId === advice.resource.id);
		if (warehouse == null) return { analysis: {
			resource: false,
			versions
		} };
		const finding = warehouse.findings.find((one) => one.rule === advice.rule);
		return { analysis: {
			resource: true,
			versions,
			...finding == null ? {} : { evidence: finding.evidence }
		} };
	}
	if (advice.advisor === "jobs") {
		const analysis = advisory.jobs;
		if (analysis == null) return {};
		const versions = [{
			name: "rulesVersion",
			value: String(analysis.rulesVersion)
		}];
		const job = analysis.jobs.find((one) => one.jobId === advice.resource.id);
		if (job == null) return { analysis: {
			resource: false,
			versions
		} };
		const finding = job.findings.find((one) => one.rule === advice.rule);
		return { analysis: {
			resource: true,
			versions,
			...finding == null ? {} : { evidence: finding.evidence }
		} };
	}
	const analysis = advisory.serverless;
	if (analysis == null) return {};
	const job = analysis.jobs.find((one) => one.jobId === advice.resource.id);
	if (job == null) return { analysis: {
		resource: false,
		versions: []
	} };
	const reason = job.reasons.find((one) => one.ruleId === advice.rule);
	return { analysis: {
		resource: true,
		versions: [],
		...reason == null ? {} : { evidence: reason.evidence ?? [] }
	} };
}
/**
* Why the two readings may not be subtracted, or nothing where they may.
*
* The window first, because it is the one that is different every time somebody reruns an advisory
* over a different period and the one a reader can act on: run it again over the same days.
*/
function whyIncomparable(advice, advisory, versions) {
	if (advisory.lookbackDays !== advice.lookbackDays) return "window";
	const before = new Map(advice.versions.map((one) => [one.name, one.value]));
	for (const version of versions) if (before.get(version.name) !== version.value) return "rules-version";
	return before.size === versions.length ? void 0 : "rules-version";
}
//#endregion
export { adviceReadingOf };
