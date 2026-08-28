//#region server/audit/record.ts
/**
* Set to `1` so an act that cannot be recorded is refused instead of performed.
*
* Named for the posture rather than for the mechanism. `WAF_AUDIT_FAIL_CLOSED=1` would describe the
* implementation to somebody who already knew what it did, and this has to be recognisable to the
* person holding the control that requires it.
*/
const STRICT_ENV = "WAF_AUDIT_STRICT";
/**
* Which posture this process is in.
*
* Exactly `1`, like `WAF_DEMO_NO_PERSISTENCE`: `0` and `false` both read as off to a person, and a
* setting that turned itself on for `false` would be the one kind of misconfiguration nobody checks
* for, because the operator believes they have already disabled it.
*/
function postureFrom(env) {
	return (env["WAF_AUDIT_STRICT"] ?? "").trim() === "1" ? "strict" : "record-and-continue";
}
/**
* The trail cannot take an event, and this install refuses acts it cannot record.
*
* Its own class so the gate's refusal can name the database. A strict refusal that reached the
* caller as a permission problem would send them to their group membership, where they would find
* nothing wrong and conclude the app was broken — and they would be right, just not about that.
*
* `cause` is kept for the operator's console and deliberately not for the response: a driver error
* carries a connection string, and `event.ts` is explicit that estate detail does not leave here.
*/
var TrailUnwritableError = class extends Error {
	cause;
	kind = "trail-unwritable";
	constructor(cause) {
		super("This action was refused because it could not be written to the audit trail. The database that holds the trail did not answer, and this install is configured to refuse an action it cannot record rather than perform one it cannot account for.");
		this.cause = cause;
		this.name = "TrailUnwritableError";
	}
};
var AuditRecorder = class {
	log;
	options;
	lost = 0;
	constructor(log, options = {}) {
		this.log = log;
		this.options = options;
	}
	/**
	* Opens an act, capturing who and when.
	*
	* The instant is taken here rather than at the outcome, so the event is stamped with when the app
	* began the act. A mutation that takes four seconds and then fails is otherwise timestamped four
	* seconds after the thing the reader is correlating it with.
	*/
	begin(action, who, context = {}) {
		const at = (this.options.now ?? (() => /* @__PURE__ */ new Date()))();
		let closed = false;
		const write = async (outcome, target, reason, emptied) => {
			if (closed) return;
			closed = true;
			const on = target ?? context.target;
			await this.record({
				id: this.mintId(),
				at,
				actor: who.actor,
				executionMode: who.executionMode,
				action,
				outcome,
				...on != null ? { target: on } : {},
				...reason != null ? { reason } : {},
				...context.correlation != null ? { correlation: context.correlation } : {},
				...emptied != null ? { emptied } : {}
			});
		};
		return {
			performed: (target, emptied) => write("performed", target, void 0, emptied),
			failed: (cause, target) => write("failed", target, reasonFor(cause)),
			settle: (status) => status < 400 ? write("performed", void 0, void 0) : write("failed", void 0, `http-${String(status)}`)
		};
	}
	/**
	* Records an act the gate turned away.
	*
	* Its own method rather than an outcome on `Act`, because a refusal happens before the handler
	* runs: `permitted` throws, so there is nobody holding an act to close. That is also why this is
	* the one place the recorder is called from outside a route handler.
	*/
	async refused(action, who, reason, target) {
		await this.record({
			id: this.mintId(),
			at: (this.options.now ?? (() => /* @__PURE__ */ new Date()))(),
			actor: who.actor,
			executionMode: who.executionMode,
			action,
			outcome: "refused",
			reason,
			...target != null ? { target } : {}
		});
	}
	/** How many events this process could not write. Served on the health surface, not a debug aid. */
	get unrecorded() {
		return this.lost;
	}
	/**
	* What this install does about an act it cannot record.
	*
	* Read by the health surface rather than inferred there from the environment. A second reading of
	* `WAF_AUDIT_STRICT` beside this one is a second chance to disagree with the recorder that is
	* actually enforcing it, and the disagreement would surface as a page confidently reporting a
	* posture the app is not in.
	*/
	get posture() {
		return this.options.posture ?? "record-and-continue";
	}
	/**
	* Refuses an act this install could not account for, before the act happens.
	*
	* Called by the gate rather than by each route, in the same place and for the same reason the
	* permission check is: a change nobody could record should not be validated, stored or partially
	* applied first. It resolves without touching the database in the default posture, so the round
	* trip is paid for only by the installs that asked for it.
	*
	* The header on this file says what the reading proves and what it does not. In short: the trail's
	* head comes back, so the table is reachable through the pool that would carry the insert. An
	* insert that would have been refused on its own terms is not covered, and that is why the close
	* keeps counting in this posture too.
	*/
	async refuseIfUnrecordable() {
		if (this.posture !== "strict") return;
		try {
			await this.log.head();
		} catch (cause) {
			this.options.onError?.("reach the trail, so the action was refused", cause);
			throw new TrailUnwritableError(cause);
		}
	}
	/**
	* The log this writes to, for the surface that reads it back.
	*
	* Reached through the recorder rather than passed to the API a second time, so there is one log by
	* construction. Two references would be two chances to wire the trail page to a different log from
	* the one the routes append to — a page that is always empty and never wrong, which is the one
	* failure mode an audit surface must not have.
	*/
	get trail() {
		return this.log;
	}
	/**
	* Counting in both postures, which is not an oversight.
	*
	* A strict install reaches here having already passed `refuseIfUnrecordable`, so an append that
	* fails now is one the check could not foresee — and the act it describes has happened. Rethrowing
	* would fail a response for a change that is in the database, which is the dishonest order the
	* amendment to ADR 0046 exists to avoid. So it is counted, and the health surface names the
	* posture beside the count so a strict install's non-zero reads as the gap it is.
	*/
	async record(event) {
		try {
			await this.log.append(event);
		} catch (error) {
			this.lost += 1;
			this.options.onError?.(`record that ${event.actor} ${event.outcome} ${event.action}`, error);
		}
	}
	mintId() {
		return (this.options.newId ?? (() => crypto.randomUUID()))();
	}
};
/**
* Binds an act's close to the end of the response, and hands the act back.
*
* The net described on `settle`, in one place so that neither a route nor a test can stand in for it
* with something subtly different. Every act this app opens goes through here.
*
* `close` rather than `finish`, because it fires on an abandoned request as well as a completed one:
* an act the server carried out is recorded whether or not the caller stayed to read the answer. Not
* awaited, because there is nobody left to await it — the response is already gone — and `settle`
* resolves rather than throwing however the append went.
*/
function closedWhenAnswered(act, response) {
	response.once("close", () => {
		act.settle(response.statusCode);
	});
	return act;
}
/**
* Why an act failed, in this app's words.
*
* The error's *class* and never its message. `event.ts` is explicit that the log holds identifiers
* and not contents, and an exception message is the single most likely place in this app for a
* connection string, a host name or a fragment of a query to end up — a driver error carries all
* three. A class name says as much as an auditor needs ("it conflicted", "the estate refused it")
* and cannot carry an estate detail into a document that outlives the incident.
*
* The name is checked against an identifier shape rather than trusted, because a thrown value can
* be anything: an object with a crafted `constructor.name` would otherwise write whatever it liked
* into an audit row.
*/
function reasonFor(cause) {
	if (typeof cause === "string") return IDENTIFIER.test(cause) ? cause : "unknown";
	const kind = cause?.kind;
	if (typeof kind === "string" && IDENTIFIER.test(kind)) return kind;
	const name = cause?.constructor?.name;
	return typeof name === "string" && IDENTIFIER.test(name) ? name : "unknown";
}
/** What a reason may look like: a class name or a refusal kind, and nothing that reads as prose. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9-]{0,60}$/;
//#endregion
export { AuditRecorder, STRICT_ENV, TrailUnwritableError, closedWhenAnswered, postureFrom, reasonFor };
