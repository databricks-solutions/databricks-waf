//#region server/collect/estate-scope.ts
/** Raised when a scope cannot mean anything — an empty selection, or a blank id in one. */
var EstateScopeError = class extends Error {};
const ACCOUNT_DESCRIPTION = "Assessed across every workspace the scanning identity can see in the system tables. Unity Catalog and per-table findings cover the metastore attached to this workspace, and workspace settings cover this workspace alone — each finding states which.";
function accountScope(hostWorkspaceId) {
	return {
		...hostWorkspaceId != null && hostWorkspaceId !== "" ? { hostWorkspaceId } : {},
		description: ACCOUNT_DESCRIPTION
	};
}
accountScope();
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
function selectedScope(scope, workspaceIds) {
	const trimmed = workspaceIds.map((id) => id.trim());
	if (trimmed.some((id) => id === "")) throw new EstateScopeError("A blank workspace id is not a workspace. Remove it, or name the one that was meant.");
	const selected = [...new Set(trimmed)].sort();
	if (selected.length === 0) throw new EstateScopeError("A scope naming no workspace would assess nothing. Name at least one, or ask for the whole estate.");
	return {
		...scope,
		selected,
		description: `Assessed across the ${count(selected.length, "workspace")} this assessment names, of those the scanning identity can see. Unity Catalog and per-table findings cover the metastore attached to this workspace, and workspace settings cover this workspace alone — each finding states which.`
	};
}
function count(n, noun) {
	return `${String(n)} ${noun}${n === 1 ? "" : "s"}`;
}
/** The host workspace id the platform provides, if the runtime supplies one. */
function hostWorkspaceFromEnvironment(env = process.env) {
	const id = env.DATABRICKS_WORKSPACE_ID?.trim();
	return id != null && id !== "" ? id : void 0;
}
async function probeCurrentUser(probe) {
	const doFetch = probe.fetch ?? globalThis.fetch;
	try {
		const response = await doFetch(`${probe.host.replace(/\/+$/, "")}/api/2.0/preview/scim/v2/Me`, { headers: { Authorization: `Bearer ${probe.token}` } });
		if (!response.ok) return {};
		const workspaceId = response.headers.get("x-databricks-org-id")?.trim();
		const body = await response.json();
		const groups = groupNames(body.groups);
		const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
		return {
			...typeof body.userName === "string" && body.userName !== "" ? { userName: body.userName } : {},
			...workspaceId != null && workspaceId !== "" ? { workspaceId } : {},
			...groups != null ? { groups } : {},
			...displayName !== "" && displayName !== body.userName ? { displayName } : {}
		};
	} catch {
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
function groupNames(raw) {
	if (!Array.isArray(raw)) return void 0;
	return raw.map((entry) => entry?.display).filter((display) => typeof display === "string" && display.trim() !== "").map((display) => display.trim());
}
/** Scope from an already-probed identity, so the request path probes only once. */
function scopeFromProbe(user, env) {
	return accountScope(hostWorkspaceFromEnvironment(env) ?? user.workspaceId);
}
//#endregion
export { EstateScopeError, accountScope, hostWorkspaceFromEnvironment, probeCurrentUser, scopeFromProbe, selectedScope };
