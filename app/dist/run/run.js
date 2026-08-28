//#region server/run/run.ts
/**
* The states in which the run said something about the estate, or somebody decided it should not.
*
* Narrower than {@link TERMINAL} by exactly one state, and the distinction is what a retry turns on. A
* complete or partial run produced a scan, and a cancelled one was stopped on purpose; a second trigger
* against any of those should be told to read the answer rather than quietly replacing it.
*
* A `failed` run is over and produced nothing. Refusing to retry it under its own key would mean
* telling a caller to go and read an answer that does not exist, and forcing it to invent a new key —
* which files each retry as a separate assessment of the estate, when what happened was one assessment
* attempted twice. So failure is not an answer, and a retry may take a failed run back up: its
* checkpoints are kept for that reason, and `attempts` is what records that it took more than one go.
*/
const ANSWERED = [
	"complete",
	"partial",
	"cancelled"
];
function answered(state) {
	return ANSWERED.includes(state);
}
/**
* Whether a run's claim has lapsed as at `now`.
*
* A run with no lease is unheld — either nothing has claimed it yet, or an attempt released it. A
* lease whose `until` has passed is one whose holder stopped renewing, which is the only evidence
* available that a process died: it cannot be asked, and waiting for it to say so is what leaves a
* run stuck for ever.
*/
function unheld(run, now) {
	return run.lease == null || run.lease.until.getTime() <= now.getTime();
}
/**
* Whether a repeated trigger may join an existing run and carry it on.
*
* The refusals are different mistakes and it matters which is reported. A run that already
* answered should be read rather than replaced. A held run is being worked on by a process that is
* still alive, so joining would put two attempts on one assessment. A run asked for by somebody
* else, or for something else, is not this trigger's run at all and continuing it would produce an
* assessment attributed to a request nobody made.
*
* Answered rather than terminal, which lets a retry take up a run whose attempt broke — see
* {@link ANSWERED} for why failure is the one ending that is not an answer.
*
* The kind is compared before the request, and it is its own refusal rather than a difference in the
* request. Two kinds share one key space (ADR 0069), so a key naming an assessment can be presented
* by an advisory trigger; reporting that as `other-request` would be true and useless, because the
* scope and window it names may match exactly and the caller would go looking for a difference that
* is not there.
*/
function joinable(run, by, now) {
	if (answered(run.state)) return "terminal";
	if (run.kind !== by.kind) return "other-kind";
	if (run.actor !== by.actor) return "other-actor";
	if (!sameRequest(run.request, by.request)) return "other-request";
	if (!unheld(run, now)) return "held";
}
/**
* Whether two requests measure the same thing.
*
* Compared field by field rather than by deep equality of the whole object, because two of the
* fields are allowed to differ and silently accepting a difference in the others would resume a run
* that had been asked a different question — the mirror of the fingerprint rule for definitions.
*
* Field by field all the way down, and that is not fastidiousness. This compared scopes by
* `JSON.stringify` and a live run found it: one side is the scope the caller just built and the other
* has been through `jsonb`, which stores an object by its own key order rather than the one it arrived
* in. Two identical scopes stringified to different strings, so the supervisor's retry after the app
* was killed mid-scan was refused as a different request — the one moment the whole design exists for.
*/
function sameRequest(one, other) {
	return one.lookbackDays === other.lookbackDays && sameScope(one.scope, other.scope) && sameList(one.pillars, other.pillars) && one.definition?.id === other.definition?.id && one.definition?.version === other.definition?.version;
}
/**
* Whether two scopes cover the same estate.
*
* `description` is deliberately not compared. It is prose derived from the three fields that are, and
* comparing it would mean a run could not be resumed across a release that reworded a sentence — a
* refusal with no estate behind it, reported to a supervisor as a request that measures something
* else.
*/
function sameScope(one, other) {
	return one.hostWorkspaceId === other.hostWorkspaceId && one.narrowedTo === other.narrowedTo && sameList(one.selected, other.selected);
}
/**
* Whether two lists name the same things, in whatever order.
*
* Absent and empty compare equal because neither field this serves can be empty: an empty selection is
* refused where it is built, and an empty pillar list is refused at the route. What arrives here is a
* list of somethings or nothing at all.
*/
function sameList(one, other) {
	const first = [...one ?? []].sort();
	const second = [...other ?? []].sort();
	return first.length === second.length && first.every((value, at) => value === second[at]);
}
/**
* The state a finished scan leaves its run in.
*
* `partial` rather than `complete` for a scan that was cut short, and `cancelled` only when somebody
* asked: a run that hit its budget and one somebody stopped are both partial assessments, and a
* reader deciding whether to re-run needs to know which. A cancelled run still has a scan, because
* the readings it reached are real and are saved — see `ScanRunner`.
*/
function endedAs(scan, cancelled) {
	if (cancelled) return "cancelled";
	return scan.state === "complete" ? "complete" : "partial";
}
/** The readings a resumed attempt starts from, newest checkpoint of a signal winning. */
function resumeFrom(checkpoints) {
	const readings = /* @__PURE__ */ new Map();
	for (const checkpoint of [...checkpoints].sort((a, b) => a.at.getTime() - b.at.getTime())) for (const reading of checkpoint.readings) readings.set(reading.id, reading);
	return readings;
}
/**
* What to tell a caller whose trigger could not join the run their key names.
*
* Here rather than at the route because the same four sentences are owed to an HTTP caller and to
* the job's task output, and because the useful part of each is which of the four it is.
*/
function refusalMeans(refusal, run) {
	switch (refusal) {
		case "terminal": return `That run already finished as ${run.state}${run.scanId == null ? "" : `, recorded as scan ${run.scanId}`}. Read it rather than running it again, or trigger a new run with a new key.`;
		case "held": return "That run is being worked on by a process that is still renewing its claim on it, so this would be a second attempt at one assessment. Wait for it, or read its progress.";
		case "other-actor": return `That run was asked for by ${run.actor}. A run's readings are collected as one identity, so continuing somebody else’s run would describe an estate neither of you can see.`;
		case "other-request": return "That key names a run that was asked a different question — a different scope, window, pillar set or assessment version. Continuing it would answer the earlier request under this one’s name.";
		case "other-kind": return `That key names ${run.kind === "assessment" ? "an assessment" : "an advisory"} run, and this trigger is ${run.kind === "assessment" ? "an advisory" : "an assessment"} one. The two are separate cycles that happen to share a key space, so this needs a key of its own rather than continuing that run.`;
	}
}
//#endregion
export { ANSWERED, answered, endedAs, joinable, refusalMeans, resumeFrom, sameRequest, unheld };
