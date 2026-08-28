import { AUDIT_ACTIONS, AUDIT_PHRASES } from "../audit/event.js";
//#region server/api/audit-routes.ts
const OUTCOMES = [
	"performed",
	"refused",
	"failed"
];
/** The vocabulary, paired with its prose, in the order `event.ts` groups it. */
const VOCABULARY = AUDIT_ACTIONS.map((id) => ({
	id,
	phrase: AUDIT_PHRASES[id]
}));
const NO_LOG = "This install records no events, so there is no trail to search. Events are written to the bound database, and this app has none — bind a Lakebase instance and the trail begins from that point. Nothing before it can be recovered, because an event nobody wrote down is not somewhere else.";
/** Thrown by the parser, caught by the route, and never reaches the failure responder. */
var BadFilterError = class extends Error {
	parameter;
	constructor(parameter, message) {
		super(message);
		this.parameter = parameter;
	}
};
function eventOf(event) {
	return {
		sequence: event.sequence,
		at: event.at.toISOString(),
		actor: event.actor,
		executionMode: event.executionMode,
		action: event.action,
		outcome: event.outcome,
		...event.target != null ? { target: {
			kind: event.target.kind,
			id: event.target.id,
			...event.target.digest != null ? { digest: event.target.digest } : {}
		} } : {},
		...event.reason != null ? { reason: event.reason } : {},
		...event.correlation != null ? { correlation: event.correlation } : {},
		digest: event.digest
	};
}
function one(request, name) {
	const raw = request.query[name];
	const value = Array.isArray(raw) ? raw[0] : raw;
	if (typeof value !== "string" || value.trim() === "") return void 0;
	return value.trim();
}
/**
* A whole number from the query, or a refusal.
*
* `limit` and `before` both arrive as text and both have a wrong answer that looks like a right one:
* `limit=abc` as `NaN` reaching the store becomes a page of whatever the driver makes of it, and
* `before=0` would serve nothing while reading as the first page.
*/
function counted(request, name, least) {
	const raw = one(request, name);
	if (raw == null) return void 0;
	const value = Number(raw);
	if (!Number.isInteger(value) || value < least) throw new BadFilterError(name, `\`${name}\` must be a whole number of at least ${String(least)}, and was \`${raw}\`.`);
	return value;
}
function dated(request, name) {
	const raw = one(request, name);
	if (raw == null) return void 0;
	const at = new Date(raw);
	if (Number.isNaN(at.getTime())) throw new BadFilterError(name, `\`${name}\` must be a date, and was \`${raw}\`. An ISO 8601 instant is what the trail records.`);
	return at;
}
function queryFrom(request) {
	const action = one(request, "action");
	if (action != null && !AUDIT_ACTIONS.includes(action)) throw new BadFilterError("action", `\`${action}\` is not an act this app records. It records: ${AUDIT_ACTIONS.join(", ")}.`);
	const outcome = one(request, "outcome");
	if (outcome != null && !OUTCOMES.includes(outcome)) throw new BadFilterError("outcome", `\`${outcome}\` is not an outcome. An event is ${OUTCOMES.join(", ")}.`);
	const since = dated(request, "since");
	const until = dated(request, "until");
	if (since != null && until != null && since > until) throw new BadFilterError("since", "`since` is after `until`, so this range covers nothing.");
	const actor = one(request, "actor");
	const targetId = one(request, "target");
	const correlation = one(request, "correlation");
	const before = counted(request, "before", 1);
	const limit = counted(request, "limit", 1);
	return {
		...actor != null ? { actor } : {},
		...action != null ? { action } : {},
		...outcome != null ? { outcome } : {},
		...targetId != null ? { targetId } : {},
		...correlation != null ? { correlation } : {},
		...since != null ? { since } : {},
		...until != null ? { until } : {},
		...before != null ? { before } : {},
		...limit != null ? { limit: Math.min(limit, 200) } : {}
	};
}
function registerAuditRoutes(app, options) {
	app.get("/api/audit", async (request, response) => {
		const log = options.audit;
		if (log == null) {
			const empty = {
				durable: false,
				events: [],
				actions: VOCABULARY,
				unavailable: NO_LOG
			};
			response.json(empty);
			return;
		}
		let query;
		try {
			query = queryFrom(request);
		} catch (cause) {
			if (cause instanceof BadFilterError) {
				response.status(400).json({
					error: "bad-filter",
					parameter: cause.parameter,
					message: cause.message
				});
				return;
			}
			options.respondToFailure(response, cause);
			return;
		}
		try {
			const page = await log.search(query);
			const head = await log.head();
			const payload = {
				durable: options.durable ?? false,
				events: page.events.map(eventOf),
				...page.next != null ? { next: page.next } : {},
				...head.sequence > 0 ? { head: {
					sequence: head.sequence,
					digest: head.digest
				} } : {},
				actions: VOCABULARY
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Whether the trail is still what this app wrote.
	*
	* Separate from `/api/records/verification`, which checks the scans, answers and decisions. Both
	* report and neither enforces, for the reason stated there — but the two are different claims and
	* a combined endpoint would let one of them pass while the reader read the other's result.
	*/
	app.get("/api/audit/verification", async (_request, response) => {
		const log = options.audit;
		if (log == null) {
			response.json({
				checked: 0,
				breaks: [],
				means: "This install records no events, so there is no chain to verify."
			});
			return;
		}
		try {
			const report = await log.verify();
			const payload = {
				checked: report.checked,
				...report.head != null ? { head: {
					sequence: report.head.sequence,
					digest: report.head.digest
				} } : {},
				breaks: report.breaks,
				means: report.means
			};
			response.json(payload);
		} catch (cause) {
			response.status(503).json({
				error: "verification-unavailable",
				message: `The trail could not be read back, so nothing about its integrity is being claimed. The database reported: ${cause instanceof Error ? cause.message : String(cause)}`
			});
		}
	});
}
//#endregion
export { registerAuditRoutes };
