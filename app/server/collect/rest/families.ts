// Which control-plane API families an app install can reach, measured rather than assumed.
//
// This table exists to stop the assessment telling a lie it was telling. 37 requirements name a
// control-plane endpoint and have no automated check, and the app reported every one of them as
// "an automated check is planned but not implemented yet". For most of them that is false and
// flattering in the wrong direction: the check is not missing through neglect, it is missing
// because Databricks Apps does not offer an app the authority to make the call, and no amount of
// work on this app will change that. A reader chasing the roadmap for 37 checks that are not
// coming has been misled by a default string.
//
// So each family records the scope its endpoints demand and whether an app may hold it. The facts
// come from ADR 0016, which probed all 56 scopes the workspace OAuth server publishes against the
// Apps scope registry, and then re-checked the conclusion against a real install's token because
// the registry accepts names the token minter does not honour. Nothing here is inferred from
// documentation.
//
// The consequence is a fork in how a control reports:
//
//   grantable   — the app could ask for this. An unbuilt check here is genuinely unbuilt, and
//                 saying so is accurate.
//   ungrantable — no install can be authorised. The requirement is answered by a person, and the
//                 finding says which scope is missing so the claim can be checked rather than
//                 taken on trust.
//
// Kept beside the probes rather than in the catalogue because it describes this platform's
// authorisation model, not the requirement. The same requirement assessed by a tool running as an
// admin would be perfectly measurable, and the catalogue is meant to outlive the way this
// particular app is allowed to read things.

/** How a family is reached, which decides whether a workspace token can reach it at all. */
export type Plane =
  /** The workspace control plane. Reachable with the forwarded user token, if the scope allows. */
  | 'workspace'
  /**
   * The account control plane.
   *
   * Unreachable by construction, whatever the scope: measured under ADR 0016, a workspace token
   * sent to an account endpoint is rejected with `Unable to load OAuth Config` before
   * authorisation is considered. So account-plane families are ungrantable for a reason that has
   * nothing to do with scopes, and the finding has to say so — telling an admin to widen a scope
   * that would not help is worse than telling them nothing.
   */
  | 'account';

export interface ApiFamily {
  /**
   * Prefix of the catalogue's `collector` value, without the surface.
   *
   * Matched as a prefix so one entry covers a family's endpoints — `unity-catalog.metastores` and
   * `unity-catalog.metastore_summary` are one authorisation question — and so a control naming a
   * more specific path than this table knows about is still classified.
   */
  readonly prefix: string;
  readonly label: string;
  readonly plane: Plane;
  /** The scope the platform names when it refuses, in its own words. */
  readonly scope: string;
  /** Whether the Apps scope registry accepts that name. False means no install, ever. */
  readonly grantable: boolean;
  /**
   * How `grantable` was established, because the two ways are not equally strong.
   *
   * `endpoint` means the call was made from a real install and the platform's refusal named the
   * scope. `registry` means only the scope name was tested against the Apps registry, which
   * rejected it — conclusive about whether an app may ask, and an inference about the endpoint.
   *
   * Recorded rather than flattened because ADR 0016 found the two can disagree in the other
   * direction: `serving.serving-endpoints:read` was accepted by the registry and granted nothing.
   * A future ADR finding the reverse should be able to see which claims rest on which evidence
   * without re-probing all of them.
   */
  readonly measuredBy: 'endpoint' | 'registry';
}

/**
 * Longest prefix wins, so order here is irrelevant and specificity is what decides.
 *
 * Every `grantable: false` entry was refused by name against the registry, and every one whose
 * controls this app now measures — `serving-endpoints`, `vector-search.endpoints` — was confirmed
 * to work against a live install's minted token rather than merely to validate. The distinction
 * cost a day: `serving.serving-endpoints:read` passes validation and grants nothing.
 */
