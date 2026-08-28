import { readHealth } from "../health/health.js";
//#region server/api/health-routes.ts
function readingOf(reading) {
	return {
		dependency: reading.dependency,
		standing: reading.standing,
		provenance: reading.provenance,
		at: reading.at.toISOString(),
		detail: reading.detail,
		...reading.action != null ? { action: reading.action } : {}
	};
}
function registerHealthRoutes(app, options) {
	app.get("/api/diagnostics", async (request, response) => {
		try {
			const health = await readHealth(await options.sourcesFor(request));
			const payload = {
				at: health.at.toISOString(),
				well: health.well,
				unrecorded: health.unrecorded,
				readings: health.readings.map(readingOf)
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
}
//#endregion
export { registerHealthRoutes };
