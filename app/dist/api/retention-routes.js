import { DEFAULT_PERIOD_DAYS, EXEMPT, MAX_PERIOD_DAYS, RETENTION_CLASSES, holdRefusal, holdTarget, periodRefusal, planRetention, sweepRetention } from "../admin/retention.js";
import { InstallHeld, planReset, resetInstall } from "../admin/reset.js";
//#region server/api/retention-routes.ts
const NOTHING_KEPT = "This install stores nothing that outlives a restart, so there is no retention period to set and nothing to remove. Everything it holds is in memory and is gone when the app stops. Bind a Lakebase instance and the policy below begins to apply from that point.";
function eligibilityOf(one) {
	return {
		table: one.table,
		holds: one.holds,
		total: one.total,
		eligible: one.eligible,
		...one.oldest != null ? { oldest: one.oldest.toISOString() } : {}
	};
}
function classOf(planned) {
	return {
		retentionClass: planned.retentionClass,
		periodDays: planned.periodDays,
		defaultDays: DEFAULT_PERIOD_DAYS[planned.retentionClass],
		cutoff: planned.cutoff.toISOString(),
		heldBy: planned.heldBy.map((hold) => hold.id),
		tables: planned.tables.map(eligibilityOf)
	};
}
function holdOf(hold) {
	return {
		id: hold.id,
		reason: hold.reason,
		covers: hold.covers,
		placedBy: hold.placedBy,
		placedAt: hold.placedAt.toISOString(),
		...hold.releasedBy != null ? { releasedBy: hold.releasedBy } : {},
		...hold.releasedAt != null ? { releasedAt: hold.releasedAt.toISOString() } : {}
	};
}
function resetPlanOf(plan) {
	return {
		tables: plan.tables.map((one) => ({
			table: one.table,
			holds: one.holds,
			swept: one.swept,
			rows: one.rows
		})),
		records: plan.records,
		events: plan.events,
		heldBy: plan.heldBy.map((hold) => hold.id)
	};
}
/**
* The holds in force, as one comparable string.
*
* Only the ones still in force, and only their ids: a hold whose reason was edited preserves the same
* classes, and refusing a sweep over that would be refusing over a typo. What matters is whether the
* set of things saying "do not delete this" is the set the plan was computed from.
*/
function heldIds(holds) {
	return holds.filter((hold) => hold.releasedAt == null).map((hold) => hold.id).sort().join(" ");
}
/**
* The periods from a request body, or a refusal.
*
* A partial map rather than all three, so setting one class does not require the caller to restate
* the other two — which would make a page that had read a stale policy silently reset them.
*/
function periodsFrom(body) {
	if (typeof body !== "object" || body == null) return { refusal: "A period change is an object of retention classes to whole numbers of days." };
	const periods = {};
	const asked = body.periods;
	const source = typeof asked === "object" && asked != null ? asked : {};
	for (const [key, value] of Object.entries(source)) {
		const retentionClass = RETENTION_CLASSES.find((one) => one === key);
		if (retentionClass == null) return { refusal: `\`${key}\` is not something this app retains. The classes are ${RETENTION_CLASSES.join(", ")}.` };
		const refusal = periodRefusal(value);
		if (refusal != null) return { refusal };
		periods[retentionClass] = value;
	}
	if (Object.keys(periods).length === 0) return { refusal: `Nothing was asked for. Name at least one of ${RETENTION_CLASSES.join(", ")}.` };
	return { periods };
}
function registerRetentionRoutes(app, options) {
	const at = () => (options.now ?? (() => /* @__PURE__ */ new Date()))();
	const mintId = () => (options.newId ?? (() => crypto.randomUUID()))();
	/**
	* The policy, what it makes eligible, and what is being held.
	*
	* One request rather than three, because the three are only meaningful together: a period without
	* the counts cannot be judged, and counts without the holds would show rows as due for removal that
	* nothing will remove.
	*/
	app.get("/api/retention", async (_request, response) => {
		const retention = options.retention;
		if (retention == null) {
			const empty = {
				durable: false,
				classes: [],
				holds: [],
				exempt: EXEMPT.map((one) => ({ ...one })),
				wouldRemove: 0,
				bounds: {
					least: 1,
					most: MAX_PERIOD_DAYS
				},
				unavailable: NOTHING_KEPT
			};
			response.json(empty);
			return;
		}
		try {
			const policy = await retention.store.policy();
			const holds = await retention.store.holds();
			const now = at();
			const plan = await planRetention(retention.gateway, policy, holds, now);
			const reset = await planReset(retention.gateway, holds, now);
			const payload = {
				durable: true,
				at: plan.at.toISOString(),
				...policy.setBy != null ? { setBy: policy.setBy } : {},
				...policy.setAt != null ? { setAt: policy.setAt.toISOString() } : {},
				classes: plan.classes.map(classOf),
				holds: holds.map(holdOf),
				exempt: plan.exempt.map((one) => ({ ...one })),
				wouldRemove: plan.wouldRemove,
				bounds: {
					least: 1,
					most: MAX_PERIOD_DAYS
				},
				reset: resetPlanOf(reset)
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** How long each class is kept. */
	app.put("/api/retention/periods", async (request, response) => {
		const retention = options.retention;
		let act;
		try {
			const who = await options.permitted(request, response, "retention.configure");
			act = who.act;
			if (retention == null) {
				await act.failed("nothing-retained");
				response.status(409).json({
					error: "nothing-retained",
					message: NOTHING_KEPT
				});
				return;
			}
			const parsed = periodsFrom(request.body);
			if ("refusal" in parsed) {
				await act.failed("bad-period");
				response.status(400).json({
					error: "bad-period",
					message: parsed.refusal
				});
				return;
			}
			await retention.store.setPeriods(parsed.periods, who.actor, at());
			await act.performed();
			response.status(204).end();
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
	/** A reason not to delete something, placed by a named person. */
	app.post("/api/retention/holds", async (request, response) => {
		const retention = options.retention;
		let act;
		try {
			const who = await options.permitted(request, response, "retention.hold");
			act = who.act;
			if (retention == null) {
				await act.failed("nothing-retained");
				response.status(409).json({
					error: "nothing-retained",
					message: NOTHING_KEPT
				});
				return;
			}
			const body = typeof request.body === "object" && request.body != null ? request.body : {};
			const refusal = holdRefusal(body.reason, body.covers);
			if (refusal != null) {
				await act.failed("bad-hold");
				response.status(400).json({
					error: "bad-hold",
					message: refusal
				});
				return;
			}
			const hold = {
				id: mintId(),
				reason: body.reason.trim(),
				covers: body.covers,
				placedBy: who.actor,
				placedAt: at()
			};
			await retention.store.place(hold);
			await act.performed(holdTarget(hold.id));
			response.status(201).json(holdOf(hold));
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Lifting a hold.
	*
	* A `post` to `release` rather than a `delete` of the hold, because the hold is not deleted: the row
	* stays, with who lifted it and when. "There was a hold on this from March to July" is the question
	* somebody asks about a record that is unexpectedly still here, and a `delete` would be the verb for
	* an operation that made that unanswerable.
	*/
	app.post("/api/retention/holds/:id/release", async (request, response) => {
		const retention = options.retention;
		const id = request.params.id;
		let act;
		try {
			const who = await options.permitted(request, response, "retention.release", { target: holdTarget(id) });
			act = who.act;
			if (retention == null) {
				await act.failed("nothing-retained");
				response.status(409).json({
					error: "nothing-retained",
					message: NOTHING_KEPT
				});
				return;
			}
			if (!await retention.store.release(id, who.actor, at())) {
				await act.failed("not-in-force");
				response.status(409).json({
					error: "not-in-force",
					message: `There is no hold \`${id}\` still in force. Either it was never placed, or somebody lifted it first — the trail records which, and the hold itself keeps who lifted it.`
				});
				return;
			}
			await act.performed();
			response.status(204).end();
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Removing what is past its period.
	*
	* The only irreversible act this app performs, so it is the only one that asks the caller to state
	* what they expect it to do. `expect` is the row count the plan showed them; a disagreement means the
	* ground moved between reading and asking, and the answer to that is a refusal carrying the new plan
	* rather than a deletion of whatever is there now.
	*/
	app.post("/api/retention/sweep", async (request, response) => {
		const retention = options.retention;
		let act;
		try {
			const who = await options.permitted(request, response, "retention.sweep");
			act = who.act;
			if (retention == null) {
				await act.failed("nothing-retained");
				response.status(409).json({
					error: "nothing-retained",
					message: NOTHING_KEPT
				});
				return;
			}
			const expected = request.body?.expect;
			if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
				await act.failed("unconfirmed");
				response.status(400).json({
					error: "unconfirmed",
					message: "A sweep has to be confirmed with the number of records it is expected to remove, as `expect`. This is the one action here that cannot be undone, and the number is what proves the caller is acting on a plan they have read."
				});
				return;
			}
			const now = at();
			const policy = await retention.store.policy();
			const holds = await retention.store.holds();
			const plan = await planRetention(retention.gateway, policy, holds, now);
			if (plan.wouldRemove !== expected) {
				await act.failed("plan-moved");
				response.status(409).json({
					error: "plan-moved",
					message: `The plan now removes ${String(plan.wouldRemove)} records rather than the ${String(expected)} that were confirmed. Nothing was removed. Read the plan again — a period may have been changed, a hold placed or lifted, or a scan finished since it was shown.`,
					wouldRemove: plan.wouldRemove
				});
				return;
			}
			const inForce = await retention.store.holds();
			if (heldIds(inForce) !== heldIds(holds)) {
				await act.failed("holds-moved");
				response.status(409).json({
					error: "plan-moved",
					message: "A legal hold was placed or lifted while this sweep was being prepared. Nothing was removed. Read the plan again — it will show what the hold now preserves.",
					wouldRemove: plan.wouldRemove
				});
				return;
			}
			const sweep = await sweepRetention(retention.gateway, policy, inForce, who.actor, now);
			await act.performed();
			const payload = {
				at: sweep.at.toISOString(),
				by: sweep.by,
				removed: sweep.removed,
				removals: sweep.removals.map((removal) => ({
					table: removal.table,
					retentionClass: removal.retentionClass,
					removed: removal.removed,
					before: removal.before.toISOString()
				})),
				held: sweep.held.map((one) => ({
					retentionClass: one.retentionClass,
					holds: one.holds
				})),
				...sweep.auditFloor != null ? { auditFloor: sweep.auditFloor } : {}
			};
			response.json(payload);
		} catch (cause) {
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Emptying the install.
	*
	* Confirmed with `expect`, like the sweep, and for the same reason — but against the record count
	* rather than the total, because the total includes the trail and the trail grows every time
	* anybody does anything. A refused reset records itself, so a caller retrying with the number the
	* refusal quoted would be refused again, by one, forever. The plan's `records` does not move under
	* the app's own bookkeeping.
	*
	* The order at the end is the whole act. The tables are emptied, `audit_events` among them, and only
	* then is the act closed — so the event this route writes lands in an empty log at sequence 1, naming
	* genesis as its predecessor. That event *is* the chain's new root, which is why nothing here appends
	* a second one to say a reset happened: a purpose-built "genesis" event beside the act's own would be
	* two records of one act, and the second would be the one nothing verified against a permission
	* check. ADR 0048's amendment.
	*/
	app.post("/api/retention/reset", async (request, response) => {
		const retention = options.retention;
		let act;
		try {
			const who = await options.permitted(request, response, "retention.reset");
			act = who.act;
			if (retention == null) {
				await act.failed("nothing-retained");
				response.status(409).json({
					error: "nothing-retained",
					message: NOTHING_KEPT
				});
				return;
			}
			const expected = request.body?.expect;
			if (typeof expected !== "number" || !Number.isInteger(expected) || expected < 0) {
				await act.failed("unconfirmed");
				response.status(400).json({
					error: "unconfirmed",
					message: "A reset has to be confirmed with the number of records it is expected to remove, as `expect`. That is the count the plan reports as `records`, which is everything except the audit trail — the trail goes too, and its size moves whenever anybody does anything."
				});
				return;
			}
			const now = at();
			const holds = await retention.store.holds();
			const plan = await planReset(retention.gateway, holds, now);
			if (plan.heldBy.length > 0) {
				await act.failed("held");
				response.status(409).json({
					error: "held",
					message: `A legal hold is in force (${plan.heldBy.map((hold) => hold.id).join(", ")}), and a reset does not override one. Nothing was removed. Lift the hold first — which is itself recorded, and is the point: somebody decided this had to be preserved.`,
					heldBy: plan.heldBy.map((hold) => hold.id)
				});
				return;
			}
			if (plan.records !== expected) {
				await act.failed("plan-moved");
				response.status(409).json({
					error: "plan-moved",
					message: `This install now holds ${String(plan.records)} records rather than the ${String(expected)} that were confirmed. Nothing was removed. Read the page again — a run may have finished, or somebody may have answered a requirement, since it was shown.`,
					records: plan.records
				});
				return;
			}
			const inForce = await retention.store.holds();
			if (heldIds(inForce) !== heldIds(holds)) {
				await act.failed("held");
				const standing = inForce.filter((hold) => hold.releasedAt == null).map((hold) => hold.id);
				const placed = standing.filter((id) => !holds.some((hold) => hold.id === id && hold.releasedAt == null));
				response.status(409).json({
					error: "held",
					message: placed.length > 0 ? "A legal hold was placed while this reset was being prepared. Nothing was removed. Read the page again — it will show what the hold now preserves." : "The legal holds changed while this reset was being prepared, so it was refused rather than run against an install other than the one confirmed. Nothing was removed, and nothing is held now: read the page again and it will go through.",
					heldBy: standing
				});
				return;
			}
			const reset = await resetInstall(retention.gateway, () => retention.store.holds(), who.actor, now);
			await act.performed(void 0, {
				rows: reset.rows,
				tables: reset.tables
			});
			const payload = {
				at: reset.at.toISOString(),
				by: reset.by,
				emptied: reset.emptied.map((one) => ({
					table: one.table,
					removed: one.removed
				})),
				rows: reset.rows,
				tables: reset.tables
			};
			response.json(payload);
		} catch (cause) {
			if (cause instanceof InstallHeld) {
				await act?.failed("held");
				response.status(409).json({
					error: "held",
					message: "A legal hold was placed while this reset was running, and it takes precedence. Nothing was removed. Read the page again — it will show what the hold now preserves.",
					heldBy: cause.holds.map((hold) => hold.id)
				});
				return;
			}
			await act?.failed(cause);
			options.respondToFailure(response, cause);
		}
	});
}
//#endregion
export { registerRetentionRoutes };
