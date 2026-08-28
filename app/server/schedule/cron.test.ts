import { describe, expect, it } from 'vitest';
import { describeCadence, nextRun, readCadence } from './cron';

describe('reading a Quartz expression', () => {
  it('reads the schedule this product ships', () => {
    // resources/scheduled-scan.yml: weekly, early Monday.
    expect(readCadence('0 0 6 ? * MON')).toEqual({ second: 0, minute: 0, hour: 6, days: [1] });
  });

  it('reads every day', () => {
    expect(readCadence('0 30 4 * * ?')).toEqual({ second: 0, minute: 30, hour: 4, days: [0, 1, 2, 3, 4, 5, 6] });
  });

  it('reads a list of weekdays, in week order whatever order it was written in', () => {
    expect(readCadence('0 0 7 ? * FRI,MON,WED')).toEqual({ second: 0, minute: 0, hour: 7, days: [1, 3, 5] });
  });

  it('reads Quartz day numbers, where 1 is Sunday', () => {
    expect(readCadence('0 0 6 ? * 2')).toEqual({ second: 0, minute: 0, hour: 6, days: [1] });
  });

  it('accepts 0 for Sunday, which is what somebody who knows Unix cron writes', () => {
    expect(readCadence('0 0 6 ? * 0')?.days).toEqual([0]);
  });

  it('reads a day of the month', () => {
    expect(readCadence('0 0 3 1 * ?')).toEqual({ second: 0, minute: 0, hour: 3, days: [], dayOfMonth: 1 });
  });

  it('ignores a year, which bounds the schedule rather than its cadence', () => {
    expect(readCadence('0 0 6 ? * MON 2027')?.hour).toBe(6);
  });

  it('deduplicates a weekday written twice', () => {
    expect(readCadence('0 0 6 ? * MON,MON')?.days).toEqual([1]);
  });
});

describe('refusing an expression rather than guessing at it', () => {
  // Each of these is a schedule the Jobs API accepts and this file will not describe. The surface
  // shows the raw expression instead. A wrong next-review date is worse than an absent one.
  it.each([
    ['a step', '0 0/15 * * * ?'],
    ['a range of hours', '0 0 9-17 * * ?'],
    ['a list of hours', '0 0 6,18 * * ?'],
    ['the last day of the month', '0 0 6 L * ?'],
    ['the nth weekday of the month', '0 0 6 ? * MON#1'],
    ['a nearest weekday', '0 0 6 15W * ?'],
    ['certain months only', '0 0 6 ? JAN,JUL MON'],
    ['too few fields', '0 6 * * MON'],
    ['too many fields', '0 0 6 ? * MON 2027 extra'],
    ['an hour that is not one', '0 0 25 * * ?'],
    ['a minute that is not one', '0 60 6 * * ?'],
    ['a weekday that is not one', '0 0 6 ? * FUNDAY'],
    ['a day of the month that is not one', '0 0 6 32 * ?'],
    ['a day of the month and weekdays together', '0 0 6 15 * MON'],
    ['nothing at all', ''],
  ])('refuses %s', (_what, expression) => {
    expect(readCadence(expression)).toBeUndefined();
  });
});

describe('the cadence in words', () => {
  it('names the zone, because a reader in another one needs to know which', () => {
    const cadence = readCadence('0 0 6 ? * MON');
    expect(cadence && describeCadence(cadence, 'UTC')).toBe('Every Monday at 06:00 UTC');
  });

  it('says every day rather than listing seven', () => {
    const cadence = readCadence('0 30 4 * * ?');
    expect(cadence && describeCadence(cadence, 'UTC')).toBe('Every day at 04:30 UTC');
  });

  it('joins several weekdays with an and', () => {
    const cadence = readCadence('0 0 7 ? * MON,WED,FRI');
    expect(cadence && describeCadence(cadence, 'Australia/Sydney')).toBe(
      'Every Monday, Wednesday and Friday at 07:00 Australia/Sydney'
    );
  });

  it('gives a day of the month its ordinal', () => {
    const first = readCadence('0 0 3 1 * ?');
    expect(first && describeCadence(first, 'UTC')).toBe('Every month on the 1st at 03:00 UTC');

    const second = readCadence('0 0 3 22 * ?');
    expect(second && describeCadence(second, 'UTC')).toBe('Every month on the 22nd at 03:00 UTC');

    const eleventh = readCadence('0 0 3 11 * ?');
    expect(eleventh && describeCadence(eleventh, 'UTC')).toBe('Every month on the 11th at 03:00 UTC');
  });
});

describe('when the next assessment is due', () => {
  const of = (expression: string) => readCadence(expression)!;

  it('finds the coming Monday', () => {
    // Friday 2026-08-07T03:00:00Z.
    const next = nextRun(of('0 0 6 ? * MON'), 'UTC', new Date('2026-08-07T03:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-10T06:00:00.000Z');
  });

  it('skips today where today has already fired', () => {
    // Monday, an hour after the run.
    const next = nextRun(of('0 0 6 ? * MON'), 'UTC', new Date('2026-08-10T07:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-17T06:00:00.000Z');
  });

  it('takes today where today has not fired yet', () => {
    const next = nextRun(of('0 0 6 ? * MON'), 'UTC', new Date('2026-08-10T05:59:59Z'));
    expect(next?.toISOString()).toBe('2026-08-10T06:00:00.000Z');
  });

  it('is strictly after, so a run exactly now is not the next one', () => {
    const next = nextRun(of('0 0 6 ? * MON'), 'UTC', new Date('2026-08-10T06:00:00Z'));
    expect(next?.toISOString()).toBe('2026-08-17T06:00:00.000Z');
  });

  it('holds the local wall-clock time across a daylight-saving change', () => {
    // Sydney leaves daylight saving on 2026-04-05, going from UTC+11 to UTC+10. A 06:00 local
    // schedule is 19:00Z the day before while daylight saving is on, and 20:00Z the day before after
    // it ends. Arithmetic on a UTC instant gets the second of these wrong by an hour.
    const before = nextRun(of('0 0 6 ? * MON'), 'Australia/Sydney', new Date('2026-03-27T00:00:00Z'));
    expect(before?.toISOString()).toBe('2026-03-29T19:00:00.000Z');

    const after = nextRun(of('0 0 6 ? * MON'), 'Australia/Sydney', new Date('2026-04-10T00:00:00Z'));
    expect(after?.toISOString()).toBe('2026-04-12T20:00:00.000Z');
  });

  it('crosses a month, and a year, without special handling', () => {
    const next = nextRun(of('0 0 3 1 * ?'), 'UTC', new Date('2026-12-15T00:00:00Z'));
    expect(next?.toISOString()).toBe('2027-01-01T03:00:00.000Z');
  });

  it('finds the 29th in a leap February', () => {
    const next = nextRun(of('0 0 3 29 * ?'), 'UTC', new Date('2028-02-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2028-02-29T03:00:00.000Z');
  });

  it('finds the 31st by skipping the months that have no such day', () => {
    const next = nextRun(of('0 0 3 31 * ?'), 'UTC', new Date('2026-04-01T00:00:00Z'));
    expect(next?.toISOString()).toBe('2026-05-31T03:00:00.000Z');
  });

  it('gives up rather than spinning on a zone that is not one', () => {
    expect(nextRun(of('0 0 6 ? * MON'), 'Middle/Earth', new Date('2026-08-07T03:00:00Z'))).toBeUndefined();
  });
});
