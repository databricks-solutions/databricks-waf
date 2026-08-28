// The layout controls, and the asymmetry of a sampled result.
//
// The point these tests defend is that a failure found in a sample and a pass found in a
// sample are not equally strong claims. A badly partitioned table is badly partitioned
// whether or not the pass looked at every table, so a sampled failure is a real failure.
// A sample where nothing was found wrong says only that — so the passing finding has to
// carry its coverage and say what it did not test.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { TableDetail, TableDetails } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const DETAILS = 'describe:storage.table_details' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

const TIB = 1024 ** 4;

function table(overrides: Partial<TableDetail> = {}): TableDetail {
  return {
    catalog: 'main',
    schema: 'sales',
    table: 'orders',
    sizeBytes: 10 * TIB,
    fileCount: 200,
    partitionColumns: [],
    clusteringColumns: [],
    features: ['appendOnly'],
    automaticClustering: false,
    properties: {},
    readEvents: 5,
    ...overrides,
  };
}

function findingFor(controlId: string, details: TableDetails, mode: 'complete' | 'sampled' = 'sampled') {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);

  const coverage =
    mode === 'complete'
      ? COMPLETE
      : { mode: 'sampled' as const, examined: details.tables.length, population: details.eligibleTables };
  const signals = new Map<SignalId, SignalResult>([[DETAILS, observed(DETAILS, details, 1, coverage)]]);
  return resolveControl(spec, signals, registry.get(controlId));
}

