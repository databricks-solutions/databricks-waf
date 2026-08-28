import { NotPermittedError, recordRefusal, requirePermission } from "../authorize/group.js";
import { NO_CHANGELOG, spanBetween } from "../catalogue/changelog.js";
import { authoredGuidance } from "../guidance/guidance.js";
import { DIRECTORY_SIGNAL } from "../collect/sql/collector.js";
import { clientFor } from "../collect/rest/client.js";
import { MissingUserTokenError, USER_TOKEN_HEADER, actorFromHeaders, fromRequest } from "../collect/credentials.js";
import { declaredScopes } from "../collect/rest/declared-scopes.js";
import { StatementExecutor } from "../collect/sql/statements.js";
import { probeReach } from "../collect/rest/reach.js";
import { InvalidAttestationError, cadenceDaysFor, draftFrom, stateOf } from "../attest/attestation.js";
import { BLOCKED_QUESTIONS } from "../attest/blocked-questions.js";
import { INCONCLUSIVE_QUESTIONS } from "../attest/inconclusive-questions.js";
import { registerAttestation } from "../attest/register.js";
import { InvalidDecisionError, draftFrom as draftFrom$1, parkDays } from "../decide/decision.js";
import { registerDecision } from "../decide/register.js";
import { parked, standingsFor } from "../decide/standing.js";
import { answeredControls } from "../score/score.js";
import { contained } from "./contain.js";
import { currentVersion } from "../define/definition.js";
import { probeStatement, sourcesFor } from "../define/preflight.js";
import { registerDefinitionRoutes } from "./definition-routes.js";
import { registerImportRoutes } from "./import-routes.js";
import { AUDIT_PHRASES } from "../audit/event.js";
import { registerAuditRoutes } from "./audit-routes.js";
import { registerHealthRoutes } from "./health-routes.js";
import { comparable } from "../shared/api/comparability.js";
import { registerMethodologyRoutes } from "./methodology-routes.js";
import { registerRetentionRoutes } from "./retention-routes.js";
import { EXPORT_VARIANTS, VARIANT_SHAPES, variantOf } from "../export/variant.js";
import { DIGEST_HEADER, howToCheck, seal } from "../export/artefact.js";
import { assessmentOf, scopedHref } from "./assessment-query.js";
import { registerImproveRoutes } from "./improve-routes.js";
import { registerNoteRoutes } from "./note-routes.js";
import { registerFoundationRoutes } from "./foundation-routes.js";
import { servingSql } from "../foundation/serving-sql.js";
import { registerTopologyRoutes } from "./topology-routes.js";
import { collectNamedTopology } from "../collect/topology/collector.js";
import { confidenceOf } from "../resolve/confidence.js";
import { CollectionScheduler } from "../scan/scheduler.js";
import { describeEstate } from "../scan/estate.js";
import "../scan/scan.js";
import { publicationOf } from "../review/final-assessment.js";
import { ineligible } from "../shared/api/eligibility.js";
import { registerReviewRoutes } from "./review-routes.js";
import { finalisationOf } from "../review/finalisation.js";
import { registerValidateRoutes } from "./validate-routes.js";
import { registerRiskRoutes } from "./risk-routes.js";
import { registerApplicabilityRoutes } from "./applicability-routes.js";
import { readTargets } from "../programme/targets.js";
import { signalDescriptors } from "../plan/descriptors.js";
import { EstateScopeError, accountScope, hostWorkspaceFromEnvironment, probeCurrentUser, scopeFromProbe, selectedScope } from "../collect/estate-scope.js";
import { TrailUnwritableError, closedWhenAnswered } from "../audit/record.js";
import { MEANS, describeVerification } from "../records/verify.js";
import { ScanInProgressError } from "../scan/runner.js";
import { RunNotJoinable } from "../run/runs.js";
import { refusedPayload, registerRunRoutes } from "./run-routes.js";
import { read } from "../schedule/schedule.js";
import { scheduleRoutes } from "./schedule-routes.js";
import { registerPublicationRoutes } from "./publication-routes.js";
import { registerAdvisoryRoutes } from "./advisory-routes.js";
import { reportOn } from "../collect/rest/token.js";
import { SCRIPT_NAME, evidenceScriptPayload, loadEvidenceScript } from "../evidence/script.js";
import { occurrencesIn } from "../scan/occurrence.js";
import { changesBetween } from "../scan/changes.js";
import { beyondAnyInstall, buildPlan, descriptorsById } from "../plan/plan.js";
//#region server/api/routes.ts
function registerApi(served, options) {
	/**
	* Every handler below, and every handler in the sixteen route modules this function hands `app`
	* to, is registered through the containment proxy rather than on the application directly.
	*
	* Sited here rather than at the `server.extend` call in server.ts so that it cannot be bypassed by
	* a second caller, and so the route tests exercise the same arrangement production serves on.
	* `contain.ts` says why an express 4 under an app declaring express 5 makes this necessary.
	*/
	const app = contained(served);
	/**
	* Refuse content sniffing on every API response.
	*
	* The export carries names this app did not choose — table names, catalogue names, the text of
	* a permission error — so a customer who can name a table decides part of the bytes. Those
	* bytes are served with an explicit non-HTML content type and as an attachment, and `nosniff`
	* is what makes the declaration binding rather than advisory: without it a browser is free to
	* decide a `text/csv` body beginning with a tag is really HTML, and render it.
	*/
	app.use("/api", (_request, response, next) => {
		response.setHeader("X-Content-Type-Options", "nosniff");
		next();
	});
	/**
	* Where a run stands with its review, for the payload that carries its score.
	*
	* Read here rather than left to a second request, because every surface that shows a score has the
	* scan and none of them should be able to render one without the answer beside it. `undefined`
	* where this install keeps no reviews, and where the store cannot be read at all — a review store
	* that is down is a thing this app cannot say, and a page that fell over would replace a score
	* nobody has reviewed with no score at all.
	*/
	async function standingOf(runId, scope) {
		if (options.reviews == null) return void 0;
		try {
			return finalisationOf(await options.reviews.forRun(runId, scope), options.catalogue.pillars.map((pillar) => pillar.id));
		} catch {
			return;
		}
	}
	registerDefinitionRoutes(app, {
		...options.definitions != null ? { definitions: options.definitions } : {},
		...options.drafts != null ? { drafts: options.drafts } : {},
		...options.definitionStorage != null ? { definitionStorage: options.definitionStorage } : {},
		store: options.store,
		pillars: options.pillars ?? options.catalogue.pillars.map((pillar) => pillar.id),
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure,
		currentDirectory: async (request) => {
			const identity = await identify(request, options.host);
			const credentials = fromRequest(request, options.host, identity.actor, identity.actorName);
			const collector = options.collectorsFor({
				credentials,
				scope: identity.scope,
				lookbackDays: 30
			}).find((candidate) => candidate.signals.includes(DIRECTORY_SIGNAL));
			if (collector == null) return {
				asOf: /* @__PURE__ */ new Date(),
				unavailable: "This installation has no collector for the account workspace directory."
			};
			const [reading] = await collector.collect([DIRECTORY_SIGNAL], {
				credentials,
				scheduler: new CollectionScheduler(),
				collected: /* @__PURE__ */ new Map()
			});
			if (reading?.status !== "observed" || reading.value == null) return {
				asOf: reading?.collectedAt ?? /* @__PURE__ */ new Date(),
				unavailable: reading?.unmeasurableReason ?? "The account workspace directory returned no reading."
			};
			return {
				directory: reading.value,
				asOf: reading.collectedAt
			};
		},
		sources: (measurement) => sourcesFor({
			catalogue: options.catalogue,
			registry: options.registry,
			descriptors: signalDescriptors(),
			measurement
		}),
		probeFor: (request, actor) => {
			const warehouseId = options.warehouse?.();
			if (warehouseId == null) throw new Error("No SQL warehouse is bound, so nothing can be probed.");
			const credentials = fromRequest(request, options.host, actor);
			const executor = new StatementExecutor({
				host: options.host,
				warehouseId,
				token: async () => (await credentials.databricks()).token()
			});
			return async (table) => {
				await executor.query(probeStatement(table), {});
			};
		}
	});
	/**
	* What a run executes, built once.
	*
	* Lazily and then kept, because building it reads the fifteen shipped query files to derive
	* which tables each statement touches. Nothing in it varies per request or per user — it
	* describes the app's own behaviour, not the estate — so re-deriving it per request would be
	* fifteen file reads to produce the same bytes.
	*/
	let plan;
	app.get("/api/plan", (_request, response) => {
		plan ??= buildPlan({
			catalogue: options.catalogue,
			registry: options.registry,
			...options.pillars != null ? { measuredPillars: options.pillars } : {}
		});
		response.json(plan);
	});
	app.get("/api/catalogue", (_request, response) => {
		const payload = {
			version: options.catalogue.version,
			measuredPillars: options.pillars ?? null,
			pillars: options.catalogue.pillars.map((pillar) => ({
				id: pillar.id,
				code: pillar.code,
				title: pillar.title,
				...pillar.page != null ? { page: pillar.page } : {},
				principles: pillar.principles.map((principle) => ({
					id: principle.id,
					title: principle.title,
					...principle.sourceAnchor != null ? { sourceAnchor: principle.sourceAnchor } : {},
					controls: principle.controls.map((control) => ({
						id: control.id,
						title: control.title,
						severity: control.severity,
						provenance: control.provenance,
						measurability: control.measurability,
						evaluatorStatus: control.evaluatorStatus,
						...control.aliasGroup != null ? { aliasGroup: control.aliasGroup } : {},
						...control.criteria != null ? { criteria: control.criteria } : {},
						...control.rationale != null ? { rationale: control.rationale } : {},
						...control.remediation != null ? { remediation: control.remediation } : {},
						...control.sourceRef != null ? { sourceRef: control.sourceRef } : {}
					}))
				}))
			}))
		};
		response.json(payload);
	});
	registerMethodologyRoutes(app, { catalogue: options.catalogue });
	app.get("/api/scans", async (request, response) => {
		const scope = assessmentOf(request);
		const scans = await options.store.history(void 0, scope);
		const failure = options.store.unreadable?.();
		const linked = await Promise.all(scans.map(async (scan) => {
			const standing = await standingOf(scan.id, scope);
			return standing?.resultId == null ? scan : {
				...scan,
				resultId: standing.resultId
			};
		}));
		const payload = {
			durable: options.store.durable,
			...options.store.durable ? {} : { durabilityNote: options.storage ?? "Scan history is held in memory for now and is lost when the app restarts, which happens on every deploy. Durable storage is not yet configured." },
			...failure != null ? { unreadable: `Scan history could not be read from the database, so this list may be short or empty. Runs already recorded are not lost. The database reported: ${failure}` } : {},
			scans: linked
		};
		response.json(payload);
	});
	/**
	* Whether the stored records are still what this app wrote.
	*
	* A read, so it is open to anyone who can open the app — the same authority under which they can
	* read the records themselves. It reports rather than enforces: nothing else in the app consults
	* it, because a scan that refused to run because a year-old row was edited would be punishing the
	* wrong person for the wrong thing. What it is for is the moment somebody is asked to stand behind
	* an artefact, which is a moment with a human in it.
	*/
	app.get("/api/records/verification", async (_request, response) => {
		if (options.verifyRecords == null) {
			response.json({
				checked: false,
				summary: "This install keeps no records, so there is nothing to check. Scan history, answers and decisions are held in memory and lost on restart.",
				means: MEANS
			});
			return;
		}
		try {
			const report = await options.verifyRecords();
			response.json({
				checked: true,
				...report,
				summary: describeVerification(report)
			});
		} catch (cause) {
			response.status(503).json({
				error: "verification-unavailable",
				message: `The stored records could not be read back, so nothing about their integrity is being claimed. The database reported: ${cause instanceof Error ? cause.message : String(cause)}`
			});
		}
	});
	app.get("/api/scans/latest", async (request, response) => {
		const scan = await options.store.latest(assessmentOf(request));
		if (scan == null) {
			response.status(404).json({
				error: "no-scans",
				message: "No assessment has been run yet. Run one to see its findings and posture."
			});
			return;
		}
		response.json(present(scan, await historyFor(options.store, assessmentOf(request)), options.catalogue.changelog, await targetsFor(scan, options.definitions, /* @__PURE__ */ new Date()), await standingOf(scan.id, assessmentOf(request))));
	});
	app.get("/api/scans/:id", async (request, response) => {
		const scan = await options.store.get(request.params.id, assessmentOf(request));
		if (scan == null) {
			response.status(404).json({
				error: "scan-not-found",
				message: `No scan with id ${request.params.id}. Scan history does not survive an app restart yet.`
			});
			return;
		}
		response.json(present(scan, await historyFor(options.store, assessmentOf(request)), options.catalogue.changelog, await targetsFor(scan, options.definitions, /* @__PURE__ */ new Date()), await standingOf(scan.id, assessmentOf(request))));
	});
	app.get("/api/scans/:id/comparison/:otherId", async (request, response) => {
		const scope = assessmentOf(request);
		const [scan, other] = await Promise.all([options.store.get(request.params.id, scope), options.store.get(request.params.otherId, scope)]);
		if (scan == null || other == null) {
			response.status(404).json({
				error: "scan-not-found",
				message: "One of those scans is not available."
			});
			return;
		}
		const [older, newer] = other.finishedAt.getTime() <= scan.finishedAt.getTime() ? [other, scan] : [scan, other];
		const verdict = comparable(scan.stamp, other.stamp, spanBetween(options.catalogue.changelog, older.stamp.catalogueVersion, newer.stamp.catalogueVersion));
		response.json(verdict.ok ? {
			comparable: true,
			from: {
				id: other.id,
				overall: other.score.overall,
				finishedAt: other.finishedAt
			},
			to: {
				id: scan.id,
				overall: scan.score.overall,
				finishedAt: scan.finishedAt
			},
			...verdict.caveat != null ? { caveat: verdict.caveat } : {}
		} : {
			comparable: false,
			reason: verdict.reason
		});
	});
	/**
	* Where serverless readiness used to live, kept as a redirect.
	*
	* The analysis moved onto the advisory run in row 33d, so it is no longer addressed by a scan id —
	* which is the point of the move rather than a side effect of it. An assessment measures the estate
	* against a framework; whether a job could move to serverless is advice about what to change, and
	* riding the scan meant every assessment paid for two account-wide statements to produce a page it
	* did not have to serve.
	*
	* A redirect rather than a 410, and the id is discarded rather than translated, because there is no
	* advisory that corresponds to a given scan: the two are separate runs over separate windows. A
	* caller asking about a particular scan's serverless analysis is asking a question that no longer
	* has an answer, and the closest true one is what the advisor last concluded.
	*
	* 308 rather than 302 so the method and body survive it, and so a client caches the new location
	* instead of asking here forever.
	*/
	app.get("/api/scans/:id/serverless", (_request, response) => {
		response.redirect(308, "/api/advisory/latest");
	});
	/**
	* The assessment as a file, for somebody who was not in the room.
	*
	* Two formats from one builder, and `latest` accepted as an id so the download the page offers
	* and the one a curl in a runbook fetches are the same URL. A GET rather than a POST of a
	* client-side render, because the file has to be the stored scan rather than whatever the page
	* currently has filtered on screen: a customer forwarding "the assessment" and meaning "the
	* eleven rows I was looking at" is how a report gets argued with in a meeting nobody enjoys.
	*
	* Content-Disposition is set so a browser saves rather than renders it, with a filename that
	* carries the date and the run. See export/document.
	*
	* Two literal routes rather than one with `:format(csv|json)`, which Express 4 would accept and
	* Express 5 would not: the inline-regex form went away with path-to-regexp v8, and a route that
	* silently stops matching on a dependency bump is a worse trade than one repeated line.
	*/
	/**
	* The run an export route was asked for, or a 404 explaining which of the two absences it is.
	*
	* Shared by the download and by the route that publishes digests without serving bytes, so the two
	* cannot resolve `latest` differently. That matters more than the saved lines: a published digest
	* for one run beside a download of another is a mismatch a recipient would read as tampering.
	*/
	const exportSubject = async (request, response) => {
		const scan = request.params.id === "latest" ? await options.store.latest(assessmentOf(request)) : await options.store.get(request.params.id, assessmentOf(request));
		if (scan != null) return scan;
		response.status(404).json({
			error: "scan-not-found",
			message: request.params.id === "latest" ? "No scan has been run yet, so there is nothing to export." : `No scan with id ${request.params.id}. Scan history is kept in the bound Lakebase database, unless this app is running with WAF_DEMO_NO_PERSISTENCE set, in which case a restart lost it.`
		});
	};
	const finalResultSubject = async (request, response) => {
		const scope = assessmentOf(request);
		const reviews = options.reviews;
		if (reviews == null) {
			resultGateFailure(response, 503, ineligible("unavailable", "results-unavailable", "This installation has no review database, so report eligibility cannot be established.", "Bind the durable review database, restart the app, and retry this exact request."));
			return;
		}
		let result;
		try {
			result = await reviews.result(request.params.id, scope);
		} catch {
			resultGateFailure(response, 503, ineligible("unreadable", "result-unreadable", `Published report ${request.params.id} could not be read, so no report can be produced.`, "Restore the database connection and retry this exact request."));
			return;
		}
		if (result == null) {
			resultGateFailure(response, 404, ineligible("unknown", "unknown-result", `No report with id ${request.params.id} exists in this assessment.`, "Return to report history and open a report that exists."));
			return;
		}
		const blocking = publicationOf(result, options.pillars ?? options.catalogue.pillars.map((pillar) => pillar.id)).reasons.filter((reason) => reason !== "methodology-not-released");
		if (blocking.length > 0) {
			resultGateFailure(response, 409, ineligible("incomplete", "result-incomplete", `Published report ${result.id} is incomplete or inconsistent: ${blocking.join(", ")}.`, "Complete a new assessment and review under the released methodology, then use that report."));
			return;
		}
		let source;
		try {
			source = await options.store.get(result.runId, scope);
		} catch {
			resultGateFailure(response, 503, ineligible("unreadable", "result-source-unreadable", `Published report ${result.id} names source run ${result.runId}, but the run history could not be read.`, "Restore the database connection and retry this exact request."));
			return;
		}
		if (source == null) {
			resultGateFailure(response, 409, ineligible("incomplete", "result-source-missing", `Published report ${result.id} names source run ${result.runId}, but that run could not be read.`, "Restore the named immutable run before retrying this result, report, or export."));
			return;
		}
		const scan = scanFromFinalResult(result, source);
		if (scan == null) {
			resultGateFailure(response, 409, ineligible("incomplete", "legacy-result", `Published report ${result.id} predates the Version 2 outcome and cannot produce a report file.`, "Complete a new assessment and review under Methodology Version 1, then use that report."));
			return;
		}
		return {
			scan,
			resultId: result.id,
			result
		};
	};
	/**
	* The decisions that may travel with an export of this run.
	*
	* A standing is a comparison between a decision and one particular run, so writing one into an
	* export of an earlier scan would put a claim in the file that the rest of the file contradicts.
	* The newest run is the one every standing was computed against, and an export of anything else
	* carries the assessment as it was measured, with the decision columns empty.
	*/
	const exportDecisions = async (scan) => {
		const scope = scan.stamp.definition?.id ?? null;
		const newest = await latestOrNothing(options.store, scope);
		if (newest == null || newest.id !== scan.id || options.decisions == null) return [];
		return standingsFor(await options.decisions.current(scope), {
			findings: scan.findings,
			measuredAt: scan.finishedAt
		});
	};
	const exportFile = (format, subject) => async (request, response) => {
		const resolved = await subject(request, response);
		if (resolved == null) return;
		const { scan, correlation } = resolved;
		const variant = variantOf(request.query.variant);
		if (variant == null) {
			response.status(400).json({
				error: "unknown-variant",
				message: `This app produces four exports of a run: ${EXPORT_VARIANTS.join(", ")}. Ask for one of those, or omit the parameter for the complete file.`
			});
			return;
		}
		const decided = await exportDecisions(scan);
		const reviewed = await standingOf(scan.id, scan.stamp.definition?.id ?? null);
		const file = seal({
			scan,
			catalogue: options.catalogue,
			decisions: decided,
			format,
			variant,
			...reviewed != null ? { finalisation: reviewed } : {}
		});
		await unguarded(request, response, options, "export.scan", { correlation }).performed({
			kind: "artefact",
			id: file.name,
			digest: file.digest
		});
		response.setHeader("Content-Type", file.contentType);
		response.setHeader("Content-Disposition", `attachment; filename="${file.name}"`);
		response.setHeader(DIGEST_HEADER, file.digest);
		response.send(file.bytes);
	};
	const exportScan = (format) => exportFile(format, async (request, response) => {
		const scan = await exportSubject(request, response);
		return scan == null ? void 0 : {
			scan,
			correlation: scan.id
		};
	});
	const exportResult = (format) => exportFile(format, async (request, response) => {
		const result = await finalResultSubject(request, response);
		return result == null ? void 0 : {
			scan: result.scan,
			correlation: result.resultId
		};
	});
	app.get("/api/scans/:id/export.csv", exportScan("csv"));
	app.get("/api/scans/:id/export.json", exportScan("json"));
	app.get("/api/results/:id/export.csv", exportResult("csv"));
	app.get("/api/results/:id/export.json", exportResult("json"));
	/**
	* What each export of this run should hash to, without serving one.
	*
	* The same separation the evidence script has, in the opposite direction. There, the app publishes
	* a digest so an admin can check a file before running it; here, so somebody who has *sent* an
	* export can tell the recipient what to expect — and so the value is on a page they can read out,
	* rather than in a response header of a download they have already put in an email.
	*
	* Not recorded in the trail. Nothing left the app: this is the digest of a file that would be
	* produced, and a row saying somebody looked at a checksum would be the kind of entry that makes an
	* auditor scroll past the rows that matter. The download beside it is what is recorded.
	*
	* Sealing every file to answer is deliberate rather than a cached table. It is the same code path
	* the download takes, over the same stored run, so the published digest cannot drift from the served
	* bytes — which is the one failure this route has, and the one that would be read as tampering.
	*
	* Eight files: four variants in two formats. Sealing all eight is eight passes over the findings of
	* one run, which is a few milliseconds on a catalogue of this size and buys the property above for
	* every variant rather than for the two a page happens to link.
	*/
	/**
	* What has already been taken from this run, from the trail.
	*
	* Read from the audit log rather than kept in a table of its own, because it is already there: an
	* export records the filename and the digest of the bytes that left, which is exactly the pair a
	* sender needs to read back. A second store would be a second answer to one question.
	*
	* Each row is compared against what a file of that name would hash to now, and that comparison is
	* the reason this exists. An export describes the run *and the decisions standing against it*, so
	* accepting a risk after sending a copy changes the next download — a recipient checks, reports a
	* mismatch, and somebody spends an afternoon on a tampering scare that was a decision recorded on
	* Thursday. `current: false` says so on the page instead.
	*
	* Empty when no trail is bound, which is the same page an install without persistence has always
	* shown: the digests above are still worth publishing when nothing recorded who took them.
	*/
	const exportsTaken = async (action, correlation, current) => {
		if (options.audit == null) return [];
		return (await options.audit.trail.search({
			action,
			correlation,
			outcome: "performed",
			limit: EXPORTS_SHOWN
		})).events.flatMap((event) => {
			const target = event.target;
			if (target?.kind !== "artefact" || target.digest == null) return [];
			const now = current.get(target.id);
			return [{
				name: target.id,
				digest: target.digest,
				at: event.at.toISOString(),
				by: event.actor,
				...now == null ? {} : { current: now === target.digest }
			}];
		});
	};
	const listExports = async (scan, identity) => {
		const decided = await exportDecisions(scan);
		const reviewed = await standingOf(scan.id, scan.stamp.definition?.id ?? null);
		const fileOf = (variant, format) => {
			const file = seal({
				scan,
				catalogue: options.catalogue,
				decisions: decided,
				format,
				variant,
				...reviewed != null ? { finalisation: reviewed } : {}
			});
			return {
				name: file.name,
				format,
				variant,
				digest: file.digest,
				bytes: file.bytes.byteLength,
				href: scopedHref(variant === "technical" ? `/api/${identity.resultId == null ? "scans" : "results"}/${identity.resultId ?? scan.id}/export.${format}` : `/api/${identity.resultId == null ? "scans" : "results"}/${identity.resultId ?? scan.id}/export.${format}?variant=${variant}`, scan.stamp.definition?.id),
				verify: howToCheck(file)
			};
		};
		const variants = EXPORT_VARIANTS.map((variant) => {
			const shape = VARIANT_SHAPES[variant];
			return {
				variant,
				says: shape.says,
				...shape.omits != null ? { omits: shape.omits } : {},
				files: ["csv", "json"].map((format) => fileOf(variant, format))
			};
		});
		const current = new Map(variants.flatMap((entry) => entry.files.map((file) => [file.name, file.digest])));
		return {
			scanId: scan.id,
			files: variants.find((entry) => entry.variant === "technical")?.files ?? [],
			variants,
			taken: await exportsTaken("export.scan", identity.correlation, current)
		};
	};
	app.get("/api/scans/:id/exports", async (request, response) => {
		const scan = await exportSubject(request, response);
		if (scan == null) return;
		response.json(await listExports(scan, { correlation: scan.id }));
	});
	app.get("/api/results/:id/exports", async (request, response) => {
		const result = await finalResultSubject(request, response);
		if (result == null) return;
		response.json(await listExports(result.scan, {
			correlation: result.resultId,
			resultId: result.resultId
		}));
	});
	/**
	* What a run changed against the run before it.
	*
	* A separate endpoint from the comparison above, which answers whether two named scans may be
	* compared at all. This one picks the predecessor itself — the run immediately before by
	* finish time — because "what did this run change" is the question a history row raises and
	* making the reader choose the other side of the comparison first is a worse way to ask it.
	*/
	app.get("/api/scans/:id/changes", async (request, response) => {
		const scope = assessmentOf(request);
		const scan = await options.store.get(request.params.id, scope);
		if (scan == null) {
			response.status(404).json({
				error: "scan-not-found",
				message: "That run is not in the recorded history."
			});
			return;
		}
		const earlier = (await options.store.history(void 0, scope)).filter((entry) => entry.id !== scan.id && entry.finishedAt.getTime() <= scan.finishedAt.getTime()).sort((a, b) => b.finishedAt.getTime() - a.finishedAt.getTime())[0];
		const payload = changesBetween(scan, earlier == null ? void 0 : await options.store.get(earlier.id, scope), options.catalogue, options.catalogue.changelog);
		response.json(payload);
	});
	app.get("/api/results/:id/changes", async (request, response) => {
		const resolved = await finalResultSubject(request, response);
		if (resolved == null) return;
		const { scan, result } = resolved;
		const scope = assessmentOf(request);
		try {
			const history = await options.store.history(void 0, scope);
			const prior = (await Promise.all(history.map(async (entry) => {
				const candidate = (await options.reviews?.forRun(entry.id, scope))?.result;
				return candidate == null || candidate.id === result.id ? void 0 : candidate;
			}))).filter((candidate) => candidate != null && candidate.finalisedAt.getTime() <= result.finalisedAt.getTime()).sort((left, right) => right.finalisedAt.getTime() - left.finalisedAt.getTime())[0];
			const priorSource = prior == null ? void 0 : await options.store.get(prior.runId, scope);
			const previous = prior == null || priorSource == null ? void 0 : scanFromFinalResult(prior, priorSource);
			response.json(changesBetween(scan, previous, options.catalogue, options.catalogue.changelog));
		} catch {
			resultGateFailure(response, 503, ineligible("unreadable", "result-history-unreadable", `The comparison history for published report ${result.id} could not be read.`, "Restore the database connection and retry this comparison."));
		}
	});
	app.get("/api/scan/status", (_request, response) => {
		const running = options.runner.running();
		const run = options.runs?.holding();
		const payload = running == null ? { running: false } : {
			running: true,
			startedAt: running.startedAt,
			actor: running.actor,
			scope: running.scope,
			callsMade: running.callsMade,
			...running.trigger != null && { trigger: running.trigger },
			...run != null && { run }
		};
		response.json(payload);
	});
	/**
	* Run the assessment.
	*
	* One implementation behind two routes, because the two differ in exactly two ways and
	* nothing else: what the run records about why it happened, and what happens when it comes
	* back having measured nothing. The authority is identical — both read as whoever the Apps
	* proxy says the caller is — and a second copy of this would be a second place for the
	* scheduled path to fall behind the interactive one. See ADR 0021.
	*/
	const runScanFor = (trigger) => async (request, response) => {
		let act;
		try {
			const asked = askedFor(request);
			if (asked instanceof RunRequestError) {
				response.status(400).json({
					error: asked.kind,
					message: asked.message
				});
				return;
			}
			const answering = await answeringDefinition(asked.definitionId ?? assessmentOf(request) ?? void 0, options);
			if (answering instanceof RunRequestError) {
				response.status(answering.kind === "assessment-not-found" ? 404 : 400).json({
					error: answering.kind,
					message: answering.message
				});
				return;
			}
			const measurement = answering?.version.measurement;
			const requested = asked.pillars ?? measurement?.pillars;
			const unknown = unmeasurable(requested, options);
			if (unknown != null) {
				response.status(400).json({
					error: "unknown-pillar",
					message: unknown
				});
				return;
			}
			const lookbackDays = measurement?.lookbackDays ?? asked.lookbackDays;
			const workspaces = measurement == null ? asked.workspaces : measurement.scope.kind === "selected" ? measurement.scope.workspaceIds : void 0;
			const permission = await permitted(request, response, options, "scan.start");
			const { actor, actorName, scope: granted } = permission;
			act = permission.act;
			const scope = workspaces == null ? granted : selectedScope(granted, workspaces);
			const credentials = fromRequest(request, options.host, actor, actorName);
			const warehouse = options.warehouse?.();
			const asking = {
				credentials,
				scope,
				collectors: options.collectorsFor({
					credentials,
					scope,
					lookbackDays
				}),
				lookbackDays,
				trigger,
				...warehouse != null ? { warehouse } : {},
				...requested != null ? { pillars: requested } : {},
				...answering != null ? { definition: {
					id: answering.definition.id,
					version: answering.version.version,
					fingerprint: answering.version.fingerprint,
					name: answering.version.attribution.name
				} } : {}
			};
			const started = options.runs == null ? void 0 : await startRun(options.runs, asking, actor, request);
			const scan = started == null ? await options.runner.start(asking) : await started.scan;
			await act.performed({
				kind: "scan",
				id: scan.id
			});
			if (trigger === "interactive") {
				response.json(present(scan, await historyFor(options.store, scan.stamp.definition?.id ?? null), options.catalogue.changelog, await targetsFor(scan, options.definitions, /* @__PURE__ */ new Date()), await standingOf(scan.id, scan.stamp.definition?.id ?? null)));
				return;
			}
			const summary = scheduledSummary(scan, started?.run);
			if (underGranted(scan)) {
				response.status(422).json({
					error: "mostly-unreadable",
					message: blindRunMessage(scan, actor),
					...summary
				});
				return;
			}
			response.json(summary);
		} catch (cause) {
			await act?.failed(cause);
			if (cause instanceof RunNotJoinable) {
				response.status(409).json(refusedPayload(cause, await summaryOf(cause, options.store)));
				return;
			}
			respondToFailure(response, cause);
		}
	};
	app.post("/api/scan", runScanFor("interactive"));
	/**
	* The same assessment, started by a schedule rather than by a person.
	*
	* A separate route rather than a flag in the body so that "nobody was watching" is decided by
	* which door the call came through, not by what the caller claimed about itself.
	*
	* There is deliberately no shared secret, no trigger token and no service principal of the
	* app's own on this path. Measured against a live install: the Apps proxy authenticates a
	* programmatic caller and mints it an on-behalf-of token holding exactly the scopes the app
	* declares — no more than a browser gets, and it overrides whatever token the caller supplied.
	* So the platform has already done the authenticating, and a secret of this app's own would add
	* a credential to keep without adding a check. ADR 0021 records the measurement.
	*/
	app.post("/api/scan/scheduled", runScanFor("scheduled"));
	/**
	* Whether a scan started here would get as far as running, asked without starting one.
	*
	* For the scheduled job, and the reason it exists is a cost rather than a courtesy. A refusal the
	* assessment cannot clear by trying again — an identity outside the group, a warehouse nothing is
	* bound to — arrives at the same moment as the failures a retry exists for, and the job cannot tell
	* them apart: it retries three times, pays a serverless start for each, and learns the same thing
	* four times. Measured on labs before this existed: four attempts, seven and a half minutes of
	* startup, 47 seconds of work, one answer. Asking first is a task with no retries, and the answer
	* is the same either way.
	*
	* The permission half deliberately calls `requirePermission` rather than describing what it does.
	* A route that re-derived the rule would be a second copy of the gate, and the copy that matters is
	* the one that says a scan may start when the gate would refuse it — a preflight that passes and a
	* run that is then refused is worse than no preflight, because it moves the failure to the task
	* that has already spent the startup.
	*
	* A read, so no act. Nothing changes here, and a caller who may not start a scan is exactly who
	* needs to be able to ask — telling them they are not permitted to find out whether they are
	* permitted is the one answer that helps nobody.
	*/
	app.get("/api/scan/readiness", async (request, response) => {
		try {
			const token = userToken(request);
			const identity = identityFrom(actorFromHeaders(request), await probeCurrentUser({
				host: options.host,
				token
			}));
			let may;
			try {
				requirePermission(options.assessorGroup, identity);
				may = { start: true };
			} catch (cause) {
				if (!(cause instanceof NotPermittedError)) throw cause;
				may = {
					start: false,
					refusal: cause.kind,
					message: cause.message
				};
			}
			const payload = {
				actor: identity.actor,
				group: options.assessorGroup,
				may,
				warehouse: options.warehouse?.() != null,
				runs: options.runs != null
			};
			response.json(payload);
		} catch (cause) {
			respondToFailure(response, cause);
		}
	});
	/**
	* What this app can read here, asked live.
	*
	* Separate from a scan because it answers a different question. A scan says what the
	* estate is like; this says what the app was allowed to look at, which is the first
	* thing to establish when a pillar reports most of itself unanswered — and the thing
	* that decides which checks are worth writing next.
	*
	* Runs as the signed-in user, like every other read.
	*/
	app.get("/api/reach", async (request, response) => {
		try {
			const { actor } = await identify(request, options.host);
			const credentials = fromRequest(request, options.host, actor);
			const token = reportOn(await (await credentials.databricks()).token());
			const declared = declaredScopes();
			const families = await probeReach(await clientFor(credentials)(), {
				...token.scopes != null ? { carried: token.scopes } : {},
				declared
			});
			response.json({
				actor,
				token,
				declared,
				families
			});
		} catch (cause) {
			respondToFailure(response, cause);
		}
	});
	/**
	* The admin evidence script, and the checksum for the copy already downloaded.
	*
	* Two routes rather than one because they answer different questions. This one is what the app
	* knows about the script without serving it — the digest, the version, and the two commands that
	* check a file against it — which is what somebody who already has a copy needs. The download
	* below is for somebody who does not.
	*
	* Unauthenticated, deliberately. There is nothing here an anonymous caller learns about the
	* estate: the script is the same file for every install, and the digest is published precisely so
	* that it can be compared by someone who has not signed in. Gating it would mean an admin
	* verifying a file a colleague sent them has to log into the app first, which is friction in
	* exchange for nothing.
	*/
	let script;
	const scriptOnce = () => script ??= loadEvidenceScript();
	app.get("/api/evidence/script", (_request, response) => {
		const loaded = scriptOnce();
		const payload = evidenceScriptPayload(loaded, `/api/evidence/${loaded.name}`);
		response.json(payload);
	});
	app.get(`/api/evidence/${SCRIPT_NAME}`, (_request, response) => {
		const loaded = scriptOnce();
		response.setHeader("Content-Type", "text/plain; charset=utf-8");
		response.setHeader("Content-Disposition", `attachment; filename="${loaded.name}"`);
		response.setHeader("X-Evidence-Script-Digest", loaded.digest);
		response.setHeader("X-Evidence-Script-Version", loaded.version);
		response.send(loaded.source);
	});
	registerAuditRoutes(app, {
		...options.audit != null ? {
			audit: options.audit.trail,
			durable: options.audit.trail.durable
		} : {},
		respondToFailure
	});
	registerHealthRoutes(app, {
		respondToFailure,
		sourcesFor: async (request) => {
			const token = forwardedToken(request);
			return {
				...options.pingDatabase != null ? { pingDatabase: options.pingDatabase } : {},
				...options.storage != null ? { storage: options.storage } : {},
				durable: options.store.durable,
				warehouseId: options.warehouse?.(),
				...token != null ? { probeIdentity: async () => {
					await probeCurrentUser({
						host: options.host,
						token
					});
				} } : {},
				...options.audit != null ? {
					unrecorded: options.audit.unrecorded,
					auditDurable: options.audit.trail.durable,
					auditPosture: options.audit.posture
				} : {},
				...await warehouseUse(options.store)
			};
		}
	});
	/**
	* The catalogue by id, built on the first action that names a requirement and then kept.
	*
	* Lazily, like the plan above, and for a weaker version of the same reason: it is a map over a few
	* hundred controls rather than fifteen file reads, but an install where nobody opens a plan should not
	* pay for it, and rebuilding it per action would make the cost proportional to the size of the board.
	*/
	let improvable;
	const improvableControls = () => improvable ??= controlIndex(options.catalogue);
	registerImproveRoutes(app, {
		...options.improvements != null ? { improvements: options.improvements } : {},
		...options.improvementStorage != null ? { improvementStorage: options.improvementStorage } : {},
		...options.definitions != null ? { definitions: options.definitions } : {},
		...options.advisories != null ? { advisories: options.advisories } : {},
		store: options.store,
		knownControl: (id) => improvableControls().has(id),
		titleOf: (id) => improvableControls().get(id)?.title,
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		recordRead: (request, response, action, context) => unguarded(request, response, options, action, context),
		takenFrom: exportsTaken,
		respondToFailure
	});
	registerValidateRoutes(app, {
		...options.validations != null ? { validations: options.validations } : {},
		...options.validationStorage != null ? { validationStorage: options.validationStorage } : {},
		...options.improvements != null ? { improvements: options.improvements } : {},
		measurabilityOf: (id) => improvableControls().get(id)?.measurability,
		titleOf: (id) => improvableControls().get(id)?.title,
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerRiskRoutes(app, {
		...options.risks != null ? { risks: options.risks } : {},
		...options.riskStorage != null ? { riskStorage: options.riskStorage } : {},
		controlOf: (id) => {
			const control = improvableControls().get(id);
			return control == null ? void 0 : {
				title: control.title,
				pillarId: control.pillarId,
				severity: control.severity
			};
		},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerApplicabilityRoutes(app, {
		...options.applicability != null ? { applicability: options.applicability } : {},
		controlOf: (id) => {
			const control = improvableControls().get(id);
			return control == null ? void 0 : {
				title: control.title,
				pillarId: control.pillarId,
				severity: control.severity
			};
		},
		readingOf: (controlId, scope) => lastReading(options.store, controlId, scope),
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerNoteRoutes(app, {
		...options.notes != null ? { notes: options.notes } : {},
		...options.noteStorage != null ? { noteStorage: options.noteStorage } : {},
		knownSubject: async (subject, scope) => {
			if (subject.kind === "control") return improvableControls().has(subject.id);
			if (subject.kind === "pillar") return options.catalogue.pillars.some((pillar) => pillar.id === subject.id);
			return await options.store.get(subject.id, scope) != null;
		},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerFoundationRoutes(app, {
		...options.serving != null ? { serving: options.serving } : {},
		...options.servingStorage != null ? { servingStorage: options.servingStorage } : {},
		...options.warehouse?.() == null ? {} : { servingSql: async (request) => {
			const warehouseId = options.warehouse?.();
			if (warehouseId == null) throw new Error("No SQL warehouse is bound, so nothing can be read.");
			const { actor } = await identify(request, options.host);
			const credentials = fromRequest(request, options.host, actor);
			const executor = new StatementExecutor({
				host: options.host,
				warehouseId,
				token: async () => (await credentials.databricks()).token()
			});
			return servingSql({
				executor: (statement, parameters, signal) => executor.query(statement, parameters, signal),
				lookbackDays: 30
			});
		} },
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerTopologyRoutes(app, {
		...options.warehouse?.() == null ? {} : { collect: async (request, signal) => {
			const warehouseId = options.warehouse?.();
			if (warehouseId == null) throw new Error("No SQL warehouse is bound, so nothing can be read.");
			const { actor } = await identify(request, options.host);
			const credentials = fromRequest(request, options.host, actor);
			const executor = new StatementExecutor({
				host: options.host,
				warehouseId,
				token: async () => (await credentials.databricks()).token()
			});
			return collectNamedTopology({
				executor: (statement, parameters, signal) => executor.query(statement, parameters, signal),
				lookbackDays: 30,
				signal
			});
		} },
		respondToFailure
	});
	registerReviewRoutes(app, {
		...options.reviews != null ? { reviews: options.reviews } : {},
		...options.reviewStorage != null ? { reviewStorage: options.reviewStorage } : {},
		scans: options.store,
		pillars: options.catalogue.pillars.map((pillar) => pillar.id),
		...options.attestations != null ? { attestations: options.attestations } : {},
		control: (id) => controlIndex(options.catalogue).get(id),
		cadenceDays: (spec) => asked(spec).cadenceDays,
		requirementsFor: (scan) => attestable(options.catalogue, options.registry, settledByMeasurement(scan), inconclusiveMeasurements(scan), unreachableMeasurements(scan)),
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerRetentionRoutes(app, {
		...options.retention != null ? { retention: options.retention } : {},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerPublicationRoutes(app, {
		...options.publications != null ? { publications: options.publications } : {},
		scans: options.store,
		...options.runs != null ? { runs: options.runs } : {},
		...options.risks != null ? { risks: options.risks } : {},
		...options.improvements != null ? { improvements: options.improvements } : {},
		...options.reviews != null ? { reviews: {
			store: options.reviews,
			pillars: options.catalogue.pillars.map((pillar) => pillar.id),
			pillarTitle: (id) => options.catalogue.pillars.find((one) => one.id === id)?.title
		} } : {},
		timezone: async () => {
			const schedule = await read({ ...options.machineClient != null ? { client: options.machineClient } : {} });
			return schedule.timezone == null ? {
				id: "UTC",
				source: "default"
			} : {
				id: schedule.timezone,
				source: "schedule"
			};
		},
		label: (controlId) => {
			const control = improvableControls().get(controlId);
			if (control == null) return void 0;
			const pillar = options.catalogue.pillars.find((one) => one.id === control.pillarId);
			return {
				requirement: control.title,
				pillar: pillar?.title ?? control.pillarId
			};
		},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	scheduleRoutes(app, {
		...options.machineClient != null ? { client: options.machineClient } : {},
		...options.definitions != null ? { assessments: { named: async (id) => {
			const definition = await options.definitions?.get(id);
			if (definition == null) return void 0;
			return {
				name: currentVersion(definition).attribution.name,
				archived: definition.archivedAt != null
			};
		} } } : {},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerRunRoutes(app, {
		...options.runs != null ? { runs: options.runs } : {},
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure
	});
	registerAdvisoryRoutes(app, {
		...options.advisories != null ? { advisories: options.advisories } : {},
		...options.runs != null ? { runs: options.runs } : {},
		asking: (request, actor, granted) => advisoryRequest(request, actor, granted, options),
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure,
		idempotencyKey
	});
	registerImportRoutes(app, {
		...options.imports != null ? { imports: options.imports } : {},
		store: options.store,
		permitted: (request, response, action, context) => permitted(request, response, options, action, context),
		respondToFailure,
		publishedScriptDigest: () => {
			try {
				return scriptOnce().digest;
			} catch {
				return;
			}
		}
	});
	/**
	* Stop the run in progress.
	*
	* Gated like every other mutation, and it was the one that needed the gate most: before `A1a`
	* this route asked for nothing at all — no forwarded token, no identity — so anyone who could
	* reach the app could end a colleague's scan halfway through and leave them looking at a partial
	* assessment with no record of who stopped it.
	*/
	app.post("/api/scan/cancel", async (request, response) => {
		let act;
		try {
			act = (await permitted(request, response, options, "scan.cancel")).act;
			const cancelled = options.runner.cancel();
			if (cancelled) await act.performed();
			else await act.failed("nothing-running");
			response.json({ cancelled });
		} catch (cause) {
			await act?.failed(cause);
			respondToFailure(response, cause);
		}
	});
	/**
	* Every requirement only a person can answer, with its answer where it has one.
	*
	* The whole set rather than only the unanswered, because the page this serves is as much
	* about reviewing answers that are about to lapse as about giving new ones. 82 requirements
	* is a page, not a payload problem.
	*/
	app.get("/api/attestations", async (request, response) => {
		const store = options.attestations;
		if (store == null) {
			response.json({
				durable: false,
				durabilityNote: NO_ATTESTATION_STORE,
				requirements: []
			});
			return;
		}
		try {
			const scope = assessmentOf(request);
			const recorded = new Map((await store.current(scope)).map((entry) => [entry.controlId, entry]));
			const requestedRunId = typeof request.query.runId === "string" ? request.query.runId.trim() : "";
			const reference = requestedRunId === "" ? await latestOrNothing(options.store, scope) : await options.store.get(requestedRunId, scope);
			if (requestedRunId !== "" && reference == null) {
				response.status(404).json({
					error: "scan-not-found",
					message: `No scan with id ${requestedRunId}. The review cannot decide which questions that run handed to a person.`
				});
				return;
			}
			const measured = settledByMeasurement(reference);
			const inconclusive = inconclusiveMeasurements(reference);
			const unreachable = unreachableMeasurements(reference);
			const payload = {
				durable: store.durable,
				...store.durable ? {} : { durabilityNote: options.attestationStorage ?? NO_ATTESTATION_STORE },
				requirements: attestable(options.catalogue, options.registry, measured, inconclusive, unreachable).map((control) => ({
					controlId: control.id,
					pillarId: control.pillarId,
					principleId: control.principleId,
					title: control.title,
					severity: control.severity,
					askedBecause: askedBecause(control, inconclusive),
					...asked(control),
					...withAnswer(recorded.get(control.id))
				}))
			};
			response.json(payload);
		} catch (cause) {
			response.status(503).json({
				error: "attestations-unavailable",
				message: `The recorded answers could not be read: ${cause instanceof Error ? cause.message : "unknown fault"}`
			});
		}
	});
	/** Everything ever answered for one requirement, so a superseded claim stays inspectable. */
	app.get("/api/attestations/:controlId", async (request, response) => {
		const store = options.attestations;
		if (store == null) {
			response.status(404).json({
				error: "attestations-unavailable",
				message: NO_ATTESTATION_STORE
			});
			return;
		}
		const history = await store.historyFor(request.params.controlId, assessmentOf(request));
		response.json({
			controlId: request.params.controlId,
			attestations: history.map(presentAttestation)
		});
	});
	/**
	* What a person needs in order to answer one question honestly, where somebody has written it.
	*
	* Fetched per requirement rather than served with the list, for the same reason the answer history
	* is: the list is 105 requirements and this is several hundred words each.
	*
	* Answers 200 with `status: 'absent'` for a question nobody has written up yet, not 404. A missing
	* entry is the expected state for most of the catalogue until row 10b of the plan is done, and a
	* status code that reads as an error would have every pane logging one — while the pane's own
	* handling of it is a sentence, not an error state.
	*
	* A control id that is not in the catalogue is the other thing, and it does get a 404. The
	* distinction is worth the branch: "nobody has written this yet" is a fact about the content and
	* "there is no such requirement" is a fact about the caller, and collapsing them would have a
	* client that asked the wrong question told, in the affirmative, that the answer is nothing. It
	* also keeps the response from echoing whatever arrived in the path.
	*/
	app.get("/api/guidance/:controlId", (request, response) => {
		const { controlId } = request.params;
		if (!options.catalogue.controls.some((control) => control.id === controlId)) {
			response.status(404).json({
				error: "control-not-found",
				message: "That control is not in this build of the catalogue."
			});
			return;
		}
		const found = options.guidance == null ? void 0 : authoredGuidance(options.guidance, controlId);
		if (found == null) {
			response.json({
				controlId,
				status: "absent"
			});
			return;
		}
		response.json({
			controlId,
			status: "authored",
			guidance: {
				means: found.means ?? "",
				matters: found.matters ?? "",
				good: found.good,
				examples: found.examples ?? {
					strong: "",
					partial: "",
					weak: ""
				},
				verify: found.verify,
				pitfalls: found.pitfalls,
				partialWhen: found.partialWhen ?? "",
				...found.notApplicableWhen != null ? { notApplicableWhen: found.notApplicableWhen } : {},
				...found.ownerRole != null ? { ownerRole: found.ownerRole } : {},
				...found.lastReviewed != null ? { lastReviewed: found.lastReviewed } : {},
				references: found.references,
				...found.advice != null ? { advice: found.advice } : {}
			}
		});
	});
	app.post("/api/attestations", async (request, response) => {
		const store = options.attestations;
		if (store == null) {
			response.status(503).json({
				error: "attestations-unavailable",
				message: NO_ATTESTATION_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await permitted(request, response, options, "attestation.record");
			const { actor } = permission;
			act = permission.act;
			const control = controlIndex(options.catalogue);
			const draft = draftFrom(request.body, (id) => control.get(id) != null);
			const spec = control.get(draft.controlId);
			if (spec == null) {
				await act.failed("unknown-control", {
					kind: "control",
					id: draft.controlId
				});
				response.status(400).json({
					error: "unknown-control",
					message: `No requirement with id ${draft.controlId}.`
				});
				return;
			}
			const definitionId = assessmentOf(request) ?? void 0;
			const attestation = await registerAttestation({
				store,
				draft,
				actor,
				severity: spec.severity,
				cadenceDays: asked(spec).cadenceDays,
				...definitionId != null ? { definitionId } : {}
			});
			await act.performed({
				kind: "control",
				id: draft.controlId
			});
			response.status(201).json(presentAttestation(attestation));
		} catch (cause) {
			await act?.failed(cause);
			if (cause instanceof InvalidAttestationError) {
				response.status(400).json({
					error: "invalid-attestation",
					message: cause.message
				});
				return;
			}
			respondToFailure(response, cause);
		}
	});
	/**
	* Every decision taken about a finding, judged against the run being read.
	*
	* The standing is computed here rather than sent as a raw record for the browser to interpret,
	* because it is a comparison between a decision's date and a run's and the server is the only
	* side that has both. A claimed fix that the latest run contradicts is the most consequential
	* sentence this app produces, and it is not going to depend on the reader's clock.
	*/
	app.get("/api/decisions", async (request, response) => {
		const store = options.decisions;
		if (store == null) {
			response.json({
				durable: false,
				durabilityNote: NO_DECISION_STORE,
				decisions: [],
				parkDays: parkDays()
			});
			return;
		}
		try {
			const scope = assessmentOf(request);
			const latest = await latestOrNothing(options.store, scope);
			const control = controlIndex(options.catalogue);
			const payload = {
				durable: store.durable,
				parkDays: parkDays(),
				...store.durable ? {} : { durabilityNote: options.decisionStorage ?? NO_DECISION_STORE },
				...latest?.finishedAt != null ? { measuredAt: latest.finishedAt } : {},
				decisions: standingsFor(await store.current(scope), { ...latest != null ? {
					findings: latest.findings,
					measuredAt: latest.finishedAt
				} : {} }).map((entry) => presentDecision(entry, control.get(entry.decision.controlId)))
			};
			response.json(payload);
		} catch (cause) {
			response.status(503).json({
				error: "decisions-unavailable",
				message: `The recorded decisions could not be read: ${cause instanceof Error ? cause.message : "unknown fault"}`
			});
		}
	});
	/** Every decision ever taken about one requirement, so a superseded one stays inspectable. */
	app.get("/api/decisions/:controlId", async (request, response) => {
		const store = options.decisions;
		if (store == null) {
			response.status(404).json({
				error: "decisions-unavailable",
				message: NO_DECISION_STORE
			});
			return;
		}
		const scope = assessmentOf(request);
		const latest = await latestOrNothing(options.store, scope);
		const history = await store.historyFor(request.params.controlId, scope);
		const control = controlIndex(options.catalogue).get(request.params.controlId);
		response.json({
			controlId: request.params.controlId,
			decisions: standingsFor(history, { ...latest != null ? {
				findings: latest.findings,
				measuredAt: latest.finishedAt
			} : {} }).map((entry) => presentDecision(entry, control))
		});
	});
	app.post("/api/decisions", async (request, response) => {
		const store = options.decisions;
		if (store == null) {
			response.status(503).json({
				error: "decisions-unavailable",
				message: NO_DECISION_STORE
			});
			return;
		}
		let act;
		try {
			const permission = await permitted(request, response, options, "decision.record");
			const { actor } = permission;
			act = permission.act;
			const control = controlIndex(options.catalogue);
			const draft = draftFrom$1(request.body, {
				knownControl: (id) => control.get(id) != null,
				severityOf: (id) => control.get(id)?.severity
			});
			const definitionId = assessmentOf(request) ?? void 0;
			const decision = await registerDecision({
				store,
				draft,
				actor,
				...definitionId != null ? { definitionId } : {}
			});
			await act.performed({
				kind: "control",
				id: decision.controlId
			});
			const latest = await latestOrNothing(options.store, definitionId ?? null);
			const [judged] = standingsFor([decision], { ...latest != null ? {
				findings: latest.findings,
				measuredAt: latest.finishedAt
			} : {} });
			response.status(201).json(presentDecision(judged, control.get(decision.controlId)));
		} catch (cause) {
			await act?.failed(cause);
			if (cause instanceof InvalidDecisionError) {
				response.status(400).json({
					error: "invalid-decision",
					message: cause.message
				});
				return;
			}
			respondToFailure(response, cause);
		}
	});
	/**
	* What the containment proxy forwards, answered as one failed request.
	*
	* Registered last because express only reaches error middleware declared after the routes it is
	* meant to cover, so this moving up the function would silently stop covering the ones below it.
	*
	* The status is a flat 500 and the code is deliberately not one of `respondToFailure`'s. Anything
	* arriving here got past a handler's own `catch`, so it is not a permission refusal or an
	* unwritable trail — those are answered where they are recognised. Naming it `scan-failed`, which
	* is that function's fallback, would tell a reader on the retention page that a scan broke.
	*
	* The message says where the detail is rather than carrying it. The stack goes to the log because
	* `databricks apps logs` is the surface an operator reads — and until this row, a fault like this
	* killed the process before it could write one.
	*/
	app.use("/api", (cause, request, response, next) => {
		console.error(`Unhandled error from ${request.method} ${request.originalUrl}:`, cause instanceof Error ? cause.stack : cause);
		if (response.headersSent) {
			next(cause);
			return;
		}
		response.status(500).json({
			error: "unhandled",
			message: "This request failed for a reason the app does not recognise. The stack was written to the app's logs against this request's method and path."
		});
	});
}
/**
* How many past exports of one run the app lists.
*
* A cap rather than the whole history, because the question this list answers is "what did I send, and
* does it still match" — which is asked about the copies somebody sent recently. A run exported nightly
* by a pipeline would otherwise put a thousand identical rows on the page and bury the one download a
* person did by hand. The trail itself holds all of them, filtered by this run.
*/
const EXPORTS_SHOWN = 20;
const NO_DECISION_STORE = "Decisions about findings are not being kept, because this app is running with WAF_DEMO_NO_PERSISTENCE set. Unset it and restart so an accepted risk, a deferred fix or a claim that something has been fixed is written to the bound Lakebase database and survives a restart.";
const NO_ATTESTATION_STORE = "Answers to the requirements that cannot be measured are not being kept, because this app is running with WAF_DEMO_NO_PERSISTENCE set. Unset it and restart so answers are written to the bound Lakebase database, and those requirements can be assessed.";
/**
* Everything a person, and only a person, can answer.
*
* Two kinds, and the second is easy to miss. The catalogue marks 82 requirements as
* `measurability: attestation` — practice rather than configuration, no API returns them. Beyond
* those, a handful have a check that is written and working and that no install of this app can be
* authorised to run: ADR 0016's case, where the platform grants apps no scope for the source. The
* checks page has counted those separately for some time and told the reader they need an answer
* instead. Leaving them out here would make that sentence a dead end.
*
* `measured` then takes the second kind back out again where this deployment did in fact read it.
* Whether an install can be authorised for a source is a property of the deployment model, and it
* is not always right: run locally against a workspace admin's own token, several of these
* settings are perfectly readable, and the last scan read them. Asking someone to report a setting
* the app has just measured is asking them to duplicate a reading — and if their report disagreed
* with the measurement, the app would show a contradiction it already knows the answer to.
*
* The first kind is never removed, however a scan turned out. Their only route to an outcome is an
* answer, so a settled one is settled *by* an answer, and dropping it from this page would leave no
* way to renew it before it lapses.
*/
function attestable(catalogue, registry, measured = /* @__PURE__ */ new Set(), inconclusive = /* @__PURE__ */ new Set(), unreachable = /* @__PURE__ */ new Set()) {
	const byId = descriptorsById();
	return catalogue.controls.filter((control) => {
		if (control.measurability === "attestation") return true;
		if (beyondAnyInstall(control, registry, byId) && !measured.has(control.id)) return true;
		if (inconclusive.has(control.id) && INCONCLUSIVE_QUESTIONS[control.id] != null) return true;
		return unreachable.has(control.id);
	});
}
/**
* Requirements the last scan read and could not settle, where asking is the only way forward.
*
* Deliberately narrow: an `unmeasurable` finding is the state an answer exists to resolve, but most
* of them resolve better by fixing the collection than by asking someone. A finding whose outcome
* currently rests on an answer stays in this set too: the answer changed the displayed outcome, not
* the fact that only a person can settle the underlying ambiguity. The filter to authored questions
* is what separates "the warehouse was asleep" from "Terraform leaves no marker" — the first wants
* a rerun, and putting it on this page as a question would teach the reader to answer around their
* own broken scan.
*/
function inconclusiveMeasurements(scan) {
	if (scan == null) return /* @__PURE__ */ new Set();
	return new Set(scan.findings.filter((finding) => (finding.outcome === "unmeasurable" || finding.attested?.bearing === "outcome") && INCONCLUSIVE_QUESTIONS[finding.controlId] != null).map((finding) => finding.controlId));
}
/**
* Requirements a resolver ran and then declared out of reach, which the static check cannot see.
*
* `beyondAnyInstall` reasons about the signals a requirement needs: if every one of them wants a
* scope no install is granted, nothing can ever be read and an answer is the only route. That is
* right for the 40 it finds, and blind to a resolver whose signals all answered and which then
* found the *specific thing asked about* unreadable.
*
* SCP-03-07 is the case. The serving census answers, so the requirement is known to apply; the
* protection in front of those endpoints needs `networking` and the account plane, so the verdict
* never comes. Statically it looks measurable, because its one signal is grantable and did answer.
*
* It went unnoticed because nothing failed. The finding rendered correctly, said an answer was the
* way to settle it, and offered the link — and the page it linked to had no slot for the
* requirement, so the reader arrived at 104 questions with no sign of the one they came to answer.
* `attest-reach.test.ts` now holds the two sides together.
*/
function unreachableMeasurements(scan) {
	if (scan == null) return /* @__PURE__ */ new Set();
	return new Set(scan.findings.filter((finding) => finding.outcome === "unmeasurable" && finding.unmeasured === "unreachable").map((finding) => finding.controlId));
}
/**
* Which requirements the last scan settled by reading something, rather than by being told.
*
* `unmeasurable` is excluded because that is the state an answer exists to resolve, and an outcome
* carried by an attestation is excluded because counting it here would remove the requirement from
* the page that renews it — the answer would lapse with nowhere to confirm it.
*/
function settledByMeasurement(scan) {
	if (scan == null) return /* @__PURE__ */ new Set();
	return new Set(scan.findings.filter((finding) => finding.outcome !== "unmeasurable" && finding.attested?.bearing !== "outcome").map((finding) => finding.controlId));
}
/**
* The last scan, or nothing if it cannot be read.
*
* A store that is unreachable must not fail this route. The consequence of no scan here is a
* slightly longer list of questions, which is recoverable; the consequence of a 503 is a reader who
* cannot answer anything because history is unavailable, which is not the same problem at all.
*/
async function latestOrNothing(store, scope) {
	if (store == null) return void 0;
	try {
		return await store.latest(scope);
	} catch {
		return;
	}
}
/**
* What to put to the reader for one requirement, and how long their answer will stand.
*
* Two sources, because the two kinds of unanswerable requirement are authored in two places:
* the catalogue carries the question for a requirement no telemetry can reach, and
* `BLOCKED_QUESTIONS` carries it for a requirement this app checks but cannot be authorised to.
*
* Where neither has one, the requirement is named and nothing is invented. The previous
* fallback built a question out of the title — `"Use certified partner tools: is this practice
* in place?"` — which reads like a question while being unanswerable, so whatever was clicked
* became an answer of record and moved the score. Naming the requirement and asking for a
* judgement is at least honest about what is being requested, and CI fails on the gap so this
* branch stays unreached.
*/
function asked(control) {
	const blocked = BLOCKED_QUESTIONS[control.id];
	const unsettled = INCONCLUSIVE_QUESTIONS[control.id];
	const question = control.attestation?.question ?? blocked?.question ?? unsettled?.question;
	const guidance = control.attestation?.evidenceGuidance ?? blocked?.evidence ?? unsettled?.evidence;
	return {
		question: question ?? `${control.title}. How well does this describe your estate?`,
		...guidance != null || unsettled != null ? { evidenceGuidance: [unsettled?.whyAsked, guidance].filter((part) => part != null).join("\n\n") } : {},
		cadenceDays: cadenceDaysFor(control.severity, control.attestation?.cadenceDays ?? blocked?.cadenceDays ?? unsettled?.cadenceDays)
	};
}
/**
* Which of the three reasons this requirement is being put to a person.
*
* Order matters. A practice requirement is `no-telemetry` however a scan turned out, because no
* scan was ever going to settle it. An inconclusive reading is checked before the authorisation
* case so that a control which is both — written, unauthorised, and inconclusive this time —
* reports the reason the reader can act on.
*/
function askedBecause(control, inconclusive) {
	if (control.measurability === "attestation") return "no-telemetry";
	if (inconclusive.has(control.id)) return "inconclusive";
	return "not-authorised";
}
function controlIndex(catalogue) {
	return new Map(catalogue.controls.map((control) => [control.id, control]));
}
function withAnswer(attestation) {
	return attestation == null ? {} : { attestation: presentAttestation(attestation) };
}
function presentAttestation(attestation) {
	return {
		...attestation,
		state: stateOf(attestation)
	};
}
/**
* A decision with its standing, and enough of the requirement to be read on its own.
*
* The title, pillar and severity are carried rather than left to the client to join, because a
* decision is read on a page that is a list of decisions rather than a list of requirements. A
* client join would have to hold the whole catalogue to render one row, and a row whose title
* failed to resolve would render as an id.
*/
function presentDecision(entry, control) {
	return {
		...entry.decision,
		standing: entry.standing,
		parked: parked(entry.standing),
		...entry.outcome != null ? { outcome: entry.outcome } : {},
		...control != null ? {
			title: control.title,
			pillarId: control.pillarId,
			severity: control.severity
		} : {}
	};
}
/**
* The scan as the UI needs it, in the shape the shared contract declares.
*
* The declared return type is the point: it is the same type the client reads, differing
* only in how dates are represented, so a change to a domain type that the client is not
* ready for fails the server typecheck rather than rendering blank fields.
*
* Two things are shaped rather than passed through. Signal values are dropped — they are
* the raw collected structures, some of them per-table arrays, and each finding's
* evidence already carries what its outcome was based on. And the scheduler's footprint
* is flattened per surface, so the wire format does not change every time the scheduler
* grows an internal counter.
*/
/**
* The runs an occurrence history is walked over, or none when they cannot be read.
*
* A store that cannot answer leaves every requirement reporting the single run in hand, which is
* the truthful reading — this build cannot speak for the runs before it — and is far better than
* failing the request. A finding pane that will not open because a history query timed out is a
* worse outcome than one that shows the finding without its streak.
*/
async function historyFor(store, scope) {
	try {
		return await store.history(void 0, scope);
	} catch {
		return [];
	}
}
/**
* What this run can be held against, and from which version of the assessment.
*
* The version the run is stamped with is not automatically the right answer, and the fingerprint is
* what settles it. A revision that only moves a target does not change the measurement, so it leaves
* the fingerprint alone — the question is identical, and a target set this morning is a commitment
* this morning's run answers to even though the run predates it. Requiring a re-run before a new
* target appeared anywhere would mean setting one and seeing nothing, which is how a programme
* surface teaches people it does not work.
*
* When the fingerprint *has* moved, the later version asks a different question — a wider scope, a
* different window — and its targets are about a measurement this run is not of. Then the stamped
* version's own targets are the only ones this run can be held against.
*
* So: the newest version asking the same question as the run, falling back to the run's own. Which is
* the same rule `comparability` already uses for whether two runs may be compared, applied to whether
* a commitment and a measurement are about the same thing.
*
* A store that cannot answer yields no readings, for the reason `historyFor` gives: a surface that
* will not render because a definition lookup failed is worse than one without its targets.
*/
async function targetsFor(scan, definitions, now) {
	const stamped = scan.stamp.definition;
	if (stamped == null || definitions == null) return [];
	try {
		const definition = await definitions.get(stamped.id);
		if (definition == null) return [];
		const version = definition.versions.filter((version) => version.fingerprint === stamped.fingerprint).at(-1) ?? definition.versions.find((one) => one.version === stamped.version);
		if (version?.targets == null) return [];
		return readTargets(version.targets, scan.score.pillars, now);
	} catch {
		return [];
	}
}
function present(scan, history = [], changelog = NO_CHANGELOG, targets = [], finalisation = void 0) {
	const occurrences = occurrencesIn(scan, history, changelog);
	const carried = new Set(scan.measurement.filter((entry) => entry.carriedForward).map((entry) => entry.pillarId));
	return {
		id: scan.id,
		startedAt: scan.startedAt,
		finishedAt: scan.finishedAt,
		state: scan.state,
		stamp: scan.stamp,
		...scan.incompleteReason != null ? { incompleteReason: scan.incompleteReason } : {},
		...scan.requestedPillars != null ? { requestedPillars: scan.requestedPillars } : {},
		measurement: scan.measurement,
		...scan.notCarried != null ? { notCarried: scan.notCarried } : {},
		score: scan.score,
		...targets.length > 0 ? { targets } : {},
		findings: scan.findings.map((finding) => ({
			...finding,
			confidence: confidenceOf(finding, {
				carriedForward: carried.has(finding.pillarId),
				asOf: scan.finishedAt
			}),
			...occurrences.get(finding.controlId) != null ? { occurrence: occurrences.get(finding.controlId) } : {}
		})),
		footprint: presentFootprint(scan.footprint),
		spend: scan.spend,
		signals: scan.signals.map((signal) => ({
			id: signal.id,
			status: signal.status,
			coverage: signal.coverage,
			...signal.unmeasurableReason != null ? { unmeasurableReason: signal.unmeasurableReason } : {},
			durationMs: signal.durationMs,
			...signal.provenance != null ? { provenance: signal.provenance } : {}
		})),
		estate: presentEstate(scan.estate),
		...finalisation != null ? { finalisation } : {}
	};
}
function presentEstate(estate) {
	const note = describeEstate(estate);
	return {
		...estate,
		...note != null ? { note } : {}
	};
}
function presentFootprint(footprint) {
	return {
		surfaces: Object.entries(footprint.tasks).map(([surface, counters]) => ({
			surface,
			succeeded: counters.ok,
			failed: counters.failed,
			skipped: counters.skipped,
			retries: counters.retries,
			attempts: counters.attempts,
			refusals: Object.entries(counters.terminal).map(([kind, tasks]) => ({
				kind,
				tasks
			})).sort((a, b) => b.tasks - a.tasks),
			spent: footprint.spend.spent[surface],
			budget: footprint.spend.limits[surface]
		})).filter((surface) => surface.succeeded + surface.failed + surface.skipped > 0),
		durationMs: footprint.spend.elapsedMs,
		cancelled: footprint.cancelled,
		concurrencyReductions: Object.values(footprint.limiters).reduce((total, limiter) => total + limiter.reductions, 0)
	};
}
/**
* Why a run was refused before it started, in the terms the response uses.
*
* One error type across the four cases rather than four, because the route does the same thing with
* all of them — name the field and stop — and the kind is what decides the status code.
*/
var RunRequestError = class extends Error {
	kind;
	constructor(kind, message) {
		super(message);
		this.kind = kind;
		this.name = "RunRequestError";
	}
};
/**
* What the body asked for, validated as a shape but not yet against anything.
*
* An assessment named in the body cannot share that body with an override: a run stamped with a
* fingerprint describing a question it did not ask would poison every later comparison. Pillars on
* the body with the assessment on the query are the targeted rerun — the one combination the body
* cannot carry — and lookback or workspaces still cannot ride along, because those would be dropped
* in favour of the definition's measurement with nothing saying so.
*/
function askedFor(request) {
	const body = request.body ?? {};
	const definitionId = body.definitionId;
	if (definitionId != null && (typeof definitionId !== "string" || definitionId.trim() === "")) return new RunRequestError("assessment-not-found", "The definitionId field must be the id of an assessment.");
	const overrides = [
		"pillars",
		"workspaces",
		"lookbackDays"
	].filter((field) => body[field] != null);
	if (definitionId != null && overrides.length > 0) return new RunRequestError("assessment-and-overrides", `This run names an assessment and also sets ${overrides.join(", ")}. An assessment already says which pillars, which workspaces and how far back, and a run that used both would be recorded as having asked a question it did not ask. Name one or the other.`);
	const dropped = ["workspaces", "lookbackDays"].filter((field) => body[field] != null);
	if (definitionId == null && assessmentOf(request) != null && dropped.length > 0) return new RunRequestError("assessment-and-overrides", `This run names an assessment and also sets ${dropped.join(", ")}. An assessment already says which workspaces and how far back, and a run that used both would be recorded as having asked a question it did not ask. Name one or the other.`);
	const pillars = body.pillars;
	if (pillars != null && (!Array.isArray(pillars) || pillars.some((id) => typeof id !== "string"))) return new RunRequestError("unknown-pillar", "The pillars field must be a list of pillar ids.");
	if (Array.isArray(pillars) && pillars.length === 0) return new RunRequestError("unknown-pillar", "Name at least one pillar to measure, or omit the field.");
	const workspaces = body.workspaces;
	if (workspaces != null && (!Array.isArray(workspaces) || workspaces.some((id) => typeof id !== "string"))) return new RunRequestError("unusable-scope", "The workspaces field must be a list of workspace ids.");
	return {
		...typeof definitionId === "string" ? { definitionId: definitionId.trim() } : {},
		...pillars != null ? { pillars } : {},
		...workspaces != null ? { workspaces } : {},
		lookbackDays: lookbackFrom(request)
	};
}
/** The definition a run answers to and the version it answers to it at, or why neither is available. */
async function answeringDefinition(id, options) {
	if (id == null) return void 0;
	if (options.definitions == null) return new RunRequestError("assessments-unavailable", "This install does not keep assessment definitions, so a run cannot answer to one.");
	const definition = await options.definitions.get(id);
	if (definition == null) return new RunRequestError("assessment-not-found", `No assessment with id ${id} is recorded here.`);
	if (definition.archivedAt != null) return new RunRequestError("assessment-archived", `Assessment ${id} was archived on ${definition.archivedAt.toISOString().slice(0, 10)} and is closed to new runs. Put it back from the assessments list if closing it was a mistake, or define a new one if it was not — the archived one keeps the runs it explains either way.`);
	return {
		definition,
		version: currentVersion(definition)
	};
}
/**
* Why this build cannot measure what was asked for, if it cannot.
*
* Applied to a definition's pillars as well as a caller's, because the two fail the same way and for
* a reason worth catching: a definition written when this build measured seven pillars is still
* stored when it measures six, and running it silently against the six would report an assessment of
* the customer's whole framework while answering part of it.
*/
function unmeasurable(requested, options) {
	if (requested == null) return void 0;
	const measured = options.pillars ?? options.catalogue.pillars.map((pillar) => pillar.id);
	const unknown = requested.filter((id) => !measured.includes(id));
	if (unknown.length === 0) return void 0;
	return `This build does not measure ${unknown.join(", ")}. It measures ${measured.join(", ")}.`;
}
function lookbackFrom(request) {
	const raw = request.body?.lookbackDays;
	const parsed = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(parsed)) return 30;
	return Math.min(Math.max(Math.round(parsed), 1), 365);
}
/**
* What an unattended run tells the job that started it.
*
* Small on purpose. The interactive payload carries 184 findings with their evidence, which is
* the right answer for a page and the wrong one for a task log that somebody will read months
* later while working out when a number moved. Everything omitted here is on the store, keyed by
* the id in the first field.
*/
/**
* What an advisory run should read, resolved from the request.
*
* Almost the scan resolver, minus everything about scoring: no pillars, because nothing here is scored,
* and no measurement to reconcile a definition against, because an advisory run borrows a definition's
* *scope* and answers none of its requirements. What it keeps is the two refusals that matter — an
* assessment that does not exist, and one that was archived — because those are properties of the
* definition rather than of the run, and an advisory run against a closed assessment would extend a
* history somebody deliberately ended.
*
* The error shape is a value rather than a throw, because the route has to choose the status: a missing
* assessment is a 404 and an archived one is a 400, and a single exception type would have the route
* guessing which it was from the message.
*/
async function advisoryRequest(request, actor, granted, options) {
	const asked = askedFor(request);
	if (asked instanceof RunRequestError) return {
		error: asked.kind,
		message: asked.message,
		status: 400
	};
	const answering = await answeringDefinition(asked.definitionId, options);
	if (answering instanceof RunRequestError) return {
		error: answering.kind,
		message: answering.message,
		status: answering.kind === "assessment-not-found" ? 404 : 400
	};
	const measurement = answering?.version.measurement;
	const lookbackDays = measurement?.lookbackDays ?? asked.lookbackDays;
	const workspaces = measurement == null ? asked.workspaces : measurement.scope.kind === "selected" ? measurement.scope.workspaceIds : void 0;
	const scope = workspaces == null ? granted : selectedScope(granted, workspaces);
	const credentials = fromRequest(request, options.host, actor);
	const warehouse = options.warehouse?.();
	return {
		credentials,
		scope,
		collectors: options.collectorsFor({
			credentials,
			scope,
			lookbackDays
		}),
		lookbackDays,
		...warehouse != null ? { warehouse } : {},
		...answering != null ? { definition: {
			id: answering.definition.id,
			version: answering.version.version,
			fingerprint: answering.version.fingerprint,
			name: answering.version.attribution.name
		} } : {}
	};
}
/**
* Starts a run through the record.
*
* Separate from the route body so the ordering is readable: the record is opened and claimed before any
* collection starts, and `trigger` throwing `RunNotJoinable` is how a duplicate is refused. The
* exception is deliberately not caught here — the route's own handler answers it with the reason, which
* is the part a supervisor acts on.
*/
async function startRun(runs, asking, actor, request) {
	const key = idempotencyKey(request);
	const started = await runs.trigger(asking, {
		actor,
		...key != null ? { idempotencyKey: key } : {}
	});
	return {
		run: started.run,
		scan: started.scan,
		resumedFrom: started.resumedFrom
	};
}
/**
* The key that makes a repeated trigger the same run, from the header or the body.
*
* The header is the convention and the body is accepted because a Databricks job posting through the
* SDK finds a body easier to set than a header. Absent is the ordinary case for a person: two admins
* pressing scan are two intentions, and the in-process lock already refuses the second.
*
* Trimmed and length-capped, because it goes into a unique index: an unbounded string from a caller is
* a way to make a write fail with a message about a B-tree.
*/
function idempotencyKey(request) {
	const header = request.header("idempotency-key");
	const body = request.body;
	const trimmed = (header ?? (typeof body?.idempotencyKey === "string" ? body.idempotencyKey : void 0))?.trim();
	return trimmed == null || trimmed === "" ? void 0 : trimmed.slice(0, 200);
}
/**
* What the run a refused trigger collided with found, where it found anything.
*
* Only for `terminal`: a `held` run has produced nothing yet, and the two key-reuse refusals are about
* a run that describes something else, where reporting its result would be answering a question nobody
* asked. Undefined where the scan is gone — a retention sweep outlives no run it kept — and that is a
* complete answer rather than a failure, so the refusal still goes out.
*/
async function summaryOf(cause, store) {
	if (cause.refusal !== "terminal" || cause.run.scanId == null) return void 0;
	const scan = await store.get(cause.run.scanId);
	return scan == null ? void 0 : scheduledSummary(scan, cause.run);
}
function scheduledSummary(scan, run) {
	return {
		scan: scan.id,
		...underGranted(scan) ? { blind: true } : {},
		...run != null ? { run: run.id } : {},
		trigger: scan.stamp.trigger ?? "scheduled",
		ranAs: scan.stamp.actor,
		startedAt: scan.startedAt.toISOString(),
		finishedAt: scan.finishedAt.toISOString(),
		state: scan.state,
		score: scan.score.overall,
		confidence: scan.score.range,
		measured: answeredControls(scan.score.counts),
		requirements: scan.findings.length
	};
}
/**
* Requirements this app can measure and this run could not read.
*
* Only `unreadable`. The other four reasons a requirement goes unmeasured are not this identity's
* fault and must not count against it: `unreachable` is the 37 no install of this app can reach at
* all, `attestation` is a question for a person, `unbuilt` is work this app has not done, and
* `disabled` is a decision the customer made. Counting those would fail every run.
*
* `disabled` does still reach the rule it feeds, from the other side: a switched-off requirement is
* not an answered one, so it leaves the set this is compared against and the comparison tips sooner.
* An install that switches off enough checks can therefore make its unattended runs report as having
* seen too little to be an assessment. Only where something was already unreadable, though: the
* comparison is against that count, so on an install where nothing was refused no amount of disabling
* tips it. Access decides whether the lever can reach this rule at all. A real consequence of the lever
* rather than a defect in this one, and row 31b is where it belongs.
*/
function unreadable(scan) {
	return scan.score.pillars.reduce((sum, pillar) => sum + (pillar.unmeasuredBy.unreadable ?? 0), 0);
}
/**
* Whether the identity behind a run could see too little of the estate for the result to be an
* assessment.
*
* The rule is a comparison rather than a threshold: more requirements failed to read than were
* measured. That needs no constant to argue about, and it says the thing that matters in one
* clause — most of this assessment did not happen.
*
* The first version of this asked whether the run scored *nothing*, and a live test showed why
* that is not enough. A service principal with no grants at all still came back with one pass and
* one partial out of 184, from the two requirements that happen to be answerable without reading
* anything. Scored: 2. Unreadable: 60. Under the old rule that was a success, and a job would have
* reported a healthy nightly assessment of an estate it never read.
*
* Both sides are counted per requirement. `scoredControls` would be the wrong right-hand side: it is
* deduplicated, so on a catalogue that aliases controls it is smaller than the number of requirements
* actually answered, and the comparison would call a well-read run blind.
*/
function underGranted(scan) {
	return unreadable(scan) > answeredControls(scan.score.counts);
}
/**
* Why an under-granted run is reported as a failure.
*
* A scheduled run has nobody to notice it came back blind, so the app notices for them. Returning
* this as a success would put a flat line on the trend and call it good news.
*
* The refusals are grouped and counted rather than quoted from the estate note, which the first
* version did and a live run showed to be wrong. That note explains why a *resource count* is
* uncertain, so it ended the message with "resource counts may therefore include workspaces that
* have been cancelled" — true, unrelated to the grant that was missing, and the last thing an
* operator read. What they need is which refusals happened and how many requirements each cost,
* because that is one grant per line.
*/
function blindRunMessage(scan, actor) {
	return `This run could not read ${String(unreadable(scan))} of the requirements it can normally measure, and measured ${String(answeredControls(scan.score.counts))}. More of the assessment failed than ran, so it is reported as a failure rather than kept as an assessment.\n\nIt ran as ${actor}. A scheduled run sees only what that identity has been granted, which for a newly created service principal is nothing — docs/scheduled-scans.md lists the four grants.\n\n${refusals(scan)}\n\nThe run is saved as ${scan.id} either way, so the evidence behind this message is readable.`;
}
/**
* What was refused, grouped by refusal, worst first — and separately, what was not refused at all.
*
* Grouped because the refusals repeat: one missing warehouse grant is one line here and eighty
* unreadable requirements in the findings, and eighty copies of the same sentence would bury the
* second refusal. Capped for the same reason — this is read in a task log, and a message long
* enough to scroll is a message whose first line is the only one anybody sees.
*
* Only `because` is grouped, which is the platform's own words: the 403, the schema that does not
* exist, the scope it wanted. An operator checking whether a grant landed needs that verbatim, and
* it is also the only part of a remedy that identifies a *refusal*. Where it is absent nothing
* refused anything — the signal never ran and reported no reason, which is a defect in this app
* rather than a grant to issue. Those are counted at the end instead of ranked alongside, because
* ranking them together put "this app has a bug" above the missing warehouse grant that actually
* cost the run: measured on a synthetic estate, three of the top four lines were app defects.
*/
function refusals(scan) {
	const counts = /* @__PURE__ */ new Map();
	let unexplained = 0;
	for (const finding of scan.findings) {
		if (finding.unmeasured !== "unreadable") continue;
		const refusal = finding.remedy?.because;
		if (refusal == null) {
			unexplained += 1;
			continue;
		}
		counts.set(refusal, (counts.get(refusal) ?? 0) + 1);
	}
	const also = unexplained === 0 ? "" : `\n\nA further ${String(unexplained)} went unread with nothing refusing them: the signal behind each reported no reason for failing, which is a defect in this app rather than a grant you can issue.`;
	if (counts.size === 0) return "Nothing recorded a refusal, which is itself worth reporting: the requirements went unread without the platform saying why." + also;
	const ranked = [...counts].sort(([, a], [, b]) => b - a);
	const shown = ranked.slice(0, 4).map(([refusal, count]) => `  - ${String(count)} requirement${count === 1 ? "" : "s"}: ${refusal}`).join("\n");
	const rest = ranked.length - 4;
	return `What was refused:\n${shown}` + (rest > 0 ? `\n  - and ${String(rest)} other refusal${rest === 1 ? "" : "s"}.` : "") + also;
}
/**
* Who is scanning and what they are scanning, from the cheapest source that has it.
*
* Both answers are usually already present without a network call: the proxy names the
* user in a header and the platform names the workspace in the environment. The SCIM
* probe is the fallback for a runtime that supplies neither, and it is only worth its
* round trip when something is actually missing — so it is skipped when nothing is.
*/
async function identify(request, host) {
	const token = userToken(request);
	const headerActor = actorFromHeaders(request);
	const hostWorkspace = hostWorkspaceFromEnvironment();
	if (headerActor != null && hostWorkspace != null) return {
		actor: headerActor,
		scope: accountScope(hostWorkspace)
	};
	return identityFrom(headerActor, await probeCurrentUser({
		host,
		token
	}));
}
function identityFrom(headerActor, user) {
	return {
		actor: headerActor ?? user.userName ?? "unknown",
		...user.displayName != null ? { actorName: user.displayName } : {},
		scope: scopeFromProbe(user),
		...user.groups != null ? { groups: user.groups } : {}
	};
}
/**
* The caller, having established that they may change something.
*
* The probe is not skipped here the way `identify` skips it, and that is the whole cost of the
* gate: one identity call per mutation. The shortcut `identify` takes — trust the proxy's header
* and the platform's environment, ask nobody — answers who and where, and cannot answer whether,
* because a membership is not in a header. Mutations are rare next to reads (a scan runs for
* minutes; an answer is somebody typing) so the round trip buys a check rather than costing a page
* load.
*
* Refused before the body is read, like the attribution it sits next to: a change nobody is
* permitted to make should not be validated, stored or partially applied first.
*/
async function permitted(request, response, options, action, context = {}) {
	const token = userToken(request);
	const identity = identityFrom(actorFromHeaders(request), await probeCurrentUser({
		host: options.host,
		token
	}));
	const who = {
		actor: identity.actor,
		executionMode: "on-behalf-of-user"
	};
	try {
		requirePermission(options.assessorGroup, identity);
	} catch (cause) {
		if (cause instanceof NotPermittedError) {
			recordRefusal(phraseFor(action), identity, cause);
			await options.audit?.refused(action, who, cause.kind, context.target);
		}
		throw cause;
	}
	await options.audit?.refuseIfUnrecordable();
	return {
		...identity,
		act: begin(options.audit, response, action, who, context)
	};
}
/**
* An act on a route with no gate in front of it.
*
* Synchronous, and that is the point: nothing here can throw or wait, so recording an export cannot
* turn a working download into a failure. The actor is whatever the proxy forwarded, or `unknown` —
* which is the honest value for a request that reached this app without one, and matches what
* `identityFrom` does with the same absence.
*/
function unguarded(request, response, options, action, context = {}) {
	const actor = actorFromHeaders(request) ?? "unknown";
	return begin(options.audit, response, action, {
		actor,
		executionMode: "on-behalf-of-user"
	}, context);
}
/**
* An act, or a stand-in when this install has no recorder.
*
* A no-op rather than an optional `act`, so a handler never branches on whether recording is
* configured. A route that had to write `identity.act?.performed()` would be a route where forgetting
* the `?.` is a crash and remembering it is indistinguishable from not recording.
*
* # The net
*
* The act is closed when the response closes, from the status, unless the handler closed it first.
*
* This is here rather than in a `finally` in each handler because review of the first version found
* three routes where it mattered and the shape of the mistake is invisible at the site: a handler
* that returns early — an unknown id, a stale version, a precondition checked after the gate —
* leaves the act open, and an act never closed writes *nothing*. That is worse than a wrong outcome.
* The table's entire claim is that an absence means nobody tried, so one silent early return makes
* every absence in it worth less, and a `finally` per handler is a line the fourteenth route omits.
*
* The binding itself is `closedWhenAnswered` in `record.ts` rather than two lines here, so that the
* route tests — which inject their own gate — exercise the same net production does instead of a
* copy of it that could differ in the one case that matters. The handler's own close is what carries
* the target and the reason; the net only ever fires for a path nobody thought about, where
* `http-409` beside the act is far more than silence.
*/
function begin(recorder, response, action, who, context) {
	if (recorder == null) return {
		performed: () => Promise.resolve(),
		failed: () => Promise.resolve(),
		settle: () => Promise.resolve()
	};
	return closedWhenAnswered(recorder.begin(action, who, context), response);
}
/**
* The act, in the words the refusal log line uses.
*
* Derived from the action rather than passed alongside it, because the two drifting apart is a log
* that says one thing and an audit row that says another about the same refusal.
*/
function phraseFor(action) {
	return AUDIT_PHRASES[action];
}
function userToken(request) {
	const raw = request.headers[USER_TOKEN_HEADER];
	const token = Array.isArray(raw) ? raw[0] : raw;
	if (token == null || token === "") throw new MissingUserTokenError();
	return token;
}
/** The forwarded token, or nothing. `userToken` throws for the routes that cannot proceed without one. */
function forwardedToken(request) {
	const raw = request.headers[USER_TOKEN_HEADER];
	const token = Array.isArray(raw) ? raw[0] : raw;
	return token == null || token === "" ? void 0 : token;
}
/**
* What the last run did with the warehouse, for the reading that is observed rather than probed.
*
* Counted from the signals whose provenance names a surface that runs statements — `sql` and
* `describe` both do — rather than from every signal, because a REST reading that failed says nothing
* about the warehouse and would report a working binding as degraded. `unmeasurable` is the refusal:
* the statement ran and the app could not read what it needed, which is a grant rather than a binding
* and is why that case reads as degraded and points at Checks instead of at the resource form.
*
* Absent when nothing has run, which the reading turns into `unknown` rather than a clean bill.
*/
async function warehouseUse(store) {
	const latest = await latestOrNothing(store);
	if (latest == null) return {};
	const onWarehouse = latest.signals.filter((signal) => signal.provenance?.surface === "sql" || signal.provenance?.surface === "describe");
	if (onWarehouse.length === 0) return {};
	return { lastRun: {
		at: latest.finishedAt,
		statements: onWarehouse.length,
		refused: onWarehouse.filter((signal) => signal.status === "unmeasurable").length
	} };
}
/**
* How far back a reading is looked for, in scans.
*
* The walk stops at the first scan that has a finding for the requirement, so this bounds the miss rather
* than the hit: past it, a requirement no recent run covered reads as one nothing ever measured, which is
* what every run did before this looked back at all.
*/
const READING_LOOKBACK = 50;
/**
* The last reading of one requirement, and whether the latest scan is where it came from.
*
* The latest scan first, then the history, because an absent finding has two meanings: nothing ever
* measured this requirement — the case the applicability levers exist for — or the most recent run did
* not cover it. A targeted rerun produces the second for every pillar it could not carry forward, and
* reading it as the first let a decision be recorded against a requirement an earlier scan had measured
* as failing, which is the one thing the write-time guard exists to refuse.
*
* The summaries carry an outcome per finding, so the walk costs one history read rather than a scan load
* each. What it does not do is look past the first scan that read the requirement: an outcome a decision
* in force at the time rewrote reads as it stands, the same as it does for the latest scan.
*/
const CUSTOMER_SEVERITY = {
	critical: 5,
	high: 4,
	medium: 3,
	low: 2,
	informational: 1
};
/** Replace a run's provisional arithmetic with the immutable outcome frozen by its final assessment. */
function scanFromFinalResult(result, source) {
	if (result.schemaVersion !== 2 || result.finalAssessment == null) return void 0;
	const final = result.finalAssessment;
	const findings = final.outcome.findings.map((one) => ({
		...one.finding,
		confidence: one.confidence
	}));
	const score = {
		...final.outcome.score,
		pillars: final.outcome.score.pillars.map((pillar) => ({
			...pillar,
			worstFirst: findings.filter((finding) => finding.pillarId === pillar.pillarId && (finding.outcome === "fail" || finding.outcome === "partial")).sort((left, right) => Number(left.outcome === "partial") - Number(right.outcome === "partial") || CUSTOMER_SEVERITY[right.severity] - CUSTOMER_SEVERITY[left.severity] || left.controlId.localeCompare(right.controlId))
		}))
	};
	return {
		...source,
		stamp: {
			...source.stamp,
			publicMethodology: final.versions.methodology,
			catalogueVersion: final.versions.catalogue.revision,
			catalogueFingerprint: final.versions.catalogue.fingerprint,
			executionMode: final.executionMode,
			definition: {
				...source.stamp.definition,
				...final.definition
			}
		},
		findings,
		score
	};
}
async function lastReading(store, controlId, scope) {
	const found = (await latestOrNothing(store, scope))?.findings.find((finding) => finding.controlId === controlId)?.outcome;
	if (found != null) return {
		outcome: found,
		latest: true
	};
	const history = await store.history(READING_LOOKBACK, scope).catch(() => []);
	for (const summary of history) {
		const outcome = summary.outcomes?.[controlId];
		if (outcome != null) return {
			outcome,
			latest: false
		};
	}
}
function resultGateFailure(response, status, eligibility) {
	response.status(status).json({
		error: eligibility.reason.code,
		message: eligibility.reason.message,
		action: eligibility.reason.action,
		eligibility
	});
}
function respondToFailure(response, cause) {
	if (cause instanceof ScanInProgressError) {
		response.status(409).json({
			error: "scan-in-progress",
			message: cause.message,
			running: cause.running
		});
		return;
	}
	if (cause instanceof NotPermittedError) {
		response.status(403).json({
			error: cause.kind,
			message: cause.message
		});
		return;
	}
	if (cause instanceof TrailUnwritableError) {
		response.status(503).json({
			error: "trail-unwritable",
			message: cause.message
		});
		return;
	}
	if (cause instanceof EstateScopeError) {
		response.status(400).json({
			error: "unusable-scope",
			message: cause.message
		});
		return;
	}
	if (cause instanceof MissingUserTokenError) {
		response.status(401).json({
			error: "no-user-token",
			message: "This page reads Databricks using your signed-in identity, but the platform did not forward a user token. Enable user authorization for the app, then try again."
		});
		return;
	}
	response.status(500).json({
		error: "scan-failed",
		message: cause instanceof Error ? cause.message : "The scan failed for an unrecorded reason."
	});
}
//#endregion
export { registerApi };
