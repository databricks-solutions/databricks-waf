// Naming a resource so its owner can find it.
//
// The account-reach change made this a correctness question rather than a cosmetic one.
// When every workspace in the account is assessed at once, "cluster `etl` does not
// auto-terminate" names a resource that may exist in four of them. These tests pin the
// two halves of the answer: qualify when there is ambiguity, stay quiet when there is not.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ClusterRow, WarehouseRow, WorkspaceDirectory, WorkspaceRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CLUSTERS = 'sql:compute.clusters' as SignalId;
const WAREHOUSES = 'sql:compute.warehouses' as SignalId;
const WORKSPACES = 'sql:estate.workspaces' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

function cluster(name: string, workspaceId: string): ClusterRow {
  return {
    workspaceId,
    clusterId: `c-${name}-${workspaceId}`,
    name,
    source: 'UI',
    hasPolicy: false,
    autoscaling: false,
    autoTerminates: false,
    gpuNode: false,
    initScriptCount: 0,
    dbfsInitScriptCount: 0,
    initScriptsKnown: true,
    tagCount: 0,
    workerCount: 2,
    minWorkers: 0,
    maxWorkers: 0,
  };
}

function workspace(id: string, name: string, live = true): WorkspaceRow {
  return { workspaceId: id, name, status: live ? 'RUNNING' : 'CANCELLED', live };
}

function directory(...workspaces: readonly WorkspaceRow[]): WorkspaceDirectory {
  return {
    workspaces,
    live: workspaces.filter((w) => w.live),
    excluded: workspaces.filter((w) => !w.live).map((w) => ({ ...w, reason: 'not-running' as const })),
    regionUnverified: [],
    outOfScope: [],
  };
}

/** CO-02-02 names the clusters that do not auto-terminate, so it is the shortest path in. */
function autoTerminationEvidence(
  clusters: readonly ClusterRow[],
  workspaces: SignalResult | undefined,
): string {
  const spec = catalogue.controls.find((control) => control.id === 'CO-02-02');
  if (spec == null) throw new Error('CO-02-02 is not in the catalogue');

  const warehouses: readonly WarehouseRow[] = [];
  const signals = new Map<SignalId, SignalResult>([
    [CLUSTERS, observed(CLUSTERS, clusters, 1, COMPLETE)],
    [WAREHOUSES, observed(WAREHOUSES, warehouses, 1, COMPLETE)],
  ]);
  if (workspaces != null) signals.set(WORKSPACES, workspaces);

  const finding = resolveControl(spec, signals, registry.get('CO-02-02'));
  // The detail line, not the outcome line: the count belongs to the measurement and the names
  // belong to the answer to "where". See `offenders`.
  return finding.evidence.find((e) => e.signal === CLUSTERS && e.bearing === 'detail')?.observed ?? '';
}

describe('naming resources across workspaces', () => {
  it('says which workspace a resource is in when more than one was assessed', () => {
    const observedDirectory = observed(
      WORKSPACES,
      directory(workspace('1', 'field-eng'), workspace('2', 'data-platform')),
      1,
      COMPLETE,
    );

    const evidence = autoTerminationEvidence([cluster('etl', '1'), cluster('etl', '2')], observedDirectory);

    expect(evidence).toContain('etl (field-eng)');
    expect(evidence).toContain('etl (data-platform)');
  });

  it('does not qualify names in a single-workspace estate, where the suffix is only noise', () => {
    const observedDirectory = observed(WORKSPACES, directory(workspace('1', 'field-eng')), 1, COMPLETE);

    const evidence = autoTerminationEvidence([cluster('etl', '1')], observedDirectory);

    expect(evidence).toContain('etl');
    expect(evidence).not.toContain('field-eng');
  });

  it('counts only live workspaces when deciding there is ambiguity to resolve', () => {
    // Two workspaces in the account, one cancelled. Nothing was assessed in the second, so
    // there is no ambiguity and no reason to lengthen every name.
    const observedDirectory = observed(
      WORKSPACES,
      directory(workspace('1', 'field-eng'), workspace('2', 'old-poc', false)),
      1,
      COMPLETE,
    );

    const evidence = autoTerminationEvidence([cluster('etl', '1')], observedDirectory);

    expect(evidence).not.toContain('field-eng');
  });

  it('falls back to the bare name rather than reporting unmeasurable when the directory is unreadable', () => {
    // Only the labelling was lost. The evidence for the control itself was collected, so
    // the finding must still be produced.
    const evidence = autoTerminationEvidence(
      [cluster('etl', '1')],
      unmeasurable(WORKSPACES, 'system.access.workspaces_latest was denied.'),
    );

    expect(evidence).toContain('etl');
  });

  it('prints the id when a resource names a workspace the directory does not list', () => {
    // A resource from a workspace created after the directory row was written. Printing the
    // id is worse than a name and better than dropping the resource from the finding.
    const observedDirectory = observed(
      WORKSPACES,
      directory(workspace('1', 'field-eng'), workspace('2', 'data-platform')),
      1,
      COMPLETE,
    );

    const evidence = autoTerminationEvidence([cluster('etl', '9999')], observedDirectory);

    expect(evidence).toContain('etl (workspace 9999)');
  });
});
