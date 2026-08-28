// Reading predictive optimization per catalog.
//
// The tests worth having here are the ones about what an absence means. This signal is
// read as an applicability precondition, so a wrong answer does not produce a wrong
// finding on this control — it silently removes the VACUUM and OPTIMIZE controls from the
// assessment, or puts them back demanding maintenance that is already automatic. The
// parsing is checked too, but the parsing failure mode is a visibly blank field.

import { describe, expect, it, vi } from 'vitest';
import { CollectionScheduler } from '../../scan/scheduler.js';
import type { CredentialProvider } from '../credentials.js';
import { COMPLETE, observed, unmeasurable, type CollectorContext, type SignalId, type SignalResult } from '../signal.js';
import { CATALOGS_SIGNAL, PO_SIGNAL, PredictiveOptimizationCollector } from './predictive-optimization.js';
import type { CatalogInventory, PredictiveOptimizationCoverage } from './shapes.js';

/** A credential provider the collector never calls, because the executor is injected. */
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

function inventory(...catalogs: readonly { name: string; managed: number }[]): CatalogInventory {
  return {
    catalogs: catalogs.map((catalog) => ({
      catalog: catalog.name,
      tableCount: catalog.managed,
      managedTables: catalog.managed,
      schemaCount: 1,
    })),
  };
}

/**
 * The two-column name/value listing `DESCRIBE CATALOG EXTENDED` returns.
 *
 * The surrounding rows are not padding. The parser has to find its row among them by
 * label, and a parser that took the first row or a fixed index would pass a fixture that
 * held only the row it wanted.
 */
function describeRows(setting: string | undefined) {
  return [
    { info_name: 'Catalog Name', info_value: 'main' },
    { info_name: 'Owner', info_value: 'someone@example.com' },
    ...(setting != null ? [{ info_name: 'Predictive Optimization', info_value: setting }] : []),
    { info_name: 'Storage Root', info_value: '' },
  ];
}

function contextWith(catalogs: SignalResult | undefined): CollectorContext {
  const collected = new Map<SignalId, SignalResult>();
  if (catalogs != null) collected.set(CATALOGS_SIGNAL, catalogs);
  return { credentials: userCredentials(), scheduler: new CollectionScheduler(), collected };
}

function catalogSignal(value: CatalogInventory): SignalResult {
  return observed(CATALOGS_SIGNAL, value, 1, COMPLETE);
}

async function coverageFrom(
  rowsPerCatalog: readonly (readonly Record<string, unknown>[])[],
  catalogs: CatalogInventory
): Promise<SignalResult> {
  let call = 0;
  const executor = vi.fn().mockImplementation(() => {
    const rows = rowsPerCatalog[call] ?? [];
    call += 1;
    return Promise.resolve({ data: rows });
  });
  const collector = new PredictiveOptimizationCollector({ executor });
  const [result] = await collector.collect([PO_SIGNAL], contextWith(catalogSignal(catalogs)));
  if (result == null) throw new Error('the collector returned no result');
  return result;
}

describe('reading the setting', () => {
  it('takes the state and where it was inherited from', async () => {
    const result = await coverageFrom(
      [describeRows('ENABLE (inherited from METASTORE metastore_aws_ap_southeast_2)')],
      inventory({ name: 'main', managed: 10 })
    );

    const value = result.value as PredictiveOptimizationCoverage;
    expect(value.catalogs[0]?.setting).toBe('enable');
    // Kept because it is the difference between an estate someone configured and one that
    // happens to sit under an enabled metastore, and the remediation differs.
    expect(value.catalogs[0]?.inheritedFrom).toBe('METASTORE metastore_aws_ap_southeast_2');
    expect(value.state).toBe('enabled');
  });

  it('reads a bare setting with no inheritance clause', async () => {
    const result = await coverageFrom([describeRows('DISABLE')], inventory({ name: 'main', managed: 10 }));

    const value = result.value as PredictiveOptimizationCoverage;
    expect(value.catalogs[0]?.setting).toBe('disable');
    expect(value.catalogs[0]?.inheritedFrom).toBeUndefined();
    expect(value.state).toBe('disabled');
  });

  it('calls a setting it cannot find unknown, not disabled', async () => {
    // A runtime that does not report the field, or a renamed label. Reading that as
    // disabled would make the VACUUM control start demanding manual maintenance that may
    // already be running automatically.
    const result = await coverageFrom([describeRows(undefined)], inventory({ name: 'main', managed: 10 }));

    const value = result.value as PredictiveOptimizationCoverage;
    expect(value.catalogs[0]?.setting).toBe('unknown');
    expect(value.state).toBe('unknown');
  });
});

