// Naming the resources behind a share, and linking each to the page that fixes it.
//
// Through a real resolver rather than the helper alone, because the thing worth pinning is that a
// link survives the whole path — signal, resolver, finding — and reaches the reader. The helper
// composing a correct URL that nothing carries would pass a unit test and ship nothing.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { COMPLETE, observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ClusterRow, WarehouseRow, WorkspaceDirectory } from '../../collect/sql/shapes.js';
import type { Evidence } from '../finding.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CLUSTERS = 'sql:compute.clusters' as SignalId;
const WAREHOUSES = 'sql:compute.warehouses' as SignalId;
const WORKSPACES = 'sql:estate.workspaces' as SignalId;

const catalogue = loadCatalogue();
const registry = buildRegistry();

const HOST = 'https://dbc-example.cloud.databricks.com';

function cluster(name: string): ClusterRow {
  return {
    workspaceId: '1',
    clusterId: `c-${name}`,
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

const DIRECTORY: WorkspaceDirectory = {
  workspaces: [{ workspaceId: '1', name: 'field-eng', url: HOST, status: 'RUNNING', live: true }],
  live: [{ workspaceId: '1', name: 'field-eng', url: HOST, status: 'RUNNING', live: true }],
  excluded: [],
  regionUnverified: [],
  outOfScope: [],
};

/** CO-02-02 names the clusters that do not auto-terminate, so it is the shortest path in. */
function detail(clusters: readonly ClusterRow[], directory: WorkspaceDirectory = DIRECTORY): Evidence | undefined {
  const spec = catalogue.controls.find((control) => control.id === 'CO-02-02');
  if (spec == null) throw new Error('CO-02-02 is not in the catalogue');

  const warehouses: readonly WarehouseRow[] = [];
  const signals = new Map<SignalId, SignalResult>([
    [CLUSTERS, observed(CLUSTERS, clusters, 1, COMPLETE)],
    [WAREHOUSES, observed(WAREHOUSES, warehouses, 1, COMPLETE)],
    [WORKSPACES, observed(WORKSPACES, directory, 1, COMPLETE)],
  ]);

  const finding = resolveControl(spec, signals, registry.get('CO-02-02'));
  return finding.evidence.find((one) => one.signal === CLUSTERS && one.bearing === 'detail');
}

describe('naming the resources behind a finding', () => {
  it('links each named resource to its own page', () => {
    const evidence = detail([cluster('etl')]);

    expect(evidence?.observed).toBe('Without it: etl');
    expect(evidence?.at).toEqual({
      lead: 'Without it',
      // The kind rides along unrendered, so the inspector folding this list into another one can
      // tell a cluster called `etl` from a warehouse called `etl`. See `LocatedItemPayload.kind`.
      items: [{ label: 'etl', kind: 'cluster', url: `${HOST}/compute/clusters/c-etl?o=1` }],
    });
  });

  it('keeps the workspace out of the link and in the sentence', () => {
    // Four warehouses called "Serverless Starter Warehouse" in four workspaces are told apart only
    // by the parenthetical. Inside the link it reads as part of a name; outside it, it reads as
    // where to go. The sentence is identical either way.
    const evidence = detail([cluster('etl'), { ...cluster('etl'), workspaceId: '2', clusterId: 'c-etl-2' }], {
      workspaces: [
        { workspaceId: '1', name: 'field-eng', url: HOST, status: 'RUNNING', live: true },
        { workspaceId: '2', name: 'data-platform', url: HOST, status: 'RUNNING', live: true },
      ],
      live: [
        { workspaceId: '1', name: 'field-eng', url: HOST, status: 'RUNNING', live: true },
        { workspaceId: '2', name: 'data-platform', url: HOST, status: 'RUNNING', live: true },
      ],
      excluded: [],
      regionUnverified: [],
      outOfScope: [],
    });

    expect(evidence?.observed).toBe('Without it: etl (field-eng), etl (data-platform)');
    expect(evidence?.at?.items[0]).toEqual({
      label: 'etl',
      in: 'field-eng',
      kind: 'cluster',
      url: `${HOST}/compute/clusters/c-etl?o=1`,
    });
  });

  it('says the same thing in the sentence and in the list', () => {
    // The page renders one and the export renders the other, so a difference between them is a
    // difference between two files describing the same run.
    const evidence = detail(['a', 'b'].map(cluster));

    expect(evidence?.observed).toBe('Without it: a, b');
    expect(evidence?.at?.items.map((item) => item.label)).toEqual(['a', 'b']);
  });

  it('caps the list at five, and says how many are behind them', () => {
    // Seven links is a wall rather than an action, and the reader needs to know the list is
    // truncated: a finding naming five clusters in an estate of seven understates itself.
    const evidence = detail(['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(cluster));

    expect(evidence?.observed).toBe('Without it: a, b, c, d, e and 2 more');
    expect(evidence?.at?.items).toHaveLength(5);
    expect(evidence?.at?.more).toBe(2);
  });

  it('keeps the list when there is nowhere to link to', () => {
    // An account whose workspace directory is unreadable still gets the finding and still gets the
    // names. Only the links are lost, and the sentence reads identically without them.
    const evidence = detail([cluster('etl')], { workspaces: [], live: [], excluded: [], regionUnverified: [], outOfScope: [] });

    expect(evidence?.observed).toBe('Without it: etl');
    // The kind is not a link and does not go with them: it comes from the row rather than from the
    // directory, so it survives an account that cannot read one.
    expect(evidence?.at?.items).toEqual([{ label: 'etl', kind: 'cluster' }]);
  });

  it('carries no links at all when nothing falls short', () => {
    // Not an empty list, and not an empty "where" line either: a passing control has nowhere to
    // send anyone.
    const passing = { ...cluster('etl'), autoTerminates: true };

    expect(detail([passing])).toBeUndefined();
  });
});
