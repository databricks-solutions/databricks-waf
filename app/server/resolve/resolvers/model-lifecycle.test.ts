// The three model-lifecycle readings, and mostly what they must refuse to conclude.
//
// Two of the three have an asymmetric population: the table records managed serving and MLflow runs,
// and an estate with neither is an estate that does the thing elsewhere as readily as one that does not
// do it at all. Half of what is below is negative — that an empty reading never becomes a fail, that a
// pass never widens into a claim about production, and that a notebook-heavy estate is not scored down
// for being one.
//
// The other half is arithmetic that would be easy to get wrong in a direction nobody would notice:
// foundation models excluded from the registry denominator, untagged runs excluded from the automated
// share. Both were measured large enough on `large-estate` to move a percentage by tens of points.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { MlflowRunTracking, ServingModelEntity } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const SERVING_ENTITIES = 'sql:serving.model_entities' as SignalId;
const RUN_TRACKING = 'sql:mlflow.run_tracking' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function findingFor(controlId: string, signal: SignalId, value: unknown) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const signals = new Map<SignalId, SignalResult>([[signal, observed(signal, value, 1, { mode: 'complete' })]]);
  return resolveControl(spec, signals, registry.get(controlId));
}

/** The estate-wide counts, which the statement cross-joins onto every row identically. */
interface Totals {
  readonly liveEntities: number;
  readonly liveEndpoints: number;
  readonly customModels: number;
  readonly foundationModels: number;
  readonly externalModels: number;
  readonly featureSpecs: number;
  readonly customModelsWithAVersion: number;
  readonly customModelsNamedInUc: number;
}

function entity(
  name: string,
  totals: Totals,
  over: Partial<ServingModelEntity> = {}
): ServingModelEntity {
  return {
    workspaceId: '1',
    servedEntityId: `id-${name}`,
    endpointId: `endpoint-${name}`,
    endpointName: name,
    servedEntityName: name,
    entityType: 'CUSTOM_MODEL',
    entityName: `prod.models.${name}`,
    entityVersion: '3',
    requests: 0,
    daysWithTraffic: 0,
    failedRequests: 0,
    requestsWithoutStatus: 0,
    ...totals,
    ...over,
  };
}

const ONE_VERSIONED: Totals = {
  liveEntities: 1,
  liveEndpoints: 1,
  customModels: 1,
  foundationModels: 0,
  externalModels: 0,
  featureSpecs: 0,
  customModelsWithAVersion: 1,
  customModelsNamedInUc: 1,
};

const EMPTY: Totals = {
  liveEntities: 0,
  liveEndpoints: 0,
  customModels: 0,
  foundationModels: 0,
  externalModels: 0,
  featureSpecs: 0,
  customModelsWithAVersion: 0,
  customModelsNamedInUc: 0,
};

function tracking(over: Partial<MlflowRunTracking> = {}): MlflowRunTracking {
  return {
    runs: 0,
    experimentsWithRuns: 0,
    runsFromAJob: 0,
    experimentsWithAJobRun: 0,
    runsFromANotebook: 0,
    runsFromElsewhere: 0,
    runsFromAProject: 0,
    runsWithoutASource: 0,
    runsThatFinished: 0,
    experiments: 0,
    liveExperiments: 0,
    ...over,
  };
}

