import { JOB_NAME, read } from "../schedule/schedule.js";
import { trigger } from "../schedule/trigger.js";
//#region server/api/schedule-routes.ts
function scheduleRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	app.get("/api/schedule", async (_request, response) => {
		try {
			const payload = await read({
				...options.client != null ? { client: options.client } : {},
				...options.assessments != null ? { assessments: options.assessments } : {},
				now
			});
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	app.post("/api/schedule/run", async (request, response) => {
		let act;
		try {
			const who = await options.permitted(request, response, "schedule.trigger", { target: {
				kind: "job",
				id: JOB_NAME
			} });
			act = who.act;
			if (options.client == null) {
				await act.failed("no-machine-identity");
				response.status(409).json({
					error: "no-machine-identity",
					message: "This install has no machine identity, so the app cannot start its own scheduled job. A scan started by hand from the header does the same assessment; what it does not exercise is the schedule's own path."
				});
				return;
			}
			const started = await trigger({
				client: options.client,
				actor: who.actor
			});
			if (started.error != null) {
				await act.failed(started.error);
				response.status(started.status).json({
					error: started.error,
					message: started.message
				});
				return;
			}
			await act.performed();
			response.status(202).json(started.run);
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
}
//#endregion
export { scheduleRoutes };
