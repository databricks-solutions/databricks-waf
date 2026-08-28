import { describe, expect, it } from 'vitest';

import { currentMonthIn, monthHasClosed } from './closed.js';
import { parseMonth, type MonthId } from './publication.js';

/** A `MonthId` for a test, asserting the literal is well-formed rather than casting past the brand. */
function month(value: string): MonthId {
  const parsed = parseMonth(value);
  if (parsed === undefined) throw new Error(`test wrote a bad month: ${value}`);
  return parsed;
}

describe('currentMonthIn', () => {
  it('reads the wall-clock month in the given zone, not UTC', () => {
    // Half past midnight UTC on the first of September. Still August on the American west coast.
    const now = new Date('2026-09-01T00:30:00Z');
    expect(currentMonthIn('UTC', now)).toBe('2026-09');
    expect(currentMonthIn('America/Los_Angeles', now)).toBe('2026-08');
  });

  it('reads a month east of UTC that has already turned over', () => {
    // Late on the 31st in UTC is already the first of the next month in Auckland.
    const now = new Date('2026-08-31T20:00:00Z');
    expect(currentMonthIn('UTC', now)).toBe('2026-08');
    expect(currentMonthIn('Pacific/Auckland', now)).toBe('2026-09');
  });

  it('carries the year across the December boundary', () => {
    expect(currentMonthIn('UTC', new Date('2027-01-01T05:00:00Z'))).toBe('2027-01');
  });

  it('throws on a zone Intl does not recognise, rather than falling back', () => {
    expect(() => currentMonthIn('Mars/Olympus', new Date('2026-09-01T00:30:00Z'))).toThrow();
  });
});

describe('monthHasClosed', () => {
  const now = new Date('2026-09-01T00:30:00Z');

  it('is closed once the zone clock has moved into a later month', () => {
    expect(monthHasClosed(month('2026-08'), 'UTC', now)).toBe(true);
  });

  it('is not closed while the zone clock is still in the same month', () => {
    // August has not closed in Los Angeles at this instant — it is still the 31st there.
    expect(monthHasClosed(month('2026-08'), 'America/Los_Angeles', now)).toBe(false);
  });

  it('is not closed for the current month', () => {
    expect(monthHasClosed(month('2026-09'), 'UTC', now)).toBe(false);
  });

  it('is not closed for a future month', () => {
    expect(monthHasClosed(month('2026-12'), 'UTC', now)).toBe(false);
  });

  it('closes a December against a January that has arrived', () => {
    expect(monthHasClosed(month('2026-12'), 'UTC', new Date('2027-01-01T05:00:00Z'))).toBe(true);
  });
});