describe('PE-02-02, models served by managed serving', () => {
  it('passes an estate serving models on managed endpoints, and says how much traffic reached them', () => {
    const finding = findingFor('PE-02-02', SERVING_ENTITIES, [
      entity('fraud', ONE_VERSIONED, { requests: 4_000, daysWithTraffic: 12 }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('4,000 requests');
  });

  it('keeps an idle endpoint in the reading rather than reporting nothing', () => {
    // An endpoint that exists and is idle is a different finding from an endpoint that is absent, and
    // 96% of the measured estate's entities took no request in thirty days. A resolver that filtered
    // on traffic would report that estate as having no managed serving at all.
    const finding = findingFor('PE-02-02', SERVING_ENTITIES, [entity('idle', ONE_VERSIONED)]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('none of which took a request');
  });

  it('does not fail an estate with no managed serving, because the alternative is invisible', () => {
    // The whole shape of this control. `served_entities` records managed serving; a model served from
    // a team's own Flask app leaves no row, and that arrangement is what the requirement is about.
    const finding = findingFor('PE-02-02', SERVING_ENTITIES, []);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('not a finding either way');
  });

  it('does not claim every production model is on managed serving', () => {
    const finding = findingFor('PE-02-02', SERVING_ENTITIES, [entity('one', ONE_VERSIONED)]);

    // Asserted as the disclaimer being present rather than the phrase being absent: the phrase appears
    // inside the disclaimer, so a bare negative match on it fails on the sentence that gets this right.
    expect(finding.outcomeReason).toContain('not a claim that every production model is on it');
    expect(finding.outcomeReason).toContain('leaves no record here');
  });
});

describe('OE-02-08, served models resolved through a registry', () => {
  it('passes where every served custom model carries a version', () => {
    const finding = findingFor('OE-02-08', SERVING_ENTITIES, [entity('fraud', ONE_VERSIONED)]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('(100%)');
  });

  it('fails where a served custom model names no version, and says what that costs', () => {
    const totals: Totals = { ...ONE_VERSIONED, customModels: 2, liveEntities: 2, customModelsNamedInUc: 2 };
    const finding = findingFor('OE-02-08', SERVING_ENTITIES, [
      entity('pinned', totals),
      entity('floating', totals, { entityVersion: undefined }),
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('1 served custom model has no version');
  });

  it('leaves foundation and external models out of the denominator', () => {
    // They have no registry entry to reference — the platform resolves them itself — so counting one
    // either way answers a question nobody asked. On the measured estate that is 794 of 3,965 entities,
    // which folded in would drop a 100% reading to 79%.
    const totals: Totals = {
      liveEntities: 5,
      liveEndpoints: 5,
      customModels: 1,
      foundationModels: 3,
      externalModels: 1,
      featureSpecs: 0,
      customModelsWithAVersion: 1,
      customModelsNamedInUc: 1,
    };
    const finding = findingFor('OE-02-08', SERVING_ENTITIES, [entity('fraud', totals)]);

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('1 of 1 served custom model');
  });

  it('reads nothing from an estate serving only foundation models', () => {
    const totals: Totals = { ...EMPTY, liveEntities: 2, liveEndpoints: 1, foundationModels: 2 };
    const finding = findingFor('OE-02-08', SERVING_ENTITIES, [
      entity('llama', totals, { entityType: 'FOUNDATION_MODEL', entityVersion: undefined }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('no registry entry of their own');
  });

  it('does not claim a version means the model was promoted deliberately', () => {
    // A version says the endpoint names a fixed registry entry. Stage, approval and what produced the
    // version are not on the serving row, and the pass must not read as though they were.
    const finding = findingFor('OE-02-08', SERVING_ENTITIES, [entity('one', ONE_VERSIONED)]);

    expect(finding.outcomeReason).toContain('is not recorded on the serving row');
    expect(finding.outcomeReason).not.toMatch(/approved|governed lifecycle/i);
  });
});

describe('OE-02-09, automated experiment tracking', () => {
  it('passes where some runs were started by a job', () => {
    const finding = findingFor(
      'OE-02-09',
      RUN_TRACKING,
      tracking({ runs: 100, runsFromAJob: 40, runsFromANotebook: 60, experimentsWithRuns: 12 })
    );

    expect(finding.outcome).toBe('pass');
    expect(finding.outcomeReason).toContain('40%');
  });

  it('does not score a notebook-heavy estate down for being one', () => {
    // Developing models in notebooks is the ordinary shape. The share is reported, not judged, and a
    // resolver that graded on it would fail nearly every estate that trains models at all.
    const finding = findingFor(
      'OE-02-09',
      RUN_TRACKING,
      tracking({ runs: 1_000, runsFromAJob: 10, runsFromANotebook: 990, experimentsWithRuns: 40 })
    );

    expect(finding.outcome).toBe('pass');
    expect(finding.outcomeReason).toContain('ordinary shape');
  });

  it('fails where every run the platform sourced was started by a person', () => {
    const finding = findingFor(
      'OE-02-09',
      RUN_TRACKING,
      tracking({ runs: 50, runsFromANotebook: 30, runsFromElsewhere: 20, experimentsWithRuns: 4 })
    );

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('started by a person');
  });

  it('counts an MLflow project as automated, since it is not a person at a notebook', () => {
    const finding = findingFor(
      'OE-02-09',
      RUN_TRACKING,
      tracking({ runs: 10, runsFromAProject: 4, runsFromANotebook: 6, experimentsWithRuns: 2 })
    );

    expect(finding.outcome).toBe('pass');
  });

  it('leaves untagged runs out of the share rather than counting them as manual', () => {
    // 491 of 5,633 on the measured estate. Folded in as manual they move the automated share from 56%
    // to 51%, and the sentence reporting it is wrong by that much.
    const finding = findingFor(
      'OE-02-09',
      RUN_TRACKING,
      tracking({ runs: 100, runsFromAJob: 50, runsFromANotebook: 30, runsWithoutASource: 20, experimentsWithRuns: 5 })
    );

    // 50 of the 80 sourced, not 50 of 100.
    expect(finding.outcomeReason).toContain('62.5%');
    expect(finding.outcomeReason).toContain('20 runs carried no source at all');
  });

  it('does not conclude anything from an estate with no runs in the window', () => {
    const finding = findingFor('OE-02-09', RUN_TRACKING, tracking({ experiments: 40, liveExperiments: 40 }));

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('40 MLflow experiments');
  });

  it('does not read an estate with no MLflow at all as a failure to automate', () => {
    // Training outside MLflow leaves no record here, and nothing distinguishes that from an estate
    // that trains no models. Neither is a verdict on automation.
    const finding = findingFor('OE-02-09', RUN_TRACKING, tracking());

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('leaves no record here');
  });
});
