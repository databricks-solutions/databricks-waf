// The scope table's job is to stop the assessment promising checks that are not coming, so what is
// tested here is mostly that it still covers the catalogue. A new control naming an endpoint nobody
// has classified would report as an unbuilt check, which is a promise this project cannot keep.

import { describe, expect, it } from 'vitest';

import { loadCatalogue } from '../../catalogue/catalogue.js';
import { API_FAMILIES, beyondAnyApp, familyOf } from './families.js';

describe('familyOf', () => {
  it('reads the plane from the collector rather than the path', () => {
    // The same path on the two planes, which is not hypothetical: SCP-03-06 reaches the workspaces
    // endpoint from a workspace collector and SCP-03-03 from an account one.
    expect(familyOf('rest:account:accounts.workspaces')?.plane).toBe('account');
    expect(familyOf('rest:workspace:accounts.workspaces')?.plane).toBe('account');
  });

  it('classifies an account collector it has never seen, because the plane is the whole answer', () => {
    const family = familyOf('rest:account:accounts.something.invented');
    expect(family?.grantable).toBe(false);
    expect(family?.plane).toBe('account');
  });

  it('prefers the longest matching prefix, so a narrower family keeps its own scope name', () => {
    expect(familyOf('rest:workspace:unity-catalog.metastores')?.scope).toBe('unity-catalog');
    expect(familyOf('rest:workspace:unity-catalog.recipients')?.scope).toBe('sharing');
  });

  it('says nothing about a collector that is not a control-plane call', () => {
    expect(familyOf('sql:compute.clusters')).toBeUndefined();
    expect(familyOf('describe:tables')).toBeUndefined();
    expect(familyOf(undefined)).toBeUndefined();
  });

  it('treats an unclassified workspace endpoint as unbuilt rather than unreachable', () => {
    // The conservative direction on purpose. Claiming a platform limit that was never measured
    // would let unfinished work hide behind it, and nobody would go looking.
    expect(beyondAnyApp('rest:workspace:some-new-api.list')).toBe(false);
  });
});

describe('the catalogue', () => {
  const controls = loadCatalogue().controls;
  const restControls = controls.filter((control) => control.collector?.startsWith('rest:') === true);

  it('names control-plane endpoints, so this table has something to classify', () => {
    expect(restControls.length).toBeGreaterThan(30);
  });

  it('has every one of them classified', () => {
    const unclassified = restControls.filter((control) => familyOf(control.collector) == null);
    expect(
      unclassified.map((control) => `${control.id} ${control.collector ?? ''}`),
      'add the family to API_FAMILIES: an unclassified endpoint reports as a check that is planned, ' +
        'and if it is in fact ungrantable that is a roadmap promise nobody can keep'
    ).toEqual([]);
  });

  it('grants no scope the ADR did not record as accepted', () => {
    // ADR 0016 probed all 56 published scopes against the Apps registry and listed the nine it
    // accepts. Anything marked grantable here has to be one of them, or the table is asserting an
    // authority the platform has already refused.
    const accepted = new Set([
      'ai-gateway',
      'apps',
      'files',
      'genie',
      'model-serving',
      'postgres',
      'sql',
      'vector-search',
    ]);
    const overclaimed = API_FAMILIES.filter((family) => family.grantable && !accepted.has(family.scope));
    expect(overclaimed.map((family) => `${family.prefix} wants ${family.scope}`)).toEqual([]);
  });
});
