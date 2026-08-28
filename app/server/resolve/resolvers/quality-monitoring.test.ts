// DG-03-02 reports the quality monitor and does not score it.
//
// The claim these tests defend is that neither candidate band `78` measured becomes a verdict.
// A Healthy majority is not a pass. Zero monitored tables is not a fail. The statement's grain
// is latest-per-table, and the customer-catalog predicate in the SQL is the one `queries.ts`
// owns — inlined, because a statement on the awaiting-reading list cannot carry the fragment.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import { customerCatalogPredicate } from '../../collect/sql/queries.js';
import { parse, type QualityMonitoring } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const MONITOR = 'sql:uc.quality_monitoring' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();
const STATEMENT = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../../config/statements/uc_quality_monitoring.sql'),
  'utf8'
);

function reading(overrides: Partial<QualityMonitoring> = {}): QualityMonitoring {
  return {
    estateTables: 446_914,
    estateCatalogs: 2_886,
    monitoredTables: 12_589,
    monitoredCatalogs: 400,
    healthy: 12_409,
    unhealthy: 1,
    training: 151,
    errored: 28,
    unnamedStatus: 0,
    freshnessPresent: 12_589,
    completenessPresent: 12_589,
    freshnessEstablished: 12_417,
    completenessEstablished: 12_501,
    ...overrides,
  };
}

function findingFor(value: QualityMonitoring) {
  const spec = catalogue.controls.find((control) => control.id === 'DG-03-02');
  if (spec == null) throw new Error('DG-03-02 is not in the catalogue');
  const signals = new Map<SignalId, SignalResult>([
    [MONITOR, observed(MONITOR, value, 1, { mode: 'complete', reach: 'metastore' })],
  ]);
  return resolveControl(spec, signals, registry.get('DG-03-02'));
}

describe('DG-03-02, the quality monitor reported rather than scored', () => {
  it('does not pass a Healthy majority, and does not fail one Unhealthy table', () => {
    // `78`'s large-estate reading: 98.6% Healthy, one Unhealthy. Either band would have
    // resolved this into a score. The decision is that it does not.
    const finding = findingFor(reading());
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.remedy?.kind).toBe('attest');
    expect(finding.evidence[0]?.observed).toContain('12,589');
    expect(finding.evidence[0]?.observed).toContain('446,914');
    expect(finding.evidence[0]?.observed).toContain('2.8%');
    expect(finding.evidence[1]?.observed).toContain('12,409 Healthy');
    expect(finding.evidence[1]?.observed).toContain('1 Unhealthy');
    expect(finding.outcomeReason).toContain('expect_or_fail');
  });

  it('does not fail an estate the monitor does not cover', () => {
    const finding = findingFor(reading({ monitoredTables: 0, monitoredCatalogs: 0, healthy: 0, unhealthy: 0, training: 0, errored: 0 }));
    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
    expect(finding.evidence[0]?.observed).toContain('0 of the 446,914 customer tables');
  });

  it('leaves an empty metastore out of the denominator rather than asking about it', () => {
    const finding = findingFor(reading({ estateTables: 0, estateCatalogs: 0, monitoredTables: 0 }));
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toContain('no customer tables');
  });

  it('names a status the four known values do not cover, rather than folding it into them', () => {
    const finding = findingFor(reading({ unnamedStatus: 3 }));
    expect(finding.evidence[1]?.observed).toContain('3 with a status this reading does not name');
  });

  it('parses the statement the same way `78` counted', () => {
    const parsed = parse.qualityMonitoring([
      {
        estate_tables: '446914',
        estate_catalogs: '2886',
        monitored_tables: '12589',
        monitored_catalogs: '400',
        healthy: '12409',
        unhealthy: '1',
        training: '151',
        errored: '28',
        unnamed_status: '0',
        freshness_present: '12589',
        completeness_present: '12589',
        freshness_established: '12417',
        completeness_established: '12501',
      },
    ]);
    expect(parsed.monitoredTables).toBe(12_589);
    expect(parsed.unhealthy).toBe(1);
    expect(parsed.unnamedStatus).toBe(0);
  });

  it('filters on the customer-catalog predicate queries.ts owns, not a third copy', () => {
    expect(STATEMENT).toContain(customerCatalogPredicate('table_catalog'));
    expect(STATEMENT).toContain(customerCatalogPredicate('catalog_name'));
    expect(STATEMENT).not.toMatch(/\{\{customer_catalog /);
  });

  it('reads only the quality-monitoring signal', () => {
    expect(registry.get('DG-03-02')?.requires).toEqual([MONITOR]);
  });
});
