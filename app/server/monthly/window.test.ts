import { describe, expect, it } from 'vitest';

import { parseMonth, type MonthId } from './publication.js';
import { monthWindow } from './window.js';

function month(value: string): MonthId {
  const parsed = parseMonth(value);
  if (parsed === undefined) throw new Error(`test wrote a bad month: ${value}`);
  return parsed;
}

describe('monthWindow', () => {
  it('spans a UTC month from first instant to first of the next', () => {
    const { start, end } = monthWindow(month('2026-08'), 'UTC');
    expect(start.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('rolls December into the next January', () => {
    const { start, end } = monthWindow(month('2026-12'), 'UTC');
    expect(start.toISOString()).toBe('2026-12-01T00:00:00.000Z');
    expect(end.toISOString()).toBe('2027-01-01T00:00:00.000Z');
  });

  it('places the boundaries at local midnight west of UTC', () => {
    // August in Los Angeles: local midnight on the 1st is 07:00 UTC (PDT, UTC-7).
    const { start, end } = monthWindow(month('2026-08'), 'America/Los_Angeles');
    expect(start.toISOString()).toBe('2026-08-01T07:00:00.000Z');
    expect(end.toISOString()).toBe('2026-09-01T07:00:00.000Z');
  });

  it('reads each boundary against its own offset across a daylight-saving change', () => {
    // March in New York contains the spring-forward: the month opens at EST (UTC-5) and the next
    // month opens at EDT (UTC-4), so the two boundaries are not the same offset from UTC.
    const { start, end } = monthWindow(month('2026-03'), 'America/New_York');
    expect(start.toISOString()).toBe('2026-03-01T05:00:00.000Z');
    expect(end.toISOString()).toBe('2026-04-01T04:00:00.000Z');
  });

  it('places the boundaries at local midnight east of UTC', () => {
    // August in Auckland: local midnight on the 1st is the previous day at 12:00 UTC (NZST, UTC+12).
    const { start } = monthWindow(month('2026-08'), 'Pacific/Auckland');
    expect(start.toISOString()).toBe('2026-07-31T12:00:00.000Z');
  });
});
