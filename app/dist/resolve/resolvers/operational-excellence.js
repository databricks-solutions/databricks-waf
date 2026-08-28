import { share } from "../../collect/sql/rows.js";
import { fromBundle, hasRun, isAllPurpose } from "../../collect/sql/shapes.js";
import { asCluster, asJob } from "../locate.js";
import { bandOutcome, bandsOf, enrichedBy, evidenceFrom, fromSignal, fromSignals, notApplicable, observedValue, offenders, percent, satisfiedByArchitecture, sourcedFrom, triggerRecorded, unmeasured, valueOf } from "./helpers.js";
import { VISIBILITY_CROSS_CHECK, unestablishedEmptiness } from "./visibility.js";
//#region server/resolve/resolvers/operational-excellence.ts
const CENSUS = "sql:uc.census";
const CLUSTERS = "sql:compute.clusters";
const JOBS = "sql:jobs.inventory";
const PIPELINES = "sql:pipelines.inventory";
/**
* OE-02-03: Unity Catalog managed tables.
*
* Managed over managed-plus-external, with views excluded from both. A view has no storage
* to manage, so counting views in the denominator would make a well-documented estate of
* mostly views look like it had chosen external storage everywhere.
*
* External tables are a legitimate choice — data already in a lake someone else writes to
* cannot be managed — so a low share is reported as a finding with that caveat attached
* rather than as a straightforward failure.
*/
const managedTables = enrichedBy([VISIBILITY_CROSS_CHECK], fromSignal(CENSUS, ["OE-02-03"], (census, context) => {
	const storage = census.managedTables + census.externalTables;
	if (storage === 0) return (census.tableCount === 0 ? unestablishedEmptiness(context) : void 0) ?? notApplicable(census.tableCount === 0 ? "This metastore contains no tables, so there is no storage to manage." : `All ${census.tableCount} catalogued objects are views, which have no storage of their own to manage.`);
	const managed = share(census.managedTables, storage);
	return {
		outcome: bandOutcome(managed, bandsOf(context.spec, {
			pass: .8,
			partial: .4
		})),
		evidence: [evidenceFrom(context, CENSUS, `${census.managedTables} of ${storage} tables are managed by Unity Catalog, ${census.externalTables} are external (${percent(managed)} managed)`, "Tables are managed by Unity Catalog, so layout, statistics and cleanup are the platform’s job")],
		outcomeReason: "Managed tables get predictive optimization, automatic file compaction and vacuuming without anyone scheduling them. External tables are sometimes unavoidable — data written by a system outside this account cannot be managed — so treat the external share as a question to answer rather than a defect."
	};
}));
/**
* OE-02-04: scheduled and triggered jobs.
*
* A job with no schedule and no trigger runs when a person presses the button, which is the
* thing this control exists to find. `paused` counts against the schedule: a paused
* schedule fires nothing, so crediting it would pass an estate whose automation is
* switched off.
*/
const automatedJobs = fromSignal(JOBS, ["OE-02-04"], (jobs, context) => {
	if (jobs.length === 0) return notApplicable("No jobs were found in the assessed workspaces, so there is no orchestration to automate. Work running only in interactive notebooks would not appear here.");
	const decidable = jobs.filter((job) => triggerRecorded(job));
	const unknown = jobs.length - decidable.length;
	const undecided = `${unknown.toLocaleString("en-US")} job${unknown === 1 ? "" : "s"}`;
	if (decidable.length === 0) return unmeasured(`${jobs.length.toLocaleString("en-US")} job${jobs.length === 1 ? "" : "s"} found, and no trigger recorded against any of them. A definition edited before the system table began recording triggers reads the same way as one nobody scheduled, and nothing here separates the two, so whether these run on a schedule is unknown rather than manual.`, "attestation");
	const automated = decidable.filter((job) => triggered(job));
	const adopted = share(automated.length, decidable.length);
	const manual = decidable.filter((job) => !triggered(job));
	const bands = bandsOf(context.spec, {
		pass: .9,
		partial: .6
	});
	const ifAllManual = bandOutcome(share(automated.length, jobs.length), bands);
	const outcome = bandOutcome(adopted, bands);
	if (outcome !== ifAllManual) return unmeasured(`${automated.length.toLocaleString("en-US")} of ${decidable.length.toLocaleString("en-US")} jobs whose trigger this table records are started by the platform (${percent(adopted)}), and ${undecided} ${unknown === 1 ? "has" : "have"} no trigger recorded — either nobody scheduled them or their definitions predate the column. Counting those as manual puts the share at ${percent(share(automated.length, jobs.length))}, which scores differently, so the reading does not settle this either way.`, "attestation");
	return {
		outcome,
		evidence: [evidenceFrom(context, JOBS, `${automated.length} of ${decidable.length} jobs whose trigger this table records run on a schedule, a trigger or continuously (${percent(adopted)})` + (unknown > 0 ? `; ${undecided} ${unknown === 1 ? "has" : "have"} no trigger recorded and ${unknown === 1 ? "is" : "are"} left out of the share, which counting them as manual would not change` : ""), "Jobs are started by the platform rather than by a person pressing run"), ...offenders(context, JOBS, "Started manually", manual, asJob)],
		...jobs.some((job) => job.paused === true) ? { outcomeReason: "A paused schedule is counted as unautomated, because it fires nothing until someone un-pauses it. Some of these will be jobs deliberately parked rather than jobs nobody finished." } : {}
	};
});
function triggered(job) {
	if (job.paused === true) return false;
	return job.scheduled || job.continuous === true || (job.triggerType ?? "") !== "";
}
const OPERATIONAL_EXCELLENCE_RESOLVERS = [
	managedTables,
	automatedJobs,
	sourcedFrom([JOBS], fromSignal(PIPELINES, ["OE-02-06", "OE-02-11"], (pipelines, context) => {
		const jobs = observedValue(context, JOBS) ?? [];
		if (pipelines.length === 0 && jobs.length === 0) return notApplicable("No jobs or pipelines were found in the assessed workspaces, so there is no data engineering workload to have chosen a framework for.");
		if (pipelines.length === 0) return {
			outcome: "fail",
			evidence: [evidenceFrom(context, PIPELINES, `No declarative pipelines, against ${jobs.length} job${jobs.length === 1 ? "" : "s"}`, "Data transformation runs in a declarative pipeline rather than hand-orchestrated notebooks")],
			outcomeReason: "All orchestration here is jobs. That is not wrong for every workload — a job calling a stored procedure is not a pipeline waiting to happen — but the retries, schema evolution and data quality expectations a declarative pipeline provides are being hand-written or skipped."
		};
		const running = pipelines.filter(hasRun);
		const production = pipelines.filter((pipeline) => !pipeline.development);
		const adopted = share(pipelines.length, pipelines.length + jobs.length);
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .5,
				partial: .15
			})),
			evidence: [evidenceFrom(context, PIPELINES, `${pipelines.length} declarative pipeline${pipelines.length === 1 ? "" : "s"} against ${jobs.length} job${jobs.length === 1 ? "" : "s"} (${percent(adopted)} of orchestration)`, "Data transformation runs in a declarative pipeline rather than hand-orchestrated notebooks"), evidenceFrom(context, PIPELINES, `${production.length} in production mode, ${running.length} updated in the window`, "Pipelines are in production mode, where failed updates retry and clusters are not reused")],
			outcomeReason: "A job that exists only to start a pipeline is counted on the job side of this ratio, so an estate that triggers its pipelines from jobs scores lower here than its architecture deserves. The jobs inventory does not record which jobs call a pipeline." + (production.length < pipelines.length ? ` ${pipelines.length - production.length} pipeline${pipelines.length - production.length === 1 ? " is" : "s are"} still in development mode, which reuses the cluster and does not retry failed updates.` : "")
		};
	})),
	sourcedFrom([PIPELINES], fromSignal(JOBS, [
		"OE-01-02",
		"OE-02-01",
		"IU-01-05"
	], (jobs, context) => {
		if (jobs.length === 0) return notApplicable("No jobs were found in the assessed workspaces, so there is no deployed workload whose provenance could be read.");
		const bundled = jobs.filter(fromBundle);
		const adopted = share(bundled.length, jobs.length);
		if (bundled.length === 0) return unmeasured(`None of the ${jobs.length} jobs here carry a deployment marker, which does not mean they were built by hand. Databricks records \`deployment.kind = BUNDLE\` for jobs deployed by an asset bundle, but the Terraform provider writes jobs through the same API a person uses and leaves no marker at all. So this reads as no evidence either way rather than as a failure — an estate managed entirely in Terraform looks exactly like this. Answer the attestation to record which it is.`, "attestation");
		return {
			outcome: "partial",
			evidence: [evidenceFrom(context, JOBS, `${bundled.length} of ${jobs.length} jobs were deployed by an asset bundle (${percent(adopted)})`, "Workloads are deployed from version-controlled definitions rather than edited in the workspace")],
			outcomeReason: "Asset bundles are in use, so a deployment pipeline exists. This caps at partial rather than passing because the remaining jobs cannot be told apart: Terraform-managed jobs carry no marker, so the unmarked ones are either Terraform-managed or hand-built and this signal cannot say which."
		};
	})),
	fromSignal(CLUSTERS, ["OE-02-02", "IU-03-03"], (clusters, context) => {
		const population = clusters.filter(isAllPurpose);
		if (population.length === 0) return satisfiedByArchitecture("There are no classic all-purpose clusters in this estate, so there is no compute configuration to standardise. Serverless compute exposes no instance type, node count or runtime for a user to choose, which is what a template exists to settle.", [evidenceFrom(context, CLUSTERS, `${clusters.length} cluster records, none of them all-purpose classic compute`)]);
		const governed = population.filter((cluster) => cluster.hasPolicy);
		const adopted = share(governed.length, population.length);
		const free = population.filter((cluster) => !cluster.hasPolicy);
		return {
			outcome: bandOutcome(adopted, bandsOf(context.spec, {
				pass: .9,
				partial: .5
			})),
			evidence: [evidenceFrom(context, CLUSTERS, `${governed.length} of ${population.length} all-purpose clusters were created from a policy (${percent(adopted)})`, "Compute is created from a template, so configuration is a decision made once rather than per cluster"), ...offenders(context, CLUSTERS, "Configured freehand", free, asCluster)]
		};
	}),
	enrichedBy([VISIBILITY_CROSS_CHECK], fromSignal(CENSUS, ["OE-01-06"], (census, context) => {
		if (census.tableCount === 0) return unestablishedEmptiness(context) ?? notApplicable("This metastore contains no tables, so there is no asset estate to organise yet.");
		const perCatalog = census.tableCount / Math.max(census.catalogCount, 1);
		if (census.catalogCount <= 1) return {
			outcome: "fail",
			evidence: [evidenceFrom(context, CENSUS, `All ${census.tableCount} tables are in a single catalog`, "Assets are organised across catalogs along a deliberate boundary — environment, domain or team")],
			outcomeReason: "One catalog for the whole estate is the shape an estate takes when no boundary was chosen. It means environment separation, per-domain ownership and catalog-level access grants all have to be done at the schema level or not at all."
		};
		return {
			outcome: "partial",
			evidence: [evidenceFrom(context, CENSUS, `${census.tableCount} tables across ${census.catalogCount} catalogs and ${census.schemaCount} schemas, averaging ${Math.round(perCatalog)} tables per catalog, with ${census.distinctOwners} distinct owner${census.distinctOwners === 1 ? "" : "s"}`, "Assets are organised across catalogs along a deliberate boundary — environment, domain or team")],
			outcomeReason: "The estate is spread across catalogs rather than piled into one, which is the observable half of a catalog strategy. Whether the boundary is environment, domain or team — and whether it is the one you intended — is not readable from the metastore, so this caps at partial and the attestation records which it is."
		};
	})),
	fromSignals([JOBS], [
		"OE-04-01",
		"OE-04-02",
		"PE-05-04"
	], (context) => {
		const jobs = valueOf(context, JOBS);
		if (jobs.length === 0) return notApplicable("No jobs were found in the assessed workspaces, so there is no workload whose failure anyone would need to be told about.");
		const known = jobs.filter((job) => job.healthRulesKnown);
		if (known.length === 0) return unmeasured(`None of the ${jobs.length} job definitions here record their health rules. That column is only written for rows changed since early December 2025, so this means the definitions are older than the column rather than that the jobs are unmonitored. Editing a job populates it.`, "attestation");
		const monitored = known.filter((job) => job.healthRuleCount > 0);
		const covered = share(monitored.length, known.length);
		const unwatched = known.filter((job) => job.healthRuleCount === 0);
		return {
			outcome: bandOutcome(covered, bandsOf(context.spec, {
				pass: .8,
				partial: .3
			})),
			evidence: [evidenceFrom(context, JOBS, `${monitored.length} of ${known.length} jobs carry a health rule (${percent(covered)})` + (known.length < jobs.length ? `; ${jobs.length - known.length} job definitions predate the column` : ""), "Jobs declare a health rule, so a failure or an overrun notifies someone rather than sitting unseen"), ...offenders(context, JOBS, "No health rule", unwatched, asJob)],
			outcomeReason: "Health rules are what the platform can see of monitoring. A team watching these jobs through Datadog or PagerDuty off the back of the audit logs would look unmonitored here, which is why the attestation for this control asks which external tooling is in play."
		};
	})
];
//#endregion
export { OPERATIONAL_EXCELLENCE_RESOLVERS };
