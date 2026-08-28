// What the assessment is an assessment of.
//
// This started narrowed to one workspace on a real observation and a wrong
// conclusion. `system.compute.warehouses` returned 129 rows for a workspace holding
// two, and the other 127 were treated as noise. They were not noise. They were the
// rest of the customer's estate. The recorded reasoning was that a number spanning
// the account is one "no workspace admin can act on" — true of a workspace admin,
// and irrelevant, because this app's stated user is an account admin with full read.
//
// Measured on labs from one install: 11 workspaces in `system.billing.usage`, 70 in
// `system.compute.warehouses`, 10 in `system.access.audit`. Narrowing threw away a
// tenth of the evidence to serve a persona the project had already rejected.
//
// So the account is the default and narrowing is something the user asks for. What
// cannot be widened is recorded per signal as its reach, not here: `information_schema`
// stops at the metastore, and workspace settings stop at this workspace because a
// workspace token is refused by siblings. See ADR 0015.
//
// The host workspace id is still worth knowing — it identifies which workspace the
// workspace-reach signals are about, and it is what a narrowing request names. Databricks
// SQL exposes `current_metastore()` and `current_user()` but nothing for the workspace, so
// it comes from the environment where the platform provides it and otherwise from the
// `x-databricks-org-id` response header that every workspace API call carries. That route
// is reachable with the default-granted `iam.current-user:read` scope, so it costs no
// additional consent.

export interface EstateScope {
  /**
   * The workspace this app runs in, when it could be identified. Not a filter: it names
   * which workspace the workspace-reach signals describe.
   */
  readonly hostWorkspaceId?: string;
  /**
   * Set only when the user asked to assess one workspace rather than the account. Absent
   * means account reach, which is the default. Binding this narrows every statement that
   * carries a workspace_id filter.
   */
  readonly narrowedTo?: string;
  /**
   * The workspaces an assessment definition asked for, when the run was started for one.
   *
   * Not the same mechanism as `narrowedTo` and deliberately not built on it. `narrowedTo` forces every
   * signal to `reach: 'workspace'` and disables slicing, which is right for one workspace and wrong for
   * a set of them: a run of six workspaces out of forty is still an account-reach read of six, and it
   * still wants slicing. This narrows the live set the workspace filter is built from instead, so the
   * ids the statements filter to, the estate summary and the export stay one set by construction — the
   * property E1 established and the reason this is not a second filter applied somewhere else.
   *
   * Absent means the whole assessable estate, which is what an ad-hoc scan asks for. An empty list is
   * refused rather than read as either.
   */
  readonly selected?: readonly string[];
  /** Shown to the user verbatim, so what was covered reads as fact rather than as a caveat. */
  readonly description: string;
}

/** Raised when a scope cannot mean anything — an empty selection, or a blank id in one. */
export class EstateScopeError extends Error {}

const ACCOUNT_DESCRIPTION =
  'Assessed across every workspace the scanning identity can see in the system tables. ' +
  'Unity Catalog and per-table findings cover the metastore attached to this workspace, ' +
  'and workspace settings cover this workspace alone — each finding states which.';

export function accountScope(hostWorkspaceId?: string): EstateScope {
  return {
    ...(hostWorkspaceId != null && hostWorkspaceId !== '' ? { hostWorkspaceId } : {}),
    description: ACCOUNT_DESCRIPTION,
  };
}

export const ACCOUNT_SCOPE: EstateScope = accountScope();

/**
 * Narrowed to one workspace at the user's request.
 *
 * Kept because it is a legitimate thing to want — assessing one workspace before a
 * migration, or one team's workspace — but it is no longer what happens by default.
 */
export function workspaceScope(workspaceId: string): EstateScope {
  return {
    hostWorkspaceId: workspaceId,
    narrowedTo: workspaceId,
    description:
      `Narrowed to workspace ${workspaceId} because it was asked for. Resources in other ` +
      'workspaces of the same account are excluded, so scores here are not account-wide.',
  };
}

/**
 * The same reach, narrowed to the workspaces an assessment named.
 *
 * Built from an existing scope rather than from scratch so the host workspace survives. Losing it would
 * cost the region partition its home region, and the run would then report that it could not establish
 * which region it reads — of a run that had just been told exactly which workspaces to read.
 *
 * Ids are trimmed, deduplicated and sorted, for the reason `definition.ts` does the same: the scope
 * recorded on the stamp is what two runs are compared by, and `' w1'` and `'w1'` are one estate that
 * must not compare as two. A blank id is refused rather than dropped, because dropping narrows the
 * assessment while leaving the record of what was asked for unchanged.
 *
 * What this cannot do is decide whether an id names anything. A selected workspace the directory has no
 * row for is not representable in a directory partition — the collector has no row to place — so it
 * simply contributes no ids to the filter, and `resolveScope` is what reports it as unknown to the
 * author. The two answer different questions and only one of them can see the catalogue.
 */
export function selectedScope(scope: EstateScope, workspaceIds: readonly string[]): EstateScope {
  const trimmed = workspaceIds.map((id) => id.trim());
  if (trimmed.some((id) => id === '')) {
    throw new EstateScopeError('A blank workspace id is not a workspace. Remove it, or name the one that was meant.');
  }

  const selected = [...new Set(trimmed)].sort();
  if (selected.length === 0) {
    throw new EstateScopeError(
      'A scope naming no workspace would assess nothing. Name at least one, or ask for the whole estate.'
    );
  }

  return {
    ...scope,
    selected,
    description:
      `Assessed across the ${count(selected.length, 'workspace')} this assessment names, of those the ` +
      'scanning identity can see. Unity Catalog and per-table findings cover the metastore attached to ' +
      'this workspace, and workspace settings cover this workspace alone — each finding states which.',
  };
}

