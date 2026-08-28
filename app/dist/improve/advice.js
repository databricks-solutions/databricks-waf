import { jobRules, sizingRules, workloadRules, writeRules } from "../advise/workload-rules.js";
//#region server/improve/advice.ts
/** The five analyses one advisory run produces, named as a reader's URL names them. */
const ADVISORS = [
	"workload",
	"sizing",
	"jobs",
	"writes",
	"serverless"
];
var UnknownAdviceError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "UnknownAdviceError";
	}
};
/**
* The provenance for one finding of one advisory, or an error saying which part of the reference
* named nothing.
*
* The messages name the part rather than the whole, because a reference is four fields assembled by
* two different pieces of code and "no such finding" sends whoever reads it to check all four.
*/
function adviceFrom(advisory, reference) {
	const common = {
		advisoryId: advisory.id,
		measuredAt: advisory.finishedAt,
		lookbackDays: advisory.lookbackDays
	};
	if (reference.advisor === "workload") {
		const analysis = advisory.workload;
		if (analysis == null) throw missing("workload", advisory.id);
		const shape = [...analysis.top, ...analysis.failing].find((one) => one.shape === reference.resource);
		if (shape == null) throw noResource("query group", reference.resource, advisory.id);
		const finding = shape.findings.find((one) => one.rule === reference.rule);
		if (finding == null) throw noRule(reference.rule, "query group", reference.resource);
		const rule = workloadRules().rules.get(finding.rule);
		if (rule == null) throw noWords(reference.rule);
		return {
			...common,
			advisor: "workload",
			rule: finding.rule,
			versions: [{
				name: "rulesVersion",
				value: String(analysis.rulesVersion)
			}, {
				name: "rankingVersion",
				value: analysis.rankingVersion
			}],
			resource: {
				kind: "shape",
				id: shape.shape,
				workspaceId: shape.workspaceId
			},
			headline: rule.headline,
			detail: rule.detail,
			docUrl: rule.docUrl,
			severity: finding.severity,
			baseline: finding.evidence,
			assumptions: []
		};
	}
	if (reference.advisor === "sizing") {
		const analysis = advisory.sizing;
		if (analysis == null) throw missing("warehouse sizing", advisory.id);
		const warehouse = analysis.warehouses.find((one) => one.warehouseId === reference.resource);
		if (warehouse == null) throw noResource("warehouse", reference.resource, advisory.id);
		const finding = warehouse.findings.find((one) => one.rule === reference.rule);
		if (finding == null) throw noRule(reference.rule, "warehouse", reference.resource);
		const rule = sizingRules().rules.get(finding.rule);
		if (rule == null) throw noWords(reference.rule);
		return {
			...common,
			advisor: "sizing",
			rule: finding.rule,
			versions: [{
				name: "rulesVersion",
				value: String(analysis.rulesVersion)
			}],
			resource: {
				kind: "warehouse",
				id: warehouse.warehouseId,
				workspaceId: warehouse.workspaceId,
				name: warehouse.name
			},
			headline: rule.headline,
			detail: rule.detail,
			docUrl: rule.docUrl,
			severity: finding.severity,
			baseline: finding.evidence,
			assumptions: []
		};
	}
	if (reference.advisor === "jobs") {
		const analysis = advisory.jobs;
		if (analysis == null) throw missing("job health", advisory.id);
		const job = analysis.jobs.find((one) => one.jobId === reference.resource);
		if (job == null) throw noResource("job", reference.resource, advisory.id);
		const finding = job.findings.find((one) => one.rule === reference.rule);
		if (finding == null) throw noRule(reference.rule, "job", reference.resource);
		const rule = jobRules().rules.get(finding.rule);
		if (rule == null) throw noWords(reference.rule);
		return {
			...common,
			advisor: "jobs",
			rule: finding.rule,
			versions: [{
				name: "rulesVersion",
				value: String(analysis.rulesVersion)
			}],
			resource: {
				kind: "job",
				id: job.jobId,
				workspaceId: job.workspaceId,
				name: job.name
			},
			headline: rule.headline,
			detail: rule.detail,
			docUrl: rule.docUrl,
			severity: finding.severity,
			baseline: finding.evidence,
			assumptions: []
		};
	}
	if (reference.advisor === "writes") {
		const analysis = advisory.writes;
		if (analysis == null) throw missing("write patterns", advisory.id);
		const shape = analysis.shapes.find((one) => one.shape === reference.resource);
		if (shape == null) throw noResource("write group", reference.resource, advisory.id);
		const finding = shape.findings.find((one) => one.rule === reference.rule);
		if (finding == null) throw noRule(reference.rule, "write group", reference.resource);
		const rule = writeRules().rules.get(finding.rule);
		if (rule == null) throw noWords(reference.rule);
		return {
			...common,
			advisor: "writes",
			rule: finding.rule,
			versions: [{
				name: "rulesVersion",
				value: String(analysis.rulesVersion)
			}],
			resource: {
				kind: "shape",
				id: shape.shape,
				workspaceId: shape.workspaceId
			},
			headline: rule.headline,
			detail: rule.detail,
			docUrl: rule.docUrl,
			severity: finding.severity,
			baseline: finding.evidence,
			assumptions: []
		};
	}
	const analysis = advisory.serverless;
	if (analysis == null) throw missing("serverless readiness", advisory.id);
	const job = analysis.jobs.find((one) => one.jobId === reference.resource);
	if (job == null) throw noResource("job", reference.resource, advisory.id);
	const reason = job.reasons.find((one) => one.ruleId === reference.rule);
	if (reason == null) throw noRule(reference.rule, "job", reference.resource);
	return {
		...common,
		advisor: "serverless",
		rule: reason.ruleId,
		versions: [],
		resource: {
			kind: "job",
			id: job.jobId,
			workspaceId: job.workspaceId,
			name: job.name
		},
		headline: reason.headline,
		detail: reason.detail,
		docUrl: reason.docUrl,
		baseline: reason.evidence ?? [],
		observation: reason.observed,
		...job.estimate != null ? { opportunity: job.estimate } : {},
		assumptions: analysis.assumptions.map((one) => one.statement)
	};
}
function missing(advisor, advisoryId) {
	return new UnknownAdviceError(`Advisory ${advisoryId} has no ${advisor} analysis, so nothing in it can be acted on. A run that could not read that part of the estate has no findings there rather than none to report.`);
}
function noResource(kind, id, advisoryId) {
	return new UnknownAdviceError(`Advisory ${advisoryId} says nothing about the ${kind} ${id}.`);
}
function noRule(rule, kind, id) {
	return new UnknownAdviceError(`No rule called ${rule} fired on the ${kind} ${id} in this advisory. Advice changes between runs, so a finding that has gone is raised again from the run that shows it.`);
}
function noWords(rule) {
	return new UnknownAdviceError(`The rule ${rule} fired in this advisory and this build's ruleset has no words for it, so an action raised from it would say nothing about what it is.`);
}
//#endregion
export { ADVISORS, UnknownAdviceError, adviceFrom };
