import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
//#region server/catalogue/changelog.ts
const NO_CHANGELOG = { entries: [] };
function loadChangelog(directory) {
	const path = join(directory, "changelog.json");
	if (!existsSync(path)) return NO_CHANGELOG;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!Array.isArray(parsed)) return NO_CHANGELOG;
		return { entries: parsed.map(entry).filter((one) => numbered(one.version)).sort((a, b) => order(a.version) - order(b.version)) };
	} catch {
		return NO_CHANGELOG;
	}
}
function entry(raw) {
	const one = raw ?? {};
	return {
		version: typeof one.version === "number" || typeof one.version === "string" ? String(one.version) : "",
		fingerprint: typeof one.fingerprint === "string" ? one.fingerprint : "",
		recordedAt: typeof one.recordedAt === "string" ? one.recordedAt : "",
		scoredUnits: typeof one.scored_units === "number" ? one.scored_units : 0,
		describes: one.describes === true,
		added: ids(one.added),
		removed: ids(one.removed),
		renamed: Array.isArray(one.renamed) ? one.renamed.map((move) => move).filter((move) => typeof move.from === "string" && typeof move.to === "string").map((move) => ({
			from: String(move.from),
			to: String(move.to)
		})) : [],
		changed: Array.isArray(one.changed) ? one.changed.map((change) => change).filter((change) => typeof change.id === "string").map((change) => ({
			id: String(change.id),
			fields: ids(change.fields)
		})) : []
	};
}
function ids(value) {
	return Array.isArray(value) ? value.filter((one) => typeof one === "string") : [];
}
function order(version) {
	const parsed = Number(version);
	return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
}
function numbered(version) {
	return version !== "" && Number.isFinite(Number(version));
}
/**
* What lies between the catalogue a run was scored against and the catalogue a later run was.
*
* Directional: `later` and `earlier` are the two runs' versions in time order, and the answer is
* expressed from the earlier catalogue's point of view, because that is the one whose findings have
* to be carried across. Symmetric input would be a nicer signature and a worse answer — a control
* "added" means the opposite depending on which way round it is read.
*/
function spanBetween(changelog, earlier, later) {
	if (earlier === later) return {
		describable: true,
		added: [],
		removed: [],
		renamed: /* @__PURE__ */ new Map(),
		changed: [],
		versions: []
	};
	if (!numbered(earlier) || !numbered(later)) return {
		describable: false,
		why: "One of these runs does not record which catalogue version it was scored against, so what changed between them cannot be established.",
		added: [],
		removed: [],
		renamed: /* @__PURE__ */ new Map(),
		changed: [],
		versions: []
	};
	const from = order(earlier);
	const to = order(later);
	if (from > to) return {
		describable: false,
		why: `The more recent run was scored against catalogue version ${later}, which is older than version ${earlier}. Comparing across a rollback is not described.`,
		added: [],
		removed: [],
		renamed: /* @__PURE__ */ new Map(),
		changed: [],
		versions: []
	};
	const crossed = changelog.entries.filter((one) => order(one.version) > from && order(one.version) <= to);
	const missing = missingVersions(crossed, from, to);
	if (missing != null) return {
		describable: false,
		why: missing,
		added: [],
		removed: [],
		renamed: /* @__PURE__ */ new Map(),
		changed: [],
		versions: []
	};
	const endpoint = crossed.find((one) => order(one.version) === to);
	return {
		describable: true,
		...compose(crossed),
		versions: crossed.map((one) => one.version).reverse(),
		...endpoint != null && endpoint.fingerprint !== "" ? { recordedFingerprint: endpoint.fingerprint } : {}
	};
}
/**
* What the crossed versions did, composed forward one version at a time.
*
* Forward rather than as a set-difference between the two endpoints, because a control can move more
* than once: renumbered in 10 and re-severitied in 11 is one requirement with a history, and
* differencing the endpoints would report it as a removal beside an addition.
*/
function compose(crossed) {
	const lineages = [];
	/** Which lineage holds each id right now. An id absent from this is unoccupied. */
	const occupying = /* @__PURE__ */ new Map();
	/** Every id this walk has ever put a lineage on, so a vacated id is not mistaken for an untouched one. */
	const touched = /* @__PURE__ */ new Set();
	/**
	* The lineage holding an id, minting one for a requirement the walk has not seen before.
	*
	* A first sighting means the requirement was in the earlier catalogue under this id and nothing
	* has moved it yet, so the minted lineage starts there. Unless the id has been *vacated*, which
	* means the record is naming an id nothing occupies — a `changed` on a requirement a previous
	* version removed. That is a contradictory record rather than a case to interpret, and the
	* degradation is chosen deliberately: the lineage is minted with no `startId`, so it cannot claim
	* an earlier-catalogue identity that another lineage already holds, and it surfaces as an
	* arrival rather than corrupting the departure.
	*/
	const holding = (id) => {
		const occupant = occupying.get(id);
		if (occupant != null) return occupant;
		const lineage = touched.has(id) ? { changed: /* @__PURE__ */ new Set() } : {
			startId: id,
			changed: /* @__PURE__ */ new Set()
		};
		lineages.push(lineage);
		occupy(id, lineage);
		return lineage;
	};
	/** Puts a lineage on an id, and takes off whatever was there. */
	function occupy(id, lineage) {
		const displaced = occupying.get(id);
		if (displaced != null && displaced !== lineage) displaced.liveId = void 0;
		occupying.set(id, lineage);
		touched.add(id);
		lineage.liveId = id;
	}
	const vacate = (id) => {
		const lineage = holding(id);
		occupying.delete(id);
		lineage.liveId = void 0;
		return lineage;
	};
	for (const step of crossed) {
		for (const id of step.removed) vacate(id);
		for (const move of step.renamed) {
			const lineage = holding(move.from);
			occupying.delete(move.from);
			occupy(move.to, lineage);
		}
		for (const id of step.added) {
			const lineage = { changed: /* @__PURE__ */ new Set() };
			lineages.push(lineage);
			occupy(id, lineage);
		}
		for (const one of step.changed) {
			const lineage = holding(one.id);
			for (const field of one.fields) lineage.changed.add(field);
		}
	}
	const added = [];
	const removed = [];
	const renamed = /* @__PURE__ */ new Map();
	const changed = [];
	for (const lineage of lineages) {
		const { startId, liveId } = lineage;
		if (startId != null && liveId != null) {
			if (startId !== liveId) renamed.set(startId, liveId);
			if (lineage.changed.size > 0) changed.push({
				id: liveId,
				fields: [...lineage.changed].sort()
			});
			continue;
		}
		if (startId != null) removed.push(startId);
		else if (liveId != null) added.push(liveId);
	}
	return {
		added: added.sort(),
		removed: removed.sort(),
		renamed,
		changed: changed.sort((a, b) => a.id.localeCompare(b.id))
	};
}
/**
* Why the span cannot be walked, if it cannot.
*
* Every version between the two endpoints has to be present and has to describe itself. One gap and
* the composition is wrong in a way that reads as right: a control renamed in the missing version
* would appear as an addition beside a removal, and the delta attributed to it would be a
* requirement arriving rather than being renumbered.
*/
function missingVersions(crossed, from, to) {
	const present = new Set(crossed.map((one) => order(one.version)));
	const absent = [];
	for (let version = Math.floor(from) + 1; version <= Math.floor(to); version += 1) if (!present.has(version)) absent.push(version);
	if (to !== Math.floor(to) && !present.has(to)) absent.push(to);
	if (absent.length > 0) return `This build has no record of what changed in catalogue version ${absent.map(String).join(", ")}, so the difference between these two runs cannot be attributed.`;
	const undescribed = crossed.filter((one) => !one.describes).map((one) => one.version);
	if (undescribed.length > 0) return `Catalogue version ${undescribed.join(", ")} was recorded before this app wrote down what a version changed, so the difference between these two runs cannot be attributed.`;
}
//#endregion
export { NO_CHANGELOG, loadChangelog, spanBetween };
