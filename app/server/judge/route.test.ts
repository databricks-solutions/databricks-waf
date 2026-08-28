import { describe, expect, it } from 'vitest';

import { loadCatalogue } from '../catalogue/catalogue.js';
import { beyondAnyInstall, descriptorsById } from '../plan/plan.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ELIGIBLE } from './eligibility.js';
import { judgmentRoutes } from './route.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();
const descriptors = descriptorsById();
const routes = judgmentRoutes(catalogue, registry, descriptors);

const routeOf = (id: string) => routes.get(id)?.route;
const verdictOf = (id: string) =>
  catalogue.controls.find((control) => control.id === id)?.attestation?.askedBecause?.verdict;

describe('what may produce a verdict for a requirement', () => {
  it('routes every requirement, and never twice', () => {
    // The property the deferral of the model phases rests on: a check can refuse a requirement that
    // reaches a model without a route, and a paragraph cannot.
    expect(routes.size).toBe(catalogue.controls.length);
    for (const control of catalogue.controls) expect(routes.get(control.id)?.route).toBeDefined();
  });

  it('gives every route a reason a reader of the ledger can check', () => {
    for (const [id, routing] of routes) {
      expect(routing.why.trim(), `${id} is routed with no reason`).not.toBe('');
    }
  });

  it('sends a requirement a resolver answers to the reading, not to a model', () => {
    // DG-01-06 is the worked case. It was on the advisor plan's eligible list, was recorded as owed a
    // measure, and 37k paid that debt — so the same requirement the plan argued eligibility from is
    // deterministic now, without anybody editing a list.
    expect(routeOf('DG-01-06')).toBe('deterministic');
    expect(ELIGIBLE['DG-01-06']).toBeUndefined();
  });

  it('routes a requirement whose every reading wants an ungrantable scope as evidence-incomplete', () => {
    // Written, correct, and unable to run anywhere (ADR 0016). There is nothing to judge over, which
    // is a different thing from a rubric nobody has written.
    const beyond = catalogue.controls.filter(
      (control) => control.measurability !== 'attestation' && beyondAnyInstall(control, registry, descriptors)
    );

    expect(beyond.length).toBeGreaterThan(0);
    for (const control of beyond) expect(routeOf(control.id)).toBe('evidence-incomplete');
  });

  it('has no requirement still recorded as owed a measure', () => {
    // 37j paid the last one. The rule in route.ts still routes an owed measure to deterministic,
    // and this is what fails if a question is marked owed without a reading.
    const owed = catalogue.controls.filter(
      (control) => control.attestation?.askedBecause?.verdict === 'owed-a-measure'
    );

    expect(owed.map((control) => control.id)).toEqual([]);
  });

  it('leaves a partial-telemetry question nobody authored evidence-incomplete rather than deterministic', () => {
    // The plan calls thirteen of these "deterministic-first", which is a statement about the route they
    // take once they gain a reading. Calling them deterministic now would claim a rule was applied when
    // none exists.
    const unauthored = catalogue.controls.filter(
      (control) =>
        control.measurability === 'attestation' &&
        control.attestation?.askedBecause?.verdict === 'partial-telemetry' &&
        ELIGIBLE[control.id] == null
    );

    expect(unauthored.length).toBeGreaterThan(0);
    for (const control of unauthored) expect(routeOf(control.id)).toBe('evidence-incomplete');
  });

  it('makes a beyond-telemetry question nobody authored a person’s answer', () => {
    const unauthored = catalogue.controls.filter(
      (control) =>
        control.attestation?.askedBecause?.verdict === 'beyond-telemetry' && ELIGIBLE[control.id] == null
    );

    expect(unauthored.length).toBeGreaterThan(0);
    for (const control of unauthored) expect(routeOf(control.id)).toBe('human-accountable');
  });

  it('declares a packet class on the eligible route and on no other', () => {
    for (const [id, routing] of routes) {
      if (routing.route === 'llm-eligible') expect(routing.packet, `${id} is eligible over nothing`).toBeDefined();
      else expect(routing.packet, `${id} is not eligible and declares a packet`).toBeUndefined();
    }
  });

  it('judges a requirement nothing records over declarations alone, and says so', () => {
    // The advisor plan's condition for permitting these at all: the verdict inherits the declaration's
    // authority, so the packet class has to be stated rather than assumed.
    for (const [id, entry] of Object.entries(ELIGIBLE)) {
      const wanted = verdictOf(id) === 'beyond-telemetry' ? 'declarations-only' : 'evidence';
      expect(entry.packet, `${id} is ${String(verdictOf(id))}`).toBe(wanted);
    }
  });

  it('names no requirement the catalogue does not have', () => {
    const known = new Set(catalogue.controls.map((control) => control.id));
    for (const id of Object.keys(ELIGIBLE)) expect(known.has(id), `${id} is not in the catalogue`).toBe(true);
  });

  it('says what a rubric would weigh, rather than restating the catalogue', () => {
    // The entry requirement for the table, and the thing that stops it growing to the whole catalogue:
    // an entry has to say what a model would synthesize that the reading does not already settle.
    for (const [id, entry] of Object.entries(ELIGIBLE)) {
      const control = catalogue.controls.find((one) => one.id === id);
      expect(entry.why.length, `${id} explains itself in a phrase`).toBeGreaterThan(60);
      expect(entry.why, `${id} restates its own title`).not.toBe(control?.title);
      expect(entry.why, `${id} copies the catalogue’s reason`).not.toBe(control?.attestation?.askedBecause?.why);
    }
  });
});
