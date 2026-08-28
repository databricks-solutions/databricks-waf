import { currentVersion } from "../define/definition.js";
import { PLAN_VARIANTS, PLAN_VARIANT_SHAPES, planVariantOf } from "../export/plan-document.js";
import { DIGEST_HEADER, howToCheck, sealPlan } from "../export/artefact.js";
import { UnknownAdviceError, adviceFrom } from "../improve/advice.js";
import { InvalidActionError, draftFrom, moved, movesFor, revised } from "../improve/action.js";
import { adviceReadingOf } from "../improve/advice-reading.js";
import { valueOf } from "../improve/value.js";
import { InvalidPlanError, closed, draftFrom as draftFrom$1 } from "../improve/plan.js";
import { planProgress, progressOf } from "../improve/progress.js";
import { ConcurrentChangeError, MismatchedPlanError } from "../improve/store.js";
import { assessmentOf, scopedHref } from "./assessment-query.js";
//#region server/api/improve-routes.ts
const NO_STORE = "This installation is not keeping improvement plans, so there is nowhere to put one. Bind a database and restart, and the plans you open will survive a deploy.";
const NOT_DURABLE = "Improvement plans are being kept in memory on this installation, so a restart loses every plan and every action in it. A plan is a fortnight of agreements between people about who is doing what, and nothing in the estate can reconstruct it — bind a database before using this in earnest.";
function registerImproveRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	/** What the estate says, and when "now" is, for one response. See `judgedAgainst`. */
	const judged = (request) => judgedAgainst(options, now(), assessmentOf(request));
	/**
	* Every plan, with the rollup of its actions.
	*
	* Closed plans included, like the definitions list and for the same reason: a closed plan is the
	* record of a period, and last quarter's is exactly the one somebody is looking for.
	*
	* The actions themselves are not sent. A list page shows counts and the three lists that matter —
	* contradicted, overdue, blocked — and sending every action of every plan would grow with the
	* programme rather than with the page.
	*/
	app.get("/api/improvements", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.json({
				durable: false,
				durabilityNote: NO_STORE,
				plans: [],
				minProse: 20
			});
			return;
		}
		try {
			const scope = assessmentOf(request);
			const plans = await store.plans(scope);
			const context = await judged(request);
			const actions = await Promise.all(plans.map((plan) => store.actions(plan.id, scope)));
			const payload = {
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE },
				plans: plans.map((plan, index) => presentPlan(plan, actions[index] ?? [], context)),
				...context.measuredAt != null ? { measuredAt: context.measuredAt } : {},
				...await valuePayload(actions.flat(), context, options, scope),
				minProse: 20
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	app.post("/api/improvements", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(503).json({
				error: "improvements-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await options.permitted(request, response, "plan.open");
			const { actor } = permission;
			act = permission.act;
			const draft = draftFrom$1(request.body, { knownAssessment: await assessmentReader(options) });
			const assessment = draft.assessment ?? await citedFromQuery(request, options);
			const plan = {
				...draft,
				...assessment != null ? { assessment } : {},
				id: newId(),
				createdBy: actor,
				createdAt: now(),
				revision: 0
			};
			await store.addPlan(plan);
			await act.performed({
				kind: "plan",
				id: plan.id
			});
			response.status(201).json(dated(presentPlan(plan, [], await judged(request))));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Every action currently raised, so a page that lists many requirements can ask once.
	*
	* Registered before `/:id` because `raised` is one path segment and would otherwise be read as a
	* plan id. The per-requirement route stays: a findings pane that shows one control still asks
	* about that control.
	*/
	app.get("/api/improvements/raised", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.json({
				actions: [],
				durable: false,
				durabilityNote: NO_STORE,
				minProse: 20
			});
			return;
		}
		try {
			const actions = await store.actionsRaised(assessmentOf(request));
			const context = await judged(request);
			const payload = {
				actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE },
				...context.measuredAt != null ? { measuredAt: context.measuredAt } : {},
				minProse: 20
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/** One plan and every action in it, which is what the plan's own page reads. */
	app.get("/api/improvements/:id", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(404).json({
				error: "unknown-plan",
				message: NO_STORE
			});
			return;
		}
		try {
			const id = request.params.id ?? "";
			const plan = await store.plan(id, assessmentOf(request));
			if (plan == null) {
				response.status(404).json({
					error: "unknown-plan",
					message: `No improvement plan with id ${id}.`
				});
				return;
			}
			const actions = await store.actions(id, assessmentOf(request));
			const context = await judged(request);
			const payload = {
				plan: presentPlan(plan, actions, context),
				actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE },
				...context.measuredAt != null ? { measuredAt: context.measuredAt } : {},
				minProse: 20
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* Closes a plan, which is refused while any action in it is still live.
	*
	* Closed rather than deleted, and the refusal is the plan's only rule of its own — `plan.ts` says
	* why a closed plan with live actions under it is the state a programme review is misled by.
	*/
	app.post("/api/improvements/:id/close", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(503).json({
				error: "improvements-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const id = request.params.id ?? "";
			const target = {
				kind: "plan",
				id
			};
			const permission = await options.permitted(request, response, "plan.close", { target });
			const { actor } = permission;
			act = permission.act;
			const plan = await store.plan(id, assessmentOf(request));
			if (plan == null) {
				await refuse(response, act, 404, "unknown-plan", `No improvement plan with id ${id}.`);
				return;
			}
			const reason = reasonFrom(request.body);
			const shut = closed(plan, await store.actions(id, assessmentOf(request)), {
				by: actor,
				reason,
				at: now()
			});
			await store.changePlan(shut);
			await act.performed(target);
			response.json(dated(presentPlan(shut, await store.actions(id, assessmentOf(request)), await judged(request))));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Raises an action in a plan.
	*
	* The plan is read first, and a closed one is refused: adding work to a closed plan would make its
	* rollup wrong the moment it was written, and the honest answer is that the plan has to be reopened —
	* which it cannot be, so the work belongs in a new one.
	*/
	app.post("/api/improvements/:id/actions", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(503).json({
				error: "improvements-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const planId = request.params.id ?? "";
			const permission = await options.permitted(request, response, "action.raise", { target: {
				kind: "plan",
				id: planId
			} });
			const { actor } = permission;
			act = permission.act;
			const plan = await store.plan(planId, assessmentOf(request));
			if (plan == null) {
				await refuse(response, act, 404, "unknown-plan", `No improvement plan with id ${planId}.`);
				return;
			}
			if (plan.closed != null) {
				await refuse(response, act, 409, "plan-closed", `This plan was closed on ${plan.closed.at.toISOString().slice(0, 10)}. Raise the action in an open plan, so that what the plan reports finished stays true.`);
				return;
			}
			const siblings = await store.actions(planId, assessmentOf(request));
			const adviceFor = await adviceReader(request, options);
			const action = {
				...draftFrom({
					...asObject(request.body),
					planId
				}, {
					knownControl: options.knownControl,
					siblings,
					now: now(),
					...adviceFor != null ? { adviceFor } : {}
				}),
				id: newId(),
				state: "draft",
				createdBy: actor,
				createdAt: now(),
				history: [],
				revision: 0
			};
			await store.addAction(action, plan);
			await act.performed({
				kind: "action",
				id: action.id
			});
			response.status(201).json(dated(presentAction(progressOf(action, await judged(request)), options)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Replaces the revisable fields of an action.
	*
	* A whole replacement rather than a patch, for the reason `revised` gives. What it refuses is in the
	* domain: nothing about a verified or cancelled action, and nothing about what a live action is *for*
	* — only who is doing it, how much it matters, by when, and in what steps.
	*/
	app.put("/api/improvements/:id/actions/:actionId", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(503).json({
				error: "improvements-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const planId = request.params.id ?? "";
			const actionId = request.params.actionId ?? "";
			const target = {
				kind: "action",
				id: actionId
			};
			act = (await options.permitted(request, response, "action.revise", { target })).act;
			const plan = await store.plan(planId, assessmentOf(request));
			const action = await store.action(actionId, assessmentOf(request));
			if (plan == null || action == null || action.planId !== planId) {
				await refuse(response, act, 404, "unknown-action", `Plan ${planId} has no action with id ${actionId}.`);
				return;
			}
			if (plan.closed != null) {
				await refuse(response, act, 409, "plan-closed", "This plan is closed, so what it reports finished has to stay as it was. Revise the work in an open plan.");
				return;
			}
			const siblings = (await store.actions(planId, assessmentOf(request))).filter((sibling) => sibling.id !== actionId);
			const after = revised(action, request.body, {
				knownControl: options.knownControl,
				siblings,
				now: now()
			});
			await store.changeAction(after, plan);
			await act.performed(target);
			response.json(dated(presentAction(progressOf(after, await judged(request)), options)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Moves an action to another state.
	*
	* One route for all six person-made moves rather than a route per verb, because the rule about which
	* moves are legal lives in one table in the domain and a route per verb would be six places that
	* each have to agree with it. `verified` is refused here by the same table, and that refusal is the
	* point rather than an omission.
	*/
	app.post("/api/improvements/:id/actions/:actionId/move", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(503).json({
				error: "improvements-unavailable",
				message: NO_STORE
			});
			return;
		}
		let act;
		try {
			const planId = request.params.id ?? "";
			const actionId = request.params.actionId ?? "";
			const target = {
				kind: "action",
				id: actionId
			};
			const permission = await options.permitted(request, response, "action.move", { target });
			const { actor } = permission;
			act = permission.act;
			const plan = await store.plan(planId, assessmentOf(request));
			const action = await store.action(actionId, assessmentOf(request));
			if (plan == null || action == null || action.planId !== planId) {
				await refuse(response, act, 404, "unknown-action", `Plan ${planId} has no action with id ${actionId}.`);
				return;
			}
			if (plan.closed != null) {
				await refuse(response, act, 409, "plan-closed", "This plan is closed, so what it reports finished has to stay as it was. Move the work in an open plan.");
				return;
			}
			const body = asObject(request.body);
			const to = stateFrom(body.to);
			const reason = typeof body.reason === "string" ? body.reason : void 0;
			const after = moved(action, {
				to,
				who: actor,
				at: now(),
				...reason != null ? { reason } : {}
			});
			await store.changeAction(after, plan);
			await act.performed(target);
			response.json(dated(presentAction(progressOf(after, await judged(request)), options)));
		} catch (cause) {
			await act?.failed(cause);
			respond(response, cause, options);
		}
	});
	/**
	* Actions naming one requirement, across every plan.
	*
	* What a findings page asks: this requirement is failing, is it already somebody's work? Every plan
	* rather than the one being read, because the plan the action is in is rarely the one the reader
	* came from.
	*/
	app.get("/api/improvements/for/:controlId", async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.json({
				actions: [],
				durable: false,
				durabilityNote: NO_STORE,
				minProse: 20
			});
			return;
		}
		try {
			const controlId = request.params.controlId ?? "";
			const actions = await store.actionsFor(controlId, assessmentOf(request));
			const context = await judged(request);
			const payload = {
				actions: sorted(actions).map((action) => presentAction(progressOf(action, context), options)),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.improvementStorage ?? NOT_DURABLE },
				...context.measuredAt != null ? { measuredAt: context.measuredAt } : {},
				minProse: 20
			};
			response.json(dated(payload));
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
	/**
	* The plan this export is about, or a 404 already sent.
	*
	* Shared by the three routes below so that a download and the digest published for it cannot end up
	* reading different plans — which is the failure that would be read as tampering.
	*/
	const exportSubject = async (request, response) => {
		const store = options.improvements;
		if (store == null) {
			response.status(404).json({
				error: "unknown-plan",
				message: NO_STORE
			});
			return;
		}
		const id = request.params.id ?? "";
		const scope = assessmentOf(request);
		const plan = await store.plan(id, scope);
		if (plan == null) {
			response.status(404).json({
				error: "unknown-plan",
				message: `No improvement plan with id ${id}.`
			});
			return;
		}
		const context = await judgedAgainst(options, now(), scope);
		const actions = sorted(await store.actions(id, scope));
		return {
			plan,
			actions: actions.map((action) => progressOf(action, context)),
			progress: planProgress(plan.id, actions, context),
			titleOf: options.titleOf,
			...context.runId != null && context.measuredAt != null ? { judgedAgainst: {
				runId: context.runId,
				at: context.measuredAt
			} } : {}
		};
	};
	/**
	* The plan as a file.
	*
	* A read that is recorded, for the reason `event.ts` gives about exports generally: it is the one
	* read that produces an artefact which outlives the app and travels outside the customer. A plan is
	* the sharper case of it — an assessment export says what is wrong, and a plan export says what
	* somebody committed to doing about it, which is the document that gets quoted back.
	*/
	const exportPlan = (format) => async (request, response) => {
		try {
			const subject = await exportSubject(request, response);
			if (subject == null) return;
			const variant = planVariantOf(request.query.variant);
			if (variant == null) {
				response.status(400).json({
					error: "unknown-variant",
					message: `This app produces three exports of a plan: ${PLAN_VARIANTS.join(", ")}. Ask for one of those, or omit the parameter for the complete file.`
				});
				return;
			}
			const file = sealPlan({
				...subject,
				format,
				variant
			});
			await options.recordRead?.(request, response, "export.plan", { correlation: subject.plan.id }).performed({
				kind: "artefact",
				id: file.name,
				digest: file.digest
			});
			response.setHeader("Content-Type", file.contentType);
			response.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
			response.setHeader("X-Content-Type-Options", "nosniff");
			response.setHeader(DIGEST_HEADER, file.digest);
			response.send(file.bytes);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	};
	app.get("/api/improvements/:id/export.csv", exportPlan("csv"));
	app.get("/api/improvements/:id/export.json", exportPlan("json"));
	/**
	* What each export of this plan should hash to, without serving one.
	*
	* Not recorded: nothing left the app. The same separation the run's exports have, and for the same
	* reason — a sender who has already mailed a copy needs the value on a page they can read out
	* rather than in the response header of a download they no longer have.
	*
	* Every file is sealed to answer, which is six passes over one plan's actions. Deliberately the same
	* code path the download takes, over the same stored plan, so a published digest cannot drift from
	* the served bytes.
	*/
	app.get("/api/improvements/:id/exports", async (request, response) => {
		try {
			const subject = await exportSubject(request, response);
			if (subject == null) return;
			const fileOf = (variant, format) => {
				const file = sealPlan({
					...subject,
					format,
					variant
				});
				return {
					name: file.name,
					format,
					variant,
					digest: file.digest,
					bytes: file.bytes.byteLength,
					href: scopedHref(variant === "delivery" ? `/api/improvements/${subject.plan.id}/export.${format}` : `/api/improvements/${subject.plan.id}/export.${format}?variant=${variant}`, subject.plan.assessment?.definitionId),
					verify: howToCheck(file)
				};
			};
			const variants = PLAN_VARIANTS.map((variant) => {
				const shape = PLAN_VARIANT_SHAPES[variant];
				return {
					variant,
					says: shape.says,
					...shape.omits != null ? { omits: shape.omits } : {},
					files: ["csv", "json"].map((format) => fileOf(variant, format))
				};
			});
			const current = new Map(variants.flatMap((entry) => entry.files.map((file) => [file.name, file.digest])));
			const payload = {
				planId: subject.plan.id,
				...subject.judgedAgainst != null ? { judgedAgainst: {
					run: subject.judgedAgainst.runId,
					at: subject.judgedAgainst.at.toISOString()
				} } : {},
				variants,
				taken: await options.takenFrom?.("export.plan", subject.plan.id, current) ?? []
			};
			response.json(payload);
		} catch (cause) {
			options.respondToFailure(response, cause);
		}
	});
}
/**
* Resolves an advice reference in this request's body, or nothing where it names none.
*
* The advisory is read here, before the body is validated, because `draftFrom` is synchronous and the
* record is a database read. So the id is taken from the body first and the finding is looked up
* inside it afterwards — which also means a body naming one advisory cannot have its finding resolved
* out of another.
*/
async function adviceReader(request, options) {
	const store = options.advisories;
	if (store == null) return void 0;
	const body = request.body;
	const supplied = body != null && typeof body === "object" ? body.advice : void 0;
	if (supplied == null || typeof supplied !== "object") return void 0;
	const advisoryId = supplied.advisoryId;
	if (typeof advisoryId !== "string" || advisoryId === "") return void 0;
	const advisory = await store.get(advisoryId, assessmentOf(request));
	return (reference) => {
		if (advisory == null || advisory.id !== reference.advisoryId) throw new UnknownAdviceError(`There is no advisory ${reference.advisoryId} in this assessment. An action can only be raised from advice this installation still holds, because the advice is what the action is about.`);
		return adviceFrom(advisory, reference);
	};
}
/**
* The run every agreement in a response is judged against.
*
* The latest run rather than the run a plan was raised from, which is the whole point: the baseline is
* what the plan was written against, and the question a board answers is what the estate says *now*. A
* store with nothing in it yields no findings and no date, and every claim reads `awaiting` — which is
* the honest reading before anything has been measured.
*/
async function judgedAgainst(options, now, scope) {
	const [latest, advised] = await Promise.all([options.store.latest(scope), advisedBy(options, scope)]);
	if (latest == null) return {
		now,
		...advised
	};
	return {
		findings: latest.findings.map((finding) => ({
			controlId: finding.controlId,
			outcome: finding.outcome,
			...finding.attested != null ? { attested: finding.attested } : {}
		})),
		measuredAt: latest.finishedAt,
		runId: latest.id,
		now,
		...advised
	};
}
/**
* The latest advisory as a reading of one action's advice, and the advisor's own totals beside it.
*
* Read once per response and closed over, rather than fetched per action: every action's finding is in
* a different advisory and every reading is against the same latest one, so a lookup per action would
* be the same row fetched as many times as there is work on the board.
*
* Absent where this install keeps no advisories or has run none, which is `unjudged` on every
* advice-raised action and no value figures at all. Not an error: three of the four figures are the
* advisors', and an install without them has nothing to report rather than zeroes to show.
*/
async function advisedBy(options, scope) {
	const store = options.advisories;
	if (store == null) return {};
	const latest = await store.latest(scope);
	if (latest == null) return {};
	return {
		adviceReading: (advice) => adviceReadingOf(advice, latest),
		opportunity: opportunityIn(latest)
	};
}
/**
* The four figures, or nothing where none of them can be read.
*
* Absent rather than empty when this install has no advisory: three of the four come from one, and a
* report showing a posture beside three zeroes would say the estate has nothing to gain — which is a
* claim about the advisors nobody has run.
*
* The posture is the scan's own score restated, read here rather than passed through `AgreementContext`
* because the context is a comparison and this is a figure. Nothing below derives one from the other:
* ADR 0083's prohibition is that no advisor figure moves a score and no score enters the other three,
* and this function is the one place all four are in scope.
*/
async function valuePayload(actions, context, options, scope) {
	if (context.adviceReading == null) return {};
	const latest = await options.store.latest(scope);
	const posture = latest == null ? void 0 : {
		runId: latest.id,
		at: latest.finishedAt,
		...latest.score.overall != null ? { overall: latest.score.overall } : {},
		scoredControls: latest.score.scoredControls,
		totalControls: latest.score.totalControls,
		unmeasured: latest.score.counts.unmeasurable
	};
	return { value: valueOf({
		progress: actions.map((action) => progressOf(action, context)),
		...context.opportunity != null ? { opportunity: context.opportunity } : {},
		...posture != null ? { posture } : {}
	}) };
}
/**
* What the advisors say is available, in their own totals.
*
* One entry, because one advisor prices anything: the serverless analysis, which computes a range
* across the jobs it could price and declares the assumptions it did so under. The other three report
* no money, and an empty entry for each of them would be three zeroes that read as nothing to gain.
*
* The analysis's own total rather than a sum over its jobs. Re-adding them here would produce a second
* number with a different denominator — `estimate.jobs` is the count of jobs it could price, which is
* not the count of jobs with a finding — and two totals with one name is the defect this avoids.
*/
function opportunityIn(advisory) {
	const estimate = advisory.serverless?.estimate;
	if (estimate == null) return [];
	return [{
		advisor: "serverless",
		low: estimate.low,
		high: estimate.high,
		currency: estimate.currency,
		...estimate.region != null ? { region: estimate.region } : {},
		resources: estimate.jobs,
		assumptions: (advisory.serverless?.assumptions ?? []).map((one) => one.statement)
	}];
}
/**
* The assessment the request is in, as a plan citation, when the body did not name one.
*
* The UI posts through `useScopedPath` and does not send an `assessment` field — PlanForm cites the
* run, not the definition. Without this, a plan opened on an assessment is stored unscoped and
* vanishes from the list that created it. The version is the current one when a store is bound, and
* 1 when it is not: a build with no definition store already accepts any citation unchecked, and
* the id is what the filter reads.
*/
async function citedFromQuery(request, options) {
	const id = assessmentOf(request);
	if (id == null) return void 0;
	const store = options.definitions;
	if (store == null) return {
		definitionId: id,
		version: 1
	};
	const definition = await store.get(id);
	if (definition == null) throw new InvalidPlanError(`There is no assessment ${id}.`);
	return {
		definitionId: definition.id,
		version: currentVersion(definition).version
	};
}
/**
* Whether a definition version exists, for the citation on a plan.
*
* Absent when this install keeps no definitions, in which case the citation is accepted unchecked
* rather than refused: a build with no definition store has no way to know, and refusing every
* citation would make a plan unwritable for a reason that has nothing to do with the plan. The
* alternative — accepting silently and calling it verified — is the one to avoid, which is why this
* returns undefined and the domain treats the absence as "not checked".
*/
async function assessmentReader(options) {
	const store = options.definitions;
	if (store == null) return void 0;
	const definitions = await store.all();
	const versions = new Map(definitions.map((one) => [one.id, one.versions.map((version) => version.version)]));
	return (definitionId, version) => versions.get(definitionId)?.includes(version) ?? false;
}
/**
* Newest first, and within a plan that is the order work was raised in reversed.
*
* Sorted here rather than in the store, because the store's contract deliberately promises no order —
* `actionsFor` reads across plans and a durable one reads by revision. The page that needs a different
* order sorts what it was sent.
*
* The id breaks a tie, and that stopped being cosmetic when this order started reaching an export. Two
* actions raised in the same millisecond — one request that seeds a plan from a run does exactly that —
* compare equal, and a stable sort then keeps whatever order the store happened to return. Postgres
* promises none for equal keys, so the same plan could serialise two ways, produce two digests, and have
* the panel report a recipient's unaltered copy as no longer matching.
*/
function sorted(actions) {
	return [...actions].sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime() || left.id.localeCompare(right.id));
}
function presentPlan(plan, actions, context) {
	return {
		id: plan.id,
		title: plan.title,
		outcome: plan.outcome,
		owners: plan.owners,
		...plan.assessment != null ? { assessment: plan.assessment } : {},
		...plan.raisedFrom != null ? { raisedFrom: plan.raisedFrom } : {},
		createdBy: plan.createdBy,
		createdAt: plan.createdAt,
		...plan.closed != null ? { closed: plan.closed } : {},
		progress: progressPayload(planProgress(plan.id, actions, context))
	};
}
/**
* The rollup, field by field rather than passed through.
*
* Written out because the two types are structurally identical today and are allowed to stop being: the
* domain is free to grow a field the wire should not carry, and a spread would carry it silently the
* day somebody adds one.
*/
function progressPayload(progress) {
	return {
		planId: progress.planId,
		states: progress.states,
		contradicted: progress.contradicted,
		overdue: progress.overdue,
		blocked: progress.blocked,
		settled: progress.settled,
		...progress.nextDue != null ? { nextDue: progress.nextDue } : {}
	};
}
function presentAction(progress, options) {
	const { action } = progress;
	return {
		id: action.id,
		planId: action.planId,
		controlIds: action.controlIds,
		outcome: action.outcome,
		definitionOfDone: action.definitionOfDone,
		owner: action.owner,
		priority: action.priority,
		effort: action.effort,
		...action.due != null ? { due: action.due } : {},
		steps: action.steps,
		dependsOn: action.dependsOn,
		state: action.state,
		...action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {},
		...action.advice != null ? { advice: presentAdvice(action.advice) } : {},
		createdBy: action.createdBy,
		createdAt: action.createdAt,
		history: action.history.map(transition),
		agreement: progress.agreement,
		lateness: progress.lateness,
		unmet: progress.unmet,
		unreadable: progress.unreadable,
		...progress.advice != null ? { adviceReading: presentReading(progress.advice) } : {},
		moves: movesFor(action.state),
		titles: Object.fromEntries(action.controlIds.map((id) => [id, options.titleOf(id)]).filter((entry) => entry[1] != null))
	};
}
/**
* The provenance on the wire, field by field for the reason `progressPayload` is written out.
*
* Nothing is summarised here and nothing is computed. A saving inferred from a baseline would be this
* file's arithmetic rather than the advisor's, and a surface that showed it would be quoting a figure
* with no assumptions attached to it — which is the one thing 44b's own note refuses.
*/
function presentAdvice(advice) {
	return {
		advisoryId: advice.advisoryId,
		advisor: advice.advisor,
		rule: advice.rule,
		versions: advice.versions,
		resource: advice.resource,
		headline: advice.headline,
		detail: advice.detail,
		docUrl: advice.docUrl,
		...advice.severity != null ? { severity: advice.severity } : {},
		baseline: advice.baseline,
		...advice.observation != null ? { observation: advice.observation } : {},
		assumptions: advice.assumptions,
		...advice.opportunity != null ? { opportunity: advice.opportunity } : {},
		measuredAt: advice.measuredAt,
		lookbackDays: advice.lookbackDays
	};
}
function presentReading(reading) {
	return {
		advisoryId: reading.advisoryId,
		measuredAt: reading.measuredAt,
		lookbackDays: reading.lookbackDays,
		standing: reading.standing,
		movements: reading.movements,
		unmatched: reading.unmatched,
		...reading.incomparable != null ? { incomparable: reading.incomparable } : {}
	};
}
function transition(entry) {
	return {
		from: entry.from,
		to: entry.to,
		at: entry.at,
		by: entry.by,
		who: entry.who,
		...entry.reason != null ? { reason: entry.reason } : {}
	};
}
/**
* The payload with every date as an ISO string.
*
* One traversal at the edge rather than `toISOString()` at forty field sites, which is the shape the
* rest of the API arrived at the long way round. The payload types are generic in their date so the
* server can hold `Date` and the client reads `string`, and this is the single place the two meet.
*/
function dated(payload) {
	if (payload instanceof Date) return payload.toISOString();
	if (Array.isArray(payload)) return payload.map((entry) => dated(entry));
	if (payload != null && typeof payload === "object") return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
	return payload;
}
/**
* The state a move is asking for, refused rather than defaulted.
*
* `verified` passes this check and is refused by `moved`, deliberately: the sentence a caller needs is
* the domain's one about nobody marking their own work verified, and a parser that rejected the word
* as unknown would tell them it does not exist.
*/
function stateFrom(raw) {
	if (typeof raw !== "string" || raw === "") throw new InvalidActionError("Say which state to move this to, as to.");
	return raw;
}
function reasonFrom(body) {
	const reason = asObject(body).reason;
	if (typeof reason !== "string") throw new InvalidPlanError("Say why the plan is being closed, as reason.");
	return reason;
}
function asObject(body) {
	if (body == null || typeof body !== "object" || Array.isArray(body)) throw new InvalidActionError("This is described by an object.");
	return body;
}
/**
* Answers with a refusal this route decided on, and closes the act with the same word.
*
* The same helper, and the same argument, as `definition-routes.ts`: the body's `error` doubles as the
* audit reason so the two vocabularies cannot drift, and the one that drifts unnoticed is the one in
* the log because nobody reads it until the day it matters.
*/
async function refuse(response, act, status, error, message) {
	await act.failed(error);
	response.status(status).json({
		error,
		message
	});
}
function respond(response, cause, options) {
	if (cause instanceof ConcurrentChangeError) {
		response.status(409).json({
			error: "concurrent-change",
			message: cause.message
		});
		return;
	}
	if (cause instanceof InvalidActionError) {
		response.status(400).json({
			error: "invalid-action",
			message: cause.message
		});
		return;
	}
	if (cause instanceof UnknownAdviceError) {
		response.status(400).json({
			error: "unknown-advice",
			message: cause.message
		});
		return;
	}
	if (cause instanceof InvalidPlanError) {
		response.status(400).json({
			error: "invalid-plan",
			message: cause.message
		});
		return;
	}
	if (cause instanceof MismatchedPlanError) {
		options.respondToFailure(response, cause);
		return;
	}
	options.respondToFailure(response, cause);
}
//#endregion
export { registerImproveRoutes };
