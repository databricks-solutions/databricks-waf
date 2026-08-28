// Whether a recorded Databricks URL is still a customer action.
//
// A finding is immutable, so its URL remains useful provenance after the estate changes. The latest
// recorded workspace directory is the narrower fact available now: it can prove that the workspace
// was running when the directory was read, prove that it was not, or say nothing. Topology is not an
// inventory and is deliberately absent from this decision.

import type { LocatedItem, SelectableWorkspace, SelectableWorkspaces } from '../api/types';

export type DestinationStanding = 'current' | 'unavailable' | 'unknown';

export interface ResourceDestination {
  readonly standing: DestinationStanding;
  readonly workspace?: SelectableWorkspace;
  readonly asOf?: string;
}

export function resourceDestination(resource: LocatedItem, directory?: SelectableWorkspaces): ResourceDestination {
  const exact = resource.url == null ? undefined : destinationFrom(resource.url);
  if (exact == null || directory == null || directory.unavailable != null) {
    return { standing: 'unknown', ...(directory?.asOf != null ? { asOf: directory.asOf } : {}) };
  }

  const workspace = directory.workspaces.find((candidate) => candidate.id === exact.workspaceId);
  if (workspace == null) return { standing: 'unknown', ...(directory.asOf != null ? { asOf: directory.asOf } : {}) };
  if (workspace.url == null || originOf(workspace.url) !== exact.origin) {
    return { standing: 'unknown', workspace, ...(directory.asOf != null ? { asOf: directory.asOf } : {}) };
  }

  return {
    standing: workspace.assessable || workspace.status === 'RUNNING' ? 'current' : 'unavailable',
    workspace,
    ...(directory.asOf != null ? { asOf: directory.asOf } : {}),
  };
}

/** The recorded URL only where the latest directory still makes it a customer action. */
export function currentResourceUrl(resource: LocatedItem, directory?: SelectableWorkspaces): string | undefined {
  return resourceDestination(resource, directory).standing === 'current' ? resource.url : undefined;
}

function destinationFrom(url: string): { readonly workspaceId: string; readonly origin: string } | undefined {
  try {
    const parsed = new URL(url);
    const workspaceId = parsed.searchParams.get('o')?.trim();
    return workspaceId == null || workspaceId === '' ? undefined : { workspaceId, origin: parsed.origin };
  } catch {
    return undefined;
  }
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}