describe('collapsing catalogs into one state', () => {
  it('weights by managed tables, not by catalog', async () => {
    // Three of four catalogs enabled sounds like 75%. It is 4%, because the fourth holds
    // almost everything — and the control that reads this decides whether the estate is
    // maintained, not whether its catalogs are tidy.
    const result = await coverageFrom(
      [describeRows('ENABLE'), describeRows('ENABLE'), describeRows('ENABLE'), describeRows('DISABLE')],
      inventory(
        { name: 'a', managed: 1 },
        { name: 'b', managed: 1 },
        { name: 'c', managed: 2 },
        { name: 'big', managed: 96 }
      )
    );

    const value = result.value as PredictiveOptimizationCoverage;
    expect(value.managedTables).toBe(100);
    expect(value.enabledTables).toBe(4);
    expect(value.state).toBe('partial');
  });

  it('reports enabled only when every managed table is covered', async () => {
    const result = await coverageFrom(
      [describeRows('ENABLE'), describeRows('ENABLE')],
      inventory({ name: 'a', managed: 5 }, { name: 'b', managed: 5 })
    );

    expect((result.value as PredictiveOptimizationCoverage).state).toBe('enabled');
  });

  it('treats a literal INHERIT as not enabled', async () => {
    // DESCRIBE reports the effective value with its origin, so a catalog under an enabled
    // metastore reads as ENABLE. A literal INHERIT therefore means the chain above it did
    // not resolve to enabled either.
    const result = await coverageFrom([describeRows('INHERIT')], inventory({ name: 'main', managed: 10 }));

    const value = result.value as PredictiveOptimizationCoverage;
    expect(value.catalogs[0]?.setting).toBe('inherit');
    expect(value.enabledTables).toBe(0);
    expect(value.state).toBe('disabled');
  });
});

describe('what it claims to have covered', () => {
  it('claims complete when it read every catalog holding a table', async () => {
    const result = await coverageFrom(
      [describeRows('ENABLE'), describeRows('ENABLE')],
      inventory({ name: 'a', managed: 5 }, { name: 'b', managed: 5 })
    );

    expect(result.coverage.mode).toBe('complete');
  });

  it('claims sampled when a catalog went unread, rather than counting it as enabled', async () => {
    // The unread catalog is exactly the one that could turn this estate from enabled to
    // partial, so a complete claim here would be the claim that matters most and is wrong.
    let call = 0;
    const executor = vi.fn().mockImplementation(() => {
      call += 1;
      if (call === 2) return Promise.reject(new Error('PERMISSION_DENIED'));
      return Promise.resolve({ data: describeRows('ENABLE') });
    });
    const collector = new PredictiveOptimizationCollector({ executor });

    const [result] = await collector.collect(
      [PO_SIGNAL],
      contextWith(catalogSignal(inventory({ name: 'a', managed: 5 }, { name: 'b', managed: 5 })))
    );

    expect(result?.status).toBe('observed');
    expect(result?.coverage.mode).toBe('sampled');
    expect(result?.coverage.examined).toBe(1);
    expect(result?.coverage.population).toBe(2);
    const value = result?.value as PredictiveOptimizationCoverage;
    expect(value.unreadable).toHaveLength(1);
    expect(value.unreadable[0]?.catalog).toBe('b');
    // Only the catalogs it read are in the denominator. Counting the unread one as
    // enabled would be a fabrication; counting it as disabled would be a different one.
    expect(value.managedTables).toBe(5);
  });

  it('inherits reach from the inventory it was given', async () => {
    const result = await coverageFrom([describeRows('ENABLE')], inventory({ name: 'main', managed: 1 }));

    // Read from the catalogs the inventory named, so the claim can be no broader than
    // information_schema, which is where they came from.
    expect(result.coverage.reach).toBe('metastore');
  });
});