describe('over-partitioning', () => {
  it('fails a table partitioned below the documented size floor', () => {
    const finding = findingFor('PE-03-13', {
      tables: [table({ sizeBytes: 5 * 1024 ** 3, partitionColumns: ['event_date'] })],
      eligibleTables: 400,
      undescribed: [],
    });

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0].observed).toContain('main.sales.orders');
    // The size has to appear, because "over-partitioned" without the number gives the
    // reader nothing to check the judgement against.
    expect(finding.evidence[0].observed).toContain('GiB');
  });

  it('passes a large partitioned table, since the rule is about small ones', () => {
    const finding = findingFor('PE-03-13', {
      tables: [table({ sizeBytes: 8 * TIB, partitionColumns: ['event_date'] })],
      eligibleTables: 400,
      undescribed: [],
    });

    expect(finding.outcome).toBe('pass');
  });

  it('credits liquid clustering, which the same guidance prefers to partitioning', () => {
    const finding = findingFor('PE-03-13', {
      tables: [table({ sizeBytes: 2 * 1024 ** 3, clusteringColumns: ['customer_id'] })],
      eligibleTables: 400,
      undescribed: [],
    });

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.some((item) => item.observed.includes('liquid clustering'))).toBe(true);
  });

  it('says what a passing sample did not establish', () => {
    const finding = findingFor('PE-03-13', {
      tables: [table()],
      eligibleTables: 4000,
      undescribed: [],
    });

    expect(finding.outcome).toBe('pass');
    // Both admissions matter: the sample is not the estate, and the per-partition rule
    // was never tested. A pass that implied either would be overclaiming.
    expect(finding.outcomeReason).toContain('not a statement that none exists');
    expect(finding.outcomeReason).toContain('partition cardinality');
  });

  it('carries the sampled coverage onto the finding', () => {
    const finding = findingFor('PE-03-13', {
      tables: [table(), table({ table: 'returns' })],
      eligibleTables: 4000,
      undescribed: [],
    });

    expect(finding.coverage.mode).toBe('sampled');
    expect(finding.coverage.examined).toBe(2);
    expect(finding.coverage.population).toBe(4000);
  });

  // The population this control judges. Measured on large-estate 2026-08-12, the one partitioned
  // table in the sample held 0 bytes in 0 files, and the finding told the owner of a table drawing
  // 15,558 reads that its file layout was slowing every read. A table with nothing in it has no
  // partitions of any size, which is not the same question as a small table partitioned too finely.
  describe('a partitioned table holding nothing', () => {
    const nothing = table({ table: 'sales_events', sizeBytes: 0, fileCount: 0, partitionColumns: ['region'], readEvents: 15_558 });

    it('is not a failure, however heavily the table is read', () => {
      const finding = findingFor('PE-03-13', { tables: [nothing], eligibleTables: 184_605, undescribed: [] });

      expect(finding.outcome).not.toBe('fail');
    });

    it('leaves the control inapplicable rather than crediting the estate with a pass', () => {
      const finding = findingFor('PE-03-13', { tables: [nothing], eligibleTables: 184_605, undescribed: [] });

      // ADR 0074: an empty population leaves the denominator, and a pass here would be credit for
      // an absence. The emptiness is one the scan established — the table was described.
      expect(finding.outcome).toBe('not-applicable');
      expect(finding.evidence[0].observed).toContain('main.sales.sales_events');
      expect(finding.evidence[0].observed).toContain('0 B');
      expect(finding.outcomeReason).toContain('no over-partitioned table exists');
    });

    it('still fails a table that holds a little rather than nothing, and says how much', () => {
      // The floor is emptiness, not a second size band. A few kilobytes across a few files is
      // over-partitioned and cheap to fix, so the finding has to keep firing on it.
      const finding = findingFor('PE-03-13', {
        tables: [table({ sizeBytes: 26 * 1024, fileCount: 3, partitionColumns: ['region'] })],
        eligibleTables: 400,
        undescribed: [],
      });

      expect(finding.outcome).toBe('fail');
      expect(finding.evidence[0].observed).toContain('26 KiB');
      expect(finding.evidence[0].observed).toContain('3 files');
    });

    it('is excluded from a pass over the partitioned tables that do hold data, and named in it', () => {
      const finding = findingFor('PE-03-13', {
        tables: [nothing, table({ sizeBytes: 8 * TIB, partitionColumns: ['event_date'] })],
        eligibleTables: 400,
        undescribed: [],
      });

      expect(finding.outcome).toBe('pass');
      // One judged, not two: a pass claiming both would be counting a table it could not judge
      // as one that came out clean.
      expect(finding.evidence[0].observed).toContain('1 partitioned table');
      expect(finding.evidence.some((item) => item.observed.includes('main.sales.sales_events'))).toBe(true);
    });

    it('agrees its verb with its count, on both sides of the exclusion', () => {
      const two = findingFor('PE-03-13', {
        tables: [nothing, table({ table: 'refunds', sizeBytes: 0, fileCount: 0, partitionColumns: ['region'] })],
        eligibleTables: 400,
        undescribed: [],
      });

      expect(two.outcome).toBe('not-applicable');
      expect(two.evidence[0].observed).toContain('2 partitioned tables among');
      expect(two.evidence[0].observed).toContain('have no data');
      expect(two.evidence[0].observed).not.toContain('has no data');

      const one = findingFor('PE-03-13', { tables: [nothing], eligibleTables: 400, undescribed: [] });

      expect(one.evidence[0].observed).toContain('1 partitioned table among');
      expect(one.evidence[0].observed).toContain('has no data');
      expect(one.evidence[0].observed).toContain('across 0 files');
    });

    it('does not turn an estate that partitions nothing at all into an exclusion', () => {
      // Not the same claim. Nothing partitioned means every table examined was checked against
      // the rule and none broke it; a partitioned table with no data is one the rule cannot ask
      // about. Only the second leaves the denominator.
      const finding = findingFor('PE-03-13', {
        tables: [table({ sizeBytes: 0, fileCount: 0 })],
        eligibleTables: 400,
        undescribed: [],
      });

      expect(finding.outcome).toBe('pass');
      expect(finding.evidence[0].observed).toContain('None of the');
    });
  });
});

