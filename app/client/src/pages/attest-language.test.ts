import { describe, expect, it } from 'vitest';
import {
  ANSWER_EFFECT,
  STATE_RANK,
  attributionPhrase,
  cadencePhrase,
  progressPhrase,
  renewalPhrase,
  stateOf,
} from './attest-language';
import type { AttestableRequirement } from '../api/types';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function requirement(state?: AttestableRequirement['attestation']): AttestableRequirement {
  return {
    controlId: 'OE-01-01',
    pillarId: 'operational-excellence',
  principleId: 'oe-01',
    title: 'Rehearse recovery',
    severity: 'high',
    askedBecause: 'no-telemetry',
    question: 'Is recovery rehearsed?',
    cadenceDays: 180,
    ...(state != null ? { attestation: state } : {}),
  };
}

function answered(state: 'current' | 'due' | 'expired'): AttestableRequirement['attestation'] {
  return {
    id: 'a1',
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Rehearsed each quarter.',
    owner: 'platform-team@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: '2026-01-01T00:00:00.000Z',
    reviewBy: '2026-07-01T00:00:00.000Z',
    state,
  };
}

describe('where a requirement stands', () => {
  it('is unanswered when nobody has answered it', () => {
    expect(stateOf(requirement())).toBe('unanswered');
  });

  it('takes the state the server decided rather than recomputing it', () => {
    // The server has already used this to decide whether the requirement is in the score. A
    // second opinion computed against the browser's clock could contradict the number beside it.
    expect(stateOf(requirement(answered('due')))).toBe('due');
  });

  it('ranks a lapsed answer above one nobody ever gave', () => {
    // A lapsed answer is a practice that was being managed and has stopped being, which is a
    // sharper signal than one never looked at.
    expect(STATE_RANK.expired).toBeLessThan(STATE_RANK.unanswered);
    expect(STATE_RANK.due).toBeLessThan(STATE_RANK.unanswered);
    expect(STATE_RANK.current).toBeGreaterThan(STATE_RANK.unanswered);
  });
});

describe('how often to confirm', () => {
  it('says a year rather than 365 days', () => {
    expect(cadencePhrase(365)).toBe('Confirm once a year');
  });

  it('says months for a half-yearly cadence', () => {
    expect(cadencePhrase(180)).toBe('Confirm every 6 months');
  });

  it('falls back to days for a short cadence, where days is the right unit', () => {
    expect(cadencePhrase(14)).toBe('Confirm every 14 days');
  });
});

describe('the review date', () => {
  it('says how long ago a lapsed answer stopped counting', () => {
    const phrase = renewalPhrase('2026-05-01T00:00:00.000Z', 'expired', NOW);

    expect(phrase).toContain('Lapsed');
    // 31 days and 12 hours, rounded. Days is the right resolution here: an answer that lapsed
    // yesterday afternoon and one that lapsed this morning call for the same thing.
    expect(phrase).toContain('32 days ago');
  });

  it('says how long is left on one that is due', () => {
    const phrase = renewalPhrase('2026-06-20T00:00:00.000Z', 'due', NOW);

    // The distinction the two branches exist for: same comparison, opposite meanings.
    expect(phrase).toContain('Due for review in');
    expect(phrase).not.toContain('Lapsed');
  });

  it('states the date and nothing else for a current answer', () => {
    expect(renewalPhrase('2026-12-01T00:00:00.000Z', 'current', NOW)).toMatch(/^Next review/);
  });

  it('says a day rather than 1 days', () => {
    expect(renewalPhrase('2026-05-31T12:00:00.000Z', 'expired', NOW)).toContain('1 day ago');
  });

  it('says so rather than rendering an invalid date', () => {
    expect(renewalPhrase('not a date', 'current', NOW)).toContain('could not be read');
  });
});

describe('attribution', () => {
  it('names who answered and when', () => {
    expect(attributionPhrase('admin@example.com', '2026-01-15T00:00:00.000Z')).toContain('admin@example.com');
    expect(attributionPhrase('admin@example.com', '2026-01-15T00:00:00.000Z')).toContain('2026');
  });

  it('does not invent a date it does not have', () => {
    expect(attributionPhrase('admin@example.com', '')).toContain('unrecorded');
  });
});

describe('progress across the set', () => {
  it('counts answered and due as counting toward the score', () => {
    // Due still counts. Warning about a lapse and causing one are different things, and a page
    // that counted `due` as outstanding would be telling the reader their score is lower than it is.
    const phrase = progressPhrase([requirement(answered('current')), requirement(answered('due')), requirement()]);

    expect(phrase).toContain('2 of 3');
  });

  it('does not count a lapsed answer', () => {
    expect(progressPhrase([requirement(answered('expired')), requirement()])).toContain('0 of 2');
  });

  it('says so when the build asks nothing', () => {
    expect(progressPhrase([])).toContain('no requirements');
  });
});

describe('what each answer does to the score', () => {
  it('says partial earns half, so the reader knows progress is worth recording', () => {
    expect(ANSWER_EFFECT['partially-met']).toContain('half');
  });

  it('says not-applicable leaves the score, since that is the answer most open to misuse', () => {
    expect(ANSWER_EFFECT['not-applicable']).toContain('Leaves the score');
  });
});
