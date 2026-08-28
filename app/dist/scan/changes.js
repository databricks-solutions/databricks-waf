import { NO_CHANGELOG, spanBetween } from "../catalogue/changelog.js";
import { comparable } from "../shared/api/comparability.js";
import "./scan.js";
import { attribute } from "./attribution.js";
//#region server/scan/changes.ts
/**
* What changed between a run and the one before it.
*
* `previous` is the run immediately before by finish time, which the caller resolves — this
* function does not go to the store, so it can be tested with two objects.
*/
function changesBetween(scan, previous, catalogue, changelog = NO_CHANGELOG) {
	if (previous == null) return {
		comparable: false,
		reason: "This is the first recorded run, so there is nothing to compare it against.",
		changes: [],
		unobserved: []
	};
	const span = spanBetween(changelog, previous.stamp.catalogueVersion, scan.stamp.catalogueVersion);
	const verdict = comparable(scan.stamp, previous.stamp, span);
	if (!verdict.ok) return {
		comparable: false,
		...verdict.reason != null ? { reason: verdict.reason } : {},
		previous: summary(previous),
		changes: [],
		unobserved: []
	};
	const carried = new Set(scan.measurement.filter((entry) => entry.carriedForward).map((entry) => entry.pillarId));
	const renamedFrom = new Map([...span.renamed].map(([from, to]) => [to, from]));
	const arrived = new Set(span.added);
	const occupied = new Set([...span.removed].filter((id) => renamedFrom.has(id) || arrived.has(id)));
	const before = new Map(previous.findings.filter((finding) => !occupied.has(finding.controlId)).map((finding) => [span.renamed.get(finding.controlId) ?? finding.controlId, finding.outcome]));
	const after = new Map(scan.findings.map((finding) => [finding.controlId, finding.outcome]));
	const titles = new Map(catalogue.controls.map((control) => [control.id, control]));
	const redefined = new Map(span.changed.map((change) => [change.id, change.fields]));
	const changes = [];
	for (const controlId of /* @__PURE__ */ new Set([...before.keys(), ...after.keys()])) {
		const from = before.get(controlId) ?? "absent";
		const to = after.get(controlId) ?? "absent";
		if (from === to) continue;
		const control = titles.get(controlId);
		const was = renamedFrom.get(controlId);
		const fields = redefined.get(controlId);
		changes.push({
			controlId,
			title: control?.title ?? controlId,
			pillarId: control?.pillarId ?? "unknown",
			severity: control?.severity ?? "informational",
			from,
			to,
			...was != null ? { wasKnownAs: was } : {},
			...fields != null ? { redefined: fields } : {}
		});
	}
	const overallDelta = scan.score.overall != null && previous.score.overall != null ? scan.score.overall - previous.score.overall : void 0;
	const attribution = scan.stamp.catalogueFingerprint === previous.stamp.catalogueFingerprint ? void 0 : attribute(scan, previous, span, aliasGroupOf(catalogue));
	return {
		comparable: true,
		...verdict.caveat != null ? { caveat: verdict.caveat } : {},
		previous: summary(previous),
		...overallDelta != null ? { overallDelta } : {},
		...attribution != null ? { attribution } : {},
		changes: changes.sort((a, b) => rank(a) - rank(b) || a.controlId.localeCompare(b.controlId)),
		unobserved: [...carried].sort()
	};
}
/**
* How to collapse requirements expressed in more than one pillar, for the re-score the split needs.
*
* Taken from the catalogue the comparison was drawn against, so the stable core is scored the way
* the runs were. A re-score that double-counted a shared requirement would move the estate half by
* the size of the overlap and blame the customer's platform for it.
*/
function aliasGroupOf(catalogue) {
	const groups = new Map(catalogue.controls.map((control) => [control.id, control.aliasGroup]));
	return (controlId) => groups.get(controlId);
}
function summary(scan) {
	return {
		id: scan.id,
		finishedAt: scan.finishedAt,
		...scan.score.overall != null ? { overall: scan.score.overall } : {}
	};
}
/** Regressions, then things that stopped being measured, then improvements. */
function rank(change) {
	const met = (presence) => presence === "pass" || presence === "satisfied-by-architecture";
	if (met(change.from) && !met(change.to)) return 0;
	if (change.to === "absent" || change.to === "unmeasurable") return 1;
	if (!met(change.from) && met(change.to)) return 3;
	return 2;
}
//#endregion
export { changesBetween };
