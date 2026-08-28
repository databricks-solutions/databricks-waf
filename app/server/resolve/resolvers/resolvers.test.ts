// The registry checked against the catalogue.
//
// The failure this guards against is quiet: a resolver naming a control id that does
// not exist runs against nothing and is never called, and the control it was meant to
// answer reports as unmeasured. Both halves look fine in isolation, so nothing
// surfaces it except a test that compares the two lists.

import { describe, expect, it } from 'vitest';
import { loadCatalogue } from '../../catalogue/catalogue.js';
import { buildRegistry, resolvedControls } from './index.js';

const catalogue = loadCatalogue();
const catalogueIds = new Set(catalogue.controls.map((control) => control.id));

describe('resolver registry', () => {
  it('builds without a duplicate registration', () => {
    expect(() => buildRegistry()).not.toThrow();
  });

  it('names only controls that exist in the catalogue', () => {
    const unknown = resolvedControls().filter((id) => !catalogueIds.has(id));
    expect(unknown, `resolvers name controls absent from the catalogue: ${unknown.join(', ')}`).toEqual([]);
  });

  it('claims each control exactly once', () => {
    const seen = new Map<string, number>();
    for (const id of resolvedControls()) seen.set(id, (seen.get(id) ?? 0) + 1);
    const duplicated = [...seen.entries()].filter(([, count]) => count > 1).map(([id]) => id);
    expect(duplicated).toEqual([]);
  });

  it('marks every resolved control as implemented in the catalogue', () => {
    // The catalogue's evaluator_status is what the UI and the score reason from, so a
    // control with a working resolver still described as planned would understate what
    // the app measured.
    const mismatched = resolvedControls().filter((id) => {
      const control = catalogue.controls.find((candidate) => candidate.id === id);
      return control != null && control.evaluatorStatus !== 'implemented';
    });
    expect(mismatched, `resolved but not marked implemented: ${mismatched.join(', ')}`).toEqual([]);
  });

  it('leaves no control marked implemented without a resolver', () => {
    const resolved = new Set(resolvedControls());
    const promised = catalogue.controls
      .filter((control) => control.evaluatorStatus === 'implemented' && !resolved.has(control.id))
      .map((control) => control.id);
    expect(promised, `marked implemented but unresolved: ${promised.join(', ')}`).toEqual([]);
  });
});

describe('alias groups', () => {
  it('are shared by more than one control', () => {
    // A group of one is a typo — a control that meant to join a group and named it
    // slightly differently. It would score normally, so nothing else catches it.
    const lonely = [...catalogue.aliasGroups.entries()]
      .filter(([, controls]) => controls.length < 2)
      .map(([group]) => group);
    expect(lonely, `alias groups with a single member: ${lonely.join(', ')}`).toEqual([]);
  });

  it('are resolved consistently: either every member has a resolver or none does', () => {
    // A partly-resolved group scores from whichever member happens to be resolved,
    // and reports the rest as unmeasured, so the same requirement reads two ways in
    // two pillars.
    const resolved = new Set(resolvedControls());
    const split = [...catalogue.aliasGroups.entries()]
      .filter(([, controls]) => {
        const covered = controls.filter((control) => resolved.has(control.id)).length;
        return covered > 0 && covered < controls.length;
      })
      .map(([group]) => group);
    expect(split, `alias groups only partly resolved: ${split.join(', ')}`).toEqual([]);
  });
});
