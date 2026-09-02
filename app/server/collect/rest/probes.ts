// One probe per signal: which call to make, and what to say when it is refused.
//
// A table rather than a method each, because every probe is the same three lines around
// a different SDK call, and the interesting per-probe information is not the call — it is
// the scope it needs and the sentence that explains a refusal. Those live next to each
// other here so a new probe cannot be added without stating both.

import type { WorkspaceClient } from '@databricks/sdk-experimental';
import type { SignalId } from '../signal.js';
import { REQUESTED_KEYS } from './settings-keys.js';
import type {
  ServingEndpointRecord,
  ServingInventory,
  TokenInventory,
  TokenRecord,
  VectorSearchEndpointRecord,
  VectorSearchInventory,
  WorkspaceSettings,
} from './shapes.js';

export interface ProbeOptions {
  readonly pageLimit: number;
}

export interface Probe {
  /** Catalogue signal id. The prefix is the surface, so it must start with `rest:`. */
  readonly id: SignalId;
  /** Short label for the scheduler's log and the scan footprint. */
  readonly label: string;
  /** What was being read, as a sentence subject: "…was refused". */
  readonly what: string;
  /**
   * The endpoint the call lands on.
   *
   * Here so the requirements page can name what this app will contact rather than
   * describe it. An admin deciding whether to install is deciding about specific
   * endpoints, and "the workspace security settings" is not something they can check
   * against an audit log or an IP allowlist. Written as the SDK's own path, so it matches
   * what appears in `system.access.audit` afterwards.
   */
  readonly endpoint: string;
  /**
   * Who inside the workspace may read it, independently of the scope question.
   *
   * The two refusals are unrelated and both real: a scope the app does not hold stops the
   * call before the workspace sees it, and a user without the permission is refused after
   * it does. A page listing only scopes would tell an admin the install is fine and leave
   * them wondering why every result came back unmeasured for their non-admin users.
   */
  readonly permission: string;
  /**
   * The OAuth scope this call needs, as the platform names it when refusing.
   *
   * Taken from the refusals themselves rather than guessed: a live scan against a
   * workspace produced "does not have required scopes: settings" and "…: authentication".
   * Recorded because a scope refusal is not fixable inside the workspace — see
   * `collector.ts`.
   */
  readonly scope: string;
  /**
   * Whether an app can be granted that scope at all.
   *
   * False for most of the security surface, and that changes what the reader should do:
   * a grantable scope missing from an install is a configuration gap, while an
   * ungrantable one is a platform limit no redeploy will fix. ADR 0016.
   */
  readonly grantable: boolean;
  run(client: WorkspaceClient, options: ProbeOptions): Promise<unknown>;
}

const workspaceConf: Probe = {
  id: 'rest:workspace:preview.workspace-conf',
  label: 'workspace-conf',
  what: 'The workspace security settings',
  endpoint: 'GET /api/2.0/workspace-conf',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  async run(client): Promise<WorkspaceSettings> {
    // One call for every key, which is why fifteen controls cost one probe. The API
    // takes them comma-separated and answers with an object holding one entry per key it
    // recognises.
    const answer = (await client.workspaceConf.getStatus({ keys: REQUESTED_KEYS.join(',') })) as Record<
      string,
      unknown
    >;

    const values = new Map<string, string | null>();
    const unanswered: string[] = [];
    for (const key of REQUESTED_KEYS) {
      if (!(key in answer)) {
        unanswered.push(key);
        continue;
      }
      values.set(key, asSettingValue(answer[key]));
    }

    return { values, unanswered };
  },
};

const tokens: Probe = {
  id: 'rest:workspace:token.list',
  label: 'token-management',
  what: 'The workspace personal access tokens',
  endpoint: 'GET /api/2.0/token-management/tokens',
  permission: 'workspace admin',
  scope: 'authentication',
  grantable: false,
  async run(client, options): Promise<TokenInventory> {
    const tokens: TokenRecord[] = [];
    let truncated = false;

    for await (const token of client.tokenManagement.list({})) {
      if (tokens.length >= options.pageLimit) {
        truncated = true;
        break;
      }
      tokens.push({
        id: String(token.token_id ?? ''),
        createdBy: token.created_by_username,
        comment: token.comment,
        createdAt: asDate(token.creation_time),
        // A missing expiry is not missing data: the API omits it for a token that never
        // expires, which is precisely what two of these controls are looking for.
        expiresAt: asDate(token.expiry_time),
      });
    }

    return { tokens, truncated };
  },
};

const servingEndpoints: Probe = {
  id: 'rest:workspace:serving-endpoints',
  label: 'serving-endpoints',
  what: 'The model serving endpoints',
  endpoint: 'GET /api/2.0/serving-endpoints',
  permission: 'CAN VIEW on the endpoint, which every workspace user holds for endpoints they can see',
  scope: 'model-serving',
  grantable: true,
  async run(client, options): Promise<ServingInventory> {
    const endpoints: ServingEndpointRecord[] = [];
    let truncated = false;

    for await (const endpoint of client.servingEndpoints.list()) {
      if (endpoints.length >= options.pageLimit) {
        truncated = true;
        break;
      }
      const served = endpoint.config?.served_entities ?? [];
      endpoints.push({
        name: endpoint.name ?? '(unnamed)',
        servedExternalModel: served.some((entity) => entity.external_model != null),
        state: endpoint.state?.ready,
      });
    }

    return { endpoints, truncated };
  },
};

