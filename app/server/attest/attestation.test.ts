import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  InvalidAttestationError,
  MIN_STATEMENT,
  cadenceDaysFor,
  counts,
  draftFrom,
  reviewDateFrom,
  stateOf,
  type Attestation,
} from './attestation.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'a1',
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Reviewed quarterly by the platform team, minutes in the runbook.',
    owner: 'platform-team@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: NOW,
    reviewBy: new Date(NOW.getTime() + 365 * DAY_MS),
    ...overrides,
  };
}

describe('how long an answer stands', () => {
  it('asks more often for a critical practice than a low one', () => {
    // The point of the table: a single interval would be too slow for the things that matter
    // and too fast for the things that do not, and the second is what gets a review
    // process abandoned.
    expect(cadenceDaysFor('critical')).toBeLessThan(cadenceDaysFor('medium'));
    expect(cadenceDaysFor('high')).toBeLessThan(cadenceDaysFor('low'));
  });

  it('lets the catalogue override the default, because the framework knows better than a table', () => {
    expect(cadenceDaysFor('low', 30)).toBe(30);
  });

  it('sets the review date forward by the cadence', () => {
    expect(reviewDateFrom(NOW, 90).toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });
});

describe('whether an answer still counts', () => {
  it('counts a fresh answer', () => {
    expect(stateOf(attestation(), NOW)).toBe('current');
    expect(counts(attestation(), NOW)).toBe(true);
  });

  it('keeps a fresh thirty-day answer current instead of consuming its whole life as due', () => {
    const fresh = attestation({ reviewBy: new Date(NOW.getTime() + 30 * DAY_MS) });

    expect(stateOf(fresh, NOW)).toBe('current');
  });

  it('flags one nearing its review date, so a renewal can be asked for before it lapses', () => {
    const nearly = attestation({
      attestedAt: new Date(NOW.getTime() - 355 * DAY_MS),
      reviewBy: new Date(NOW.getTime() + 10 * DAY_MS),
    });

    expect(stateOf(nearly, NOW)).toBe('due');
    // Still counts. Warning about a lapse and causing one are different things.
    expect(counts(nearly, NOW)).toBe(true);
  });

  it('asks for a thirty-day answer again in its final third', () => {
    const short = attestation({ reviewBy: new Date(NOW.getTime() + 30 * DAY_MS) });

    expect(stateOf(short, new Date(NOW.getTime() + 20 * DAY_MS))).toBe('due');
  });

  it('stops counting a lapsed answer, so a score cannot improve by ageing', () => {
    const lapsed = attestation({ reviewBy: new Date(NOW.getTime() - DAY_MS) });

    expect(stateOf(lapsed, NOW)).toBe('expired');
    expect(counts(lapsed, NOW)).toBe(false);
  });

  it('treats the review date itself as lapsed rather than as a last valid day', () => {
    expect(stateOf(attestation({ reviewBy: NOW }), NOW)).toBe('expired');
  });
});

describe('validating what was submitted', () => {
  const known = (id: string) => id === 'OE-01-01';

  const body = {
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Reviewed quarterly by the platform team, minutes in the runbook.',
    owner: 'platform-team@example.com',
  };

  it('accepts a complete answer', () => {
    expect(draftFrom(body, known)).toEqual(body);
  });

  it('refuses an answer about a requirement the framework does not have', () => {
    expect(() => draftFrom({ ...body, controlId: 'NOPE-99-99' }, known)).toThrow(InvalidAttestationError);
  });

  it('refuses a statement too short to be reviewable later', () => {
    // The single most important validation here. An answer with nothing behind it is a
    // checkbox, and a page of ticked checkboxes is what makes self-assessments worthless.
    expect(() => draftFrom({ ...body, statement: 'yes' }, known)).toThrow(/at least/);
    expect(MIN_STATEMENT).toBeGreaterThan(10);
  });

  it('refuses an answer with no accountable owner', () => {
    expect(() => draftFrom({ ...body, owner: '  ' }, known)).toThrow(/accountable/);
  });

  it('refuses an answer outside the four the framework recognises', () => {
    expect(() => draftFrom({ ...body, answer: 'probably' }, known)).toThrow(/must be one of/);
  });

  it('refuses an evidence link that is not a URL, rather than storing something unopenable', () => {
    expect(() => draftFrom({ ...body, evidenceUrl: 'the wiki' }, known)).toThrow(/http/);
  });

  it('keeps a valid evidence link', () => {
    expect(draftFrom({ ...body, evidenceUrl: 'https://wiki.example.com/dr' }, known).evidenceUrl).toBe(
      'https://wiki.example.com/dr'
    );
  });

  it('ignores an identity in the body, because only the server may say who attested', () => {
    // A client that could set this could attribute a claim to a colleague.
    const draft = draftFrom({ ...body, attestedBy: 'someone.else@example.com' }, known);

    expect(draft).not.toHaveProperty('attestedBy');
  });

  it('ignores a review date in the body, so nothing can be attested as valid for a decade', () => {
    const draft = draftFrom({ ...body, reviewBy: '2099-01-01' }, known);

    expect(draft).not.toHaveProperty('reviewBy');
  });

  it('says which field to fix rather than that the request was invalid', () => {
    // The person reading this is filling in a form. "Invalid request" tells them nothing
    // about which part of it to change.
    expect(() => draftFrom({}, known)).toThrow(/controlId/);
  });
});
