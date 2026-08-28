/*
 * How the authored guidance stands against its own review dates.
 *
 * The completeness gate that shipped with row 8 checks whether a field is filled, which is not the
 * same question as whether it is still true. A rubric written against last year's console has every
 * field populated at every minimum length and reads exactly like a current one, so the failure is
 * silent, and because nothing about it degrades it is also cumulative: sixty-three entries drift
 * together and the first symptom is a customer following a menu path that no longer exists.
 *
 * Two thresholds rather than one, because the honest answer to "is this entry stale" is not a
 * boolean. Six months is when somebody should look; twelve is when the entry has stopped being
 * evidence of anything. A single failing threshold would have to be the later one to be fair, and
 * then nothing is said for a year.
 *
 * Split out of `check-guidance.mjs` so it can be tested. Every date in the tree today is two days
 * old, so the gate cannot fire, and a gate whose first real run is in six months is a gate nobody
 * has ever seen work — `guidance-review.test.ts` is what makes it more than an intention.
 */

/** Inside this many days, a citation is new enough that the citation is the likelier fault. */
export const OURS_WITHIN_DAYS = 14;

/** Past this many months an entry should be looked at again. */
export const AGEING_MONTHS = 6;

/** Past this many months it is no longer evidence that anybody has read it. */
export const STALE_MONTHS = 12;

/**
 * `at` advanced by `months`, clamped to the end of the target month.
 *
 * Calendar months rather than a day count because the rule is a review cadence, and "six months"
 * meaning 182 days puts the boundary on a different day of the month every year for no reason a
 * reader could predict. The clamp is what stops 31 August plus six months landing in March: without
 * it, `Date` rolls 31 February forward and the deadline silently moves later.
 */
export function addMonths(at, months) {
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth() + months;
  const day = at.getUTCDate();
  const lastOfTarget = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, lastOfTarget)));
}

/**
 * Whole months from `from` to `to`, rounded down. For reporting only.
 */
export function monthsBetween(from, to) {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

/**
 * A `YYYY-MM-DD` string as a UTC date, or `null` if it is not one.
 *
 * Strict rather than `new Date(text)`, which accepts `2026-13-45` in some runtimes and a bare year in
 * others. This value decides whether a gate fires, so a string it cannot vouch for has to come back
 * as nothing rather than as a date nobody intended.
 */
export function asDate(text) {
  if (typeof text !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (parts == null) return null;
  const [, year, month, day] = parts.map(Number);
  const at = new Date(Date.UTC(year, month - 1, day));
  // Round-trip, so 2026-02-30 is refused rather than becoming 2 March.
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) return null;
  return at;
}

/**
 * Sort every authored entry into how its review date stands against `today`.
 *
 * @param {ReadonlyArray<{ id: string, file: string, reviewed: unknown }>} entries Authored entries only.
 *   A draft has no content to go stale and asking it for a review date would make the gate an
 *   argument about the backlog instead of about what a customer reads.
 * @param {Date} today
 */
export function reviewStanding(entries, today) {
  const fresh = [];
  const ageing = [];
  const stale = [];
  const undated = [];
  const ahead = [];

  for (const entry of entries) {
    const at = asDate(entry.reviewed);
    if (at == null) {
      undated.push({ ...entry, months: null });
      continue;
    }

    // A date in the future is the one fault that turns the gate off rather than tripping it, and it
    // is a plausible typo: a year keyed as 2027 reads as diligence and buys silence until 2028. It
    // fails immediately, because every other outcome here would be a lie about that entry.
    if (at.getTime() > today.getTime()) {
      ahead.push({ ...entry, at, months: monthsBetween(today, at) });
      continue;
    }

    const months = monthsBetween(at, today);
    const standing = { ...entry, at, months };
    if (today.getTime() >= addMonths(at, STALE_MONTHS).getTime()) stale.push(standing);
    else if (today.getTime() >= addMonths(at, AGEING_MONTHS).getTime()) ageing.push(standing);
    else fresh.push(standing);
  }

  const order = (a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0);
  return {
    fresh: fresh.sort(order),
    ageing: ageing.sort(order),
    stale: stale.sort(order),
    undated,
    ahead: ahead.sort(order),
  };
}

/**
 * What a broken citation's age says about whose fault it is, as a sentence for a report.
 *
 * The scheduled link check fails for two unrelated reasons — the documentation site renamed a page
 * while nobody here touched anything, or somebody here wrote the URL wrong — and they need different
 * responses. A weekly failure that cannot tell them apart is one a reader learns to close unread, so
 * the age of the citation in this repository is the evidence that separates them.
 *
 * Pure and tested because the branch that matters is the one that only runs during an incident. Every
 * URL in the tree today was committed days ago, so a real run can only ever exercise the recent case;
 * the long-standing case is the one a reader will actually be reading in a year.
 *
 * @param {{ known: boolean, uncommitted?: boolean, since?: string }} found What git could establish.
 * @param {Date} today
 */
export function attributeCitation(found, today) {
  if (!found.known) {
    return 'no git history here, so this cannot say whether the page moved or the citation is wrong';
  }
  if (found.uncommitted === true) {
    return 'not committed yet — this citation is new work here, so check the URL before anything else';
  }
  const at = asDate(found.since);
  if (at == null) return 'cited here since an unreadable date, so this cannot attribute it';

  const days = Math.floor((today.getTime() - at.getTime()) / 86_400_000);
  // A citation dated after today is a clock disagreement rather than evidence, and claiming the page
  // moved on the strength of it would be the report inventing a cause.
  if (days < 0) return `cited here since ${found.since}, which is after today — check the clock, not the page`;
  if (days <= OURS_WITHIN_DAYS) {
    return `cited here since ${found.since}, ${days} day${days === 1 ? '' : 's'} ago — recent enough that the citation is the likelier fault`;
  }
  const months = monthsBetween(at, today);
  const age = months >= 1 ? `about ${months} month${months === 1 ? '' : 's'}` : `${days} days`;
  return `cited here unchanged since ${found.since}, ${age} — the page moved rather than the citation`;
}
