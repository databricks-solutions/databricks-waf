import { clearedBy } from "./action.js";
import { adviceReadingOf } from "./advice-reading.js";
import { ConcurrentChangeError } from "./store.js";
import { claimedAtOf } from "../validate/attempt.js";
//#region server/improve/advice-settle.ts
const NOTHING = {
	read: 0,
	cleared: 0,
	firing: 0,
	unreadable: 0,
	stalled: 0
};
/**
* Verifies every claimed action whose advice this advisory no longer reports.
*
* Never rejects. A pass that cannot read the plans settles nothing, and the next advisory settles them
* instead — late, which is the right way for this to fail.
*/
async function settleAdvice(advisory, options) {
	const scope = advisory.definition?.id ?? null;
	let claimed;
	try {
		const plans = await options.improvements.plans(scope);
		claimed = (await Promise.all(plans.map((plan) => options.improvements.actions(plan.id, scope)))).flat().filter(settleable);
	} catch (error) {
		options.onError?.("read the actions waiting on an advisory", error);
		return NOTHING;
	}
	if (claimed.length === 0) return NOTHING;
	const tally = { ...NOTHING };
	for (const action of claimed) try {
		const one = await settle(action, advisory, options);
		tally.read += one.read;
		tally.cleared += one.cleared;
		tally.firing += one.firing;
		tally.unreadable += one.unreadable;
		tally.stalled += one.stalled;
	} catch (error) {
		options.onError?.(`settle action ${action.id}`, error);
	}
	return tally;
}
/**
* Whose claim this pass may answer, which is the same split `validate/attempt.ts` refuses on.
*
* An action naming a requirement is answered by a scan and by nothing else, even where it also carries
* advice. Both are true of it and the assessment is the stronger reading: a requirement's answer
* belongs to the requirement, and an advisory clearing one rule on one resource is not the framework
* agreeing that the control is met. `attempt.ts` refuses a validation request for the other half of
* the split, so between them every claimed action has exactly one thing entitled to answer it.
*/
function settleable(action) {
	return action.state === "ready-for-validation" && action.advice != null && action.controlIds.length === 0;
}
async function settle(action, advisory, options) {
	const reading = adviceReadingOf(action.advice, advisory);
	const claimedAt = claimedAtOf(action);
	if (claimedAt == null || advisory.finishedAt.getTime() <= claimedAt.getTime()) return NOTHING;
	if (reading.standing === "still-firing") return {
		...NOTHING,
		read: 1,
		firing: 1
	};
	if (reading.standing !== "cleared") return {
		...NOTHING,
		read: 1,
		unreadable: 1
	};
	const written = await verify(action, advisory, options);
	return {
		...NOTHING,
		read: 1,
		...written ? { cleared: 1 } : { stalled: 1 }
	};
}
/**
* Marks the action verified by this advisory, retrying once if somebody wrote it meanwhile.
*
* Once rather than in a loop, and reporting rather than raising, for the reasons `validate/resolve.ts`
* gives about the same two decisions. The difference from that one is what a failure leaves behind:
* there, a passed attempt sits on the record saying the work held. Here nothing is written at all, and
* the action reads `agreed` from the same advisory on the next page load — so the visible state is
* right and only the transition is missing, until the next advisory writes it.
*/
async function verify(action, advisory, options) {
	const scope = advisory.definition?.id ?? null;
	for (const remaining of [1, 0]) try {
		const current = remaining === 1 ? action : await options.improvements.action(action.id, scope);
		if (current == null || !settleable(current)) return false;
		const plan = await options.improvements.plan(current.planId, scope);
		if (plan == null) {
			options.onError?.(`settle action ${current.id}`, /* @__PURE__ */ new Error(`Action ${current.id} names plan ${current.planId}, which is not in the record.`));
			return false;
		}
		await options.improvements.changeAction(clearedBy(current, advisory.id, advisory.finishedAt), plan);
		return true;
	} catch (error) {
		if (error instanceof ConcurrentChangeError && remaining > 0) continue;
		options.onError?.(`settle action ${action.id}`, error);
		return false;
	}
	return false;
}
//#endregion
export { settleAdvice };
