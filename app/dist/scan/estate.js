//#region server/scan/estate.ts
const DIRECTORY = "sql:estate.workspaces";
function summariseEstate(signals) {
	const signal = signals.get(DIRECTORY);
	if (signal == null) return {
		assessed: [],
		excluded: [],
		undeterminedReason: "The workspace directory was not collected, so this scan cannot say how many workspaces it covered."
	};
	if (signal.status !== "observed") return {
		assessed: [],
		excluded: [],
		undeterminedReason: `${signal.unmeasurableReason ?? "The workspace directory could not be read."} Resource counts in this scan may therefore include workspaces that have been cancelled.`
	};
	const directory = signal.value;
	return {
		workspacesInAccount: directory.workspaces.length,
		assessed: directory.live.map(reference),
		excluded: directory.excluded.map(reference),
		...directory.regionUnverified.length > 0 ? { regionUnverified: directory.regionUnverified.length } : {},
		...directory.outOfScope.length > 0 ? { outOfScope: directory.outOfScope.map(reference) } : {},
		...directory.homeRegion != null ? { region: directory.homeRegion } : {}
	};
}
/** One sentence a reader can act on, or undefined when there is nothing worth saying. */
function describeEstate(estate) {
	if (estate.undeterminedReason != null) return estate.undeterminedReason;
	const assessed = estate.assessed.length;
	const unasked = estate.outOfScope?.length ?? 0;
	if (assessed === 0 && estate.excluded.length === 0 && unasked === 0) return void 0;
	const covered = `Assessed ${count(assessed, "workspace")}${estate.region != null ? ` in ${estate.region}` : ""}`;
	const sentences = estate.excluded.length === 0 ? [`${covered}.`] : [`${covered}.`, `${count(estate.excluded.length, "workspace")} excluded as not assessable: ${reasons(estate.excluded)}.`];
	if (unasked > 0) sentences.push(`${count(unasked, "assessable workspace")} ${unasked === 1 ? "was" : "were"} outside the scope this assessment names, so nothing was read from ${unasked === 1 ? "it" : "them"}. Findings about Unity Catalog, this workspace’s own settings and account-wide configuration answer for what they can see rather than for the named workspaces, and each one says which.`);
	const unproven = estate.regionUnverified ?? 0;
	if (estate.region == null && unproven > 0) sentences.push("This deployment could not establish its own region, so no workspace was excluded for region. Where an account spans regions, the compute and job tables answer for one region only, so these counts may be wider than what was read.");
	else if (unproven > 0) sentences.push(`${String(unproven)} of those assessed billed no region-bearing SKU, so ${unproven === 1 ? "its" : "their"} region could not be confirmed.`);
	return sentences.join(" ");
}
/**
* The exclusions, grouped by what a reader would ask next.
*
* Region is one group because the workspaces in it are all `RUNNING` and their status says nothing; the
* rest keep their status, because "58 cancelled and 6 banned" is the fact that makes a smaller number
* legitimate and six banned workspaces is one fact rather than six.
*/
function reasons(excluded) {
	const elsewhere = excluded.filter((workspace) => workspace.reason === "other-region").length;
	const byStatus = /* @__PURE__ */ new Map();
	for (const workspace of excluded) {
		if (workspace.reason === "other-region") continue;
		byStatus.set(workspace.status, (byStatus.get(workspace.status) ?? 0) + 1);
	}
	return [...elsewhere > 0 ? [`${String(elsewhere)} in another region`] : [], ...[...byStatus.entries()].map(([status, n]) => `${String(n)} ${status.toLowerCase()}`)].join(", ");
}
function reference(workspace) {
	return {
		id: workspace.workspaceId,
		name: workspace.name,
		...workspace.url != null ? { url: workspace.url } : {},
		status: workspace.status,
		..."reason" in workspace ? { reason: workspace.reason } : {}
	};
}
function count(n, noun) {
	return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}
//#endregion
export { describeEstate, summariseEstate };
