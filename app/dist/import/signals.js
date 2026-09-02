import { COMPLETE } from "../collect/signal.js";
import { asDate, asSettingValue } from "../collect/rest/probes.js";
import { SURFACES } from "../scan/surfaces.js";
//#region server/import/signals.ts
/**
* The workspace settings, as fifteen controls read them.
*
* The distinction this rebuilds is the one the whole settings table exists for. A key the endpoint
* answered with `null` was never set by this workspace; a key it did not answer at all is a key this
* workspace's cloud or tier does not have. The script preserves both — a null value for the first, an
* absent field for the second — and both must survive the crossing, because a resolver that read them
* as the same thing would report "not configured" for a setting that cannot exist here.
*/
const workspaceSettings = (probe) => {
	const answered = asObject(probe.value);
	const values = /* @__PURE__ */ new Map();
	const unanswered = [];
	for (const key of probe.fields) {
		if (!(key in answered)) {
			unanswered.push(key);
			continue;
		}
		values.set(key, asSettingValue(answered[key]));
	}
	return {
		values,
		unanswered
	};
};
/**
* The personal access tokens, as three controls read them.
*
* `expiresAt` absent is the finding rather than a gap: the endpoint omits an expiry for a token that
* never expires, and two of these controls are looking for exactly that. So an absent field must
* revive as `undefined` and not as a date, which is why every timestamp goes through the same
* coercion the collector uses.
*/
const tokenInventory = (probe) => {
	const answered = asObject(probe.value);
	return {
		tokens: (Array.isArray(answered.token_infos) ? answered.token_infos : []).map((entry) => {
			const token = asObject(entry);
			return {
				id: asId(token.token_id),
				createdBy: asText(token.created_by_username),
				comment: asText(token.comment),
				createdAt: asDate(asEpoch(token.creation_time)),
				expiresAt: asDate(asEpoch(token.expiry_time))
			};
		}),
		truncated: false
	};
};
/**
* Log delivery configurations, as the account API reports them.
*
* The count field carries the script's `:count` projection. The field name in the projected
* JSON is `workspace_ids_filter:count` (with the colon), which is how the script writes
* projection-summary keys — the name is the path the field took, not a typo.
*/
const logDelivery = (probe) => {
	const answered = asObject(probe.value);
	return {
		configs: (Array.isArray(answered.log_delivery_configurations) ? answered.log_delivery_configurations : []).map((entry) => {
			const config = asObject(entry);
			return {
				configId: asId(config.config_id),
				configName: asText(config.config_name),
				logType: asText(config.log_type),
				outputFormat: asText(config.output_format),
				status: asText(config.status),
				workspaceFilterCount: asCount(config["workspace_ids_filter:count"])
			};
		}),
		truncated: probe.truncated === true
	};
};
/**
* IP access lists, as both the workspace and account endpoints report them.
*
* The same reviver handles both signal IDs because the projected shape is identical: both
* endpoints return `ip_access_lists[]` with the same fields. The resolvers differ in what
* they check against those lists, not in how they read them.
*
* `ip_addresses:count` is the script's count projection key, same convention as above.
*/
const ipAccessLists = (probe) => {
	const answered = asObject(probe.value);
	return {
		lists: (Array.isArray(answered.ip_access_lists) ? answered.ip_access_lists : []).map((entry) => {
			const item = asObject(entry);
			return {
				label: asText(item.label),
				listType: asText(item.list_type),
				enabled: asBoolean(item.enabled),
				ipAddressCount: asCount(item["ip_addresses:count"])
			};
		}),
		truncated: probe.truncated === true
	};
};
/**
* A typed settings endpoint, captured via the script's shallow projection.
*
* `shallow` keeps every scalar within two levels and stores the result as an object keyed
* by the API's own names. The reviver hands it through without interpretation: it is not
* possible to write a type-safe interpretation here because each typed setting uses a
* different key name for its value, and the resolver for each control knows which one to
* look for. What this guarantees is that the JSON object crossed correctly — same shallow
* depth, same key names — so a resolver that calls `.data.automatic_cluster_update_workspace`
* gets the same thing it would have gotten from a live collection.
*/
const typedSetting = (probe) => {
	return { data: asObject(probe.value) };
};
/**
* Secret scopes, as the workspace scopes-list endpoint reports them.
*
* The script never fetches secrets themselves, only scope names and backend types.
* A scope-free workspace is a legitimate response — not every workspace stores secrets —
* so an empty list revives as an observation of zero scopes, not as a gap.
*/
const secretScopes = (probe) => {
	const answered = asObject(probe.value);
	return {
		scopes: (Array.isArray(answered.scopes) ? answered.scopes : []).map((entry) => {
			const scope = asObject(entry);
			return {
				name: asId(scope.name),
				backendType: asText(scope.backend_type)
			};
		}),
		truncated: probe.truncated === true
	};
};
/**
* Clusters as the workspace clusters-list endpoint reports them.
*
* Two controls read this signal: SCP-02-02 (local disk encryption) and SCP-04-03
* (long-running clusters without a restart). The same revived shape serves both.
*
* `spark_env_vars:keys` is a `:keys` projection — key names without values, for the
* same reason the script never captures an environment variable value: it is a classic
* place for hard-coded credentials. `init_scripts:count` is a `:count` projection.
*
* `start_time` and `last_restarted_time` are epoch milliseconds, converted to Dates so
* a resolver can compare them with `Date.now()` rather than dividing away the epoch.
*/
const adminClusters = (probe) => {
	const answered = asObject(probe.value);
	return {
		clusters: (Array.isArray(answered.clusters) ? answered.clusters : []).map((entry) => {
			const cluster = asObject(entry);
			return {
				clusterId: asId(cluster.cluster_id),
				clusterName: asText(cluster.cluster_name),
				state: asText(cluster.state),
				clusterSource: asText(cluster.cluster_source),
				sparkVersion: asText(cluster.spark_version),
				dataSecurityMode: asText(cluster.data_security_mode),
				autoterminationMinutes: asCount(cluster.autotermination_minutes),
				enableLocalDiskEncryption: asBoolean(cluster.enable_local_disk_encryption),
				startTime: asDate(asEpoch(cluster.start_time)),
				lastRestartedTime: asDate(asEpoch(cluster.last_restarted_time)),
				sparkEnvVarKeys: asStringArray(cluster["spark_env_vars:keys"]),
				initScriptCount: asCount(cluster["init_scripts:count"])
			};
		}),
		truncated: probe.truncated === true
	};
};
/**
* The token-creation ACL, as the permissions API reports it.
*
* Only the permission level, the principal type and the principal name are captured — the
* script never fetches the token values themselves. The violation SCP-01-06 looks for is
* the `users` group appearing in the list with any permission level, which means every
* workspace member can create PATs.
*/
const tokenPermissions = (probe) => {
	const answered = asObject(probe.value);
	return { entries: (Array.isArray(answered.access_control_list) ? answered.access_control_list : []).map((entry) => {
		const item = asObject(entry);
		const permissionLevels = (Array.isArray(item.all_permissions) ? item.all_permissions : []).map((p) => asText(asObject(p).permission_level)).filter((level) => level != null);
		return {
			userName: asText(item.user_name),
			groupName: asText(item.group_name),
			servicePrincipalName: asText(item.service_principal_name),
			permissionLevels
		};
	}) };
};
/**
* The revivers, by signal.
*
* Deliberately a small map rather than a generic decoder. A generic one would accept every signal in
* the file, which reads as progress and is the failure mode described at the top: a resolver handed a
* plain object where it expected a `Map` finds nothing and reports a compliant workspace as a broken
* one. Adding a signal here is a deliberate act with a test beside it.
*/
const REVIVERS = /* @__PURE__ */ new Map([
	["rest:workspace:preview.workspace-conf", workspaceSettings],
	["rest:workspace:token.list", tokenInventory],
	["rest:account:accounts.log-delivery", logDelivery],
	["rest:account:accounts.{account_id}.ip-access-lists", ipAccessLists],
	["rest:account:accounts.settings.types.disable_legacy_features.names.default", typedSetting],
	["rest:workspace:secrets.scopes.list", secretScopes],
	["rest:workspace:clusters.list", adminClusters],
	["rest:workspace:ip-access-lists", ipAccessLists],
	["rest:workspace:permissions.authorization.tokens", tokenPermissions],
	["rest:workspace:settings.types.disable_legacy_dbfs.names.default", typedSetting],
	["rest:workspace:settings.types.sql_results_download.names.default", typedSetting],
	["rest:workspace:settings.types.restrict_workspace_admins.names.default", typedSetting],
	["rest:workspace:settings.types.automatic_cluster_update.names.default", typedSetting],
	["rest:workspace:settings.types.shield_csp_enablement_ws_db.names.default", typedSetting],
	["rest:workspace:settings.types.shield_esm_enablement_ws_db.names.default", typedSetting],
	["rest:account:accounts.settings.types.shield_csp_enablement_ac.names.default", typedSetting]
]);
/**
* The readings an import offers a scan.
*
* Takes the stored import rather than the envelope because the provenance names who collected it and
* when it was imported, and a reading that could not say whose authority produced it would be
* unattributable — which is the one thing an imported number may not be.
*/
function readingsFrom(imported) {
	const signals = /* @__PURE__ */ new Map();
	const unrevived = /* @__PURE__ */ new Set();
	for (const probe of imported.envelope.probes) for (const name of probe.signals) {
		if (!signalled(name)) {
			unrevived.add(name);
			continue;
		}
		const reviver = REVIVERS.get(name);
		if (reviver == null) {
			unrevived.add(name);
			continue;
		}
		const revived = resultFrom(name, probe, reviver, imported.envelope);
		if (preferred(signals.get(name), revived)) signals.set(name, revived);
	}
	return {
		signals,
		unrevived: [...unrevived]
	};
}
/**
* Whether a second reading of the same signal should replace the first.
*
* Two probes in one file can name the same signal, because a signal is a fact and more than one API
* can carry it — and the script does not deduplicate, on purpose: what it collected is what it wrote
* down. So the choice lands here, and it is not "the last one wins". A refusal arriving after a
* reading would erase the reading and turn a measured requirement into an unmeasured one, which is
* the wrong direction for a file that demonstrably contains the answer.
*
* A reading beats a refusal. Otherwise the first stands, because there is nothing in the file that
* makes the second of two equally-good readings the better one, and preferring the later would make
* the result depend on probe order in a file this app did not write.
*/
function preferred(held, arriving) {
	if (held == null) return true;
	return held.status === "unmeasurable" && arriving.status !== "unmeasurable";
}
/**
* Whether a name in the file is a signal id at all.
*
* The envelope validation checks that the signal names are non-empty strings and stops there, on
* purpose: a file from a newer script naming a signal this build has never heard of is a file to hold,
* not a file to refuse. So the narrowing happens here, where an unrecognised name has somewhere
* harmless to go.
*/
function signalled(name) {
	const colon = name.indexOf(":");
	return colon > 0 && SURFACES.includes(name.slice(0, colon));
}
function resultFrom(id, probe, reviver, envelope) {
	const provenance = provenanceFor(probe, envelope);
	const base = {
		id,
		coverage: COMPLETE,
		collectedAt: new Date(envelope.generatedAt),
		durationMs: 0,
		provenance
	};
	if (probe.status !== "observed") return {
		...base,
		status: "unmeasurable",
		unmeasurableReason: refusalOf(probe)
	};
	return {
		...base,
		status: "observed",
		value: reviver(probe)
	};
}
/**
* Why the administrator could not read it either, in their words rather than the app's.
*
* A denial the admin hit is more informative than the app's own, because it rules out the explanation
* a reader would otherwise reach for: that the app lacked a scope somebody could grant it. So the
* message names the tier and keeps the control plane's detail.
*/
function refusalOf(probe) {
	const where = probe.tier === "account" ? "the account console" : "the workspace";
	const said = probe.detail ?? "no reason given";
	return `An administrator's own reading of ${where} ${probe.status === "denied" ? "refused" : probe.status === "skipped" ? "did not attempt" : "failed"} this: ${said}`;
}
/**
* The authority an imported reading was made under.
*
* `admin-cli` and not the app's execution mode, because that is the fact a disputed number turns on:
* this was read by a person at a terminal, holding permissions the app does not hold and cannot
* check, and it is the reason the resulting evidence is classed `admin-collected`. The actor is the
* username the CLI reported, or the tier's own name when the CLI would not say — an account profile
* has no username to give, which is a caveat the import surface already prints.
*/
function provenanceFor(probe, envelope) {
	const identity = envelope.tiers[probe.tier].identity;
	return {
		surface: "rest",
		collector: `admin-script:${probe.label}`,
		authority: "admin-cli",
		actor: identity?.username ?? `an unnamed ${probe.tier} administrator`,
		...identity?.host != null ? { from: identity.host } : {}
	};
}
/**
* The map a scan resolves against, with imported readings filling only what it did not read itself.
*
* The rule is `mayDecideOver` expressed over signals rather than findings, and it is one-directional
* in both halves. An observation the app made stands: a file cannot overwrite a live reading, however
* recent the file claims to be, because the app can re-run its own reading and cannot re-run the
* import. But an import does replace an *unmeasurable* — a signal the app tried and was refused is
* exactly the gap the import exists to fill, and leaving the refusal in place would mean importing
* evidence changed nothing.
*/
function merged(collected, imported) {
	const merged = new Map(collected);
	for (const [id, incoming] of imported) {
		const existing = merged.get(id);
		if (existing == null) {
			merged.set(id, incoming);
			continue;
		}
		if (existing.status === "unmeasurable" && incoming.status === "observed") merged.set(id, incoming);
	}
	return merged;
}
function asObject(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}
/**
* An identifier from an untrusted file, as a string.
*
* Only primitives are converted. The collector can write `String(token.token_id)` because the SDK
* types say what it is; here the value came out of a file, and stringifying an object would put
* `[object Object]` into a finding as if it were a token id.
*/
function asId(value) {
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}
function asText(value) {
	return typeof value === "string" && value !== "" ? value : void 0;
}
/** Epoch milliseconds as the file carries them: a number, or a string when JSON round-tripping made one. */
function asEpoch(value) {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
}
/**
* A boolean from an untrusted file.
*
* Only a real boolean passes. The script's shallow projection preserves booleans as-is;
* a projected string `"true"` is a setting value and is handled by `asSettingValue`, not
* here. Confusing the two would turn `"true"` from a setting into `true` from a flag,
* collapsing the distinction the workspace-conf reviver exists to preserve.
*/
function asBoolean(value) {
	return typeof value === "boolean" ? value : void 0;
}
/**
* A non-negative integer count from a `:count` projection field.
*
* The script writes these as `key:count` in the projected JSON, and they are always
* non-negative integers. A float or a negative number is not a valid count, and is
* treated as absent rather than rounded — rounding would invent a count nobody produced.
*/
function asCount(value) {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return void 0;
	const rounded = Math.floor(value);
	return rounded === value ? rounded : void 0;
}
/**
* An array of strings from a `:keys` projection field.
*
* The script writes these as `key:keys` in the projected JSON — an array of string key
* names without values. Non-strings in the array are dropped rather than converted: a
* key name that round-tripped as a number would be a malformed projection, and silently
* stringifying it would invent a name the script never wrote.
*/
function asStringArray(value) {
	if (!Array.isArray(value)) return void 0;
	return value.filter((item) => typeof item === "string");
}
//#endregion
export { merged, readingsFrom };
