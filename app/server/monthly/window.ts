// The two instants a month spans, in the workspace's configured timezone.
//
// `content.ts` (28b) windows a month's records against a half-open `[start, end)` of instants, and
// this is where those instants come from — the endpoint layer, beside where the timezone is resolved
// from the schedule. A month is a span in a zone, not in UTC: August in Los Angeles begins seven or
// eight hours after it begins in London, and a window computed in UTC would file a run made at 11pm
// on the 31st under the wrong month for half the world.
//
// # Why the offset is looked up per boundary rather than assumed
//
// A zone's offset is not constant across a month — daylight saving moves it — so the start and the
// end of the window are computed independently, each against the offset in force at its own boundary.
// A month that contains a spring-forward has an end four hours from UTC and a start five, and taking
// one offset for both would put the window an hour out for the part of the month on the other side of
// the change. The boundaries themselves are local midnight on the first, which is not a moment any
// zone moves its clocks at, so the single lookup at each boundary is exact rather than approximate.

import type { MonthId } from './publication.js';
import type { MonthWindow } from './content.js';

/** The wall-clock parts a zone shows at an instant, read by type so the locale cannot change them. */
function partsInZone(instant: Date, timezone: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { y: value('year'), mo: value('month'), d: value('day'), h: value('hour'), mi: value('minute'), s: value('second') };
}

/**
 * The UTC instant at which a zone's wall clock reads the given local time.
 *
 * Computed by asking what a zone shows for a guess made as if the wall time were UTC, and correcting
 * by the difference — the standard single-pass inversion. Exact at a local midnight, which is the only
 * time this is asked for, because midnight on the first of a month is never a daylight-saving instant.
 */
function zonedWallToUtc(y: number, mo: number, d: number, timezone: string): Date {
  const guess = Date.UTC(y, mo - 1, d, 0, 0, 0);
  const seen = partsInZone(new Date(guess), timezone);
  const seenAsUtc = Date.UTC(seen.y, seen.mo - 1, seen.d, seen.h, seen.mi, seen.s);
  // How far ahead of UTC the zone is at this boundary. Subtracting it turns the local midnight into
  // the UTC instant that shows as local midnight.
  const offset = seenAsUtc - guess;
  return new Date(guess - offset);
}

/**
 * The half-open span `[start, end)` of `month` in `timezone`.
 *
 * `start` is the first instant of the month in the zone; `end` is the first instant of the next,
 * which is the month after December of the same year rolled to January of the next. Half-open so a
 * record at the very first instant of the next month belongs to that month alone.
 */
export function monthWindow(month: MonthId, timezone: string): MonthWindow {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const ordinal = Number(monthText);
  const start = zonedWallToUtc(year, ordinal, 1, timezone);
  const end = zonedWallToUtc(ordinal === 12 ? year + 1 : year, ordinal === 12 ? 1 : ordinal + 1, 1, timezone);
  return { start, end };
}
