import { inScope } from "../store/assessment-scope.js";
//#region server/scan/store.ts
function summarise(scan) {
	return {
		id: scan.id,
		startedAt: scan.startedAt,
		finishedAt: scan.finishedAt,
		state: scan.state,
		...scan.score.overall != null ? { overall: scan.score.overall } : {},
		...scan.score.range != null ? { range: scan.score.range } : {},
		actor: scan.stamp.actor,
		...scan.stamp.actorName != null ? { actorName: scan.stamp.actorName } : {},
		executionMode: scan.stamp.executionMode,
		...scan.stamp.trigger != null ? { trigger: scan.stamp.trigger } : {},
		catalogueVersion: scan.stamp.catalogueVersion,
		...scan.requestedPillars != null ? { requestedPillars: scan.requestedPillars } : {},
		measuredPillars: scan.measurement.map((entry) => entry.pillarId),
		freshPillars: scan.measurement.filter((entry) => !entry.carriedForward).map((entry) => entry.pillarId),
		counts: count(scan),
		pillarScores: Object.fromEntries(scan.score.pillars.filter((pillar) => pillar.score != null).map((pillar) => [pillar.pillarId, pillar.score])),
		outcomes: Object.fromEntries(scan.findings.map((finding) => [finding.controlId, finding.outcome])),
		stamp: scan.stamp
	};
}
function count(scan) {
	const of = (...outcomes) => scan.findings.filter((finding) => outcomes.includes(finding.outcome)).length;
	return {
		pass: of("pass", "satisfied-by-architecture"),
		fail: of("fail"),
		partial: of("partial"),
		unmeasurable: of("unmeasurable"),
		notApplicable: of("not-applicable")
	};
}
var InMemoryScanStore = class {
	capacity;
	durable = false;
	scans = [];
	constructor(capacity = 20) {
		this.capacity = capacity;
	}
	save(scan) {
		this.scans.unshift(scan);
		if (this.scans.length > this.capacity) this.scans.length = this.capacity;
		return Promise.resolve();
	}
	get(id, scope) {
		const scan = this.scans.find((one) => one.id === id);
		if (scan == null || !inScope(scan.stamp.definition?.id, scope)) return Promise.resolve(void 0);
		return Promise.resolve(scan);
	}
	latest(scope) {
		return Promise.resolve(this.scans.find((scan) => inScope(scan.stamp.definition?.id, scope)));
	}
	history(limit = this.capacity, scope) {
		return Promise.resolve(this.scans.filter((scan) => inScope(scan.stamp.definition?.id, scope)).slice(0, limit).map(summarise));
	}
};
//#endregion
export { InMemoryScanStore, summarise };
