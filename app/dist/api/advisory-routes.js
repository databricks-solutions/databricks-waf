import { jobRules, sizingRules, workloadRules, writeRules } from "../advise/workload-rules.js";
import { assessmentOf } from "./assessment-query.js";
import { RunNotJoinable } from "../run/runs.js";
import { EXPLAINS } from "../analyze/serverless.js";
import { sighted } from "../advise/advisory.js";
const NO_ADVISOR = "This build has no workload advisor, so there is nothing to read here and nothing to run. The advisor needs a SQL warehouse to read the estate with and somewhere durable to keep what it concludes; bind both and the Optimisation section appears.";
/** One advisory, as a reader outside the process sees it. */
function advisoryPayload(advisory) {
	return {
		id: advisory.id,
		runId: advisory.runId,
		finishedAt: advisory.finishedAt,
		state: advisory.state,
		...advisory.incompleteReason != null ? { incompleteReason: advisory.incompleteReason } : {},
		scope: advisory.scope.description,
		lookbackDays: advisory.lookbackDays,
		actor: advisory.stamp.actor,
		sighted: sighted(advisory),
		...advisory.serverless != null ? { serverless: presentServerless(advisory.serverless) } : {},
		...advisory.workload != null ? { workload: presentWorkload(advisory.workload) } : {},
		...advisory.sizing != null ? { sizing: presentSizing(advisory.sizing) } : {},
		...advisory.jobs != null ? { jobs: presentJobs(advisory.jobs) } : {},
		...advisory.writes != null ? { writes: presentWrites(advisory.writes) } : {},
		...advisory.planCapability != null ? { planCapability: advisory.planCapability } : {}
	};
}
/**
* The sizing analysis, flattened for a reader.
*
* The same two moves `presentWorkload` makes and for the same reasons: the rule's words are joined on so a
* client does not hold a copy of the ruleset, and the pressure row is unpacked rather than passed through —
* it carries the warehouse population on every row as an artefact of how the statement returns it, and
* sending two hundred copies of one number would invite a client to sum them.
*/
function presentSizing(analysis) {
	const ruleset = sizingRules();
	return {
		warehouses: analysis.warehouses.map((one) => {
			const row = one.pressure;
			return {
				workspaceId: one.workspaceId,
				warehouseId: one.warehouseId,
				name: one.name,
				...one.link != null ? { link: one.link } : {},
				...one.serverless != null ? { serverless: one.serverless } : {},
				...one.size != null ? { size: one.size } : {},
				...one.nextSizeDown != null ? { nextSizeDown: one.nextSizeDown } : {},
				...one.minClusters != null ? { minClusters: one.minClusters } : {},
				...one.maxClusters != null ? { maxClusters: one.maxClusters } : {},
				...one.autoStopMinutes != null ? { autoStopMinutes: one.autoStopMinutes } : {},
				state: one.state,
				findings: one.findings.flatMap((finding) => {
					const rule = ruleset.rules.get(finding.rule);
					return rule == null ? [] : [{
						rule: finding.rule,
						severity: finding.severity,
						confidence: finding.confidence,
						action: rule.action,
						headline: rule.headline,
						detail: rule.detail,
						docUrl: rule.docUrl,
						...rule.rationale != null ? { rationale: rule.rationale } : {},
						evidence: finding.evidence
					}];
				}),
				runs: row.runs,
				measuredRuns: row.measured,
				totalMs: row.totalMs,
				busyMs: row.busyMs,
				queueMs: row.queueMs,
				spilledBytes: row.spilledBytes,
				peakUsers: row.peakUsers,
				daysUsed: row.daysUsed,
				daysQueued: row.daysQueued,
				daysSpilled: row.daysSpilled,
				...row.p95Ms != null ? { p95Ms: row.p95Ms } : {},
				...row.worstMs != null ? { worstMs: row.worstMs } : {},
				upMs: row.upMs,
				clusterMs: row.clusterMs,
				starts: row.starts,
				peakClusters: row.peakClusters,
				carriedIn: row.carriedIn,
				...row.executionPercent != null ? { executionPercent: row.executionPercent } : {},
				...row.queuePercent != null ? { queuePercent: row.queuePercent } : {}
			};
		}),
		findingCount: analysis.findingCount,
		used: analysis.used,
		population: analysis.population,
		...analysis.live != null ? { live: analysis.live } : {},
		matched: analysis.matched,
		windowDays: analysis.windowDays,
		rulesVersion: analysis.rulesVersion
	};
}
/**
* The write analysis, flattened for a reader.
*
* The same two moves the presenters around it make: the rule's words are joined on so a client holds no
* copy of the ruleset, and the pattern row is unpacked rather than passed through — it carries the
* estate's write counts on every row as an artefact of how the statement returns them, and sending forty
* copies of one number invites a client to sum them.
*
* `statementId` is the one field of the row that is deliberately not carried. It exists so a plan could be
* fetched for the representative, and no plan is fetched for a write: `retrievable.ts` reads a warehouse id
* and a compute type this statement does not return. An id on the payload that nothing can be looked up by
* is a field a later surface would try to link.
*/
function presentWrites(analysis) {
	const ruleset = writeRules();
	return {
		shapes: analysis.shapes.map((one) => {
			const row = one.pattern;
			return {
				workspaceId: one.workspaceId,
				shape: one.shape,
				statementType: one.statementType,
				state: one.state,
				findings: one.findings.flatMap((finding) => {
					const rule = ruleset.rules.get(finding.rule);
					return rule == null ? [] : [{
						rule: finding.rule,
						severity: finding.severity,
						confidence: finding.confidence,
						action: rule.action,
						headline: rule.headline,
						detail: rule.detail,
						docUrl: rule.docUrl,
						...rule.rationale != null ? { rationale: rule.rationale } : {},
						evidence: finding.evidence
					}];
				}),
				runs: row.runs,
				finishedRuns: row.finishedRuns,
				daysRun: row.daysRun,
				runsStatingBytes: row.runsStatingBytes,
				writtenBytes: row.writtenBytes,
				...row.largestWriteBytes != null ? { largestWriteBytes: row.largestWriteBytes } : {},
				...row.medianWriteBytes != null ? { medianWriteBytes: row.medianWriteBytes } : {},
				readBytes: row.readBytes,
				producedRows: row.producedRows,
				totalMs: row.totalMs,
				...row.firstSeen != null ? { firstSeen: row.firstSeen } : {},
				...row.lastSeen != null ? { lastSeen: row.lastSeen } : {},
				...row.statementText != null ? { statementText: row.statementText } : {},
				...row.representativeAt != null ? { representativeAt: row.representativeAt } : {}
			};
		}),
		findingCount: analysis.findingCount,
		undeterminable: analysis.undeterminable,
		writeStatements: analysis.writeStatements,
		writesStatingBytes: analysis.writesStatingBytes,
		estateWrittenBytes: analysis.estateWrittenBytes,
		otherStatements: analysis.otherStatements,
		windowDays: analysis.windowDays,
		rulesVersion: analysis.rulesVersion
	};
}
/**
* The job analysis, flattened for a reader.
*
* The same two moves the two presenters below make: the rule's words are joined on so a client holds no
* copy of the ruleset, and the health row is unpacked rather than passed through.
*
* One conversion happens here and nowhere else. The statement derives seconds and `Evidence` carries a
* duration in milliseconds, so every duration on the payload is milliseconds — the unit every other
* duration on every other advisory payload is in. A page rendering seconds beside a warehouse's
* milliseconds would be two scales in one group, and `duration()` is the formatter both pages share. The
* one exception is named for its unit: `timeoutSeconds` is a definition's own setting rather than a
* measurement of a run, and it is copied as the definition states it.
*/
function presentJobs(analysis) {
	const ruleset = jobRules();
	const jobs = analysis.jobs.map((one) => {
		const row = one.health;
		return {
			workspaceId: one.workspaceId,
			jobId: one.jobId,
			name: one.name,
			...one.link != null ? { link: one.link } : {},
			...one.scheduled != null ? { scheduled: one.scheduled } : {},
			...one.triggerRecorded != null ? { triggerRecorded: one.triggerRecorded } : {},
			...one.multipleTriggers != null ? { multipleTriggers: one.multipleTriggers } : {},
			...one.paused != null ? { paused: one.paused } : {},
			...one.timeoutSeconds != null ? { timeoutSeconds: one.timeoutSeconds } : {},
			state: one.state,
			findings: one.findings.flatMap((finding) => {
				const rule = ruleset.rules.get(finding.rule);
				return rule == null ? [] : [{
					rule: finding.rule,
					severity: finding.severity,
					confidence: finding.confidence,
					action: rule.action,
					headline: rule.headline,
					detail: rule.detail,
					docUrl: rule.docUrl,
					...rule.rationale != null ? { rationale: rule.rationale } : {},
					evidence: finding.evidence
				}];
			}),
			runs: row.runs,
			totalMs: ms(row.wallSecondsTotal),
			meanMs: ms(row.wallSecondsMean),
			medianMs: ms(row.wallSecondsMedian),
			p95Ms: ms(row.wallSecondsP95),
			maxMs: ms(row.wallSecondsMax),
			taskMs: ms(row.taskSecondsTotal),
			tasksMost: row.tasksMost,
			longestTaskMs: ms(row.longestTaskSeconds),
			...row.busiestTaskKey != null ? { busiestTaskKey: row.busiestTaskKey } : {},
			...row.busiestTaskSeconds != null ? { busiestTaskMs: ms(row.busiestTaskSeconds) } : {},
			runsWithARepeatedTask: row.runsWithARepeatedTask,
			repeatedTaskRuns: row.repeatedTaskRuns,
			...row.lastRun != null ? { lastRun: row.lastRun } : {},
			...row.runsWithATerminalPeriod != null ? { runsWithATerminalPeriod: row.runsWithATerminalPeriod } : {},
			...row.runsSucceeded != null ? { runsSucceeded: row.runsSucceeded } : {},
			...row.runsDidNotSucceed != null ? { runsDidNotSucceed: row.runsDidNotSucceed } : {},
			...row.runsUnresolved != null ? { runsUnresolved: row.runsUnresolved } : {},
			...row.usageQuantity != null ? { usageQuantity: row.usageQuantity } : {},
			...row.usageRecords != null ? { usageRecords: row.usageRecords } : {},
			...row.usageRetractions != null ? { usageRetractions: row.usageRetractions } : {},
			...row.usageSkus != null ? { usageSkus: row.usageSkus } : {},
			...row.classicUsageRecords != null ? { classicUsageRecords: row.classicUsageRecords } : {},
			...row.classicRecordsStatingPhoton != null ? { classicRecordsStatingPhoton: row.classicRecordsStatingPhoton } : {},
			...row.classicRecordsWithPhotonOff != null ? { classicRecordsWithPhotonOff: row.classicRecordsWithPhotonOff } : {},
			...one.compute != null ? { compute: presentCompute(one.compute) } : {}
		};
	});
	return {
		jobs,
		findingCount: jobs.reduce((total, one) => total + one.findings.length, 0),
		eligible: analysis.eligible,
		population: analysis.population,
		sampled: analysis.sampled,
		...analysis.live != null ? { live: analysis.live } : {},
		matched: analysis.matched,
		...analysis.computeRead != null ? { computeRead: analysis.computeRead } : {},
		windowDays: analysis.windowDays,
		rulesVersion: analysis.rulesVersion
	};
}
/**
* One job's utilisation, with its three durations scaled and everything else passed through.
*
* The scaling is the only change, and it is the same one `presentJobs` makes: the statement derives
* seconds and the payload carries milliseconds, so the whole surface formats one unit. Nothing is
* defaulted — a figure the join did not reach stays absent all the way to the page.
*/
function presentCompute(row) {
	return {
		runClusterPairs: row.runClusterPairs,
		runsWithWorkerSamples: row.runsWithWorkerSamples,
		clusters: row.clusters,
		pairsBelowThreeSamples: row.pairsBelowThreeSamples,
		avgCpuPercent: row.avgCpuPercent,
		peakCpuPercent: row.peakCpuPercent,
		avgCpuWaitPercent: row.avgCpuWaitPercent,
		avgMemoryPercent: row.avgMemoryPercent,
		peakMemoryPercent: row.peakMemoryPercent,
		avgSwapPercent: row.avgSwapPercent,
		...row.networkBytesPerNodeMinute != null ? { networkBytesPerNodeMinute: row.networkBytesPerNodeMinute } : {},
		pairsWithANetworkRate: row.pairsWithANetworkRate,
		pairsStatingNoNetwork: row.pairsStatingNoNetwork,
		...row.estateMedianBytesPerNodeMinute != null ? { estateMedianBytesPerNodeMinute: row.estateMedianBytesPerNodeMinute } : {},
		estatePairsWithARate: row.estatePairsWithARate,
		...row.nodeType != null ? { nodeType: row.nodeType } : {},
		pairsWithAnAsOfConfig: row.pairsWithAnAsOfConfig,
		...row.workerCount != null ? { workerCount: row.workerCount } : {},
		runsWithNoSetupFigure: row.runsWithNoSetupFigure,
		...row.setupSecondsMax != null ? { setupMsMax: ms(row.setupSecondsMax) } : {},
		...row.setupSecondsMean != null ? { setupMsMean: ms(row.setupSecondsMean) } : {},
		...row.statedRunSecondsMean != null ? { statedRunMsMean: ms(row.statedRunSecondsMean) } : {},
		...row.earliestSample != null ? { earliestSample: row.earliestSample } : {},
		...row.latestSample != null ? { latestSample: row.latestSample } : {}
	};
}
/** Seconds as milliseconds, rounded. The one unit conversion on this payload — see `presentJobs`. */
function ms(seconds) {
	return Math.round(seconds * 1e3);
}
/**
* The workload analysis, flattened for a reader.
*
* Two things happen here that are not a rename. The rule's words and citation are joined onto each
* finding, because a client that held the ruleset would be a second copy of it — and the version this
* process shipped is the version the finding was made under, whatever the client has. And the row is
* unpacked rather than passed through: `QueryShapeRow` carries the coverage figures on every row as an
* artefact of how the statement returns them, and sending forty copies of the same pair would invite a
* client to sum them.
*/
function presentWorkload(analysis) {
	const ruleset = workloadRules();
	return {
		top: analysis.top.map((shape) => presentShape(shape, ruleset)),
		failing: analysis.failing.map((shape) => presentShape(shape, ruleset)),
		coverage: analysis.coverage,
		considered: analysis.considered,
		findingCount: analysis.findingCount,
		rankingVersion: analysis.rankingVersion,
		rulesVersion: analysis.rulesVersion,
		windowDays: analysis.windowDays
	};
}
function presentShape(shape, ruleset) {
	const row = shape.row;
	return {
		shape: shape.shape,
		workspaceId: shape.workspaceId,
		statementType: shape.statementType,
		score: shape.score,
		trend: shape.trend,
		findings: shape.findings.flatMap((finding) => {
			const rule = ruleset.rules.get(finding.rule);
			return rule == null ? [] : [{
				rule: finding.rule,
				severity: finding.severity,
				confidence: finding.confidence,
				action: rule.action,
				headline: rule.headline,
				detail: rule.detail,
				docUrl: rule.docUrl,
				...rule.rationale != null ? { rationale: rule.rationale } : {},
				evidence: finding.evidence
			}];
		}),
		...row.statementText != null ? { statementText: row.statementText } : {},
		...row.statementId != null ? { statementId: row.statementId } : {},
		...row.representativeAt != null ? { representativeAt: row.representativeAt } : {},
		representativeMeasured: row.representativeMeasured,
		...row.representativeStatus != null ? { representativeStatus: row.representativeStatus } : {},
		runs: row.runsNow,
		measuredRuns: row.measuredNow,
		totalMs: row.msNow,
		...row.meanMsNow != null ? { meanMs: row.meanMsNow } : {},
		...row.medianMs != null ? { medianMs: row.medianMs } : {},
		...row.worstMs != null ? { worstMs: row.worstMs } : {},
		readBytes: row.readBytes,
		spilledBytes: row.spilledBytes,
		shuffleBytes: row.shuffleBytes,
		readFiles: row.readFiles,
		...row.prunedPercent != null ? { prunedPercent: row.prunedPercent } : {},
		...row.parallelism != null ? { parallelism: row.parallelism } : {},
		...row.compilationPercent != null ? { compilationPercent: row.compilationPercent } : {},
		queueMs: row.queueMs,
		cacheHits: row.cacheHits,
		failures: row.failures,
		warehouses: row.warehouses,
		jobs: row.jobs,
		pipelines: row.pipelines
	};
}
/**
* The serverless analysis with the requirements it elaborates attached.
*
* The same shape the scan route serves, so a client reads one payload whichever record it came from —
* which is what makes moving the page's source a change of URL rather than a rewrite.
*/
function presentServerless(analysis) {
	return {
		...analysis,
		explains: EXPLAINS
	};
}
function linePayload(line) {
	return {
		id: line.id,
		runId: line.runId,
		finishedAt: line.finishedAt,
		state: line.state,
		scope: line.scope,
		lookbackDays: line.lookbackDays,
		...line.definitionId != null ? { definitionId: line.definitionId } : {},
		considered: line.considered
	};
}
function registerAdvisoryRoutes(app, options) {
	/**
	* What the advisor last concluded.
	*
	* 404 rather than an empty payload where nothing has run yet, and a 409 where there is no advisor —
	* which are different things a client responds to differently: the first is "press the button", the
	* second is "this install cannot".
	*/
	app.get("/api/advisory/latest", async (request, response) => {
		const store = options.advisories;
		if (store == null) {
			response.status(409).json({
				error: "no-advisor",
				message: NO_ADVISOR
			});
			return;
		}
		const latest = await store.latest(assessmentOf(request));
		if (latest == null) {
			response.status(404).json({
				error: "nothing-yet",
				message: "The advisor has not run here yet. It analyses recent query, warehouse, and job activity to prioritise changes. The read-only analysis usually takes a few minutes."
			});
			return;
		}
		response.json(advisoryPayload(latest));
	});
	/**
	* The advisor's history, newest first.
	*
	* Before the id-addressed route below, because `/api/advisory/history` would otherwise be read as an
	* advisory whose id is "history" — Express matches in the order routes are registered, and the failure
	* is a 404 that looks like a missing record rather than a routing mistake.
	*/
	app.get("/api/advisory/history", async (request, response) => {
		const store = options.advisories;
		if (store == null) {
			const nothing = {
				available: false,
				runs: [],
				unavailable: NO_ADVISOR
			};
			response.json(nothing);
			return;
		}
		const payload = {
			available: true,
			runs: (await store.history(50, assessmentOf(request))).map(linePayload)
		};
		response.json(payload);
	});
	/** One advisory, by id, so a history row links to what it was about. */
	app.get("/api/advisory/:id", async (request, response) => {
		const store = options.advisories;
		if (store == null) {
			response.status(409).json({
				error: "no-advisor",
				message: NO_ADVISOR
			});
			return;
		}
		const found = await store.get(request.params.id ?? "", assessmentOf(request));
		if (found == null) {
			response.status(404).json({
				error: "no-such-advisory",
				message: "No advisory with that id is recorded here. Advice is kept for a shorter period than an assessment is — a run older than the advisory retention period has been swept."
			});
			return;
		}
		response.json(advisoryPayload(found));
	});
	const runAdvisoryFor = (trigger) => async (request, response) => {
		let act;
		try {
			const runs = options.runs;
			const asking = options.asking;
			if (runs == null || asking == null || options.advisories == null) {
				response.status(409).json({
					error: "no-advisor",
					message: NO_ADVISOR
				});
				return;
			}
			const permission = await options.permitted(request, response, "advisory.start");
			act = permission.act;
			const resolved = await asking(request, permission.actor, permission.scope);
			if ("error" in resolved) {
				response.status(resolved.status).json({
					error: resolved.error,
					message: resolved.message
				});
				return;
			}
			const key = options.idempotencyKey?.(request);
			const started = await runs.advise(resolved, {
				actor: permission.actor,
				trigger,
				...key != null ? { idempotencyKey: key } : {}
			});
			const advisory = await started.advisory;
			await act.performed({
				kind: "run",
				id: started.run.id
			});
			if (trigger === "interactive") {
				response.json(advisoryPayload(advisory));
				return;
			}
			const summary = {
				advisory: advisory.id,
				run: started.run.id,
				state: advisory.state,
				considered: advisory.serverless?.jobs.length ?? 0
			};
			if (!sighted(advisory)) {
				response.status(422).json({
					error: "nothing-readable",
					message: "The advisory run completed and could not read any of the tables it needs, so it has no advice to give. This is a grant or a warehouse problem rather than an estate with nothing to improve — see the readings on the record.",
					...summary
				});
				return;
			}
			response.json(summary);
		} catch (cause) {
			await act?.failed(cause);
			if (cause instanceof RunNotJoinable) {
				response.status(409).json({
					error: "run-not-joinable",
					refusal: cause.refusal,
					message: cause.message,
					run: cause.run.id
				});
				return;
			}
			options.respondToFailure(response, cause);
		}
	};
	app.post("/api/advisory", runAdvisoryFor("interactive"));
	/**
	* The same run, started by a schedule.
	*
	* A separate route rather than a flag in the body, so that "nobody was watching" is decided by which
	* door the call came through rather than by what the caller claimed about itself. The same reasoning
	* as `/api/scan/scheduled`, and the same absence of a shared secret — see ADR 0021.
	*/
	app.post("/api/advisory/scheduled", runAdvisoryFor("scheduled"));
}
//#endregion
export { advisoryPayload, registerAdvisoryRoutes };
