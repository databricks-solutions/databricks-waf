import { beyondAnyApp } from "../collect/rest/families.js";
import { defaultLimits } from "../scan/surfaces.js";
import { SURFACES, signalDescriptors } from "./descriptors.js";
//#region server/plan/plan.ts
function buildPlan(options) {
	const descriptors = options.descriptors ?? signalDescriptors();
	const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
	const limits = defaultLimits();
	return {
		surfaces: SURFACES,
		pillars: options.catalogue.pillars.map((pillar) => {
			const controls = options.catalogue.controls.filter((control) => control.pillarId === pillar.id);
			const signals = plannedSignals(rolesOf(controls, options.registry), byId);
			return {
				pillarId: pillar.id,
				title: pillar.title,
				measured: options.measuredPillars == null || options.measuredPillars.includes(pillar.id),
				totalControls: controls.length,
				answeredControls: controls.filter((control) => options.registry.get(control.id) != null).length,
				blockedControls: blocked(controls, options.registry, byId),
				unanswered: unanswered(controls, options.registry),
				signals,
				requires: dedupe(signals.flatMap((signal) => signal.requires)),
				cost: costOf(signals, limits)
			};
		})
	};
}
/**
* Which signals serve which of a pillar's requirements, and how.
*
* Built from the registry and the catalogue's own preconditions rather than from a declared
* mapping, so a resolver that starts reading a second signal appears here without anyone
* remembering to say so.
*/
function rolesOf(controls, registry) {
	const roles = /* @__PURE__ */ new Map();
	const role = (signal) => {
		const existing = roles.get(signal);
		if (existing != null) return existing;
		const created = {
			answers: [],
			enriches: [],
			gates: []
		};
		roles.set(signal, created);
		return created;
	};
	for (const control of controls) {
		const resolver = registry.get(control.id);
		for (const signal of resolver?.requires ?? []) role(signal).answers.push(control.id);
		for (const signal of resolver?.enrichedBy ?? []) role(signal).enriches.push(control.id);
		for (const precondition of control.preconditions ?? []) role(precondition.signal).gates.push(control.id);
	}
	return roles;
}
/**
* The signals a run of this pillar collects, including the ones nothing asks for directly.
*
* The closure is taken over `derivedFrom` until it settles rather than in one pass, for the
* same reason the scan's own collect loop does: an input can itself have an input, and one
* pass would satisfy today's two-step chains and silently drop the first three-step one.
*/
function plannedSignals(roles, byId) {
	const needed = new Set(roles.keys());
	for (let added = true; added;) {
		added = false;
		for (const id of [...needed]) for (const input of byId.get(id)?.derivedFrom ?? []) if (!needed.has(input)) {
			needed.add(input);
			added = true;
		}
	}
	const planned = [];
	for (const id of needed) {
		const descriptor = byId.get(id);
		if (descriptor == null) continue;
		const role = roles.get(id) ?? {
			answers: [],
			enriches: [],
			gates: []
		};
		planned.push({
			...descriptor,
			...role,
			input: role.answers.length === 0 && role.enriches.length === 0 && role.gates.length === 0
		});
	}
	const order = [
		"sql",
		"describe",
		"rest",
		"cloud",
		"ai",
		"plans"
	];
	return planned.sort((a, b) => order.indexOf(a.surface) - order.indexOf(b.surface) || Number(b.input) - Number(a.input) || a.id.localeCompare(b.id));
}
/**
* Why a pillar's remaining requirements have no check.
*
* Three reasons rather than one count, because they are three different people's work. An
* attestation is the customer's. A planned check is ours. An unimplemented one is a decision
* nobody has made yet. Collapsing them into "unmeasured" is what makes a reader assume the
* whole gap is somebody else's problem.
*/
function unanswered(controls, registry) {
	let attestation = 0;
	let unreachable = 0;
	let planned = 0;
	let unimplemented = 0;
	for (const control of controls) {
		if (registry.get(control.id) != null) continue;
		if (control.measurability === "attestation") attestation += 1;
		else if (beyondAnyApp(control.collector)) unreachable += 1;
		else if (control.evaluatorStatus === "planned") planned += 1;
		else unimplemented += 1;
	}
	return {
		attestation,
		unreachable,
		planned,
		unimplemented
	};
}
/**
* Requirements whose check cannot run under any install, because every signal it reads needs a
* scope Databricks Apps does not offer.
*
* `every` rather than `some`: a check reading two signals, one of them reachable, still produces
* something. Only a check with no readable route at all is blocked.
*/
function blocked(controls, registry, byId) {
	return controls.filter((control) => registry.get(control.id) != null && beyondAnyInstall(control, registry, byId)).length;
}
/**
* Whether this requirement's check exists, is written, and cannot be authorised in any install.
*
* Exported because two callers need the same answer and they must not disagree. The plan page
* counts these to tell the reader how many of a pillar's requirements no scan will ever decide;
* the attestations route offers those same requirements to be answered. If the two computed it
* differently, the page would promise work the other page did not present — which it did, briefly,
* and the reader has no way to tell which of the two is lying.
*
* Distinct from "unmeasurable for this scope", which is a re-authorisation the reader can perform.
* This is ADR 0016's case: a scope the platform does not grant to apps at all, so an answer from a
* person is the only path that exists.
*/
function beyondAnyInstall(control, registry, byId) {
	const resolver = registry.get(control.id);
	if (resolver != null) return resolver.requires.length > 0 && resolver.requires.every((signal) => ungrantable(byId.get(signal)));
	return beyondAnyApp(control.collector);
}
/** Signal descriptors by id, so callers outside this module can use `beyondAnyInstall`. */
function descriptorsById(descriptors = signalDescriptors()) {
	return new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
}
/** Whether every scope this signal needs is one Databricks Apps does not offer. */
function ungrantable(descriptor) {
	if (descriptor == null) return false;
	const scopes = descriptor.requires.filter((requirement) => requirement.kind === "app-scope");
	return scopes.length > 0 && scopes.every((scope) => scope.grantable === false);
}
function costOf(signals, limits) {
	return [...new Set(signals.map((signal) => signal.surface))].map((surface) => {
		const mine = signals.filter((signal) => signal.surface === surface);
		return {
			surface,
			fixed: mine.filter((signal) => signal.cost.kind !== "per-object").length,
			variable: mine.filter((signal) => signal.cost.kind === "per-object").map((signal) => ({
				signal: signal.id,
				objects: signal.cost.objects ?? "objects in the estate",
				...signal.cost.ceiling != null ? { ceiling: signal.cost.ceiling } : {}
			})),
			budget: limits[surface].budget
		};
	});
}
/** One requirement per distinct kind-and-text, keeping the first note given for it. */
function dedupe(requirements) {
	const unique = /* @__PURE__ */ new Map();
	for (const requirement of requirements) {
		const key = `${requirement.kind}:${requirement.what}`;
		if (!unique.has(key)) unique.set(key, requirement);
	}
	return [...unique.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.what.localeCompare(b.what));
}
//#endregion
export { beyondAnyInstall, buildPlan, descriptorsById };
