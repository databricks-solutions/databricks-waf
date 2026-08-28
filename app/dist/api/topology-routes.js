import { topologyPayload } from "../collect/topology/payload.js";
//#region server/api/topology-routes.ts
const NO_WAREHOUSE = "No SQL warehouse is bound to this installation, so the seven statements this graph is made of cannot run. Bind one and open this page again.";
function registerTopologyRoutes(app, options) {
	app.get("/api/topology", async (request, response) => {
		if (options.collect == null) {
			response.status(503).json({
				error: "topology-unavailable",
				message: NO_WAREHOUSE
			});
			return;
		}
		const controller = new AbortController();
		const abandon = () => controller.abort();
		request.once("aborted", abandon);
		response.once("close", abandon);
		try {
			const collected = await options.collect(request, controller.signal);
			const payload = topologyPayload(collected.edges, collected.names);
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		} finally {
			request.off("aborted", abandon);
			response.off("close", abandon);
		}
	});
}
//#endregion
export { registerTopologyRoutes };
