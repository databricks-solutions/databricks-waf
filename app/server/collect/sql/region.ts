// Which workspaces one deployment of this app can assess, and which it can only name.
//
// A Unity Catalog metastore is region-bound. `system.billing.usage` and `system.access.workspaces_latest`
// are account-global, while the tables describing how compute and jobs are configured are regional. So
// the two halves of a scan disagree by default and nothing says so: measured on a large account, the cost
// signals saw 15 workspaces and every compute signal saw 5, because 10 billed from other regions.
// Reviewing those means deploying the app there, which is why they are excluded rather than half-assessed.
//
// This narrows the directory once, before anything reads it, so a single partition answers three
// questions that used to be answered separately — which ids the queries filter to, what the estate
// summary reports, and what the export claims coverage of. The version this replaces applied the region
// filter to the query parameter alone, so the queries covered five workspaces while the summary beside
// them said fifteen, which is the same class of mistake as the one E1 set out to fix.

import type { ExcludedWorkspace, WorkspaceDirectory, WorkspaceRow } from './shapes.js';

/**
 * The directory narrowed to what this deployment can actually assess.
 *
 * When the host workspace is unknown, or billed no SKU carrying a region, nothing is filtered: the
 * region is unresolved rather than known-to-be-anything, and dropping workspaces on that basis would
 * discard an estate to protect a guess. Every live workspace is then region-unverified, which is what
 * makes the difference visible instead of implied.
 */
export function scopedToRegion(directory: WorkspaceDirectory, hostWorkspaceId?: string): WorkspaceDirectory {
  const home = homeRegionOf(directory, hostWorkspaceId);

  if (home == null) {
    return { ...directory, regionUnverified: directory.live };
  }

  const inRegion: WorkspaceRow[] = [];
  const elsewhere: ExcludedWorkspace[] = [];
  for (const workspace of directory.live) {
    // Unknown stays in. Known-and-different is the only case that can be excluded on region, because it
    // is the only one where the exclusion is a fact rather than an inference from missing data.
    if (workspace.region == null || workspace.region === home) inRegion.push(workspace);
    else elsewhere.push({ ...workspace, reason: 'other-region' });
  }

  return {
    workspaces: directory.workspaces,
    live: inRegion,
    excluded: [...directory.excluded, ...elsewhere],
    regionUnverified: inRegion.filter((workspace) => workspace.region == null),
    outOfScope: directory.outOfScope,
    homeRegion: home,
  };
}

/** The region the app's own workspace bills from, when the directory could read one for it. */
function homeRegionOf(directory: WorkspaceDirectory, hostWorkspaceId?: string): string | undefined {
  if (hostWorkspaceId == null) return undefined;
  return directory.workspaces.find((workspace) => workspace.workspaceId === hostWorkspaceId)?.region;
}
