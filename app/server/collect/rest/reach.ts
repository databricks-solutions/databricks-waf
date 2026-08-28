// What this app can actually read in this workspace, asked rather than assumed.
//
// 47 requirements have no automated check, and the catalogue names an API for each. Writing
// 47 checks and discovering that 40 are refused would be 40 checks written to report their
// own refusal. So the calls are made first, once, and the answers decide what is worth
// building.
//
// This is not idle diagnostics. ADR 0016 established that the Apps scope registry accepts a
// small subset of published scopes, and separately that acceptance at registration does not
// imply the minted token carries the authority — `serving.serving-endpoints:read` validated
// and then granted nothing. Both directions have to be measured against a live workspace,
// and the only token that can measure them is the one an install actually gets.
//
// Deliberately read-only and deliberately cheap: one call per API family, first page only,
// nothing written. The families are grouped the way the scope registry appears to group
// them, so one refusal stands for every control behind it.

import type { WorkspaceClient } from '@databricks/sdk-experimental';

/** What a family turned out to be. */
export type Reach =
  /** The call answered. Every control behind this family is worth building. */
  | 'readable'
  /** Refused for want of a scope the app does not declare. No install can fix it. */
  | 'no-scope'
  /**
   * Refused for want of a scope the app does declare.
   *
   * Distinct from `no-scope` because the two are the same HTTP response and the opposite
   * situation. Measured: declaring `vector-search` put it in the app's
   * `effective_user_api_scopes` and not in the token minted moments later, because consent is
   * per user and widening the requested set does not re-prompt someone who already consented.
   * So this one clears when that user authorises the app again, and telling them so is worth
   * more than telling them the platform refuses it.
   */
  | 'stale-consent'
  /** Refused on permission. A workspace admin could read it; this user cannot. */
  | 'forbidden'
  /** The endpoint is not there — wrong path, or not enabled on this workspace. */
  | 'absent'
  /** Something else went wrong, so nothing is concluded. */
  | 'error';

export interface Family {
  /** Matches the collector prefix in the catalogue, so results map back to controls. */
  readonly id: string;
  /** What the reader is being told about. */
  readonly label: string;
  /** Controls that are waiting on this family, for ordering the work by payoff. */
  readonly controls: readonly string[];
  read(client: WorkspaceClient): Promise<unknown>;
}

export interface FamilyReach {
  readonly id: string;
  readonly label: string;
  readonly controls: readonly string[];
  readonly reach: Reach;
  /** The platform's own words. Kept because the scope name only appears in them. */
  readonly detail: string;
}

/**
 * The first page of an async iterable, or nothing.
 *
 * Listing endpoints in this SDK are async iterators that make their first request lazily, so
 * a probe that only called the method would report every list as readable without having
 * asked anything. One item is enough to have made the call.
 */
async function firstOf(iterable: AsyncIterable<unknown>): Promise<unknown> {
  for await (const item of iterable) return item;
  return null;
}

export const FAMILIES: readonly Family[] = [
  {
    id: 'iam.permissions',
    label: 'Object permissions',
    // The only family with a scope already in effect, so the one most likely to answer.
    controls: ['SCP-01-06', 'SCP-04-23', 'SCP-05-09'],
    read: (client) => client.permissions.getPermissionLevels({ request_object_type: 'authorization', request_object_id: 'tokens' }),
  },
  {
    id: 'unity-catalog.metastores',
    label: 'Metastore configuration',
    controls: ['SCP-04-10', 'SCP-04-11', 'SCP-04-14', 'SCP-04-15', 'SCP-04-18'],
    read: (client) => client.metastores.summary(),
  },
  {
    id: 'unity-catalog.recipients',
    label: 'Delta Sharing recipients',
    controls: ['SCP-04-12', 'SCP-04-13'],
    read: (client) => firstOf(client.recipients.list({})),
  },
  {
    id: 'unity-catalog.storage-credentials',
    label: 'Storage credentials',
    controls: ['SCP-05-08'],
    read: (client) => firstOf(client.storageCredentials.list({})),
  },
  {
    id: 'unity-catalog.models',
    label: 'Registered models',
    controls: ['SCP-04-17'],
    read: (client) => firstOf(client.registeredModels.list({})),
  },
  {
    id: 'unity-catalog.external-locations',
    label: 'External locations',
    // Not yet named by any control, probed because it is the natural source for several
    // storage and network controls now answered by attestation.
    controls: [],
    read: (client) => firstOf(client.externalLocations.list({})),
  },
  {
    id: 'clusters',
    label: 'Clusters',
    controls: ['SCP-02-02', 'SCP-04-03', 'SCP-04-04', 'SCP-04-07', 'SCP-05-01'],
    read: (client) => firstOf(client.clusters.list({})),
  },
  {
    id: 'jobs',
    label: 'Jobs',
    controls: ['SCP-04-22'],
    read: (client) => firstOf(client.jobs.list({})),
  },
  {
    id: 'secrets',
    label: 'Secret scopes',
    controls: ['SCP-02-01'],
    read: (client) => firstOf(client.secrets.listScopes()),
  },
  {
    id: 'ip-access-lists',
    label: 'IP access lists',
    controls: ['SCP-03-05'],
    read: (client) => firstOf(client.ipAccessLists.list()),
  },
  {
    id: 'scim.groups',
    label: 'Groups',
    controls: ['SCP-05-03'],
    read: (client) => firstOf(client.groupsV2.list({})),
  },
  {
    id: 'global-init-scripts',
    label: 'Global init scripts',
    controls: ['SCP-05-02'],
    read: (client) => firstOf(client.globalInitScripts.list()),
  },
  {
    id: 'vector-search.endpoints',
    label: 'Vector search endpoints',
    controls: ['SCP-02-09'],
    read: (client) => firstOf(client.vectorSearchEndpoints.listEndpoints({})),
  },
  {
    id: 'sql.query-history',
    label: 'Query history',
    /**
     * No control waits on this one, and it is the only family here in that position.
     *
     * It is probed because the workload advisor does: row `33j` reads the operator plan behind a query
     * shape from `GET /api/2.0/sql/history/queries/{id}`, which is the one place a scanned table's name
     * appears at all — `system.query.history` records what a statement cost and never what it touched.
     * `sql.query-history:read` is declared for it, and declaring a scope is only half a measurement.
     * ADR 0016 found `serving.serving-endpoints:read` accepted by the registry and then honoured by
     * nothing, so a scope this app holds on paper is not a call it can make until something makes it.
     *
     * `list` rather than the get-by-id the advisor will use, because a reach probe has no statement to
     * name and the SDK exposes no get. The scope is what is being asked about, and both paths sit under
     * it; if that ever stops being true the advisor's own refusal will say so in the same words.
     */
    controls: [],
    read: (client) => client.queryHistory.list({ max_results: 1 }),
  },
  {
    id: 'workspace.settings',
    label: 'Workspace settings (typed)',
    // Distinct from workspace-conf, which is already known refused. Probed separately
    // because the typed settings API is a different path and may be scoped differently.
    controls: ['SCP-02-10', 'SCP-02-11', 'SCP-04-19', 'SCP-04-20', 'SCP-05-13', 'SCP-05-14'],
    read: (client) => client.workspaceConf.getStatus({ keys: 'enableDbfsFileBrowser' }),
  },
];

