// Splitting a score's movement between the estate and the catalogue.
//
// The thing these tests are really guarding is the claim the split makes to the reader: that the
// estate half is a like-for-like comparison. Every case below is a way the arithmetic could quietly
// stop being like-for-like — a renumbered requirement, a re-severitied one, one only one run
// produced a finding for — and the assertion is that it is excluded rather than absorbed.

import { describe, expect, it } from 'vitest';
import { attribute } from './attribution.js';
import type { CatalogueSpan } from '../catalogue/changelog.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from './scan.js';
import { CollectionScheduler } from './scheduler.js';

function finding(controlId: string, outcome: Finding['outcome'], severity: Finding['severity'] = 'high'): Finding {
  return {
    controlId,
    pillarId: 'reliability',
    principleId: 'rel-1',
    title: controlId,
    outcome,
    severity,
    coverage: { mode: 'complete' },
    evidence: [],
  };
}

function scan(overall: number, findings: readonly Finding[], id = 'run'): Scan {
  return {
    id,
    startedAt: new Date('2026-08-01T09:00:00.000Z'),
    finishedAt: new Date('2026-08-01T10:00:00.000Z'),
    state: 'complete',
    stamp: {
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: findings.length,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: findings.length,
      overall,
    },
    findings: [...findings],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function span(overrides: Partial<CatalogueSpan> = {}): CatalogueSpan {
  return { describable: true, added: [], removed: [], renamed: new Map(), changed: [], versions: ['4'], ...overrides };
}

describe('how much of a score movement is the estate', () => {
  it('attributes the whole movement to the estate when the catalogue asked the same questions', () => {
    const later = scan(50, [finding('a', 'fail'), finding('b', 'pass')]);
    const earlier = scan(100, [finding('a', 'pass'), finding('b', 'pass')], 'older');

    const split = attribute(later, earlier, span());

    expect(split?.estate).toBe(-50);
    expect(split?.catalogue).toBe(0);
    expect(split?.stable).toBe(2);
  });

  it('attributes a movement caused by an arriving requirement to the catalogue, not the customer', () => {
    // Nothing about `a` or `b` moved; the whole fall is the new failing requirement.
    const later = scan(66.67, [finding('a', 'pass'), finding('b', 'pass'), finding('c', 'fail')]);
    const earlier = scan(100, [finding('a', 'pass'), finding('b', 'pass')], 'older');

    const split = attribute(later, earlier, span({ added: ['c'] }));

    expect(split?.estate).toBe(0);
    expect(split?.catalogue).toBe(-33.33);
    expect(split?.added).toBe(1);
  });

  it('scores a renumbered requirement as one requirement rather than dropping both of its names', () => {
    const later = scan(50, [finding('a2', 'fail')]);
    const earlier = scan(100, [finding('a1', 'pass')], 'older');

    const split = attribute(later, earlier, span({ renamed: new Map([['a1', 'a2']]) }));

    expect(split?.stable).toBe(1);
    expect(split?.estate).toBe(-100);
    expect(split?.renamed).toBe(1);
  });

  it('does not compare two different requirements that shared an id across the span', () => {
    // `a1` was renumbered onto `b`, which a different requirement had vacated earlier in the span.
    // The earlier run holds a finding under each name, and both point at `b` once restated.
    const later = scan(50, [finding('b', 'fail')]);
    const earlier = scan(100, [finding('a1', 'pass'), finding('b', 'fail')], 'older');

    const split = attribute(later, earlier, span({ removed: ['b'], renamed: new Map([['a1', 'b']]) }));

    // One requirement compared, not two averaged onto one id. `a1` passed and now fails, so the
    // whole of the estate half is that; the departed `b` contributes nothing, because the later run
    // holds no answer to it. Averaging the pair would have halved the fall to -50.
    expect(split?.stable).toBe(1);
    expect(split?.estate).toBe(-100);
  });

  it('keeps a requirement whose definition moved out of the estate half', () => {
    const later = scan(50, [finding('a', 'fail'), finding('b', 'pass')]);
    const earlier = scan(100, [finding('a', 'pass'), finding('b', 'pass')], 'older');

    const split = attribute(later, earlier, span({ changed: [{ id: 'a', fields: ['severity'] }] }));

    // `b` is the only like-for-like requirement and it did not move, so none of the fall is the
    // estate — even though a control did go from pass to fail, its terms changed at the same time.
    expect(split?.stable).toBe(1);
    expect(split?.estate).toBe(0);
    expect(split?.catalogue).toBe(-50);
    expect(split?.reweighted).toBe(1);
  });

  it('excludes a requirement only one of the two runs produced a finding for', () => {
    const later = scan(50, [finding('a', 'fail'), finding('b', 'pass')]);
    const earlier = scan(100, [finding('a', 'pass')], 'older');

    expect(attribute(later, earlier, span())?.stable).toBe(1);
  });

  it('makes the two halves sum to the movement the reader sees', () => {
    const later = scan(41.5, [finding('a', 'fail'), finding('b', 'pass'), finding('c', 'fail')]);
    const earlier = scan(93.25, [finding('a', 'pass'), finding('b', 'pass')], 'older');

    const split = attribute(later, earlier, span({ added: ['c'] }));

    expect(split).toBeDefined();
    expect(Math.round((split!.estate + split!.catalogue) * 100) / 100).toBe(-51.75);
  });

  it('says nothing rather than zero when the two catalogues share no comparable requirement', () => {
    const later = scan(50, [finding('c', 'fail')]);
    const earlier = scan(100, [finding('a', 'pass')], 'older');

    expect(attribute(later, earlier, span({ added: ['c'], removed: ['a'] }))).toBeUndefined();
  });

  it('says nothing when either run has no overall score to move', () => {
    const later = scan(50, [finding('a', 'fail')]);
    const earlier = { ...scan(100, [finding('a', 'pass')], 'older') };
    const scoreless = { ...earlier, score: { ...earlier.score, overall: undefined } };

    expect(attribute(later, scoreless, span())).toBeUndefined();
  });

  it('collapses a requirement written in two pillars to one, as the runs themselves scored it', () => {
    const shared = (outcome: Finding['outcome']) => [
      { ...finding('rel-1', outcome), pillarId: 'reliability' },
      { ...finding('cost-1', outcome), pillarId: 'cost-optimization' },
    ];
    const later = scan(0, shared('fail'));
    const earlier = scan(100, shared('pass'), 'older');
    const group = (controlId: string) => (controlId === 'rel-1' || controlId === 'cost-1' ? 'acid' : undefined);

    const split = attribute(later, earlier, span(), group);

    expect(split?.estate).toBe(-100);
    // And is counted the way it was scored. Two ids, one requirement, so the page cannot say the
    // estate half was measured over two things both runs asked.
    expect(split?.stable).toBe(1);
  });
});
