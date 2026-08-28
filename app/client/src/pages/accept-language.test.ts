// The words the exception register says about a clock, and the one rule the form's rendering cannot reach.
//
// Every sentence here is a comparison against a date, and the two sides of the comparison mean
// opposite things to whoever has to act: "expires in 9 days" is a diary entry, "expired 9 days ago" is
// a requirement that came back onto the queue with nobody watching. Both are one subtraction apart, so
// they are asserted rather than described.

import { describe, expect, it } from 'vitest';
import {
  acceptanceDaysFor,
  earliestStart,
  endOfDay,
  expiryPhrase,
  latestExpiry,
  needsAttention,
  registerPhrase,
  residualPhrase,
  saysNothing,
  startOfDay,
  startPhrase,
  suggestedExpiry,
} from './accept-language';

const NOW = new Date('2026-06-20T12:00:00.000Z');

describe('saysNothing', () => {
  it('refuses the words that defeat the field', () => {
    for (const said of ['none', 'None', 'n/a', 'N/A', 'na', 'nothing', 'no', 'not applicable', 'tbc', 'TBD']) {
      expect(saysNothing(said)).toBe(true);
    }
  });

  it('refuses them with punctuation, since a full stop is not an answer', () => {
    // The version of this check that compared the raw string accepted "N/A." and refused "N/A", which
    // is a rule nobody could learn from using it.
    expect(saysNothing('N/A.')).toBe(true);
    expect(saysNothing('  none  ')).toBe(true);
    expect(saysNothing('Nothing!')).toBe(true);
  });

  it('accepts the honest answer that nothing is holding the line, written as a sentence', () => {
    // Writable on purpose. Where nothing is in place, that sentence is the one a reviewer needs — what
    // is refused is the word that leaves them without it.
    expect(saysNothing('Nothing is in place. The data is synthetic and the workspace has no external access.')).toBe(
      false
    );
  });

  it('accepts a real control', () => {
    expect(saysNothing('Access is restricted to two service principals, reviewed weekly.')).toBe(false);
  });
});

describe('expiryPhrase', () => {
  it('speaks in the past tense about an expiry that has passed', () => {
    const said = expiryPhrase({ expiresAt: '2026-06-11T23:59:59.999Z', standing: 'expired' }, NOW);

    expect(said).toContain('Expired 9 days ago');
  });

  it('says today rather than "0 days ago" for one that has just lapsed', () => {
    expect(expiryPhrase({ expiresAt: '2026-06-20T09:00:00.000Z', standing: 'expired' }, NOW)).toContain(
      'Expired today'
    );
  });

  it('counts down the days for one that is close', () => {
    expect(expiryPhrase({ expiresAt: '2026-06-25T23:59:59.999Z', standing: 'expiring' }, NOW)).toContain(
      'Expires in 5 days'
    );
  });

  it('counts the days the calendar counts, not the hours divided by 24', () => {
    // Half a day, which divides to 0.5. "Expires in 0 days" reads as though it already had, and the
    // reader is asking how many dates they will see first — one.
    expect(expiryPhrase({ expiresAt: '2026-06-21T23:59:59.999Z', standing: 'expiring' }, NOW)).toContain(
      'Expires in 1 day'
    );
  });

  it('names the day that was typed into the form, not the day after it', () => {
    // An acceptance runs to the end of its final day and the form sends `23:59:59.999Z`. Rendered in the
    // reader's own timezone, every reader east of London reads back the day after the one they chose.
    expect(expiryPhrase({ expiresAt: '2026-06-25T23:59:59.999Z', standing: 'expiring' }, NOW)).toContain('Jun 25');
  });

  it('names the date without a countdown for one comfortably ahead', () => {
    const said = expiryPhrase({ expiresAt: '2026-09-30T23:59:59.999Z', standing: 'active' }, NOW);

    expect(said).toMatch(/^Expires /);
    expect(said).not.toContain('in ');
  });

  it('uses the conditional for one that never reached its expiry', () => {
    // A revoked or replaced acceptance has an expiry it did not get to, and the present tense about it
    // would read as a record still holding something.
    for (const standing of ['revoked', 'superseded'] as const) {
      expect(expiryPhrase({ expiresAt: '2026-09-30T23:59:59.999Z', standing }, NOW)).toContain('Would have expired');
    }
  });

  it('says an unreadable date could not be read, rather than rendering the epoch', () => {
    expect(expiryPhrase({ expiresAt: 'the third quarter', standing: 'active' }, NOW)).toContain('could not be read');
  });
});

