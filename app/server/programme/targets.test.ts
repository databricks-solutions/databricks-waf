import { describe, expect, it } from 'vitest';
import { readTargets, type ScoredPillar } from './targets.js';
import type { PillarTarget } from '../define/definition.js';

const NOW = new Date('2026-08-05T12:00:00Z');

function target(over: Partial<PillarTarget> = {}): PillarTarget {
  return { pillar: 'security', atLeast: 80, by: new Date('2026-09-30T00:00:00Z'), ...over };
}

function pillars(...scored: readonly ScoredPillar[]): readonly ScoredPillar[] {
  return scored;
}

function one(target: PillarTarget, scored: readonly ScoredPillar[], now: Date = NOW) {
  const readings = readTargets([target], scored, now);
  const reading = readings[0];
  if (reading == null) throw new Error('a target was read as no readings');
  return reading;
}

describe('a target with the date still ahead', () => {
  it('is met when the score has reached it, and still says the date', () => {
    const reading = one(target(), pillars({ pillarId: 'security', score: 84 }));

    expect(reading.standing).toBe('met');
    expect(reading.due).toBe(false);
    expect(reading.score).toBe(84);
    expect(reading.shortBy).toBeUndefined();
    // The date is not dropped on a met target whose date has not arrived: it can still be lost, and a
    // sentence without the date would read as settled.
    expect(reading.sentence).toContain('30 September 2026');
    expect(reading.sentence).toContain('which it meets');
  });

  it('counts an exact hit as met, since the commitment was "at least"', () => {
    expect(one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 80 })).standing).toBe('met');
  });

  it('says how far short it is and how long is left, without a verdict', () => {
    const reading = one(target(), pillars({ pillarId: 'security', score: 72 }));

    expect(reading.standing).toBe('short');
    expect(reading.shortBy).toBe(8);
    expect(reading.daysLeft).toBe(56);
    expect(reading.sentence).toBe(
      '72 against a target of 80 by 30 September 2026, 8 points short with 56 days to the date.'
    );
  });

  it('has a day left on the last day, rather than none while somebody could still act', () => {
    const reading = one(
      target({ by: new Date('2026-08-06T00:00:00Z') }),
      pillars({ pillarId: 'security', score: 10 })
    );

    expect(reading.daysLeft).toBe(1);
    expect(reading.sentence).toContain('1 day to the date');
  });
});

describe('a target whose date has passed', () => {
  const passed = target({ by: new Date('2026-07-01T00:00:00Z') });

  it('reports the gap in points', () => {
    const reading = one(passed, pillars({ pillarId: 'security', score: 72 }));

    expect(reading.standing).toBe('gap');
    expect(reading.due).toBe(true);
    expect(reading.shortBy).toBe(8);
    expect(reading.sentence).toBe('72 against a target of 80 by 1 July 2026, a gap of 8 points.');
  });

  it('does not accuse anybody of missing it', () => {
    // The property the whole module exists for. The person who would read this is the person who set
    // the target, and a tool that turns their own stated intention into an accusation gets targets
    // switched off — leaving no programme surface at all.
    const reading = one(passed, pillars({ pillarId: 'security', score: 30 }));

    for (const word of ['missed', 'miss', 'overdue', 'failed', 'failure', 'late', 'breach']) {
      expect(reading.sentence.toLowerCase()).not.toContain(word);
    }
  });

  it('is still met when the score got there, and does not dwell on the date', () => {
    const reading = one(passed, pillars({ pillarId: 'security', score: 91 }));

    expect(reading.standing).toBe('met');
    expect(reading.daysLeft).toBeUndefined();
  });

  it('treats the moment the date arrives as due, rather than a day either side of it', () => {
    const at = new Date('2026-09-30T00:00:00Z');

    expect(one(target({ by: at }), pillars({ pillarId: 'security', score: 1 }), at).standing).toBe('gap');
    expect(
      one(target({ by: at }), pillars({ pillarId: 'security', score: 1 }), new Date(at.getTime() - 1)).standing
    ).toBe('short');
  });

  it('reads a one-point gap in the singular', () => {
    expect(one(passed, pillars({ pillarId: 'security', score: 79 })).sentence).toContain('a gap of 1 point.');
  });
});

