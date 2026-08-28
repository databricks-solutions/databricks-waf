// The per-table collector, and the honesty of what it claims to have covered.
//
// Most of these tests are about coverage rather than about parsing, because the parsing
// failure mode is a blank field somebody notices and the coverage failure mode is a
// passing finding nobody questions. A pass over 3 of 4,000 tables that does not say so
// reads as "your estate is fine".

import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import type { CredentialProvider } from '../credentials.js';
import { COMPLETE, observed, unmeasurable, type CollectorContext, type SignalId, type SignalResult } from '../signal.js';
import { DescribeCollector, SAMPLE_SIGNAL } from './describe.js';
import type { SampleSelection, TableDetails } from './shapes.js';

const DETAILS = 'describe:storage.table_details' as SignalId;

/**
 * A credential provider the collector never calls, because the executor is injected.
 *
 * Built properly rather than cast into place: a cast would also have accepted the wrong
 * shape, and the reason this seam exists is that the same collectors run as a user and as
 * a service principal. A fixture that does not satisfy the interface is a fixture that
 * stops noticing when the interface changes.
 */
function userCredentials(): CredentialProvider {
  return {
    mode: 'on-behalf-of-user',
    databricks: () =>
      Promise.resolve({
        mode: 'on-behalf-of-user',
        actor: 'a@example.com',
        host: 'https://example.cloud.databricks.com',
        token: () => Promise.resolve('token'),
      }),
    cloud: () => Promise.resolve(null),
  };
}

function selection(count: number, eligible = count): SampleSelection {
  const candidates = Array.from({ length: count }, (_, index) => ({
    catalog: 'main',
    schema: 'sales',
    table: `t${String(index)}`,
    tableType: 'MANAGED',
    // Descending, so the first is the most read. The collector must preserve this order.
    readEvents: count - index,
  }));
  return { candidates, eligibleTables: eligible, activeTables: count };
}

/** One DESCRIBE DETAIL row, in the stringified shape the statement API actually returns. */
function detailRow(overrides: Record<string, unknown> = {}) {
  return {
    sizeInBytes: '1048576',
    numFiles: '4',
    partitionColumns: '[]',
    clusteringColumns: '[]',
    tableFeatures: '["appendOnly"]',
    clusterByAuto: 'false',
    ...overrides,
  };
}

function contextWith(sample: SignalResult | undefined): CollectorContext {
  const collected = new Map<SignalId, SignalResult>();
  if (sample != null) collected.set(SAMPLE_SIGNAL, sample);
  return { credentials: userCredentials(), scheduler: new CollectionScheduler(), collected };
}

