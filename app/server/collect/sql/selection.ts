// Which of the assessable workspaces this run was asked to read.
//
// Before this, a definition naming three workspaces produced a run that read the whole account and a
// scope resolution that said "Assessed 3 of the 3 workspaces this assessment covers". Both halves were
// internally consistent and the pair of them was a false statement: nothing carried the selection into
// the statements, so the scope was a record of intent and the numbers were of everything.
//
// It narrows the directory value rather than the query parameter, immediately after the region
// partition, for the reason E1 established: the ids the statements filter to, the estate summary, the
// stamp and the export have to be one set by construction rather than by four callers agreeing. The
// version of this idea that filters the parameter alone is the bug region.ts was written to fix.
//
// It is not `EstateScope.narrowedTo`. That binds `workspace_id`, forces `reach: 'workspace'` on every
// signal and disables slicing, all of which are right for one workspace and wrong for six: a run of six
// out of forty is an account-reach read of six, and it still wants slicing.

import type { WorkspaceDirectory, WorkspaceRow } from './shapes.js';

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
export function scopedToSelection(directory: WorkspaceDirectory, selected: readonly string[]): WorkspaceDirectory {
  const asked = new Set(selected);
  const inScope: WorkspaceRow[] = [];
  const left: WorkspaceRow[] = [];
  for (const workspace of directory.live) {
    if (asked.has(workspace.workspaceId)) inScope.push(workspace);
    else left.push(workspace);
  }

  return {
    ...directory,
    live: inScope,
    // Recomputed rather than kept, because it is a statement about the assessed set: a workspace whose
    // region nobody could read is no caveat on a run that was never going to read it.
    regionUnverified: inScope.filter((workspace) => workspace.region == null),
    outOfScope: [...directory.outOfScope, ...left],
  };
}
