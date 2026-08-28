// Cluster hardening, and the three ways an unwritten column could have become a wrong answer.
//
// The claim these tests defend is that a system table declining to answer is reported as
// unmeasured, never converted into a verdict. Two of these controls read columns the platform
// leaves unwritten on older cluster rows, and the tempting reading of each is a high severity
// failure: an unwritten access mode looks like no isolation, and an unwritten init-script list
// looks like no init scripts. One of those inflates the score and the other deflates it, and
// both would be caused by a system-table rollout date rather than by anything in the estate.
//
// Also defended: that the runtime control is a different question from the cost pillar's, and
// that a governed init-script location is not counted against a cluster for existing.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { ClusterRow } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CLUSTERS = 'sql:compute.clusters' as SignalId;
const PROFILE = 'sql:estate.compute_profile' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function cluster(overrides: Partial<ClusterRow> = {}): ClusterRow {
  return {
    workspaceId: '1',
    clusterId: 'c-1',
    name: 'analytics',
    source: 'UI',
    runtime: '15.4.x-scala2.12',
    dataSecurityMode: 'SINGLE_USER',
    hasPolicy: true,
    autoscaling: true,
    autoTerminates: true,
    gpuNode: false,
    initScriptCount: 0,
    dbfsInitScriptCount: 0,
    initScriptsKnown: true,
    tagCount: 2,
    workerCount: 2,
    minWorkers: 0,
    maxWorkers: 0,
    ...overrides,
  };
}

function findingFor(controlId: string, clusters: readonly ClusterRow[]) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  const signals = new Map<SignalId, SignalResult>([
    [CLUSTERS, observed(CLUSTERS, clusters, 1, { mode: 'complete' })],
    // The applicability precondition on all three: a non-zero classic cluster count, so the
    // control is assessed rather than excluded as serverless-only.
    [PROFILE, observed(PROFILE, { distinctClusters: clusters.length, summary: clusters.length }, 1, { mode: 'complete' })],
  ]);
  return resolveControl(spec, signals, registry.get(controlId));
}

describe('SCP-04-04, runtimes past end of support', () => {
  it('passes an estate entirely on supported runtimes', () => {
    const finding = findingFor('SCP-04-04', [cluster({ runtime: '15.4.x-scala2.12' }), cluster({ runtime: '16.4.x-photon-scala2.12' })]);
    expect(finding.outcome).toBe('pass');
  });

  it('fails a single unsupported cluster rather than averaging it away', () => {
    // The band is 1.0 to pass on purpose. Nine current clusters do not patch the tenth, and a
    // control that reported 90% as a pass would report an open vulnerability as compliance.
    const clusters: ClusterRow[] = Array.from({ length: 9 }, () => cluster({ runtime: '15.4.x-scala2.12' }));
    clusters.push(cluster({ name: 'legacy', runtime: '11.3.x-scala2.12' }));

    const finding = findingFor('SCP-04-04', clusters);

    expect(finding.outcome).not.toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('legacy on 11.3.x-scala2.12');
  });

  it('names the oldest runtime first when the list is truncated', () => {
    const clusters = [
      cluster({ name: 'a', runtime: '13.3.x-scala2.12' }),
      cluster({ name: 'b', runtime: '9.1.x-scala2.12' }),
      cluster({ name: 'c', runtime: '12.2.x-scala2.12' }),
    ];

    expect(findingFor('SCP-04-04', clusters).evidence[0]?.observed).toContain('b on 9.1.x-scala2.12');
  });

  it('counts an unparseable runtime as unsupported', () => {
    // The other direction would drop it from the denominator, so an estate running entirely on
    // something this app does not recognise would pass on a population of zero.
    expect(findingFor('SCP-04-04', [cluster({ runtime: 'custom-image' })]).outcome).toBe('fail');
  });

  it('says the requirement does not apply when there are no all-purpose clusters', () => {
    const finding = findingFor('SCP-04-04', [cluster({ source: 'JOB', runtime: '11.3.x-scala2.12' })]);
    expect(finding.outcome).toBe('not-applicable');
  });
});

