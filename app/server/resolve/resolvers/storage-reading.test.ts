// Two sources for one measurement, and what each entitles a finding to say.
//
// The behaviour under test is a fallback, so the interesting cases are the ones where the
// two sources disagree about how much they cover. A complete reading may state the estate's
// size; a sampled one may only state a floor, and a sampled pass has to say what it did not
// look at. A sampled *failure* says none of that, because a badly compacted table is badly
// compacted whether or not the rest were read.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { MaintenanceRecency, PredictiveOptimizationCoverage, StorageMetrics, TableDetails } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';
import { VOLUME_SIGNAL } from '../../collect/cloud/collector.js';
import { SAMPLE, SNAPSHOT } from './storage-reading.js';

const MAINTENANCE = 'sql:maintenance.recency' as SignalId;
const PO = 'describe:predictive_optimization.coverage' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

const MIB = 1024 ** 2;
const GIB = 1024 ** 3;

/** The empty snapshot, as the collector reports it on every estate seen so far. */
const EMPTY_SNAPSHOT = unmeasurable(
  SNAPSHOT,
  'The per-table storage snapshot (system.storage.table_metrics_history) has no rows for this metastore.'
);

function snapshot(overrides: Partial<StorageMetrics> = {}): SignalResult {
  const metrics: StorageMetrics = {
    snapshotAvailable: true,
    tableCount: 400,
    activeBytes: 800 * GIB,
    activeFiles: 4_000,
    predictiveOptimizationTables: 400,
    largest: [{ catalog: 'main', schema: 'sales', table: 'orders', activeBytes: 200 * GIB, activeFiles: 900, predictiveOptimization: true }],
    ...overrides,
  };
  return observed(SNAPSHOT, metrics, 1, COMPLETE);
}

function sample(sizes: readonly { readonly bytes: number; readonly files: number }[], eligible: number): SignalResult {
  const details: TableDetails = {
    tables: sizes.map((size, index) => ({
      catalog: 'main',
      schema: 'sales',
      table: `t${index}`,
      sizeBytes: size.bytes,
      fileCount: size.files,
      partitionColumns: [],
      clusteringColumns: [],
      features: [],
      properties: {},
      automaticClustering: false,
      readEvents: 1,
    })),
    eligibleTables: eligible,
    undescribed: [],
  };
  const covered = sizes.length >= eligible;
  return observed(SAMPLE, details, 1, covered ? COMPLETE : { mode: 'sampled', examined: sizes.length, population: eligible });
}

const NO_MAINTENANCE: MaintenanceRecency = { operations: [] };

const PO_ENABLED: PredictiveOptimizationCoverage = {
  managedTables: 10,
  enabledTables: 10,
  catalogs: [{ catalog: 'main', setting: 'enable', managedTables: 10 }],
  unreadable: [],
  state: 'enabled',
  summary: 'enabled',
};

/** Predictive optimization off everywhere, so partial credit has to be earned by a run rather than by it. */
const PO_DISABLED: PredictiveOptimizationCoverage = {
  managedTables: 10,
  enabledTables: 0,
  catalogs: [{ catalog: 'main', setting: 'inherit', managedTables: 10 }],
  unreadable: [],
  state: 'disabled',
  summary: 'disabled',
};

function findingFor(
  controlId: string,
  storage: readonly SignalResult[],
  over: { readonly maintenance?: MaintenanceRecency; readonly po?: PredictiveOptimizationCoverage } = {}
) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);

  const signals = new Map<SignalId, SignalResult>([
    [MAINTENANCE, observed(MAINTENANCE, over.maintenance ?? NO_MAINTENANCE, 1, COMPLETE)],
    [PO, observed(PO, over.po ?? PO_ENABLED, 1, COMPLETE)],
    ...storage.map((result) => [result.id, result] as const),
  ]);
  return resolveControl(spec, signals, registry.get(controlId));
}

function said(finding: { readonly evidence: readonly { readonly observed: string }[] }): string {
  return finding.evidence.map((item) => item.observed).join(' | ');
}