/*
 * Vector search endpoints.
 *
 * The second grantable scope in the security pillar, and it was found by measurement rather than
 * by reading: the reach probe tried fourteen API families against a real install's token and
 * `vector-search` was the one refusal whose scope the Apps registry turns out to accept. Nine
 * sibling scopes are refused by name. ADR 0016.
 *
 * Worth one control on its own terms — an embedding store outside Unity Catalog is data governed
 * by nothing — and worth more than one control as a demonstration: the pillar's coverage is
 * limited by which scopes the platform offers, so a scope becoming available is a coverage
 * increase, and the way to find out is to ask.
 */
const vectorSearchEndpoints: Probe = {
  id: 'rest:workspace:vector-search.endpoints',
  label: 'vector-search-endpoints',
  what: 'The vector search endpoints',
  endpoint: 'GET /api/2.0/vector-search/endpoints',
  permission: 'CAN USE on the endpoint, which every workspace user holds for endpoints they can see',
  scope: 'vector-search',
  grantable: true,
  async run(client, options): Promise<VectorSearchInventory> {
    const endpoints: VectorSearchEndpointRecord[] = [];
    let truncated = false;

    for await (const endpoint of client.vectorSearchEndpoints.listEndpoints({})) {
      if (endpoints.length >= options.pageLimit) {
        truncated = true;
        break;
      }
      endpoints.push({
        name: endpoint.name ?? '(unnamed)',
        type: endpoint.endpoint_type,
        state: endpoint.endpoint_status?.state,
      });
    }

    return { endpoints, truncated };
  },
};

// --------------------------------------------------------------------------- admin-only probes
//
// These signals are only ever available through admin-imported evidence: the scopes they
// require are ungrantable by Apps, and three of them reach the account plane which a
// workspace token cannot cross. Their `run()` throws immediately so the RestCollector
// returns unmeasurable when it attempts them live, and an import can replace that result.
//
// They are in PROBES so that restDescriptors() generates entries for them (keeping the
// requirements page complete) and so the tests that compare "signals descriptors exist for"
// against "signals collectors produce" remain consistent.

