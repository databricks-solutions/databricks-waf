import { describe, expect, it } from 'vitest';

import { absences, readiness, type AssetFacts, type DimensionId, type ReadinessEvidence } from './readiness.js';
import {
  defineServing,
  type AssetName,
  type CataloguedAsset,
  type ClassificationFact,
  type ProtectionFact,
  type ServingEvidence,
  type TagFact,
} from './serving-asset.js';

function name(table: string): AssetName {
  return { catalog: 'main', schema: 'sales', table };
}

function catalogued(table: string, extra: Partial<CataloguedAsset> = {}): CataloguedAsset {
  return { name: name(table), description: 'what it holds', owner: 'someone@example.com', ...extra };
}

function facts(table: string, extra: Partial<AssetFacts> = {}): AssetFacts {
  return {
    qualified: `main.sales.${table}`,
    kind: 'MANAGED',
    format: 'DELTA',
    columns: 4,
    commentedColumns: 4,
    lineageEvents: 3,
    semanticReaders: 1,
    qualityStatus: 'ok',
    ...extra,
  };
}

function serving(extra: Partial<ServingEvidence> = {}): ServingEvidence {
  return { catalogued: [], tags: [], classifications: [], protections: [], ...extra };
}

function evidence(extra: Partial<ReadinessEvidence> = {}): ReadinessEvidence {
  return { serving: serving(), facts: [], ...extra };
}

/** One named asset, everything read, everything in order. The baseline the cases below vary from. */
function healthy(): { definition: ReturnType<typeof defineServing>; evidence: ReadinessEvidence } {
  return {
    definition: defineServing({ named: [name('orders')], requiredMetadata: ['description', 'owner'] }, 1),
    evidence: evidence({ serving: serving({ catalogued: [catalogued('orders')] }), facts: [facts('orders')] }),
  };
}

function dimension(outcome: ReturnType<typeof readiness>, id: DimensionId) {
  const found = outcome.dimensions.find((one) => one.id === id);
  if (found == null) throw new Error(`no ${id} dimension`);
  return found;
}

describe('with nothing declared', () => {
  it('reports every dimension unmeasured rather than zero, and says why', () => {
    const outcome = readiness(null, evidence());

    expect(outcome.declared).toBeNull();
    expect(outcome.population.undeclared).toBe(true);
    expect(outcome.dimensions).toHaveLength(8);
    for (const reading of outcome.dimensions) {
      expect(reading.standing).toBe('unmeasured');
      expect(reading.share).toBeNull();
      expect(reading.because).toMatch(/no serving definition is declared/u);
    }
  });

  it('still reports the absence, because that is the question a reader arrived with', () => {
    expect(readiness(null, evidence()).absent).toEqual(absences());
    expect(absences()[0]?.what).toMatch(/Genie/u);
  });

  it('gives customer-visible calibration provenance without repository or pull-request references', () => {
    const measured = absences()
      .map((absence) => absence.measured)
      .join(' ');

    expect(measured).toContain('large-estate calibration estate');
    expect(measured).not.toMatch(/\bPR\b|docs\/plan|github/iu);
  });
});

describe('the dimensions', () => {
  it('reads a healthy asset as ready across all eight', () => {
    const { definition, evidence: read } = healthy();
    const outcome = readiness(definition, read);

    expect(outcome.population.assets).toBe(1);
    for (const reading of outcome.dimensions) {
      // The policy dimension is the exception by design: nothing is classified, so nothing owes a
      // protection, and an empty denominator is unmeasured rather than a pass.
      if (reading.id === 'policy-controls') continue;
      expect([reading.id, reading.standing]).toEqual([reading.id, 'ready']);
      expect(reading.share).toBe(1);
    }
  });

  it('counts a federated relation as short of the Unity Catalog boundary', () => {
    const { definition } = healthy();
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        facts: [facts('orders', { kind: 'FOREIGN' })],
      })
    );

    const boundary = dimension(outcome, 'unity-catalog-boundary');
    expect(boundary.standing).toBe('short');
    expect(boundary.shortfall).toEqual(['main.sales.orders']);
  });

  it('leaves a view out of the storage-format denominator rather than failing it for having no format', () => {
    const { definition } = healthy();
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        facts: [facts('orders', { kind: 'VIEW', format: null })],
      })
    );

    const format = dimension(outcome, 'storage-format');
    expect(format.denominator).toMatchObject({ count: 0, excluded: 1 });
    expect(format.denominator.excludedBecause).toMatch(/views or federated relations/u);
    expect(format.standing).toBe('unmeasured');
  });

  it('does not let a table with no columns read count as a table whose columns are all commented', () => {
    const { definition } = healthy();
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        facts: [facts('orders', { columns: 0, commentedColumns: 0 })],
      })
    );

    expect(dimension(outcome, 'column-metadata').standing).toBe('unmeasured');
    expect(dimension(outcome, 'column-metadata').unmeasured).toBe(1);
  });

  it('reads a metric view as covered by a semantic asset without needing a reader', () => {
    const { definition } = healthy();
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        facts: [facts('orders', { kind: 'METRIC_VIEW', semanticReaders: 0 })],
      })
    );

    expect(dimension(outcome, 'semantic-assets').standing).toBe('ready');
  });

  it('counts a recorded quality status rather than judging what the status says', () => {
    const { definition } = healthy();
    const monitored = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        // A status this app has never measured the meaning of. It counts because it is there.
        facts: [facts('orders', { qualityStatus: 'FAILED' })],
      })
    );
    const unmonitored = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders')] }),
        facts: [facts('orders', { qualityStatus: null })],
      })
    );

    expect(dimension(monitored, 'quality-monitoring').standing).toBe('ready');
    expect(dimension(unmonitored, 'quality-monitoring').standing).toBe('short');
  });
});

