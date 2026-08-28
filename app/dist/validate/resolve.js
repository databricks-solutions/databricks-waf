import { verifiedBy } from "../improve/action.js";
import { ConcurrentChangeError } from "../improve/store.js";
import { abandoned, answerable, answeredBy, claimedAtOf, verifies } from "./attempt.js";
import { AlreadyAnsweredError } from "./store.js";
//#region server/validate/resolve.ts
const NOTHING = {
	answered: 0,
	verified: 0,
	failed: 0,
	incomplete: 0,
	stalled: 0,
	withdrawn: 0,
	waiting: 0
};
/** Why an attempt with no requirements under it is closed instead of answered. Read by whoever asked. */
const NOTHING_TO_CHECK = "This validation names no requirement, so no run can say whether the work landed. It is closed rather than left waiting for a run that could never answer it. An action raised from advisor advice is settled by the advisor reading the estate again, not by an assessment.";
/**
* Answers every outstanding validation this run may answer, and verifies what passed.
*
* Never rejects. A pass that cannot read the attempts answers none of them, and the next run answers
* them instead — late, which is the right way for this to fail.
*/
async function resolveValidations(scan, options) {
	let outstanding;
	try {
		outstanding = await options.validations.outstanding();
	} catch (error) {
		options.onError?.("read the validations waiting on a run", error);
		return NOTHING;
	}
	if (outstanding.length === 0) return NOTHING;
	const measured = measuredHere(scan);
	const findings = new Map(scan.findings.map((finding) => [finding.controlId, finding]));
	const tally = { ...NOTHING };
	for (const attempt of outstanding) try {
		const one = await settle(attempt, scan, {
			measured,
			findings
		}, options);
		tally.answered += one.answered;
		tally.verified += one.verified;
		tally.failed += one.failed;
		tally.incomplete += one.incomplete;
		tally.stalled += one.stalled;
		tally.withdrawn += one.withdrawn;
		tally.waiting += one.waiting;
	} catch (error) {
		options.onError?.(`answer validation ${attempt.id}`, error);
		tally.waiting += 1;
	}
	return tally;
}
async function settle(attempt, scan, run, options) {
	if (!answerable(attempt, { measuredAt: scan.finishedAt })) return {
		...NOTHING,
		waiting: 1
	};
	const scope = scan.stamp.definition?.id ?? null;
	const action = await options.improvements.action(attempt.actionId, scope);
	const gone = whyGone(attempt, action);
	if (gone != null) {
		await options.validations.answer(abandoned(attempt, gone, scan.finishedAt));
		return {
			...NOTHING,
			withdrawn: 1
		};
	}
	if (attempt.checks.length === 0) {
		await options.validations.answer(abandoned(attempt, NOTHING_TO_CHECK, scan.finishedAt));
		return {
			...NOTHING,
			withdrawn: 1
		};
	}
	if (attempt.checks.filter((check) => !freshlyMeasured(check.controlId, run)).length > 0) return {
		...NOTHING,
		waiting: 1
	};
	const answered = answeredBy(attempt, {
		scanId: scan.id,
		measuredAt: scan.finishedAt,
		observations: attempt.checks.map((check) => observationOf(check.controlId, run))
	});
	try {
		await options.validations.answer(answered);
	} catch (error) {
		if (error instanceof AlreadyAnsweredError) return {
			...NOTHING,
			waiting: 1
		};
		throw error;
	}
	const result = answered.answer?.result;
	if (!verifies(answered)) return {
		...NOTHING,
		answered: 1,
		failed: result === "failed" ? 1 : 0,
		incomplete: result === "failed" ? 0 : 1
	};
	const verified = await verify(action, scan, options);
	return {
		...NOTHING,
		answered: 1,
		...verified ? { verified: 1 } : { stalled: 1 }
	};
}
/**
* Why the claim this attempt was about is no longer there, or undefined while it is.
*
* Prose rather than a code, because it is stored as the reason the attempt was closed and read by
* somebody wondering why their validation never produced an answer. "The action was moved to
* in-progress" is that answer; `claim-withdrawn` is a thing they then have to ask about.
*/
function whyGone(attempt, action) {
	if (action == null) return "The action this validation was about is no longer in the record, so nothing can be validated. This closes the attempt rather than leaving it waiting on a run that could never answer it.";
	if (action.state !== "ready-for-validation") return `The claim this validation was checking was withdrawn: the action is ${action.state}. Offer the work for validation again when it is done, and the next run will answer that claim.`;
	const claimed = claimedAtOf(action);
	if (claimed == null || claimed.getTime() !== attempt.claimedAt.getTime()) return "The work was taken back and claimed done again after this validation was asked for, so this attempt is about the earlier claim. Ask for a validation of the new one.";
}
/**
* Marks the action verified by this run, retrying once if somebody wrote the action meanwhile.
*
* Once rather than in a loop: the writer it is racing is a person moving the action by hand, and a
* second read either finds an action still ready for validation — in which case the retry works — or
* one that has moved on, in which case no number of retries helps and `whyGone` on the next pass is
* the honest answer.
*
* Reports rather than raises, and returns whether it verified. The answer is already on the record by
* the time this runs, so an exception out of here would be caught by the pass as a failure to answer —
* naming the wrong operation and losing an answer that was in fact written. False leaves an action in
* `ready-for-validation` with a passed attempt behind it, which is visible rather than silent: the
* attempt says it passed, `stalled` counts it, and the way out is to ask for another validation, which
* is permitted because nothing is outstanding.
*/
async function verify(action, scan, options) {
	for (const remaining of [1, 0]) try {
		const current = remaining === 1 ? action : await options.improvements.action(action.id, scan.stamp.definition?.id ?? null);
		if (current == null || current.state !== "ready-for-validation") return false;
		const plan = await options.improvements.plan(current.planId);
		if (plan == null) {
			options.onError?.(`verify action ${current.id}`, /* @__PURE__ */ new Error(`Action ${current.id} names plan ${current.planId}, which is not in the record.`));
			return false;
		}
		await options.improvements.changeAction(verifiedBy(current, scan.id, scan.finishedAt), plan);
		return true;
	} catch (error) {
		if (error instanceof ConcurrentChangeError && remaining > 0) continue;
		options.onError?.(`verify action ${action.id}`, error);
		return false;
	}
	return false;
}
/** The pillars this run measured itself. A pillar it carried forward is not among them. */
function measuredHere(scan) {
	return new Set(scan.measurement.filter((pillar) => !pillar.carriedForward).map((pillar) => pillar.pillarId));
}
function freshlyMeasured(controlId, run) {
	const finding = run.findings.get(controlId);
	return finding == null || run.measured.has(finding.pillarId);
}
/**
* What this run says about one requirement, in the terms the attempt reads.
*
* `attestedAt` is carried only where the answer decided the outcome. An answer recorded beside a
* measurement is not what the finding rests on, and passing its date would fail a validation for the
* age of evidence that did not decide anything.
*/
function observationOf(controlId, run) {
	const finding = run.findings.get(controlId);
	if (finding == null) return { controlId };
	return {
		controlId,
		outcome: finding.outcome,
		...finding.attested?.bearing === "outcome" ? { attestedAt: finding.attested.at } : {}
	};
}
//#endregion
export { resolveValidations };