describe('which source answers', () => {
  it('prefers the complete snapshot when it has rows', () => {
    const finding = findingFor('CO-03-05', [snapshot(), sample([{ bytes: GIB, files: 10 }], 400)]);

    expect(said(finding)).toMatch(/800 GiB of active data across 400 tables/);
  });

  it('reports the finding as sampled when a sampled reading decided part of it', () => {
    // The total here is complete and the file-size judgement is not, and the weaker of the
    // two is what the finding may claim. Rounding that up to complete because the headline
    // number was complete is exactly the overstatement the coverage model exists to stop.
    const finding = findingFor('CO-03-05', [snapshot(), sample([{ bytes: GIB, files: 10 }], 400)]);

    expect(finding.coverage.mode).toBe('sampled');
  });

  it('is complete when the only reading it used was complete', () => {
    const finding = findingFor('CO-03-05', [snapshot()]);

    expect(finding.coverage.mode).toBe('complete');
    expect(said(finding)).toMatch(/Active files average 204\.8 MiB across the metastore/);
  });

  it('falls back to the per-table sample when the snapshot is empty', () => {
    // The case that had this control reporting no measurement while the numbers sat
    // collected in the sample.
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 40 * GIB, files: 100 }], 400)]);

    expect(finding.outcome).toBe('pass');
    expect(said(finding)).toMatch(/At least 40 GiB of active data, across the 1 table measured/);
    expect(finding.coverage.mode).toBe('sampled');
  });

  it('reports unmeasurable naming both sources when neither answered', () => {
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT]);

    expect(finding.outcome).toBe('unmeasurable');
    // Each source's own reason, because "permission denied" and "preview table is empty"
    // need different actions from whoever reads this.
    expect(finding.outcomeReason).toMatch(/has no rows for this metastore/);
    expect(finding.outcomeReason).toMatch(/DESCRIBE DETAIL pass was not collected/);
  });
});

describe('what a sampled reading may claim', () => {
  it('states a total as a floor rather than as the estate size', () => {
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 10 * GIB, files: 20 }], 400)]);

    expect(said(finding)).toMatch(/^At least/);
    expect(said(finding)).toMatch(/the total is a floor for the estate rather than its size/);
  });

  it('passes a small estate rather than reporting its file counts as a gap', () => {
    // Volume is still measurable on an estate too small to compact, so this is a pass with
    // the file-size question reported as inapplicable rather than as fragmentation.
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 600 * 1024, files: 3 }], 1)]);

    expect(finding.outcome).toBe('pass');
    expect(said(finding)).toMatch(/holds as much as one 16 MiB file/);
  });

  it('hedges a sampled pass, since nothing measured being wrong is not nothing being wrong', () => {
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 10 * GIB, files: 20 }], 400)]);

    expect(finding.outcome).toBe('pass');
    expect(finding.outcomeReason).toMatch(/rather than that every table is/);
  });

  it('does not hedge a sampled failure', () => {
    // Asymmetry: small files found in a sample are small files.
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 100 * MIB, files: 5_000 }], 400)]);

    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toMatch(/files are smaller than the size at which per-file overhead/);
    expect(finding.outcomeReason).not.toMatch(/rather than that every table/);
  });

  it('claims completeness when the sample covered every eligible table', () => {
    const finding = findingFor('CO-03-05', [EMPTY_SNAPSHOT, sample([{ bytes: 10 * GIB, files: 20 }], 1)]);

    expect(finding.coverage.mode).toBe('complete');
    expect(said(finding)).toMatch(/10 GiB of active data across 1 table/);
    expect(finding.outcomeReason).toBeUndefined();
  });

  it('states the cloud bill when a service credential answered, and does not need one to pass', () => {
    const billed = observed(
      VOLUME_SIGNAL,
      { provider: 'aws' as const, billedBytes: 50 * GIB, locations: 2 },
      1,
      COMPLETE
    );
    const withBill = findingFor('CO-03-05', [snapshot(), billed]);
    expect(withBill.outcome).toBe('pass');
    expect(said(withBill)).toMatch(/50 GiB billed across 2 external locations/);

    const without = findingFor('CO-03-05', [snapshot()]);
    expect(without.outcome).toBe('pass');
    expect(said(without)).not.toMatch(/billed/);
  });
});