/** SCP-04-02: audit log delivery configurations. Account plane. */
const logDelivery: Probe = {
  id: 'rest:account:accounts.log-delivery',
  label: 'account-log-delivery',
  what: 'The account log delivery configurations',
  endpoint: 'GET /api/2.0/accounts/{account_id}/log-delivery',
  permission: 'account admin',
  scope: 'account',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-03-08, SCP-03-12: IP access lists for the account console. Account plane. */
const accountIpAccessLists: Probe = {
  id: 'rest:account:accounts.{account_id}.ip-access-lists',
  label: 'account-ip-access-lists',
  what: 'The account console IP access lists',
  endpoint: 'GET /api/2.0/accounts/{account_id}/ip-access-lists',
  permission: 'account admin',
  scope: 'account',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-03-05: IP access lists for workspace ingress. Scope not grantable. */
const workspaceIpAccessLists: Probe = {
  id: 'rest:workspace:ip-access-lists',
  label: 'ip-access-lists',
  what: 'The workspace IP access lists',
  endpoint: 'GET /api/2.0/ip-access-lists',
  permission: 'workspace admin',
  scope: 'networking',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "networking" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-04-21: disable legacy features for new workspaces. Account plane. */
const disableLegacyFeatures: Probe = {
  id: 'rest:account:accounts.settings.types.disable_legacy_features.names.default',
  label: 'account-setting-disable-legacy-features',
  what: 'The account-level disable-legacy-features setting',
  endpoint: 'GET /api/2.0/accounts/{account_id}/settings/types/disable_legacy_features/names/default',
  permission: 'account admin',
  scope: 'account',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-02-01: credentials held in secret scopes. Scope not grantable. */
const secretScopes: Probe = {
  id: 'rest:workspace:secrets.scopes.list',
  label: 'secret-scopes',
  what: 'The workspace secret scopes',
  endpoint: 'GET /api/2.0/secrets/scopes/list',
  permission: 'workspace admin',
  scope: 'secrets',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "secrets" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-02-02, SCP-04-03: cluster disk encryption and long-running clusters. Scope not grantable. */
const adminClusters: Probe = {
  id: 'rest:workspace:clusters.list',
  label: 'clusters',
  what: 'The workspace clusters',
  endpoint: 'GET /api/2.0/clusters/list',
  permission: 'workspace admin',
  scope: 'clusters',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "clusters" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-01-06: PAT token creation restricted to admins. Scope not grantable. */
const tokenPermissions: Probe = {
  id: 'rest:workspace:permissions.authorization.tokens',
  label: 'token-permissions',
  what: 'The workspace token creation permissions',
  endpoint: 'GET /api/2.0/permissions/authorization/tokens',
  permission: 'workspace admin',
  scope: 'all-apis',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "all-apis" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-02-10: legacy DBFS root access disabled. Scope not grantable. */
const disableLegacyDbfs: Probe = {
  id: 'rest:workspace:settings.types.disable_legacy_dbfs.names.default',
  label: 'setting-disable-legacy-dbfs',
  what: 'The workspace disable-legacy-DBFS setting',
  endpoint: 'GET /api/2.0/settings/types/disable_legacy_dbfs/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-02-11: SQL warehouse results download disabled. Scope not grantable. */
const sqlResultsDownload: Probe = {
  id: 'rest:workspace:settings.types.sql_results_download.names.default',
  label: 'setting-sql-results-download',
  what: 'The workspace SQL-results-download setting',
  endpoint: 'GET /api/2.0/settings/types/sql_results_download/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-04-19: workspace admin restrictions enabled. Scope not grantable. */
const restrictWorkspaceAdmins: Probe = {
  id: 'rest:workspace:settings.types.restrict_workspace_admins.names.default',
  label: 'setting-restrict-workspace-admins',
  what: 'The workspace restrict-workspace-admins setting',
  endpoint: 'GET /api/2.0/settings/types/restrict_workspace_admins/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-04-20: automatic cluster update enabled. Scope not grantable. */
const automaticClusterUpdate: Probe = {
  id: 'rest:workspace:settings.types.automatic_cluster_update.names.default',
  label: 'setting-automatic-cluster-update',
  what: 'The workspace automatic-cluster-update setting',
  endpoint: 'GET /api/2.0/settings/types/automatic_cluster_update/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-05-13: compliance security profile enabled on this workspace. Scope not grantable. */
const complianceSecurityProfileWs: Probe = {
  id: 'rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default',
  label: 'setting-compliance-security-profile',
  what: 'The workspace compliance security profile setting',
  endpoint: 'GET /api/2.0/settings/types/shield_csp_enablement_ws_db/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-05-14: enhanced security monitoring enabled. Scope not grantable. */
const enhancedSecurityMonitoring: Probe = {
  id: 'rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default',
  label: 'setting-enhanced-security-monitoring',
  what: 'The workspace enhanced-security-monitoring setting',
  endpoint: 'GET /api/2.0/settings/types/shield_esm_enablement_ws_db/names/default',
  permission: 'workspace admin',
  scope: 'settings',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('The "settings" scope is not grantable to apps. Import admin-collected evidence to populate this signal.'));
  },
};

/** SCP-05-11: compliance security profile enforced at account level. Account plane. */
const complianceSecurityProfileAc: Probe = {
  id: 'rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default',
  label: 'account-setting-compliance-security-profile',
  what: 'The account compliance security profile setting',
  endpoint: 'GET /api/2.0/accounts/{account_id}/settings/types/shield_csp_enablement_ac/names/default',
  permission: 'account admin',
  scope: 'account',
  grantable: false,
  run(): Promise<never> {
    return Promise.reject(new Error('Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal.'));
  },
};

export const PROBES: readonly Probe[] = [
  workspaceConf,
  tokens,
  servingEndpoints,
  vectorSearchEndpoints,
  // Admin-only: always unmeasurable live; import fills the gap.
  logDelivery,
  accountIpAccessLists,
  workspaceIpAccessLists,
  disableLegacyFeatures,
  secretScopes,
  adminClusters,
  tokenPermissions,
  disableLegacyDbfs,
  sqlResultsDownload,
  restrictWorkspaceAdmins,
  automaticClusterUpdate,
  complianceSecurityProfileWs,
  enhancedSecurityMonitoring,
  complianceSecurityProfileAc,
];

/**
 * A settings value as a string, or null for one the workspace has never set.
 *
 * The endpoint documents string values and sends them, but the field is untyped, so an
 * object arriving here would stringify to `[object Object]` and be compared against
 * `'true'` forever. Anything that is not a string or a number is treated as unset, which
 * routes it through the same explicit reasoning as a genuinely unset value rather than
 * silently failing the control.
 */
/**
 * Exported so the evidence importer coerces exactly as this does.
 *
 * The whole basis on which a resolver may read an imported reading is that it is indistinguishable
 * from a collected one. Two copies of this coercion would be one refactor away from disagreeing about
 * whether `false` means the string or the boolean, and the resolver reading the value would have no
 * way to tell which of them produced it.
 */
export function asSettingValue(raw: unknown): string | null {
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
  return null;
}

/** Epoch milliseconds as the control plane reports them, or undefined for absent and zero. */
export function asDate(value: number | undefined): Date | undefined {
  // Zero is used for "no expiry" as well as absent, and a token created at the epoch is
  // not a thing. Treated as absent so it is not reported as expiring in 1970.
  if (value == null || value === 0) return undefined;
  return new Date(value);
}
