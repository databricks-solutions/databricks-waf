import { multipleTriggers, triggerRecorded } from "../resolve/resolvers/helpers.js";
import { jobRules } from "./workload-rules.js";
//#region server/advise/jobs.ts
/**
* The analysis, or `undefined` where there is nothing to analyse.
*
* The same distinction the workload, sizing and serverless analyses draw. Here the empty case would render
* as an estate whose jobs all run cleanly, and a run whose `job_task_run_timeline` read was refused would
* be indistinguishable from a workspace with no jobs. The readings on the record are what tell those apart.
*/
function analyseJobs(health, jobs, lookbackDays, ruleset = jobRules(), compute) {
	if (health.length === 0) return void 0;
	const definitions = new Map(jobs.map((row) => [`${row.workspaceId}/${row.jobId}`, row]));
	const utilisation = new Map((compute ?? []).map((row) => [`${row.workspaceId}/${row.jobId}`, row]));
	const described = health.map((row) => describe(row, definitions.get(`${row.workspaceId}/${row.jobId}`), ruleset, utilisation.get(`${row.workspaceId}/${row.jobId}`)));
	return {
		jobs: [...described].sort((a, b) => worst(b) - worst(a) || b.health.wallSecondsTotal - a.health.wallSecondsTotal || a.name.localeCompare(b.name)),
		findingCount: described.reduce((total, one) => total + one.findings.length, 0),
		eligible: described.filter((one) => one.state !== "ineligible").length,
		population: Math.max(health[0]?.jobPopulation ?? 0, described.length),
		sampled: described.length,
		matched: described.filter((one) => definitions.has(`${one.workspaceId}/${one.jobId}`)).length,
		...jobs.length > 0 ? { live: jobs.length } : {},
		...compute != null ? { computeRead: reachOf(compute, utilisation.size) } : {},
		windowDays: lookbackDays,
		rulesVersion: ruleset.version
	};
}
/**
* The funnel, from whichever row carries it, and zeros where the statement returned nothing.
*
* The first three figures are the statement's own counts over the window and every row repeats them, so any
* row will do. The fourth is the rows themselves. An all-serverless estate returns no rows, and then all
* four are zero — which is a reading and not a missing one, because the caller passed an array.
*/
function reachOf(compute, reached) {
	const first = compute[0];
	const earliest = compute.map((row) => row.earliestSample).filter((at) => at != null);
	const latest = compute.map((row) => row.latestSample).filter((at) => at != null);
	return {
		thatRan: first?.jobsThatRan ?? 0,
		withAComputeId: first?.jobsWithAComputeId ?? 0,
		onClassicCompute: first?.jobsOnClassicCompute ?? 0,
		withWorkerSamples: reached,
		...earliest.length > 0 ? { earliestSample: new Date(Math.min(...earliest.map((at) => at.getTime()))) } : {},
		...latest.length > 0 ? { latestSample: new Date(Math.max(...latest.map((at) => at.getTime()))) } : {}
	};
}
/** The severity of a job's worst finding, as a sort key. Zero where it has none. */
function worst(one) {
	return one.findings.reduce((high, finding) => Math.max(high, 4 - RANK[finding.severity]), 0);
}
const RANK = {
	critical: 0,
	high: 1,
	medium: 2,
	info: 3
};
/**
* The eligibility floor, read from whichever rule declares it.
*
* Every rule requires three runs and they all mean the same three, so the state is decided once rather
* than by whether any rule happened to fire. A job below the floor is `ineligible` and gets no findings at
* all, including from the rule whose own threshold it might have cleared.
*/
function floorOf(ruleset) {
	return ruleset.rules.get("JOB_LONG_RUNNING")?.thresholds["min_runs"] ?? 3;
}
function describe(row, definition, ruleset, compute) {
	const eligible = row.runs >= floorOf(ruleset);
	const findings = eligible ? findingsFor(row, ruleset, compute) : [];
	return {
		workspaceId: row.workspaceId,
		jobId: row.jobId,
		name: definition?.name ?? row.jobId,
		...definition != null && {
			scheduled: definition.scheduled,
			triggerRecorded: triggerRecorded(definition),
			multipleTriggers: multipleTriggers(definition)
		},
		...definition?.paused != null && { paused: definition.paused },
		...definition?.timeoutSeconds != null && { timeoutSeconds: definition.timeoutSeconds },
		health: row,
		...compute != null && { compute },
		state: !eligible ? "ineligible" : findings.length > 0 ? "advised" : "clean",
		findings
	};
}
function findingsFor(row, ruleset, compute) {
	return [...CONDITIONS.flatMap((condition) => {
		const rule = ruleset.rules.get(condition.id);
		if (rule == null) return [];
		const hit = condition.test(row, rule, compute);
		return hit == null ? [] : [{
			rule: condition.id,
			jobId: row.jobId,
			...hit
		}];
	})].sort((a, b) => RANK[a.severity] - RANK[b.severity] || order(a.rule) - order(b.rule));
}
function order(id) {
	return CONDITIONS.findIndex((condition) => condition.id === id);
}
/** Seconds as milliseconds, which is the unit `Evidence` carries a duration in. */
function ms(seconds) {
	return Math.round(seconds * 1e3);
}
/**
* A percentage rounded the way every one of these rules reports one, to a tenth.
*
* The statement already rounds to two decimals; this is so a finding's evidence reads the same as the rest
* of the page rather than at a precision the samples behind it do not support.
*/
function pct(value) {
	return Math.round(value * 10) / 10;
}
/**
* The pairs a utilisation rule may read a mean from, or `undefined` where the job has too few.
*
* Two conditions in one place because the four rules apply the same two, and because getting either wrong
* is silent: a job with no compute row would otherwise read as one whose workers were idle, and a job whose
* every pair holds one sample would read as one whose mean was measured. 48.2% of pairs on the estate `41b`
* measured are the second.
*/
function sampled(compute, rule) {
	if (compute == null) return void 0;
	const usable = compute.runClusterPairs - compute.pairsBelowThreeSamples;
	return usable >= rule.thresholds["min_sampled_pairs"] ? usable : void 0;
}
/**
* The two lines every utilisation finding ends with.
*
* The pair count and the node type, and the node type only where the as-of configuration join resolved it.
* `47` decided that: relaxing the ordering would name a type for 53.6% of pairs instead of 8.7%, and every
* pair in the difference has its only configuration record written *after* the run it would be attributed
* to. So the finding recommends the direction without the name rather than naming the wrong cluster.
*/
function computeEvidence(compute, usable) {
	return [{
		label: "Runs and clusters read",
		value: usable,
		unit: "count"
	}, ...compute.nodeType != null ? [{
		label: `Runs on "${compute.nodeType}"`,
		value: compute.pairsWithAnAsOfConfig,
		unit: "count"
	}] : []];
}
/**
* The conditions, in the order they should be read: what went wrong, then what it costs.
*
* Failure first and duration second, which is the opposite of the audit document's query order and
* deliberate. A job whose runs do not succeed is not a job to resize, and a page led by "this job is slow"
* invites a reader to make it faster at failing.
*/
const CONDITIONS = [
	{
		id: "JOB_RUNS_NOT_SUCCEEDING",
		test: (row, rule) => {
			const succeeded = row.runsSucceeded;
			const failed = row.runsDidNotSucceed;
			if (succeeded == null || failed == null) return void 0;
			const resolved = succeeded + failed;
			if (resolved < rule.thresholds["min_resolved_runs"]) return void 0;
			const share = failed / resolved;
			if (share < rule.thresholds["unsuccessful_share"]) return void 0;
			return {
				severity: share >= rule.thresholds["critical_unsuccessful_share"] ? "critical" : rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Runs that did not succeed",
						value: failed,
						unit: "count"
					},
					{
						label: "Runs that stated an outcome",
						value: resolved,
						unit: "count"
					},
					{
						label: "Share that did not succeed",
						value: Math.round(share * 1e3) / 10,
						unit: "percent"
					},
					...row.runsUnresolved != null && row.runsUnresolved > 0 ? [{
						label: "Runs with no outcome yet",
						value: row.runsUnresolved,
						unit: "count"
					}] : []
				]
			};
		}
	},
	{
		id: "JOB_TASKS_RUN_AGAIN",
		test: (row, rule) => {
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.runsWithARepeatedTask / row.runs < rule.thresholds["repeating_share"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Runs in which a task ran again",
						value: row.runsWithARepeatedTask,
						unit: "count"
					},
					{
						label: "Runs in the window",
						value: row.runs,
						unit: "count"
					},
					{
						label: "Extra task runs",
						value: row.repeatedTaskRuns,
						unit: "count"
					}
				]
			};
		}
	},
	{
		id: "JOB_LONG_RUNNING",
		test: (row, rule) => {
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.wallSecondsP95 < rule.thresholds["p95_seconds"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Slowest 5% of runs took",
						value: ms(row.wallSecondsP95),
						unit: "ms"
					},
					{
						label: "Median run",
						value: ms(row.wallSecondsMedian),
						unit: "ms"
					},
					{
						label: "Longest run",
						value: ms(row.wallSecondsMax),
						unit: "ms"
					},
					{
						label: "Runs in the window",
						value: row.runs,
						unit: "count"
					}
				]
			};
		}
	},
	{
		id: "JOB_DOMINATED_BY_ONE_TASK",
		test: (row, rule) => {
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.tasksMost < rule.thresholds["min_tasks"]) return void 0;
			const busiest = row.busiestTaskSeconds;
			if (busiest == null || row.taskSecondsTotal <= 0) return void 0;
			const share = busiest / row.taskSecondsTotal;
			if (share < rule.thresholds["busiest_share"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					...row.busiestTaskKey != null ? [{
						label: `Time in "${row.busiestTaskKey}"`,
						value: ms(busiest),
						unit: "ms"
					}] : [{
						label: "Time in the busiest task",
						value: ms(busiest),
						unit: "ms"
					}],
					{
						label: "Task time across the job",
						value: ms(row.taskSecondsTotal),
						unit: "ms"
					},
					{
						label: "Share in that one task",
						value: Math.round(share * 1e3) / 10,
						unit: "percent"
					},
					{
						label: "Tasks at most",
						value: row.tasksMost,
						unit: "count"
					}
				]
			};
		}
	},
	{
		id: "JOB_WORKERS_UNDERUSED",
		test: (row, rule, compute) => {
			const usable = sampled(compute, rule);
			if (compute == null || usable == null) return void 0;
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (row.wallSecondsP95 < rule.thresholds["p95_seconds"]) return void 0;
			if (compute.avgCpuPercent >= rule.thresholds["cpu_percent"]) return void 0;
			if (compute.avgMemoryPercent >= rule.thresholds["memory_percent"]) return void 0;
			if (compute.avgSwapPercent >= rule.thresholds["swap_percent"]) return void 0;
			if (compute.avgCpuWaitPercent >= rule.thresholds["cpu_wait_percent"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Average worker CPU",
						value: pct(compute.avgCpuPercent),
						unit: "percent"
					},
					{
						label: "Average worker memory",
						value: pct(compute.avgMemoryPercent),
						unit: "percent"
					},
					{
						label: "Slowest 5% of runs took",
						value: ms(row.wallSecondsP95),
						unit: "ms"
					},
					...computeEvidence(compute, usable)
				]
			};
		}
	},
	{
		id: "JOB_MEMORY_BOUND",
		test: (row, rule, compute) => {
			const usable = sampled(compute, rule);
			if (compute == null || usable == null) return void 0;
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			const onAverage = compute.avgMemoryPercent >= rule.thresholds["memory_percent"];
			const atPeak = compute.peakMemoryPercent >= rule.thresholds["peak_memory_percent"];
			if (!onAverage && !atPeak) return void 0;
			return {
				severity: rule.severity,
				confidence: onAverage ? "moderate" : "low",
				evidence: [
					{
						label: "Average worker memory",
						value: pct(compute.avgMemoryPercent),
						unit: "percent"
					},
					{
						label: "Peak worker memory",
						value: pct(compute.peakMemoryPercent),
						unit: "percent"
					},
					...computeEvidence(compute, usable)
				]
			};
		}
	},
	{
		id: "JOB_COMPUTE_BOUND",
		test: (row, rule, compute) => {
			const usable = sampled(compute, rule);
			if (compute == null || usable == null) return void 0;
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (compute.avgCpuPercent < rule.thresholds["cpu_percent"]) return void 0;
			if (compute.avgMemoryPercent >= rule.thresholds["memory_percent"]) return void 0;
			if (compute.avgCpuWaitPercent >= rule.thresholds["cpu_wait_percent"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Average worker CPU",
						value: pct(compute.avgCpuPercent),
						unit: "percent"
					},
					{
						label: "Average worker memory",
						value: pct(compute.avgMemoryPercent),
						unit: "percent"
					},
					{
						label: "Time waiting on storage",
						value: pct(compute.avgCpuWaitPercent),
						unit: "percent"
					},
					...computeEvidence(compute, usable)
				]
			};
		}
	},
	{
		id: "JOB_STARTUP_OVERHEAD",
		test: (row, rule, compute) => {
			if (compute == null) return void 0;
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			const setup = compute.setupSecondsMean;
			const stated = compute.statedRunSecondsMean;
			if (setup == null || setup < rule.thresholds["setup_seconds"]) return void 0;
			if (stated == null || stated <= 0) return void 0;
			const share = setup / stated;
			if (share < rule.thresholds["setup_share"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "moderate",
				evidence: [
					{
						label: "Average setup per run",
						value: ms(setup),
						unit: "ms"
					},
					{
						label: "Average run as the platform states it",
						value: ms(stated),
						unit: "ms"
					},
					{
						label: "Share spent starting the cluster",
						value: pct(share * 100),
						unit: "percent"
					},
					...compute.runsWithNoSetupFigure > 0 ? [{
						label: "Runs with no setup figure",
						value: compute.runsWithNoSetupFigure,
						unit: "count"
					}] : []
				]
			};
		}
	},
	{
		id: "JOB_NETWORK_HEAVY",
		test: (row, rule, compute) => {
			if (compute == null) return void 0;
			if (row.runs < rule.thresholds["min_runs"]) return void 0;
			if (compute.pairsWithANetworkRate < rule.thresholds["min_sampled_pairs"]) return void 0;
			const rate = compute.networkBytesPerNodeMinute;
			const median = compute.estateMedianBytesPerNodeMinute;
			if (rate == null || median == null || median <= 0) return void 0;
			if (compute.estatePairsWithARate < rule.thresholds["min_estate_pairs"]) return void 0;
			if (rate < rule.thresholds["min_bytes_per_node_minute"]) return void 0;
			if (rate / median < rule.thresholds["median_multiple"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "low",
				evidence: [
					{
						label: "Network per minute of worker time",
						value: Math.round(rate),
						unit: "bytes"
					},
					{
						label: "This workspace’s median, over every pair with a rate",
						value: Math.round(median),
						unit: "bytes"
					},
					{
						label: "Times the median",
						value: Math.round(rate / median * 10) / 10,
						unit: "multiple"
					},
					{
						label: "Runs and clusters with a rate",
						value: compute.pairsWithANetworkRate,
						unit: "count"
					},
					...compute.pairsStatingNoNetwork > 0 ? [{
						label: "Runs and clusters that stated no figure",
						value: compute.pairsStatingNoNetwork,
						unit: "count"
					}] : []
				]
			};
		}
	},
	{
		id: "JOB_PHOTON_OFF",
		test: (row, rule) => {
			const stated = row.classicRecordsStatingPhoton;
			const off = row.classicRecordsWithPhotonOff;
			if (stated == null || off == null) return void 0;
			if (stated < rule.thresholds["min_photon_records"]) return void 0;
			const share = off / stated;
			if (share < rule.thresholds["photon_off_share"]) return void 0;
			return {
				severity: rule.severity,
				confidence: "high",
				evidence: [
					{
						label: "Usage records with Photon off",
						value: off,
						unit: "count"
					},
					{
						label: "Non-serverless usage records that state it",
						value: stated,
						unit: "count"
					},
					{
						label: "Share with it off",
						value: Math.round(share * 1e3) / 10,
						unit: "percent"
					},
					...row.classicUsageRecords != null && row.classicUsageRecords > stated ? [{
						label: "Non-serverless records that state nothing",
						value: row.classicUsageRecords - stated,
						unit: "count"
					}] : []
				]
			};
		}
	}
];
//#endregion
export { analyseJobs };