describe('compaction from the same reading', () => {
  it('measures file sizes per table from the sample when the snapshot is empty', () => {
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT, sample([{ bytes: 10 * GIB, files: 20 }], 400)]);

    expect(finding.outcome).toBe('pass');
    expect(said(finding)).toMatch(/1 of 1 tables large enough to compact/);
  });

  it('names the worst tables rather than only an average', () => {
    // An average tells someone there is a problem; a table name tells them where to run
    // OPTIMIZE. The evidence has to carry the second to be worth acting on.
    const finding = findingFor('PE-03-11', [
      EMPTY_SNAPSHOT,
      sample(
        [
          { bytes: 10 * GIB, files: 20 },
          { bytes: 100 * MIB, files: 5_000 },
        ],
        400
      ),
    ]);

    expect(said(finding)).toMatch(/smallest average: main\.sales\.t1 at 20\.5 KiB/);
  });

  it('gives partial credit for small files where the mechanism is already running', () => {
    // Predictive optimization is enabled in this fixture: the gap is unclosed rather than
    // unaddressed, which is partial credit and not none.
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT, sample([{ bytes: 100 * MIB, files: 5_000 }], 400)]);

    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toMatch(/OPTIMIZE on the tables named above/);
  });

  it('does not advise enabling predictive optimization that is already enabled', () => {
    // Shipped that way for one deploy, on an estate where it was on everywhere. Advice a
    // reader can see is wrong costs the whole report its credibility, not just this line.
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT, sample([{ bytes: 100 * MIB, files: 5_000 }], 400)]);

    expect(finding.outcomeReason).toMatch(/Predictive optimization is already enabled/);
    expect(finding.outcomeReason).not.toMatch(/Enabling predictive optimization/);
  });

  /*
   * OPTIMIZE that ran and could not be tied to an assessed table. 36b added the `manual_unresolved`
   * source and gave this resolver the filter without the branch its two siblings got, so these runs
   * vanished: the count read zero, the evidence said "no OPTIMIZE was observed in the window", and a
   * partial became a fail. An estate that quotes its identifiers was failed for compaction it performed.
   */
  it('does not fail an estate for compaction it ran but could not attribute', () => {
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT, sample([{ bytes: 100 * MIB, files: 5_000 }], 400)], {
      maintenance: {
        operations: [{ source: 'manual_unresolved', operation: 'OPTIMIZE', operations: 4, lastRun: new Date('2026-08-01T00:00:00.000Z') }],
      },
      po: PO_DISABLED,
    });

    expect(finding.outcome).toBe('partial');
    expect(said(finding)).toMatch(/4 OPTIMIZE operations ran that could not be matched to an assessed table/);
    expect(said(finding)).not.toMatch(/No OPTIMIZE was observed/);
  });

  it('still says nothing ran when nothing did', () => {
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT, sample([{ bytes: 100 * MIB, files: 5_000 }], 400)], {
      po: PO_DISABLED,
    });

    expect(finding.outcome).toBe('fail');
    expect(said(finding)).toMatch(/No OPTIMIZE was observed in the window/);
  });

  it('does not apply where no table is large enough to compact', () => {
    // The live false positive: eleven tables totalling well under one target file size,
    // told their 26 KiB files were costing them scan performance.
    const finding = findingFor('PE-03-11', [
      EMPTY_SNAPSHOT,
      sample([{ bytes: 600 * 1024, files: 3 }, { bytes: 32 * 1024, files: 1 }], 2),
    ]);

    expect(finding.outcome).toBe('not-applicable');
    expect(finding.outcomeReason).toMatch(/holds as much as one 16 MiB file/);
  });

  it('reports unmeasurable rather than reading OPTIMIZE runs as compaction', () => {
    // An OPTIMIZE run says the intent exists, not that it kept up. Without sizes there is
    // no measurement, and query history cannot see notebook runs on classic compute
    // either — so the absence above is not evidence in the other direction.
    const finding = findingFor('PE-03-11', [EMPTY_SNAPSHOT]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/notebooks on classic compute/);
  });
});