describe('SCP-04-07, Unity Catalog access modes', () => {
  it('passes clusters in a Unity Catalog mode under either spelling', () => {
    const finding = findingFor('SCP-04-07', [
      cluster({ dataSecurityMode: 'SINGLE_USER' }),
      cluster({ dataSecurityMode: 'USER_ISOLATION' }),
      cluster({ dataSecurityMode: 'DATA_SECURITY_MODE_DEDICATED' }),
    ]);
    expect(finding.outcome).toBe('pass');
  });

  it('fails a cluster that bypasses the metastore, and names its mode', () => {
    const finding = findingFor('SCP-04-07', [
      cluster({ name: 'shared-legacy', dataSecurityMode: 'NONE' }),
      cluster({ dataSecurityMode: 'SINGLE_USER' }),
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[1]?.observed).toContain('shared-legacy (NONE)');
  });

  it('reports unmeasured rather than failing when no cluster records a mode', () => {
    // The case measured on the development workspace: zero of twenty rows carried the column,
    // because none of the clusters had been edited since it was added. Reading that as
    // no-isolation would have produced a high severity failure from a rollout date.
    const finding = findingFor('SCP-04-07', [
      cluster({ dataSecurityMode: undefined }),
      cluster({ dataSecurityMode: undefined }),
    ]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('gap in the system table');
  });

  it('measures over the clusters that do record a mode, and says so', () => {
    const finding = findingFor('SCP-04-07', [
      cluster({ dataSecurityMode: 'SINGLE_USER' }),
      cluster({ dataSecurityMode: undefined }),
    ]);

    expect(finding.outcome).toBe('pass');
    expect(finding.outcomeReason).toContain('1 of 2');
  });

  it('treats an access mode it does not recognise as ungoverned', () => {
    // The visible error rather than the invisible one: a new mode read as governed would
    // silently pass a cluster nobody has assessed.
    expect(findingFor('SCP-04-07', [cluster({ dataSecurityMode: 'SOMETHING_NEW' })]).outcome).toBe('fail');
  });
});

describe('SCP-04-16, init scripts on DBFS', () => {
  it('passes an estate whose clusters run no init scripts at all', () => {
    expect(findingFor('SCP-04-16', [cluster(), cluster()]).outcome).toBe('pass');
  });

  it('passes init scripts in a governed location', () => {
    // A cluster is not penalised for having init scripts. It is penalised for keeping them
    // somewhere anyone can rewrite.
    const finding = findingFor('SCP-04-16', [cluster({ initScriptCount: 2, dbfsInitScriptCount: 0 })]);
    expect(finding.outcome).toBe('pass');
  });

  it('fails a cluster running an init script from DBFS, and counts the scripts', () => {
    const finding = findingFor('SCP-04-16', [
      cluster({ name: 'etl', initScriptCount: 3, dbfsInitScriptCount: 2 }),
      cluster(),
    ]);

    expect(finding.outcome).toBe('fail');
    expect(finding.evidence[0]?.observed).toContain('2 init scripts across 1 of 2 clusters');
    expect(finding.evidence[1]?.observed).toContain('etl');
  });

  it('reports unmeasured when the system table did not record init scripts', () => {
    // The opposite trap to the access-mode one: here the tempting reading is a pass, and it
    // would credit every cluster in an estate the app could not see into.
    const finding = findingFor('SCP-04-16', [cluster({ initScriptsKnown: false })]);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.outcomeReason).toContain('did not report them');
  });

  it('includes job clusters, which also run init scripts', () => {
    // Unlike the other two, this population is every cluster rather than the all-purpose ones:
    // a job cluster running a rewritable init script is the same exposure.
    const finding = findingFor('SCP-04-16', [cluster({ source: 'JOB', dbfsInitScriptCount: 1 })]);
    expect(finding.outcome).toBe('fail');
  });
});
