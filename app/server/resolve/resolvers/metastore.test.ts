// The two requirements answered by the assessment having run.
//
// What is worth testing here is not the pass — it is unconditional — but the claim that justifies
// it. These controls exist because the endpoint the catalogue names is unreachable, and they were
// about to be put to a person; the argument for reading them instead is that a workspace with no
// metastore assignment cannot produce the census at all. So the case that matters is the absent
// signal: it has to report unmeasured, because the moment it reported a pass without the census the
// control would be asserting the premise instead of observing it.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { observed, unmeasurable, type SignalId, type SignalResult } from '../../collect/signal.js';
import type { AssetCensus } from '../../collect/sql/shapes.js';
import { resolveControl } from '../resolver.js';
import { buildRegistry } from './index.js';

const CENSUS = 'sql:uc.census' as SignalId;
const catalogue = loadCatalogue();
const registry = buildRegistry();

function census(overrides: Partial<AssetCensus> = {}): AssetCensus {
  return {
    tableCount: 120,
    catalogCount: 4,
    schemaCount: 18,
    managedTables: 100,
    externalTables: 20,
    views: 12,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 118,
    icebergTables: 2,
    optimizedFormatTables: 120,
    describedTables: 60,
    distinctOwners: 5,
    databricksOwnedTables: 0,
    databricksOwnedCatalogs: '',
    ...overrides,
  };
}

function findingFor(controlId: string, signals: Map<SignalId, SignalResult>) {
  const spec = catalogue.controls.find((control) => control.id === controlId);
  if (spec == null) throw new Error(`${controlId} is not in the catalogue`);
  return resolveControl(spec, signals, registry.get(controlId));
}

function withCensus(controlId: string, overrides: Partial<AssetCensus> = {}) {
  return findingFor(controlId, new Map([[CENSUS, observed(CENSUS, census(overrides), 1, { mode: 'complete' })]]));
}

describe('SCP-04-14, a Unity Catalog metastore exists', () => {
  it('passes on the strength of the census having answered', () => {
    const finding = withCensus('SCP-04-14');
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('4 catalogs');
  });

  it('passes an empty metastore, because emptiness is not absence', () => {
    // ADR 0014's empty-estate rule does not apply: this is not a ratio over a population. A
    // metastore with nothing in it still exists, and reporting it not-applicable would leave the
    // governance pillar's premise permanently unstated.
    expect(withCensus('SCP-04-14', { tableCount: 0, catalogCount: 0, schemaCount: 0 }).outcome).toBe('pass');
  });

  it('reports unmeasured when the census could not be collected, rather than passing anyway', () => {
    const finding = findingFor(
      'SCP-04-14',
      new Map([[CENSUS, unmeasurable(CENSUS, 'METASTORE_NOT_ASSIGNED: no metastore assigned to this workspace')]])
    );
    expect(finding.outcome).toBe('unmeasurable');
  });
});

describe('SCP-04-10, the workspace is assigned to it', () => {
  it('passes, and counts what the metastore governs', () => {
    const finding = withCensus('SCP-04-10');
    expect(finding.outcome).toBe('pass');
    expect(finding.evidence[0]?.observed).toContain('governing 120 tables');
  });

  it('never claims the governed count is the whole estate', () => {
    // The regression this guards is the one that shipped: the sentence read "all 120 tables are
    // governed by it", derived from a legacy-metastore count that `system.information_schema`
    // cannot see and which was therefore always zero. Assignment is not adoption, and this
    // control asks only about assignment — so it may state what the metastore governs and may
    // not imply that is everything there is.
    const observed = withCensus('SCP-04-10').evidence[0]?.observed ?? '';
    expect(observed).not.toMatch(/\ball\b/i);
    expect(observed).not.toMatch(/hive/i);
  });

  it('reports unmeasured with no census, since the census is the evidence', () => {
    const finding = findingFor('SCP-04-10', new Map([[CENSUS, unmeasurable(CENSUS, 'query refused')]]));
    expect(finding.outcome).toBe('unmeasurable');
  });
});

describe('the pair, as the catalogue now describes them', () => {
  it('is no longer routed to a person, because the app reads them', () => {
    for (const id of ['SCP-04-10', 'SCP-04-14']) {
      expect(registry.get(id), `${id} needs a resolver or it goes back on the attestation page`).toBeDefined();
      expect(catalogue.controls.find((control) => control.id === id)?.measurability).toBe('derived');
    }
  });
});