describe('the denominators', () => {
  it('states what each share is over, on every dimension', () => {
    const { definition, evidence: read } = healthy();
    for (const reading of readiness(definition, read).dimensions) {
      expect(reading.denominator.of).toMatch(/^serving assets/u);
      expect(reading.bands).toEqual({ ready: 0.9, partial: 0.6 });
    }
  });

  it('leaves an unclassified asset out of the policy denominator rather than passing it', () => {
    const definition = defineServing(
      { named: [name('orders'), name('returns')], policy: [{ classification: 'pii', requires: ['column-mask'] }] },
      1
    );
    const classifications: ClassificationFact[] = [{ on: name('orders'), classification: 'pii' }];
    const protections: ProtectionFact[] = [{ on: name('orders'), protection: 'column-mask' }];

    const outcome = readiness(
      definition,
      evidence({
        serving: serving({
          catalogued: [catalogued('orders'), catalogued('returns')],
          classifications,
          protections,
        }),
        facts: [facts('orders'), facts('returns')],
      })
    );

    const policy = dimension(outcome, 'policy-controls');
    expect(policy.denominator).toMatchObject({ count: 1, excluded: 1 });
    expect(policy.met).toBe(1);
    expect(policy.share).toBe(1);
  });

  it('excludes an asset the evidence could not speak to from the share, and counts it', () => {
    const definition = defineServing({ named: [name('orders'), name('returns')] }, 1);
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: [catalogued('orders'), catalogued('returns')] }),
        // The second asset's row never came back, which is not the same as its lineage being empty.
        facts: [facts('orders')],
      })
    );

    const lineage = dimension(outcome, 'lineage');
    expect(lineage.denominator.count).toBe(1);
    expect(lineage.unmeasured).toBe(1);
    expect(lineage.share).toBe(1);
  });
});

describe('when the read fell short', () => {
  it('says the per-asset read did not happen, rather than reporting an estate of zeroes', () => {
    const { definition } = healthy();
    const outcome = readiness(
      definition,
      evidence({ serving: serving({ catalogued: [catalogued('orders')] }), facts: null })
    );

    for (const id of ['unity-catalog-boundary', 'lineage', 'quality-monitoring', 'storage-format'] as const) {
      expect([id, dimension(outcome, id).standing]).toEqual([id, 'unmeasured']);
      expect(dimension(outcome, id).because).toMatch(/per-asset read did not happen/u);
    }
    // The metadata half is read from the catalogue rather than from the per-asset facts, so it survives.
    expect(dimension(outcome, 'table-metadata').standing).toBe('ready');
  });

  it('distinguishes a catalogue nobody read from a declaration that selected nothing', () => {
    const definition = defineServing({ named: [name('orders')] }, 1);

    const unread = readiness(definition, evidence({ serving: serving({ catalogued: null }), facts: [] }));
    const empty = readiness(definition, evidence({ serving: serving({ catalogued: [] }), facts: [] }));

    expect(dimension(unread, 'lineage').because).toMatch(/catalogue was not read/u);
    expect(empty.population.missing).toBe(1);
    expect(dimension(empty, 'lineage').because).toMatch(/selected no asset the catalogue holds/u);
  });

  it('carries a truncated read into the population rather than into the shares', () => {
    const { definition, evidence: read } = healthy();
    const outcome = readiness(definition, { ...read, truncated: true });

    expect(outcome.population.truncated).toBe(true);
    expect(dimension(outcome, 'lineage').share).toBe(1);
  });

  it('reports the tags it could not read as unmeasured metadata, not as missing tags', () => {
    const definition = defineServing({ named: [name('orders')], requiredTagKeys: ['certification'] }, 1);
    const tags: TagFact[] | null = null;

    const outcome = readiness(
      definition,
      evidence({ serving: serving({ catalogued: [catalogued('orders')], tags }), facts: [facts('orders')] })
    );

    expect(dimension(outcome, 'table-metadata').standing).toBe('unmeasured');
    expect(dimension(outcome, 'table-metadata').unmeasured).toBe(1);
  });
});

describe('the bands', () => {
  it('reads between the two thresholds as partial rather than rounding it to a failure', () => {
    const names = ['a', 'b', 'c', 'd'].map((table) => name(table));
    const definition = defineServing({ named: names }, 1);
    const outcome = readiness(
      definition,
      evidence({
        serving: serving({ catalogued: names.map((one) => catalogued(one.table)) }),
        facts: [facts('a'), facts('b'), facts('c'), facts('d', { lineageEvents: 0 })],
      })
    );

    const lineage = dimension(outcome, 'lineage');
    expect(lineage.share).toBe(0.75);
    expect(lineage.standing).toBe('partial');
    expect(lineage.shortfall).toEqual(['main.sales.d']);
  });
});
