import { NO_CHANGELOG, spanBetween } from "../catalogue/changelog.js";
import { comparable, stampEnough } from "../shared/api/comparability.js";
import "./scan.js";
//#region server/scan/occurrence.ts
function crossings(scan, history, changelog) {
	return before(scan.id, history).map((summary) => {
		if (!stampEnough(summary.stamp)) return {
			summary,
			readable: false,
			ok: false
		};
		const span = spanBetween(changelog, summary.stamp.catalogueVersion, scan.stamp.catalogueVersion);
		return {
			summary,
			readable: true,
			ok: comparable(scan.stamp, summary.stamp, span).ok,
			span
		};
	});
}
function occurrenceAcross(controlId, scan, walk, given) {
	const outcome = scan.findings.find((finding) => finding.controlId === controlId)?.outcome;
	if (outcome == null) return {
		runs: 1,
		since: scan.finishedAt,
		horizon: "retention"
	};
	let runs = 1;
	let since = scan.finishedAt;
	for (const { summary, readable, ok, span } of walk) {
		if (summary.outcomes == null || !readable) return {
			runs,
			since,
			horizon: "unrecorded"
		};
		if (!ok) return {
			runs,
			since,
			horizon: "not-comparable"
		};
		if (span != null) {
			if (span.changed.some((one) => one.id === controlId)) return {
				runs,
				since,
				horizon: "redefined"
			};
			if (span.added.includes(controlId)) return {
				runs,
				since,
				horizon: "introduced"
			};
		}
		const then = summary.outcomes[asItWas(controlId, span)];
		if (then !== outcome) {
			if (then == null) return {
				runs,
				since,
				horizon: "unrecorded"
			};
			return {
				runs,
				since,
				horizon: "changed",
				changedFrom: {
					outcome: then,
					at: summary.finishedAt
				}
			};
		}
		runs += 1;
		since = summary.finishedAt;
	}
	return {
		runs,
		since,
		horizon: horizonAtEnd(walk, given)
	};
}
/** The id an earlier run knew this requirement by, following any renumbering the span records. */
function asItWas(controlId, span) {
	if (span == null) return controlId;
	for (const [from, to] of span.renamed) if (to === controlId) return from;
	return controlId;
}
/**
* The summaries older than the run in hand, newest first.
*
* A history that does not name the run is treated as entirely older than it, which is what a
* just-finished scan looks like before it is written.
*/
function before(id, history) {
	const at = history.findIndex((summary) => summary.id === id);
	return at < 0 ? history : history.slice(at + 1);
}
/**
* Whether running out of summaries means the estate has no earlier run, or only that nobody asked
* for one.
*
* The distinction rests on the caller having asked for the whole history rather than a page of it,
* which it cannot know from here — so the honest reading of a full-looking list is `retention`, and
* `first-run` is claimed only when the walk consumed everything it was given and the caller gave it
* something. A page boundary presented as the beginning of the estate's record would turn "we have
* only ever seen this fail" into a statement about the estate rather than about the page.
*/
function horizonAtEnd(walked, given) {
	return walked.length === 0 && given <= 1 ? "first-run" : "retention";
}
/** Every requirement in the run, so a page showing a list does not walk the history once per row. */
function occurrencesIn(scan, history, changelog = NO_CHANGELOG) {
	const walk = crossings(scan, history, changelog);
	const occurrences = /* @__PURE__ */ new Map();
	for (const finding of scan.findings) occurrences.set(finding.controlId, occurrenceAcross(finding.controlId, scan, walk, history.length));
	return occurrences;
}
//#endregion
export { occurrencesIn };
