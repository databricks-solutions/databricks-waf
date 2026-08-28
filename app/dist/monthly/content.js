import { comparable } from "../shared/api/comparability.js";
import { inForce } from "../accept/risk.js";
import "../scan/scan.js";
import { monthLabel } from "./publication.js";
//#region server/monthly/content.ts
/** The count of requirements the run reached an answer for: the three outcomes that are a reading. */
function answered(counts) {
	return counts.pass + counts.fail + counts.partial;
}
/** Every requirement the run considered, answered or not, so a share reads against a stated whole. */
function considered(counts) {
	return answered(counts) + counts.unmeasurable + counts.notApplicable;
}
/**
* A score as it appears in the bytes: a whole number, or the fact that nothing scored.
*
* Exported because the endpoint renders a prior month's score the same way when it has to fall back to a
* live scan, and two renderings of one number is how a series comes to disagree with the documents in it.
*/
function scoreText(overall) {
	return overall == null ? "not scored" : String(Math.round(overall));
}
function inWindow(at, window) {
	const t = at.getTime();
	return t >= window.start.getTime() && t < window.end.getTime();
}
/**
* The last scan of the month: the one whose result landed latest inside the window.
*
* Exported for the endpoint, which finds each prior published month's closing scan the same way to
* build the trend's series — one definition of "the month's close" rather than two that drift.
*/
function closingScan(scans, window) {
	return scans.filter((scan) => inWindow(scan.finishedAt, window)).reduce((latest, scan) => {
		if (latest == null) return scan;
		return scan.finishedAt.getTime() > latest.finishedAt.getTime() ? scan : latest;
	}, void 0);
}
/**
* The health of the month's assessment runs: the total, then one fact per state a run can be left in.
*
* Every state, not only the four terminal ones. A run whose record still says `running` is in the total
* and was in none of the rows, so the breakdown failed to sum against its own total on the reader's
* screen — arithmetic a reader can do, which no caption rescues. `Unfinished` is what the record says
* rather than what the run is doing: a worker that died leaves the row exactly as a worker still working
* does, and this document cannot tell them apart.
*/
function runHealth(runs, window) {
	const assessment = runs.filter((run) => run.kind === "assessment" && inWindow(run.requestedAt, window));
	const count = (state) => String(assessment.filter((run) => run.state === state).length);
	return [
		{
			label: "Assessment runs",
			value: String(assessment.length)
		},
		{
			label: "Completed",
			value: count("complete")
		},
		{
			label: "Partial",
			value: count("partial")
		},
		{
			label: "Failed",
			value: count("failed")
		},
		{
			label: "Cancelled",
			value: count("cancelled")
		},
		{
			label: "Unfinished",
			value: count("running")
		}
	];
}
/**
* The month's coverage movement, from what it opened at to what it closed at, both ends carried.
*
* Empty unless there is both an opening reading and a closing one: a movement with one end is a
* current figure dressed as a change, which is the thing `Movement` carries two ends to refuse. Score
* and answered-of-considered and pillars-measured are the three the scan summary can state without
* opening the stored run; confidence is not among them and is left out rather than invented, since
* the summary does not carry it.
*/
function movement(from, to) {
	if (from == null || to == null) return [];
	return [
		{
			label: "Overall score",
			from: scoreText(from.overall),
			to: scoreText(to.overall)
		},
		{
			label: "Requirements answered",
			from: `${String(answered(from.counts))} of ${String(considered(from.counts))}`,
			to: `${String(answered(to.counts))} of ${String(considered(to.counts))}`
		},
		{
			label: "Pillars measured",
			from: String(from.measuredPillars.length),
			to: String(to.measuredPillars.length)
		}
	];
}
/**
* The requirements whose finding changed between the month's opening and closing readings.
*
* Over the controls both readings measured, because a requirement one run scored and the other did
* not has not "changed" — it went unread, which the coverage movement above already accounts for, and
* reporting it here as a delta from an outcome to nothing would double-count a gap as a regression.
* Sorted by control id so the bytes are a function of the readings and not of a map's iteration order.
*/
function findingDeltas(from, to, label) {
	const before = from?.outcomes;
	const after = to?.outcomes;
	if (before == null || after == null) return [];
	const rows = [];
	for (const controlId of Object.keys(before).sort()) {
		const was = before[controlId];
		const now = after[controlId];
		if (now == null || was === now) continue;
		const words = label(controlId);
		rows.push({
			control: controlId,
			requirement: words?.requirement ?? controlId,
			pillar: words?.pillar ?? "unclassified",
			from: was,
			to: now
		});
	}
	return rows;
}
/**
* The month's exceptions: the requirements carried as an accepted risk that was standing at its close.
*
* Grouped by requirement, one row for the acceptance in force at the month's end — `inForce` picks it
* out of a requirement's history, and a requirement with none in force at that instant contributes
* nothing. `until` is the expiry as a plain date, not the stored timestamp, for the reason the risk
* module renders it as one: the milliseconds and the zone are the record's business and read as a
* fault to somebody being told which day the requirement comes back. Sorted by control id.
*/
function exceptions(risks, asOf, label) {
	const byControl = /* @__PURE__ */ new Map();
	for (const risk of risks) {
		const group = byControl.get(risk.controlId);
		if (group == null) byControl.set(risk.controlId, [risk]);
		else group.push(risk);
	}
	const rows = [];
	for (const controlId of [...byControl.keys()].sort()) {
		const standing = inForce(byControl.get(controlId) ?? [], asOf);
		if (standing == null) continue;
		const words = label(controlId);
		rows.push({
			control: controlId,
			requirement: words?.requirement ?? controlId,
			owner: standing.owner,
			residual: standing.residual,
			until: standing.expiresAt.toISOString().slice(0, 10)
		});
	}
	return rows;
}
/**
* What the review of the closing run was made of, frozen with the month.
*
* Empty where there is a closing run and no record of a review of it. A row reading "not reviewed"
* would be this document saying somebody had failed to do something, on a record that only says this
* app has no review of that run.
*
* The skipped pillars are named rather than counted, because a permanent record of a month that
* reports a score nobody reviewed part of has to say which part — and named in the catalogue's words,
* like every other string here, because the document displays what it carries and `cost-optimization`
* is not a sentence. The cited count says what it is counted from in the same cell: it is answers the
* run already held, not answers on record at publish.
*/
function review(finalisation, title) {
	if (finalisation == null) return [];
	const { finalised, recorded, expected, confirmed, skipped, cited } = finalisation;
	const named = skipped.map((id) => title(id) ?? id);
	return [
		{
			label: "Review",
			value: finalised ? `Finalised${finalisation.finalisedBy != null ? ` by ${finalisation.finalisedBy}` : ""}` : `Not finished: ${String(recorded)} of ${String(expected)} pillars have a record`
		},
		{
			label: "Pillars confirmed",
			value: `${String(confirmed)} of ${String(expected)}`
		},
		{
			label: "Pillars skipped",
			value: named.length === 0 ? "None" : `${named.join(", ")} — nobody confirmed ${named.length === 1 ? "its" : "their"} answers in this review`
		},
		{
			label: "Answers cited",
			value: `${String(cited)}, which the run already held`
		}
	];
}
/** The closing reading's outcome census: one fact per outcome the counts distinguish. */
function outcomes(closing) {
	if (closing == null) return [];
	const { counts } = closing;
	return [
		{
			label: "Met",
			value: String(counts.pass)
		},
		{
			label: "Failing",
			value: String(counts.fail)
		},
		{
			label: "Partial",
			value: String(counts.partial)
		},
		{
			label: "Not applicable",
			value: String(counts.notApplicable)
		},
		{
			label: "Unmeasured",
			value: String(counts.unmeasurable)
		}
	];
}
/**
* What moved on the improvement board during the month, counted from the actions' own timestamps.
*
* Raised is a creation in the window; verified and cancelled are transitions into those states in the
* window, read from the history rather than from the current state — an action verified in the month
* and reopened since was still verified in the month, and the history is where that stays true. No
* "open at close" count, which would need the state reconstructed as at the window's end rather than
* read as it is now, and that reconstruction is a claim this section does not need to make.
*/
function actionsMoved(actions, window) {
	const raised = actions.filter((action) => inWindow(action.createdAt, window)).length;
	const enteredIn = (state) => actions.filter((action) => action.history.some((step) => step.to === state && inWindow(step.at, window))).length;
	return [
		{
			label: "Actions raised",
			value: String(raised)
		},
		{
			label: "Actions verified",
			value: String(enteredIn("verified"))
		},
		{
			label: "Actions cancelled",
			value: String(enteredIn("cancelled"))
		}
	];
}
/**
* The month's whole content, ready for the builder to freeze.
*
* A pure function of the records passed in: the same sources produce the same rows, which is what lets
* the same publication produce the same bytes and therefore the same digest. The trend is a snapshot of
* the published series as it reads at this publish, anchored to this month and frozen with the document
* — a month published before any other carries only itself.
*/
function monthContent(sources) {
	const closing = closingScan(sources.scans, sources.window);
	const finalisation = sources.finalisation;
	return {
		...closing != null && finalisation?.resultId != null ? { assessment: {
			runId: closing.id,
			reviewId: finalisation.reviewId,
			finalResultId: finalisation.resultId,
			...closing.stamp?.definition != null ? { definition: {
				id: closing.stamp.definition.id,
				version: closing.stamp.definition.version,
				fingerprint: closing.stamp.definition.fingerprint
			} } : {}
		} } : {},
		runHealth: runHealth(sources.runs, sources.window),
		findingDeltas: findingDeltas(sources.priorScan, closing, sources.label),
		movement: movement(sources.priorScan, closing),
		actions: actionsMoved(sources.actions, sources.window),
		exceptions: exceptions(sources.risks, sources.window.end, sources.label),
		outcomes: outcomes(closing),
		...closing != null ? { review: review(sources.finalisation, sources.pillarTitle ?? (() => void 0)) } : {},
		trend: monthTrend(sources, closing)
	};
}
/**
* The month's trend: each published month as a point, carrying what the server's comparability rule
* decided about placing it on the same line as the month being published.
*
* The base is the month being published — the newest point — so the series answers the question a
* reader of this publication has: which earlier months sit on the same basis as this one. A point that
* cannot be compared is drawn with its reason rather than dropped, because a line that omits the month
* the catalogue changed, or the identity switched, is a smooth curve across a discontinuity — the lie
* `trend.ts` documents at length. The rule is the server's own `comparable`, not a second one that
* could drift from it: the same decision the live series and the carry-forward guard already make, over
* the whole stamp rather than the two fields the client narrowed to before this.
*/
function monthTrend(sources, closing) {
	const current = closing == null ? void 0 : {
		month: sources.month,
		score: scoreText(closing.overall),
		...closing.stamp != null ? { stamp: closing.stamp } : {},
		closingScan: "read"
	};
	const ordered = [...sources.series ?? [], ...current != null ? [current] : []];
	const base = ordered.at(-1);
	if (base == null) return [];
	return ordered.map((point) => {
		const [comparability, note] = placeAgainst(base, point);
		return {
			month: point.month,
			label: monthLabel(point.month),
			score: point.score ?? "not scored",
			comparability,
			...note != null ? { note } : {}
		};
	});
}
/** Where a point sits relative to the base, by the server's own comparability rule. */
function placeAgainst(base, point) {
	if (base.stamp == null) return ["refused", whyUnplaceable(base)];
	if (point.stamp == null) return ["refused", whyUnplaceable(point)];
	const verdict = comparable(base.stamp, point.stamp);
	if (!verdict.ok) return ["refused", verdict.reason];
	if (verdict.caveat != null) return ["caveat", verdict.caveat];
	return ["permitted", void 0];
}
/**
* Why a month with no measurement basis cannot go on the line, in the words its own case allows.
*
* Two cases, and the difference is what the reader can do about it. A run that did not record a basis is
* a fact about that run and permanent. A run this app can no longer read is a fact about this app's
* retention — the month is still on record with a score, and its own published document says how it was
* measured, which is where somebody goes next. Saying the first about the second was false about the
* month, and it pointed the reader at the wrong thing.
*/
function whyUnplaceable(point) {
	const label = monthLabel(point.month);
	return point.closingScan === "not-in-history" ? `The run that closed ${label} is not in the scan history this app reads, so how it was measured cannot be read from it. That month’s own published document is where it is recorded.` : `The run that closed ${label} did not record how it was measured, so it cannot be placed on the same line as the others.`;
}
//#endregion
export { closingScan, monthContent, scoreText };
