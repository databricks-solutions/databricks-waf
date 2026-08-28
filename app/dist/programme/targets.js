//#region server/programme/targets.ts
const DAY = 864e5;
/**
* Each target, held against the run that has just been read.
*
* In the definition's own order, which `normaliseTargets` has already sorted by pillar. Ordering by
* urgency was the alternative and it is a worse default: the list is short, and a list that reorders
* itself between runs is one a reader has to search rather than scan.
*/
function readTargets(targets, pillars, now) {
	const scored = new Map(pillars.map((pillar) => [pillar.pillarId, pillar]));
	return targets.map((target) => reading(target, scored.get(target.pillar), now));
}
function reading(target, pillar, now) {
	const due = target.by.getTime() <= now.getTime();
	const by = dayNamed(target.by);
	const common = {
		pillar: target.pillar,
		atLeast: target.atLeast,
		by: target.by,
		due
	};
	if (pillar == null) return {
		...common,
		standing: "not-assessed",
		sentence: `Not covered by this run, so a target of ${String(target.atLeast)} by ${by} has not been reported against.`
	};
	if (pillar.score == null) return {
		...common,
		standing: "not-scored",
		sentence: `Nothing here could be scored in this run, so there is no number to hold the target of ${String(target.atLeast)} by ${by} against.`
	};
	const score = round(pillar.score);
	const daysLeft = due ? void 0 : Math.ceil((target.by.getTime() - now.getTime()) / DAY);
	if (score >= target.atLeast) return {
		...common,
		standing: "met",
		score,
		...daysLeft != null ? { daysLeft } : {},
		sentence: `${String(score)} against a target of ${String(target.atLeast)} by ${by}, which it meets` + (daysLeft == null ? "." : ` with ${days(daysLeft)} to the date.`)
	};
	const shortBy = round(target.atLeast - score);
	if (due) return {
		...common,
		standing: "gap",
		score,
		shortBy,
		sentence: `${String(score)} against a target of ${String(target.atLeast)} by ${by}, a gap of ${points(shortBy)}.`
	};
	return {
		...common,
		standing: "short",
		score,
		shortBy,
		...daysLeft != null ? { daysLeft } : {},
		sentence: `${String(score)} against a target of ${String(target.atLeast)} by ${by}, ${points(shortBy)} short with ${days(daysLeft ?? 0)} to the date.`
	};
}
function days(count) {
	return `${String(count)} day${count === 1 ? "" : "s"}`;
}
/**
* A number to the one decimal place a pillar score is reported to.
*
* `Number(x.toFixed(1))` rather than `x.toFixed(1)`, so what leaves here is a number: the payload
* carries `score` and `shortBy` as numbers, and a string that looks like one would be a different
* shape for the same field depending on which branch produced it.
*/
function round(value) {
	return Number(value.toFixed(1));
}
/**
* A count of points, singular only when it is exactly one.
*
* A gap is fractional, so "0.8 points" and "1.5 points" are both plural and only "1 point" is not.
*/
function points(count) {
	return `${String(count)} point${count === 1 ? "" : "s"}`;
}
/**
* A date in a sentence a person reads, rather than the timestamp it is stored as.
*
* UTC for the reason `risk.ts` gives for the identical helper there: the stored date is a day, and
* rendering it in the server's zone would name the day before or after it depending on where the app
* happens to be deployed. Not shared with that one, because the day two modules of this app agree on
* how to print a date is the day somebody moves the printer and changes a sentence they were not
* reading — and these two sentences are read by different people for different reasons.
*/
function dayNamed(when) {
	return when.toLocaleDateString("en-GB", {
		year: "numeric",
		month: "long",
		day: "numeric",
		timeZone: "UTC"
	});
}
//#endregion
export { readTargets };
