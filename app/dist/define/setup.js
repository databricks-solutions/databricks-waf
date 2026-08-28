import { currentVersion } from "./definition.js";
//#region server/define/setup.ts
/**
* The steps of the setup, in the order they are asked.
*
* `sources` and `policies` come after scope because both are consequences of it: which system
* tables get read follows from which pillars are in the assessment, and the rules the result will
* be judged by are worth reading once the reader knows what is being judged. `confirm` is last and
* is the only step that writes anything.
*/
const SETUP_STEPS = [
	"purpose",
	"scope",
	"sources",
	"targets",
	"policies",
	"confirm"
];
/**
* What still stands between this draft and an assessment, step by step.
*
* Every entry is a sentence an author can act on rather than a field name, because this is what
* the wizard's contents strip shows against each step and "name: required" tells somebody who has
* been away for a week nothing they did not already know.
*
* The lookback is checked against the same bounds `normalise` enforces rather than against looser
* ones. A draft that passes here and is then refused on confirm would be the worst of both: the
* author gets to the end before finding out, which is the thing a draft exists to stop.
*/
function troubles(draft) {
	const found = [];
	if ((draft.name ?? "").trim() === "") found.push({
		step: "purpose",
		trouble: "This assessment has no name yet, so nobody could ask for it by one."
	});
	if (draft.scope == null) found.push({
		step: "scope",
		trouble: "Nothing says which workspaces this assessment is of — the whole account, or a set that was chosen."
	});
	else if (draft.scope.kind === "selected" && (draft.scope.workspaceIds ?? []).length === 0) found.push({
		step: "scope",
		trouble: "The scope narrows to chosen workspaces and none are chosen, so this assessment would measure nothing."
	});
	if (draft.lookbackDays == null) found.push({
		step: "scope",
		trouble: "Nothing says how far back this assessment looks."
	});
	else if (!Number.isInteger(draft.lookbackDays) || draft.lookbackDays < 1 || draft.lookbackDays > 365) found.push({
		step: "scope",
		trouble: `A lookback of ${String(draft.lookbackDays)} days is not one the system tables can answer. It has to be a whole number between ${String(1)} and ${String(365)}.`
	});
	if (draft.pillars != null && draft.pillars.length === 0) found.push({
		step: "sources",
		trouble: "No pillars are in the assessment. Choose at least one, or choose them all and the list goes away."
	});
	found.push(...targetTroubles(draft));
	return found;
}
/**
* What is unfinished about the commitments, if anything.
*
* Nothing at all when there are none, which is the ordinary case: a target is optional, so an author
* who never opened this step has left nothing outstanding and must not be told they have. What is
* reported is a target somebody *started* — a score with no date, a date with no score — because that
* is a commitment which would be silently dropped on confirmation, and the author believes they set it.
*
* A target for a pillar the assessment no longer covers is reported here rather than only refused on
* confirmation, and it is the trouble most likely to be reached by accident: choosing four pillars on
* the previous step after setting six targets is two ordinary edits that contradict each other.
*/
function targetTroubles(draft) {
	const started = (draft.targets ?? []).filter((target) => target.pillar.trim() !== "" && (target.atLeast != null || (target.by ?? "") !== ""));
	if (started.length === 0) return [];
	const found = [];
	const half = started.filter((target) => target.atLeast == null || (target.by ?? "") === "");
	if (half.length > 0) found.push({
		step: "targets",
		trouble: `${named(half)} ${half.length === 1 ? "has" : "have"} half a target: a commitment needs both a score and the date it is to be reached by. Fill in the rest, or clear it.`
	});
	const outside = draft.pillars == null ? [] : started.filter((target) => !draft.pillars?.includes(target.pillar));
	if (outside.length > 0) found.push({
		step: "targets",
		trouble: `${named(outside)} ${outside.length === 1 ? "is" : "are"} not in this assessment, so a target for ${outside.length === 1 ? "it" : "them"} could never be reported against. Add the pillar back, or clear the target.`
	});
	const seen = /* @__PURE__ */ new Set();
	const twice = started.filter((target) => {
		const pillar = target.pillar.trim();
		const already = seen.has(pillar);
		seen.add(pillar);
		return already;
	});
	if (twice.length > 0) found.push({
		step: "targets",
		trouble: `${named(twice)} has more than one target, and a pillar has one. Remove the one that is not meant.`
	});
	return found;
}
function named(targets) {
	const pillars = [...new Set(targets.map((target) => target.pillar.trim()))];
	if (pillars.length > 3) return `${String(pillars.length)} pillars`;
	if (pillars.length === 1) return pillars[0] ?? "";
	return `${pillars.slice(0, -1).join(", ")} and ${pillars.at(-1) ?? ""}`;
}
function ready(draft) {
	return troubles(draft).length === 0;
}
/**
* Where to put the author back: the first step that is not finished, or the confirmation.
*
* Derived rather than stored, which is what makes it right after a colleague archives the
* assessment or after the author fixed the scope from a phone. A stored position would have been
* whatever was true when it was written, and the wizard would have opened on a step with nothing
* left to do on it.
*
* The policies step never appears here, because nothing on it is the author's to fill in. It is
* reachable from the contents strip like every other step, and a reader who wants to see the rules
* before confirming can go and read them — but being taken to a page with no field on it, and told
* that is where the work stopped, would be a lie about why they are there.
*/
function resumeAt(draft) {
	const found = troubles(draft);
	for (const step of SETUP_STEPS) if (found.some((one) => one.step === step)) return step;
	return "confirm";
}
/**
* The draft held against the assessment as it is now.
*
* Called on the way into the wizard rather than on the way out. Both orders refuse the same
* revisions; only this one refuses them before the author has spent an evening re-reading their own
* scope.
*/
function standingOf(draft, definition) {
	if (draft.definitionId == null) return { standing: "new" };
	if (definition == null) return {
		standing: "gone",
		warning: "The assessment this was a revision of is no longer in the store, so there is nothing to revise. That happens if it was removed directly in the database, and it also happens if this installation lost the database it was keeping definitions in — the two cannot be told apart from here. What you wrote is still below, and it can be saved as a new assessment."
	};
	if (definition.archivedAt != null) return {
		standing: "archived",
		warning: `"${currentVersion(definition).attribution.name}" was archived, so it cannot take another version. What you wrote is still below, and it can be saved as a new assessment instead.`
	};
	const current = currentVersion(definition);
	if (draft.fromVersion !== current.version) return {
		standing: "superseded",
		warning: `This was started from ${draft.fromVersion == null ? "an unrecorded version" : `version ${String(draft.fromVersion)}`}, and version ${String(current.version)} is now current — ${current.createdBy} changed it. Read what they changed before confirming, because saving this would be a decision made against a copy that no longer exists.`
	};
	return { standing: "current" };
}
var SetupError = class extends Error {};
//#endregion
export { SETUP_STEPS, SetupError, ready, resumeAt, standingOf, troubles };
