import { pillarsEmptiedByDecision, scoreFindings } from "../score/score.js";
import { comparable } from "../shared/api/comparability.js";
import { exclusionKeys } from "./identity.js";
import { applyDecisions, exposureOf } from "../apply/apply.js";
import "./scan.js";
//#region server/scan/carry-forward.ts
/**
* The fresh run's pillars plus the previous run's, or the fresh run alone with the reason.
*
* Returns a scan either way. A caller that had to handle "merged" and "not merged"
* differently would be a caller with two save paths and two ways to be wrong.
*/
function carryForward(options) {
	const { aliasGroupOf, fresh, measuredPillars, previous } = options;
	if (measuredPillars.length === 0) return fresh;
	const refusal = why(fresh, previous, measuredPillars);
	if (refusal != null || previous == null) return {
		...fresh,
		...refusal != null ? { notCarried: refusal } : {}
	};
	const carried = previous.findings.filter((finding) => !measuredPillars.includes(finding.pillarId));
	if (carried.length === 0) return fresh;
	const merged = [...fresh.findings, ...carried];
	const applied = applyDecisions(merged, (controlId) => options.decisions?.get(controlId) ?? [], options.now ?? /* @__PURE__ */ new Date());
	const findings = applied.findings;
	const exposure = exposureOf({
		...applied,
		excluded: [...applied.excluded, ...stillExcluded(previous, carried, applied.excluded)]
	}, pillarsEmptiedByDecision(merged, findings, { aliasGroupOf }));
	const estate = fresh.estate.undeterminedReason == null ? fresh.estate : previous.estate;
	return {
		...fresh,
		signals: mergeSignals(fresh.signals, previous.signals),
		findings,
		score: {
			...scoreFindings(findings, { aliasGroupOf }),
			...exposure != null ? { exposure } : {}
		},
		estate,
		stamp: {
			...fresh.stamp,
			...estate.undeterminedReason == null ? { assessedWorkspaces: estate.assessed.map((workspace) => workspace.id).sort() } : {},
			...fresh.stamp.identity != null ? { identity: {
				...fresh.stamp.identity,
				exclusions: exclusionKeys(exposure?.excluded ?? [])
			} } : {}
		},
		state: fresh.state === "partial" || previous.state === "partial" ? "partial" : "complete",
		measurement: [...fresh.measurement, ...inherited(previous, measuredPillars)],
		...fresh.incompleteReason == null && previous.state === "partial" && previous.incompleteReason != null ? { incompleteReason: `Carried forward from an incomplete scan. ${previous.incompleteReason}` } : {}
	};
}
/**
* Why the untouched pillars cannot come forward, or undefined when they can.
*
* A full run has nothing to carry and needs no explanation, so it is not a refusal.
*/
function why(fresh, previous, measuredPillars) {
	if (previous == null) return `This run measured only ${list(measuredPillars)}. There is no earlier scan to take the other pillars from, so they are absent from this result rather than shown as unmeasured. Run a full scan to assess them.`;
	const verdict = comparable(fresh.stamp, previous.stamp, void 0, { acrossExclusionChange: "permit" });
	if (!verdict.ok) return `This run measured only ${list(measuredPillars)}. The other pillars were not carried forward from the previous scan because the two are not comparable: ${verdict.reason ?? "the runs differ."} Run a full scan to assess them under the same conditions.`;
}
/**
* Requirements a carried finding is still out of the denominator for, whose decision no longer applies.
*
* The gap this closes. Since 31g a scan stores its findings already rewritten, so a carried finding for
* an excluded requirement reads `not-applicable` or `unmeasurable` on disk with the raw reading gone.
* Re-applying over the merge finds nothing when the decision behind it has been revoked or has expired,
* and leaves that finding alone — correctly, because the reading it would revert to was not collected
* this run. What did not follow is the exposure: the requirement stayed out of the score while the
* exposure, the identity and the export all described a set that included it, so three surfaces
* disagreed with the number they were describing and a trend could be drawn between two scans whose
* denominators differed.
*
* So the previous scan's own entry comes forward with the finding it belongs to. Its `owner` and
* `reason` are what that decision said when it was applied, which is what took the requirement out; no
* surface reads this as a claim that the decision is in force today. Only `excluded` — a lapse left its
* requirement in the score, so there is nothing to carry.
*/
function stillExcluded(previous, carried, applied) {
	const reapplied = new Set(applied.map((exclusion) => exclusion.controlId));
	const rewritten = new Set(carried.filter((finding) => finding.outcome === "not-applicable" || finding.outcome === "unmeasurable").map((finding) => finding.controlId));
	return (previous.score.exposure?.excluded ?? []).filter((exclusion) => rewritten.has(exclusion.controlId) && !reapplied.has(exclusion.controlId));
}
/** Previous measurements for the pillars this run left alone, marked as carried. */
function inherited(previous, measuredPillars) {
	return previous.measurement.filter((measurement) => !measuredPillars.includes(measurement.pillarId)).map((measurement) => ({
		...measurement,
		carriedForward: true
	}));
}
function mergeSignals(fresh, previous) {
	const byId = new Map(previous.map((signal) => [signal.id, signal]));
	for (const signal of fresh) byId.set(signal.id, signal);
	return [...byId.values()];
}
function list(pillars) {
	return pillars.length === 1 ? pillars[0] ?? "" : `${pillars.slice(0, -1).join(", ")} and ${pillars.at(-1) ?? ""}`;
}
//#endregion
export { carryForward };
