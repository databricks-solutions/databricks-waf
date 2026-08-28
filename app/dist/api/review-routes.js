import { InvalidAttestationError, draftFrom } from "../attest/attestation.js";
import { registerAttestation } from "../attest/register.js";
import { assessmentOf } from "./assessment-query.js";
import { InvalidReviewError, answered, confirmed, openedFor, pillarEvidenceManifest, selectedPillarsOf, skipped } from "../review/review.js";
import { publicationOf } from "../review/final-assessment.js";
import { FinalAssessmentProjectionError } from "../review/projection.js";
import { eligible, ineligible } from "../shared/api/eligibility.js";
//#region server/api/review-routes.ts
const NO_STORE = "This installation is not keeping reviews, so there is nowhere to put one. Bind a database and restart, and a confirm or a skip will survive a deploy.";
const NOT_DURABLE = "Reviews are being kept in memory on this installation, so a restart loses every one of them. A review is a judgement somebody made while reading a run they will not open again — bind a database before relying on it.";
const NO_ANSWERS = "This installation is not keeping answers, so a requirement cannot be answered from inside a review. Bind a database and restart. Confirming and skipping this review still work.";
function registerReviewRoutes(app, options) {
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	app.get("/api/reviews", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		try {
			const open = await store.openReviews(assessmentOf(request));
			const payload = {
				eligibility: eligible(),
				reviews: open.map((one) => presentReview(one, store, options.reviewStorage)),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.reviewStorage ?? NOT_DURABLE }
			};
			response.json(dated(payload));
		} catch (cause) {
			readFailure(response, "reviews", cause);
		}
	});
	app.get("/api/reviews/for/:runId", async (request, response) => {
		const store = options.reviews;
		const runId = one(request.params.runId);
		if (runId === "") {
			response.status(404).json({
				error: "unknown-review",
				message: "A review has to name the scan it is of."
			});
			return;
		}
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		try {
			const got = await store.forRun(runId, assessmentOf(request));
			if (got == null) {
				gateFailure(response, 404, ineligible("unknown", "unknown-review", `There is no review of scan ${runId}.`, "Open the review created for this exact run, or start the review and retry."));
				return;
			}
			response.json(dated(presentReview(got, store, options.reviewStorage)));
		} catch (cause) {
			readFailure(response, "review", cause);
		}
	});
	app.get("/api/reviews/:id", async (request, response) => {
		const store = options.reviews;
		const id = one(request.params.id);
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		if (id === "") {
			gateFailure(response, 404, ineligible("unknown", "unknown-review", "No review has that id.", "Open a review from the Review page."));
			return;
		}
		try {
			const got = await store.get(id, assessmentOf(request));
			if (got == null) {
				gateFailure(response, 404, ineligible("unknown", "unknown-review", "There is no review with that id.", "Return to the Review page and open a review that exists."));
				return;
			}
			response.json(dated(presentReview(got, store, options.reviewStorage)));
		} catch (cause) {
			readFailure(response, "review", cause);
		}
	});
	app.get("/api/results/current", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "results-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		try {
			const result = await store.current(assessmentOf(request));
			const resultEligibility = result == null ? ineligible("unknown", "result-unknown", "No report has been published yet.", "Complete every selected pillar in an open review to publish the first report.") : eligibilityOfResult(result, options.pillars);
			const payload = {
				eligibility: resultEligibility,
				...result != null && resultEligibility.eligible ? { result: presentResult(result) } : {},
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.reviewStorage ?? NOT_DURABLE }
			};
			response.json(dated(payload));
		} catch (cause) {
			readFailure(response, "current result", cause, "published report");
		}
	});
	app.get("/api/results", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "results-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		try {
			const scope = assessmentOf(request);
			const runs = await options.scans.history(void 0, scope);
			const results = await Promise.all(runs.map(async (run) => {
				const result = (await store.forRun(run.id, scope))?.result;
				if (result == null) return void 0;
				const resultEligibility = eligibilityOfResult(result, options.pillars);
				if (!resultEligibility.eligible) throw new IneligibleStoredResult(resultEligibility);
				return presentResultSummary(run, result);
			}));
			const payload = {
				eligibility: eligible(),
				results: results.filter((one) => one != null),
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.reviewStorage ?? NOT_DURABLE }
			};
			response.json(dated(payload));
		} catch (cause) {
			if (cause instanceof IneligibleStoredResult) {
				gateFailure(response, 409, cause.eligibility);
				return;
			}
			readFailure(response, "result history", cause, "report history");
		}
	});
	app.get("/api/results/:id", async (request, response) => {
		const store = options.reviews;
		const id = one(request.params.id);
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "results-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		if (id === "") {
			gateFailure(response, 404, ineligible("unknown", "unknown-result", "No report has that id.", "Open a named report from report history."));
			return;
		}
		try {
			const result = await store.result(id, assessmentOf(request));
			if (result == null) {
				gateFailure(response, 404, ineligible("unknown", "unknown-result", "There is no report with that id.", "Return to report history and open a report that exists."));
				return;
			}
			const resultEligibility = eligibilityOfResult(result, options.pillars);
			if (!resultEligibility.eligible) {
				gateFailure(response, 409, resultEligibility);
				return;
			}
			response.json(dated(presentResult(result)));
		} catch (cause) {
			readFailure(response, "result", cause, "report");
		}
	});
	app.post("/api/reviews", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		let act;
		try {
			const runId = runIdFrom(request.body);
			const permission = await options.permitted(request, response, "review.open", { target: {
				kind: "run",
				id: runId === "" ? "unknown" : runId
			} });
			act = permission.act;
			if (runId === "") {
				await refuse(response, act, 400, "invalid-review", "A review has to name the scan it is of.");
				return;
			}
			const scope = assessmentOf(request);
			const scan = await options.scans.get(runId, scope);
			if (scan == null) {
				await refuse(response, act, 404, "unknown-run", `There is no completed scan ${runId} in this assessment, so there is nothing to review.`);
				return;
			}
			const review = await store.open({
				...openedFor(scan, {
					id: newId(),
					openedAt: now()
				}),
				openedBy: permission.actor
			});
			const got = await store.get(review.id, scope);
			await act.performed({
				kind: "run",
				id: runId
			});
			response.status(201).json(dated(presentReview(got ?? {
				review,
				pillars: [],
				answers: []
			}, store, options.reviewStorage)));
		} catch (cause) {
			await act?.failed(reviewFailureReason(cause));
			respond(response, cause, options, act != null);
		}
	});
	app.post("/api/reviews/:id/pillars/:pillarId/confirm", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		let act;
		try {
			const pillarId = one(request.params.pillarId);
			const permission = await options.permitted(request, response, "review.confirm", { target: {
				kind: "pillar",
				id: pillarId === "" ? "unknown" : pillarId
			} });
			act = permission.act;
			const written = await pillarRecord(request, options, store, permission.actor, (draft) => draft.manifest.attentionControlIds.length > 0 ? { refused: {
				status: 409,
				error: "pillar-needs-attention",
				message: `${String(draft.manifest.attentionControlIds.length)} ${draft.manifest.attentionControlIds.length === 1 ? "question still needs" : "questions still need"} attention in this pillar. Answer or refresh them before confirming it.`
			} } : { pillar: confirmed({
				...draft,
				attestationIds: draft.manifest.attestationIds
			}, options.pillars) });
			if (written.refused != null) {
				await refuse(response, act, written.refused.status, written.refused.error, written.refused.message);
				return;
			}
			await act.performed({
				kind: "pillar",
				id: pillarId
			});
			response.status(201).json(dated(presentReview(written.record, store, options.reviewStorage)));
		} catch (cause) {
			await act?.failed(reviewFailureReason(cause));
			respond(response, cause, options, act != null);
		}
	});
	app.post("/api/reviews/:id/pillars/:pillarId/skip", async (request, response) => {
		const store = options.reviews;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		let act;
		try {
			const pillarId = one(request.params.pillarId);
			const permission = await options.permitted(request, response, "review.skip", { target: {
				kind: "pillar",
				id: pillarId === "" ? "unknown" : pillarId
			} });
			act = permission.act;
			const written = await pillarRecord(request, options, store, permission.actor, (draft) => ({ pillar: skipped({
				...draft,
				unresolvedControlIds: draft.manifest.unresolvedControlIds
			}, options.pillars) }));
			if (written.refused != null) {
				await refuse(response, act, written.refused.status, written.refused.error, written.refused.message);
				return;
			}
			await act.performed({
				kind: "pillar",
				id: pillarId
			});
			response.status(201).json(dated(presentReview(written.record, store, options.reviewStorage)));
		} catch (cause) {
			await act?.failed(reviewFailureReason(cause));
			respond(response, cause, options, act != null);
		}
	});
	app.post("/api/reviews/:id/pillars/:pillarId/answers", async (request, response) => {
		const store = options.reviews;
		const attestations = options.attestations;
		const control = options.control;
		if (store == null) {
			gateFailure(response, 503, ineligible("unavailable", "reviews-unavailable", NO_STORE, "Bind the durable review database, restart the app, and retry."));
			return;
		}
		if (attestations == null || control == null) {
			response.status(503).json({
				error: "attestations-unavailable",
				message: NO_ANSWERS
			});
			return;
		}
		let act;
		try {
			const reviewId = one(request.params.id);
			const pillarId = one(request.params.pillarId);
			const permission = await options.permitted(request, response, "review.answer", { target: {
				kind: "pillar",
				id: pillarId === "" ? "unknown" : pillarId
			} });
			act = permission.act;
			if (reviewId === "" || pillarId === "") {
				await refuse(response, act, 400, "invalid-review", "An answer has to name the review and the pillar.");
				return;
			}
			const scope = assessmentOf(request);
			const assembled = await store.get(reviewId, scope);
			if (assembled == null) {
				await refuse(response, act, 404, "unknown-review", "There is no review with that id in this assessment.");
				return;
			}
			const boundary = reviewWriteRefusal(assembled.review, pillarId, options.pillars);
			if (boundary != null) {
				await refuse(response, act, boundary.status, boundary.error, boundary.message);
				return;
			}
			const draft = draftFrom(request.body, (id) => control(id) != null);
			const spec = control(draft.controlId);
			if (spec == null) {
				await refuse(response, act, 400, "unknown-control", `No requirement with id ${draft.controlId}.`);
				return;
			}
			if (spec.pillarId !== pillarId) {
				await refuse(response, act, 400, "wrong-pillar", `${draft.controlId} belongs to ${spec.pillarId}, not to ${pillarId}, so answering it here would be counted against a pillar it is not part of.`);
				return;
			}
			const cadenceDays = options.cadenceDays?.(spec);
			const definitionId = scope ?? void 0;
			const attestation = await registerAttestation({
				store: attestations,
				draft,
				actor: permission.actor,
				severity: spec.severity,
				...cadenceDays != null ? { cadenceDays } : {},
				...definitionId != null ? { definitionId } : {}
			});
			await store.answer(answered({
				id: newId(),
				reviewId,
				runId: assembled.review.runId,
				pillarId,
				controlId: draft.controlId,
				attestationId: attestation.id,
				by: permission.actor,
				at: now()
			}, options.pillars));
			await act.performed({
				kind: "control",
				id: draft.controlId
			});
			const got = await store.get(reviewId, scope);
			response.status(201).json(dated(presentReview(got ?? assembled, store, options.reviewStorage)));
		} catch (cause) {
			await act?.failed(reviewFailureReason(cause));
			if (cause instanceof InvalidAttestationError) {
				response.status(400).json({
					error: "invalid-attestation",
					message: cause.message
				});
				return;
			}
			respond(response, cause, options, act != null);
		}
	});
}
async function pillarRecord(request, options, store, actor, build) {
	const reviewId = one(request.params.id);
	const pillarId = one(request.params.pillarId);
	const now = options.now ?? (() => /* @__PURE__ */ new Date());
	const newId = options.newId ?? (() => crypto.randomUUID());
	if (reviewId === "" || pillarId === "") return { refused: {
		status: 400,
		error: "invalid-review",
		message: "A pillar record has to name the review and the pillar."
	} };
	const scope = assessmentOf(request);
	const assembled = await store.get(reviewId, scope);
	if (assembled == null) return { refused: {
		status: 404,
		error: "unknown-review",
		message: "There is no review with that id in this assessment."
	} };
	const boundary = reviewWriteRefusal(assembled.review, pillarId, options.pillars);
	if (boundary != null) return { refused: boundary };
	const scan = await options.scans.get(assembled.review.runId, scope);
	if (scan == null) return { refused: {
		status: 404,
		error: "unknown-run",
		message: `The scan this review is of is not in this assessment, so there is nothing to confirm or skip against.`
	} };
	const at = now();
	const current = await options.attestations?.current(scope) ?? [];
	const built = build({
		id: newId(),
		reviewId,
		runId: assembled.review.runId,
		pillarId,
		by: actor,
		at,
		scan,
		record: assembled,
		manifest: pillarEvidenceManifest(options.requirementsFor(scan), current, pillarId, at)
	});
	if ("refused" in built) return { refused: built.refused };
	await store.record(built.pillar);
	return { record: await store.get(reviewId, scope) ?? assembled };
}
function reviewWriteRefusal(review, pillarId, known) {
	if (review.definitionId == null) return {
		status: 409,
		error: "assessment-definition-required",
		message: "This custom run has no saved assessment definition. Its automated results remain available, but Review cannot record human decisions or publish a report. Define an assessment and run it to continue."
	};
	if (!known.includes(pillarId)) return void 0;
	if (!selectedPillarsOf(review, known).includes(pillarId)) return {
		status: 409,
		error: "pillar-not-selected",
		message: `${pillarId} was not selected for this assessment, so Review cannot record a decision against it.`
	};
}
function presentReview(record, store, storage) {
	return {
		id: record.review.id,
		runId: record.review.runId,
		openedBy: record.review.openedBy,
		openedAt: record.review.openedAt,
		...record.review.definitionId != null ? { definitionId: record.review.definitionId } : {},
		...record.review.selectedPillars != null ? { selectedPillars: record.review.selectedPillars } : {},
		pillars: record.pillars.map(presentPillar),
		answers: record.answers.map((one) => ({
			id: one.id,
			pillarId: one.pillarId,
			controlId: one.controlId,
			attestationId: one.attestationId,
			by: one.by,
			at: one.at
		})),
		...record.result != null ? { result: presentResult(record.result) } : {},
		durable: store.durable,
		...store.durable ? {} : { durabilityNote: storage ?? NOT_DURABLE }
	};
}
function presentResult(result) {
	const final = result.schemaVersion === 2 && result.finalAssessment != null ? result : void 0;
	return {
		id: result.id,
		reviewId: result.reviewId,
		runId: result.runId,
		finalisedBy: result.finalisedBy,
		finalisedAt: result.finalisedAt,
		pillars: result.pillars.map(presentPillar),
		attestationIds: result.attestationIds,
		...final != null ? { finalAssessment: {
			schemaVersion: 2,
			definition: final.finalAssessment.definition,
			versions: final.finalAssessment.versions,
			executionMode: final.finalAssessment.executionMode,
			automatedEvidence: final.finalAssessment.automatedEvidence,
			humanEvidence: final.finalAssessment.humanEvidence,
			decisions: final.finalAssessment.decisions,
			outcome: {
				findings: final.finalAssessment.outcome.findings,
				score: final.finalAssessment.outcome.score,
				coverage: final.finalAssessment.outcome.coverage
			},
			disclosure: final.finalAssessment.disclosure,
			publication: final.finalAssessment.publication
		} } : {}
	};
}
function presentResultSummary(run, result) {
	if (result.schemaVersion !== 2 || result.finalAssessment == null) return void 0;
	const final = result.finalAssessment;
	const findings = final.outcome.findings.map((one) => one.finding);
	const of = (...outcomes) => findings.filter((finding) => outcomes.includes(finding.outcome)).length;
	return {
		...run,
		resultId: result.id,
		finishedAt: result.finalisedAt,
		...final.outcome.score.overall != null ? { overall: final.outcome.score.overall } : {},
		...final.outcome.score.range != null ? { range: final.outcome.score.range } : {},
		counts: {
			pass: of("pass", "satisfied-by-architecture"),
			fail: of("fail"),
			partial: of("partial"),
			unmeasurable: of("unmeasurable"),
			notApplicable: of("not-applicable")
		},
		pillarScores: Object.fromEntries(final.outcome.score.pillars.filter((pillar) => pillar.score != null).map((pillar) => [pillar.pillarId, pillar.score])),
		outcomes: Object.fromEntries(findings.map((finding) => [finding.controlId, finding.outcome])),
		...run.stamp != null ? { stamp: {
			...run.stamp,
			publicMethodology: final.versions.methodology,
			catalogueVersion: final.versions.catalogue.revision,
			catalogueFingerprint: final.versions.catalogue.fingerprint,
			executionMode: final.executionMode,
			definition: {
				...run.stamp.definition,
				...final.definition
			}
		} } : {}
	};
}
function presentPillar(one) {
	return {
		id: one.id,
		reviewId: one.reviewId,
		runId: one.runId,
		pillarId: one.pillarId,
		kind: one.kind,
		...one.attestationIds != null ? { attestationIds: one.attestationIds } : {},
		...one.unresolvedControlIds != null ? { unresolvedControlIds: one.unresolvedControlIds } : {},
		by: one.by,
		at: one.at
	};
}
function runIdFrom(body) {
	if (body == null || typeof body !== "object") return "";
	const runId = body.runId;
	return typeof runId === "string" ? runId.trim() : "";
}
function one(raw) {
	return typeof raw === "string" ? raw.trim() : "";
}
function dated(payload) {
	if (payload instanceof Date) return payload.toISOString();
	if (Array.isArray(payload)) return payload.map((entry) => dated(entry));
	if (payload != null && typeof payload === "object") return Object.fromEntries(Object.entries(payload).map(([key, value]) => [key, dated(value)]));
	return payload;
}
var IneligibleStoredResult = class extends Error {
	eligibility;
	constructor(eligibility) {
		super(eligibility.reason.message);
		this.eligibility = eligibility;
	}
};
function eligibilityOfResult(result, pillars) {
	const blocking = publicationOf(result, pillars).reasons.filter((reason) => reason !== "methodology-not-released");
	if (blocking.length === 0) return eligible();
	return ineligible("incomplete", "result-incomplete", `Published report ${result.id} is incomplete or inconsistent: ${blocking.join(", ")}.`, "Complete a new assessment and review under the released methodology, then retry with that report.");
}
function gateFailure(response, status, eligibility) {
	response.status(status).json({
		error: eligibility.reason.code,
		message: eligibility.reason.message,
		action: eligibility.reason.action,
		eligibility
	});
}
function readFailure(response, subject, cause, customerSubject = subject) {
	gateFailure(response, 503, ineligible("unreadable", `${subject.replaceAll(" ", "-")}-unreadable`, `The ${customerSubject} could not be read, so this request cannot be completed safely.`, "Restore the database connection and retry this exact request."));
}
async function refuse(response, act, status, error, message) {
	await act.failed(error);
	response.status(status).json({
		error,
		message
	});
}
function respond(response, cause, options, writeStarted) {
	if (cause instanceof FinalAssessmentProjectionError) {
		gateFailure(response, 409, ineligible("incomplete", "final-assessment-refused", cause.message, "Correct the named review input and retry this exact pillar decision."));
		return;
	}
	if (cause instanceof InvalidReviewError) {
		response.status(400).json({
			error: "invalid-review",
			message: customerReviewMessage(cause.message)
		});
		return;
	}
	if (writeStarted) {
		gateFailure(response, 503, ineligible("unreadable", "review-write-unreadable", "The review could not be saved, so no decision was accepted.", "Restore the database connection and retry this exact review action."));
		return;
	}
	options.respondToFailure(response, cause);
}
/** Translate storage-model language at the public boundary without changing the durable store contract. */
function customerReviewMessage(message) {
	return message.replace(/This review already has a result/g, "This review has already published a report").replace(/Final assessment projection/g, "Publishing the report").replace(/The final assessment was written/g, "The report was published").replace(/The stored final assessment/g, "The published report").replace(/this review acted on/g, "this review used");
}
function reviewFailureReason(cause) {
	return cause instanceof FinalAssessmentProjectionError || cause instanceof InvalidReviewError ? cause : "review-write-unreadable";
}
//#endregion
export { customerReviewMessage, registerReviewRoutes };
