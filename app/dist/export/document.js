import { describeItem } from "../resolve/finding.js";
import { classOf } from "../resolve/evidence-class.js";
import { csv } from "./csv.js";
import { DEFAULT_VARIANT, VARIANT_SHAPES, carriesEvidence, carriesProvenance } from "./variant.js";
const DOCUMENT_KIND = "databricks-waf-assessment";
/** How each unmeasured reason reads to somebody who does not know the app's vocabulary. */
const UNMEASURED = {
	attestation: "no telemetry can answer this; a person has to",
	unreachable: "the platform does not authorise any install of this app to read it",
	unbuilt: "this app does not read this yet",
	unreadable: "the app asked and did not get an answer",
	disabled: "this check is switched off in this install, so this run did not score it"
};
/**
* What to do about a requirement nothing measured, for a column headed `next_step`.
*
* Separate from `UNMEASURED` above because the two columns ask different questions and were answering
* with one string: `why_unmeasured` wants the reason and `next_step` wants an instruction, and a reader
* filtering a spreadsheet to the rows with a step found "no telemetry can answer this; a person has to"
* in the cell they were going to work from. Where the finding carries its own remedy that still wins —
* a resolver that knows why it could not read something knows better than a table.
*/
const STEP_WHEN_UNMEASURED = {
	attestation: "Answer this in the questionnaire, with the name of whoever answered.",
	unreachable: "Nothing, until the platform exposes it. No install of this app can read it.",
	unbuilt: "Nothing. Answer it in the questionnaire if you need it recorded before then.",
	unreadable: "Re-run the scan. If it persists, check what this app is permitted to read.",
	disabled: "Switch the check back on if this requirement should apply here."
};
const MODE = {
	"on-behalf-of-user": "the identity that started it",
	"service-principal": "a service principal"
};
const TRIGGER = {
	interactive: "a person",
	scheduled: "a schedule"
};
/**
* The decision words, in a file's terms rather than a form's.
*
* Not the labels the UI uses. "Fixed it" is right above a radio button and wrong in a spreadsheet
* cell, where the same string is read as a statement about the requirement rather than as the
* choice somebody made about it.
*/
const DISPOSITION = {
	fixed: "reported fixed",
	deferred: "fix planned",
	accepted: "risk accepted",
	reopened: "reopened"
};
/**
* What the run made of the decision, spelled out.
*
* `contradicted` is the reason these columns are in the file at all: a recipient filtering a
* spreadsheet for work that was reported done and did not hold should find it in one filter, and
* "contradicted" alone would need explaining to whoever reads the sheet next.
*/
const STANDING = {
	current: "holding",
	due: "holding, review date close",
	lapsed: "lapsed, back on the list",
	unverified: "not yet checked by a run",
	confirmed: "confirmed by this run",
	contradicted: "this run still finds it unmet",
	settled: "no longer unmet",
	withdrawn: "withdrawn"
};
/**
* How each applicability lever reads in a file, as the thing the customer decided rather than the
* outcome it produced. The outcome is already in the `outcome` column; this is why it reads that way.
*/
const LEVER = {
	"not-applicable": "not applicable, by customer decision",
	disabled: "check disabled by customer"
};
/**
* The applicability decisions that bear on a row, by requirement, from the score's exposure.
*
* An excluded requirement carries its lever, owner and reason. A lapsed one carries only the lever and
* the reading that set it aside — the exposure records no owner or reason for a lapse, and a file that
* invented them would say more than the field under it. Both are shown, because a reader reconciling the
* file against the score needs to tell a requirement a customer took out from one whose exclusion the
* reading has put back.
*/
function exposureIndex(exposure) {
	const index = /* @__PURE__ */ new Map();
	for (const one of exposure?.excluded ?? []) index.set(one.controlId, {
		phrase: LEVER[one.lever],
		decisionId: one.decisionId,
		owner: one.owner,
		reason: one.reason
	});
	for (const one of exposure?.lapsed ?? []) index.set(one.controlId, {
		phrase: `${LEVER[one.lever]} — not applied, this run reads ${one.reading}, so it is in the score`,
		decisionId: one.decisionId,
		owner: "",
		reason: ""
	});
	return index;
}
/**
* Coverage in one cell.
*
* The reach is included because it is the difference between "every workspace in the account" and
* "this workspace", and a recipient who assumes the first when the truth is the second will
* report the wrong thing to their own management.
*/
function coverageCell(coverage) {
	const reach = coverage.reach == null ? "" : ` of the ${coverage.reach}`;
	if (coverage.mode === "complete") return `complete${reach}`;
	if (coverage.examined == null || coverage.population == null) return `sampled${reach}`;
	return `sampled, ${String(coverage.examined)} of ${String(coverage.population)}${reach}`;
}
/** Who read it and from where, in one cell. Empty when the finding rests on nothing observed. */
function attributionCell(provenance) {
	if (provenance == null) return "";
	const where = provenance.from == null ? "" : `, from ${provenance.from}`;
	return `${provenance.actor} (${provenance.authority})${where}`;
}
/**
* The one thing to do about this finding.
*
* The catalogue's remediation when the app measured the requirement and found it unmet, and the
* finding's own remedy when it could not measure it at all. Never both: they answer the same
* question at different stages, and a cell holding two instructions is a cell a reader skips.
*/
function nextStepCell(finding, control) {
	if (finding.outcome === "unmeasurable") return finding.remedy?.says ?? STEP_WHEN_UNMEASURED[finding.unmeasured ?? "unreadable"];
	if (finding.outcome === "fail" || finding.outcome === "partial") return control?.remediation?.summary ?? "";
	return "";
}
/**
* The review in one cell, and the only place a spreadsheet can say it.
*
* Four states rather than two, because a review can be finished with pillars nobody looked at, and a
* cell reading `reviewed` on a run with three skips would be the file claiming more than the record.
* Which pillars were skipped is in the JSON document's `review` block; a cell has no room for names
* and a count of them would not say which.
*
* Blank where there is no record, which is an install that keeps no reviews rather than a run nobody
* reviewed — the same distinction `started_by` leaves blank for.
*/
function reviewCell(finalisation) {
	if (finalisation == null) return "";
	if (!finalisation.finalised) return `review unfinished (${String(finalisation.recorded)} of ${String(finalisation.expected)} pillars)`;
	const result = finalisation.resultId == null ? "finalised" : `published report ${finalisation.resultId}`;
	if (finalisation.confirmed === 0) return `${result}, no pillar confirmed`;
	if (finalisation.confirmed !== finalisation.expected) return `${result}, ${String(finalisation.confirmed)} of ${String(finalisation.expected)} pillars confirmed`;
	return `${result}, every pillar confirmed`;
}
/**
* The review as the JSON document carries it: the fields, and a sentence saying what they are not.
*
* The skipped pillars by id and not as a count, because a recipient asking which parts of the score
* nobody reviewed cannot get that from a number — the same reason the payload carries ids.
*/
function reviewBlock(finalisation) {
	return {
		...finalisation.resultId != null ? { finalResultId: finalisation.resultId } : {},
		finalised: finalisation.finalised,
		pillarsRecorded: finalisation.recorded,
		pillarsExpected: finalisation.expected,
		pillarsConfirmed: finalisation.confirmed,
		pillarsSkipped: finalisation.skipped,
		answersCited: finalisation.cited,
		means: reviewCell(finalisation),
		answersCitedMeans: "Answers this run already held, copied when a pillar was confirmed. Not a count of the answers on record now, which moves after the review.",
		...finalisation.skipped.length > 0 ? { pillarsSkippedMeans: "Nobody confirmed the answers of these pillars in this review. Their requirements are in the score on whatever the run measured." } : {},
		...finalisation.finalisedAt != null ? { finalisedAt: finalisation.finalisedAt.toISOString() } : {},
		...finalisation.finalisedBy != null ? { finalisedBy: finalisation.finalisedBy } : {}
	};
}
/**
* How each column is written, one function per column name.
*
* A map rather than a positional list, because four variants carry overlapping subsets of these and
* the alternative is four lists of expressions that have to be kept saying the same thing. The
* column order is `EXPORT_COLUMNS`, which every variant filters rather than reorders — so a reader
* comparing two variants of one run reads the same columns in the same order, with some missing.
*/
const CELL = {
	run: (row) => row.scan.id,
	variant: (row) => row.variant,
	ran_at: (row) => row.scan.finishedAt.toISOString(),
	ran_as: (row) => row.scan.stamp.actor,
	ran_with: (row) => MODE[row.scan.stamp.executionMode],
	started_by: (row) => row.scan.stamp.trigger == null ? "" : TRIGGER[row.scan.stamp.trigger],
	methodology_version: (row) => String(row.scan.stamp.publicMethodology?.publicVersion ?? ""),
	methodology_state: (row) => row.scan.stamp.publicMethodology?.state ?? "pre-release",
	methodology_manifest: (row) => row.scan.stamp.publicMethodology?.manifestDigest ?? "",
	methodology_effective_date: (row) => row.scan.stamp.publicMethodology?.effectiveDate ?? "",
	catalogue_revision: (row) => row.scan.stamp.catalogueVersion,
	review: (row) => reviewCell(row.finalisation),
	app_build: (row) => axisCell(row.scan.stamp.identity?.build),
	scoring_method: (row) => axisCell(row.scan.stamp.identity?.methodology),
	pillar: (row) => row.pillar,
	requirement: (row) => row.finding.controlId,
	title: (row) => row.finding.title,
	outcome: (row) => row.finding.outcome,
	severity: (row) => row.finding.severity,
	reason: (row) => row.finding.outcomeReason ?? "",
	observed: (row) => row.finding.evidence.map((one) => one.observed).join("; "),
	expected: (row) => row.finding.evidence.map((one) => one.expected).filter((one) => one != null).join("; "),
	coverage: (row) => coverageCell(row.finding.coverage),
	evidence: (row) => classOf(row.finding) ?? "",
	why_unmeasured: (row) => row.finding.unmeasured == null ? "" : UNMEASURED[row.finding.unmeasured],
	next_step: (row) => nextStepCell(row.finding, row.control),
	answered_by: (row) => row.finding.attested?.by ?? "",
	answered_at: (row) => row.finding.attested?.at.toISOString() ?? "",
	answer_review_by: (row) => row.finding.attested?.reviewBy.toISOString() ?? "",
	accountable: (row) => row.finding.attested?.owner ?? "",
	decision_id: (row) => row.decided?.decision.id ?? "",
	decision: (row) => row.decided == null ? "" : DISPOSITION[row.decided.decision.disposition],
	decision_standing: (row) => row.decided == null ? "" : STANDING[row.decided.standing],
	decision_reason: (row) => row.decided?.decision.reason ?? "",
	decided_by: (row) => row.decided?.decision.decidedBy ?? "",
	decided_at: (row) => row.decided?.decision.decidedAt.toISOString() ?? "",
	decision_owner: (row) => row.decided?.decision.owner ?? "",
	decision_date: (row) => row.decided?.decision.until?.toISOString() ?? "",
	applicability: (row) => row.applied?.phrase ?? "",
	applicability_id: (row) => row.applied?.decisionId ?? "",
	applicability_owner: (row) => row.applied?.owner ?? "",
	applicability_reason: (row) => row.applied?.reason ?? "",
	read_as: (row) => attributionCell(row.first?.provenance),
	collected_at: (row) => row.first?.collectedAt.toISOString() ?? "",
	documentation: (row) => row.control?.remediation?.docUrl ?? row.control?.sourceRef ?? "",
	where: (row) => row.finding.evidence.flatMap((one) => one.at?.items ?? []).flatMap((item) => item.url != null ? [`${describeItem(item)}: ${item.url}`] : []).join(" ")
};
/**
* An identity axis as one cell: what it was, or why this build could not establish it.
*
* Never blank for a run that recorded the axis, because a blank in a column of digests reads as "the
* same as the others" to somebody scanning it. A run from before identity was recorded has nothing to
* say and says nothing, which is the one honest empty here.
*/
function axisCell(axis) {
	if (axis == null) return "";
	return axis.id ?? (axis.unknown == null ? "" : `not established: ${axis.unknown}`);
}
/**
* One row per finding, including the ones that are not applicable.
*
* Not filtered to failures, in any variant. A recipient checking whether a requirement was considered
* needs to find it in the file and read "not applicable, and here is why" — an absent row is
* indistinguishable from a requirement the app forgot, and that suspicion is the thing an
* assessment cannot recover from. `variant.ts` says why that rule holds even for the file somebody
* sends to a board.
*/
function assessmentRows(options) {
	const { scan, catalogue } = options;
	const variant = options.variant ?? "technical";
	const columns = VARIANT_SHAPES[variant].columns;
	const controls = new Map(catalogue.controls.map((control) => [control.id, control]));
	const pillars = new Map(catalogue.pillars.map((pillar) => [pillar.id, pillar.title]));
	const decisions = decisionIndex(options.decisions);
	const applied = exposureIndex(scan.score.exposure);
	return [columns, ...scan.findings.map((finding) => {
		const row = {
			scan,
			variant,
			finding,
			control: controls.get(finding.controlId),
			decided: decisions.get(finding.controlId),
			applied: applied.get(finding.controlId),
			pillar: pillars.get(finding.pillarId) ?? finding.pillarId,
			finalisation: options.finalisation,
			first: finding.evidence.find((one) => one.bearing !== "detail") ?? finding.evidence[0]
		};
		return columns.map((column) => CELL[column](row));
	})];
}
function assessmentCsv(options) {
	return csv(assessmentRows(options));
}
/**
* The decisions that bear on a row, by requirement, with the withdrawn ones dropped.
*
* A withdrawn decision is history rather than a state of the requirement, and a spreadsheet cell
* reading "reopened" beside a failure would be read as something being done about it.
*/
function decidedField(entry) {
	if (entry == null) return {};
	const { decision } = entry;
	return { decision: {
		id: decision.id,
		choice: decision.disposition,
		means: DISPOSITION[decision.disposition],
		reason: decision.reason,
		decidedBy: decision.decidedBy,
		decidedAt: decision.decidedAt.toISOString(),
		...decision.owner != null ? { owner: decision.owner } : {},
		...decision.until != null ? { until: decision.until.toISOString() } : {},
		...decision.supersedes != null ? { supersedes: decision.supersedes } : {},
		standing: entry.standing,
		standingMeans: STANDING[entry.standing]
	} };
}
function decisionIndex(decisions) {
	return new Map((decisions ?? []).filter((entry) => entry.standing !== "withdrawn").map((entry) => [entry.decision.controlId, entry]));
}
/**
* The same assessment with its structure intact.
*
* Deliberately not the wire format the UI consumes. That one is shaped for a page that already
* has the catalogue loaded, so its findings carry ids and no requirement text; a file has to
* stand on its own, so each finding here carries the title, the judging criteria and the fix.
*
* Every field is a fact about the run or about what has been decided against it, and there is
* deliberately nothing here about the export itself — no time it was taken, no identity that took it.
* That is what makes the bytes a function of the record rather than of the request, which is what lets
* a recipient check the file at all; who took it and when is in the trail, where it is a fact about a
* person rather than a property of the assessment. Do not add a timestamp back. ADR 0050.
*/
function assessmentDocument(options) {
	const { scan, catalogue } = options;
	const variant = options.variant ?? "technical";
	const shape = VARIANT_SHAPES[variant];
	const controls = new Map(catalogue.controls.map((control) => [control.id, control]));
	const pillars = new Map(catalogue.pillars.map((pillar) => [pillar.id, pillar.title]));
	const decisions = decisionIndex(options.decisions);
	return {
		document: DOCUMENT_KIND,
		documentVersion: 4,
		variant,
		variantMeans: shape.says,
		...shape.omits != null ? { variantOmits: shape.omits } : {},
		run: {
			id: scan.id,
			startedAt: scan.startedAt.toISOString(),
			finishedAt: scan.finishedAt.toISOString(),
			/** `partial` means the run stopped short of its plan; `incompleteReason` says why. */
			state: scan.state,
			ranAs: scan.stamp.actor,
			ranWith: scan.stamp.executionMode,
			...scan.stamp.trigger != null ? { startedBy: scan.stamp.trigger } : {},
			covered: scan.stamp.scope.description,
			lookbackDays: scan.stamp.lookbackDays,
			...scan.stamp.assessedWorkspaces != null ? { assessedWorkspaces: scan.stamp.assessedWorkspaces } : {},
			methodology: scan.stamp.publicMethodology == null ? { classification: "pre-release" } : {
				classification: "public",
				...scan.stamp.publicMethodology
			},
			technicalCatalogue: {
				revision: scan.stamp.catalogueVersion,
				fingerprint: scan.stamp.catalogueFingerprint
			},
			anySampled: scan.findings.some((one) => one.coverage.mode === "sampled"),
			...scan.requestedPillars != null ? { measuredPillars: scan.requestedPillars } : {},
			...scan.incompleteReason != null ? { incompleteReason: scan.incompleteReason } : {},
			...scan.notCarried != null ? { notCarried: scan.notCarried } : {},
			...shape.produced ? producedField(scan) : {}
		},
		estate: scan.estate,
		score: scan.score,
		...options.finalisation != null ? { review: reviewBlock(options.finalisation) } : {},
		findings: scan.findings.map((finding) => {
			const control = controls.get(finding.controlId);
			return {
				requirement: finding.controlId,
				pillar: pillars.get(finding.pillarId) ?? finding.pillarId,
				pillarId: finding.pillarId,
				principleId: finding.principleId,
				title: finding.title,
				outcome: finding.outcome,
				severity: finding.severity,
				coverage: finding.coverage,
				...classOf(finding) != null ? { restsOn: classOf(finding) } : {},
				...finding.outcomeReason != null ? { reason: finding.outcomeReason } : {},
				...finding.unmeasured != null ? { unmeasured: {
					kind: finding.unmeasured,
					means: UNMEASURED[finding.unmeasured]
				} } : {},
				...finding.remedy != null ? { remedy: finding.remedy } : {},
				...carriesEvidence(shape.detail) ? { evidence: finding.evidence.map((one) => ({
					signal: one.signal,
					observed: one.observed,
					...one.expected != null ? { expected: one.expected } : {},
					bearing: one.bearing ?? "outcome",
					evidenceClass: one.evidenceClass ?? "observed",
					coverage: one.coverage,
					collectedAt: one.collectedAt.toISOString(),
					...one.provenance != null && carriesProvenance(shape.detail) ? { readBy: one.provenance } : {},
					...one.at != null ? { links: one.at.items.flatMap((item) => item.url != null ? [{
						label: describeItem(item),
						url: item.url
					}] : []) } : {}
				})) } : {},
				...finding.attested != null ? { answeredByAPerson: {
					...finding.attested,
					at: finding.attested.at.toISOString(),
					reviewBy: finding.attested.reviewBy.toISOString()
				} } : {},
				...decidedField(decisions.get(finding.controlId)),
				...control?.criteria != null && carriesEvidence(shape.detail) ? { judgedBy: control.criteria } : {},
				...control?.rationale != null ? { whyItMatters: control.rationale } : {},
				...control?.remediation != null ? { remediation: control.remediation } : {},
				...control?.sourceRef != null ? { source: control.sourceRef } : {}
			};
		})
	};
}
/**
* What produced the run, for the file whose reader is establishing whether the numbers can be relied
* on rather than reading them.
*
* Four axes and the assessment the run answers to, each carried as what it was *or* as why this build
* could not establish it — the distinction `scan/identity.ts` exists for, and the reason this is not a
* block of digests with blanks in it. An axis nobody could establish is a fact about the run; a blank
* is a reader guessing.
*
* Absent from a run recorded before identity was kept, rather than filled in: back-filling would put a
* claim about what produced a run into the one document whose whole job is to be checkable.
*/
function producedField(scan) {
	const identity = scan.stamp.identity;
	if (identity == null && scan.stamp.definition == null) return {};
	return { producedBy: {
		...identity != null ? {
			build: identity.build,
			scoringMethod: identity.methodology,
			recordEncoding: identity.record,
			/** Which surfaces answered. A run with no warehouse bound did not measure the same estate. */
			sources: identity.sources
		} : {},
		...scan.stamp.definition != null ? { assessment: scan.stamp.definition } : {}
	} };
}
/**
* A filename that tells three downloads apart.
*
* The date, the run and the variant, because a reader comparing last month with this month has both
* files in one folder and `export.csv (2)` tells them nothing about which is which — and because a
* recipient checking a digest has to be holding the variant it was published for. Two variants of one
* run are different bytes, so a filename that did not distinguish them would produce a mismatch that
* reads as tampering. The complete file keeps the name it has always had, so a runbook that downloads
* it and checks the name still works.
*/
function exportName(scan, extension, variant = DEFAULT_VARIANT) {
	const day = scan.finishedAt.toISOString().slice(0, 10);
	const which = variant === "technical" ? "" : `-${variant}`;
	return `well-architected-${day}-${scan.id.slice(0, 8)}${which}.${extension}`;
}
//#endregion
export { DOCUMENT_KIND, assessmentCsv, assessmentDocument, assessmentRows, attributionCell, coverageCell, exportName };
