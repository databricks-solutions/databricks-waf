import { digestOf } from "../records/digest.js";
var DefinitionError = class extends Error {};
/**
* The measurement in the exact shape the fingerprint is taken over.
*
* Sorted and stripped of anything absent, so that a definition assembled in a different field
* order, or with `pillars: undefined` present as a key, fingerprints the same. Without this the
* hash would depend on how the object was built, which is the failure `canonical.ts` exists to
* stop for stored records and which arrives here by the same route.
*/
function fingerprintable(measurement) {
	const scope = measurement.scope.kind === "account" ? { kind: "account" } : {
		kind: "selected",
		workspaceIds: [...new Set(measurement.scope.workspaceIds)].sort()
	};
	return {
		lookbackDays: measurement.lookbackDays,
		...measurement.pillars != null ? { pillars: [...new Set(measurement.pillars)].sort() } : {},
		scope
	};
}
/** What two runs compare on. Equal fingerprints mean the same question of the same estate. */
function fingerprintOf(measurement) {
	return digestOf(fingerprintable(measurement));
}
/**
* A measurement with its sets in canonical form, as it should be stored.
*
* The fingerprint would be stable without this, since it canonicalises on the way in. Storing the
* canonical form as well means the value a reader sees and the value that was hashed are the same
* thing, rather than two representations that happen to agree.
*/
function normalise(measurement) {
	if (!Number.isInteger(measurement.lookbackDays)) throw new DefinitionError("A lookback is a whole number of days.");
	if (measurement.lookbackDays < 1 || measurement.lookbackDays > 365) throw new DefinitionError(`A lookback of ${String(measurement.lookbackDays)} days is outside the ${String(1)} to ${String(365)} the system tables retain.`);
	if (measurement.pillars != null && measurement.pillars.length === 0) throw new DefinitionError("An assessment of no pillars is not an assessment. Omit the list to cover all of them.");
	if (measurement.scope.kind === "selected" && measurement.scope.workspaceIds.length === 0) throw new DefinitionError("A selected scope with no workspaces in it would assess nothing. Choose at least one, or use account reach.");
	return {
		scope: measurement.scope.kind === "account" ? { kind: "account" } : {
			kind: "selected",
			workspaceIds: identifiers(measurement.scope.workspaceIds, "workspace")
		},
		lookbackDays: measurement.lookbackDays,
		...measurement.pillars != null ? { pillars: identifiers(measurement.pillars, "pillar") } : {}
	};
}
/**
* A set of ids in canonical form: trimmed, deduplicated after trimming, sorted, none of them blank.
*
* Trimming matters more here than it looks. `' w1'` and `'w1'` are one estate under two fingerprints,
* and a fingerprint is what two runs compare on — so an author who pasted a list with a stray space
* gets a definition that can never be compared against the same definition typed by hand. Deduplicating
* after the trim rather than before is the whole point: the two forms have to collapse into one.
*
* A blank id is refused rather than dropped. Dropping it would silently turn a selection of three
* workspaces into a selection of two, at a stable fingerprint, which is the shape of error this module
* exists to make impossible: a definition that persists a mistake and repeats it on every run while the
* trend reads as healthy.
*
* What this does not check is whether the id names anything. That needs the catalogue for a pillar and
* the account directory for a workspace, and neither belongs to a domain object that has to be
* constructible from a stored row without reading either. The routes check existence; see
* `definition-routes.ts`.
*/
function identifiers(values, kind) {
	const trimmed = values.map((value) => value.trim());
	if (trimmed.some((value) => value === "")) throw new DefinitionError(`A blank ${kind} id is not a ${kind}. Remove it, or name the one that was meant.`);
	return [...new Set(trimmed)].sort();
}
/**
* The targets in canonical form, checked against the measurement they are targets of.
*
* Sorted by pillar so two definitions committing to the same thing store it the same way, which
* matters here for the same reason it matters for workspace ids even though these are not
* fingerprinted: a reader comparing two versions should see a reordering as no change.
*
* The cross-check is the point of taking the measurement. A target for a pillar the assessment does
* not measure can never be reported against — the run produces no score for it — so it would sit in
* the document looking like a commitment and behaving like nothing. That is worse than being refused,
* because the author believes they have set it.
*/
function normaliseTargets(targets, measurement) {
	const measured = measurement.pillars == null ? void 0 : new Set(measurement.pillars);
	const seen = /* @__PURE__ */ new Set();
	const kept = [];
	for (const target of targets) {
		const pillar = target.pillar.trim();
		if (pillar === "") throw new DefinitionError("A target names the pillar it is a target for, and this one names none.");
		if (seen.has(pillar)) throw new DefinitionError(`There are two targets for ${pillar}. A pillar has one target, so say which of them is meant.`);
		seen.add(pillar);
		if (measured != null && !measured.has(pillar)) throw new DefinitionError(`This assessment does not measure ${pillar}, so a target for it could never be reported against. Add the pillar to the assessment, or drop the target.`);
		if (!Number.isInteger(target.atLeast)) throw new DefinitionError(`A target is a whole number of points, and ${String(target.atLeast)} is not.`);
		if (target.atLeast < 1 || target.atLeast > 100) throw new DefinitionError(`A target of ${String(target.atLeast)} is outside the ${String(1)} to ${String(100)} a score can be.`);
		if (Number.isNaN(target.by.getTime())) throw new DefinitionError(`The date on the ${pillar} target is not a date.`);
		kept.push({
			pillar,
			atLeast: target.atLeast,
			by: target.by
		});
	}
	return kept.sort((a, b) => a.pillar.localeCompare(b.pillar));
}
function normaliseAttribution(attribution) {
	const name = attribution.name.trim();
	if (name === "") throw new DefinitionError("An assessment needs a name somebody can ask for it by.");
	const purpose = attribution.purpose?.trim();
	return {
		name,
		...purpose != null && purpose !== "" ? { purpose } : {},
		owners: [...new Set(attribution.owners.map((owner) => owner.trim()).filter((owner) => owner !== ""))].sort()
	};
}
/**
* The person a version is attributed to, which cannot be nobody.
*
* `normaliseAttribution` already refuses a blank name, and this field has a stronger claim to the same
* check: the name is what an assessment is called, and this is who decided what it measures. An empty
* string satisfies the type and defeats the feature — a version history whose author column is blank
* answers none of the questions a version history exists to answer.
*
* Refused rather than replaced with "unknown". A caller that does not know who is acting has a bug in
* its authorization, and every route reaching here has already established an actor in order to be
* allowed to call it. Substituting a placeholder would hide that.
*/
function attributedTo(createdBy) {
	const actor = createdBy.trim();
	if (actor === "") throw new DefinitionError("A version records who decided it, and no one was named.");
	return actor;
}
/** A new definition at version 1. */
function define(draft, id, createdAt, createdBy) {
	const measurement = normalise(draft.measurement);
	const targets = normaliseTargets(draft.targets ?? [], measurement);
	return {
		id,
		versions: [{
			version: 1,
			fingerprint: fingerprintOf(measurement),
			createdAt,
			createdBy: attributedTo(createdBy),
			measurement,
			attribution: normaliseAttribution(draft.attribution),
			...targets.length > 0 ? { targets } : {}
		}]
	};
}
function currentVersion(definition) {
	const current = definition.versions.at(-1);
	if (current == null) throw new DefinitionError(`Definition ${definition.id} has no versions.`);
	return current;
}
/**
* The same definition with one more version on the end.
*
* Refuses a revision that changes nothing, because a version that differs from its predecessor
* only in timestamp tells a later reader that something was decided when nothing was, and a
* history of those is a history nobody reads.
*/
function revise(definition, revision, createdAt, createdBy) {
	if (definition.archivedAt != null) throw new DefinitionError(`Assessment "${currentVersion(definition).attribution.name}" was archived, so it cannot be revised. Copy it instead.`);
	const author = attributedTo(createdBy);
	const current = currentVersion(definition);
	const measurement = revision.measurement != null ? normalise(revision.measurement) : current.measurement;
	const attribution = revision.attribution != null ? normaliseAttribution(revision.attribution) : current.attribution;
	const targets = normaliseTargets(revision.targets ?? current.targets ?? [], measurement);
	if (same(measurement, current.measurement) && same(attribution, current.attribution) && same(targets, current.targets ?? [])) throw new DefinitionError("That revision would change nothing.");
	const note = revision.note?.trim();
	return {
		...definition,
		versions: [...definition.versions, {
			version: current.version + 1,
			fingerprint: fingerprintOf(measurement),
			createdAt,
			createdBy: author,
			measurement,
			attribution,
			...targets.length > 0 ? { targets } : {},
			...note != null && note !== "" ? { note } : {}
		}]
	};
}
/** Compared as canonical bytes, so field order and set order do not decide whether this is a change. */
function same(a, b) {
	return digestOf(a) === digestOf(b);
}
/**
* Retire a definition from the list of things a new run can be started against.
*
* Idempotent, and it keeps the *first* date: archiving twice is a second click on a button whose
* effect already happened, and moving the date would rewrite when the decision was taken.
*/
function archive(definition, at) {
	if (definition.archivedAt != null) return definition;
	return {
		...definition,
		archivedAt: at
	};
}
/**
* Put an archived definition back, by forgetting that it was archived.
*
* The date is dropped rather than kept beside a flag, because `archivedAt` is the whole
* representation of the state and a definition holding the date it was once archived would read as
* archived to every caller that asks the obvious question. What was archived and when is in the
* audit log, which is where a history belongs — the definition carries what is true now.
*
* Nothing about the versions changes. Archiving never removed them, so there is nothing to restore:
* a run stamped with version 3 still resolves version 3 either way, and this only decides whether
* the definition appears among the things a new run can be started against.
*/
function unarchive(definition) {
	if (definition.archivedAt == null) return definition;
	const { archivedAt: _was, ...rest } = definition;
	return rest;
}
/**
* The definition's scope, resolved against the directory the scan just read.
*
* Order matters in one place worth naming: a named workspace is looked up in the whole directory
* before it is called unknown, so a cancelled workspace is reported as cancelled rather than as
* missing. The `live` set alone would have collapsed all three omission reasons into one.
*/
function resolveScope(measurement, directory, undeterminedReason) {
	if (directory == null) return {
		assessed: [],
		omitted: [],
		outOfScope: [],
		regionUnverified: [],
		undeterminedReason: undeterminedReason ?? UNREADABLE_DIRECTORY,
		complete: false,
		description: undeterminedDescription(measurement, undeterminedReason)
	};
	const unverified = directory.regionUnverified;
	const undetermined = directory.homeRegion == null;
	if (measurement.scope.kind === "account") return {
		assessed: directory.live,
		omitted: [],
		outOfScope: [],
		regionUnverified: unverified,
		...undetermined ? { homeRegionUndetermined: true } : {},
		complete: true,
		description: accountDescription(directory)
	};
	const wanted = new Set(measurement.scope.workspaceIds);
	const byId = new Map(directory.workspaces.map((workspace) => [workspace.workspaceId, workspace]));
	const liveIds = new Set(directory.live.map((workspace) => workspace.workspaceId));
	const excludedById = new Map(directory.excluded.map((workspace) => [workspace.workspaceId, workspace]));
	const assessed = directory.live.filter((workspace) => wanted.has(workspace.workspaceId));
	const outOfScope = directory.live.filter((workspace) => !wanted.has(workspace.workspaceId));
	const omitted = [];
	for (const id of [...wanted].sort()) {
		if (liveIds.has(id)) continue;
		const excluded = excludedById.get(id);
		if (excluded != null) {
			omitted.push({
				workspaceId: id,
				name: excluded.name,
				status: excluded.status,
				reason: excluded.reason
			});
			continue;
		}
		const known = byId.get(id);
		if (known != null) {
			omitted.push({
				workspaceId: id,
				name: known.name,
				status: known.status,
				reason: "unknown"
			});
			continue;
		}
		omitted.push({
			workspaceId: id,
			reason: "unknown"
		});
	}
	const assessedIds = new Set(assessed.map((workspace) => workspace.workspaceId));
	const regionUnverified = unverified.filter((workspace) => assessedIds.has(workspace.workspaceId));
	return {
		assessed,
		omitted,
		outOfScope,
		regionUnverified,
		...undetermined ? { homeRegionUndetermined: true } : {},
		complete: omitted.length === 0,
		description: selectedDescription({
			assessed: assessed.length,
			omitted,
			outOfScope: outOfScope.length,
			regionUnverified: regionUnverified.length,
			homeRegionUndetermined: undetermined
		})
	};
}
/**
* The fallback reason, worded to claim nothing about why.
*
* "Could not be read" would name a cause this function does not know: the caller may have been refused
* the grant, or may simply not have looked yet. Callers that know say so through `undeterminedReason`,
* and the two readings need different remedies — one is a grant, the other is a scan.
*/
const UNREADABLE_DIRECTORY = "The account directory was not read, so what this scope covers is unknown rather than empty.";
/**
* What to say when there was no directory.
*
* Names what was asked for, because that much is known and is the part an author can act on, and says
* plainly that whether it was covered was not established. The reason is quoted when the caller has one
* — "the workspace directory is in Public Preview and this account cannot read it" sends somebody
* somewhere, and "unavailable" does not.
*/
function undeterminedDescription(measurement, reason) {
	return `This assessment covers ${measurement.scope.kind === "account" ? "every workspace the scanning identity can see" : `${String(measurement.scope.workspaceIds.length)} named workspace${measurement.scope.workspaceIds.length === 1 ? "" : "s"}`}, and how much of that was reached could not be established. ` + (reason ?? UNREADABLE_DIRECTORY);
}
function accountDescription(directory) {
	const covered = directory.live.length;
	return `Assessed across every workspace the scanning identity can see — ${`${String(covered)} workspace${covered === 1 ? "" : "s"}`} at the time of the run. Because the scope is what the identity can read rather than a set that was chosen, a change to its grants changes what this assessment is of.`;
}
function selectedDescription(coverage) {
	const { assessed, omitted, outOfScope } = coverage;
	const named = assessed + omitted.length;
	const head = `Assessed ${String(assessed)} of the ${String(named)} workspace${named === 1 ? "" : "s"} this assessment covers.`;
	const tail = [];
	if (outOfScope > 0) tail.push(`${String(outOfScope)} further workspace${outOfScope === 1 ? "" : "s"} in the account ${outOfScope === 1 ? "is" : "are"} deliberately outside it.`);
	const missing = omitted.filter((one) => one.reason === "unknown");
	const stopped = omitted.filter((one) => one.reason === "not-running");
	const elsewhere = omitted.filter((one) => one.reason === "other-region");
	if (stopped.length > 0) tail.push(`${list(stopped)} ${stopped.length === 1 ? "is" : "are"} no longer running, so ${stopped.length === 1 ? "it holds" : "they hold"} nothing to assess.`);
	if (elsewhere.length > 0) tail.push(`${list(elsewhere)} ${elsewhere.length === 1 ? "is" : "are"} in another region, which this deployment cannot read. A deployment there would cover ${elsewhere.length === 1 ? "it" : "them"}.`);
	const unclassified = missing.filter((one) => one.name != null);
	const absent = missing.filter((one) => one.name == null);
	if (unclassified.length > 0) tail.push(`${list(unclassified)} ${unclassified.length === 1 ? "is" : "are"} in the account directory, which does not say whether ${unclassified.length === 1 ? "it is" : "they are"} running. Until it does, ${unclassified.length === 1 ? "it was" : "they were"} left out rather than assessed on a guess.`);
	if (absent.length > 0) tail.push(`${list(absent)} ${absent.length === 1 ? "is" : "are"} not in the account directory at all. That happens when a workspace is cancelled and when the scanning identity loses the grant to see it, and the two cannot be told apart from here — so this assessment covers less than it claims until somebody says which.`);
	const regionClause = regionCaveat(coverage);
	if (regionClause != null) tail.push(regionClause);
	return [head, ...tail].join(" ");
}
/**
* What to say about workspaces whose region was never established, if anything.
*
* Two sentences rather than one because the causes are different and so is the remedy. When the home
* region itself is unknown nothing was filtered, so the risk is that the assessment silently spans
* regions; when only some workspaces lack a region, the usual cause is that they spent nothing in the
* lookback window, and a longer window fixes it. Saying "region unverified" without which of those it is
* leaves a reader with a caveat and no action.
*/
function regionCaveat(coverage) {
	if (coverage.homeRegionUndetermined) return "Which region this deployment reads was not established, so no workspace was excluded for being in another one. If the account spans regions, this assessment may be reading across them.";
	const unverified = coverage.regionUnverified;
	if (unverified === 0) return void 0;
	return `${String(unverified)} of ${String(coverage.assessed)} ${unverified === 1 ? "was" : "were"} assessed without confirming the region it bills from, which happens when a workspace spent nothing in the lookback window. A longer window would settle it.`;
}
/** Names where there are few enough to read, and a count where there are not. */
function list(workspaces) {
	const labels = workspaces.map((one) => one.name ?? one.workspaceId);
	if (labels.length > 3) return `${String(labels.length)} workspaces`;
	if (labels.length === 1) return labels[0] ?? "";
	return `${labels.slice(0, -1).join(", ")} and ${labels.at(-1) ?? ""}`;
}
//#endregion
export { DefinitionError, archive, currentVersion, define, fingerprintOf, resolveScope, revise, unarchive };
