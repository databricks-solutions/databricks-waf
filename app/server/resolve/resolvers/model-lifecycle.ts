// The three model-lifecycle requirements, turned from questions into readings by row 37g.
//
// All three were `attestation` with the verdict `owed-a-measure` against them, and all three read
// system tables that were already there. What follows is what each one can actually conclude, which
// is less than the audit's note implied in two of the three cases.
//
// ## The shape they share, and why two of them stop short of a verdict
//
// `PE-02-02` asks whether production models are served by managed infrastructure. The table records
// managed serving and only managed serving. So endpoints under traffic prove the managed path is in
// use, and their *absence* proves nothing at all: it is equally an estate that serves models from a
// hand-built service and an estate that serves no models. Reporting the empty case as a fail would be
// a claim about a system the app cannot see, and reporting it as a pass would be worse.
//
// `OE-02-09` has the same asymmetry one layer down. A run tagged `JOB` was started by something
// scheduled; a run tagged `NOTEBOOK` was started by a person, and an estate whose runs are mostly
// notebooks is the ordinary shape of model development rather than a failure of automation. So the
// reading is whether automated tracking exists at all and what share of the window it accounts for,
// and the pass is on existence rather than on the share.
//
// `OE-02-08` is the one that resolves cleanly, because the field it needs is on the row it needs it
// on: a served custom model either carries an `entity_version` or does not.
//
// ## What was measured, and where the reading came from
//
// `large-estate` on 2026-08-16, which is the only estate of the two with a population here. 3,965 live
// served entities across 13,873 endpoints, 3,145 of them custom models; every custom model carried a
// version, 3,011 of them named in Unity Catalog and 134 in the workspace registry. 775,193 requests
// over thirty days reached 161 of those entities, so 96% of the population is idle — which is why
// traffic is reported beside the count rather than used to filter it. MLflow over the same window:
// 5,633 runs, 2,861 from a job, 1,348 from a notebook, 933 from elsewhere and 491 with no source
// recorded at all.
//
// labs has both schemas and neither population, which is exactly the case the unmeasured branch below
// is written for — see `docs/estates.md` on what an empty reading there is and is not evidence of.

import type { ControlResolver } from '../resolver.js';
import type { MlflowRunTracking, ServingModelEntity } from '../../collect/sql/shapes.js';
import { agreeing, evidenceFrom, fromSignal, percent, unmeasured } from './helpers.js';

const SERVING_ENTITIES = 'sql:serving.model_entities';
const RUN_TRACKING = 'sql:mlflow.run_tracking';

/**
 * The share of the window's runs the app can place on one side or the other.
 *
 * Untagged runs are excluded from the denominator rather than counted as interactive, because a client
 * that does not write `mlflow.source.type` — an older MLflow, or a direct REST call — is unreadable and
 * not manual. On the measured estate that is 491 of 5,633, so folding them in would move the automated
 * share from 56% to 51% and the sentence reporting it would be wrong by that much.
 */
function sourcedRuns(tracking: MlflowRunTracking): number {
  return tracking.runs - tracking.runsWithoutASource;
}

/**
 * PE-02-02: production models served by managed serving infrastructure.
 *
 * A positive check, and one whose negative case is unreadable rather than failing. See the header.
 */
const managedServing = fromSignal<readonly ServingModelEntity[]>(
  SERVING_ENTITIES,
  ['PE-02-02'],
  (entities, context) => {
    const totals = entities[0];
    if (totals == null || totals.liveEntities === 0) {
      return unmeasured(
        'This account has no models on managed serving endpoints. That is not a finding either way: the ' +
          'platform records managed serving and nothing else, so an empty reading is an estate that serves ' +
          'no models and an estate that serves them from something a team built, and nothing here separates ' +
          'the two. If models are served from your own service, this requirement needs an answer rather ' +
          'than a scan.',
        // Not `unreachable`: the thing that cannot be seen is outside the platform rather than behind a
        // grant this install lacks, so pointing an admin at a permission would send them nowhere.
        'unreadable'
      );
    }

    const withTraffic = entities.filter((entity) => entity.requests > 0);
    const requests = withTraffic.reduce((total, entity) => total + entity.requests, 0);
    const served = agreeing(totals.liveEntities, 'model');
    const endpoints = agreeing(totals.liveEndpoints, 'managed serving endpoint');

    return {
      outcome: 'pass',
      evidence: [
        evidenceFrom(
          context,
          SERVING_ENTITIES,
          `${served.noun} on ${endpoints.noun}` +
            (requests > 0
              ? `, ${withTraffic.length.toLocaleString('en-US')} of which took ` +
                `${requests.toLocaleString('en-US')} requests in the window`
              : ', none of which took a request in the window'),
          'Models are served by managed serving infrastructure rather than by a service a team maintains'
        ),
      ],
      // The scope of the pass, stated rather than implied. The requirement is about production models,
      // and nothing on the row says which of these is production — see ADR 0074's rule applied to a
      // population defined by the choice being assessed.
      outcomeReason:
        'A pass on the presence of managed serving, which is what the platform can show. It is not a claim ' +
        'that every production model is on it: a model served from a team’s own service leaves no record ' +
        'here, so this says the managed path is in use rather than that it is the only one.',
    };
  }
);

