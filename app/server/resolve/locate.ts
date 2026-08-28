// Where in the workspace UI a finding gets fixed.
//
// A finding that names `nightly-load` as unscheduled tells the reader what is wrong. It does
// not tell them where to go, and across eleven workspaces "search the jobs list for
// nightly-load" is a minute of work per finding. The ids are already in the evidence rows, so
// the link is computable — 184 hand-authored URLs would be both wrong and unmaintainable.
//
// Two facts make this safe to compute:
//
// - Each workspace's own base URL comes from `system.access.workspaces_latest`, which the
//   scan already reads to filter cancelled workspaces out of every denominator. Measured on
//   labs: `workspace_url` is populated and absolute for all 11 workspaces. So a link into
//   another workspace of the same account is as reliable as a link into this one.
// - The job route shape is the platform's own. A run's `run_page_url` from the Jobs API reads
//   `https://<host>/?o=<workspaceId>#job/<jobId>/run/<runId>`, so the job page is that URL
//   without the run segment. Using the form Databricks itself emits in job notifications
//   beats using the form its documentation describes.
//
// Routes are only listed here for surfaces addressed by a stable id. Workspace settings pages
// are deliberately absent: their sub-tab routes are undocumented, and a link that lands
// somewhere plausible but wrong costs more trust than no link at all.

import { rowsOf, type WorkspaceDirectory, type WorkspaceRow } from '../collect/sql/shapes.js';

/** A kind of estate resource with a stable identifier and a page of its own. */
export type EstateObjectKind = 'job' | 'cluster' | 'warehouse' | 'pipeline' | 'table';

/**
 * One resource, addressed the way its workspace addresses it.
 *
 * Carries no display name: the caller already labelled the resource for the finding's prose,
 * and a link whose text disagreed with the sentence above it would read as a different
 * resource.
 */
export interface EstateObject {
  readonly kind: EstateObjectKind;
  /** The workspace-scoped id, or for a table the three-part Unity Catalog name. */
  readonly id: string;
  /** Absent for a resource whose row predates the column, which is not linkable. */
  readonly workspaceId?: string;
}

export const asJob = (row: { readonly jobId: string; readonly workspaceId?: string }): EstateObject => ({
  kind: 'job',
  id: row.jobId,
  workspaceId: row.workspaceId,
});

export const asCluster = (row: { readonly clusterId: string; readonly workspaceId?: string }): EstateObject => ({
  kind: 'cluster',
  id: row.clusterId,
  workspaceId: row.workspaceId,
});

export const asWarehouse = (row: { readonly warehouseId: string; readonly workspaceId?: string }): EstateObject => ({
  kind: 'warehouse',
  id: row.warehouseId,
  workspaceId: row.workspaceId,
});

export const asPipeline = (row: { readonly pipelineId: string; readonly workspaceId?: string }): EstateObject => ({
  kind: 'pipeline',
  id: row.pipelineId,
  workspaceId: row.workspaceId,
});

/** A table, addressed by its full name. `workspaceId` says which workspace's Catalog Explorer to open. */
export const asTable = (name: string, workspaceId?: string): EstateObject => ({
  kind: 'table',
  id: name,
  workspaceId,
});

/**
 * Resolve estate objects to URLs, against the workspaces an account actually has.
 *
 * Returns undefined per object rather than throwing, and for every object when the directory
 * is unreadable. A finding must still be produced when only its links are unavailable: an
 * account that cannot read `workspaces_latest` gets prose instead of links, not an
 * unmeasurable control.
 */
export function linksIn(directory: WorkspaceDirectory | undefined): (object: EstateObject) => string | undefined {
  // A directory that is absent and one whose value is not the shape this expects are the same case, and
  // both have to answer `undefined` rather than raise. The type says this cannot happen; a reading can
  // come from an imported collection written by an older version of the collector, and an analysis is
  // run after collection has finished — so a throw here does not degrade to prose without links, it
  // takes down a run that had already read the estate. `rowsOf` is why this is a check and not a cast.
  const listed = rowsOf(directory?.live);
  if (listed.length === 0) return () => undefined;

  const hosts = new Map(listed.map((workspace) => [workspace.workspaceId, workspace]));
  return (object) => {
    if (object.workspaceId == null || object.workspaceId === '') return undefined;
    const workspace = hosts.get(object.workspaceId);
    if (workspace == null) return undefined;
    return urlTo(object, workspace);
  };
}

function urlTo(object: EstateObject, workspace: WorkspaceRow): string | undefined {
  const base = (workspace.url ?? '').replace(/\/+$/, '');
  if (base === '') return undefined;

  // Every link names its workspace, the way the platform's own job URLs do. The host identifies
  // the workspace on all three clouds, so this is belt and braces — but the case it covers is a
  // reader with several workspaces open, following a link out of a finding that spans four of
  // them. Landing in the wrong one is the exact failure the link exists to prevent.
  const o = `o=${encodeURIComponent(workspace.workspaceId)}`;

  switch (object.kind) {
    // The platform's own shape, taken verbatim from a run's `run_page_url` minus the run segment.
    case 'job':
      return `${base}/?${o}#job/${encodeURIComponent(object.id)}`;
    case 'cluster':
      return `${base}/compute/clusters/${encodeURIComponent(object.id)}?${o}`;
    case 'warehouse':
      return `${base}/sql/warehouses/${encodeURIComponent(object.id)}?${o}`;
    case 'pipeline':
      return `${base}/pipelines/${encodeURIComponent(object.id)}?${o}`;
    case 'table':
      return tableUrl(base, object.id, o);
  }
}

/**
 * Catalog Explorer addresses a table by its three parts.
 *
 * A name that does not split into exactly three gets no link: a two-part name is a Hive
 * metastore table addressed differently, and a name containing a quoted dot cannot be split
 * safely at all. Both are rare, and guessing at either would produce a link to the wrong table
 * — worse than the prose the reader already has.
 */
function tableUrl(base: string, name: string, query: string): string | undefined {
  const parts = name.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) return undefined;
  return `${base}/explore/data/${parts.map((part) => encodeURIComponent(part)).join('/')}?${query}`;
}
