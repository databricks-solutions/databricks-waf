import internal_delivery_patterns_default from "./internal-delivery-patterns.js";
//#region shared/api/comparability.ts
const INTERNAL_DELIVERY_NAMES = internal_delivery_patterns_default.map((pattern) => new RegExp(pattern, "iu"));
/**
* A customer-authored assessment name is the best description when it is customer language.
*
* The labs release estate also retains immutable runs created while rows and pull requests were the
* working names of assessments. Those names remain valid record data, but repeating one in the global
* comparison strip turns repository provenance back into primary customer chrome. The release gate and
* this runtime boundary read one pattern list so a label cannot pass one and fail the other.
*/
function customerAssessmentName(name) {
	if (name == null || INTERNAL_DELIVERY_NAMES.some((pattern) => pattern.test(name))) return void 0;
	return name;
}
/**
* Whether a stamp holds the fields a comparison dereferences.
*
* A stamp arrives out of a `jsonb` column, and over HTTP out of that same column, so one truncated by
* a partial write or by a build that wrote fewer fields is a value rather than a type error, and
* `comparable` reaches into `scope`, `identity.sources` and the rest without asking. A crash there
* would take out the whole pane over a history it could simply have declined to walk — the client's is
* a dashboard rather than a pane, because a pillar row computes its own series while rendering.
* Checked rather than caught, because catching would also swallow a genuine fault in the comparison
* itself.
*
* Beside the rule rather than beside either caller, so that a second surface reaching for `comparable`
* finds the guard in the same import.
*/
function stampEnough(stamp) {
	if (stamp == null) return false;
	if (typeof stamp.catalogueFingerprint !== "string" || typeof stamp.actor !== "string") return false;
	if (stamp.scope == null || typeof stamp.lookbackDays !== "number") return false;
	return stamp.identity == null || Array.isArray(stamp.identity.sources);
}
/**
* Whether two scans can be compared.
*
* Refusing a comparison and saying why is better than drawing a trend line across a
* change of observer, which would show score movement that has nothing to do with the
* customer's estate.
*
* Two kinds of dimension, and the difference is deliberate. What the run *was about* — the
* catalogue, the identity that read the estate, the scope, the window, the assessment it answers
* to — refuses the comparison, because two answers to different questions are not a trend. What
* *produced* the run is in `identity`, and only some of it refuses: `identityBarriers` below says
* which and why. Everything that refuses names the field, because "not comparable" without the reason
* is a dead end for the reader.
*
* Both stamps must have passed `stampEnough`. This dereferences them without asking, which is the
* reason that guard exists and is exported beside it.
*/
function comparable(a, b, across, options) {
	const methodology = methodologyBarrier(a, b);
	if (methodology != null) return {
		ok: false,
		reason: methodology
	};
	const definition = definitionBarrier(a.definition, b.definition);
	if (definition != null) return {
		ok: false,
		reason: definition
	};
	const catalogue = catalogueBarrier(a, b, across);
	if (catalogue?.refusal != null) return {
		ok: false,
		reason: catalogue.refusal
	};
	if (a.executionMode !== b.executionMode) return {
		ok: false,
		reason: "One scan read the estate as the identity that started it and the other as a service principal. The two see different parts of the estate, so a change between them is not a change in the estate."
	};
	if (a.actor !== b.actor) return {
		ok: false,
		reason: `These scans ran as different identities (${a.actor} and ${b.actor}), whose visible estates may differ.`
	};
	if (a.scope.narrowedTo !== b.scope.narrowedTo) {
		const describe = (scope) => scope.narrowedTo != null ? `workspace ${scope.narrowedTo} alone` : "the whole account";
		return {
			ok: false,
			reason: `One of these scans covered ${describe(a.scope)} and the other ${describe(b.scope)}, so their totals are not of the same estate.`
		};
	}
	const selection = selectionBarrier(a, b);
	if (selection != null) return {
		ok: false,
		reason: selection
	};
	if (a.lookbackDays !== b.lookbackDays) return {
		ok: false,
		reason: `These scans looked back over different windows (${a.lookbackDays} and ${b.lookbackDays} days).`
	};
	const identity = identityBarriers(a.identity, b.identity);
	const refusals = options?.acrossExclusionChange === "permit" || identity.exclusions == null ? identity.refusals : [...identity.refusals, identity.exclusions];
	if (refusals.length > 0) return {
		ok: false,
		reason: refusals.join(" ")
	};
	const drift = workspaceDrift(a, b);
	const caveats = [
		catalogue?.caveat,
		drift,
		...identity.caveats
	].filter((caveat) => caveat != null);
	return caveats.length === 0 ? { ok: true } : {
		ok: true,
		caveat: caveats.join(" ")
	};
}
/**
* Whether both runs belong to the same named public methodology candidate or release.
*
* Absence is a classification, not a default. Catalogue revisions 9 through 18 predate the public
* release and a reader must never turn their missing identity into Version 1 because the build now
* ships Version 1. Candidate runs carry their candidate state and exact manifest, so two matching
* candidate records can be compared without either being presented as released. Publication remains
* a separate, stricter gate.
*/
function methodologyBarrier(a, b) {
	const one = a.publicMethodology;
	const two = b.publicMethodology;
	if (one == null && two == null) return "Neither scan records a public methodology release. They are pre-release development records, so they are not points in a customer methodology trend.";
	if (one == null || two == null) return "One scan records a public methodology release and the other is a pre-release development record. They do not belong to one customer methodology trend.";
	if (one.publicVersion !== two.publicVersion) return `These scans belong to different public methodology versions (${String(one.publicVersion)} and ${String(two.publicVersion)}).`;
	if (one.manifestDigest !== two.manifestDigest) return `These scans name Methodology Version ${String(one.publicVersion)} with different manifest digests, so they do not describe the same released standard.`;
}
/**
* What a change of catalogue between two runs means for comparing them.
*
* Refusing outright is what this did before there was a record of what a version changed, and it is
* the right answer whenever there still is not one: two scores out of different requirement sets are
* not a trend, and a caveat cannot make them one.
*
* What a described change buys is the ability to say which part of the difference is the catalogue.
* Most of two catalogues is the same catalogue — a release moves a handful of 184 requirements — and
* a customer whose trend resets on the month we ship an update, for reasons that have nothing to do
* with their estate, has been failed by a refusal that was technically correct. So a described span
* permits the comparison and qualifies it, and `attribution.ts` splits the delta.
*/
function catalogueBarrier(a, b, across) {
	if (a.catalogueFingerprint === b.catalogueFingerprint) return void 0;
	const sameVersion = `These scans were assessed against different catalogue versions (${a.catalogueVersion} and ${b.catalogueVersion}), so they asked different questions.`;
	if (across == null) return { refusal: sameVersion };
	if (!across.describable) return { refusal: across.why ?? sameVersion };
	if (across.recordedFingerprint != null && across.recordedFingerprint !== a.catalogueFingerprint) return { refusal: `The record of what catalogue version ${a.catalogueVersion} changed does not match the catalogue this run was scored against, so what separates these two runs cannot be established.` };
	const moved = [
		across.added.length > 0 ? `${String(across.added.length)} added` : void 0,
		across.removed.length > 0 ? `${String(across.removed.length)} removed` : void 0,
		across.renamed.size > 0 ? `${String(across.renamed.size)} renumbered` : void 0,
		across.changed.length > 0 ? `${String(across.changed.length)} reweighted or rescoped` : void 0
	].filter((part) => part != null);
	if (moved.length === 0) return void 0;
	return { caveat: `The catalogue moved from version ${b.catalogueVersion} to ${a.catalogueVersion} between these runs (${moved.join(", ")}), so part of any movement is a change in what is being asked rather than in the estate.` };
}
/**
* Whether the two runs were asked to cover the same workspaces.
*
* Absent on both sides means both covered whatever the identity could see, which is the same
* question asked twice. One side naming a set and the other not is two different questions, however
* much the sets may overlap in practice — one is a claim the app can be held to and the other is a
* consequence of somebody's grants.
*/
function selectionBarrier(a, b) {
	const one = a.scope.selected;
	const two = b.scope.selected;
	if (one == null && two == null) return void 0;
	if (one == null || two == null) return "One of these scans covered the workspaces an assessment names and the other covered whatever the scanning identity could see, so their totals are not of the same estate.";
	if (one.length === two.length && one.every((id, at) => id === two[at])) return void 0;
	const gained = one.filter((id) => !two.includes(id));
	const lost = two.filter((id) => !one.includes(id));
	return `These scans were asked to cover different workspaces (${[gained.length > 0 ? `${gained.join(", ")} added` : void 0, lost.length > 0 ? `${lost.join(", ")} removed` : void 0].filter((part) => part != null).join(", ")}), so their totals are not of the same estate.`;
}
/**
* Whether the assessed workspace set moved, described in the terms the reader needs.
*
* Says which workspaces appeared or disappeared rather than only that the count changed,
* because the follow-up question is always "which one" and a count cannot answer it.
*/
function workspaceDrift(a, b) {
	if (a.assessedWorkspaces == null || b.assessedWorkspaces == null) return void 0;
	const gained = a.assessedWorkspaces.filter((id) => !b.assessedWorkspaces.includes(id));
	const lost = b.assessedWorkspaces.filter((id) => !a.assessedWorkspaces.includes(id));
	if (gained.length === 0 && lost.length === 0) return void 0;
	return `The assessed workspaces changed between these scans: ${[gained.length > 0 ? `${String(gained.length)} appeared (${gained.join(", ")})` : void 0, lost.length > 0 ? `${String(lost.length)} no longer assessed (${lost.join(", ")})` : void 0].filter((part) => part != null).join(" and ")}. Part of any movement may be the estate changing rather than its configuration.`;
}
/**
* What the identities of two runs mean for comparing them.
*
* The split between refusing and qualifying is the whole decision here, and it is not the same
* answer for every axis:
*
* A **changed methodology** is refused. The weighting decides what every score is out of, so the
* same estate scores differently under two of them and no caveat makes those two numbers a trend.
*
* A **changed build** is qualified, and this is the one judgement call in this file. Refusing would
* be defensible — a corrected resolver changes findings — and it would also mean no customer could
* ever see a trend across a release of this app, which is most weeks. A reader told "these runs came
* from different builds, so part of any movement may be this app changing rather than your estate"
* has what they need to interpret the number; a reader shown nothing has neither the trend nor the
* warning. Recorded in ADR 0043 as a decision to revisit if releases become rare enough that
* refusing costs nothing.
*
* An axis this build **tried to establish and could not** is refused, because the alternative is
* presenting an equality nobody checked. An axis a run **never recorded** — a run from before this
* existed — is qualified instead, since refusing retroactively would empty every history in the
* product on the deploy that introduced the field, and that is a worse answer than a sentence saying
* the earlier run does not record what produced it.
*/
function identityBarriers(a, b) {
	if (a == null || b == null) return {
		refusals: [],
		caveats: ["One of these runs was recorded before this app noted what produced it, so a change of build or of scoring method between them cannot be ruled out."]
	};
	const refusals = [];
	const caveats = [];
	if (a.methodology.id == null || b.methodology.id == null) refusals.push("One of these runs does not record how findings were weighted into a score, so the two totals cannot be shown to be out of the same thing.");
	else if (a.methodology.id !== b.methodology.id) refusals.push("The scoring method changed between these runs — how heavily each severity weighs, or what a partial answer earns — so the same estate would score differently under each.");
	if (a.build.id != null && b.build.id != null && a.build.id !== b.build.id) caveats.push(`These runs came from different builds of this app (${a.build.id} and ${b.build.id}). Part of any movement may be a corrected reading rather than a change in the estate.`);
	else if (a.build.id == null || b.build.id == null) caveats.push("One of these runs could not identify the build that produced it, so a change in this app between them cannot be ruled out.");
	const dropped = b.sources.filter((source) => !a.sources.includes(source));
	const gained = a.sources.filter((source) => !b.sources.includes(source));
	if (dropped.length > 0 || gained.length > 0) {
		const parts = [gained.length > 0 ? `${gained.join(", ")} answered in the later run and not the earlier` : void 0, dropped.length > 0 ? `${dropped.join(", ")} answered in the earlier run and not the later` : void 0].filter((part) => part != null);
		caveats.push(`These runs read different sources: ${parts.join(", and ")}. A requirement that stopped being measurable is this app losing a source rather than the estate losing a control.`);
	}
	const exclusion = exclusionRefusal(a.exclusions, b.exclusions);
	return {
		refusals,
		caveats,
		...exclusion != null ? { exclusions: exclusion } : {}
	};
}
/**
* Why a change in what a customer took out of the score refuses a comparison, or undefined when it does
* not.
*
* The same shape of reason as a changed scoring method, and for the same reason: two scores computed
* over different denominators are out of different things, and no caveat makes them a trend. A
* requirement excluded in one run and scored in the other moved the denominator, so a difference in
* either direction — a decision recorded, or one revoked — refuses.
*
* Absent reads as the empty set here, deliberately, which is the exception `RunIdentity.exclusions`
* documents: applicability postdates every run without the field, so absent means nothing was
* excluded rather than that the app failed to record it. The count is all the reason names — which
* requirements moved is the export's to show, and a refusal line more specific than that would be a
* sentence claiming more than the field it is drawn from.
*/
function exclusionRefusal(a, b) {
	const later = levered(a);
	const earlier = levered(b);
	const added = [...later.keys()].filter((id) => !earlier.has(id));
	const dropped = [...earlier.keys()].filter((id) => !later.has(id));
	if (added.length > 0 || dropped.length > 0) return `A customer's applicability decisions took a different set of requirements out of these two scores (${[added.length > 0 ? `${String(added.length)} taken out of the later run and not the earlier` : void 0, dropped.length > 0 ? `${String(dropped.length)} taken out of the earlier run and not the later` : void 0].filter((part) => part != null).join(", and ")}), so the two totals are out of different denominators. Run a full scan under one set to compare them.`;
	const switched = [...later.entries()].filter(([id, lever]) => {
		const before = earlier.get(id);
		return lever != null && before != null && lever !== before;
	}).length;
	if (switched === 0) return void 0;
	return `A customer's applicability decisions took the same requirements out of these two scores by different means (${String(switched)} switched between not applying and having its check switched off). The two levers leave the same total and give it a different range, so a movement between these two ranges need not be a movement in the estate. Run a full scan under one set to compare them.`;
}
/**
* The entries as requirement to lever, with an absent lever where the run recorded none.
*
* A `Map` rather than a set of the raw strings, because the two halves refuse for different reasons and
* the id half has to keep comparing as it did: the same requirement under two levers is one requirement
* out of both denominators, not one added and one dropped.
*/
function levered(entries) {
	const found = /* @__PURE__ */ new Map();
	for (const entry of entries ?? []) {
		const at = entry.indexOf(":");
		if (at === -1) found.set(entry, void 0);
		else found.set(entry.slice(0, at), entry.slice(at + 1));
	}
	return found;
}
/**
* What the definitions of two runs mean for comparing them.
*
* Returned as a reason rather than a boolean, because every case here is one a reader has to be able
* to act on, and "not comparable" without the reason sends them to ask somebody.
*
* The fingerprint decides, not the version number, which is ADR 0037's property being spent rather
* than restated: a definition renamed or handed to a new owner produces a new version at the same
* fingerprint, and two runs either side of that are of the same estate answering the same questions.
* A definition whose scope, window or pillars moved produces a different fingerprint, and those two
* runs are not a trend however similar their totals look.
*/
function definitionBarrier(a, b) {
	if (a == null && b == null) return void 0;
	if (a == null || b == null) {
		const named = customerAssessmentName((a ?? b)?.name);
		return `One of these runs answers to ${named == null ? "an assessment" : `assessment “${named}”`} and the other was started directly, so they are not two measurements of one assessment.`;
	}
	if (a.id !== b.id) {
		const aName = customerAssessmentName(a.name);
		const bName = customerAssessmentName(b.name);
		return `These runs answer to different assessments${aName != null && bName != null ? aName === bName ? ` that share the name “${aName}”` : ` (“${aName}” and “${bName}”)` : aName != null || bName != null ? `, one named “${aName ?? bName}”` : ""}, which cover different things.`;
	}
	if (a.fingerprint !== b.fingerprint) {
		const assessment = customerAssessmentName(a.name) ?? customerAssessmentName(b.name);
		return `${assessment == null ? "The assessment" : `Assessment “${assessment}”`} changed what it measures between version ${String(b.version)} and version ${String(a.version)} — its scope, window or pillars — so the two runs asked different questions.`;
	}
}
//#endregion
export { comparable, definitionBarrier, identityBarriers, stampEnough };
