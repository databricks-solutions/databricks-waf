import { describe, expect, it } from 'vitest';

import { loadCatalogue } from '../server/catalogue/catalogue.js';
import { MIN_THRESHOLD_CALLS, readsOf, unreadThresholds, walkResolvers } from './check-thresholds.js';

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
