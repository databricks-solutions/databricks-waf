import { ADVISORS } from "./advice.js";
//#region server/improve/action.ts
const ACTION_STATES = [
	"draft",
	"planned",
	"in-progress",
	"blocked",
	"ready-for-validation",
	"verified",
	"cancelled"
];
const MOVES = {
	draft: [{
		to: "planned",
		by: "person"
	}, {
		to: "cancelled",
		by: "person"
	}],
	planned: [
		{
			to: "in-progress",
			by: "person"
		},
		{
			to: "blocked",
			by: "person"
		},
		{
			to: "draft",
			by: "person"
		},
		{
			to: "cancelled",
			by: "person"
		}
	],
	"in-progress": [
		{
			to: "ready-for-validation",
			by: "person"
		},
		{
			to: "blocked",
			by: "person"
		},
		{
			to: "cancelled",
			by: "person"
		}
	],
	blocked: [{
		to: "in-progress",
		by: "person"
	}, {
		to: "cancelled",
		by: "person"
	}],
	"ready-for-validation": [
		{
			to: "verified",
			by: "run"
		},
		{
			to: "in-progress",
			by: "person"
		},
		{
			to: "blocked",
			by: "person"
		},
		{
			to: "cancelled",
			by: "person"
		}
	],
	verified: [],
	cancelled: []
};
/** The states from which a person can move an action, for a form that has to render buttons. */
function movesFor(state) {
	return MOVES[state].filter((move) => move.by === "person").map((move) => move.to);
}
const EFFORTS = [
	"small",
	"medium",
	"large",
	"programme"
];
const PRIORITIES = [
	"now",
	"next",
	"later"
];
var InvalidActionError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "InvalidActionError";
	}
};
/**
* The moves that mean nothing without a sentence beside them.
*
* Both are moves away from the work happening: blocked is a claim about somebody else, and cancelled
* is a decision that the requirement is not going to be answered this way. Each is the kind of thing
* a colleague inherits and cannot interpret. The moves *towards* work — planned, in progress, ready
* — do not need one, because the state itself is the whole statement and demanding prose for every
* move is how a lifecycle acquires a field full of "as discussed".
*/
function needsReason(to) {
	return to === "blocked" || to === "cancelled";
}
/**
* The action after a person's move, or an error naming what is wrong with it.
*
* Returns a new action rather than mutating, so a caller that refuses to persist the result leaves
* the record as it was. Every refusal names both states, because "invalid transition" in a log tells
* whoever reads it nothing about which of the two ends was the surprise.
*/
function moved(action, request) {
	const at = request.at ?? /* @__PURE__ */ new Date();
	const permitted = MOVES[action.state].find((move) => move.to === request.to);
	if (permitted == null) throw new InvalidActionError(refusalFor(action.state, request.to));
	if (permitted.by === "run") throw new InvalidActionError("Nobody can mark their own work verified. An action becomes verified when a run measures every requirement it names as met, after the owner said it was done — see the improvement progress reading.");
	if (request.to === "planned" && action.definitionOfDone.trim().length < 20) throw new InvalidActionError(`Say what would have to be true for this to be finished, in at least ${String(20)} characters, before planning it. An action nobody can judge finished can only be abandoned or asserted.`);
	if (request.to === "planned" && action.due == null) throw new InvalidActionError("Give the date this is expected by, as due, before planning it.");
	const reason = request.reason?.trim();
	if (needsReason(request.to) && (reason == null || reason.length < 20)) throw new InvalidActionError(request.to === "blocked" ? `Say what it is blocked on, in at least ${String(20)} characters. A blocker nobody named is a blocker nobody can clear.` : `Say why this is being cancelled, in at least ${String(20)} characters. Cancelling without a reason loses the fact that somebody considered it.`);
	return {
		...action,
		revision: action.revision + 1,
		state: request.to,
		history: [...action.history, {
			from: action.state,
			to: request.to,
			at,
			by: "person",
			who: request.who,
			...reason != null ? { reason } : {}
		}]
	};
}
/**
* The action after a run agreed with it.
*
* Separate from `moved` rather than a flag on it, so that no handler holding a request body can
* reach this path. The caller is the code that has just read a run, and `scanId` is what makes the
* claim checkable afterwards: a verification citing no measurement is somebody's word again.
*/
function verifiedBy(action, scanId, at) {
	if (action.state !== "ready-for-validation") throw new InvalidActionError(`Only an action whose owner has said the work is done can be verified by a run, and this one is ${action.state}.`);
	return {
		...action,
		revision: action.revision + 1,
		state: "verified",
		history: [...action.history, {
			from: action.state,
			to: "verified",
			at,
			by: "run",
			who: scanId
		}]
	};
}
/**
* The action after a later advisory stopped finding what it was raised from.
*
* The counterpart of `verifiedBy` for the actions no scan can speak to. An action about a warehouse's
* size names no requirement in the framework, so the assessment has nothing to agree with; what agrees
* is the advisor reading the estate again and not finding the rule firing on that resource.
*
* Separate from `verifiedBy` rather than a parameter on it for the reason `verifiedBy` is separate from
* `moved`: the two have different callers, and a shared function with a flag is one a future caller can
* pass the wrong way. The stricter half of it is here — an action with no advice may not reach
* `verified` this way, because the only evidence this path has is a finding that has stopped firing,
* and an action that names requirements has requirements that were never measured.
*
* What counts as "stopped finding" is not this function's judgement. `adviceReadingOf` decides it, and
* refuses every reading that could be mistaken for one: a resource the run did not mention, an analysis
* it could not form, a rule this build no longer has.
*/
function clearedBy(action, advisoryId, at) {
	if (action.state !== "ready-for-validation") throw new InvalidActionError(`Only an action whose owner has said the work is done can be verified by an advisory, and this one is ${action.state}.`);
	if (action.advice == null) throw new InvalidActionError("This action was not raised from advisor advice, so an advisory has no finding of its own to stop reporting. It is verified by a run measuring the requirements it names.");
	return {
		...action,
		revision: action.revision + 1,
		state: "verified",
		history: [...action.history, {
			from: action.state,
			to: "verified",
			at,
			by: "advisor",
			who: advisoryId
		}]
	};
}
/**
* Why a particular move is refused, in terms of what the reader was trying to do.
*
* Written out per terminal state rather than as one generic sentence, because the two terminal
* states are refused for opposite reasons and a reader told "cannot move from verified" will assume
* the app has lost their action.
*/
function refusalFor(from, to) {
	if (!ACTION_STATES.includes(to)) return `An action can be ${ACTION_STATES.join(", ")}, and nothing else. There is no state called ${to}.`;
	if (from === "verified") return "A verified action is finished, and a run said so. If the requirement has come back, that is a new finding and a new action rather than a reopening of this one — the history of what was fixed and confirmed has to stay readable.";
	if (from === "cancelled") return "A cancelled action is kept as a record of what was considered, and cannot be restarted. Raise a new one.";
	return `An action that is ${from} can only become ${movesFor(from).join(" or ")}, not ${to}.`;
}
/**
* A draft from an untrusted body, or an error naming the field to fix.
*
* Validated here rather than at the route, so the same rules hold for any caller and the messages
* are written once. Every message says what to do with the form the reader is looking at, because
* "invalid request" is a sentence that has never helped anybody fill one in.
*/
function draftFrom(body, context) {
	const raw = body ?? {};
	const now = context.now ?? /* @__PURE__ */ new Date();
	const planId = text(raw.planId);
	if (planId == null) throw new InvalidActionError("Name the plan this action belongs to, as planId.");
	const advice = adviceFrom(raw.advice, context);
	const controlIds = [...new Set(list(raw.controlIds, "controlIds"))];
	if (controlIds.length === 0 && advice == null) throw new InvalidActionError("Name at least one requirement this action is about, as controlIds, or the advisor finding it came from, as advice. An action about neither cannot be found from anything, and nothing can ever say whether it helped.");
	const unknown = controlIds.filter((id) => !context.knownControl(id));
	if (unknown.length > 0) throw new InvalidActionError(`This framework has no requirement with the id ${unknown.join(", ")}.`);
	const outcome = prose(raw.outcome, "outcome", "Say what changes for the business when this is done");
	const definitionOfDone = prose(raw.definitionOfDone, "definitionOfDone", "Say what would have to be true for this to be finished");
	const owner = text(raw.owner);
	if (owner == null) throw new InvalidActionError("Name who is doing this, as owner.");
	const raisedFrom = text(raw.raisedFrom);
	const priority = text(raw.priority);
	if (priority == null || !PRIORITIES.includes(priority)) throw new InvalidActionError(`The priority must be one of ${PRIORITIES.join(", ")}.`);
	const effort = text(raw.effort);
	if (effort == null || !EFFORTS.includes(effort)) throw new InvalidActionError(`The effort must be one of ${EFFORTS.join(", ")}.`);
	return {
		planId,
		controlIds,
		outcome,
		definitionOfDone,
		owner,
		priority,
		effort,
		steps: list(raw.steps, "steps"),
		dependsOn: dependenciesFrom(list(raw.dependsOn, "dependsOn"), context),
		...dueFrom(raw.due, now, context.existingDue),
		...raisedFrom != null ? { raisedFrom } : {},
		...advice != null ? { advice } : {}
	};
}
/**
* The provenance a reference in the body resolves to, or nothing where the body named no finding.
*
* Four strings in and a whole provenance out, and everything between the two comes from the stored
* advisory: what a client sends is which finding, never what the finding said. `advice.ts` sets out
* why, and it is the reason this returns the resolver's answer rather than merging it with the body's.
*/
function adviceFrom(raw, context) {
	if (raw == null) return context.existingAdvice;
	if (typeof raw !== "object" || Array.isArray(raw)) throw new InvalidActionError("The advice this came from is named by an object with an advisoryId, an advisor, a resource and a rule.");
	const supplied = raw;
	const advisoryId = text(supplied.advisoryId);
	const advisor = text(supplied.advisor);
	const resource = text(supplied.resource);
	const rule = text(supplied.rule);
	if (advisoryId == null || advisor == null || resource == null || rule == null) throw new InvalidActionError("Name all four of advisoryId, advisor, resource and rule in advice. Three of them find the finding and the fourth says which advisory said it, and a reference short of one names a set rather than a thing.");
	if (!ADVISORS.includes(advisor)) throw new InvalidActionError(`The advisor must be one of ${ADVISORS.join(", ")}.`);
	if (context.adviceFor == null) throw new InvalidActionError("This installation is not keeping advisories, so there is nothing to check this reference against. An action recording advice that cannot be looked up reads as checkable and is not.");
	return context.adviceFor({
		advisoryId,
		advisor,
		resource,
		rule
	});
}
/**
* The fields a revision may not touch once the action has left `draft`.
*
* What an action is *about* — which requirements, what outcome, what would count as done — is the part
* colleagues agreed to and the part a run is later measured against. Editing it in place would make
* every earlier reading of this action a reading of something else: a board that showed three weeks of
* work against a definition of done nobody worked to, and a `verified` further down that cited a run
* which agreed with different criteria.
*
* So while an action is a draft, all of it is editable, and afterwards these three are not. The way to
* change them is the way the lifecycle already provides: `planned` moves back to `draft`, and work
* further along is cancelled with a reason and raised again — which keeps the fact that the first
* version existed.
*/
const SETTLED_BY_AGREEMENT = [
	"controlIds",
	"outcome",
	"definitionOfDone"
];
/**
* The action after somebody corrected it, or an error naming what may not be corrected.
*
* A whole replacement rather than a patch, and the body is validated by `draftFrom` — the same rules,
* the same sentences, one place. A patch would have to decide what an absent `steps` means, and both
* answers are wrong often enough to lose somebody's work.
*
* The identity of the action survives: id, plan, state, history, and who raised it when. A revision is
* not a transition, so nothing is appended to `history`; what changed and who changed it is in the
* audit log, where `action.revise` names it.
*/
function revised(action, body, context) {
	if (action.state === "verified" || action.state === "cancelled") throw new InvalidActionError(action.state === "verified" ? "A verified action is the record of work a run agreed with, and editing it would leave that agreement describing something else. If more is needed, raise a new action." : "A cancelled action is kept as a record of what was considered, and cannot be edited. Raise a new one.");
	const draft = draftFrom({
		...body != null && typeof body === "object" && !Array.isArray(body) ? body : {},
		planId: action.planId,
		...action.raisedFrom != null ? { raisedFrom: action.raisedFrom } : {},
		advice: void 0
	}, {
		...context,
		self: action.id,
		...action.due != null ? { existingDue: action.due } : {},
		...action.advice != null ? { existingAdvice: action.advice } : {}
	});
	if (action.state !== "draft") {
		const changed = SETTLED_BY_AGREEMENT.filter((field) => !same(action[field], draft[field]));
		if (changed.length > 0) throw new InvalidActionError(`An action that is ${action.state} cannot have its ${changed.join(", ")} changed, because that is what people agreed to and what a run will be measured against. Move it back to draft if it is still only planned, or cancel it with a reason and raise the replacement.`);
	}
	const { due: _replaced, ...kept } = action;
	return {
		...kept,
		...draft,
		id: action.id,
		planId: action.planId,
		state: action.state,
		createdBy: action.createdBy,
		createdAt: action.createdAt,
		history: action.history,
		revision: action.revision + 1
	};
}
/** Whether a revisable field is unchanged, comparing lists by their members in order. */
function same(before, after) {
	if (typeof before === "string" || typeof after === "string") return before === after;
	return before.length === after.length && before.every((entry, index) => entry === after[index]);
}
/**
* The date, which is optional on a draft and required to plan one.
*
* Optional here on purpose: an action being written down in a workshop does not yet have a date, and
* refusing the draft would send people back to the spreadsheet for the part of the process this is
* meant to replace. `moved` is where it becomes required, because that is where the action stops
* being a note and becomes work somebody has agreed to.
*/
function dueFrom(raw, now, existing) {
	const supplied = text(raw);
	if (supplied == null) return {};
	const due = new Date(supplied);
	if (Number.isNaN(due.getTime())) throw new InvalidActionError("The date must be an ISO date, such as 2026-09-30.");
	if (due.getTime() === existing?.getTime()) return { due };
	if (due.getTime() <= now.getTime()) throw new InvalidActionError("The date has to be in the future. An action that is already late on the day it is written tells the owner nothing, and makes every overdue count meaningless.");
	return { due };
}
/**
* The dependencies, refusing the two that cannot mean anything.
*
* A dependency on an action outside this plan is refused because a plan whose completeness depends
* on work it does not contain cannot report progress — and reporting progress is what a plan is for.
* Where the dependency is real and cross-plan, the honest answer is that the two plans are one, and
* a refusal that says so is better than a field that quietly makes every rollup wrong.
*
* A cycle is refused because it is not a statement about order. Nothing else about a dependency is
* enforced: it does not block a transition, and an owner who starts work early is not doing anything
* this app should have an opinion about.
*/
function dependenciesFrom(supplied, context) {
	const known = new Map(context.siblings.map((sibling) => [sibling.id, sibling.dependsOn]));
	const wanted = [...new Set(supplied)];
	if (context.self != null && wanted.includes(context.self)) throw new InvalidActionError("An action cannot depend on itself.");
	const foreign = wanted.filter((id) => !known.has(id));
	if (foreign.length > 0) throw new InvalidActionError(`An action can only depend on another action in the same plan, and this plan has nothing with the id ${foreign.join(", ")}. If the dependency really is on other work, the two plans are one plan.`);
	if (context.self != null) {
		const seen = /* @__PURE__ */ new Set();
		const pending = [...wanted];
		while (pending.length > 0) {
			const next = pending.pop();
			if (seen.has(next)) continue;
			seen.add(next);
			const onward = known.get(next) ?? [];
			if (onward.includes(context.self)) throw new InvalidActionError(`These dependencies run in a circle: ${next} already waits on this action. A circle is not an order, so nothing in it could ever be first.`);
			pending.push(...onward);
		}
	}
	return wanted;
}
function prose(value, field, instruction) {
	const supplied = text(value);
	if (supplied == null || supplied.length < 20) throw new InvalidActionError(`${instruction}, as ${field}, in at least ${String(20)} characters.`);
	return supplied;
}
function text(value) {
	if (typeof value !== "string") return void 0;
	const trimmed = value.trim();
	return trimmed === "" ? void 0 : trimmed;
}
/**
* Strings from an untrusted array. An empty one is dropped; anything that is not a string is refused.
*
* The two are treated differently because they mean different things. A blank row in a form is a
* person who has not filled it in, and refusing the whole submission over it would be a rule about
* typing. A number where a requirement id belongs is a caller that is wrong about the shape, and
* dropping it silently is the failure that matters here: an action built from `['DG-02-01', 42]` would
* be stored as answering one requirement while whoever sent it believes it answers two, and nothing
* anywhere would ever say so.
*/
function list(value, field) {
	if (value == null) return [];
	if (!Array.isArray(value)) throw new InvalidActionError(`${field} has to be a list of text values.`);
	const entries = [];
	for (const entry of value) {
		if (typeof entry !== "string") throw new InvalidActionError(`Every entry in ${field} has to be text, and one of them is not.`);
		const trimmed = text(entry);
		if (trimmed != null) entries.push(trimmed);
	}
	return entries;
}
//#endregion
export { ACTION_STATES, EFFORTS, InvalidActionError, PRIORITIES, clearedBy, draftFrom, moved, movesFor, needsReason, revised, verifiedBy };
