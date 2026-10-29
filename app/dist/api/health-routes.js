import { AUDIT_PHRASES } from "../audit/event.js";
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
function gapOf(gap) {
	return {
		id: gap.id,
		at: gap.at.toISOString(),
		actor: gap.actor,
		action: gap.action,
		phrase: AUDIT_PHRASES[gap.action] ?? gap.action,
		outcome: gap.outcome,
		...gap.target != null ? { target: {
			kind: gap.target.kind,
			id: gap.target.id
		} } : {},
		cause: gap.cause
	};
}
/**
* The markers as the page is told them, or nothing for an install that keeps none.
*
* A read that failed is served as such, with an empty list beside the reason, and not as an empty list:
* a page told "nothing lost" by a read that threw would be the one reading this record cannot afford.
*/
function gapsOf(found, unreadable) {
	if (unreadable != null) return {
		gaps: [],
		truncated: false,
		unreadable
	};
	if (found == null) return void 0;
	return {
		gaps: found.gaps.map(gapOf),
		truncated: found.truncated
	};
}
function registerHealthRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	app.get("/api/diagnostics", async (request, response) => {
		try {
			const health = await readHealth(await options.sourcesFor(request));
			const auditGaps = gapsOf(health.gaps, health.gapsUnreadable);
			const payload = {
				at: health.at.toISOString(),
				well: health.well,
				unrecorded: health.unrecorded,
				...auditGaps != null ? { auditGaps } : {},
				readings: health.readings.map(readingOf)
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Says that somebody has looked at a lost audit event.
	*
	* Idempotent in what it records: a second acknowledgement of the same event answers with the first,
	* and writes nothing, so two people acting on the same page do not each believe they dealt with it
	* and the name beside it is not rewritten by whoever clicked last.
	*/
	app.post("/api/diagnostics/audit-gaps/:id/acknowledge", async (request, response) => {
		const gaps = options.gaps;
		if (gaps == null || options.permitted == null) {
			response.status(503).json({
				error: "audit-gaps-unavailable",
				message: "This install keeps no markers for audit events it could not write, so there is nothing to acknowledge here."
			});
			return;
		}
		const id = request.params.id ?? "";
		let act;
		try {
			const permission = await options.permitted(request, response, "gap.acknowledge", { target: {
				kind: "audit-gap",
				id
			} });
			act = permission.act;
			const done = await gaps.acknowledge(id, permission.actor, now());
			if (done == null) {
				await act.failed("unknown-gap", {
					kind: "audit-gap",
					id
				});
				response.status(404).json({
					error: "unknown-gap",
					message: `No lost audit event is recorded with id ${id}.`
				});
				return;
			}
			await act.performed({
				kind: "audit-gap",
				id
			});
			const payload = {
				id,
				acknowledgedBy: done.by,
				acknowledgedAt: done.at.toISOString(),
				already: done.already
			};
			response.json(payload);
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
}
//#endregion
export { registerHealthRoutes };