describe('describing a sample of tables', () => {
  it('reports what it covered as a fraction of what it could have', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor, sampleLimit: 3 });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(3, 4000), 1, COMPLETE)));

    expect(result.status).toBe('observed');
    expect(result.coverage.mode).toBe('sampled');
    expect(result.coverage.examined).toBe(3);
    expect(result.coverage.population).toBe(4000);
    // The basis is shown to the user verbatim, so it has to say how the sample was picked
    // rather than merely that it was one.
    expect(result.coverage.basis).toContain('most-read');
  });

  it('claims complete coverage only when the sample reached every eligible table', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(2, 2), 1, COMPLETE)));

    expect(result.coverage.mode).toBe('complete');
  });

  it('reaches no further than the sample it was given', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor, sampleLimit: 3 });
    const sample = observed(SAMPLE_SIGNAL, selection(3, 4000), 1, { mode: 'complete', reach: 'metastore' });

    const [result] = await collector.collect([DETAILS], contextWith(sample));

    // This pass can only describe tables the sample named, so it cannot be a statement
    // about anything wider. A live scan stamped this signal with no reach at all, which
    // renders as an unqualified claim about the estate.
    expect(result.coverage.reach).toBe('metastore');
  });

  it('states metastore reach rather than none when the sample did not say', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(2, 2), 1, COMPLETE)));

    // The tables came from information_schema either way, so metastore is the honest floor.
    expect(result.coverage.reach).toBe('metastore');
  });

  it('parses the layout fields the statement API sends as JSON text', async () => {
    const executor = vi.fn().mockResolvedValue({
      data: [
        detailRow({
          partitionColumns: '["event_date","region"]',
          clusteringColumns: '["customer_id"]',
          tableFeatures: '["deletionVectors","rowTracking"]',
          clusterByAuto: 'true',
        }),
      ],
    });
    const collector = new DescribeCollector({ executor, sampleLimit: 1 });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(1), 1, COMPLETE)));
    const [table] = (result.value as TableDetails).tables;

    expect(table.partitionColumns).toEqual(['event_date', 'region']);
    expect(table.clusteringColumns).toEqual(['customer_id']);
    expect(table.features).toContain('deletionVectors');
    expect(table.automaticClustering).toBe(true);
    expect(table.sizeBytes).toBe(1_048_576);
  });

  it('quotes each part of the name so a table needing quoting still resolves', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor, sampleLimit: 1 });
    const sample = selection(1);
    const odd: SampleSelection = {
      ...sample,
      candidates: [{ ...sample.candidates[0], table: 'order details' }],
    };

    await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, odd, 1, COMPLETE)));

    expect(executor.mock.calls[0][0]).toBe('DESCRIBE DETAIL `main`.`sales`.`order details`');
  });

  it('describes the tables that work and records the ones that do not', async () => {
    const executor = vi
      .fn()
      .mockResolvedValueOnce({ data: [detailRow()] })
      .mockRejectedValueOnce(Object.assign(new Error('PERMISSION_DENIED'), { status: 403 }))
      .mockResolvedValueOnce({ data: [detailRow()] });
    const collector = new DescribeCollector({ executor, sampleLimit: 3 });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(3, 3), 1, COMPLETE)));
    const value = result.value as TableDetails;

    // A denial on one table must not end the pass — the other two are still evidence,
    // and a per-table permission gap is the normal case under on-behalf-of auth.
    expect(value.tables).toHaveLength(2);
    expect(value.undescribed).toHaveLength(1);
    expect(result.coverage.mode).toBe('sampled');
    expect(result.coverage.examined).toBe(2);
  });
});

describe('when the sample is missing', () => {
  it('says the ordering requirement was not met rather than reporting a clean estate', async () => {
    const executor = vi.fn();
    const collector = new DescribeCollector({ executor });

    const [result] = await collector.collect([DETAILS], contextWith(undefined));

    expect(result.status).toBe('unmeasurable');
    expect(result.unmeasurableReason).toContain('must run before this one');
    expect(executor).not.toHaveBeenCalled();
  });

  it('carries the sample collector’s own reason forward', async () => {
    const collector = new DescribeCollector({ executor: vi.fn() });
    const sample = unmeasurable(SAMPLE_SIGNAL, 'The warehouse refused the query.');

    const [result] = await collector.collect([DETAILS], contextWith(sample));

    expect(result.unmeasurableReason).toContain('The warehouse refused the query.');
  });

  it('reports an empty metastore as unmeasured, not as an estate without layout problems', async () => {
    const collector = new DescribeCollector({ executor: vi.fn() });

    const [result] = await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(0, 0), 1, COMPLETE)));

    expect(result.status).toBe('unmeasurable');
    expect(result.unmeasurableReason).toContain('cannot see them');
  });
});

describe('the footprint it reports', () => {
  it('counts one statement per table described', async () => {
    const executor = vi.fn().mockResolvedValue({ data: [detailRow()], statementId: 'stmt-1' });
    const collector = new DescribeCollector({ executor, sampleLimit: 2 });

    await collector.collect([DETAILS], contextWith(observed(SAMPLE_SIGNAL, selection(2), 1, COMPLETE)));
    const spend = collector.spent();

    expect(spend.surface).toBe('describe');
    expect(spend.calls).toBe(2);
    expect(spend.statementIds).toEqual(['stmt-1', 'stmt-1']);
  });
});
