import "../attest/attestation.js";
/** Outcomes that mean the requirement is not currently a problem. The same set `standing.ts` uses. */
function met(outcome) {
	return outcome === "pass" || outcome === "satisfied-by-architecture" || outcome === "not-applicable";
}
/**
* Whether a met requirement is met on evidence that postdates the claim.
*
* The one place a finding's outcome is not the whole answer. Fifty-five requirements in this catalogue
* are answered by somebody's word, and a run reports them as met because an attestation says so — so
* an action claiming "we now review access quarterly", validated by a run that agreed on the strength
* of an attestation from March, is verified by evidence recorded before the work started. That is what
* AUD-DEC-107 means by refreshed attributed evidence, and it is why this reading and
* `validate/attempt.ts` share the rule rather than each having their own.
*
* Only where the answer *carries* the outcome. An attestation recorded beside a measurement
* (`bearing: 'record'`) is a note next to a fact the app established itself, and treating that as
* stale human evidence would refuse the stronger of the two answers. An absent `attested` is the
* ordinary case — the app measured it — and says nothing about staleness.
*
* Unmeasured rather than unmet, which is the important half: stale human evidence is not the estate
* disagreeing with the claim, it is nobody having been asked since. `contradicted` would put it on the
* board beside genuine regressions and send somebody to look at a system that is fine.
*/
function refreshed(finding, claimedAt) {
	const attested = finding.attested;
	if (attested == null || attested.bearing !== "outcome") return true;
	if (claimedAt == null) return true;
	return attested.at.getTime() >= claimedAt.getTime();
}
function unmet(outcome) {
	return outcome === "fail" || outcome === "partial";
}
/** The states in which nothing has been claimed about the estate. */
function unclaimed(state) {
	return state === "draft" || state === "planned" || state === "in-progress" || state === "blocked";
}
/**
* When the claim was made, which is what a run has to be later than to speak to it.
*
* The date the action reached `ready-for-validation`, from the history, rather than the date it was
* created or the date it was verified. A run between the work starting and the owner finishing it is
* evidence about a half-done change, and reading it as a contradiction would make every action that
* spans a scheduled scan look like a failed fix.
*
* The last such transition rather than the first: an action sent back for more work and offered again
* is making a new claim, and the run that contradicted the first one has already had its say.
*/
function claimedAt(action) {
	const claims = action.history.filter((entry) => entry.to === "ready-for-validation");
	return claims.length === 0 ? void 0 : claims[claims.length - 1]?.at;
}
function progressOf(action, context = {}) {
	const now = context.now ?? /* @__PURE__ */ new Date();
	const byControl = new Map((context.findings ?? []).map((finding) => [finding.controlId, finding]));
	const claimed = claimedAt(action);
	const since = claimed != null && context.measuredAt != null && context.measuredAt.getTime() > claimed.getTime();
	const outcomes = action.controlIds.map((id) => {
		const finding = byControl.get(id);
		return {
			id,
			outcome: finding?.outcome,
			stale: finding != null && finding.outcome != null && met(finding.outcome) && !refreshed(finding, claimed)
		};
	});
	const unmetIds = outcomes.filter((entry) => entry.outcome != null && unmet(entry.outcome)).map((entry) => entry.id);
	const unreadable = outcomes.filter((entry) => entry.outcome == null || entry.stale || !met(entry.outcome) && !unmet(entry.outcome)).map((entry) => entry.id);
	const advice = action.advice != null && context.adviceReading != null ? context.adviceReading(action.advice) : void 0;
	return {
		action,
		agreement: agreementFor(action, {
			since,
			unmet: unmetIds,
			unreadable,
			...advice != null ? { advice } : {},
			...claimed != null ? { claimedAt: claimed } : {}
		}),
		lateness: latenessFor(action, now),
		unmet: unmetIds,
		unreadable,
		...advice != null ? { advice } : {}
	};
}
/**
* The agreement, decided in an order that puts the disagreement first.
*
* `cancelled` reads as `unclaimed` rather than as a fifth value, which is a judgement worth stating:
* the action makes no claim about the estate, and the requirement it named is still measured by the
* assessment itself. An action cancelled because the requirement was answered another way is not
* evidence about anything, and a board that said "cancelled — agreed" would be inviting the reading
* that cancelling counts as fixing.
*
* `verified` is read here like any other claimed state, and that is what answers the obvious question
* about a terminal `verified`: an action a run agreed with in June, whose requirement fails again in
* July, reads `contradicted`. The state records what happened — a run did agree, on a date, and the
* history names it — and the agreement records what the estate says now. Moving the action back out of
* `verified` instead would rewrite the record of a verification that genuinely occurred, and would add
* a transition to somebody's history on every scan that disagreed.
*/
function agreementFor(action, reading) {
	if (unclaimed(action.state) || action.state === "cancelled") return "unclaimed";
	if (action.controlIds.length === 0) return advisedAgreement(reading.advice, reading.claimedAt);
	if (!reading.since) return "awaiting";
	if (reading.unmet.length > 0) return "contradicted";
	if (reading.unreadable.length > 0) return "unmeasured";
	return "agreed";
}
/**
* The same four readings, taken from an advisory instead of a scan.
*
* The mapping is deliberately the assessment's own and not a softer version of it. A rule that fired
* again is the estate disagreeing with the claim, which is `contradicted` and belongs on the board
* beside a failing requirement. A rule that did not fire on a resource the run did read is `agreed`.
* Everything else — a resource the run did not mention, an analysis it could not form, a rule this
* build no longer has — is `unmeasured`, which is the value that exists for a measurement that was
* attempted and could not be read, and `advice-reading.ts` is where each of those is refused.
*
* The claim date is checked here rather than in the reading because it is a fact about the action: the
* reading knows whether the advisory is later than the *advice*, and only this knows whether it is
* later than the day somebody said the work was done. An advisory in between measured a half-finished
* change, which is the argument `validate/attempt.ts` opens with, and it holds identically here.
*/
function advisedAgreement(advice, claimedAt) {
	if (advice == null) return "unjudged";
	if (claimedAt == null || advice.measuredAt.getTime() <= claimedAt.getTime()) return "awaiting";
	if (advice.standing === "still-firing") return "contradicted";
	if (advice.standing === "cleared") return "agreed";
	return "unmeasured";
}
/**
* Whether the date has passed, for the states where a date still means something.
*
* A verified or cancelled action is `undated` however far past its date it is, because "overdue" on
* finished work is a count nobody can act on and it would put every historical action permanently in
* the worst bucket on the board.
*/
function latenessFor(action, now) {
	if (action.state === "verified" || action.state === "cancelled") return "undated";
	if (action.due == null) return "undated";
	const remaining = action.due.getTime() - now.getTime();
	if (remaining <= 0) return "overdue";
	return remaining <= 7 * 864e5 ? "due" : "on-time";
}
/**
* The plan's progress, which is a count of its actions and never a judgement about the plan.
*
* No percentage and no traffic light, deliberately. Five actions of which three are verified is not
* 60% of an outcome — the remaining two are usually the hard ones — and a single figure over a plan
* is the number that ends up in a slide with nothing underneath it. What is here instead is the three
* lists somebody running the plan actually asks for, by id, plus the counts.
*/
function planProgress(planId, actions, context = {}) {
	const mine = actions.filter((action) => action.planId === planId);
	const readings = mine.map((action) => progressOf(action, context));
	const states = {
		draft: 0,
		planned: 0,
		"in-progress": 0,
		blocked: 0,
		"ready-for-validation": 0,
		verified: 0,
		cancelled: 0
	};
	for (const action of mine) states[action.state] += 1;
	const live = mine.filter((action) => action.state !== "verified" && action.state !== "cancelled");
	const dates = live.map((action) => action.due).filter((due) => due != null);
	return {
		planId,
		states,
		contradicted: readings.filter((reading) => reading.agreement === "contradicted").map((reading) => reading.action.id),
		overdue: readings.filter((reading) => reading.lateness === "overdue").map((reading) => reading.action.id),
		blocked: mine.filter((action) => action.state === "blocked").map((action) => action.id),
		settled: live.length === 0,
		...dates.length > 0 ? { nextDue: new Date(Math.min(...dates.map((date) => date.getTime()))) } : {}
	};
}
//#endregion
export { planProgress, progressOf };
