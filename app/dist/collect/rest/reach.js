//#region server/collect/rest/reach.ts
/**
* The first page of an async iterable, or nothing.
*
* Listing endpoints in this SDK are async iterators that make their first request lazily, so
* a probe that only called the method would report every list as readable without having
* asked anything. One item is enough to have made the call.
*/
async function firstOf(iterable) {
	for await (const item of iterable) return item;
	return null;
}
const FAMILIES = [
	{
		id: "iam.permissions",
		label: "Object permissions",
		controls: [
			"SCP-01-06",
			"SCP-04-23",
			"SCP-05-09"
		],
		read: (client) => client.permissions.getPermissionLevels({
			request_object_type: "authorization",
			request_object_id: "tokens"
		})
	},
	{
		id: "unity-catalog.metastores",
		label: "Metastore configuration",
		controls: [
			"SCP-04-10",
			"SCP-04-11",
			"SCP-04-14",
			"SCP-04-15",
			"SCP-04-18"
		],
		read: (client) => client.metastores.summary()
	},
	{
		id: "unity-catalog.recipients",
		label: "Delta Sharing recipients",
		controls: ["SCP-04-12", "SCP-04-13"],
		read: (client) => firstOf(client.recipients.list({}))
	},
	{
		id: "unity-catalog.storage-credentials",
		label: "Storage credentials",
		controls: ["SCP-05-08"],
		read: (client) => firstOf(client.storageCredentials.list({}))
	},
	{
		id: "unity-catalog.models",
		label: "Registered models",
		controls: ["SCP-04-17"],
		read: (client) => firstOf(client.registeredModels.list({}))
	},
	{
		id: "unity-catalog.external-locations",
		label: "External locations",
		controls: [],
		read: (client) => firstOf(client.externalLocations.list({}))
	},
	{
		id: "clusters",
		label: "Clusters",
		controls: [
			"SCP-02-02",
			"SCP-04-03",
			"SCP-04-04",
			"SCP-04-07",
			"SCP-05-01"
		],
		read: (client) => firstOf(client.clusters.list({}))
	},
	{
		id: "jobs",
		label: "Jobs",
		controls: ["SCP-04-22"],
		read: (client) => firstOf(client.jobs.list({}))
	},
	{
		id: "secrets",
		label: "Secret scopes",
		controls: ["SCP-02-01"],
		read: (client) => firstOf(client.secrets.listScopes())
	},
	{
		id: "ip-access-lists",
		label: "IP access lists",
		controls: ["SCP-03-05"],
		read: (client) => firstOf(client.ipAccessLists.list())
	},
	{
		id: "scim.groups",
		label: "Groups",
		controls: ["SCP-05-03"],
		read: (client) => firstOf(client.groupsV2.list({}))
	},
	{
		id: "global-init-scripts",
		label: "Global init scripts",
		controls: ["SCP-05-02"],
		read: (client) => firstOf(client.globalInitScripts.list())
	},
	{
		id: "vector-search.endpoints",
		label: "Vector search endpoints",
		controls: ["SCP-02-09"],
		read: (client) => firstOf(client.vectorSearchEndpoints.listEndpoints({}))
	},
	{
		id: "sql.query-history",
		label: "Query history",
		/**
		* No control waits on this one, and it is the only family here in that position.
		*
		* It is probed because the workload advisor does: row `33j` reads the operator plan behind a query
		* shape from `GET /api/2.0/sql/history/queries/{id}`, which is the one place a scanned table's name
		* appears at all — `system.query.history` records what a statement cost and never what it touched.
		* `sql.query-history:read` is declared for it, and declaring a scope is only half a measurement.
		* ADR 0016 found `serving.serving-endpoints:read` accepted by the registry and then honoured by
		* nothing, so a scope this app holds on paper is not a call it can make until something makes it.
		*
		* `list` rather than the get-by-id the advisor will use, because a reach probe has no statement to
		* name and the SDK exposes no get. The scope is what is being asked about, and both paths sit under
		* it; if that ever stops being true the advisor's own refusal will say so in the same words.
		*/
		controls: [],
		read: (client) => client.queryHistory.list({ max_results: 1 })
	},
	{
		id: "workspace.settings",
		label: "Workspace settings (typed)",
		controls: [
			"SCP-02-10",
			"SCP-02-11",
			"SCP-04-19",
			"SCP-04-20",
			"SCP-05-13",
			"SCP-05-14"
		],
		read: (client) => client.workspaceConf.getStatus({ keys: "enableDbfsFileBrowser" })
	}
];
async function probeReach(client, grants) {
	const results = [];
	for (const family of FAMILIES) results.push(await probeOne(client, family, grants));
	return results;
}
async function probeOne(client, family, grants) {
	const shared = {
		id: family.id,
		label: family.label,
		controls: family.controls
	};
	try {
		await family.read(client);
		return {
			...shared,
			reach: "readable",
			detail: "The call answered."
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			...shared,
			reach: classify(message, grants),
			detail: message
		};
	}
}
/**
* The scope a refusal names, if it names one.
*
* Exported because the same sentence is what a finding has to quote when it explains why a
* control could not be measured, and parsing it in two places would let the two disagree.
*/
function demandedScope(message) {
	return /required scopes?:\s*([A-Za-z0-9_.:-]+)/i.exec(message)?.[1];
}
/**
* Which of the reaches a failure is, from the message.
*
* On the message rather than the status code because the distinctions that matter — a scope
* never granted, a scope granted to the app but not to this user, a permission the user
* lacks — are all 403, and only the text separates them.
*/
function classify(message, grants) {
	if (/required scopes|not a valid scope|invalid scope|insufficient_scope/i.test(message)) return staleConsent(message, grants) ? "stale-consent" : "no-scope";
	if (/\b404\b|not found|does not exist|ENDPOINT_NOT_FOUND|RESOURCE_DOES_NOT_EXIST/i.test(message)) return "absent";
	if (/permission|forbidden|not authorized|unauthorized|PERMISSION_DENIED|\b403\b/i.test(message)) return "forbidden";
	return "error";
}
/**
* Whether this refusal is the temporary kind: the app asked for the scope, the token does not
* have it, so the user's consent predates the request.
*
* Every uncertainty resolves to false, which reports the refusal as permanent. That is the
* asymmetry worth being deliberate about — the two errors are not equally bad. Reporting a
* permanent limit as stale consent sends a workspace admin to re-authorise for a scope no
* install will ever be granted, and when nothing changes they have learnt to distrust the
* next message too. Reporting stale consent as a permanent limit understates what the app
* could measure, which is the same thing every other unmeasured control already says.
*/
function staleConsent(message, grants) {
	if (grants?.carried == null) return false;
	const demanded = demandedScope(message);
	if (demanded == null) return false;
	return grants.declared.includes(demanded) && !grants.carried.includes(demanded);
}
//#endregion
export { FAMILIES, classify, demandedScope, probeReach };