describe('when there is nothing to read', () => {
  it('reports unmeasurable, not coverage of zero, when no catalog holds a table', async () => {
    const executor = vi.fn();
    const collector = new PredictiveOptimizationCollector({ executor });

    const [result] = await collector.collect([PO_SIGNAL], contextWith(catalogSignal(inventory())));

    expect(result?.status).toBe('unmeasurable');
    // Coverage of zero would read as predictive optimization being switched off, which
    // would put the VACUUM control into the score demanding maintenance for no tables.
    expect(result?.unmeasurableReason).toMatch(/nothing for predictive optimization to maintain/);
    expect(executor).not.toHaveBeenCalled();
  });

  it('names its missing input rather than describing nothing', async () => {
    const collector = new PredictiveOptimizationCollector({ executor: vi.fn() });

    const [result] = await collector.collect([PO_SIGNAL], contextWith(undefined));

    expect(result?.status).toBe('unmeasurable');
    expect(result?.unmeasurableReason).toMatch(/must run before this one/);
  });

  it('passes on the reason its input gave', async () => {
    const collector = new PredictiveOptimizationCollector({ executor: vi.fn() });

    const [result] = await collector.collect(
      [PO_SIGNAL],
      contextWith(unmeasurable(CATALOGS_SIGNAL, 'The user cannot read information_schema.'))
    );

    expect(result?.unmeasurableReason).toMatch(/cannot read information_schema/);
  });

  it('reports unmeasurable when no catalog could be described', async () => {
    const executor = vi.fn().mockRejectedValue(new Error('PERMISSION_DENIED'));
    const collector = new PredictiveOptimizationCollector({ executor });

    const [result] = await collector.collect(
      [PO_SIGNAL],
      contextWith(catalogSignal(inventory({ name: 'main', managed: 5 })))
    );

    expect(result?.status).toBe('unmeasurable');
    expect(result?.unmeasurableReason).toMatch(/PERMISSION_DENIED/);
  });
});

describe('the statement it issues', () => {
  it('quotes the catalog name, doubling any backtick it contains', async () => {
    const executor = vi.fn().mockResolvedValue({ data: describeRows('ENABLE') });
    const collector = new PredictiveOptimizationCollector({ executor });

    await collector.collect([PO_SIGNAL], contextWith(catalogSignal(inventory({ name: 'od`d', managed: 1 }))));

    // Identifiers cannot be bound as parameters, so the name is interpolated. Doubling the
    // backtick is what stops a name containing one from terminating the quoting early.
    expect(executor).toHaveBeenCalledWith('DESCRIBE CATALOG EXTENDED `od``d`', {}, expect.anything());
  });

  it('stops at the catalog limit', async () => {
    const executor = vi.fn().mockResolvedValue({ data: describeRows('ENABLE') });
    const collector = new PredictiveOptimizationCollector({ executor, catalogLimit: 2 });

    const [result] = await collector.collect(
      [PO_SIGNAL],
      contextWith(
        catalogSignal(inventory({ name: 'a', managed: 1 }, { name: 'b', managed: 1 }, { name: 'c', managed: 1 }))
      )
    );

    expect(executor).toHaveBeenCalledTimes(2);
    expect(result?.coverage.mode).toBe('sampled');
    expect(result?.coverage.population).toBe(3);
  });
});