/**
 * OE-02-08: served models resolved through a registry with a version.
 *
 * Custom models only. A foundation or external model has no registry entry to reference, so counting
 * one either way would answer a question nobody asked — and on the measured estate that is 794 of the
 * 3,965 live entities, enough to move a share by twenty points if they were folded in.
 */
const modelRegistry = fromSignal<readonly ServingModelEntity[]>(
  SERVING_ENTITIES,
  ['OE-02-08'],
  (entities, context) => {
    const totals = entities[0];
    if (totals == null || totals.customModels === 0) {
      return unmeasured(
        'No custom models are served on managed endpoints in this account, so there is nothing whose ' +
          'reference this can read. Foundation and external models are resolved by the platform and have no ' +
          'registry entry of their own, so their presence is not evidence either way.',
        'unreadable'
      );
    }

    const versioned = totals.customModelsWithAVersion;
    const unversioned = totals.customModels - versioned;
    const share = versioned / totals.customModels;
    const models = agreeing(totals.customModels, 'served custom model');
    const inUc = totals.customModelsNamedInUc;

    const evidence = [
      evidenceFrom(
        context,
        SERVING_ENTITIES,
        `${versioned.toLocaleString('en-US')} of ${models.noun} carry a model version (${percent(share)})` +
          `; ${inUc.toLocaleString('en-US')} are named in Unity Catalog and ` +
          `${(totals.customModels - inUc).toLocaleString('en-US')} in the workspace model registry`,
        'Every served custom model resolves to a registered model at a stated version'
      ),
    ];

    if (unversioned === 0) {
      return {
        outcome: 'pass',
        evidence,
        // What a version does and does not establish. It says the endpoint names a registry entry at a
        // point in its history; it says nothing about stages, approvals or what produced the version.
        outcomeReason:
          'Every served custom model names a version, so each endpoint resolves to a fixed entry in a ' +
          'registry rather than to whatever is currently at a path. Which stage that version sits in, and ' +
          'whether it was promoted deliberately, is not recorded on the serving row.',
      };
    }

    const offending = agreeing(unversioned, 'served custom model');
    return {
      outcome: 'fail',
      evidence,
      outcomeReason:
        `${offending.noun} ${offending.verb} no version recorded, so what each one serves is whatever the ` +
        'name currently resolves to. A model changed underneath an endpoint referenced that way changes ' +
        'what the endpoint answers, with nothing in the endpoint’s own configuration to say it moved.',
    };
  }
);

/**
 * OE-02-09: training runs tracked automatically.
 *
 * A pass on existence, with the share reported beside it rather than gating it. See the header for why
 * a notebook-heavy estate is not a failing one.
 */
const automatedTracking = fromSignal<MlflowRunTracking>(RUN_TRACKING, ['OE-02-09'], (tracking, context) => {
  if (tracking.runs === 0) {
    return unmeasured(
      tracking.liveExperiments > 0
        ? `This account holds ${tracking.liveExperiments.toLocaleString('en-US')} MLflow experiments and none ` +
            'of them recorded a run in the window, so there is no training activity here to read. Whether ' +
            'training happens outside MLflow is not something the platform records.'
        : 'This account has no MLflow experiments and no runs, so no training is tracked in MLflow. That is ' +
          'not a finding on its own: training that happens outside MLflow entirely leaves no record here, ' +
          'and nothing the platform exposes distinguishes that from an estate that trains no models.',
      'unreadable'
    );
  }

  const sourced = sourcedRuns(tracking);
  const automated = tracking.runsFromAJob + tracking.runsFromAProject;
  const share = sourced > 0 ? automated / sourced : undefined;
  const untagged = tracking.runsWithoutASource;

  const evidence = [
    evidenceFrom(
      context,
      RUN_TRACKING,
      `${tracking.runs.toLocaleString('en-US')} MLflow runs across ` +
        `${tracking.experimentsWithRuns.toLocaleString('en-US')} experiments in the window: ` +
        `${automated.toLocaleString('en-US')} started by a job or an MLflow project, ` +
        `${tracking.runsFromANotebook.toLocaleString('en-US')} from a notebook, ` +
        `${tracking.runsFromElsewhere.toLocaleString('en-US')} from elsewhere` +
        (untagged > 0 ? `, and ${untagged.toLocaleString('en-US')} with no source recorded` : ''),
      'At least some training runs are started and tracked by automation rather than by hand'
    ),
  ];

  if (automated === 0) {
    return {
      outcome: 'fail',
      evidence,
      outcomeReason:
        'Every run the platform recorded a source for was started by a person — from a notebook or from a ' +
        'machine elsewhere — so nothing in the window traces a model to a run something else produced on a ' +
        'schedule. A run started by hand is still tracked; what is missing is the automation that would make ' +
        'the tracking happen without somebody remembering.',
    };
  }

  return {
    outcome: 'pass',
    evidence,
    outcomeReason:
      'Some training runs are started by jobs, so automated tracking exists in this account. The share is ' +
      `reported rather than judged: ${percent(share)} of the runs whose source the platform recorded came ` +
      'from a job, and an estate developing models in notebooks is the ordinary shape rather than a gap.' +
      (untagged > 0
        ? ` ${untagged.toLocaleString('en-US')} runs carried no source at all and are left out of that ` +
          'share rather than counted as manual.'
        : ''),
  };
});

export const MODEL_LIFECYCLE_RESOLVERS: readonly ControlResolver[] = [
  managedServing,
  modelRegistry,
  automatedTracking,
];
