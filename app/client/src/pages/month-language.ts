// What the monthly page says, in one place because most of it is a judgement rather than a label.
//
// ADR 0072 enumerates the preview/published differences that a test can fail: a named preview
// sentence, no digest until something is frozen, publish versus supersede, standing that names a
// count rather than "the" current copy, and the digest caveat that must not imply origin. A sentence
// buried in JSX is one nobody reviews twice, which is why the other `*-language.ts` modules exist
// and why this one does.
//
// A sentence may restate a field. It may not infer what the platform will do, pick a unique copy
// from a count, or point at something the page does not show.

import type {
  MonthId,
  MonthSummary,
  MonthTrendPoint,
  PublishedMonth,
  PublishingZone,
} from '../api/types';

/**
 * What a live month is, said before the figures rather than in a caption inside them.
 *
 * Modelled on the RunFiles sentence ADR 0072 cites: named, asserted as a string, and specific about
 * what changes it. Publishing is this app's act, so "will not move" is a fact about code here rather
 * than a prediction about the estate.
 */
export const PREVIEW_NOTE =
  'These figures describe the month as it stands. Publishing freezes them into a digest-bearing record ' +
  'that will not move when a later run or decision does.';

/**
 * What a digest does and does not establish, in the same words the export panel uses.
 *
 * ADR 0068 and ADR 0072: a publication page showing a digest is a boundary surface, and this sentence
 * may not be reworded to imply origin. The third sentence of `DigestCaveat` is about exports; the
 * cryptographic claim is these two.
 */
export const DIGEST_NOTE =
  'A digest establishes that a file has not changed. It is not a signature: anybody who can produce the same bytes ' +
  'can produce the same digest, so it answers “has this been altered” and not “who wrote it”.';

/** `durable: false`, restated. The publish error carries the longer Lakebase sentence. */
export const NOT_DURABLE_NOTE =
  'This install keeps nothing that survives a restart, so a month cannot be published here.';

/** The shortest reason a correction may carry, matching the publish route. */
export const MIN_SUPERSEDE_REASON = 12;

const MONTH_NAMES = [
  '',
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** `2026-08` → `August 2026`, from the digits, not a locale. */
export function monthTitle(month: string): string | undefined {
  const parsed = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (parsed == null) return undefined;
  return `${MONTH_NAMES[Number(parsed[2])]} ${parsed[1]}`;
}

/** The calendar month before `month`, or nothing when `month` is not `YYYY-MM`. */
export function previousMonth(month: string): string | undefined {
  const parsed = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (parsed == null) return undefined;
  const year = Number(parsed[1]);
  const ordinal = Number(parsed[2]);
  return ordinal === 1 ? `${year - 1}-12` : `${String(year)}-${String(ordinal - 1).padStart(2, '0')}`;
}

/**
 * The months the navigator lists: published ones, the wall-clock month, and the month before it.
 *
 * Current and previous are included even when unpublished, because those are the months a cadence
 * reader opens — this month's preview, last month's publish. A month two back that was never
 * published is still reachable by URL; it is not guessed into the list.
 */
export function navigatorMonths(
  currentMonth: MonthId,
  published: readonly MonthSummary[]
): readonly string[] {
  const ids = new Set(published.map((row) => row.month));
  ids.add(currentMonth);
  const prior = previousMonth(currentMonth);
  if (prior != null) ids.add(prior);
  return [...ids].sort().reverse();
}

/** An ISO instant as a UTC calendar date, so two machines print the same day. */
export function instantDate(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getUTCDate())} ${MONTH_NAMES[at.getUTCMonth() + 1]} ${String(at.getUTCFullYear())}`;
}

/**
 * Where this publication sits in its month, and whether anything superseded it.
 *
 * Restates `ordinal`, `total`, and `supersededAt` / `current`. Does not say "the current publication":
 * two copies can both have `current: true`, and a count is not a unique name.
 */
export function standingPhrase(publication: PublishedMonth): string {
  const place = `Publication ${String(publication.ordinal)} of ${String(publication.total)}`;
  if (publication.supersededAt != null) {
    return `${place}, superseded on ${instantDate(publication.supersededAt)}.`;
  }
  if (publication.current) return `${place}, not superseded.`;
  return `${place}.`;
}

/**
 * How many publications of this month nothing supersedes, when that number is not one.
 *
 * A count. Not which one stands — the record does not say, and a sentence that picked would be
 * inventing a uniqueness the field does not carry.
 */
export function standingCountNote(count: number): string | undefined {
  if (count === 1) return undefined;
  if (count === 0) return 'This month has not been published.';
  return `${String(count)} publications of this month are not superseded.`;
}

/** Who published it, and that this is attribution rather than approval. */
export function publishedBySentence(publishedBy: string): string {
  return `Published by ${publishedBy}. That records who acted, not approval.`;
}

/**
 * Why publish is disabled on an open month.
 *
 * Prefers the server's `closedNote` when present, because that sentence already names the zone and
 * where it came from. The fallback restates `availableFrom` and `zone` without calling a default
 * UTC the workspace's timezone.
 */
export function unclosedNote(
  label: string,
  availableFrom: string | undefined,
  zone: PublishingZone,
  closedNote?: string
): string {
  if (closedNote != null && closedNote !== '') return closedNote;
  const where =
    zone.source === 'schedule'
      ? `${zone.id}, the timezone the deployed schedule carries`
      : `${zone.id}, which is this app's default because no deployed schedule supplied one`;
  const when = availableFrom != null ? ` Publish becomes available on ${availableFrom}.` : '';
  return `${label} has not ended yet in ${where}.${when}`;
}

/** A trend point's comparability, as a word the badge can carry. */
export const COMPARABILITY_LABEL: Readonly<Record<MonthTrendPoint['comparability'], string>> = {
  permitted: 'Comparable',
  caveat: 'Comparable, with a caveat',
  refused: 'Not comparable',
};

/** Navigator caption: published count, or that this is still a preview. */
export function monthRowCaption(
  month: string,
  currentMonth: string,
  published: readonly MonthSummary[]
): string {
  const row = published.find((one) => one.month === month);
  if (row != null) {
    return row.publications === 1 ? '1 publication' : `${String(row.publications)} publications`;
  }
  if (month === currentMonth) return 'Open';
  return 'Not published';
}
