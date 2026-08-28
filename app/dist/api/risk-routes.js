import { stamped } from "../store/assessment-scope.js";
import { assessmentOf } from "./assessment-query.js";
import { InvalidRiskError, acceptanceDays, effective, newestFirst, recorded, revoked, riskFrom, standingOf } from "../accept/risk.js";
import { AlreadyAcceptedError, AlreadyRevokedError, RisksUnreadableError } from "../accept/store.js";
//#region server/api/risk-routes.ts
const NO_STORE = "Accepted risks are not being kept on this installation, so there is nowhere to record one. Bind a database and restart: an acceptance that does not survive a deploy is an exposure nobody is watching.";
const NOT_DURABLE = "Accepted risks are being kept in memory on this installation, so a restart loses every one of them — including their expiry dates, which is what puts the work back. Bind a database before using this in earnest.";
function registerRiskRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	/**
	* Every acceptance this install has recorded, newest first.
	*
	* Including the expired, the revoked and the superseded, because the question this list answers is
	* how long each exposure has been carried rather than what is parked today. A list of the effective
	* ones would make a requirement accepted for the fourth quarter running look like a fresh decision.
	*/
	app.get("/api/risks", async (request, response) => {
		const store = options.risks;
		if (store == null) {
			response.json(present([], options, false, now()));
			return;
		}
		try {
			response.json(present(await store.all(assessmentOf(request)), options, store.durable, now()));
		} catch (cause) {
			respond(response, cause, options);
		}
	});
	/** Every acceptance ever recorded against one requirement, so a superseded one stays readable. */
	app.get("/api/risks/:controlId", async (request, response) => {
		const controlId = request.params.controlId ?? "";
		const store = options.risks;
		if (store == null) {
			response.json(present([], options, false, now(), controlId));
			return;
		}
		try {
			const risks = await store.for(controlId, assessmentOf(request));
			response.json(present(risks, options, store.durable, now(), controlId));
		} catch (cause) {
			respond(response, cause, options);
		}
	});
	/** Records an acceptance, or refuses it and says which field to fix. */
	app.post("/api/risks", async (request, response) => {
		const store = options.risks;
		if (store == null) {
			response.status(503).json({
				error: "risks-unavailable",
				message: options.riskStorage ?? NO_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await options.permitted(request, response, "risk.accept");
			act = permission.act;
			const controlId = idFrom(request.body);
			const scope = assessmentOf(request);
			const previous = controlId == null ? [] : await store.for(controlId, scope);
			const risk = stamped(recorded(riskFrom(request.body, {
				knownControl: (id) => options.controlOf(id) != null,
				severityOf: (id) => options.controlOf(id)?.severity,
				existing: previous,
				now: now()
			}), permission.actor, newId(), now(), previous), scope);
			await store.record(risk);
			await act.performed({
				kind: "control",
				id: risk.controlId
			});
			response.status(201).json(dated(presentRisk(risk, options, now())));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Ends an acceptance before its expiry, with a reason.
	*
	* A second version of the same record rather than a deletion: the requirement goes back on somebody's
	* queue ahead of the date they were told to expect, and who decided that and why is the part anybody
	* comes back for.
	*/
	app.post("/api/risks/:riskId/revoke", async (request, response) => {
		const store = options.risks;
		if (store == null) {
			response.status(503).json({
				error: "risks-unavailable",
				message: options.riskStorage ?? NO_STORE
			});
			return;
		}
		let act;
		try {
			const riskId = request.params.riskId ?? "";
			const permission = await options.permitted(request, response, "risk.revoke");
			act = permission.act;
			const risk = (await store.all(assessmentOf(request))).find((one) => one.id === riskId);
			if (risk == null) {
				await refuse(response, act, 404, "unknown-risk", `No accepted risk with id ${riskId}.`);
				return;
			}
			const ended = revoked(risk, permission.actor, reasonFrom(request.body), now());
			await store.revoke(ended);
			await act.performed({
				kind: "control",
				id: ended.controlId
			});
			response.json(dated(presentRisk(ended, options, now())));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
}
function present(risks, options, durable, at, controlId) {
	const ordered = newestFirst(risks);
	const newest = /* @__PURE__ */ new Map();
	for (const risk of ordered) if (!newest.has(risk.controlId)) newest.set(risk.controlId, risk.id);
	return dated({
		risks: ordered.map((risk) => presentRisk(risk, options, at, newest.get(risk.controlId) !== risk.id)),
		...controlId != null ? { controlId } : {},
		durable,
		...durable ? {} : { durabilityNote: options.riskStorage ?? NOT_DURABLE },
		acceptanceDays: acceptanceDays()
	});
}
function presentRisk(risk, options, at, superseded = false) {
	const standing = standingOf(risk, {
		now: at,
		superseded
	});
	const control = options.controlOf(risk.controlId);
	return {
		id: risk.id,
		controlId: risk.controlId,
		reason: risk.reason,
		compensatingControl: risk.compensatingControl,
		residual: risk.residual,
		owner: risk.owner,
		effectiveFrom: risk.effectiveFrom,
		expiresAt: risk.expiresAt,
		recordedBy: risk.recordedBy,
		recordedAt: risk.recordedAt,
		...risk.supersedes != null ? { supersedes: risk.supersedes } : {},
		...risk.revoked != null ? { revoked: {
			by: risk.revoked.by,
			at: risk.revoked.at,
			reason: risk.revoked.reason
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
* Why it is being revoked, straight from the body.
*
* Required, unlike a withdrawn validation's reason, and `revoked` in the domain enforces the length
* rather than this function: the refusal is a rule about the record and belongs where the record is.
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
	if (cause instanceof InvalidRiskError) {
		response.status(400).json({
			error: "invalid-risk",
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
	if (cause instanceof AlreadyAcceptedError) {
		response.status(409).json({
			error: "already-accepted",
			message: cause.message
		});
		return;
	}
	if (cause instanceof RisksUnreadableError) {
		response.status(503).json({
			error: "risks-unreadable",
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
export { registerRiskRoutes };
