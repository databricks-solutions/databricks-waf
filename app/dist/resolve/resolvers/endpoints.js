import { evidenceFrom, fromSignal, notApplicable, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/endpoints.ts
const SERVING = "rest:workspace:serving-endpoints";
const VECTOR_SEARCH = "rest:workspace:vector-search.endpoints";
const ENDPOINT_RESOLVERS = [fromSignal(VECTOR_SEARCH, ["SCP-02-09"], (inventory, context) => {
	if (inventory.endpoints.length === 0) return notApplicable("There are no Databricks Vector Search endpoints in this workspace, so there is no managed embedding store to assess. This does not rule out embeddings held somewhere else — a self-managed index on a cluster or an external vector database is invisible from here, and is the thing this requirement is really about. If that is how embeddings are stored, the requirement needs an answer rather than a scan.");
	const ready = inventory.endpoints.filter((endpoint) => endpoint.state == null || endpoint.state === "ONLINE");
	return {
		outcome: "pass",
		evidence: [evidenceFrom(context, VECTOR_SEARCH, `${inventory.endpoints.length} Databricks Vector Search endpoint${inventory.endpoints.length === 1 ? "" : "s"} (${String(ready.length)} online): ${inventory.endpoints.map((endpoint) => endpoint.name).slice(0, 5).join(", ")}`, "Embeddings are held in Databricks Vector Search, whose indexes are Unity Catalog objects and carry its grants")],
		outcomeReason: "A pass on the presence of a governed store, which is what the requirement asks. It is not a claim that every embedding in the estate is in it: an index built outside Databricks would not appear here, and nothing in the control plane would reveal it."
	};
}), fromSignal(SERVING, ["SCP-03-07"], (inventory, context) => {
	if (inventory.endpoints.length === 0) return notApplicable("There are no model serving endpoints in this workspace, so there is no serving surface exposed to the internet. The requirement returns as soon as an endpoint is created.");
	const named = inventory.endpoints.map((endpoint) => endpoint.name).slice(0, 5).join(", ");
	return {
		...unmeasured(`This workspace serves ${String(inventory.endpoints.length)} model endpoint${inventory.endpoints.length === 1 ? "" : "s"}, so the requirement applies. Whether they are shielded cannot be read: an IP access list needs the "networking" scope and Private Link is account-plane configuration, and Databricks Apps offers an app neither.`, "unreachable"),
		evidence: [evidenceFrom(context, SERVING, `${inventory.endpoints.length} model serving endpoint${inventory.endpoints.length === 1 ? "" : "s"}: ${named}`, "Serving endpoints are reachable only over Private Link or from an allowed IP range")]
	};
})];
//#endregion
export { ENDPOINT_RESOLVERS };
