import { classOf } from "./evidence-class.js";
//#region server/resolve/confidence.ts
/** An attestation within this many days of its review date is called out as expiring. */
const EXPIRING_WITHIN_DAYS = 30;
/**
* What a finding rests on, and what limits it.
*
* An `unmeasurable` finding gets `none` and no limitations. Nothing was established, so there is
* nothing to qualify — and `unmeasured` already says which of the five kinds of gap it is, which is
* the question a reader actually has there. Listing limitations against it would read as though a
* better-covered scan would have produced an answer, which is true for one of the five kinds and
* false for the other four.
*/
function confidenceOf(finding, circumstances = {}) {
	if (finding.outcome === "unmeasurable") return {
		standing: "none",
		because: "Nothing was established, so there is no confidence to report.",
		limitations: []
	};
	const limitations = limitationsOf(finding, circumstances);
	const standing = standingOf(finding, limitations);
	return {
		standing,
		because: because(standing, limitations),
		limitations
	};
}
function standingOf(finding, limitations) {
	if (classOf(finding) === "attested") return "stated";
	return limitations.length === 0 ? "established" : "qualified";
}
/**
* Narrowest first, which is the order a reader needs rather than the order they are computed in.
*
* The list can hold more than one and they compound: a sampled reading of one workspace, imported,
* is three separate statements about what may not be concluded and collapsing them to the worst
* would drop two of them.
*/
function limitationsOf(finding, circumstances) {
	const limitations = [];
	const attested = finding.attested;
	if (attested != null && attested.bearing === "outcome") {
		limitations.push({
			kind: "attested",
			says: `This is ${attested.by}'s answer about the practice, recorded ${on(attested.at)}, not something this app read. ${attested.owner} is accountable for it.`
		});
		const days = daysUntil(attested.reviewBy, circumstances.asOf);
		if (days != null && days <= EXPIRING_WITHIN_DAYS) limitations.push({
			kind: "expiring",
			says: days <= 0 ? `The answer was due for review ${on(attested.reviewBy)} and no longer counts.` : `The answer is due for review ${on(attested.reviewBy)}, in ${String(days)} ${days === 1 ? "day" : "days"}, after which it stops counting.`
		});
	}
	const sampled = sampling(finding.coverage);
	if (sampled != null) limitations.push(sampled);
	const narrow = narrowReach(finding.coverage.reach);
	if (narrow != null) limitations.push(narrow);
	const imported = importedAt(finding.evidence);
	if (imported != null) limitations.push({
		kind: "imported",
		says: `An administrator collected this against an authority this app cannot hold, and imported it. It describes the estate as it stood ${on(imported)}, and this app cannot re-read it to check.`
	});
	if (circumstances.carriedForward === true) limitations.push({
		kind: "carried",
		says: "This run did not measure this pillar. The outcome and its evidence are from the run named on it."
	});
	return limitations;
}
function sampling(coverage) {
	if (coverage.mode !== "sampled") return void 0;
	return {
		kind: "sampled",
		says: `Read over ${coverage.examined != null && coverage.population != null ? `${String(coverage.examined)} of ${String(coverage.population)}` : "part of the population"}, so the outcome describes what was examined rather than the whole of it.${coverage.basis != null ? ` ${coverage.basis}` : ""}`
	};
}
/**
* A reach narrower than the account, which is what the reader of a multi-workspace estate assumes.
*
* An unstated reach is a limitation too, and the sentence says whose fault it is: a collector that
* did not declare what it was a statement about leaves the reader unable to tell a complete account
* reading from a single-workspace one, and that gap is this app's rather than the estate's.
*/
function narrowReach(reach) {
	if (reach === "account") return void 0;
	if (reach === "metastore") return {
		kind: "reach",
		says: "Read from the Unity Catalog metastore attached to this workspace. An account with metastores in more than one region needs this app installed once per region before this covers all of them."
	};
	if (reach === "workspace") return {
		kind: "reach",
		says: "Read from this workspace only. It says nothing about the others in the account."
	};
	return {
		kind: "reach",
		says: "The collector did not declare which part of the estate this is a statement about, which is a gap in this app."
	};
}
/** When the outcome-bearing imported evidence was collected, or nothing when none of it was. */
function importedAt(evidence) {
	const bearing = evidence.filter((one) => one.bearing !== "detail" && one.evidenceClass === "admin-collected");
	if (bearing.length === 0) return void 0;
	return bearing.reduce((oldest, one) => one.collectedAt < oldest ? one.collectedAt : oldest, bearing[0].collectedAt);
}
function because(standing, limitations) {
	if (standing === "established") return "Read by this app from the sources named below, over the whole of the estate it can see. Nothing qualifies it.";
	if (standing === "stated") return limitations.filter((one) => one.kind !== "attested" && one.kind !== "expiring").length === 0 ? "The outcome is somebody’s answer about the practice rather than a reading, so it is as good as their account of it." : "The outcome is somebody’s answer about the practice rather than a reading, and what is recorded beside it is qualified too.";
	return limitations.length === 1 ? "Read by this app, with one limit on what it establishes." : `Read by this app, with ${String(limitations.length)} limits on what it establishes.`;
}
function daysUntil(when, asOf) {
	if (asOf == null) return void 0;
	return Math.ceil((when.getTime() - asOf.getTime()) / 864e5);
}
/** The date alone. A finding shows several and a time on each would be noise. */
function on(date) {
	return `on ${date.toISOString().slice(0, 10)}`;
}
//#endregion
export { confidenceOf };