describe('startPhrase', () => {
  it('says when an acceptance starts only while that is still ahead', () => {
    expect(startPhrase({ effectiveFrom: '2026-07-01T00:00:00.000Z', standing: 'pending' })).toContain(
      'In force from'
    );
    // A start date in the past is not news, and a pane repeating it competes with the expiry.
    expect(startPhrase({ effectiveFrom: '2026-01-01T00:00:00.000Z', standing: 'active' })).toBeUndefined();
  });
});

describe('residualPhrase', () => {
  it('never states a residual without the severity it came down from', () => {
    expect(residualPhrase({ residual: 'low', severity: 'critical' })).toContain('down from critical');
  });

  it('says an unchanged residual is unchanged rather than implying a reduction', () => {
    expect(residualPhrase({ residual: 'high', severity: 'high' })).toContain('unchanged');
  });

  it('states the residual alone where the requirement is not in the catalogue', () => {
    // An acceptance against a requirement a later catalogue dropped still has to render.
    expect(residualPhrase({ residual: 'medium' })).toBe('Residual risk: medium.');
  });
});

describe('registerPhrase', () => {
  it('leads with what needs deciding again, because that is what the page is about', () => {
    expect(registerPhrase(40, 2)).toContain('2 of which need deciding again');
  });

  it('agrees with itself for one', () => {
    expect(registerPhrase(3, 1)).toContain('1 of which needs deciding again');
  });

  it('says so when nothing needs anything', () => {
    expect(registerPhrase(3, 0)).toContain('none expiring yet');
  });

  it('says nothing has been accepted rather than counting zero', () => {
    expect(registerPhrase(0, 0)).toBe('Nothing has been accepted on this installation.');
  });

  it('says on the page that none of it moves the score, which the page claimed and nothing said', () => {
    // A list of accepted failures beside a number that has not fallen invites the reading that
    // accepting them is what holds the number down.
    expect(registerPhrase(40, 2)).toContain('None of it changes the score');
    expect(registerPhrase(3, 0)).toContain('None of it changes the score');
  });

  it('does not make the claim over an empty register, where there is nothing to misread', () => {
    expect(registerPhrase(0, 0)).not.toContain('score');
  });
});

describe('the dates a form may offer', () => {
  it('offers an expiry short of the cap, so the longest is not taught as the normal one', () => {
    const offered = new Date(suggestedExpiry(90, NOW));
    const cap = new Date(latestExpiry(90, NOW));

    expect(offered.getTime()).toBeLessThan(cap.getTime());
  });

  it('never offers less than a week, however short the cap', () => {
    expect(suggestedExpiry(3, NOW)).toBe('2026-06-27');
  });

  it('keeps the furthest offer a day inside the cap', () => {
    // The date means the end of that day, and the end of the cap's own day is hours past the cap —
    // which the server refuses, teaching the reader the form cannot be trusted.
    expect(latestExpiry(90, NOW)).toBe('2026-09-17');
  });

  it('lets an acceptance start today but not before', () => {
    expect(earliestStart(NOW)).toBe('2026-06-20');
  });

  it('sends the start of the chosen day and the end of the chosen expiry', () => {
    // Both, and in that direction: an acceptance effective from the 4th covers the 4th, and one
    // expiring on the 30th holds through the 30th.
    expect(startOfDay('2026-06-20')).toBe('2026-06-20T00:00:00.000Z');
    expect(endOfDay('2026-06-30')).toBe('2026-06-30T23:59:59.999Z');
  });

  it('falls back to the longest cap rather than the shortest', () => {
    expect(acceptanceDaysFor(undefined, undefined)).toBe(365);
    expect(acceptanceDaysFor('critical', undefined)).toBe(365);
  });

  it('reads the cap from the payload rather than a table of its own', () => {
    expect(acceptanceDaysFor('critical', { critical: 30, high: 90, medium: 180, low: 365, informational: 365 })).toBe(
      30
    );
  });
});

describe('needsAttention', () => {
  it('is the two standings that are somebody’s to act on now', () => {
    expect(needsAttention('expiring')).toBe(true);
    expect(needsAttention('expired')).toBe(true);
    // Not `active`, which is doing what whoever wrote it intended, and not `revoked` or `superseded`,
    // which are history.
    for (const standing of ['active', 'pending', 'revoked', 'superseded'] as const) {
      expect(needsAttention(standing)).toBe(false);
    }
  });
});
