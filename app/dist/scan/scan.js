import { resolveControl } from "../resolve/resolver.js";
import { pillarsEmptiedByDecision, scoreFindings } from "../score/score.js";
import { PUBLIC_METHODOLOGY } from "../methodology/identity.js";
import { comparable, stampEnough } from "../shared/api/comparability.js";
import { exclusionKeys, runIdentity } from "./identity.js";
import { applyDecisions, exposureOf } from "../apply/apply.js";
import { CollectionScheduler } from "./scheduler.js";
import { summariseEstate } from "./estate.js";
import { merged } from "../import/signals.js";
import { collectSignals, withInputs } from "../collect/collection.js";
import { randomUUID } from "node:crypto";
//#region server/scan/scan.ts
async function runScan(options) {
	const startedAt = /* @__PURE__ */ new Date();
	const scheduler = options.scheduler ?? new CollectionScheduler();
	const identity = await options.credentials.databricks();
	const controls = options.catalogue.controls.filter((control) => options.pillars == null || options.pillars.includes(control.pillarId));
	const collected = await collect(controls, options, scheduler, identity);
	const signals = options.imported == null ? collected : merged(collected, options.imported);
	const resolveContext = options.declaredScopes != null ? { declaredScopes: options.declaredScopes } : {};
	const findings = controls.map((control) => resolveControl(toSpec(control), signals, options.registry.get(control.id), options.attestations?.get(control.id), resolveContext));
	const aliasOf = aliasLookup(options.catalogue);
	const footprint = scheduler.footprint();
	const estate = summariseEstate(signals);
	const id = randomUUID();
	const finishedAt = /* @__PURE__ */ new Date();
	const applied = applyDecisions(findings, (controlId) => options.decisions?.get(controlId) ?? [], finishedAt);
	const exposure = exposureOf(applied, pillarsEmptiedByDecision(findings, applied.findings, { aliasGroupOf: aliasOf }));
	return {
		id,
		startedAt,
		finishedAt,
		state: footprint.exhaustion == null && !footprint.cancelled ? "complete" : "partial",
		stamp: {
			publicMethodology: PUBLIC_METHODOLOGY,
			catalogueVersion: options.catalogue.version.version,
			catalogueFingerprint: options.catalogue.version.fingerprint,
			executionMode: identity.mode,
			actor: identity.actor,
			...identity.actorName != null ? { actorName: identity.actorName } : {},
			trigger: options.trigger ?? "interactive",
			scope: options.scope,
			lookbackDays: options.lookbackDays,
			...estate.undeterminedReason == null ? { assessedWorkspaces: estate.assessed.map((workspace) => workspace.id).sort() } : {},
			...options.definition != null ? { definition: options.definition } : {},
			identity: runIdentity([...signals.values()], { exclusions: exclusionKeys(exposure?.excluded ?? []) })
		},
		score: {
			...scoreFindings(applied.findings, { aliasGroupOf: aliasOf }),
			...exposure != null ? { exposure } : {}
		},
		findings: applied.findings,
		signals: [...signals.values()],
		estate,
		measurement: [...new Set(applied.findings.map((finding) => finding.pillarId))].map((pillarId) => ({
			pillarId,
			scanId: id,
			measuredAt: finishedAt,
			actor: identity.actor,
			carriedForward: false
		})),
		footprint,
		spend: options.collectors.flatMap((collector) => collector.spent != null ? [collector.spent()] : []),
		...footprint.cancelled ? { incompleteReason: "The scan was cancelled. Controls that had not been collected are reported as unmeasured." } : footprint.exhaustion != null ? { incompleteReason: describeExhaustion(footprint.exhaustion) } : {}
	};
}
/**
* Which limit stopped the scan, named so the reader knows what to change.
*
* "Partial" on its own invites a support ticket. "Stopped after 40 queries against
* the warehouse budget" tells someone either to raise the budget or to accept the
* result, which are the only two useful responses.
*/
function describeExhaustion(exhaustion) {
	const tail = "Controls it did not reach are reported as unmeasured rather than failed, and the score covers only what was measured.";
	return exhaustion.kind === "surface-budget" ? `The scan stopped after reaching its budget of ${exhaustion.limit} ${exhaustion.surface} operations. ${tail}` : `The scan stopped after ${Math.round(exhaustion.elapsedMs / 1e3)}s, against a limit of ${Math.round(exhaustion.limitMs / 1e3)}s. ${tail}`;
}
/**
* Collect every signal the plan needs, one collector at a time.
*
* Sequential across collectors rather than parallel, because parallelism between them
* would put two surfaces' worth of work in flight at once and the per-surface limits
* would no longer bound total load. Within a collector, the scheduler decides.
*/
async function collect(controls, options, scheduler, identity) {
	return collectSignals(plan(controls, options), options, scheduler, identity);
}
/**
* Which signals a set of controls needs read.
*
* All that is left here of what used to be the collection loop, and the only part of it that is about
* an assessment: the loop itself moved to `collect/collection.ts` when the advisory run needed it, and
* an advisory run has no controls to derive a set from. See ADR 0069.
*/
function plan(controls, options) {
	const needed = new Set(options.registry.signalsFor(controls.map((control) => control.id)));
	for (const control of controls) for (const precondition of control.preconditions ?? []) needed.add(precondition.signal);
	return withInputs(needed, options.collectors);
}
function toSpec(control) {
	return control;
}
/** Which alias group a control belongs to, so a cross-pillar requirement is scored once. */
function aliasLookup(catalogue) {
	const groups = /* @__PURE__ */ new Map();
	for (const [group, controls] of catalogue.aliasGroups) for (const control of controls) groups.set(control.id, group);
	return (controlId) => groups.get(controlId);
}
//#endregion
export { aliasLookup, comparable, runScan, stampEnough };
