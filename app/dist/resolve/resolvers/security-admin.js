import { detailFrom, evidenceFrom, fromSignal, notApplicable, threshold, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/security-admin.ts
const LOG_DELIVERY = "rest:account:accounts.log-delivery";
const ACCOUNT_IP_ACCESS_LISTS = "rest:account:accounts.{account_id}.ip-access-lists";
const WORKSPACE_IP_ACCESS_LISTS = "rest:workspace:ip-access-lists";
const DISABLE_LEGACY_FEATURES = "rest:account:accounts.settings.types.disable_legacy_features.names.default";
const SECRET_SCOPES = "rest:workspace:secrets.scopes.list";
const CLUSTERS = "rest:workspace:clusters.list";
const TOKEN_PERMISSIONS = "rest:workspace:permissions.authorization.tokens";
const DISABLE_LEGACY_DBFS = "rest:workspace:settings.types.disable_legacy_dbfs.names.default";
const SQL_RESULTS_DOWNLOAD = "rest:workspace:settings.types.sql_results_download.names.default";
const RESTRICT_WORKSPACE_ADMINS = "rest:workspace:settings.types.restrict_workspace_admins.names.default";
const AUTOMATIC_CLUSTER_UPDATE = "rest:workspace:settings.types.automatic_cluster_update.names.default";
const CSP_WS = "rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default";
const ESM_WS = "rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default";
const CSP_AC = "rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default";
/**
* SCP-04-02: audit log delivery configured and enabled.
*
* Passes when at least one log delivery configuration has log_type AUDIT_LOGS and
* status ENABLED. Partial when configurations exist but none is for audit logs or none
* is enabled. Fails when no configurations exist at all.
*/
const logDelivery = fromSignal(LOG_DELIVERY, ["SCP-04-02"], (inventory, context) => {
	if (inventory.configs.length === 0) return {
		outcome: "fail",
		evidence: [evidenceFrom(context, LOG_DELIVERY, "No log delivery configurations are defined in this account", "At least one audit log delivery configuration is enabled")],
		outcomeReason: "Without a log delivery configuration, audit events are only visible in the workspace UI for the limited retention window the platform provides. An enabled configuration writes them to your own storage, which is the copy an investigation can reach after a workspace is deleted or suspended."
	};
	const auditEnabled = inventory.configs.filter((cfg) => cfg.logType === "AUDIT_LOGS" && cfg.status === "ENABLED");
	const auditAny = inventory.configs.filter((cfg) => cfg.logType === "AUDIT_LOGS");
	const expected = "At least one enabled audit log delivery configuration exists";
	if (auditEnabled.length > 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, LOG_DELIVERY, `${auditEnabled.length} of ${inventory.configs.length} log delivery configuration${inventory.configs.length === 1 ? "" : "s"} deliver${auditEnabled.length === 1 ? "s" : ""} audit logs and ${auditEnabled.length === 1 ? "is" : "are"} enabled`, expected)]
	};
	if (auditAny.length > 0) return {
		outcome: "partial",
		evidence: [evidenceFrom(context, LOG_DELIVERY, `${auditAny.length} audit log configuration${auditAny.length === 1 ? "" : "s"} exist${auditAny.length === 1 ? "s" : ""} but ${auditAny.length === 1 ? "is" : "are"} not enabled`, expected)],
		outcomeReason: "Audit log configurations exist but none is currently enabled. A configuration in a disabled state does not deliver, so the audit trail is not reaching your storage."
	};
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, LOG_DELIVERY, `${inventory.configs.length} log delivery configuration${inventory.configs.length === 1 ? "" : "s"} exist${inventory.configs.length === 1 ? "s" : ""} but none delivers audit logs`, expected)],
		outcomeReason: "Configurations exist for other log types but none covers audit events. Adding an AUDIT_LOGS configuration is separate from enabling verbose audit logs."
	};
});
/**
* SCP-03-08: IP access lists configured for the account console.
*/
const accountIpAccessLists = fromSignal(ACCOUNT_IP_ACCESS_LISTS, ["SCP-03-08"], (inventory, context) => {
	const expected = "At least one enabled IP access list is configured for the account console";
	if (inventory.lists.length === 0) return {
		outcome: "fail",
		evidence: [evidenceFrom(context, ACCOUNT_IP_ACCESS_LISTS, "No IP access lists are configured for the account console", expected)],
		outcomeReason: "With no IP access lists the account console is reachable from any IP address. The account console is where workspaces are created and deleted, so it is a higher-value target than any workspace."
	};
	const enabledAllows = inventory.lists.filter((l) => l.listType === "ALLOW" && l.enabled === true);
	if (enabledAllows.length > 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, ACCOUNT_IP_ACCESS_LISTS, `${enabledAllows.length} enabled ALLOW list${enabledAllows.length === 1 ? "" : "s"} ${enabledAllows.length === 1 ? "restricts" : "restrict"} account console access`, expected)]
	};
	return {
		outcome: "partial",
		evidence: [evidenceFrom(context, ACCOUNT_IP_ACCESS_LISTS, `${inventory.lists.length} IP access list${inventory.lists.length === 1 ? "" : "s"} exist${inventory.lists.length === 1 ? "s" : ""} but none is an enabled ALLOW list`, expected)],
		outcomeReason: "Lists exist but none is an enabled ALLOW list, which is the type that restricts access to named ranges. A BLOCK list alone does not restrict access from unknown IPs."
	};
});
/**
* SCP-03-12: account console IP access list enforcement — at least one enabled ALLOW entry.
*/
const accountIpAccessListEnforcement = fromSignal(ACCOUNT_IP_ACCESS_LISTS, ["SCP-03-12"], (inventory, context) => {
	const expected = "At least one enabled ALLOW-type IP access list is active for the account console";
	const enabledAllows = inventory.lists.filter((l) => l.listType === "ALLOW" && l.enabled === true);
	if (enabledAllows.length > 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, ACCOUNT_IP_ACCESS_LISTS, `${enabledAllows.length} enabled ALLOW IP access list${enabledAllows.length === 1 ? "" : "s"} ${enabledAllows.length === 1 ? "enforces" : "enforce"} access restrictions on the account console`, expected)]
	};
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, ACCOUNT_IP_ACCESS_LISTS, inventory.lists.length === 0 ? "No IP access lists are configured for the account console" : `${inventory.lists.length} IP access list${inventory.lists.length === 1 ? "" : "s"} exist${inventory.lists.length === 1 ? "s" : ""} but none is an enabled ALLOW list`, expected)],
		outcomeReason: "An absent ALLOW list means the account console is reachable from any IP, regardless of any BLOCK lists that exist. ALLOW lists restrict everything outside the named ranges."
	};
});
/**
* SCP-03-05: IP access lists configured for workspace access.
*/
const workspaceIpAccessLists = fromSignal(WORKSPACE_IP_ACCESS_LISTS, ["SCP-03-05"], (inventory, context) => {
	const expected = "At least one enabled IP access list restricts workspace access";
	if (inventory.lists.length === 0) return {
		outcome: "fail",
		evidence: [evidenceFrom(context, WORKSPACE_IP_ACCESS_LISTS, "No IP access lists are configured for this workspace", expected)],
		outcomeReason: "Without an IP access list the workspace is reachable from any IP address. Network policies restrict egress; IP access lists restrict ingress to the workspace UI and APIs."
	};
	const enabledAllows = inventory.lists.filter((l) => l.listType === "ALLOW" && l.enabled === true);
	if (enabledAllows.length > 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, WORKSPACE_IP_ACCESS_LISTS, `${enabledAllows.length} enabled ALLOW list${enabledAllows.length === 1 ? "" : "s"} ${enabledAllows.length === 1 ? "restricts" : "restrict"} workspace access by IP`, expected)]
	};
	return {
		outcome: "partial",
		evidence: [evidenceFrom(context, WORKSPACE_IP_ACCESS_LISTS, `${inventory.lists.length} IP access list${inventory.lists.length === 1 ? "" : "s"} exist${inventory.lists.length === 1 ? "s" : ""} but none is an enabled ALLOW list`, expected)],
		outcomeReason: "Lists are configured but none is an enabled ALLOW list. A BLOCK list without an ALLOW list only restricts named ranges, leaving all other IPs unrestricted."
	};
});
/**
* SCP-04-21: disable legacy features for new workspaces (account-level setting).
*
* The shallow projection stores: `{ "disable_legacy_features": { "value": false }, "setting_name": "..." }`
*/
const disableLegacyFeatures = fromSignal(DISABLE_LEGACY_FEATURES, ["SCP-04-21"], (setting, context) => {
	const value = asSub(setting.data, "disable_legacy_features")?.["value"];
	const expected = "Legacy features are disabled for new workspaces by default";
	if (value == null) return unmeasured("The disable_legacy_features setting did not carry a value field. The shallow projection preserves everything within two levels of the response.");
	if (value === true) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, DISABLE_LEGACY_FEATURES, "Legacy features are disabled for new workspaces", expected)]
	};
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, DISABLE_LEGACY_FEATURES, "Legacy features are not disabled for new workspaces", expected)],
		outcomeReason: "New workspaces created in this account will have legacy features enabled. Legacy features include DBFS root access and legacy cluster access modes, which bypass Unity Catalog governance."
	};
});
/**
* SCP-02-01: credentials held in secret scopes rather than in notebooks.
*
* Passes when at least one secret scope exists.
*/
const secretScopes = fromSignal(SECRET_SCOPES, ["SCP-02-01"], (inventory, context) => {
	if (inventory.scopes.length === 0) return {
		outcome: "fail",
		evidence: [evidenceFrom(context, SECRET_SCOPES, "No secret scopes are configured in this workspace", "At least one secret scope holds credentials that would otherwise live in a notebook")],
		outcomeReason: "A workspace with no secret scopes has nowhere for its credentials to live except in notebooks and job definitions, where they are readable by anyone with access to the asset."
	};
	const databricksScopes = inventory.scopes.filter((s) => s.backendType === "DATABRICKS").length;
	const kvScopes = inventory.scopes.filter((s) => s.backendType === "AZURE_KEYVAULT").length;
	const detail = [databricksScopes > 0 ? `${databricksScopes} Databricks-backed` : "", kvScopes > 0 ? `${kvScopes} Azure Key Vault-backed` : ""].filter(Boolean).join(", ") || "backend type not recorded";
	return {
		outcome: "pass",
		evidence: [evidenceFrom(context, SECRET_SCOPES, `${inventory.scopes.length}${inventory.truncated ? "+" : ""} secret scope${inventory.scopes.length === 1 ? "" : "s"}: ${detail}`, "Secret scopes exist to hold credentials outside notebooks and job definitions")]
	};
});
/**
* SCP-02-02: local disk encryption enabled on clusters.
*
* Fails when any cluster has `enable_local_disk_encryption === false`. An absent value
* means the field was not returned — those clusters are not counted as unencrypted.
*/
const clusterDiskEncryption = fromSignal(CLUSTERS, ["SCP-02-02"], (inventory, context) => {
	if (inventory.clusters.length === 0) return notApplicable("No classic clusters are present in this workspace. Serverless compute does not have a local disk in the same sense — its storage is managed by the platform.");
	const known = inventory.clusters.filter((c) => c.enableLocalDiskEncryption != null);
	if (known.length === 0) return unmeasured("None of the clusters in this workspace recorded a local disk encryption setting. The field is only present when the cluster supports it and returned it in the API response.");
	const unencrypted = known.filter((c) => c.enableLocalDiskEncryption === false);
	const expected = "Every cluster has local disk encryption enabled";
	if (unencrypted.length === 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, CLUSTERS, `All ${known.length} cluster${known.length === 1 ? "" : "s"} with a recorded encryption setting have it enabled`, expected)]
	};
	const names = unencrypted.slice(0, 5).map((c) => c.clusterName ?? c.clusterId).join(", ");
	const tail = unencrypted.length > 5 ? `, and ${unencrypted.length - 5} more` : "";
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, CLUSTERS, `${unencrypted.length} of ${known.length} clusters have local disk encryption disabled`, expected), detailFrom(context, CLUSTERS, `Encryption off: ${names}${tail}`)],
		outcomeReason: "Local disk encryption covers the shuffle and spill space Spark writes during a job. That space holds the same data the table does, so an unencrypted disk is an unencrypted copy of the data in the table. Enabling this setting requires restarting the cluster."
	};
});
/**
* SCP-04-03: clusters running too long without a restart.
*
* A running cluster that has not been restarted in more than `max_running_days` days
* (default 30) may be running an unpatched image.
*/
const longRunningClusters = fromSignal(CLUSTERS, ["SCP-04-03"], (inventory, context) => {
	const runningClusters = inventory.clusters.filter((c) => c.state === "RUNNING");
	if (runningClusters.length === 0) return notApplicable("No clusters are currently running in this workspace. The finding applies only to running clusters that have not been restarted recently.");
	const maxDays = threshold(context.spec, "max_running_days", 30);
	const now = Date.now();
	const limit = maxDays * 864e5;
	const stale = runningClusters.filter((c) => {
		const reference = c.lastRestartedTime?.getTime() ?? c.startTime?.getTime();
		if (reference == null) return false;
		return now - reference > limit;
	});
	const expected = `No running cluster has been up more than ${maxDays} days without a restart`;
	if (stale.length === 0) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, CLUSTERS, `All ${runningClusters.length} running cluster${runningClusters.length === 1 ? "" : "s"} ${runningClusters.length === 1 ? "has" : "have"} been restarted within ${maxDays} days`, expected)]
	};
	const names = stale.slice(0, 5).map((c) => c.clusterName ?? c.clusterId).join(", ");
	const tail = stale.length > 5 ? `, and ${stale.length - 5} more` : "";
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, CLUSTERS, `${stale.length} of ${runningClusters.length} running clusters ${stale.length === 1 ? "has" : "have"} not been restarted in more than ${maxDays} days`, expected), detailFrom(context, CLUSTERS, `Running ${maxDays}+ days: ${names}${tail}`)],
		outcomeReason: "A cluster that has not been restarted recently is running on an older image and may not have received security patches applied since it started. Databricks updates cluster images regularly, and the only way to get those updates on a running cluster is to restart it."
	};
});
/**
* SCP-01-06: PAT token creation restricted to admins.
*/
const tokenCreationRestricted = fromSignal(TOKEN_PERMISSIONS, ["SCP-01-06"], (permissions, context) => {
	const usersEntry = permissions.entries.find((e) => e.groupName === "users");
	const anyoneCanCreate = usersEntry != null && usersEntry.permissionLevels.length > 0;
	const expected = "Token creation is restricted — the users group does not hold token-management permissions";
	if (!anyoneCanCreate) return {
		outcome: "pass",
		evidence: [evidenceFrom(context, TOKEN_PERMISSIONS, "Token creation is restricted: the users group does not appear in the token management ACL", expected)],
		outcomeReason: "Token creation is restricted to admins or named groups — the workspace-wide \"users\" group does not hold any token management permissions, so workspace members cannot create personal access tokens without explicit permission from an admin."
	};
	return {
		outcome: "fail",
		evidence: [evidenceFrom(context, TOKEN_PERMISSIONS, "Every workspace member can create tokens: the users group holds token management permissions", expected)],
		outcomeReason: "When the users group has token management permissions, every workspace member can create a personal access token. Restricting creation to admins or named groups limits who can generate credentials that bypass SSO."
	};
});
/** SCP-02-10: legacy DBFS root access and mounts disabled. */
const disableLegacyDbfs = fromSignal(DISABLE_LEGACY_DBFS, ["SCP-02-10"], booleanTypedSetting(DISABLE_LEGACY_DBFS, "disable_legacy_dbfs", "value", true, "Legacy DBFS root access is disabled"));
/** SCP-02-11: downloading SQL warehouse results is disabled (value === false means disabled = secure). */
const sqlResultsDownload = fromSignal(SQL_RESULTS_DOWNLOAD, ["SCP-02-11"], booleanTypedSetting(SQL_RESULTS_DOWNLOAD, "boolean_val", "value", false, "SQL results download is disabled"));
/** SCP-04-19: workspace admin restrictions are enabled. */
const restrictWorkspaceAdmins = fromSignal(RESTRICT_WORKSPACE_ADMINS, ["SCP-04-19"], (setting, context) => {
	const status = asSub(setting.data, "restrict_workspace_admins")?.["status"];
	const expected = "Workspace admin restrictions are enabled";
	if (status == null) return unmeasured("The restrict_workspace_admins setting did not carry a status field. The shallow projection preserves every scalar within two levels.");
	const restricted = status !== "ALLOW_ALL";
	return {
		outcome: restricted ? "pass" : "fail",
		evidence: [evidenceFrom(context, RESTRICT_WORKSPACE_ADMINS, `Workspace admin restriction status: ${asDisplay(status)}`, expected)],
		...restricted ? {} : { outcomeReason: "ALLOW_ALL means workspace admins may change job ownership and run jobs as other users. Restricting this closes two common privilege escalation paths." }
	};
});
/** SCP-04-20: automatic cluster update is enabled. */
const automaticClusterUpdate = fromSignal(AUTOMATIC_CLUSTER_UPDATE, ["SCP-04-20"], booleanTypedSetting(AUTOMATIC_CLUSTER_UPDATE, "automatic_cluster_update_workspace", "enabled", true, "Automatic cluster update is enabled"));
/** SCP-05-13: compliance security profile enabled on this workspace. */
const complianceSecurityProfileWs = fromSignal(CSP_WS, ["SCP-05-13"], booleanTypedSetting(CSP_WS, "compliance_security_profile_workspace", "is_enabled", true, "Compliance security profile is enabled"));
/** SCP-05-14: enhanced security monitoring enabled on this workspace. */
const enhancedSecurityMonitoringWs = fromSignal(ESM_WS, ["SCP-05-14"], booleanTypedSetting(ESM_WS, "enhanced_security_monitoring_workspace", "is_enabled", true, "Enhanced security monitoring is enabled"));
/** SCP-05-11: compliance security profile enforced at the account level. */
const complianceSecurityProfileAc = fromSignal(CSP_AC, ["SCP-05-11"], booleanTypedSetting(CSP_AC, "csp_enablement_account", "is_enforced", true, "Compliance security profile is enforced at the account level"));
const SECURITY_ADMIN_RESOLVERS = [
	logDelivery,
	accountIpAccessLists,
	accountIpAccessListEnforcement,
	workspaceIpAccessLists,
	disableLegacyFeatures,
	secretScopes,
	clusterDiskEncryption,
	longRunningClusters,
	tokenCreationRestricted,
	disableLegacyDbfs,
	sqlResultsDownload,
	restrictWorkspaceAdmins,
	automaticClusterUpdate,
	complianceSecurityProfileWs,
	enhancedSecurityMonitoringWs,
	complianceSecurityProfileAc
];
/**
* A resolver body for a typed setting with a single boolean deciding the verdict.
*
* @param signal   The signal ID carrying this setting's shallow data.
* @param outer    The top-level key in the shallow projection (`automatic_cluster_update_workspace`).
* @param inner    The nested key holding the boolean (`enabled`).
* @param secure   The boolean value that means compliant.
* @param observed The evidence sentence for the passing case.
*/
function booleanTypedSetting(signal, outer, inner, secure, observed) {
	return (setting, context) => {
		const value = asSub(setting.data, outer)?.[inner];
		const expected = observed;
		if (value == null) return unmeasured(`The ${outer} setting did not carry a ${inner} field. The shallow projection preserves every scalar within two levels of the API response.`);
		const pass = value === secure;
		return {
			outcome: pass ? "pass" : "fail",
			evidence: [evidenceFrom(context, signal, pass ? observed : `${outer}.${inner} is ${asDisplay(value)}, expected ${String(secure)}`, expected)],
			...pass ? {} : { outcomeReason: `The setting is explicitly ${asDisplay(value)}, not ${String(secure)}. This is a deliberate configuration rather than an unset default.` }
		};
	};
}
/**
* A nested sub-object from a typed setting's shallow data.
*
* The shallow projection keeps nested objects as plain JSON objects. This extracts one
* safely so each resolver does not repeat the same null-and-type check.
*/
function asSub(data, key) {
	const value = data[key];
	if (value == null || typeof value !== "object" || Array.isArray(value)) return void 0;
	return value;
}
/**
* A value as a display string, safe for any JSON-representable type.
*
* `String()` on an unknown-typed value may produce `[object Object]` for objects, which
* confuses a reader and triggers `@typescript-eslint/no-base-to-string`. This handles
* the common API-value cases (boolean, string, number) and falls back to JSON for the rest.
*/
function asDisplay(value) {
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	if (typeof value === "string") return value;
	return JSON.stringify(value) ?? "null";
}
//#endregion
export { SECURITY_ADMIN_RESOLVERS, accountIpAccessListEnforcement, accountIpAccessLists, automaticClusterUpdate, clusterDiskEncryption, complianceSecurityProfileAc, complianceSecurityProfileWs, disableLegacyDbfs, disableLegacyFeatures, enhancedSecurityMonitoringWs, logDelivery, longRunningClusters, restrictWorkspaceAdmins, secretScopes, sqlResultsDownload, tokenCreationRestricted, workspaceIpAccessLists };
