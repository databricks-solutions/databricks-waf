//#region server/resolve/evidence-class.ts
/**
* Strongest first. Lower is more reliable, which is what "one-directional" means in one number.
*
* Ranked rather than compared ad hoc so that adding a fourth class is a line here and not a search
* for every `if` that assumed two.
*/
const RANK = {
	observed: 0,
	"admin-collected": 1,
	attested: 2
};
/**
* The class a finding rests on, or undefined when it rests on nothing.
*
* Two rules, and the second is the one worth reading twice.
*
* An attestation that bears on the outcome makes the finding attested, whatever else is attached.
* That follows from the precedence above: a resolver that had an observation of its own would not
* have consulted the answer, so an attested outcome means there was no observation to weigh.
*
* Otherwise the *weakest* bearing evidence governs — the same rule `Finding.coverage` uses, for the
* same reason. A verdict that needed an observation and an admin's import is only as good as the
* import, and labelling it observed would describe the finding by its best part. Detail evidence is
* ignored: a complete observation located by an imported list is still an observation, and counting
* the locator would understate what was measured.
*
* Undefined for an `unmeasurable` finding with nothing bearing on it, which is honest — there is no
* class of evidence behind a finding that has no evidence.
*/
function classOf(finding) {
	if (finding.attested?.bearing === "outcome") return "attested";
	const bearing = finding.evidence.filter((one) => (one.bearing ?? "outcome") === "outcome");
	if (bearing.length === 0) return decidedByApplicability(finding) ? "observed" : void 0;
	return bearing.map((one) => one.evidenceClass ?? "observed").reduce((weakest, next) => RANK[next] > RANK[weakest] ? next : weakest);
}
/**
* Whether the verdict came from the control's preconditions rather than from its own evidence.
*
* Those two outcomes carry no evidence rows because there was nothing to measure once the
* preconditions answered — but the preconditions are signals this app read, so the verdict is
* observed, and `satisfied-by-architecture` is scored as a pass. Leaving it unclassified would put a
* requirement in `scoredControls` and in none of the classes, so the composition would not add up to
* the number beside it. An attested one never reaches here: the check above claims it first.
*/
function decidedByApplicability(finding) {
	return finding.outcome === "satisfied-by-architecture" || finding.outcome === "not-applicable";
}
const NO_COMPOSITION = {
	observed: 0,
	"admin-collected": 0,
	attested: 0
};
/**
* The composition of a set of findings.
*
* Findings with no class are not counted anywhere, so the total is the number of findings that rest
* on something. Callers that need a denominator use their own — the score uses the requirements that
* scored, which is not the same set, and folding one into the other here would make this function
* answer a question it was not asked.
*/
function composition(findings) {
	const counted = { ...NO_COMPOSITION };
	for (const finding of findings) {
		const kind = classOf(finding);
		if (kind != null) counted[kind] += 1;
	}
	return counted;
}
//#endregion
export { NO_COMPOSITION, classOf, composition };
