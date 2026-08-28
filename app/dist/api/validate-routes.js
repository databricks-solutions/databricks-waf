import { assessmentOf } from "./assessment-query.js";
import { InvalidAttemptError, abandoned, draftFrom, newestFirst, requested, whyNotRequestable } from "../validate/attempt.js";
import { AlreadyAnsweredError } from "../validate/store.js";
//#region server/api/validate-routes.ts
const NO_STORE = "This installation is not keeping validations, so there is nowhere to record one. Bind a database and restart, and the claims you ask a run to check will survive a deploy.";
const NOT_DURABLE = "Validations are being kept in memory on this installation, so a restart loses every attempt, including the ones that failed. The record of how many runs it took to hold is the part that is hardest to reconstruct afterwards — bind a database before using this in earnest.";
const NO_ACTIONS = "This installation is not keeping improvement plans, so there are no claims to validate. Bind a database and restart.";
function registerValidateRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	/**
	* Every attempt against one action, and whether another may be asked for.
	*
	* Addressed under the action rather than under a validations collection of its own, because an
	* attempt is never read on its own: the question is always what has been tried on this claim.
	*/
	app.get("/api/improvements/:planId/actions/:actionId/validations", async (request, response) => {
		const actionId = request.params.actionId ?? "";
		try {
			const action = await options.improvements?.action(actionId, assessmentOf(request));
			if (options.improvements == null || action == null) {
				response.status(404).json({
					error: "unknown-action",
					message: options.improvements == null ? NO_ACTIONS : `No improvement action with id ${actionId}.`
				});
				return;
			}
			if (options.validations == null) {
				response.json(present(actionId, [], action, options, false));
				return;
			}
			const attempts = newestFirst(await options.validations.for(actionId));
			response.json(present(actionId, attempts, action, options, options.validations.durable));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** Asks for the claim on this action to be checked by a run. */
	app.post("/api/improvements/:planId/actions/:actionId/validations", async (request, response) => {
		if (options.validations == null || options.improvements == null) {
			response.status(503).json({
				error: "validations-unavailable",
				message: options.validations == null ? NO_STORE : NO_ACTIONS
			});
			return;
		}
		const store = options.validations;
		const actions = options.improvements;
		let act;
		try {
			const actionId = request.params.actionId ?? "";
			const permission = await options.permitted(request, response, "validation.request", { target: {
				kind: "action",
				id: actionId
			} });
			act = permission.act;
			const action = await actions.action(actionId, assessmentOf(request));
			if (action == null) {
				await refuse(response, act, 404, "unknown-action", `No improvement action with id ${actionId}.`);
				return;
			}
			const attempt = requested(draftFrom(action, request.body, {
				measurabilityOf: options.measurabilityOf,
				existing: await store.for(actionId)
			}), permission.actor, newId(), now());
			await store.add(attempt);
			await act.performed({
				kind: "action",
				id: action.id
			});
			response.status(201).json(dated(presentAttempt(attempt, options)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Withdraws a claim that is waiting on a run.
	*
	* A withdrawal closes the attempt as incomplete rather than deleting it, so the record still says
	* somebody offered work for validation and took it back. It does not move the action: taking the work
	* back to `in-progress` is a separate act with its own audit event, and doing both from one endpoint
	* would make one refusal undo half of two changes.
	*/
	app.post("/api/improvements/:planId/actions/:actionId/validations/:validationId/withdraw", async (request, response) => {
		if (options.validations == null) {
			response.status(503).json({
				error: "validations-unavailable",
				message: NO_STORE
			});
			return;
		}
		const store = options.validations;
		let act;
		try {
			const actionId = request.params.actionId ?? "";
			const validationId = request.params.validationId ?? "";
			const permission = await options.permitted(request, response, "validation.withdraw", { target: {
				kind: "action",
				id: actionId
			} });
			act = permission.act;
			const action = await options.improvements?.action(actionId, assessmentOf(request));
			if (options.improvements == null || action == null) {
				await refuse(response, act, 404, "unknown-action", options.improvements == null ? NO_ACTIONS : `No improvement action with id ${actionId}.`);
				return;
			}
			const attempt = (await store.for(actionId)).find((one) => one.id === validationId);
			if (attempt == null) {
				await refuse(response, act, 404, "unknown-validation", `No validation with id ${validationId} against action ${actionId}.`);
				return;
			}
			if (attempt.answer != null) {
				await refuse(response, act, 409, "already-answered", "This validation has already been answered by a run, so there is nothing waiting to withdraw. Its answer stays on the record either way.");
				return;
			}
			const closed = abandoned(attempt, whyFrom(request.body, permission.actor), now());
			await store.answer(closed);
			await act.performed({
				kind: "action",
				id: actionId
			});
			response.json(dated(presentAttempt(closed, options)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
}
function present(actionId, attempts, action, options, durable) {
	const refusal = options.validations == null ? NO_STORE : whyNotRequestable(action, {
		measurabilityOf: options.measurabilityOf,
		existing: attempts
	});
	return dated({
		actionId,
		attempts: attempts.map((attempt) => presentAttempt(attempt, options)),
		mayRequest: refusal == null,
		...refusal != null ? { whyNot: refusal } : {},
		maxObserveDays: 90,
		durable,
		...durable ? {} : { durabilityNote: options.validationStorage ?? NOT_DURABLE }
	});
}
function presentAttempt(attempt, options) {
	return {
		id: attempt.id,
		planId: attempt.planId,
		actionId: attempt.actionId,
		checks: attempt.checks.map((check) => {
			const title = options.titleOf(check.controlId);
			return {
				controlId: check.controlId,
				method: check.method,
				...title != null ? { title } : {}
			};
		}),
		claimedAt: attempt.claimedAt,
		requestedBy: attempt.requestedBy,
		requestedAt: attempt.requestedAt,
		observeFrom: attempt.observeFrom,
		observeDays: attempt.observeDays,
		...attempt.answer != null ? { answer: {
			result: attempt.answer.result,
			...attempt.answer.scanId != null ? { scanId: attempt.answer.scanId } : {},
			at: attempt.answer.at,
			unmet: attempt.answer.unmet,
			unreadable: attempt.answer.unreadable,
			...attempt.answer.why != null ? { why: attempt.answer.why } : {}
		} } : {}
	};
}
/**
* Why the claim is being withdrawn, with the withdrawer's name in it.
*
* A reason is optional here, unlike on a cancelled action, and the difference is what the sentence is
* for: a cancelled action is a decision a colleague inherits and cannot interpret, where a withdrawn
* validation is a question taken back before anything answered it. Demanding prose for it would mostly
* collect "wrong workspace" — which the default already says as well as it can be said.
*/
function whyFrom(body, actor) {
	const raw = body == null || typeof body !== "object" ? {} : body;
	const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
	const withdrawn = `${actor} withdrew the claim before a run answered it`;
	return reason === "" ? `${withdrawn}.` : `${withdrawn}: ${reason}`;
}
async function refuse(response, act, status, error, message) {
	await act.failed(error);
	response.status(status).json({
		error,
		message
	});
}
function respond(response, cause, options) {
	if (cause instanceof InvalidAttemptError) {
		response.status(400).json({
			error: "invalid-validation",
			message: cause.message
		});
		return;
	}
	if (cause instanceof AlreadyAnsweredError) {
		response.status(409).json({
			error: "already-answered",
			message: cause.message
		});
		return;
	}
	options.respondToFailure(response, cause);
}
/** Every date as an ISO string, in one traversal at the edge. See `improve-routes.ts`. */
function dated(payload) {
	if (payload instanceof Date) return payload.toISOString();
	if (Array.isArray(payload)) return payload.map((entry) => dated(entry));
	if (payload != null && typeof payload === "object") return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
	return payload;
}
//#endregion
export { registerValidateRoutes };
