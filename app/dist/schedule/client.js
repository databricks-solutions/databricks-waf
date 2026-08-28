import { getWorkspaceClient } from "@databricks/lakebase";
//#region server/schedule/client.ts
/**
* The app's client, built once, or undefined where this install has no identity of its own.
*
* Undefined is a supported state rather than a fault: a container with no credentials in its
* environment and no CLI config is what a reviewer running the app with `WAF_DEMO_NO_PERSISTENCE` has,
* and the schedule surface reports `unreadable` rather than failing the page. So construction failure is
* caught here rather than left to the first call, which would turn a missing credential into a 500 on a
* route that had a truthful answer available.
*/
function machineClient() {
	let client;
	try {
		client = getWorkspaceClient({});
	} catch {
		return;
	}
	const built = client;
	return () => Promise.resolve(built);
}
//#endregion
export { machineClient };
