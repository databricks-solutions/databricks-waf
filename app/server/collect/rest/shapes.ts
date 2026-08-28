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
