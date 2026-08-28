// The format population: tables that store a format, not every relation the catalogue lists.
//
// Views were already out of the denominator. Metric views and foreign tables were not, so an
// estate of Delta tables plus either leftover type failed CO-01-01 (and its aliases) for
// relations that have no storage format to choose. These tests hold that subtraction.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import { parse, type AssetCensus, type SchemaCensus, type SchemaCensusRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const SCHEMA_CENSUS = 'sql:uc.schema_census' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 100,
    catalogCount: 4,
    schemaCount: 18,
    managedTables: 90,
    externalTables: 10,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 100,
    icebergTables: 0,
    optimizedFormatTables: 100,
    describedTables: 90,
    distinctOwners: 5,
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
    ...overrides,
  };
}

function schema(overrides: Partial<SchemaCensusRow> & Pick<SchemaCensusRow, 'schema' | 'tableCount'>): SchemaCensusRow {
  return {
    catalog: 'main',
    managedTables: overrides.tableCount,
    externalTables: 0,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    optimizedFormatTables: overrides.tableCount,
    describedTables: overrides.tableCount,
    distinctOwners: 1,
    ...overrides,
  };
}

function findingFor(controlId: string, signals: Map<SignalId, SignalResult>) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, registry.get(controlId));
}

function signalsOf(entries: readonly [SignalId, unknown][]): Map<SignalId, SignalResult> {
  return new Map(entries.map(([id, value]) => [id, observed(id, value, 1, COMPLETE)]));
}

function schemaCensus(schemas: readonly SchemaCensusRow[]): SchemaCensus {
  return { schemas, schemaPopulation: schemas.length };
}

describe('CO-01-01 format population', () => {
  it('passes an estate of Delta tables plus metric views and foreign tables', () => {
    // The defect: 90 Delta + 10 metric views + 10 foreign was 90 of 110 under tables-less-views,
    // which is partial. The leftover types store no format, so the population is the 90.
    const finding = findingFor(
      'CO-01-01',
      signalsOf([
        [
          CENSUS,
          census({
            tableCount: 110,
            metricViews: 10,
            foreignTables: 10,
            deltaTables: 90,
            optimizedFormatTables: 90,
          }),
        ],
      ])
    );

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('90 of 90 tables are Delta or Iceberg');
    expect(finding.evidence[0]?.observed).toContain('10 metric views and 10 foreign tables are out of the denominator');
  });

  it('does not name leftover types as the format gap', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([
        [
          CENSUS,
          census({
            tableCount: 20,
            metricViews: 8,
            foreignTables: 2,
            deltaTables: 10,
            optimizedFormatTables: 10,
          }),
        ],
        [
          SCHEMA_CENSUS,
          schemaCensus([
            schema({
              schema: 'metrics',
              tableCount: 20,
              metricViews: 8,
              foreignTables: 2,
              optimizedFormatTables: 10,
            }),
          ]),
        ],
      ])
    );

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.some((item) => item.signal === SCHEMA_CENSUS)).toBe(false);
  });

  it('still fails tables that store a non-Delta format', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([
        [
          CENSUS,
          census({
            tableCount: 100,
            deltaTables: 50,
            optimizedFormatTables: 50,
          }),
        ],
      ])
    );

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('50 of 100 tables are Delta or Iceberg');
  });

  it('keeps the views-only sentence when the leftover is only views', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([[CENSUS, census({ tableCount: 12, views: 12, optimizedFormatTables: 0 })]])
    );

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toBe('This metastore contains only views, which have no storage format to choose.');
  });

  it('names metric views when that is the whole leftover', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([[CENSUS, census({ tableCount: 7, metricViews: 7, optimizedFormatTables: 0 })]])
    );

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toBe(
      'This metastore contains only metric views, which have no storage format to choose.'
    );
  });

  it('names foreign tables when that is the whole leftover', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([[CENSUS, census({ tableCount: 4, foreignTables: 4, optimizedFormatTables: 0 })]])
    );

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toBe(
      'This metastore contains only foreign tables, which have no storage format to choose.'
    );
  });

  it('restates a mixed leftover rather than picking one type', () => {
    const finding = findingFor(
      'CO-01-01',
      signalsOf([
        [CENSUS, census({ tableCount: 6, views: 2, metricViews: 3, foreignTables: 1, optimizedFormatTables: 0 })],
      ])
    );

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toBe(
      'This metastore contains 2 views, 3 metric views and 1 foreign table, which have no storage format to choose.'
    );
  });

  it('treats leftover counts missing from a stored scan as zero', () => {
    const stored = census({ tableCount: 100, views: 0, optimizedFormatTables: 100 });
    const { metricViews: _metric, foreignTables: _foreign, ...without } = stored;

    const finding = findingFor('CO-01-01', signalsOf([[CENSUS, without]]));

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('100 of 100 tables are Delta or Iceberg');
  });
});

describe('the census parse', () => {
  it('reads the leftover type columns', () => {
    const row = parse.assetCensus([
      {
        table_count: '12',
        views: '2',
        metric_views: '3',
        foreign_tables: '1',
        optimized_format_tables: '6',
      },
    ]);

    expect(row.metricViews).toBe(3);
    expect(row.foreignTables).toBe(1);
  });

  it('counts leftover types as zero when the stored row predates the columns', () => {
    const row = parse.assetCensus([{ table_count: '10', views: '2' }]);

    expect(row.metricViews).toBe(0);
    expect(row.foreignTables).toBe(0);
  });

  it('reads the same leftover types on a schema row', () => {
    const { schemas } = parse.schemaCensus([
      {
        table_catalog: 'main',
        table_schema: 'metrics',
        table_count: '20',
        views: '0',
        metric_views: '8',
        foreign_tables: '2',
        optimized_format_tables: '10',
      },
    ]);

    expect(schemas[0]?.metricViews).toBe(8);
    expect(schemas[0]?.foreignTables).toBe(2);
  });
});
