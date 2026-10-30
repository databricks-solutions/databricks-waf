// What the REST probes return, in the app's terms rather than the SDK's.
//
// Narrowed deliberately at the boundary: the SDK's response types carry dozens of
// fields, and a resolver that reached into them would couple a control's logic to an
// SDK version. These shapes carry what the controls read and nothing else, so an SDK
// upgrade breaks one file rather than fifteen.

/** Workspace settings as `workspace-conf` reports them. */
export interface WorkspaceSettings {
  /**
   * Every requested key, present whether or not the workspace has set it.
   *
   * `null` distinguishes "never set" from "set to false", which is the distinction the
   * whole settings table exists to preserve. Absent from the map entirely means the
   * endpoint did not return the key at all — which happens for keys a workspace's cloud
   * or tier does not have — and is reported differently again.
   */
  readonly values: ReadonlyMap<string, string | null>;
  /** Keys asked for that the endpoint did not answer, so absence is not read as null. */
  readonly unanswered: readonly string[];
}

/** A workspace personal access token, as token management reports it. */
export interface TokenRecord {
  readonly id: string;
  readonly createdBy: string | undefined;
  readonly comment: string | undefined;
  readonly createdAt: Date | undefined;
  /** Undefined means the token never expires, which is the finding rather than a gap in the data. */
  readonly expiresAt: Date | undefined;
}

export interface TokenInventory {
  readonly tokens: readonly TokenRecord[];
  /** True when the listing stopped at its cap, so counts are floors rather than totals. */
  readonly truncated: boolean;
}

/** A model serving endpoint, reduced to what the two security controls read. */
export interface ServingEndpointRecord {
  readonly name: string;
  readonly servedExternalModel: boolean;
  /** Undefined when the endpoint reports no state, rather than being assumed ready. */
  readonly state: string | undefined;
}

export interface ServingInventory {
  readonly endpoints: readonly ServingEndpointRecord[];
  readonly truncated: boolean;
}

export interface VectorSearchEndpointRecord {
  readonly name: string;
  /** `STANDARD` or `STORAGE_OPTIMIZED` today. Undefined when the endpoint does not report one. */
  readonly type: string | undefined;
  /** Undefined when the endpoint reports no state, rather than being assumed ready. */
  readonly state: string | undefined;
}

export interface VectorSearchInventory {
  readonly endpoints: readonly VectorSearchEndpointRecord[];
  readonly truncated: boolean;
}

// --------------------------------------------------------------------------- admin-collected shapes
//
// The shapes below are not produced by the app's own REST probes — they are only ever
// revived from admin-collected imports. They live here so that resolver tests import from
// the same place as everything else, and so a future probe that reads one of these APIs
// directly can reuse the shape without a second definition drifting from the first.

/** One log delivery configuration as the account API reports it. */
export interface LogDeliveryConfigRecord {
  readonly configId: string;
  readonly configName: string | undefined;
  /** The log type: 'AUDIT_LOGS' or 'BILLABLE_USAGE'. */
  readonly logType: string | undefined;
  readonly outputFormat: string | undefined;
  /** 'ENABLED' or 'DISABLED'. */
  readonly status: string | undefined;
  /**
   * How many workspace IDs the filter covers. Zero means the configuration applies to
   * every workspace in the account, which is what most installations want.
   */
  readonly workspaceFilterCount: number | undefined;
}

export interface LogDeliveryInventory {
  readonly configs: readonly LogDeliveryConfigRecord[];
  readonly truncated: boolean;
}

/** A single IP access list entry, from both workspace and account endpoints. */
export interface IpAccessListRecord {
  readonly label: string | undefined;
  /** 'ALLOW' or 'BLOCK'. An absent ALLOW list means any IP may reach the endpoint. */
  readonly listType: string | undefined;
  readonly enabled: boolean | undefined;
  /** The number of IP addresses or CIDR blocks in the list. */
  readonly ipAddressCount: number | undefined;
}

export interface IpAccessListInventory {
  readonly lists: readonly IpAccessListRecord[];
  readonly truncated: boolean;
}

/**
 * A typed settings endpoint response captured via the script's shallow projection.
 *
 * `shallow` keeps every scalar within two levels, keyed as the API spelled them and
 * stored verbatim. Revivers hand this through without interpretation; each resolver
 * knows which nested key its control turns on.
 */
export interface TypedSettingValue {
  readonly data: Readonly<Record<string, unknown>>;
}

/** A secret scope, from the scopes-list endpoint. */
export interface SecretScopeRecord {
  readonly name: string;
  /** 'DATABRICKS' or 'AZURE_KEYVAULT'. */
  readonly backendType: string | undefined;
}

export interface SecretScopeInventory {
  readonly scopes: readonly SecretScopeRecord[];
  readonly truncated: boolean;
}

/** A cluster as reported by the REST clusters-list endpoint. */
export interface AdminClusterRecord {
  readonly clusterId: string;
  readonly clusterName: string | undefined;
  readonly state: string | undefined;
  readonly clusterSource: string | undefined;
  readonly sparkVersion: string | undefined;
  readonly dataSecurityMode: string | undefined;
  readonly autoterminationMinutes: number | undefined;
  /**
   * Whether local disk encryption is on. Absent means the cluster predates the field or
   * did not return it; false is the actionable finding.
   */
  readonly enableLocalDiskEncryption: boolean | undefined;
  /** When the cluster was started, as an epoch timestamp. */
  readonly startTime: Date | undefined;
  /**
   * When the cluster was last restarted, used to detect long-running clusters.
   *
   * Absent either means the cluster has never been restarted since creation (use
   * `startTime` instead) or that the field was not returned.
   */
  readonly lastRestartedTime: Date | undefined;
  /** Key names of spark environment variables, without their values. */
  readonly sparkEnvVarKeys: readonly string[] | undefined;
  readonly initScriptCount: number | undefined;
}

export interface AdminClusterInventory {
  readonly clusters: readonly AdminClusterRecord[];
  readonly truncated: boolean;
}

/** One entry in the token-creation ACL from the permissions API. */
export interface TokenPermissionEntry {
  readonly userName: string | undefined;
  readonly groupName: string | undefined;
  readonly servicePrincipalName: string | undefined;
  readonly permissionLevels: readonly string[];
}

/**
 * Who may create personal access tokens.
 *
 * The violation the corresponding control looks for is the `users` group appearing with
 * any permission level, which means every workspace member can create tokens.
 */
export interface TokenPermissions {
  readonly entries: readonly TokenPermissionEntry[];
}