/**
 * What the token holds against what the app asked for.
 *
 * Both are needed to classify a scope refusal, and neither alone will do: carried without
 * declared cannot tell a permanent refusal from a stale consent, and declared without carried
 * cannot tell that anything is missing at all.
 */
export interface Grants {
  /** Scopes the caller's token names. Absent when the token is opaque. */
  readonly carried?: readonly string[];
  /** Scopes `app.yaml` requests. */
  readonly declared: readonly string[];
}

export async function probeReach(client: WorkspaceClient, grants?: Grants): Promise<readonly FamilyReach[]> {
  // Sequential, not parallel. Fourteen simultaneous control-plane calls from an app is
  // exactly the impolite burst the whole scheduler exists to avoid, and this runs rarely.
  const results: FamilyReach[] = [];
  for (const family of FAMILIES) {
    results.push(await probeOne(client, family, grants));
  }
  return results;
}

async function probeOne(client: WorkspaceClient, family: Family, grants?: Grants): Promise<FamilyReach> {
  const shared = { id: family.id, label: family.label, controls: family.controls };
  try {
    await family.read(client);
    return { ...shared, reach: 'readable', detail: 'The call answered.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ...shared, reach: classify(message, grants), detail: message };
  }
}

/**
 * The scope a refusal names, if it names one.
 *
 * Exported because the same sentence is what a finding has to quote when it explains why a
 * control could not be measured, and parsing it in two places would let the two disagree.
 */
export function demandedScope(message: string): string | undefined {
  return /required scopes?:\s*([A-Za-z0-9_.:-]+)/i.exec(message)?.[1];
}

/**
 * Which of the reaches a failure is, from the message.
 *
 * On the message rather than the status code because the distinctions that matter — a scope
 * never granted, a scope granted to the app but not to this user, a permission the user
 * lacks — are all 403, and only the text separates them.
 */
export function classify(message: string, grants?: Grants): Reach {
  if (/required scopes|not a valid scope|invalid scope|insufficient_scope/i.test(message)) {
    return staleConsent(message, grants) ? 'stale-consent' : 'no-scope';
  }
  if (/\b404\b|not found|does not exist|ENDPOINT_NOT_FOUND|RESOURCE_DOES_NOT_EXIST/i.test(message)) return 'absent';
  if (/permission|forbidden|not authorized|unauthorized|PERMISSION_DENIED|\b403\b/i.test(message)) return 'forbidden';
  return 'error';
}

/**
 * Whether this refusal is the temporary kind: the app asked for the scope, the token does not
 * have it, so the user's consent predates the request.
 *
 * Every uncertainty resolves to false, which reports the refusal as permanent. That is the
 * asymmetry worth being deliberate about — the two errors are not equally bad. Reporting a
 * permanent limit as stale consent sends a workspace admin to re-authorise for a scope no
 * install will ever be granted, and when nothing changes they have learnt to distrust the
 * next message too. Reporting stale consent as a permanent limit understates what the app
 * could measure, which is the same thing every other unmeasured control already says.
 */
function staleConsent(message: string, grants?: Grants): boolean {
  if (grants?.carried == null) return false;

  const demanded = demandedScope(message);
  if (demanded == null) return false;

  return grants.declared.includes(demanded) && !grants.carried.includes(demanded);
}