describe('deletion vectors', () => {
  it('passes when the actively read tables have them enabled', () => {
    const tables = Array.from({ length: 5 }, (_, index) =>
      table({ table: `t${String(index)}`, features: ['deletionVectors'], readEvents: 3 })
    );
    const finding = findingFor('PE-03-16', { tables, eligibleTables: 5, undescribed: [] });

    expect(finding.outcome).toBe('pass');
  });

  it('scores against read tables, not every table', () => {
    // Four unread tables without the feature, one read table with it. Judged across
    // everything this fails; judged across what is actually modified it passes, and the
    // latter is the question worth asking — enabling the feature on a table nobody
    // touches changes nothing and costs a protocol upgrade.
    const tables = [
      table({ table: 'hot', features: ['deletionVectors'], readEvents: 40 }),
      ...Array.from({ length: 4 }, (_, index) => table({ table: `cold${String(index)}`, readEvents: 0 })),
    ];
    const finding = findingFor('PE-03-16', { tables, eligibleTables: 5, undescribed: [] });

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0].observed).toContain('1 of 1 tables read in the window');
  });

  it('fails when most read tables rewrite whole files, and says why that costs', () => {
    const tables = Array.from({ length: 5 }, (_, index) => table({ table: `t${String(index)}`, readEvents: 2 }));
    const finding = findingFor('PE-03-16', { tables, eligibleTables: 5, undescribed: [] });

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toContain('rewrites whole data files');
    // The caveat has to travel with the recommendation, because acting on it without
    // knowing about the reader-version bump can break a downstream consumer.
    expect(finding.outcomeReason).toContain('minimum reader version');
  });
});

describe('data skipping', () => {
  const GIB = 1024 ** 3;

  function large(overrides: Partial<TableDetail> = {}): TableDetail {
    return table({ sizeBytes: 40 * GIB, fileCount: 200, readEvents: 4, ...overrides });
  }

  it('fails outright where file statistics are switched off, whatever the clustering', () => {
    // The one unambiguous data-skipping fact. With no statistics per file, no predicate can
    // skip anything, so a well-clustered table with stats off still reads every file.
    const finding = findingFor('PE-03-12', {
      tables: [large({ clusteringColumns: ['customer_id'], properties: { 'delta.dataSkippingNumIndexedCols': '0' } })],
      eligibleTables: 400,
      undescribed: [],
    });

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0].observed).toContain('delta.dataSkippingNumIndexedCols');
    // Acting on it needs to come with the fact that statistics are not backfilled.
    expect(finding.outcomeReason).toContain('does not backfill');
  });

  it('passes where the large read tables cluster or partition their data', () => {
    const tables = Array.from({ length: 5 }, (_, index) =>
      large({ table: `t${String(index)}`, clusteringColumns: ['customer_id'] })
    );
    const finding = findingFor('PE-03-12', { tables, eligibleTables: 5, undescribed: [] });

    expect(finding.outcome).toBe('pass');
  });

  it('fails where large read tables have no clustering and no partitioning', () => {
    const tables = Array.from({ length: 5 }, (_, index) => large({ table: `t${String(index)}` }));
    const finding = findingFor('PE-03-12', { tables, eligibleTables: 5, undescribed: [] });

    expect(finding.outcome).toBe('fail');
    // The limit of the claim has to travel with it: this measures whether skipping is
    // possible, and cannot say whether it is saving anything, because the predicates
    // queries actually use are never read against the layout.
    expect(finding.outcomeReason).toContain('does not measure is whether skipping is working');
  });

  it('leaves the denominator for an estate of tables small enough to read whole', () => {
    // Not a pass: skipping changes nothing on a two-file table, so crediting it would move
    // the score for a control with no consequence here.
    const finding = findingFor('PE-03-12', {
      tables: [table({ sizeBytes: 20 * 1024 ** 2, fileCount: 2 })],
      eligibleTables: 400,
      undescribed: [],
    });

    expect(finding.outcome).toBe('not-applicable');
  });

  it('reports a narrowed statistics column list without failing the table for it', () => {
    // Naming the columns is a legitimate choice — statistics on 32 wide string columns cost
    // more than they save. It changes which predicates can skip, so it is reported.
    const finding = findingFor('PE-03-12', {
      tables: [
        large({ clusteringColumns: ['customer_id'], properties: { 'delta.dataSkippingStatsColumns': 'order_date' } }),
      ],
      eligibleTables: 5,
      undescribed: [],
    });

    expect(finding.outcome).toBe('pass');
    expect(finding.evidence.some((item) => item.observed.includes('delta.dataSkippingStatsColumns'))).toBe(true);
  });
});
