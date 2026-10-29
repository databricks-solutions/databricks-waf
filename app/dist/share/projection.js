import "../resolve/resolvers/security-jobs.js";
import "../resolve/resolvers/security-settings.js";
//#region server/share/projection.ts
const WHAT = {
	"statement-text": "Statement text is withheld.",
	"principal-identifiers": "The names of the users, service principals and token creators here are withheld.",
	"admin-reading": "An administrator’s imported reading is withheld."
};
/** The placeholder for one kind of field, naming the group whose members can see it. */
function withheldFrom(kind, group) {
	return {
		withheld: kind,
		reason: `${WHAT[kind]} Only direct members of the ${group} group can see it.`,
		visibleTo: group
	};
}
/** The record without the named fields, so a withheld value is absent rather than present and blanked. */
function without(record, fields) {
	const dropped = fields;
	return Object.fromEntries(Object.entries(record).filter(([name]) => !dropped.includes(name)));
}
/**
* Whether this evidence lists the principals behind a finding.
*
* The token inventory's detail evidence says who holds each token, and the job inventory's detail
* evidence under the run-as lead says which account each job runs as. Nothing else a resolver writes
* onto a finding names a principal; `projection.test.ts` holds the resolver sources to that.
*/
function carriesPrincipals(evidence) {
	if (evidence.bearing !== "detail") return false;
	if (evidence.signal === "rest:workspace:token.list") return true;
	return evidence.signal === "sql:jobs.inventory" && evidence.at?.lead === "Running as a user account";
}
/** Whether an administrator read this and imported it, rather than the app reading it. */
function isImportedReading(evidence) {
	return evidence.evidenceClass === "admin-collected" || evidence.provenance?.authority === "admin-cli";
}
/**
* One piece of evidence as this reader may see it.
*
* What is withheld is the sentence and the structured copy of it: `observed` becomes the placeholder's
* reason, and `at` goes, because its items carry the same names. For an imported reading `provenance`
* goes as well, since its actor is the administrator. What was expected, the coverage, the signal and
* the time stay, so the evidence still says what it was about and how much of the estate it covered.
*/
function projectEvidence(evidence, reader) {
	if (reader.assessor) return evidence;
	const kind = isImportedReading(evidence) ? "admin-reading" : carriesPrincipals(evidence) ? "principal-identifiers" : void 0;
	if (kind == null) return evidence;
	const placeholder = withheldFrom(kind, reader.group);
	return {
		...kind === "admin-reading" ? without(evidence, ["at", "provenance"]) : without(evidence, ["at"]),
		observed: placeholder.reason,
		withheld: placeholder
	};
}
/** The findings of a record with each one's evidence projected, and every other field as it was. */
function projectFindings(findings, reader) {
	if (reader.assessor) return findings;
	return findings.map((finding) => {
		const evidence = finding.evidence.map((one) => projectEvidence(one, reader));
		return evidence.some((one, index) => one !== finding.evidence[index]) ? {
			...finding,
			evidence
		} : finding;
	});
}
/** A scan as an export is built from it, so a file cannot carry what a reader may not see. */
function projectScan(scan, reader) {
	if (reader.assessor) return scan;
	const findings = projectFindings(scan.findings, reader);
	return findings === scan.findings ? scan : {
		...scan,
		findings
	};
}
/**
* The summary of a signal as this reader may see it.
*
* For an imported reading that is its fact of having been read and imported, without who read it or what
* the administrator's own refusal said.
*/
function projectSignal(signal, reader) {
	if (reader.assessor || !isImportedReading(signal)) return signal;
	return {
		...without(signal, ["provenance", "unmeasurableReason"]),
		withheld: withheldFrom("admin-reading", reader.group)
	};
}
function projectScanPayload(payload, reader) {
	if (reader.assessor) return payload;
	return {
		...payload,
		findings: projectFindings(payload.findings, reader),
		signals: payload.signals.map((signal) => projectSignal(signal, reader))
	};
}
/** The final result as a reader sees it: the frozen findings, with their evidence projected. */
function projectResultPayload(payload, reader) {
	if (reader.assessor || payload.finalAssessment == null) return payload;
	const { outcome } = payload.finalAssessment;
	return {
		...payload,
		finalAssessment: {
			...payload.finalAssessment,
			outcome: {
				...outcome,
				findings: outcome.findings.map((one) => {
					const [finding] = projectFindings([one.finding], reader);
					return finding === one.finding ? one : {
						...one,
						finding: finding ?? one.finding
					};
				})
			}
		}
	};
}
/** A review whose frozen result, where it has one, is projected. */
function projectReviewPayload(payload, reader) {
	if (reader.assessor || payload.result == null) return payload;
	return {
		...payload,
		result: projectResultPayload(payload.result, reader)
	};
}
function projectStatement(shape, reader) {
	if (shape.statementText == null) return shape;
	return {
		...without(shape, ["statementText"]),
		statementWithheld: withheldFrom("statement-text", reader.group)
	};
}
/** An advisory with the statement text of every shape it lists replaced. */
function projectAdvisoryPayload(payload, reader) {
	if (reader.assessor) return payload;
	const { workload, writes } = payload;
	return {
		...payload,
		...workload != null ? { workload: {
			...workload,
			top: workload.top.map((shape) => projectStatement(shape, reader)),
			failing: workload.failing.map((shape) => projectStatement(shape, reader))
		} } : {},
		...writes != null ? { writes: {
			...writes,
			shapes: writes.shapes.map((shape) => projectStatement(shape, reader))
		} } : {}
	};
}
/** An import's list entry, without who ran the script that collected it. */
function projectImportPayload(payload, reader) {
	if (reader.assessor || payload.collectedBy == null) return payload;
	return {
		...without(payload, ["collectedBy"]),
		collectedByWithheld: withheldFrom("principal-identifiers", reader.group)
	};
}
//#endregion
export { carriesPrincipals, projectAdvisoryPayload, projectEvidence, projectFindings, projectImportPayload, projectResultPayload, projectReviewPayload, projectScan, projectScanPayload, projectSignal, withheldFrom };
