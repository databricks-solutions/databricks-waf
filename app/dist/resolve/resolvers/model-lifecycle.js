import { agreeing, evidenceFrom, fromSignal, percent, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/model-lifecycle.ts
const SERVING_ENTITIES = "sql:serving.model_entities";
const RUN_TRACKING = "sql:mlflow.run_tracking";
/**
* The share of the window's runs the app can place on one side or the other.
*
* Untagged runs are excluded from the denominator rather than counted as interactive, because a client
* that does not write `mlflow.source.type` — an older MLflow, or a direct REST call — is unreadable and
* not manual. On the measured estate that is 491 of 5,633, so folding them in would move the automated
* share from 56% to 51% and the sentence reporting it would be wrong by that much.
*/
function sourcedRuns(tracking) {
	return tracking.runs - tracking.runsWithoutASource;
}
const MODEL_LIFECYCLE_RESOLVERS = [
	fromSignal(SERVING_ENTITIES, ["PE-02-02"], (entities, context) => {
		const totals = entities[0];
		if (totals == null || totals.liveEntities === 0) return unmeasured("This account has no models on managed serving endpoints. That is not a finding either way: the platform records managed serving and nothing else, so an empty reading is an estate that serves no models and an estate that serves them from something a team built, and nothing here separates the two. If models are served from your own service, this requirement needs an answer rather than a scan.", "unreadable");
		const withTraffic = entities.filter((entity) => entity.requests > 0);
		const requests = withTraffic.reduce((total, entity) => total + entity.requests, 0);
		const served = agreeing(totals.liveEntities, "model");
		const endpoints = agreeing(totals.liveEndpoints, "managed serving endpoint");
		return {
			outcome: "pass",
			evidence: [evidenceFrom(context, SERVING_ENTITIES, `${served.noun} on ${endpoints.noun}` + (requests > 0 ? `, ${withTraffic.length.toLocaleString("en-US")} of which took ${requests.toLocaleString("en-US")} requests in the window` : ", none of which took a request in the window"), "Models are served by managed serving infrastructure rather than by a service a team maintains")],
			outcomeReason: "A pass on the presence of managed serving, which is what the platform can show. It is not a claim that every production model is on it: a model served from a team’s own service leaves no record here, so this says the managed path is in use rather than that it is the only one."
		};
	}),
	fromSignal(SERVING_ENTITIES, ["OE-02-08"], (entities, context) => {
		const totals = entities[0];
		if (totals == null || totals.customModels === 0) return unmeasured("No custom models are served on managed endpoints in this account, so there is nothing whose reference this can read. Foundation and external models are resolved by the platform and have no registry entry of their own, so their presence is not evidence either way.", "unreadable");
		const versioned = totals.customModelsWithAVersion;
		const unversioned = totals.customModels - versioned;
		const share = versioned / totals.customModels;
		const models = agreeing(totals.customModels, "served custom model");
		const inUc = totals.customModelsNamedInUc;
		const evidence = [evidenceFrom(context, SERVING_ENTITIES, `${versioned.toLocaleString("en-US")} of ${models.noun} carry a model version (${percent(share)}); ${inUc.toLocaleString("en-US")} are named in Unity Catalog and ${(totals.customModels - inUc).toLocaleString("en-US")} in the workspace model registry`, "Every served custom model resolves to a registered model at a stated version")];
		if (unversioned === 0) return {
			outcome: "pass",
			evidence,
			outcomeReason: "Every served custom model names a version, so each endpoint resolves to a fixed entry in a registry rather than to whatever is currently at a path. Which stage that version sits in, and whether it was promoted deliberately, is not recorded on the serving row."
		};
		const offending = agreeing(unversioned, "served custom model");
		return {
			outcome: "fail",
			evidence,
			outcomeReason: `${offending.noun} ${offending.verb} no version recorded, so what each one serves is whatever the name currently resolves to. A model changed underneath an endpoint referenced that way changes what the endpoint answers, with nothing in the endpoint’s own configuration to say it moved.`
		};
	}),
	fromSignal(RUN_TRACKING, ["OE-02-09"], (tracking, context) => {
		if (tracking.runs === 0) return unmeasured(tracking.liveExperiments > 0 ? `This account holds ${tracking.liveExperiments.toLocaleString("en-US")} MLflow experiments and none of them recorded a run in the window, so there is no training activity here to read. Whether training happens outside MLflow is not something the platform records.` : "This account has no MLflow experiments and no runs, so no training is tracked in MLflow. That is not a finding on its own: training that happens outside MLflow entirely leaves no record here, and nothing the platform exposes distinguishes that from an estate that trains no models.", "unreadable");
		const sourced = sourcedRuns(tracking);
		const automated = tracking.runsFromAJob + tracking.runsFromAProject;
		const share = sourced > 0 ? automated / sourced : void 0;
		const untagged = tracking.runsWithoutASource;
		const evidence = [evidenceFrom(context, RUN_TRACKING, `${tracking.runs.toLocaleString("en-US")} MLflow runs across ${tracking.experimentsWithRuns.toLocaleString("en-US")} experiments in the window: ${automated.toLocaleString("en-US")} started by a job or an MLflow project, ${tracking.runsFromANotebook.toLocaleString("en-US")} from a notebook, ${tracking.runsFromElsewhere.toLocaleString("en-US")} from elsewhere` + (untagged > 0 ? `, and ${untagged.toLocaleString("en-US")} with no source recorded` : ""), "At least some training runs are started and tracked by automation rather than by hand")];
		if (automated === 0) return {
			outcome: "fail",
			evidence,
			outcomeReason: "Every run the platform recorded a source for was started by a person — from a notebook or from a machine elsewhere — so nothing in the window traces a model to a run something else produced on a schedule. A run started by hand is still tracked; what is missing is the automation that would make the tracking happen without somebody remembering."
		};
		return {
			outcome: "pass",
			evidence,
			outcomeReason: `Some training runs are started by jobs, so automated tracking exists in this account. The share is reported rather than judged: ${percent(share)} of the runs whose source the platform recorded came from a job, and an estate developing models in notebooks is the ordinary shape rather than a gap.` + (untagged > 0 ? ` ${untagged.toLocaleString("en-US")} runs carried no source at all and are left out of that share rather than counted as manual.` : "")
		};
	})
];
//#endregion
export { MODEL_LIFECYCLE_RESOLVERS };
