import { describe, expect, it } from 'vitest';

import { loadCatalogue } from '../server/catalogue/catalogue.js';
import {
  deadBand,
  deadBands,
  MIN_THRESHOLD_CALLS,
  readsOf,
  unreadThresholds,
  walkResolvers,
} from './check-thresholds.js';

describe('a declared threshold is a measurement somebody takes', () => {
  it('attributes every threshold() call in a registration to the controls that registration names', () => {
    /*
     * The apparatus. A walk that cannot see `threshold(context.spec, 'name')` — the first version
     * of this measurement required the first argument to be a single word, so every real call
     * was invisible and nineteen controls looked unread — produces a list calibrated to the
     * fault in the walker rather than to the catalogue.
     */
    const walked = readsOf(`
      const audit = fromSignal(AUDIT, ['DG-02-02', 'DG-02-03'], (audit, context) => {
        const maxGapDays = threshold(context.spec, 'max_days_since_event', 2);
      });
    `);
    expect(walked.unattributed).toEqual([]);
    expect([...walked.byControl.get('DG-02-02') ?? []]).toEqual(['max_days_since_event']);
    expect([...walked.byControl.get('DG-02-03') ?? []]).toEqual(['max_days_since_event']);
  });

  it('treats bandsOf as a read of pass_share and partial_share, which is what bandsOf asks for', () => {
    const walked = readsOf(`
      fromSignal(CENSUS, ['DG-01-05'], (census, context) => {
        return bandOutcome(described, bandsOf(context.spec, { pass: 0.8, partial: 0.4 }));
      });
    `);
    expect([...walked.byControl.get('DG-01-05') ?? []].sort()).toEqual(['partial_share', 'pass_share']);
  });

  it('reaches the control whose unread thresholds were the finding, so a rename of the registration does not go silent', () => {
    const walked = walkResolvers();
    expect(walked.byControl.has('DG-01-02')).toBe(true);
    expect(walked.byControl.has('DG-01-03')).toBe(true);
    expect(walked.byControl.has('PE-03-15')).toBe(true);
  });

  it('finds enough threshold() calls that a walk which resolved nothing cannot pass', () => {
    expect(walkResolvers().calls).toBeGreaterThan(MIN_THRESHOLD_CALLS);
  });

  it('holds no unread declared threshold against the catalogue as it stands', () => {
    expect(unreadThresholds(loadCatalogue(), walkResolvers())).toEqual([]);
  });
});

describe('a declared band is one that can change the outcome', () => {
  /*
   * OE-03-01 declared `partial_share: 0.01`, and its resolver passed `{ pass: 0, partial: 0.01 }` to
   * `bandsOf` and then returned `partial` on every branch. The threshold was read, so the unread check
   * was satisfied, and no number a reader could put in the catalogue would have moved the outcome. A
   * band is only a band if a share can fall into each of its three outcomes.
   */
  it.each([
    ['everything passes', 0, 0.01],
    ['the partial band is empty', 0.5, 0.5],
    ['the partial band is above the pass band', 0.4, 0.8],
    ['nothing can fail', 0.8, 0],
    ['nothing can pass', 1.2, 0.5],
  ])('refuses a band where %s', (_why, pass, partial) => {
    expect(deadBand(pass, partial)).toEqual(expect.any(String));
  });

  it.each([
    [0.8, 0.4],
    [1, 0.99],
    [1, 0.5],
    [0.98, 0.85],
  ])('accepts %d and %d', (pass, partial) => {
    expect(deadBand(pass, partial)).toBeUndefined();
  });

  it('reads the fallback bands a resolver compiles in, attributed to the control it registers', () => {
    const walked = readsOf(`
      fromSignal(CAPACITY, ['OE-03-01'], (capacity, context) => {
        return bandOutcome(share, bandsOf(context.spec, { pass: 0, partial: 0.01 }));
      });
    `);
    expect(walked.fallbacks.get('OE-03-01')).toEqual([{ pass: 0, partial: 0.01 }]);
  });

  it('judges the band a control is actually scored on: the declaration over the fallback', () => {
    const resolver = { fallbacks: new Map([['XX-01-01', [{ pass: 0.9, partial: 0.5 }]]]) };
    const declaring = (thresholds: Record<string, number>) => ({ controls: [{ id: 'XX-01-01', thresholds }] });

    expect(deadBands(declaring({ partial_share: 0.6 }), resolver)).toEqual([]);
    // The declaration alone is a fine number. Over the compiled-in pass band it empties the partial one.
    expect(deadBands(declaring({ partial_share: 0.95 }), resolver)).toEqual([
      expect.objectContaining({ id: 'XX-01-01', pass: 0.9, partial: 0.95 }),
    ]);
    expect(deadBands(declaring({ pass_share: 0, partial_share: 0.01 }), resolver)).toHaveLength(1);
  });

  it('holds no dead band against the catalogue and the resolvers as they stand', () => {
    expect(deadBands(loadCatalogue(), walkResolvers())).toEqual([]);
  });

  it('sees the bands of enough resolvers that a walk which resolved nothing cannot pass', () => {
    expect(walkResolvers().fallbacks.size).toBeGreaterThan(10);
  });
});
