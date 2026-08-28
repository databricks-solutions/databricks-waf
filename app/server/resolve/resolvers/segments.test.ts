// Locating a gap, and what happens when it cannot be located.
//
// The enrichment is the first evidence in the app that is not load-bearing, so these tests
// pin both halves of that: it says where the gap sits when the per-schema census landed,
// and its absence or truncation costs a sentence rather than a control or a coverage claim.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import {
  COMPLETE,
  observed,
  unmeasurable,
  type Coverage,
  type SignalId,
  type SignalResult,
} from '../../collect/signal.js';
import type { AssetCensus, SchemaCensus, SchemaCensusRow } from '../../collect/sql/shapes.js';
import { resolveControl, type ControlSpec } from '../resolver.js';
import type { Finding } from '../finding.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const SCHEMA_CENSUS = 'sql:uc.schema_census' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function schema(name: string, tableCount: number, describedTables: number): SchemaCensusRow {
  return {
    catalog: 'main',
    schema: name,
    tableCount,
    managedTables: tableCount,
    externalTables: 0,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    optimizedFormatTables: tableCount,
    describedTables,
    distinctOwners: 1,
  };
}

function census(tableCount: number, describedTables: number): AssetCensus {
  return {
    tableCount,
    catalogCount: 1,
    schemaCount: 3,
    managedTables: tableCount,
    externalTables: 0,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: tableCount,
    icebergTables: 0,
    optimizedFormatTables: tableCount,
    describedTables,
    distinctOwners: 1,
    // Zero, so these tests are about locating a gap and nothing else. The estate-boundary
    // note has its own cases below.
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
  };
}

/** DG-01-05 counts descriptions estate-wide and is enriched with where the gap sits. */
function descriptionFinding(schemas?: SignalResult): Finding {
  const spec = specFor('DG-01-05');
  const signals = new Map<SignalId, SignalResult>([[CENSUS, observed(CENSUS, census(100, 40), 1, COMPLETE)]]);
  if (schemas != null) signals.set(SCHEMA_CENSUS, schemas);
  return resolveControl(spec, signals, registry.get('DG-01-05'));
}

function specFor(id: string): ControlSpec {
  const spec = catalogue.controls.find((control) => control.id === id);
  if (spec == null) throw new Error(`${id} is not in the catalogue`);
  return spec;
}

function schemaCensus(
  schemas: readonly SchemaCensusRow[],
  population = schemas.length,
  coverage: Coverage = COMPLETE
): SignalResult {
  return observed(SCHEMA_CENSUS, { schemas, schemaPopulation: population } satisfies SchemaCensus, 1, coverage);
}

function where(finding: Finding): string | undefined {
  return finding.evidence.find((item) => item.signal === SCHEMA_CENSUS && item.bearing === 'detail')?.observed;
}

function boundary(finding: Finding): string | undefined {
  return finding.evidence.find((item) => item.signal === CENSUS && item.bearing === 'detail')?.observed;
}

