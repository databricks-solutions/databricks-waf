// DG-01-02 and DG-01-03: how the metadata plane is organised, and where AI assets are registered.
//
// These two used to pass whenever the metastore held a table, which made a critical control the app
// could not fail. What they score now is organisational design, which the census does show: whether
// the estate was divided into catalogs at all, and whether ownership is spread across more than one
// person. Description coverage is not scored here — DG-01-05 scores it in the same pillar — and a
// test below holds that line, because it is the part most likely to creep back in.
//
// DG-01-03 is "data and AI assets in one place", so it also reads whether the models the estate
// serves are registered in Unity Catalog. That reading comes from a different statement and is an
// enrichment: when it is missing the first half stands, rather than the control going unmeasured on
// a signal that has no bearing on the census. Decision D4, revised by A8, in docs/decisions.md.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { AssetCensus, ServingModelEntity } from '../../collect/sql/shapes.js';
import { scoreFindings } from '../../score/score.js';
import type { Finding } from '../finding.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const SERVING_ENTITIES = 'sql:serving.model_entities' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 120,
    catalogCount: 4,
    schemaCount: 18,
    managedTables: 100,
    externalTables: 20,
    views: 12,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 118,
    icebergTables: 2,
    optimizedFormatTables: 120,
    describedTables: 60,
    distinctOwners: 5,
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
    ...overrides,
  };
}

function models(customModels: number, inUc: number): ServingModelEntity {
  return {
    workspaceId: '1',
    servedEntityId: 'se-1',
    endpointId: 'ep-1',
    endpointName: 'fraud-scoring',
    servedEntityName: 'fraud-scoring-v1',
    entityType: 'CUSTOM_MODEL',
    requests: 0,
    daysWithTraffic: 0,
    failedRequests: 0,
    requestsWithoutStatus: 0,
    liveEntities: customModels,
    liveEndpoints: customModels,
    customModels,
    foundationModels: 0,
    externalModels: 0,
    featureSpecs: 0,
    customModelsWithAVersion: customModels,
    customModelsNamedInUc: inUc,
  };
}

function findingFor(controlId: string, readings: readonly [SignalId, SignalResult][]): Finding {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, new Map(readings), registry.get(controlId));
}

function read(value: AssetCensus): [SignalId, SignalResult] {
  return [CENSUS, observed(CENSUS, value, 1, COMPLETE)];
}

function served(customModels: number, inUc: number): [SignalId, SignalResult] {
  return [SERVING_ENTITIES, observed(SERVING_ENTITIES, [models(customModels, inUc)], 1, COMPLETE)];
}

describe.each(['DG-01-02', 'DG-01-03'])('%s, the catalog and ownership half', (controlId) => {
  it('fails an estate whose every table is in one catalog', () => {
    const finding = findingFor(controlId, [read(census({ catalogCount: 1 }))]);
    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('single catalog');
  });

  it('is partial with more than one catalog and a single owner across the estate', () => {
    const finding = findingFor(controlId, [read(census({ catalogCount: 4, distinctOwners: 1 }))]);
    expect(finding.outcome).toBe('partial');
    expect(finding.evidence[0]?.observed).toContain('1 distinct owner');
  });

  it('is partial when no owner is recorded at all', () => {
    expect(findingFor(controlId, [read(census({ catalogCount: 4, distinctOwners: 0 }))]).outcome).toBe('partial');
  });

  it('passes with more than one catalog and distributed ownership', () => {
    const finding = findingFor(controlId, [read(census({ catalogCount: 2, distinctOwners: 2 }))]);
    expect(finding.outcome).toBe('pass');
  });

  it('does not score description coverage, which DG-01-05 scores', () => {
    const undescribed = findingFor(controlId, [read(census({ describedTables: 0 }))]);
    const described = findingFor(controlId, [read(census({ describedTables: 120 }))]);
    expect(undescribed.outcome).toBe('pass');
    expect(described.outcome).toBe(undescribed.outcome);
  });

  it('never says everything is governed, which the census cannot show', () => {
    const finding = findingFor(controlId, [read(census())]);
    expect(finding.outcomeReason ?? '').not.toMatch(/\ball\b.*governed/i);
  });

  it('leaves the control unmeasured when the census could not be read', () => {
    const finding = findingFor(controlId, [[CENSUS, unmeasurable(CENSUS, 'query refused')]]);
    expect(finding.outcome).toBe('unmeasurable');
  });
});