function count(n: number, noun: string): string {
  return `${String(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/** The host workspace id the platform provides, if the runtime supplies one. */
export function hostWorkspaceFromEnvironment(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const id = env.DATABRICKS_WORKSPACE_ID?.trim();
  return id != null && id !== '' ? id : undefined;
}

export interface ScopeProbe {
  readonly host: string;
  readonly token: string;
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * Who the token belongs to and which workspace answered.
 *
 * One call, two answers, because the current-user endpoint carries both: the username
 * in the body and the workspace id in the `x-databricks-org-id` header. A scan needs
 * both — the actor to stamp the result, the workspace to scope the queries — and making
 * two calls to learn two fields of one response would be a needless second round trip
 * on the request path.
 *
 * It is also the cheapest call that is certain to be authorised under the narrowed OBO
 * scopes, which is why the workspace id is read from here rather than from a
 * workspace-settings endpoint that would need a scope we do not request.
 */
export interface CurrentUser {
  readonly userName?: string;
  readonly workspaceId?: string;
  /**
   * The groups SCIM says this caller is in, by display name.
   *
   * Three states rather than two, and the difference decides whether a mutation is allowed:
   * absent means SCIM was not asked or did not answer, empty means it answered and the caller
   * is in nothing, and a list means what it says. `authorize/group.ts` refuses on the first two
   * for different reasons, because "we could not tell" and "you are not a member" send an admin
   * to opposite places.
   *
   * Direct memberships only. SCIM `Me` reports `type: "direct"` entries and does not expand a
   * group that contains another group, so the configured group has to hold its people itself.
   * Recorded here rather than only in the docs because it is the kind of thing that looks like a
   * bug from the outside.
   */
  readonly groups?: readonly string[];
  /**
   * What this identity calls itself, when SCIM says. For display beside the actor, never instead of it.
   *
   * It exists for one reader: a service principal's actor is an application id, and a UUID in the
   * "measured as" column of a history page is noise to everybody who did not configure it. SCIM
   * answers `waf-schedule-probe` for the same identity, which is the name the person who granted it
   * chose.
   *
   * Taken from the caller's own `Me` record rather than by looking the id up, because that is the one
   * form of this question every identity is allowed to ask. Listing service principals needs an
   * entitlement this app is not granted and should not ask for, so a lookup would make a display name
   * contingent on privilege the app does not need — and would resolve nothing on the installs that
   * refused it.
   *
   * Not the identity, and the distinction is the reason this is a separate field. A display name is
   * mutable, non-unique, and set by whoever created the principal; `actor` stays the application id
   * so that attribution a year later survives a rename. Absent whenever SCIM did not answer or the
   * record has no name, which is why every reader of it falls back to the id.
   */
  readonly displayName?: string;
}

export async function probeCurrentUser(probe: ScopeProbe): Promise<CurrentUser> {
  const doFetch = probe.fetch ?? globalThis.fetch;
  try {
    const response = await doFetch(`${probe.host.replace(/\/+$/, '')}/api/2.0/preview/scim/v2/Me`, {
      headers: { Authorization: `Bearer ${probe.token}` },
    });
    if (!response.ok) return {};

    const workspaceId = response.headers.get('x-databricks-org-id')?.trim();
    const body = (await response.json()) as { userName?: unknown; groups?: unknown; displayName?: unknown };
    const groups = groupNames(body.groups);
    const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
    return {
      ...(typeof body.userName === 'string' && body.userName !== '' ? { userName: body.userName } : {}),
      ...(workspaceId != null && workspaceId !== '' ? { workspaceId } : {}),
      ...(groups != null ? { groups } : {}),
      // Only when it adds something. SCIM echoes a person's own email here, so keeping it for
      // everybody would put the same string in the record twice and invite a reader to wonder which
      // of the two was authoritative.
      ...(displayName !== '' && displayName !== body.userName ? { displayName } : {}),
    };
  } catch {
    // Deliberately swallowed. Failing to identify the workspace or the user degrades
    // the scope and the attribution; it does not prevent the assessment, and a scan
    // that refused to start over one missing header would be worse than one that says
    // what it covered.
    return {};
  }
}

/**
 * The `display` of each group in a SCIM `Me` response, or nothing if there was no list.
 *
 * Nothing rather than an empty list when the field is missing, because an absent `groups`
 * attribute is SCIM declining to say and an empty one is SCIM saying "none" — and the gate
 * treats those differently. An entry without a usable display is dropped rather than kept as a
 * blank: the only thing a caller can do with a group is name it, so a group with no name cannot
 * be the one that was configured.
 */
function groupNames(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .map((entry) => (entry as { display?: unknown } | null)?.display)
    .filter((display): display is string => typeof display === 'string' && display.trim() !== '')
    .map((display) => display.trim());
}

/**
 * Resolves the scope, preferring the environment and falling back to the probe.
 *
 * The environment wins because the platform's own value cannot be wrong, and reading it
 * costs nothing. Either way the result is account reach: identifying the host workspace
 * says which workspace we are running in, not which workspace to restrict the answer to.
 */
export async function resolveEstateScope(probe: ScopeProbe, env?: NodeJS.ProcessEnv): Promise<EstateScope> {
  const fromEnv = hostWorkspaceFromEnvironment(env);
  if (fromEnv != null) return accountScope(fromEnv);

  const { workspaceId } = await probeCurrentUser(probe);
  return accountScope(workspaceId);
}

/** Scope from an already-probed identity, so the request path probes only once. */
export function scopeFromProbe(user: CurrentUser, env?: NodeJS.ProcessEnv): EstateScope {
  return accountScope(hostWorkspaceFromEnvironment(env) ?? user.workspaceId);
}
