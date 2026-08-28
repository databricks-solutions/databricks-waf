// The date-dependent sentences, which are the ones that can be confidently wrong.
//
// "Review date passed 12 days ago" and "Review in 12 days" differ by one comparison and mean
// opposite things to whoever has to act, and neither is visible in a type. The rest of the module is
// lookup tables, tested here only for completeness against the union — a standing with no words is a
// blank badge, and a standing with no rank sorts as first.

import { describe, expect, it } from 'vitest';
import {
  DISPOSITIONS,
  DISPOSITION_EFFECT,
  DISPOSITION_LABEL,
  STANDING_DETAIL,
  STANDING_LABEL,
  STANDING_RANK,
  STANDING_TONE,
  datePhrase,
  earliestDate,
  endOfDay,
  latestDate,
  parkDaysFor,
  parkedPhrase,
  suggestedDate,
} from './decide-language';
import type { Standing } from '../api/types';

const NOW = new Date('2026-06-01T12:00:00.000Z');

const STANDINGS: readonly Standing[] = [
  'current',
  'due',
  'lapsed',
  'unverified',
  'confirmed',
  'contradicted',
  'settled',
  'withdrawn',
];

describe('the date on a decision', () => {
  it('says how long a lapsed one has been lapsed', () => {
    const phrase = datePhrase(
      { disposition: 'accepted', until: '2026-05-20T00:00:00.000Z', standing: 'lapsed' },
      NOW
    );

    expect(phrase).toContain('passed 13 days ago');
    expect(phrase).toContain('Review');
  });

  it('says how long a due one has left', () => {
    const phrase = datePhrase({ disposition: 'deferred', until: '2026-06-13T00:00:00.000Z', standing: 'due' }, NOW);

    expect(phrase).toContain('Due in 12 days');
  });

  it('calls a deferral due and an acceptance reviewed', () => {
    // Different words because they mean different things on the day: a deferred fix is expected, an
    // accepted risk is only revisited. One word for both would tell half the readers the wrong thing.
    const deferred = datePhrase({ disposition: 'deferred', until: '2026-09-01T00:00:00.000Z', standing: 'current' }, NOW);
    const accepted = datePhrase({ disposition: 'accepted', until: '2026-09-01T00:00:00.000Z', standing: 'current' }, NOW);

    expect(deferred).toMatch(/^Due /);
    expect(accepted).toMatch(/^Review /);
  });

  it('says today rather than "0 days ago" on the day it lapses', () => {
    const phrase = datePhrase({ disposition: 'accepted', until: NOW.toISOString(), standing: 'lapsed' }, NOW);

    expect(phrase).toContain('today');
  });

  it('is empty for a disposition that carries no date', () => {
    expect(datePhrase({ disposition: 'fixed', standing: 'unverified' }, NOW)).toBe('');
  });

  it('says the date could not be read rather than printing Invalid Date', () => {
    const phrase = datePhrase({ disposition: 'accepted', until: 'the fifth of never', standing: 'current' }, NOW);

    expect(phrase).toContain('could not be read');
  });
});

describe('what the queue says it is not showing', () => {
  it('says nothing when nothing is held back', () => {
    expect(parkedPhrase(0)).toBeUndefined();
  });

  it('agrees with itself in number', () => {
    expect(parkedPhrase(1)).toContain('1 more is');
    expect(parkedPhrase(4)).toContain('4 more are');
  });
});

describe('the dates the form offers', () => {
  it('suggests well short of the cap', () => {
    // A form that arrives with the longest permitted date filled in teaches the reader to park
    // everything for as long as the app allows.
    expect(suggestedDate(90, NOW)).toBe('2026-07-01');
  });

  it('never suggests less than a week, however short the cap', () => {
    expect(suggestedDate(3, NOW)).toBe('2026-06-08');
  });

  it('stops a day inside the cap, since the date it offers means the end of that day', () => {
    // Ninety days from noon on 1 June is 30 August, and the end of the 30th is past the cap the
    // server enforces. Offering the 29th means every date the picker allows is one it will accept.
    expect(latestDate(90, NOW)).toBe('2026-08-29');
  });

  it('will not offer a date that has already passed', () => {
    expect(earliestDate(NOW)).toBe('2026-06-02');
  });

  it('sends the end of the chosen day, so the decision holds through it', () => {
    expect(endOfDay('2026-09-30')).toBe('2026-09-30T23:59:59.999Z');
  });
});

describe('how long a severity may be parked', () => {
  const CAPS = { critical: 90, high: 180, medium: 365, low: 365, informational: 365 } as const;

  it('reads the server\u2019s own table', () => {
    expect(parkDaysFor('critical', CAPS)).toBe(90);
  });

  it('falls back to the longest interval the server has when the caps did not arrive', () => {
    expect(parkDaysFor('critical', undefined)).toBe(365);
    expect(parkDaysFor(undefined, CAPS)).toBe(365);
  });
});

describe('the tables', () => {
  it('has words, a tone and a rank for every standing', () => {
    for (const standing of STANDINGS) {
      expect(STANDING_LABEL[standing]).toBeTruthy();
      expect(STANDING_DETAIL[standing]).toBeTruthy();
      expect(STANDING_TONE).toHaveProperty(standing);
      expect(STANDING_RANK[standing]).toBeGreaterThanOrEqual(0);
    }
  });

  it('ranks a contradicted fix above everything else', () => {
    const ranked = [...STANDINGS].sort((a, b) => STANDING_RANK[a] - STANDING_RANK[b]);

    expect(ranked[0]).toBe('contradicted');
  });

  it('has words for every disposition, and offers all four', () => {
    expect(DISPOSITIONS).toHaveLength(4);
    for (const disposition of DISPOSITIONS) {
      expect(DISPOSITION_LABEL[disposition]).toBeTruthy();
      expect(DISPOSITION_EFFECT[disposition]).toBeTruthy();
    }
  });

  it('does not name a disposition after the accepted-risk record beside it', () => {
    // Both said "Accepting the risk" and they do different things: this one parks a finding, the
    // record puts it on the exceptions register. A reader choosing between two identically named
    // controls picks by position, and the one that looks like a register entry here is not one.
    for (const disposition of DISPOSITIONS) {
      expect(DISPOSITION_LABEL[disposition].toLowerCase()).not.toContain('accepting the risk');
    }
  });

  it('says of the parking choice that it is not the register, since that is what a reader assumes', () => {
    expect(DISPOSITION_EFFECT.accepted).toContain('does not go on the exceptions register');
    // And where to go instead, because naming an absence without a direction is a dead end.
    expect(DISPOSITION_EFFECT.accepted).toContain('accept the risk below');
  });
});
