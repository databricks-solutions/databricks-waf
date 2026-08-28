import { selectedPillarsOf } from "./review.js";
/**
* Adds the complete Version 2 body to a result assembled from stored review decisions.
*
* This does no projection. Row 107b owns producing `findings` and `score`; this function owns the
* record boundary, its internal agreement and the publication classification those facts support.
*/
function versionedFinalAssessment(result, draft, knownPillars) {
	const unresolved = new Map(draft.unresolved.map((one) => [one.pillarId, canonicalIds(one.controlIds)]));
	const decisions = result.pillars.map((pillar) => ({
		decisionId: pillar.id,
		pillarId: pillar.pillarId,
		kind: pillar.kind,
		unresolvedControlIds: unresolved.get(pillar.pillarId) ?? []
	}));
	const reused = canonicalIds(draft.humanEvidence.filter((one) => one.selection === "reused").map((one) => one.attestationId));
	const refreshed = canonicalIds(draft.humanEvidence.filter((one) => one.selection === "refreshed").map((one) => one.attestationId));
	const skipped = canonicalIds(result.pillars.filter((one) => one.kind === "skipped").map((one) => one.pillarId));
	const unresolvedControls = canonicalIds(draft.unresolved.flatMap((one) => one.controlIds));
	const unmeasured = canonicalIds(draft.unmeasuredControlIds);
	const findingIds = draft.findings.map((one) => one.id);
	const evidenceIds = draft.findings.flatMap((one) => one.evidenceIds);
	const disclosure = {
		reusedAttestationIds: reused,
		refreshedAttestationIds: refreshed,
		skippedPillarIds: skipped,
		unresolvedControlIds: unresolvedControls,
		unmeasuredControlIds: unmeasured,
		counts: {
			reused: reused.length,
			refreshed: refreshed.length,
			skipped: skipped.length,
			unresolved: unresolvedControls.length,
			unmeasured: unmeasured.length
		}
	};
	const withoutPublication = {
		definition: { ...draft.definition },
		versions: {
			methodology: { ...draft.versions.methodology },
			catalogue: { ...draft.versions.catalogue },
			scoring: draft.versions.scoring
		},
		executionMode: draft.executionMode,
		automatedEvidence: {
			runDigest: draft.runDigest,
			findingIds: [...findingIds],
			evidenceIds: [...evidenceIds]
		},
		humanEvidence: draft.humanEvidence.map((one) => ({ ...one })),
		decisions,
		outcome: {
			findings: draft.findings.map((one) => ({
				...one,
				evidenceIds: [...one.evidenceIds],
				confidence: {
					...one.confidence,
					limitations: [...one.confidence.limitations]
				}
			})),
			score: frozenScore(draft.score),
			coverage: {
				answered: answered(draft.score),
				total: draft.score.totalControls
			}
		},
		disclosure
	};
	const candidate = {
		...result,
		schemaVersion: 2,
		finalAssessment: {
			...withoutPublication,
			publication: {
				eligible: false,
				reasons: []
			}
		}
	};
	const publication = contentPublication(candidate, knownPillars);
	return {
		...candidate,
		finalAssessment: {
			...candidate.finalAssessment,
			publication
		}
	};
}
/** The classification consumers use instead of trusting a stored boolean on its own. */
function publicationOf(result, knownPillars) {
	if (result.schemaVersion == null) return {
		eligible: false,
		reasons: ["legacy-result"]
	};
	if (result.schemaVersion !== 2) return {
		eligible: false,
		reasons: ["unsupported-schema"]
	};
	if (!isObject(result.finalAssessment)) return {
		eligible: false,
		reasons: ["incomplete-contract"]
	};
	let expected;
	try {
		expected = contentPublication(result, selectedPillarsOf(result, knownPillars));
	} catch {
		return {
			eligible: false,
			reasons: ["incomplete-contract"]
		};
	}
	const stored = result.finalAssessment.publication;
	if (!isPublication(stored) || !samePublication(stored, expected)) {
		const incomplete = isPublication(stored) ? [] : ["incomplete-contract"];
		return {
			eligible: false,
			reasons: canonicalReasons([
				...expected.reasons,
				...incomplete,
				"publication-mismatch"
			])
		};
	}
	return expected;
}
/** Restores dates nested inside the frozen findings after JSONB has returned plain strings. */
function reviveFinalAssessment(result) {
	if (result.schemaVersion !== 2) return result;
	if (!isRevivableContract(result.finalAssessment)) throw new TypeError("The Version 2 outcome cannot be revived.");
	const contract = result.finalAssessment;
	const findings = contract.outcome.findings.map((snapshot) => ({
		...snapshot,
		finding: reviveFinding(snapshot.finding)
	}));
	return {
		...result,
		finalAssessment: {
			...contract,
			outcome: {
				...contract.outcome,
				findings
			}
		}
	};
}
function contentPublication(result, knownPillars) {
	const reasons = [];
	const contract = result.finalAssessment;
	const nonblank = (value) => typeof value === "string" && value.trim() !== "";
	if (!isObject(contract) || !isObject(contract.definition) || !isObject(contract.versions) || !isObject(contract.versions.methodology) || !isObject(contract.versions.catalogue) || !isObject(contract.automatedEvidence) || !isObject(contract.outcome) || !isObject(contract.disclosure) || !Array.isArray(contract.humanEvidence) || !Array.isArray(contract.decisions) || !Array.isArray(contract.outcome.findings) || !isObject(contract.outcome.score) || !isObject(contract.outcome.coverage) || !nonblank(contract.definition.id) || !Number.isInteger(contract.definition.version) || contract.definition.version < 1 || !nonblank(contract.definition.fingerprint) || !Number.isInteger(contract.versions.methodology.publicVersion) || contract.versions.methodology.publicVersion < 1 || !nonblank(contract.versions.methodology.manifestDigest) || !nonblank(contract.versions.catalogue.revision) || !nonblank(contract.versions.catalogue.fingerprint) || !nonblank(contract.versions.scoring) || !nonblank(contract.automatedEvidence.runDigest) || !Array.isArray(contract.automatedEvidence.findingIds) || !Array.isArray(contract.automatedEvidence.evidenceIds) || contract.outcome.findings.length === 0 || !Number.isInteger(contract.outcome.score.totalControls) || contract.outcome.score.totalControls < 1) reasons.push("incomplete-contract");
	if (contract.versions?.methodology?.state !== "released") reasons.push("methodology-not-released");
	const wanted = canonicalIds(knownPillars);
	const recorded = canonicalIds(result.pillars.map((one) => one.pillarId));
	const decided = canonicalIds(contract.decisions?.map((one) => one.pillarId) ?? []);
	if (!sameIds(wanted, recorded) || !sameIds(wanted, decided)) reasons.push("pillar-set-incomplete");
	if (result.definitionId == null || result.definitionId !== contract.definition?.id || result.definitionVersion == null || result.definitionVersion !== contract.definition?.version || result.definitionFingerprint == null || result.definitionFingerprint !== contract.definition?.fingerprint) reasons.push("scope-mismatch");
	const cited = canonicalIds(result.attestationIds);
	const manifested = canonicalIds(contract.humanEvidence?.map((one) => one.attestationId) ?? []);
	const findingIds = contract.outcome?.findings?.map((one) => one.id) ?? [];
	const evidenceIds = contract.outcome?.findings?.flatMap((one) => one.evidenceIds) ?? [];
	const evidenceLengthsAgree = contract.outcome?.findings?.every((one) => one.evidenceIds.length === one.finding.evidence.length) ?? false;
	if (!sameIds(cited, manifested) || !uniqueNonblank(findingIds) || !uniqueNonblank(evidenceIds) || !sameIds(canonicalIds(findingIds), canonicalIds(contract.automatedEvidence?.findingIds ?? [])) || !sameIds(canonicalIds(evidenceIds), canonicalIds(contract.automatedEvidence?.evidenceIds ?? [])) || !evidenceLengthsAgree) reasons.push("evidence-manifest-mismatch");
	const skipped = canonicalIds(result.pillars.filter((one) => one.kind === "skipped").map((one) => one.pillarId));
	const decisionByPillar = new Map(contract.decisions?.map((one) => [one.pillarId, one]) ?? []);
	const decisionsAgree = result.pillars.every((pillar) => {
		const decision = decisionByPillar.get(pillar.pillarId);
		if (decision == null || decision.decisionId !== pillar.id || decision.kind !== pillar.kind) return false;
		return pillar.kind === "skipped" || decision.unresolvedControlIds.length === 0;
	});
	const disclosure = contract.disclosure;
	const reused = canonicalIds(contract.humanEvidence?.filter((one) => one.selection === "reused").map((one) => one.attestationId) ?? []);
	const refreshed = canonicalIds(contract.humanEvidence?.filter((one) => one.selection === "refreshed").map((one) => one.attestationId) ?? []);
	const unresolved = canonicalIds(contract.decisions?.flatMap((one) => one.unresolvedControlIds) ?? []);
	if (!decisionsAgree || !isObject(disclosure?.counts) || !sameIds(reused, canonicalIds(disclosure?.reusedAttestationIds ?? [])) || !sameIds(refreshed, canonicalIds(disclosure?.refreshedAttestationIds ?? [])) || !sameIds(skipped, canonicalIds(disclosure?.skippedPillarIds ?? [])) || !sameIds(unresolved, canonicalIds(disclosure?.unresolvedControlIds ?? [])) || disclosure?.counts?.reused !== reused.length || disclosure?.counts?.refreshed !== refreshed.length || disclosure?.counts?.skipped !== skipped.length || disclosure?.counts?.unresolved !== unresolved.length || disclosure?.counts?.unmeasured !== (disclosure?.unmeasuredControlIds?.length ?? -1)) reasons.push("disclosure-mismatch");
	const unique = canonicalReasons(reasons);
	return {
		eligible: unique.length === 0,
		reasons: unique
	};
}
function frozenScore(score) {
	return {
		...score,
		pillars: score.pillars.map((pillar) => ({ ...pillar })),
		counts: { ...score.counts },
		composition: { ...score.composition }
	};
}
function answered(score) {
	return score.counts.pass + score.counts["satisfied-by-architecture"] + score.counts.partial + score.counts.fail;
}
function reviveFinding(finding) {
	return {
		...finding,
		evidence: finding.evidence.map((one) => ({
			...one,
			collectedAt: new Date(one.collectedAt)
		})),
		...finding.attested != null ? { attested: {
			...finding.attested,
			at: new Date(finding.attested.at),
			reviewBy: new Date(finding.attested.reviewBy)
		} } : {}
	};
}
function canonicalIds(values) {
	return [...new Set(values)].sort();
}
function canonicalReasons(values) {
	return [...new Set(values)].sort();
}
function sameIds(left, right) {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}
function uniqueNonblank(values) {
	return values.every((value) => value.trim() !== "") && new Set(values).size === values.length;
}
function samePublication(left, right) {
	return left.eligible === right.eligible && sameIds([...left.reasons].sort(), [...right.reasons].sort());
}
function isPublication(value) {
	return isObject(value) && typeof value.eligible === "boolean" && Array.isArray(value.reasons) && value.reasons.every((reason) => typeof reason === "string");
}
function isRevivableContract(value) {
	if (!isObject(value) || !isObject(value.outcome) || !Array.isArray(value.outcome.findings)) return false;
	return value.outcome.findings.every((snapshot) => {
		if (!isObject(snapshot) || !isObject(snapshot.finding) || !Array.isArray(snapshot.finding.evidence)) return false;
		if (!snapshot.finding.evidence.every((evidence) => isObject(evidence) && isDateInput(evidence.collectedAt))) return false;
		return snapshot.finding.attested == null || isObject(snapshot.finding.attested) && isDateInput(snapshot.finding.attested.at) && isDateInput(snapshot.finding.attested.reviewBy);
	});
}
function isDateInput(value) {
	return typeof value === "string" || value instanceof Date;
}
function isObject(value) {
	return typeof value === "object" && value != null;
}
//#endregion
export { publicationOf, reviveFinalAssessment, versionedFinalAssessment };
