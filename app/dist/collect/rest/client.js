import { WorkspaceClient } from "@databricks/sdk-experimental";
//#region server/collect/rest/client.ts
/**
* A factory that builds the client once and hands the same one to every probe.
*
* Not eager, because a scan that collects no REST signals should not mint a token or
* open a pool for nothing.
*/
function clientFor(credentials) {
	let client;
	return () => {
		client ??= build(credentials);
		return client;
	};
}
async function build(credentials) {
	const identity = await credentials.databricks();
	const token = await identity.token();
	return new WorkspaceClient({
		host: identity.host,
		token,
		authType: "pat"
	});
}
//#endregion
export { clientFor };
