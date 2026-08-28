import { share } from "../../collect/sql/rows.js";
import { isAllPurpose } from "../../collect/sql/shapes.js";
import { asCluster, asJob, asWarehouse } from "../locate.js";
import { bandOutcome, bandsOf, detailFrom, enrichedBy, evidenceFrom, fromSignal, fromSignals, money, nameIn, notApplicable, offenders, percent, priceBarrier, priceCoverageClause, satisfiedByArchitecture, threshold, unmeasured, valueOf } from "./helpers.js";
import { SCHEMA_CENSUS, estateExclusion, whereTheGapIs } from "./segments.js";
import { VISIBILITY_CROSS_CHECK, unestablishedEmptiness } from "./visibility.js";
//#region server/resolve/resolvers/cost.ts
const CLUSTERS = "sql:compute.clusters";
const WAREHOUSES = "sql:compute.warehouses";
const MIX = "sql:cost.compute_mix";
const ATTRIBUTION = "sql:cost.attribution";
const CENSUS = "sql:uc.census";
const JOBS = "sql:jobs.inventory";
const SQL_PATHS = "sql:workload.sql_paths";
function leftoverWithoutFormat(census) {
	return {
		views: census.views,
		metricViews: census.metricViews ?? 0,
		foreignTables: census.foreignTables ?? 0
	};
}
function formatPopulation(census) {
	const leftover = leftoverWithoutFormat(census);
	return census.tableCount - leftover.views - leftover.metricViews - leftover.foreignTables;
}
function formatGap(schema) {
	return formatPopulation(schema) - schema.optimizedFormatTables;
}
function countNoun(count, one, many) {
	return `${count} ${count === 1 ? one : many}`;
}
function leftoverParts(leftover) {
	const parts = [];
	if (leftover.views > 0) parts.push(countNoun(leftover.views, "view", "views"));
	if (leftover.metricViews > 0) parts.push(countNoun(leftover.metricViews, "metric view", "metric views"));
	if (leftover.foreignTables > 0) parts.push(countNoun(leftover.foreignTables, "foreign table", "foreign tables"));
	return parts;
}
function joinAnd(parts) {
	if (parts.length <= 1) return parts[0] ?? "";
	if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
	return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
function noFormatReason(census) {
	const leftover = leftoverWithoutFormat(census);
	if (leftover.views === census.tableCount && leftover.metricViews === 0 && leftover.foreignTables === 0) return "This metastore contains only views, which have no storage format to choose.";
	if (leftover.metricViews === census.tableCount && leftover.views === 0 && leftover.foreignTables === 0) return "This metastore contains only metric views, which have no storage format to choose.";
	if (leftover.foreignTables === census.tableCount && leftover.views === 0 && leftover.metricViews === 0) return "This metastore contains only foreign tables, which have no storage format to choose.";
	return `This metastore contains ${joinAnd(leftoverParts(leftover))}, which have no storage format to choose.`;
}
const COST_RESOLVERS = [
	enrichedBy([SCHEMA_CENSUS, VISIBILITY_CROSS_CHECK], fromSignal(CENSUS, [
		"CO-01-01",
		"REL-01-01",
		"DG-03-03",
		"IU-02-01"
	], (census, context) => {
		const leftover = leftoverWithoutFormat(census);
		const population = formatPopulation(census);
		if (population <= 0) return (census.tableCount === 0 ? unestablishedEmptiness(context) : void 0) ?? notApplicable(census.tableCount === 0 ? "This metastore contains no tables, so there is no format choice to assess." : noFormatReason(census));
		const adopted = share(census.optimizedFormatTables, population);
		const gap = whereTheGapIs(context, formatGap);
		const exclusion = estateExclusion(census);
		const leftoverNote = leftover.views + leftover.metricViews + leftover.foreignTables > 0 ? `; ${joinAnd(leftoverParts(leftover))} are out of the denominator` : "";
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .95,
				partial: .7
			})),
			evidence: [
				evidenceFrom(context, CENSUS, `${census.optimizedFormatTables} of ${population} tables are Delta or Iceberg (${percent(adopted)}); ${census.deltaTables} Delta, ${census.icebergTables} Iceberg${leftoverNote}`, "Tables use an open, performance-optimised format rather than raw CSV, JSON or bare Parquet"),
				...gap != null ? [detailFrom(context, SCHEMA_CENSUS, gap)] : [],
				...exclusion != null ? [detailFrom(context, CENSUS, exclusion)] : []
			]
		};
	})),
	fromSignal(MIX, ["CO-01-02"], (mix, context) => {
		const barrier = priceBarrier(mix, "a share of job spend on all-purpose compute");
		if (barrier != null) return unmeasured(barrier, "attestation");
		if (mix.totalCost <= 0) return notApplicable("No billable usage was recorded in the window, so there is no spend to assess.");
		if (mix.choiceCost <= 0) return notApplicable(`None of the ${money(mix.totalCost, mix.currency)} billed in the window was on job, all-purpose, SQL or pipeline compute, so there is no compute choice here to get wrong.`);
		const wasted = share(mix.jobsOnAllPurposeCost, mix.choiceCost) ?? 0;
		const bands = bandsOf(context.spec, {
			pass: .98,
			partial: .85
		});
		return {
			outcome: bandOutcome(1 - wasted, bands),
			evidence: [evidenceFrom(context, MIX, mix.jobsOnAllPurposeCost <= 0 ? `No job-attributed spend on all-purpose compute, out of ${money(mix.choiceCost, mix.currency)} on compute somebody configured (${priceCoverageClause(mix)})` : `${money(mix.jobsOnAllPurposeCost, mix.currency)} of ${money(mix.choiceCost, mix.currency)} (${percent(wasted)}) is job-attributed spend on all-purpose compute (${priceCoverageClause(mix)})`, "Scheduled work runs on job compute, which is billed at a lower rate than all-purpose")]
		};
	}),
	fromSignal(CLUSTERS, ["CO-01-04"], (clusters, context) => {
		const population = clusters.filter(isAllPurpose);
		if (population.length === 0) return satisfiedByArchitecture("This estate runs no classic all-purpose clusters, so there is no runtime version to keep current — serverless compute is upgraded by the platform.");
		const minimum = threshold(context.spec, "min_runtime_major", 14);
		const current = population.filter((cluster) => majorVersion(cluster.runtime) >= minimum);
		const adopted = share(current.length, population.length);
		const stale = population.filter((cluster) => majorVersion(cluster.runtime) < minimum);
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .9,
				partial: .6
			})),
			evidence: [evidenceFrom(context, CLUSTERS, `${current.length} of ${population.length} all-purpose clusters run DBR ${minimum} or later` + (stale.length > 0 ? `; oldest: ${describeOldest(stale, nameIn(context))}` : ""), `All-purpose clusters run Databricks Runtime ${minimum} or later`)]
		};
	}),
	fromSignal(CLUSTERS, ["CO-01-05"], (clusters, context) => {
		const gpuClusters = clusters.filter((cluster) => cluster.gpuNode);
		if (gpuClusters.length === 0) return {
			outcome: "pass",
			evidence: [evidenceFrom(context, CLUSTERS, "No GPU-backed clusters are configured", "GPUs are used only for workloads that need them")]
		};
		return {
			outcome: "partial",
			evidence: [evidenceFrom(context, CLUSTERS, `${gpuClusters.length} GPU-backed cluster${gpuClusters.length === 1 ? "" : "s"}`, "GPUs are used only for workloads that need them"), ...offenders(context, CLUSTERS, "On GPU nodes", gpuClusters, asCluster, { note: (cluster) => cluster.workerNodeType ?? "unknown node type" })],
			outcomeReason: "Whether these workloads need GPUs cannot be determined from configuration alone. Confirm each is doing GPU-accelerated work; the check can only show that GPUs are in use."
		};
	}),
	fromSignal(MIX, [
		"CO-01-06",
		"PE-02-01",
		"REL-01-06",
		"IU-03-02"
	], (mix, context) => {
		const barrier = priceBarrier(mix, "a serverless adoption share");
		if (barrier != null) return unmeasured(barrier, "attestation");
		if (mix.totalCost <= 0) return notApplicable("No billable usage was recorded in the window, so there is no spend to assess.");
		if (mix.choiceCost <= 0) return notApplicable(`None of the ${money(mix.totalCost, mix.currency)} billed in the window was on compute with a serverless option — jobs, all-purpose, SQL warehouses or pipelines. The rest of the estate is on products that have no classic form to move away from.`);
		const adopted = share(mix.serverlessChoiceCost, mix.choiceCost);
		const settled = mix.totalCost - mix.choiceCost;
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .8,
				partial: .3
			})),
			evidence: [evidenceFrom(context, MIX, `${money(mix.serverlessChoiceCost, mix.currency)} of ${money(mix.choiceCost, mix.currency)} (${percent(adopted)}) of the spend that has a serverless option is serverless` + (settled > 0 ? `. A further ${money(settled, mix.currency)} is on products with no classic form — serving, Lakebase, Apps, storage — and is not counted either way` : "") + ` (${priceCoverageClause(mix)})`, "Workloads run on serverless compute where the workload suits it")]
		};
	}),
	fromSignal(MIX, ["CO-01-10", "PE-03-08"], (mix, context) => {
		const barrier = priceBarrier(mix, "a Photon adoption share");
		if (barrier != null) return unmeasured(barrier, "attestation");
		if (mix.photonEligibleCost <= 0) return notApplicable("No spend in the window was on compute where Photon is an option.");
		const serverlessShare = share(mix.serverlessChoiceCost, mix.photonEligibleCost) ?? 0;
		if (serverlessShare >= threshold(context.spec, "serverless_credit_share", .95)) return satisfiedByArchitecture(`${percent(serverlessShare)} of the spend where Photon is an option is serverless, and serverless SQL and jobs run the vectorised engine by default, so there is no separate Photon setting to enable.`, [evidenceFrom(context, MIX, `${money(mix.serverlessChoiceCost, mix.currency)} of ${money(mix.photonEligibleCost, mix.currency)} Photon-eligible spend is serverless (${priceCoverageClause(mix)})`)]);
		const adopted = share(mix.photonCost, mix.photonEligibleCost);
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .7,
				partial: .3
			})),
			evidence: [evidenceFrom(context, MIX, `${money(mix.photonCost, mix.currency)} of ${money(mix.photonEligibleCost, mix.currency)} (${percent(adopted)}) of Photon-eligible spend ran on Photon (${priceCoverageClause(mix)})`, "Photon or serverless compute is used for the compute that can benefit from it")]
		};
	}),
	fromSignals([CLUSTERS, WAREHOUSES], ["CO-02-01", "REL-03-01"], (context) => {
		const clusters = valueOf(context, CLUSTERS).filter(isAllPurpose);
		const warehouses = valueOf(context, WAREHOUSES);
		const population = clusters.length + warehouses.length;
		if (population === 0) return satisfiedByArchitecture("There are no classic clusters or SQL warehouses to configure. Serverless compute scales without a capacity setting, so the intent is met by the architecture.");
		return {
			outcome: bandOutcome(share(clusters.filter((c) => c.autoscaling).length + warehouses.filter((w) => w.serverless || w.scalesOut).length, population), bandsOf(context.spec, {
				pass: .8,
				partial: .4
			})),
			evidence: [evidenceFrom(context, CLUSTERS, `${clusters.filter((c) => c.autoscaling).length} of ${clusters.length} all-purpose clusters autoscale`, "Compute scales with demand rather than being fixed at peak size"), evidenceFrom(context, WAREHOUSES, `${warehouses.filter((w) => w.serverless || w.scalesOut).length} of ${warehouses.length} SQL warehouses scale out or are serverless`, "Warehouses scale with concurrency rather than being fixed")]
		};
	}),
	fromSignals([CLUSTERS, WAREHOUSES], ["CO-02-02"], (context) => {
		const clusters = valueOf(context, CLUSTERS).filter(isAllPurpose);
		const warehouses = valueOf(context, WAREHOUSES);
		const population = clusters.length + warehouses.length;
		if (population === 0) return satisfiedByArchitecture("There is no long-running compute to terminate. Serverless compute is released when idle without an auto-termination setting.");
		return {
			outcome: bandOutcome(share(clusters.filter((c) => c.autoTerminates).length + warehouses.filter((w) => w.autoStops).length, population), bandsOf(context.spec, {
				pass: 1,
				partial: .7
			})),
			evidence: [
				evidenceFrom(context, CLUSTERS, `${clusters.filter((c) => c.autoTerminates).length} of ${clusters.length} all-purpose clusters auto-terminate`, "Every all-purpose cluster has an auto-termination window"),
				...offenders(context, CLUSTERS, "Without it", clusters.filter((c) => !c.autoTerminates), asCluster),
				evidenceFrom(context, WAREHOUSES, `${warehouses.filter((w) => w.autoStops).length} of ${warehouses.length} SQL warehouses auto-stop`, "Every SQL warehouse has an auto-stop window"),
				...offenders(context, WAREHOUSES, "Without it", warehouses.filter((w) => !w.autoStops), asWarehouse)
			]
		};
	}),
	fromSignal(CLUSTERS, ["CO-02-03"], (clusters, context) => {
		const population = clusters.filter(isAllPurpose);
		if (population.length === 0) return satisfiedByArchitecture("There are no classic all-purpose clusters in this estate, so there is no cluster configuration for a policy to constrain. Serverless compute has no instance type, node count or runtime for a user to choose wrongly, which is what a compute policy exists to prevent.", [evidenceFrom(context, CLUSTERS, `${clusters.length} cluster records, none of them all-purpose classic compute`)]);
		const governed = population.filter((cluster) => cluster.hasPolicy);
		return {
			outcome: bandOutcome(share(governed.length, population.length), bandsOf(context.spec, {
				pass: .9,
				partial: .5
			})),
			evidence: [evidenceFrom(context, CLUSTERS, `${governed.length} of ${population.length} all-purpose clusters were created under a compute policy`, "All-purpose clusters are created under a policy that bounds size, runtime and cost")]
		};
	}),
	fromSignal(CLUSTERS, ["CO-04-02"], (clusters, context) => {
		const population = clusters.filter((cluster) => cluster.availability != null);
		if (population.length === 0) return notApplicable("No classic compute with a cloud availability setting was found, so there is no on-demand versus spot balance to assess. Serverless compute does not expose this choice.");
		const spot = population.filter((cluster) => /SPOT|PREEMPTIBLE|LOWEST_PRICE/i.test(cluster.availability ?? ""));
		return {
			outcome: bandOutcome(share(spot.length, population.length), bandsOf(context.spec, {
				pass: .5,
				partial: .2
			})),
			evidence: [evidenceFrom(context, CLUSTERS, `${spot.length} of ${population.length} clusters use spot or capacity-excess instances`, "Interruption-tolerant workloads use discounted capacity rather than on-demand throughout")],
			outcomeReason: "Spot capacity suits interruption-tolerant work and not everything qualifies, so a low share may be a deliberate choice rather than an oversight."
		};
	}),
	fromSignal(ATTRIBUTION, ["CO-03-01"], (attribution, context) => {
		const barrier = priceBarrier(attribution, "a tagging share");
		if (barrier != null) return unmeasured(barrier, "attestation");
		if (attribution.listCost <= 0) return notApplicable("No billable usage was recorded in the window, so there is no spend to attribute.");
		const tagged = share(attribution.customTaggedCost, attribution.listCost);
		const identifiable = share(attribution.identifiableCost, attribution.listCost);
		return {
			outcome: bandOutcome(tagged, bandsOf(context.spec, {
				pass: .8,
				partial: .3
			})),
			evidence: [evidenceFrom(context, ATTRIBUTION, `${percent(tagged)} of ${money(attribution.listCost, attribution.currency)} spend carries a custom tag` + (attribution.tagKeys.length > 0 ? ` (${attribution.tagKeys.join(", ")})` : "") + ` (${priceCoverageClause(attribution)})`, "Spend carries tags that attribute it to a team, project or cost centre"), evidenceFrom(context, ATTRIBUTION, `${percent(identifiable)} is attributable to a specific job, cluster, warehouse, pipeline or endpoint`, "Spend can be traced to the resource that incurred it")],
			outcomeReason: identifiable != null && tagged != null && identifiable > tagged ? "Platform-populated resource identifiers cover more spend than customer tags do. Those allow attribution to a resource but not to a team or budget, which is what the tags are for." : void 0
		};
	}),
	fromSignal(SQL_PATHS, ["CO-01-03"], (paths, context) => {
		if (paths.statements === 0) return unmeasured("No SQL ran in the window that this assessment did not run itself, so there is no path to observe. Query history keeps ninety days, so a longer lookback or a workspace with traffic would answer this.", "unreadable");
		if (paths.interactiveStatements === 0) return notApplicable(`All ${paths.statements} statements in the window were submitted by a job or a pipeline, so nobody chose where to run SQL by hand and there is no path of least resistance to assess.`);
		const onWarehouse = share(paths.interactiveWarehouseStatements, paths.interactiveStatements);
		return {
			outcome: bandOutcome(onWarehouse, bandsOf(context.spec, {
				pass: .9,
				partial: .6
			})),
			evidence: [evidenceFrom(context, SQL_PATHS, `${percent(onWarehouse)} of ${paths.interactiveStatements} statements a person submitted ran on a SQL warehouse, and ${paths.interactiveAllPurposeStatements} on an all-purpose cluster`, "Ad-hoc SQL runs on a warehouse rather than on a cluster started to run it"), detailFrom(context, SQL_PATHS, `Across everything that ran: ${paths.warehouseStatements} statements on warehouses, ${paths.allPurposeStatements} on all-purpose clusters and ${paths.jobClusterStatements} on job clusters, which are the right place for the SQL inside a scheduled task`)],
			outcomeReason: paths.unattributedStatements > 0 ? `${paths.unattributedStatements} statements ran on a cluster this metastore no longer records, so they are in neither share above.` : void 0
		};
	}),
	fromSignal(SQL_PATHS, ["PE-03-10"], (paths, context) => {
		if (paths.statements === 0) return unmeasured("No SQL ran in the window that this assessment did not run itself, so nothing was read and there is no cache behaviour to observe.", "unreadable");
		if (paths.fileReadingStatements === 0) return notApplicable(`None of ${paths.statements} statements in the window read a file — they were answered from metadata or from memory — so there was nothing for a cache to hold.`);
		const cached = share(paths.cachedReadBytes, paths.fileReadBytes);
		return {
			outcome: bandOutcome(cached, bandsOf(context.spec, {
				pass: .5,
				partial: .2
			})),
			evidence: [evidenceFrom(context, SQL_PATHS, `${percent(cached)} of the bytes read from files came from cache, across ${paths.fileReadingStatements} statements that read any`, "Repeated reads are served from cache rather than from storage"), detailFrom(context, SQL_PATHS, `${paths.resultCacheHits} statements were answered from the result cache without reading anything, so they are outside the figure above rather than counted as a miss`)],
			outcomeReason: "A cache share is what was cached, not whether anybody chose it: the disk cache is on by default on most compute. A low share on a workload that reads the same data repeatedly is the finding here; whether the effect was ever measured is the part this cannot see."
		};
	}),
	fromSignal(JOBS, ["CO-04-01"], (jobs, context) => {
		if (jobs.length === 0) return notApplicable("There are no jobs in this workspace, so there is no trigger choice to assess.");
		const continuous = jobs.filter((job) => job.continuous === true);
		if (continuous.length === 0) return {
			outcome: "pass",
			evidence: [evidenceFrom(context, JOBS, `None of ${jobs.length} jobs run continuously`, "Streaming work runs on a trigger unless it genuinely needs to be always on")]
		};
		return {
			outcome: (share(continuous.length, jobs.length) ?? 0) <= threshold(context.spec, "max_continuous_share", .25) ? "partial" : "fail",
			evidence: [evidenceFrom(context, JOBS, `${continuous.length} of ${jobs.length} jobs run continuously`, "Streaming work runs on a trigger unless it genuinely needs to be always on"), ...offenders(context, JOBS, "Always on", continuous, asJob)],
			outcomeReason: "Continuous jobs bill for the whole time they are up. Whether that is right depends on the latency the workload needs, which configuration cannot show — confirm each one needs sub-minute freshness."
		};
	})
];
/**
* The leading integer of a runtime string such as `14.3.x-photon-scala2.12`.
*
* Zero when it cannot be read, which makes an unparseable runtime fail the check
* rather than pass it. An unknown runtime version is not evidence of a current one.
*/
function majorVersion(runtime) {
	const match = /^(\d+)/.exec(runtime ?? "");
	return match == null ? 0 : Number(match[1]);
}
function describeOldest(stale, named) {
	const oldest = [...stale].sort((a, b) => majorVersion(a.runtime) - majorVersion(b.runtime))[0];
	if (oldest == null) return "none";
	return `${named(oldest)} on ${oldest.runtime ?? "an unrecorded runtime"}`;
}
//#endregion
export { COST_RESOLVERS };