export const API_FAMILIES: readonly ApiFamily[] = [
  // Reachable, and read today.
  {
    prefix: 'serving-endpoints',
    label: 'Model serving endpoints',
    plane: 'workspace',
    scope: 'model-serving',
    grantable: true,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'vector-search',
    label: 'Vector search endpoints',
    plane: 'workspace',
    scope: 'vector-search',
    grantable: true,
    measuredBy: 'endpoint',
  },

  // Workspace plane, refused by name. Each was rejected by the Apps scope registry, so an install
  // cannot request it however it is deployed; `measuredBy` says which of those refusals was also
  // seen from the endpoint itself.
  {
    prefix: 'preview.workspace-conf',
    label: 'Workspace security settings',
    plane: 'workspace',
    scope: 'settings',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'settings',
    label: 'Workspace settings (typed API)',
    plane: 'workspace',
    // A different path from workspace-conf and probed separately in case it was scoped
    // differently. It is not.
    scope: 'settings',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'token',
    label: 'Personal access tokens',
    plane: 'workspace',
    scope: 'authentication',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'clusters',
    label: 'Clusters',
    plane: 'workspace',
    scope: 'clusters',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'libraries',
    label: 'Cluster libraries',
    plane: 'workspace',
    // Part of the clusters package: the library endpoints are addressed per cluster and refuse
    // with the same scope name.
    scope: 'clusters',
    grantable: false,
    measuredBy: 'endpoint',
  },
  { prefix: 'jobs', label: 'Jobs', plane: 'workspace', scope: 'jobs', grantable: false, measuredBy: 'endpoint' },
  {
    prefix: 'secrets',
    label: 'Secret scopes',
    plane: 'workspace',
    scope: 'secrets',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'ip-access-lists',
    label: 'IP access lists',
    plane: 'workspace',
    scope: 'networking',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'preview.scim',
    label: 'Users and groups',
    plane: 'workspace',
    scope: 'scim',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'global-init-scripts',
    label: 'Global init scripts',
    plane: 'workspace',
    scope: 'global-init-scripts',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'unity-catalog',
    label: 'Unity Catalog administration',
    plane: 'workspace',
    // Metastores, storage credentials, registered models, external locations, UC grants and
    // artifact allowlists all refused with this one name. The catalog reads this app does hold —
    // `catalog.catalogs:read` and its siblings — cover information_schema and nothing
    // administrative.
    scope: 'unity-catalog',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    // Longer than the entry above, so it wins for the two recipient controls and leaves the rest of
    // Unity Catalog alone. Worth the extra entry only because the scope name differs: Delta Sharing
    // is its own package, and a finding that told an admin to ask for `unity-catalog` when the
    // refusal said `sharing` would send the platform team looking for the wrong gap.
    prefix: 'unity-catalog.recipients',
    label: 'Delta Sharing recipients',
    plane: 'workspace',
    scope: 'sharing',
    grantable: false,
    measuredBy: 'endpoint',
  },
  {
    prefix: 'dbfs',
    label: 'DBFS',
    plane: 'workspace',
    // Not the `files` scope, which the registry does accept: that covers the Files API over Unity
    // Catalog volumes, and the legacy DBFS paths these controls inspect are not volumes.
    scope: 'dbfs',
    grantable: false,
    measuredBy: 'registry',
  },
  {
    prefix: 'permissions',
    label: 'Object permissions',
    plane: 'workspace',
    /*
     * The one that surprised us, and the reason this column exists separately from the registry's
     * accept list.
     *
     * `iam.access-control:read` is declared, effective, and carried by the token — and the
     * permissions endpoints refuse anyway, demanding `all-apis`. A package-granularity scope will
     * not open them. So these controls are unreachable for a different reason from the rest: not
     * "the scope is not offered" but "the only scope that works is the one that means everything",
     * which an app has no business holding.
     */
    scope: 'all-apis',
    grantable: false,
    measuredBy: 'endpoint',
  },

  {
    prefix: 'accounts',
    label: 'Account configuration',
    plane: 'account',
    // Reached from a workspace collector rather than an account one in one case (SCP-03-06, which
    // reads the workspace's own network configuration from the workspaces endpoint). Same
    // authority either way: it is account-plane data.
    scope: 'account',
    grantable: false,
    measuredBy: 'endpoint',
  },
];

/**
 * The account plane, which no workspace token reaches whatever it is scoped for.
 *
 * Returned for every `rest:account:` collector regardless of path, because the refusal happens
 * before the path is considered — the token is rejected while its OAuth config is being loaded. A
 * per-endpoint table for the account plane would imply the endpoints differ, and they do not.
 */
const ACCOUNT_PLANE: ApiFamily = {
  prefix: '',
  label: 'Account configuration',
  plane: 'account',
  scope: 'account',
  grantable: false,
  measuredBy: 'endpoint',
};

/**
 * The family a catalogue collector belongs to, or nothing if this table does not know it.
 *
 * Nothing is a real answer rather than a failure. An unknown collector reports as an unbuilt check,
 * which is the conservative claim: it says the app has not done the work rather than asserting a
 * platform limit that was never measured. Overclaiming in the other direction would let a genuine
 * gap hide behind "the platform won't let us".
 */
export function familyOf(collector: string | undefined): ApiFamily | undefined {
  const rest = restParts(collector);
  if (rest == null) return undefined;
  if (rest.plane === 'account') return ACCOUNT_PLANE;

  let best: ApiFamily | undefined;
  for (const family of API_FAMILIES) {
    if (family.prefix === '' || !rest.path.startsWith(family.prefix)) continue;
    if (best == null || family.prefix.length > best.prefix.length) best = family;
  }
  return best;
}

/**
 * Whether no install of this app could read what a control needs.
 *
 * True for an ungrantable scope and for the account plane, which are different facts with the same
 * consequence: the requirement has to be answered by a person. Both are named in the reason the
 * finding carries, because "we cannot read this" is only credible if it says why.
 */
export function beyondAnyApp(collector: string | undefined): boolean {
  const family = familyOf(collector);
  return family != null && !family.grantable;
}

/**
 * A `rest:<plane>:<path>` collector split into its plane and path, or nothing for another surface.
 *
 * A collector naming a system table or a DESCRIBE is not a control-plane question at all, so it
 * has no family and no scope. Returning nothing rather than guessing keeps the two apart.
 */
function restParts(collector: string | undefined): { plane: string; path: string } | undefined {
  if (collector == null) return undefined;
  const parts = collector.split(':');
  if (parts.length < 3 || parts[0] !== 'rest') return undefined;
  return { plane: parts[1] ?? '', path: parts.slice(2).join(':') };
}
