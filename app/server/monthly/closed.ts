// Whether a calendar month has ended, in the timezone the workspace keeps its cadence in.
//
// A month may be published only once it has closed (ADR 0072), and "closed" is a claim about a
// timezone rather than about an instant. August ends at a different UTC moment in Auckland than in
// Los Angeles, and a rule that closed August at midnight UTC on the first of September would let a
// workspace on the American west coast publish August while it was still the 31st there — a month
// reporting on a day that had not happened yet.
//
// So the rule reads what month it *is* on the wall clock in the configured zone, and compares. A
// month has closed once that clock has moved into a later month, and no earlier: the comparison is
// between two `YYYY-MM` strings, which order the same lexically as they do chronologically because
// both are fixed-width and zero-padded. There is no date arithmetic here and so no daylight-saving
// edge to get wrong — the platform's own `Intl` says what the wall clock reads, and the rest is a
// string comparison.
//
// # Where the timezone comes from is not decided here
//
// This takes the timezone as an argument. The workspace's configured zone is the scheduled job's
// `timezone_id`, read through the schedule surface, and resolving it — including the default when no
// schedule is deployed — is the endpoint's, because that is where the live sources are read (28c).
// Keeping it out of here is what lets the rule be tested against a fixed zone and a fixed instant
// rather than against a schedule, and it is the same separation the content assembler keeps: the
// pure computation takes what it needs already resolved.

import { parseMonth, type MonthId } from './publication.js';

/**
 * The month a wall clock in `timezone` reads at the instant `now`.
 *
 * From `Intl` rather than from `Date` arithmetic, because "what month is it there" is exactly what a
 * localised formatter answers and exactly what an offset calculation gets wrong twice a year. The
 * parts are read by type rather than by parsing a formatted string, so the locale cannot change the
 * answer — `month: '2-digit'` is numeric whatever the locale would otherwise render.
 *
 * Throws on a timezone `Intl` does not recognise, rather than falling back to UTC: a silent fallback
 * would close a month on the wrong clock and publish it, which is the failure this module exists to
 * refuse. The caller resolves a real zone or the explicit UTC default before reaching here.
 */
export function currentMonthIn(timezone: string, now: Date): MonthId {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const year = parts.find((part) => part.type === 'year')?.value;
  const month = parts.find((part) => part.type === 'month')?.value;
  const parsed = parseMonth(`${year ?? ''}-${month ?? ''}`);
  if (parsed === undefined) {
    // Unreachable for a valid zone — `Intl` gives a four-digit year and a two-digit month — but a
    // parse that fails is a bug, not a refusal, so it is thrown as one rather than returned.
    throw new Error(`Could not read the current month in timezone "${timezone}".`);
  }
  return parsed;
}

/**
 * Whether `month` has ended in `timezone` as at `now`.
 *
 * True when the wall clock in that zone has moved into a later month, false while it is still in
 * `month` or earlier. The strict comparison is the whole rule: the current month is not yet closed —
 * its cadence is still accumulating runs — and a future month has plainly not closed either.
 */
export function monthHasClosed(month: MonthId, timezone: string, now: Date): boolean {
  return currentMonthIn(timezone, now) > month;
}
