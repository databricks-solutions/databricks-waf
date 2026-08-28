import { familyOf } from "../collect/rest/families.js";
import { narrowest } from "./finding.js";
import { resolveApplicability } from "./applicability.js";
import { attestRemedy, remedyFor } from "./remedy.js";
//#region server/resolve/resolver.ts
var ResolverRegistry = class {
	byControl = /* @__PURE__ */ new Map();
	register(resolver) {
		for (const controlId of resolver.controls) {
			const existing = this.byControl.get(controlId);
			if (existing != null) throw new Error(`Control ${controlId} already has a resolver (${existing.constructor.name}); a control may only be answered by one.`);
			this.byControl.set(controlId, resolver);
		}
	}
	get(controlId) {
		return this.byControl.get(controlId);
	}
	/** Signals needed to resolve these controls, deduplicated. The scan plan. */
	signalsFor(controlIds) {
		const needed = /* @__PURE__ */ new Set();
		for (const id of controlIds) {
			const resolver = this.byControl.get(id);
			for (const signal of resolver?.requires ?? []) needed.add(signal);
			for (const signal of resolver?.enrichedBy ?? []) needed.add(signal);
		}
		return [...needed];
	}
};
/**
* Resolve one control: applicability first, then evidence.
*
* The order is load-bearing rather than tidy. A control that does not apply must not
* be evaluated at all, because evaluating it produces an observation ("no cluster
* policies exist") that reads as a failure and would be reported as one by any
* later step that saw it.
*/
function resolveControl(spec, signals, resolver, attested, context = {}) {
	const applicability = resolveApplicability(spec.preconditions ?? [], signals);
	if (applicability.kind === "not-applicable" || applicability.kind === "satisfied-by-architecture") return {
		...base(spec),
		outcome: applicability.kind,
		coverage: { mode: "complete" },
		evidence: [],
		outcomeReason: applicability.reason
	};
	if (resolver == null) {
		if (attested != null) return findingFromAttestation(spec, attested);
		const unresolved = whyUnresolved(spec);
		return {
			...base(spec),
			outcome: "unmeasurable",
			coverage: { mode: "complete" },
			evidence: [],
			outcomeReason: unresolved.reason,
			unmeasured: unresolved.kind,
			...unresolved.kind === "attestation" || unresolved.kind === "unreachable" ? { remedy: attestRemedy() } : {}
		};
	}
	const resolution = resolver.resolve(spec, signals);
	if (resolution.outcome === "unmeasurable" && attested != null) return {
		...findingFromAttestation(spec, attested),
		evidence: resolution.evidence
	};
	const reason = reasonFor(resolution, applicability);
	const refused = remedyFor(resolver.requires, signals, {
		...context.declaredScopes != null ? { declaredScopes: context.declaredScopes } : {},
		...spec.collector != null ? { collector: spec.collector } : {}
	});
	const unmeasured = resolution.outcome === "unmeasurable" ? kindOfGap(resolution.unmeasured, refused) : void 0;
	return {
		...base(spec),
		outcome: resolution.outcome,
		coverage: coverageOf(resolution.evidence),
		evidence: resolution.evidence,
		...unmeasured != null ? { unmeasured } : {},
		...reason != null ? { outcomeReason: reason } : {},
		...remedyWhenUnmeasured(refused, unmeasured, resolution.remedy) ?? {},
		...attested != null ? { attested: factFromAttestation(attested, "record") } : {}
	};
}
/**
* Which kind of gap this is, once the platform's refusal has been read.
*
* Four of the five: `disabled` is a decision the customer recorded, not anything a resolver or a
* refusal can read, so nothing here returns it.
*
* A resolver's own classification wins where it made one: it read its source successfully and
* found the answer absent from the platform, which nothing here can tell.
*
* Otherwise the refusal decides, and `attest` means `unreachable`. Those two say the same thing in
* the two vocabularies — no install of this app can be authorised for this call, so it ends at a
* person — and defaulting to `unreadable` instead put them under "sources the scan could not read".
* A live scheduled run made the cost concrete: of 80 requirements it reported as unread, 18 were
* calls Databricks Apps offers no scope for, so an operator following the advice would have spent
* an afternoon granting things that could not have helped. It also counted those 18 against the
* identity in the rule that decides whether an unattended run measured enough to keep.
*
* `re-authorise` stays `unreadable` deliberately: the scope exists and consent is stale, which one
* sign-in fixes. That is the reader's to close, which is what `unreadable` means.
*/
function kindOfGap(declared, refused) {
	if (declared != null) return declared;
	return refused?.kind === "attest" ? "unreachable" : "unreadable";
}
/**
* What the reader can do about a requirement a resolver could not settle.
*
* Three sources, in that order. A signal that failed is classified from the platform's own refusal,
* which is the specific answer: which scope, whose grant, whether consent is stale. Failing that,
* the resolver's own, for the case it read its source successfully and can tell the answer was
* incomplete — a privilege-filtered catalogue reads as a row of zeroes, and nothing outside the
* resolver can distinguish that from an empty estate. Failing both, the resolver's classification
* decides: `attestation` and `unreachable` end at a person, and saying so is the only useful thing
* left to say.
*
* Nothing for an otherwise unexplained `unreadable`, which would be this app contradicting itself,
* and nothing for a measured outcome: there is no access remedy for a finding that has an answer.
*/
function remedyWhenUnmeasured(refused, unmeasured, declared) {
	if (unmeasured == null) return void 0;
	if (refused != null) return { remedy: refused };
	if (declared != null) return { remedy: declared };
	if (unmeasured === "attestation" || unmeasured === "unreachable") return { remedy: attestRemedy() };
}
/** What each answer means as an outcome, in the vocabulary every other finding uses. */
const OUTCOME_OF_ANSWER = {
	met: "pass",
	"partially-met": "partial",
	"not-met": "fail",
	"not-applicable": "not-applicable"
};
function findingFromAttestation(spec, attested) {
	const outcome = OUTCOME_OF_ANSWER[attested.answer];
	return {
		...base(spec),
		outcome,
		coverage: { mode: "complete" },
		evidence: [],
		outcomeReason: outcome === "not-applicable" ? `Attested as not applicable by ${attested.attestedBy}: ${attested.statement}` : `Answered by attestation rather than measured. ${attested.owner} is accountable for this practice.`,
		attested: factFromAttestation(attested, "outcome")
	};
}
function factFromAttestation(attested, bearing) {
	return {
		id: attested.id,
		bearing,
		by: attested.attestedBy,
		at: attested.attestedAt,
		statement: attested.statement,
		owner: attested.owner,
		reviewBy: attested.reviewBy,
		...attested.evidenceUrl != null ? { evidenceUrl: attested.evidenceUrl } : {}
	};
}
/**
* What the finding may claim, from the evidence the outcome rests on.
*
* Detail-bearing evidence is excluded because it did not decide anything. A control that
* counted every table in the metastore and then named the four schemas holding most of the
* gap has measured the estate completely; letting the sampled breakdown narrow the whole
* finding would report a complete measurement as a partial one, and under the sampled-pass
* rule that turns a pass into a weaker claim than it earned.
*
* Falls back to all of it when nothing is marked outcome-bearing, so an existing resolver
* that says nothing about bearing keeps the coverage it had.
*/
function coverageOf(evidence) {
	const bearing = evidence.filter((item) => item.bearing !== "detail");
	return narrowest((bearing.length > 0 ? bearing : evidence).map((item) => item.coverage));
}
/**
* An unresolved segment precondition is surfaced on the finding rather than hidden.
*
* The alternative — resolving normally and saying nothing — would mean a mixed
* estate silently gets an assessment whose applicability was never actually
* checked, and nobody looking at the result could tell.
*/
function reasonFor(resolution, applicability) {
	if (resolution.outcomeReason != null) return resolution.outcomeReason;
	if (applicability.kind === "needs-segments") return `Assessed across the whole estate. ${applicability.reason} Per-segment applicability is not yet implemented, so this may apply to only part of the estate.`;
	if (applicability.kind === "undetermined") return applicability.detail;
}
/**
* Why a control has no resolver, in the terms the catalogue itself uses.
*
* A control the app has decided cannot be automated, and a control whose automated
* check has not been written yet, look identical from here but are not the same
* thing. Saying "answered by attestation" for the second would present unfinished
* work to the customer as a question only they can answer.
*/
function whyUnresolved(spec) {
	if (spec.measurability === "attestation") return {
		kind: "attestation",
		reason: "This practice leaves no trace on the platform, so there is nothing to read that would settle it."
	};
	const family = familyOf(spec.collector);
	if (family != null && !family.grantable) return {
		kind: "unreachable",
		reason: family.plane === "account" ? `${family.label} is account-plane configuration, and this app is installed in a workspace. A workspace token is rejected by the account endpoints before authorisation is even considered, so no scope and no permission would change it.` : `${family.label} needs the "${family.scope}" authorization scope, which Databricks Apps does not offer an app — a platform limit rather than unfinished work. Reading it as the app's own identity instead would show you an estate you may not have the right to see, which is why it does not.`
	};
	if (spec.evaluatorStatus === "planned") return {
		kind: "unbuilt",
		reason: "An automated check for this control is planned but not implemented yet, so it is unmeasured rather than answered. It is left in the denominator: not having built the check is not evidence that the estate is compliant." + (familyOf(spec.collector) != null ? ` The app can be authorised to read ${familyOf(spec.collector)?.label.toLowerCase() ?? "this"}, so this one is genuinely a gap here rather than a limit of the platform.` : "")
	};
	return {
		kind: "unbuilt",
		reason: "No automated check is implemented for this control, so it is unmeasured in this scan."
	};
}
function base(spec) {
	return {
		controlId: spec.id,
		pillarId: spec.pillarId,
		principleId: spec.principleId,
		title: spec.title,
		severity: spec.severity
	};
}
//#endregion
export { OUTCOME_OF_ANSWER, ResolverRegistry, factFromAttestation, findingFromAttestation, resolveControl };
