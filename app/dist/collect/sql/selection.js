//#region server/collect/sql/selection.ts
/**
* The directory narrowed to the workspaces an assessment named.
*
* The workspaces left out land in `outOfScope` rather than `excluded`, because they are a different
* answer to a different question: `excluded` is the estate saying a workspace cannot be assessed, and
* this is the assessment saying it was not asked about. Keeping them apart is also what lets the account
* total still reconcile — three sets summing to `workspaces` — and what lets the workspace picker keep
* offering them, since they are assessable and a wider definition would cover them.
*
* A selected id no live workspace matches contributes nothing and is not an error here. It is either
* stopped, in another region, or gone, and `excluded` already carries the first two with the reason that
* explains them; the third is `resolveScope`'s `unknown`, reported to the author against the catalogue
* this collector cannot read.
*/
function scopedToSelection(directory, selected) {
	const asked = new Set(selected);
	const inScope = [];
	const left = [];
	for (const workspace of directory.live) if (asked.has(workspace.workspaceId)) inScope.push(workspace);
	else left.push(workspace);
	return {
		...directory,
		live: inScope,
		regionUnverified: inScope.filter((workspace) => workspace.region == null),
		outOfScope: [...directory.outOfScope, ...left]
	};
}
//#endregion
export { scopedToSelection };
