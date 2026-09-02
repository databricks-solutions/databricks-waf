import { REQUESTED_KEYS } from "./settings-keys.js";
const PROBES = [
	{
		id: "rest:workspace:preview.workspace-conf",
		label: "workspace-conf",
		what: "The workspace security settings",
		endpoint: "GET /api/2.0/workspace-conf",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		async run(client) {
			const answer = await client.workspaceConf.getStatus({ keys: REQUESTED_KEYS.join(",") });
			const values = /* @__PURE__ */ new Map();
			const unanswered = [];
			for (const key of REQUESTED_KEYS) {
				if (!(key in answer)) {
					unanswered.push(key);
					continue;
				}
				values.set(key, asSettingValue(answer[key]));
			}
			return {
				values,
				unanswered
			};
		}
	},
	{
		id: "rest:workspace:token.list",
		label: "token-management",
		what: "The workspace personal access tokens",
		endpoint: "GET /api/2.0/token-management/tokens",
		permission: "workspace admin",
		scope: "authentication",
		grantable: false,
		async run(client, options) {
			const tokens = [];
			let truncated = false;
			for await (const token of client.tokenManagement.list({})) {
				if (tokens.length >= options.pageLimit) {
					truncated = true;
					break;
				}
				tokens.push({
					id: String(token.token_id ?? ""),
					createdBy: token.created_by_username,
					comment: token.comment,
					createdAt: asDate(token.creation_time),
					expiresAt: asDate(token.expiry_time)
				});
			}
			return {
				tokens,
				truncated
			};
		}
	},
	{
		id: "rest:workspace:serving-endpoints",
		label: "serving-endpoints",
		what: "The model serving endpoints",
		endpoint: "GET /api/2.0/serving-endpoints",
		permission: "CAN VIEW on the endpoint, which every workspace user holds for endpoints they can see",
		scope: "model-serving",
		grantable: true,
		async run(client, options) {
			const endpoints = [];
			let truncated = false;
			for await (const endpoint of client.servingEndpoints.list()) {
				if (endpoints.length >= options.pageLimit) {
					truncated = true;
					break;
				}
				const served = endpoint.config?.served_entities ?? [];
				endpoints.push({
					name: endpoint.name ?? "(unnamed)",
					servedExternalModel: served.some((entity) => entity.external_model != null),
					state: endpoint.state?.ready
				});
			}
			return {
				endpoints,
				truncated
			};
		}
	},
	{
		id: "rest:workspace:vector-search.endpoints",
		label: "vector-search-endpoints",
		what: "The vector search endpoints",
		endpoint: "GET /api/2.0/vector-search/endpoints",
		permission: "CAN USE on the endpoint, which every workspace user holds for endpoints they can see",
		scope: "vector-search",
		grantable: true,
		async run(client, options) {
			const endpoints = [];
			let truncated = false;
			for await (const endpoint of client.vectorSearchEndpoints.listEndpoints({})) {
				if (endpoints.length >= options.pageLimit) {
					truncated = true;
					break;
				}
				endpoints.push({
					name: endpoint.name ?? "(unnamed)",
					type: endpoint.endpoint_type,
					state: endpoint.endpoint_status?.state
				});
			}
			return {
				endpoints,
				truncated
			};
		}
	},
	{
		id: "rest:account:accounts.log-delivery",
		label: "account-log-delivery",
		what: "The account log delivery configurations",
		endpoint: "GET /api/2.0/accounts/{account_id}/log-delivery",
		permission: "account admin",
		scope: "account",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:account:accounts.{account_id}.ip-access-lists",
		label: "account-ip-access-lists",
		what: "The account console IP access lists",
		endpoint: "GET /api/2.0/accounts/{account_id}/ip-access-lists",
		permission: "account admin",
		scope: "account",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:ip-access-lists",
		label: "ip-access-lists",
		what: "The workspace IP access lists",
		endpoint: "GET /api/2.0/ip-access-lists",
		permission: "workspace admin",
		scope: "networking",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"networking\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:account:accounts.settings.types.disable_legacy_features.names.default",
		label: "account-setting-disable-legacy-features",
		what: "The account-level disable-legacy-features setting",
		endpoint: "GET /api/2.0/accounts/{account_id}/settings/types/disable_legacy_features/names/default",
		permission: "account admin",
		scope: "account",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:secrets.scopes.list",
		label: "secret-scopes",
		what: "The workspace secret scopes",
		endpoint: "GET /api/2.0/secrets/scopes/list",
		permission: "workspace admin",
		scope: "secrets",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"secrets\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:clusters.list",
		label: "clusters",
		what: "The workspace clusters",
		endpoint: "GET /api/2.0/clusters/list",
		permission: "workspace admin",
		scope: "clusters",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"clusters\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:permissions.authorization.tokens",
		label: "token-permissions",
		what: "The workspace token creation permissions",
		endpoint: "GET /api/2.0/permissions/authorization/tokens",
		permission: "workspace admin",
		scope: "all-apis",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"all-apis\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.disable_legacy_dbfs.names.default",
		label: "setting-disable-legacy-dbfs",
		what: "The workspace disable-legacy-DBFS setting",
		endpoint: "GET /api/2.0/settings/types/disable_legacy_dbfs/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.sql_results_download.names.default",
		label: "setting-sql-results-download",
		what: "The workspace SQL-results-download setting",
		endpoint: "GET /api/2.0/settings/types/sql_results_download/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.restrict_workspace_admins.names.default",
		label: "setting-restrict-workspace-admins",
		what: "The workspace restrict-workspace-admins setting",
		endpoint: "GET /api/2.0/settings/types/restrict_workspace_admins/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.automatic_cluster_update.names.default",
		label: "setting-automatic-cluster-update",
		what: "The workspace automatic-cluster-update setting",
		endpoint: "GET /api/2.0/settings/types/automatic_cluster_update/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default",
		label: "setting-compliance-security-profile",
		what: "The workspace compliance security profile setting",
		endpoint: "GET /api/2.0/settings/types/shield_csp_enablement_ws_db/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default",
		label: "setting-enhanced-security-monitoring",
		what: "The workspace enhanced-security-monitoring setting",
		endpoint: "GET /api/2.0/settings/types/shield_esm_enablement_ws_db/names/default",
		permission: "workspace admin",
		scope: "settings",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("The \"settings\" scope is not grantable to apps. Import admin-collected evidence to populate this signal."));
		}
	},
	{
		id: "rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default",
		label: "account-setting-compliance-security-profile",
		what: "The account compliance security profile setting",
		endpoint: "GET /api/2.0/accounts/{account_id}/settings/types/shield_csp_enablement_ac/names/default",
		permission: "account admin",
		scope: "account",
		grantable: false,
		run() {
			return Promise.reject(/* @__PURE__ */ new Error("Account plane endpoint: not reachable with a workspace token. Import admin-collected evidence to populate this signal."));
		}
	}
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
function asSettingValue(raw) {
	if (typeof raw === "string") return raw;
	if (typeof raw === "number" || typeof raw === "boolean") return String(raw);
	return null;
}
/** Epoch milliseconds as the control plane reports them, or undefined for absent and zero. */
function asDate(value) {
	if (value == null || value === 0) return void 0;
	return new Date(value);
}
//#endregion
export { PROBES, asDate, asSettingValue };