describe('a target with nothing to be held against', () => {
  it('separates a pillar that could not be scored from one the run never covered', () => {
    // The two absent standings, and the reason they are two: the remedies are different. One is grants
    // or evidence, the other is the assessment's own pillar list.
    const unscored = one(target(), pillars({ pillarId: 'security' }));
    const uncovered = one(target(), pillars({ pillarId: 'cost-optimization', score: 90 }));

    expect(unscored.standing).toBe('not-scored');
    expect(uncovered.standing).toBe('not-assessed');
    expect(unscored.sentence).toContain('could be scored');
    expect(uncovered.sentence).toContain('Not covered by this run');
  });

  /*
   * No pillar id in a sentence a customer reads. The three scored sentences never named the pillar —
   * the surface that shows a reading puts the pillar's title above it — and these two did, in the
   * catalogue's own spelling. "This run did not cover cost-optimization" is the app showing its
   * internals in the one place a commitment is being reported on.
   */
  it('leaves naming the pillar to whatever shows the reading', () => {
    for (const reading of [one(target(), pillars({ pillarId: 'security' })), one(target(), pillars())]) {
      expect(reading.sentence).not.toContain('security');
      expect(reading.sentence).not.toContain('cost-optimization');
    }
  });

  it('reports no gap for either, because a gap nobody measured is an invented number', () => {
    for (const scored of [pillars({ pillarId: 'security' }), pillars()]) {
      const reading = one(target(), scored);

      expect(reading.score).toBeUndefined();
      expect(reading.shortBy).toBeUndefined();
      // Specifically not "80 points short", which is what a reading that treated an absent score as
      // zero would say — a gap against a commitment the customer may well be keeping.
      expect(reading.sentence).not.toContain('short');
      expect(reading.sentence).not.toContain('gap');
    }
  });

  it('still says what the commitment was, so it does not vanish from the surface', () => {
    const reading = one(target(), pillars());

    expect(reading.atLeast).toBe(80);
    expect(reading.sentence).toContain('80');
    expect(reading.sentence).toContain('30 September 2026');
  });
});

describe('the set of readings', () => {
  it('keeps the order the definition stores, rather than sorting by urgency', () => {
    const readings = readTargets(
      [
        target({ pillar: 'cost-optimization', by: new Date('2027-01-01T00:00:00Z') }),
        target({ pillar: 'security', by: new Date('2026-01-01T00:00:00Z') }),
      ],
      pillars({ pillarId: 'cost-optimization', score: 10 }, { pillarId: 'security', score: 10 }),
      NOW
    );

    expect(readings.map((reading) => reading.pillar)).toEqual(['cost-optimization', 'security']);
  });

  it('is empty when nothing was committed, rather than inventing a row per pillar', () => {
    expect(readTargets([], pillars({ pillarId: 'security', score: 40 }), NOW)).toEqual([]);
  });
});

describe('the arithmetic a customer reads', () => {
  /*
   * A live run against a real workspace put "0.7999999999999972 points short" in front of a customer.
   * The score was 79.2 and the target 80, and binary floating point holds neither exactly. Rounding
   * only the sentence would not have been enough: `shortBy` is in the payload, and anything reading it
   * would have inherited the same digits.
   */
  it('holds a gap to the place a score is reported to, in the field as well as the sentence', () => {
    const found = one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 79.2 }));

    expect(found.shortBy).toBe(0.8);
    expect(found.sentence).toContain('0.8 points short');
    expect(found.sentence).not.toContain('0.79');
    expect(found.sentence).not.toContain('0.80000');
  });

  it('rounds the score it reports, rather than printing every digit the scorer had', () => {
    const found = one(target({ atLeast: 90 }), pillars({ pillarId: 'security', score: 79.16666666 }));

    expect(found.score).toBe(79.2);
    expect(found.sentence).toContain('79.2');
    expect(found.sentence).not.toContain('79.166');
  });

  /*
   * A gap is fractional, so the singular is the special case rather than the default. "0.8 points" and
   * "1.5 points" are both plural; only exactly one point is not.
   */
  it('uses the singular only for exactly one point', () => {
    expect(one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 79 })).sentence).toContain('1 point ');
    expect(one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 79.2 })).sentence).toContain('points');
    expect(one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 78.5 })).sentence).toContain(
      '1.5 points'
    );
  });

  /*
   * Rounding decides the standing as well as the sentence. A score of 79.96 against a target of 80 is
   * reported as 80, and a reading that showed "80 against a target of 80" and called it behind would
   * be contradicting itself on one line.
   */
  it('does not report a score as met while calling it behind, or the reverse', () => {
    const found = one(target({ atLeast: 80 }), pillars({ pillarId: 'security', score: 79.96 }));

    expect(found.score).toBe(80);
    expect(found.standing).toBe('met');
  });
});
