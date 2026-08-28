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