describe('locating a gap by schema', () => {
  it('names the schemas holding the gap, worst first', () => {
    const finding = descriptionFinding(
      schemaCensus([schema('bronze', 50, 10), schema('silver', 30, 20), schema('gold', 20, 10)])
    );

    // 40 undescribed in bronze, 10 each in silver and gold.
    expect(where(finding)).toContain('main.bronze (40)');
    expect(where(finding)).toMatch(/main\.bronze \(40\).*main\.(silver|gold) \(10\)/);
  });

  it('omits schemas with no gap rather than listing them at zero', () => {
    const finding = descriptionFinding(schemaCensus([schema('bronze', 50, 10), schema('gold', 20, 20)]));

    expect(where(finding)).toContain('main.bronze');
    expect(where(finding)).not.toContain('main.gold');
  });

  it('says the gap is entirely accounted for when few enough schemas hold it', () => {
    const finding = descriptionFinding(schemaCensus([schema('bronze', 50, 10), schema('silver', 30, 20)]));

    expect(where(finding)).toBe('All 50 sit in 2 schemas: main.bronze (40), main.silver (10)');
  });

  it('states how much of the gap the named schemas hold when there are more of them', () => {
    const many = ['a', 'b', 'c', 'd', 'e', 'f'].map((name) => schema(name, 10, 5));
    const finding = descriptionFinding(schemaCensus(many));

    // Six schemas hold five each; four are named, so twenty of thirty.
    expect(where(finding)).toContain('20 of the 30 sit in 4 of 6 schemas');
    expect(where(finding)).toContain('main.a (5)');
  });

  it('says so when the census itself was truncated, so a short list does not read as the whole estate', () => {
    const finding = descriptionFinding(
      schemaCensus([schema('bronze', 50, 10)], 900, {
        mode: 'sampled',
        examined: 1,
        population: 900,
        basis: 'the schemas holding the most tables first',
      })
    );

    expect(where(finding)).toContain('Counted across the 1 largest of 900 schemas');
  });

  it('does not let a sampled breakdown narrow a complete measurement', () => {
    // The outcome came from the estate census, which counted every table. Reporting the
    // finding as sampled would claim less than was measured, and under the sampled-pass
    // rule that weakens a result the estate earned.
    const finding = descriptionFinding(
      schemaCensus([schema('bronze', 50, 10)], 900, {
        mode: 'sampled',
        examined: 1,
        population: 900,
        basis: 'the schemas holding the most tables first',
      })
    );

    expect(finding.coverage.mode).toBe('complete');
  });

  it('still resolves the control when the breakdown could not be read', () => {
    const finding = descriptionFinding(unmeasurable(SCHEMA_CENSUS, 'The query budget ran out before this ran.'));

    // 40 of 100 described sits in the partial band. What matters is that it is not
    // unmeasurable: the evidence the outcome needs was read.
    expect(finding.outcome).toBe('partial');
    expect(where(finding)).toBeUndefined();
  });

  it('still resolves the control when the breakdown was never collected', () => {
    const finding = descriptionFinding(undefined);

    expect(finding.outcome).toBe('partial');
    expect(where(finding)).toBeUndefined();
  });

  it('is collected because the resolvers that read it declare it', () => {
    // The scan plan is built from what resolvers ask for. An enrichment nobody declares is
    // never collected, and the soft read would then find nothing on every scan forever.
    expect(registry.signalsFor(['DG-01-05'])).toContain(SCHEMA_CENSUS);
  });
});

describe('the estate boundary', () => {
  function findingWithExcluded(databricksOwnedTables: number, databricksOwnedCatalogs: string): Finding {
    const spec = specFor('DG-01-05');
    const value = { ...census(11, 4), databricksOwnedTables, databricksOwnedCatalogs };
    const signals = new Map<SignalId, SignalResult>([[CENSUS, observed(CENSUS, value, 1, COMPLETE)]]);
    return resolveControl(spec, signals, registry.get('DG-01-05'));
  }

  it('says what was left out and names the catalogs', () => {
    // Measured on labs: 130 of 141 catalogued tables were Databricks-owned. A user who counts
    // information_schema themselves gets the bigger number, so the gap has to be explained
    // where they are reading rather than left for them to discover.
    const note = boundary(findingWithExcluded(130, 'samples, system'));

    expect(note).toContain('130 further tables');
    expect(note).toContain('samples, system');
  });

  it('says nothing when there was nothing to exclude', () => {
    expect(boundary(findingWithExcluded(0, ''))).toBeUndefined();
  });

  it('still explains itself when the catalog names came back empty', () => {
    const note = boundary(findingWithExcluded(130, ''));

    expect(note).toContain('130 further tables');
    expect(note).not.toContain('()');
  });

  it('scores the customer estate, not the metastore', () => {
    // 4 of 11 described is 36% and a failure. Before the exclusion the same estate read 76 of
    // 141 and came out partial, on the strength of descriptions Databricks wrote.
    expect(findingWithExcluded(130, 'samples, system').outcome).toBe('fail');
  });
});
