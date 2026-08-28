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

export const PROBES: readonly Probe[] = [workspaceConf, tokens, servingEndpoints, vectorSearchEndpoints];

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
