//#region server/collect/rest/families.ts
/**
* Longest prefix wins, so order here is irrelevant and specificity is what decides.
*
* Every `grantable: false` entry was refused by name against the registry, and every one whose
* controls this app now measures — `serving-endpoints`, `vector-search.endpoints` — was confirmed
* to work against a live install's minted token rather than merely to validate. The distinction
* cost a day: `serving.serving-endpoints:read` passes validation and grants nothing.
*/
const API_FAMILIES = [
	{
		prefix: "serving-endpoints",
		label: "Model serving endpoints",
		plane: "workspace",
		scope: "model-serving",
		grantable: true,
		measuredBy: "endpoint"
	},
	{
		prefix: "vector-search",
		label: "Vector search endpoints",
		plane: "workspace",
		scope: "vector-search",
		grantable: true,
		measuredBy: "endpoint"
	},
	{
		prefix: "preview.workspace-conf",
		label: "Workspace security settings",
		plane: "workspace",
		scope: "settings",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "settings",
		label: "Workspace settings (typed API)",
		plane: "workspace",
		scope: "settings",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "token",
		label: "Personal access tokens",
		plane: "workspace",
		scope: "authentication",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "clusters",
		label: "Clusters",
		plane: "workspace",
		scope: "clusters",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "libraries",
		label: "Cluster libraries",
		plane: "workspace",
		scope: "clusters",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "jobs",
		label: "Jobs",
		plane: "workspace",
		scope: "jobs",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "secrets",
		label: "Secret scopes",
		plane: "workspace",
		scope: "secrets",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "ip-access-lists",
		label: "IP access lists",
		plane: "workspace",
		scope: "networking",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "preview.scim",
		label: "Users and groups",
		plane: "workspace",
		scope: "scim",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "global-init-scripts",
		label: "Global init scripts",
		plane: "workspace",
		scope: "global-init-scripts",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "unity-catalog",
		label: "Unity Catalog administration",
		plane: "workspace",
		scope: "unity-catalog",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "unity-catalog.recipients",
		label: "Delta Sharing recipients",
		plane: "workspace",
		scope: "sharing",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "dbfs",
		label: "DBFS",
		plane: "workspace",
		scope: "dbfs",
		grantable: false,
		measuredBy: "registry"
	},
	{
		prefix: "permissions",
		label: "Object permissions",
		plane: "workspace",
		scope: "all-apis",
		grantable: false,
		measuredBy: "endpoint"
	},
	{
		prefix: "accounts",
		label: "Account configuration",
		plane: "account",
		scope: "account",
		grantable: false,
		measuredBy: "endpoint"
	}
];
/**
* The account plane, which no workspace token reaches whatever it is scoped for.
*
* Returned for every `rest:account:` collector regardless of path, because the refusal happens
* before the path is considered — the token is rejected while its OAuth config is being loaded. A
* per-endpoint table for the account plane would imply the endpoints differ, and they do not.
*/
const ACCOUNT_PLANE = {
	prefix: "",
	label: "Account configuration",
	plane: "account",
	scope: "account",
	grantable: false,
	measuredBy: "endpoint"
};
/**
* The family a catalogue collector belongs to, or nothing if this table does not know it.
*
* Nothing is a real answer rather than a failure. An unknown collector reports as an unbuilt check,
* which is the conservative claim: it says the app has not done the work rather than asserting a
* platform limit that was never measured. Overclaiming in the other direction would let a genuine
* gap hide behind "the platform won't let us".
*/
function familyOf(collector) {
	const rest = restParts(collector);
	if (rest == null) return void 0;
	if (rest.plane === "account") return ACCOUNT_PLANE;
	let best;
	for (const family of API_FAMILIES) {
		if (family.prefix === "" || !rest.path.startsWith(family.prefix)) continue;
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
function beyondAnyApp(collector) {
	const family = familyOf(collector);
	return family != null && !family.grantable;
}
/**
* A `rest:<plane>:<path>` collector split into its plane and path, or nothing for another surface.
*
* A collector naming a system table or a DESCRIBE is not a control-plane question at all, so it
* has no family and no scope. Returning nothing rather than guessing keeps the two apart.
*/
function restParts(collector) {
	if (collector == null) return void 0;
	const parts = collector.split(":");
	if (parts.length < 3 || parts[0] !== "rest") return void 0;
	return {
		plane: parts[1] ?? "",
		path: parts.slice(2).join(":")
	};
}
//#endregion
export { API_FAMILIES, beyondAnyApp, familyOf };
