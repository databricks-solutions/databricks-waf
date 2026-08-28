// Delta retention, and the difference between a window that is set and one that is inherited.
//
// The claim these tests defend is that the reachable window is the lesser of two retentions rather
// than the one an operator set. A table retaining a year of log history against a week of files can
// be restored a week, and a review reading the year off the table properties would plan a recovery
// that fails on the day it is needed. That, and the honesty rule underneath it: a property this app
// cannot parse is reported as unread, never converted into a number the table does not guarantee.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';
import { retentionDays } from './retention.js';

const DETAILS = 'describe:storage.table_details' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function table(properties: Readonly<Record<string, string>> = {}, name = 'orders'): TableDetail {
  return {
    catalog: 'main',
    schema: 'sales',
    table: name,
    sizeBytes: 4 * 1024 ** 4,
    fileCount: 200,
    partitionColumns: [],
    clusteringColumns: [],
    features: ['appendOnly'],
    automaticClustering: false,
    properties,
    readEvents: 5,
  };
}

function findingFor(controlId: string, tables: readonly TableDetail[], eligibleTables = 400) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const details: TableDetails = { tables, eligibleTables, undescribed: [] };
  const signals = new Map<SignalId, SignalResult>([
    [DETAILS, observed(DETAILS, details, 1, { mode: 'sampled', examined: tables.length, population: eligibleTables })],
  ]);
  return resolveControl(spec, signals, registry.get(controlId));
}

describe('retentionDays', () => {
  it('reads the interval syntax Delta documents', () => {
    expect(retentionDays('interval 30 days')).toBe(30);
    expect(retentionDays('30 days')).toBe(30);
    expect(retentionDays('interval 1 day')).toBe(1);
    expect(retentionDays('interval 2 weeks')).toBe(14);
    expect(retentionDays('interval 48 hours')).toBe(2);
  });

  it('refuses units with no fixed length rather than assuming one', () => {
    // Three months is 89, 90, 91 or 92 days, and a recovery window quoted from an assumption is
    // worse than one reported as unread.
    expect(retentionDays('interval 3 months')).toBeUndefined();
    expect(retentionDays('interval 1 year')).toBeUndefined();
  });

  it('returns undefined for anything it cannot read, including nothing', () => {
    expect(retentionDays(undefined)).toBeUndefined();
    expect(retentionDays('')).toBeUndefined();
    expect(retentionDays('forever')).toBeUndefined();
  });
});

describe('Delta history and time-travel retention', () => {
  it('fails a table whose reachable window is shorter than the platform default', () => {
    const finding = findingFor('REL-04-05', [
      table({ 'delta.deletedFileRetentionDuration': 'interval 24 hours' }),
      table({}, 'customers'),
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0].observed).toContain('main.sales.orders');
    // The window has to appear as a duration, because "shortened" without it is unactionable.
    // Normalised to days, since that is the unit a recovery window is discussed in.
    expect(finding.evidence[0].observed).toContain('1 day');
  });

  it('reports a sub-day window in hours rather than as a fraction of a day', () => {
    const finding = findingFor('REL-04-05', [table({ 'delta.deletedFileRetentionDuration': 'interval 6 hours' })]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0].observed).toContain('6 hours');
  });

  it('flags log history retained beyond the files that make it usable', () => {
    const finding = findingFor('REL-04-05', [table({ 'delta.logRetentionDuration': 'interval 365 days' })]);

    expect(finding.outcome).toBe('partial');
    expect(finding.evidence[0].observed).toContain('365 days');
    // The gap is the point: the reader must see both numbers, not just the one they set.
    expect(finding.evidence[0].observed).toContain('7 days');
  });

  it('does not flag the platform default, which is itself 30 days of log against 7 of files', () => {
    // Otherwise every table in every estate carries a finding for the vendor's default, which is
    // noise dressed as a measurement.
    const finding = findingFor('REL-04-05', [table({ 'delta.deletedFileRetentionDuration': 'interval 14 days' })]);

    expect(finding.outcome).toBe('pass');
  });

  it('gives partial credit where every table inherits the default, and says the decision is missing', () => {
    const finding = findingFor('REL-04-05', [table(), table({}, 'customers')]);

    expect(finding.outcome).toBe('partial');
    expect(finding.evidence[0].observed).toContain('inherit');
    expect(finding.outcomeReason).toContain('7 days');
  });

  it('reports an unreadable retention rather than guessing at it', () => {
    const finding = findingFor('REL-04-05', [
      table({ 'delta.logRetentionDuration': 'interval 6 months' }, 'ledger'),
      table({ 'delta.logRetentionDuration': 'interval 14 days', 'delta.deletedFileRetentionDuration': 'interval 14 days' }),
    ]);

    const unread = finding.evidence.find((item) => item.observed.includes('could not read'));
    expect(unread?.observed).toContain('main.sales.ledger');
    expect(unread?.observed).toContain('6 months');
  });

  it('scores the cost counterpart identically, because it is one decision', () => {
    const shortened = [table({ 'delta.deletedFileRetentionDuration': 'interval 1 hours' })];
    expect(findingFor('CO-03-07', shortened).outcome).toBe(findingFor('REL-04-05', shortened).outcome);
  });

  it('says the window is a guarantee of the settings, not of the table today', () => {
    // Deleted files survive their retention until VACUUM runs, so the computed window is a floor.
    // Reporting it as the table's actual history would overstate what was measured.
    const finding = findingFor('REL-04-05', [table()]);
    expect(finding.outcomeReason).toContain('VACUUM');
  });

  it('leaves the denominator when the metastore holds no Delta tables', () => {
    expect(findingFor('REL-04-05', [], 0).outcome).toBe('not-applicable');
  });

  it('reports unmeasured, not clean, when eligible tables went undescribed', () => {
    const finding = findingFor('REL-04-05', [], 400);
    expect(finding.outcome).toBe('unmeasurable');
  });

  it('carries the sample coverage, so a pass is not read as estate-wide', () => {
    const finding = findingFor('REL-04-05', [table({ 'delta.logRetentionDuration': 'interval 14 days' })]);
    expect(finding.evidence[0].coverage.mode).toBe('sampled');
    expect(COMPLETE.mode).toBe('complete');
  });
});
