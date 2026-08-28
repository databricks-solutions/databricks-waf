import { stamped } from "../store/assessment-scope.js";
import { assessmentOf } from "./assessment-query.js";
import { InvalidApplicabilityError, applicabilityFrom, effective, newestFirst, recorded, revoked, standingOf } from "../apply/applicability.js";
import { AlreadyDecidedError, AlreadyRevokedError, DecisionsUnreadableError } from "../apply/store.js";
//#region server/api/applicability-routes.ts
const NO_STORE = "Applicability decisions are not being kept on this installation, so there is nowhere to record one. Bind a database and restart: a requirement taken out of the score by a decision that does not survive a deploy would silently return to it, moving the score for a reason nobody recorded.";
function registerApplicabilityRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	/** Every decision this install has recorded, newest first, including expired and revoked ones. */
	app.get("/api/applicability", async (request, response) => {
		const store = options.applicability;
		if (store == null) {
			response.json(present([], false, now()));
			return;
		}
		try {
			const scope = assessmentOf(request);
			const decisions = await store.all(scope);
			response.json(present(decisions, store.durable, now(), options, void 0, await readings(decisions, options, scope)));
		} catch (cause) {
			respond(response, cause, options);
		}
	});
	/** Every decision ever recorded against one requirement, so a superseded one stays readable. */
	app.get("/api/applicability/:controlId", async (request, response) => {
		const controlId = request.params.controlId ?? "";
		const store = options.applicability;
		if (store == null) {
			response.json(present([], false, now(), options, controlId));
			return;
		}
		try {
			const scope = assessmentOf(request);
			const decisions = await store.for(controlId, scope);
			response.json(present(decisions, store.durable, now(), options, controlId, await readings(decisions, options, scope)));
		} catch (cause) {
			respond(response, cause, options);
		}
	});
	/** Records a decision, or refuses it and says which field to fix, or why the reading forbids it. */
	app.post("/api/applicability", async (request, response) => {
		const store = options.applicability;
		if (store == null) {
			response.status(503).json({
				error: "applicability-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await options.permitted(request, response, "applicability.record");
			act = permission.act;
			const controlId = idFrom(request.body);
			const scope = assessmentOf(request);
			const previous = controlId == null ? [] : await store.for(controlId, scope);
			const reading = controlId == null ? void 0 : await options.readingOf(controlId, scope);
			const decision = stamped(recorded(applicabilityFrom(request.body, {
				knownControl: (id) => options.controlOf(id) != null,
				severityOf: (id) => options.controlOf(id)?.severity,
				reading: (id) => id === controlId ? reading : void 0,
				existing: previous,
				now: now()
			}), permission.actor, newId(), now(), previous), scope);
			await store.record(decision);
			await act.performed({
				kind: "control",
				id: decision.controlId
			});
			response.status(201).json(dated(presentDecision(decision, options, now(), false, reading?.latest === true ? reading.outcome : void 0)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/** Ends a decision before its expiry, with a reason — putting the requirement back into the score. */
	app.post("/api/applicability/:decisionId/revoke", async (request, response) => {
		const store = options.applicability;
		if (store == null) {
			response.status(503).json({
				error: "applicability-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const decisionId = request.params.decisionId ?? "";
			const permission = await options.permitted(request, response, "applicability.revoke");
			act = permission.act;
			const decision = (await store.all(assessmentOf(request))).find((one) => one.id === decisionId);
			if (decision == null) {
				await refuse(response, act, 404, "unknown-decision", `No applicability decision with id ${decisionId}.`);
				return;
			}
			const ended = revoked(decision, permission.actor, reasonFrom(request.body), now());
			await store.revoke(ended);
			await act.performed({
				kind: "control",
				id: ended.controlId
			});
			response.json(dated(presentDecision(ended, options, now())));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
}
/**
* The reading behind each requirement a decision names, so the register can say a decision has lapsed.
*
* One read per requirement rather than per decision, because a requirement's history is several decisions
* and they all lapse or none do. The same `readingOf` the write path uses, so the register and the refusal
* cannot disagree about what the estate reads.
*/
async function readings(decisions, options, scope) {
	const ids = [...new Set(decisions.map((decision) => decision.controlId))];
	const found = await Promise.all(ids.map(async (id) => {
		const reading = await options.readingOf(id, scope);
		return [id, reading?.latest === true ? reading.outcome : void 0];
	}));
	return new Map(found);
}
function present(decisions, durable, at, options, controlId, readings) {
	const ordered = newestFirst(decisions);
	const newest = /* @__PURE__ */ new Map();
	for (const decision of ordered) if (!newest.has(decision.controlId)) newest.set(decision.controlId, decision.id);
	return dated({
		decisions: ordered.map((decision) => presentDecision(decision, options, at, newest.get(decision.controlId) !== decision.id, readings?.get(decision.controlId))),
		...controlId != null ? { controlId } : {},
		durable,
		...durable ? {} : { durabilityNote: NO_STORE }
	});
}
function presentDecision(decision, options, at, superseded = false, reading) {
	const standing = standingOf(decision, {
		now: at,
		superseded,
		...reading != null ? { reading } : {}
	});
	const control = options?.controlOf(decision.controlId);
	return {
		id: decision.id,
		controlId: decision.controlId,
		lever: decision.lever,
		reason: decision.reason,
		owner: decision.owner,
		effectiveFrom: decision.effectiveFrom,
		expiresAt: decision.expiresAt,
		recordedBy: decision.recordedBy,
		recordedAt: decision.recordedAt,
		...decision.supersedes != null ? { supersedes: decision.supersedes } : {},
		...decision.revoked != null ? { revoked: {
			by: decision.revoked.by,
			at: decision.revoked.at,
			reason: decision.revoked.reason
		} } : {},
		standing,
		effective: effective(standing),
		...control != null ? {
			title: control.title,
			pillarId: control.pillarId,
			severity: control.severity
		} : {}
	};
}
/** The requirement the body names, for the read that has to happen before the draft is validated. */
function idFrom(body) {
	if (body == null || typeof body !== "object") return void 0;
	const raw = body.controlId;
	if (typeof raw !== "string") return void 0;
	const trimmed = raw.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Why it is being revoked, straight from the body. The length is enforced by `revoked` in the domain,
* because the refusal is a rule about the record and belongs where the record is.
*/
function reasonFrom(body) {
	if (body == null || typeof body !== "object") return "";
	const raw = body.reason;
	return typeof raw === "string" ? raw : "";
}
async function refuse(response, act, status, error, message) {
	await act.failed(error);
	response.status(status).json({
		error,
		message
	});
}
function respond(response, cause, options) {
	if (cause instanceof InvalidApplicabilityError) {
		response.status(400).json({
			error: "invalid-applicability",
			message: cause.message
		});
		return;
	}
	if (cause instanceof AlreadyRevokedError) {
		response.status(409).json({
			error: "already-revoked",
			message: cause.message
		});
		return;
	}
	if (cause instanceof AlreadyDecidedError) {
		response.status(409).json({
			error: "already-decided",
			message: cause.message
		});
		return;
	}
	if (cause instanceof DecisionsUnreadableError) {
		response.status(503).json({
			error: "applicability-unreadable",
			message: cause.message
		});
		return;
	}
	options.respondToFailure(response, cause);
}
/** Every date as an ISO string, in one traversal at the edge. See `risk-routes.ts`. */
function dated(payload) {
	if (payload instanceof Date) return payload.toISOString();
	if (Array.isArray(payload)) return payload.map((entry) => dated(entry));
	if (payload != null && typeof payload === "object") return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
	return payload;
}
//#endregion
export { registerApplicabilityRoutes };
