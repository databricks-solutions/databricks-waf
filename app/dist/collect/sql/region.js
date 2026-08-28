//#region server/collect/sql/region.ts
/**
* The directory narrowed to what this deployment can actually assess.
*
* When the host workspace is unknown, or billed no SKU carrying a region, nothing is filtered: the
* region is unresolved rather than known-to-be-anything, and dropping workspaces on that basis would
* discard an estate to protect a guess. Every live workspace is then region-unverified, which is what
* makes the difference visible instead of implied.
*/
function scopedToRegion(directory, hostWorkspaceId) {
	const home = homeRegionOf(directory, hostWorkspaceId);
	if (home == null) return {
		...directory,
		regionUnverified: directory.live
	};
	const inRegion = [];
	const elsewhere = [];
	for (const workspace of directory.live) if (workspace.region == null || workspace.region === home) inRegion.push(workspace);
	else elsewhere.push({
		...workspace,
		reason: "other-region"
	});
	return {
		workspaces: directory.workspaces,
		live: inRegion,
		excluded: [...directory.excluded, ...elsewhere],
		regionUnverified: inRegion.filter((workspace) => workspace.region == null),
		outOfScope: directory.outOfScope,
		homeRegion: home
	};
}
/** The region the app's own workspace bills from, when the directory could read one for it. */
function homeRegionOf(directory, hostWorkspaceId) {
	if (hostWorkspaceId == null) return void 0;
	return directory.workspaces.find((workspace) => workspace.workspaceId === hostWorkspaceId)?.region;
}
//#endregion
export { scopedToRegion };