describe('DG-01-02 does not read the serving inventory', () => {
  it('is the same with and without it', () => {
    const without = findingFor('DG-01-02', [read(census())]);
    const withIt = findingFor('DG-01-02', [read(census()), served(10, 0)]);
    expect(withIt.outcome).toBe(without.outcome);
    expect(withIt.evidence).toHaveLength(without.evidence.length);
  });

  it('does not ask for the signal', () => {
    expect(registry.get('DG-01-02')?.enrichedBy ?? []).not.toContain(SERVING_ENTITIES);
  });
});

describe('DG-01-03, data and AI assets in one place', () => {
  const organised = census({ catalogCount: 4, distinctOwners: 5 });

  it('asks for the serving inventory as an enrichment, so a missing reading costs a sentence', () => {
    const resolver = registry.get('DG-01-03');
    expect(resolver?.enrichedBy).toContain(SERVING_ENTITIES);
    expect(resolver?.requires).not.toContain(SERVING_ENTITIES);
  });

  it.each([
    [10, 10, 'pass'],
    [10, 8, 'pass'],
    [10, 7, 'partial'],
    [10, 4, 'partial'],
    [10, 3, 'fail'],
    [10, 0, 'fail'],
  ] as const)('with %i served custom models, %i of them in Unity Catalog, the AI half is %s', (custom, inUc, half) => {
    const finding = findingFor('DG-01-03', [read(organised), served(custom, inUc)]);
    expect(finding.outcome).toBe(half);
    expect(finding.evidence.map((item) => item.observed).join(' ')).toContain(`${inUc} of ${custom}`);
  });

  it('takes the worse half when the AI half is weaker', () => {
    const finding = findingFor('DG-01-03', [read(organised), served(10, 1)]);
    expect(finding.outcome).toBe('fail');
  });

  it('takes the worse half when the catalog half is weaker', () => {
    expect(findingFor('DG-01-03', [read(census({ catalogCount: 1 })), served(10, 10)]).outcome).toBe('fail');
    expect(findingFor('DG-01-03', [read(census({ distinctOwners: 1 })), served(10, 10)]).outcome).toBe('partial');
  });

  it('is not applicable to the AI half when no custom model is served, so the first half stands', () => {
    const finding = findingFor('DG-01-03', [read(organised), served(0, 0)]);
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.map((item) => item.observed).join(' ')).not.toContain('served custom model');
  });

  it('leaves the first half standing when the serving inventory is refused', () => {
    const refused: [SignalId, SignalResult] = [SERVING_ENTITIES, unmeasurable(SERVING_ENTITIES, 'query refused')];
    expect(findingFor('DG-01-03', [read(organised), refused]).outcome).toBe('pass');
    expect(findingFor('DG-01-03', [read(census({ catalogCount: 1 })), refused]).outcome).toBe('fail');
  });

  it('leaves the first half standing when the serving inventory was not collected', () => {
    expect(findingFor('DG-01-03', [read(organised)]).outcome).toBe('pass');
  });

  it('reads its bands from the catalogue rather than from the code', () => {
    const control = catalogue.controls.find((one) => one.id === 'DG-01-03');
    expect(control?.thresholds).toEqual({ pass_share: 0.8, partial_share: 0.4 });
  });

  it('is scored with its alias at the worse half', () => {
    const catalogHalf = findingFor('DG-01-02', [read(organised), served(10, 1)]);
    const both = findingFor('DG-01-03', [read(organised), served(10, 1)]);
    expect(catalogHalf.outcome).toBe('pass');
    expect(both.outcome).toBe('fail');

    const group = (id: string) => (id === 'DG-01-02' || id === 'DG-01-03' ? 'unity-catalog-governed' : undefined);
    // The unit scores at its worse half: the pair reads as the weaker finding alone, and not as the
    // stronger one or an average of the two.
    const together = scoreFindings([catalogHalf, both], { aliasGroupOf: group }).overall;
    expect(together).toBe(scoreFindings([both], { aliasGroupOf: group }).overall);
    expect(together).toBeLessThan(scoreFindings([catalogHalf], { aliasGroupOf: group }).overall ?? 0);
  });
});
