// The maintenance controls, and not punishing an estate for delegating the work.
//
// The failure mode these defend against is the one that makes a score stop being read:
// telling a customer who enabled predictive optimization — the platform's own answer to
// this control — that they are failing it, because the platform found nothing to reclaim
// in the last thirty days. It is the same error as failing a serverless estate for having
// no cluster policies, and it was live for one deploy before these tests existed.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { MaintenanceRecency, PredictiveOptimizationCoverage } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const MAINTENANCE = 'sql:maintenance.recency' as SignalId;
const PO = 'describe:predictive_optimization.coverage' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

const DAY = 86_400_000;

function coverage(enabled: number, managed: number): PredictiveOptimizationCoverage {
  const state =
    managed === 0 || enabled === 0 ? ('disabled' as const) : enabled >= managed ? ('enabled' as const) : ('partial' as const);
  return {
    managedTables: managed,
    enabledTables: enabled,
    catalogs: [{ catalog: 'main', setting: enabled > 0 ? 'enable' : 'disable', managedTables: managed }],
    unreadable: [],
    state,
    summary: state,
  };
}

function unreadableCoverage(): PredictiveOptimizationCoverage {
  return {
    managedTables: 10,
    enabledTables: 0,
    catalogs: [{ catalog: 'main', setting: 'unknown', managedTables: 10 }],
    unreadable: [],
    state: 'unknown',
    summary: 'unknown',
  };
}

function ran(
  source: 'predictive_optimization' | 'manual' | 'manual_unresolved',
  operation: string,
  daysAgo: number
): MaintenanceRecency {
  return {
    operations: [{ source, operation, operations: 3, lastRun: new Date(Date.now() - daysAgo * DAY), tablesTouched: 2 }],
  };
}

function findingFor(po: PredictiveOptimizationCoverage, maintenance: MaintenanceRecency, controlId = 'CO-03-06') {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);

  const signals = new Map<SignalId, SignalResult>([
    [PO, observed(PO, po, 1, COMPLETE)],
    [MAINTENANCE, observed(MAINTENANCE, maintenance, 1, COMPLETE)],
  ]);
  return resolveControl(spec, signals, registry.get(controlId));
}

describe('VACUUM where predictive optimization is on', () => {
  it('credits the architecture even with no run in the window', () => {
    // The case that was failing live. Predictive optimization acts when files become
    // eligible, so a quiet window on a small or append-only estate means there was nothing
    // to reclaim — not that the maintenance is missing.
    const finding = findingFor(coverage(11, 11), { operations: [] });

    expect(finding.outcome).toBe('satisfied-by-architecture');
    expect(finding.outcomeReason).toMatch(/expected where no files became eligible/);
  });

  it('says a run happened when one did, as confirmation rather than as the test', () => {
    const finding = findingFor(coverage(11, 11), ran('predictive_optimization', 'VACUUM', 3));

    expect(finding.outcome).toBe('satisfied-by-architecture');
    expect(finding.evidence.map((e) => e.observed).join(' ')).toMatch(/ran VACUUM 3 times/);
  });

  it('states that enablement was read per catalog, so a pass is not read as per-table', () => {
    const finding = findingFor(coverage(11, 11), { operations: [] });

    expect(finding.outcomeReason).toMatch(/read per catalog/);
  });
});

describe('VACUUM where predictive optimization is not on', () => {
  it('fails when nothing is covered and no VACUUM was seen', () => {
    const finding = findingFor(coverage(0, 10), { operations: [] });

    expect(finding.outcome).toBe('fail');
    expect(finding.outcomeReason).toMatch(/10 managed tables are not covered/);
  });

  it('gives partial credit when part of the estate is covered', () => {
    // Half the estate is maintained by the platform and only the remainder is exposed.
    // Reporting that as a flat failure would erase the half that is handled.
    const finding = findingFor(coverage(5, 10), { operations: [] });

    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toMatch(/5 managed tables are not covered/);
  });

  it('passes on a recent manual VACUUM', () => {
    const finding = findingFor(coverage(0, 10), ran('manual', 'VACUUM', 3));

    expect(finding.outcome).toBe('pass');
  });

  it('does not credit a VACUUM that could not be attributed to the assessed population', () => {
    // Labs measured one ANALYZE of this shape; the same rule applies to VACUUM. Crediting it
    // would pass work done on a table outside the assessed catalogs.
    const finding = findingFor(coverage(0, 10), ran('manual_unresolved', 'VACUUM', 3));

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/could not be resolved/);
  });

  it('gives partial credit for a VACUUM older than the expected interval', () => {
    const finding = findingFor(coverage(0, 10), ran('manual', 'VACUUM', 90));

    expect(finding.outcome).toBe('partial');
    expect(finding.outcomeReason).toMatch(/90 days ago/);
  });

  it('names the classic-compute blind spot rather than asserting nothing ran', () => {
    // Query history omits commands run in notebooks on classic compute, so a nightly
    // VACUUM from a job cluster is invisible. A finding that did not say so would be
    // read as a measurement when it is an absence of evidence.
    const finding = findingFor(coverage(0, 10), { operations: [] });

    expect(finding.outcomeReason).toMatch(/notebooks on classic compute/);
  });
});

describe('VACUUM where the setting could not be read', () => {
  it('reports unmeasurable rather than guessing which way it falls', () => {
    // Whether absent manual VACUUM is a gap depends entirely on the setting. Guessing
    // enabled hides a real gap; guessing disabled invents one.
    const finding = findingFor(unreadableCoverage(), { operations: [] });

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toMatch(/No catalog reported a predictive optimization setting/);
  });
});

describe('predictive optimization coverage as a control', () => {
  it('is not applicable when there are no managed tables to maintain', () => {
    const finding = findingFor(coverage(0, 0), { operations: [] }, 'PE-03-05');

    expect(finding.outcome).toBe('not-applicable');
  });

  it('reports the share weighted by tables, and names the catalogs that are off', () => {
    const po: PredictiveOptimizationCoverage = {
      managedTables: 100,
      enabledTables: 4,
      catalogs: [
        { catalog: 'small', setting: 'enable', managedTables: 4 },
        { catalog: 'big', setting: 'disable', managedTables: 96 },
      ],
      unreadable: [],
      state: 'partial',
      summary: 'partial',
    };

    const finding = findingFor(po, { operations: [] }, 'PE-03-05');

    expect(finding.outcome).toBe('fail');
    const observed = finding.evidence.map((e) => e.observed).join(' ');
    expect(observed).toMatch(/4 of 100 managed tables/);
    // Naming the catalog is the difference between a number and an action.
    expect(observed).toMatch(/big \(disable\)/);
  });

  it('reports unmeasurable when no catalog stated a setting, not disabled', () => {
    const finding = findingFor(unreadableCoverage(), { operations: [] }, 'PE-03-05');

    expect(finding.outcome).toBe('unmeasurable');
  });
});
