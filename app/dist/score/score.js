import { composition } from "../resolve/evidence-class.js";
//#region server/score/score.ts
const SEVERITY_WEIGHT = {
	critical: 10,
	high: 6,
	medium: 3,
	low: 1,
	informational: .5
};
/**
* Credit earned per outcome, as a fraction of the control's weight.
*
* `partial` earns half rather than nothing, because an estate that moved coverage
* from 40% to 80% has done real work, and a score that does not move teaches people
* to stop reading it.
*
* Exported alongside `SEVERITY_WEIGHT` because the two of them are the scoring method: every run
* records a digest of both, so a comparison can refuse when the weighting moved rather than drawing
* a trend across a change in what the score is out of. See `scan/identity.ts`.
*/
const CREDIT = {
	pass: 1,
	"satisfied-by-architecture": 1,
	partial: .5,
	fail: 0,
	unmeasurable: null,
	"not-applicable": null
};
/**
* Requirements this run answered: met, met by architecture, partly met, not met.
*
* The count for any surface that tells a reader how much of their estate was assessed, and the reason
* it is not `scoredControls`. That one is deduplicated so an estate is not penalised twice where the
* catalogue expresses one requirement as several controls — correct for scoring, and smaller than the
* outcome tally every surface also draws bars and lists from. A real run measured 49 requirements and
* reported 34, and the two numbers appeared on the same panel.
*
* The client states the same four outcomes in `answered`, in its coverage module. Twice, because the
* wire contract between them carries types and no code — so a change here is a change there.
*/
function answeredControls(counts) {
	return counts.pass + counts["satisfied-by-architecture"] + counts.partial + counts.fail;
}
const OUTCOMES = [
	"pass",
	"fail",
	"partial",
	"unmeasurable",
	"not-applicable",
	"satisfied-by-architecture"
];
/** Worst first, so the alias representative and the remediation list use one order. */
const SEVERITY_OF_OUTCOME = {
	fail: 0,
	partial: 1,
	unmeasurable: 2,
	pass: 3,
	"satisfied-by-architecture": 3,
	"not-applicable": 4
};
function scoreFindings(findings, options = {}) {
	const groupOf = options.aliasGroupOf ?? (() => void 0);
	const deduped = dedupeAliases(findings, options.aliasGroupOf);
	const worstInGroup = /* @__PURE__ */ new Map();
	for (const finding of deduped) {
		const group = groupOf(finding.controlId);
		if (group != null) worstInGroup.set(group, finding.outcome);
	}
	const byPillar = /* @__PURE__ */ new Map();
	for (const finding of findings) {
		const group = byPillar.get(finding.pillarId) ?? [];
		group.push(finding);
		byPillar.set(finding.pillarId, group);
	}
	const pillars = [...byPillar.entries()].map(([pillarId, pillarFindings]) => pillarScore(pillarId, pillarFindings, groupOf, worstInGroup)).sort((a, b) => a.pillarId.localeCompare(b.pillarId));
	const scored = pillars.filter((pillar) => pillar.score != null);
	const mean = (of) => round(scored.reduce((sum, pillar) => sum + of(pillar), 0) / scored.length);
	return {
		...scored.length > 0 ? {
			overall: mean((pillar) => pillar.score ?? 0),
			range: {
				low: mean((pillar) => pillar.range?.low ?? pillar.score ?? 0),
				high: mean((pillar) => pillar.range?.high ?? pillar.score ?? 0)
			}
		} : {},
		pillars,
		counts: tally(findings),
		scoredControls: deduped.filter((finding) => CREDIT[finding.outcome] != null).length,
		composition: composition(deduped.filter((finding) => CREDIT[finding.outcome] != null)),
		totalControls: findings.length
	};
}
/**
* How many pillars had a score before a customer's decisions were applied and have none after.
*
* There is no division by zero to fix here — `pillarScore` emits a score only when `available > 0`, and
* a pillar with nothing left scores nothing. The defect is quieter: a pillar with no score is not in the
* mean, so excluding a pillar's last scored requirement raises or lowers the estate number with no
* arithmetic error and nothing on the page to say a pillar left. 31c measured it: 75 with a range of
* 75–75 became 100 with a range of 100–100, and the provenance sentence said seven requirements had been
* set aside while the doubt collapsed to certainty.
*
* Both sides are scored by the same function rather than compared by counting credit-bearing outcomes,
* because an alias group's worst reading can take credit off a finding whose own outcome carries it —
* counting outcomes would report a pillar as emptied by a decision when it had never scored.
*/
function pillarsEmptiedByDecision(before, after, options = {}) {
	const scoredIn = (findings) => new Set(scoreFindings(findings, options).pillars.filter((pillar) => pillar.score != null).map((pillar) => pillar.pillarId));
	const had = scoredIn(before);
	const has = scoredIn(after);
	return [...had].filter((pillarId) => !has.has(pillarId)).length;
}
/**
* Unmeasured requirements grouped by remedy.
*
* Counted over the same set the pillar's other counts use, so the parts add up to
* `unmeasurable` rather than to some other number. An unmeasurable finding with no
* discriminator counts as `unreadable`, the most conservative reading: it says the app
* tried, which never claims a requirement is someone else's to answer.
*
* That default is why `disabled` exists as a kind of its own rather than as an absent
* discriminator. A check the customer switched off is the one case where nothing was wrong with
* the read, and falling to `unreadable` would report a deliberate decision as a failed one.
*/
function unmeasuredBy(findings) {
	const tallied = {
		attestation: 0,
		unreachable: 0,
		unbuilt: 0,
		unreadable: 0,
		disabled: 0
	};
	for (const finding of findings) {
		if (finding.outcome !== "unmeasurable") continue;
		tallied[finding.unmeasured ?? "unreadable"] += 1;
	}
	return tallied;
}
function pillarScore(pillarId, findings, groupOf, worstInGroup) {
	let earned = 0;
	let available = 0;
	let scored = 0;
	let unmeasured = 0;
	/** The scored requirements, kept so their composition can be counted once at the end. */
	const scoredFindings = [];
	/** Requirements already counted in this pillar, so one expressed twice here scores once. */
	const counted = /* @__PURE__ */ new Set();
	for (const finding of findings) {
		const group = groupOf(finding.controlId);
		const requirement = group ?? finding.controlId;
		if (counted.has(requirement)) continue;
		counted.add(requirement);
		const weight = SEVERITY_WEIGHT[finding.severity];
		const outcome = finding.outcome === "not-applicable" ? "not-applicable" : group != null ? worstInGroup.get(group) ?? finding.outcome : finding.outcome;
		const credit = CREDIT[outcome];
		if (credit == null) {
			if (outcome === "unmeasurable") unmeasured += weight;
			continue;
		}
		earned += weight * credit;
		available += weight;
		scored += 1;
		scoredFindings.push(finding);
	}
	const counts = tally(findings);
	const total = available + unmeasured;
	return {
		pillarId,
		...available > 0 ? {
			score: round(earned / available * 100),
			range: {
				low: round(earned / total * 100),
				high: round((earned + unmeasured) / total * 100)
			}
		} : {},
		counts,
		scored,
		unmeasurable: counts.unmeasurable,
		unmeasuredBy: unmeasuredBy(findings),
		composition: composition(scoredFindings),
		notApplicable: counts["not-applicable"],
		total: findings.length,
		worstFirst: [...findings].filter((finding) => finding.outcome === "fail" || finding.outcome === "partial").sort((a, b) => SEVERITY_OF_OUTCOME[a.outcome] - SEVERITY_OF_OUTCOME[b.outcome] || SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity] || a.controlId.localeCompare(b.controlId))
	};
}
/**
* One finding per requirement.
*
* Where a group has several findings the worst is kept. The alternative — averaging
* them — would let an estate improve its score by having the same requirement
* assessed from more angles, which is a property of the catalogue rather than of the
* estate.
*/
function dedupeAliases(findings, aliasGroupOf) {
	if (aliasGroupOf == null) return [...findings];
	const representatives = /* @__PURE__ */ new Map();
	const ungrouped = [];
	for (const finding of findings) {
		const group = aliasGroupOf(finding.controlId);
		if (group == null) {
			ungrouped.push(finding);
			continue;
		}
		const existing = representatives.get(group);
		if (existing == null || SEVERITY_OF_OUTCOME[finding.outcome] < SEVERITY_OF_OUTCOME[existing.outcome]) representatives.set(group, finding);
	}
	return [...ungrouped, ...representatives.values()];
}
function tally(findings) {
	const counts = Object.fromEntries(OUTCOMES.map((outcome) => [outcome, 0]));
	for (const finding of findings) counts[finding.outcome] += 1;
	return counts;
}
function round(value) {
	return Math.round(value * 10) / 10;
}
//#endregion
export { CREDIT, SEVERITY_WEIGHT, answeredControls, pillarsEmptiedByDecision, scoreFindings };
