// A month of the operating cadence, as a record that can be published once and read forever.
//
// The word this file exists to make true is *immutable*, and ADR 0072 spent its length deciding what
// that means here rather than leaving it to the reader: an assessment export stays live and moves when
// a decision does, because it answers "what is true now"; a published month is frozen at publish,
// because it answers "what did the cadence report for this month". If accepting a risk in September
// changed what August's month said, August would not be evidence of anything.
//
// So a publication is not a view assembled on read. It is a stored record whose bytes are built once,
// at publish, and served back verbatim — and it carries its own identity *inside* those bytes (month,
// publication instant, publication id), because the bytes are the thing that travels and a recipient
// checking a digest has nothing else to compare against. The record here is that identity plus the two
// formats' bytes and the digest over them. The bytes' content — the denormalised document — is
// `document.ts`, and the write rules that decide when one may be created are 28b's endpoints.
//
// # A month is a string, not a Date
//
// `2026-08` rather than a timestamp, and the distinction is not pedantry. A month is a span in the
// workspace's configured timezone, so "August" is not a moment and reducing it to one — midnight on
// the first, say — is a value that reads as July to anyone an hour west of the timezone that minted
// it. The label a reader sees is derived here from the fixed name of the month, never from a locale or
// a `toLocaleString`, so the same publication reads the same on every machine that opens it.

import type { Digest } from '../records/digest.js';

/**
 * A calendar month, `YYYY-MM`, in the workspace's configured timezone.
 *
 * A branded string rather than a bare one, so a `MonthId` cannot be confused with the many other
 * strings a publication carries — an actor, a run label, a control id — and a function asking for a
 * month cannot be handed a timestamp that happens to start with four digits. The brand is erased at
 * runtime; `parseMonth` is the only way to obtain one, which is what makes the shape a guarantee
 * rather than a convention.
 */
export type MonthId = string & { readonly __brand: 'MonthId' };

/** `YYYY-MM`, with the month in `01`–`12`. Anchored, so a longer string carrying a valid prefix fails. */
const MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/**
 * A `MonthId` from a string, or `undefined` when it is not one.
 *
 * The only constructor, because a month reaches storage and a filename and a digest's bytes, and a
 * value that has not been proven to be `YYYY-MM` is a value that will one day be `2026-8` or
 * `August` in one of those places. Returning `undefined` rather than throwing leaves the caller to
 * decide whether a bad month is a refusal or a bug — a request supplies one and a stored row does
 * not, and those want different handling.
 */
export function parseMonth(raw: unknown): MonthId | undefined {
  if (typeof raw !== 'string') return undefined;
  return MONTH.test(raw) ? (raw as MonthId) : undefined;
}

/** The full month names, indexed 1–12. Fixed here so a label never depends on a machine's locale. */
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

/**
 * A month in the words a reader uses for it: `2026-08` becomes `August 2026`.
 *
 * From the string's own digits rather than a `Date`, because turning `2026-08` into a `Date` to read
 * its month back is a round trip through a timezone that can land in July, and the label is baked into
 * frozen bytes where being wrong is permanent.
 */
export function monthLabel(month: MonthId): string {
  const [year, ordinal] = month.split('-');
  return `${MONTH_NAMES[Number(ordinal)]} ${year}`;
}

/**
 * The calendar date a month becomes publishable: the first of the next month, in that month's own
 * names rather than a timezone-formatted instant.
 *
 * A reader waiting on August is told "1 September 2026", which is when August has closed on any
 * clock that still calls it August. The instant that date arrives depends on the workspace zone and
 * is the closure rule's; this is only the date the preview names beside a disabled publish action.
 */
export function monthOpensOn(month: MonthId): string {
  const [yearText, monthText] = month.split('-');
  const year = Number(yearText);
  const ordinal = Number(monthText);
  const nextOrdinal = ordinal === 12 ? 1 : ordinal + 1;
  const nextYear = ordinal === 12 ? year + 1 : year;
  return `1 ${MONTH_NAMES[nextOrdinal]} ${String(nextYear)}`;
}

/**
 * What a publication is, before it has any bytes: who is publishing which month, when, and — for a
 * correction — which earlier publication it supersedes and why.
 *
 * Split from the stored record below because it is the input the document builder bakes into the
 * bytes and the write path assembles from a request, where the digest and the bytes do not yet exist.
 * A month may hold several publications; this is one of them.
 */
export interface PublicationIdentity {
  /** Minted by this app, unique across every publication of every month. Carried in the bytes. */
  readonly id: string;
  readonly month: MonthId;
  /** The publication instant, carried in the bytes so a digest resolves to a moment as well as a month. */
  readonly publishedAt: Date;
  /** Who published it, from the forwarded identity. Recording who acted, never approval — see ADR 0072. */
  readonly publishedBy: string;
  /**
   * The publication this one supersedes, when it is a correction.
   *
   * Absent on a month's first publication. A supersession names its predecessor rather than editing
   * it, because the superseded copy stays readable at its own digest — deleting it would leave a
   * digest recorded in the trail pointing at bytes that no longer exist, the failure ADR 0050 exists
   * to prevent.
   */
  readonly supersedes?: string;
  /**
   * Why this correction was published, in the words of whoever published it.
   *
   * Present exactly when `supersedes` is: a first publication corrects nothing and has no reason to
   * give, and a correction with no reason is a record nobody can account for later. The endpoint that
   * enforces the pairing and the minimum length is 28b; the record only carries what it was given.
   */
  readonly reason?: string;
}

/**
 * A published month as it is stored and served: its identity, the format bytes built at publish, and
 * the digest over the JSON.
 *
 * `json` and `csv` are the bytes as sent, held verbatim. The read path returns them without rebuilding
 * — that is the whole of "frozen", and the reason the store keeps text rather than a parsed document
 * (ADR 0032: `jsonb` returns its keys in whatever order it likes, so a digest over what was stored
 * would not match what is read back). `documentVersion` is a copy of the integer inside the JSON,
 * promoted to a column so a renderer can refuse a shape it does not understand without parsing the
 * whole document first.
 */
export interface Publication extends PublicationIdentity {
  /** The version of the document format inside `json`, so a reader can tell shapes apart. */
  readonly documentVersion: number;
  /** The JSON document, verbatim. The bytes a `sha256` of gives `digest`. */
  readonly json: string;
  /** The CSV rendering of the same publication, verbatim. Has its own digest a recipient can check. */
  readonly csv: string;
  /**
   * The digest over `json`'s bytes. The JSON digest identifies the publication (ADR 0072).
   *
   * Over the bytes as stored, so a recipient runs `shasum -a 256` on the file this app served and
   * compares — no library of ours in the path. Computed once at publish and held here, which is the
   * one place a digest is a copy of something stored beside the record: a publication is a record that
   * also travels, so the column is the copy that governs. See ADR 0072 and the boundary comment in
   * `audit/event.ts`.
   */
  readonly digest: Digest;
  /**
   * This publication's position in its month, from 1. The key that keeps a month from holding two of
   * them at the same position.
   *
   * Not part of the identity, so it is not baked into the bytes: it is a fact about the month's record
   * rather than about the document, and adding it to the document would change a format that is frozen.
   *
   * It exists because position alone could not refuse a race. Two concurrent first publications both read
   * a month with nothing in it and both wrote one, and the month then held two publications neither of
   * which superseded the other. `(month, ordinal)` is unique in the database, so the second of those is
   * refused — and so is the second of two corrections of the same standing copy, which claim the same
   * next position.
   *
   * The read path takes position from the order it reads rather than from this. The constraint is what
   * keeps the two the same, and absent means a row written before the column existed — in which case the
   * store holds it against nothing, because a row already written is not a race anybody can still lose.
   */
  readonly ordinal?: number;
  /** The assessment this publication belongs to. Absent means it named none. */
  readonly definitionId?: string;
}

/**
 * The publications of a month that nothing supersedes, in publication order.
 *
 * Supersession is read from the successor that claims it rather than from adjacency, because on an
 * append-only record adjacency is not evidence: a month that holds two publications neither of which
 * names the other is a month where nothing was superseded, and calling the earlier one superseded would
 * be the read path writing history that did not happen.
 *
 * More than one means exactly that, and there is nothing here that says which of them replaced which.
 * A caller may report the count. It may not pick one.
 */
export function unsuperseded(publications: readonly Publication[]): Publication[] {
  const replaced = new Set(
    publications.map((publication) => publication.supersedes).filter((id): id is string => id != null)
  );
  return inPublishedOrder(publications).filter((publication) => !replaced.has(publication.id));
}

/**
 * The publication that superseded this one, or undefined where nothing did.
 *
 * By name, for the reason above. The month is passed whole rather than a successor by position.
 */
export function supersededBy(
  publication: Publication,
  publications: readonly Publication[]
): Publication | undefined {
  return publications.find((candidate) => candidate.supersedes === publication.id);
}

/**
 * A month's publications in the order they were published, so standing can be read from position.
 *
 * Oldest first, which is publication order because `publishedAt` only moves forward within a month.
 * Whether a publication is current or superseded is not stored on it — that would be a mutation of an
 * append-only record — but derived from where it sits: the last is current, the rest are superseded.
 * The reading of that ordinal into a sentence ("publication 2 of 3, superseded on…") is 28c's; this
 * only fixes the order the reading depends on.
 */
export function inPublishedOrder(publications: readonly Publication[]): Publication[] {
  return [...publications].sort((left, right) => {
    const byTime = left.publishedAt.getTime() - right.publishedAt.getTime();
    // A stable tie-break on the id, so two publications minted in the same millisecond — which a test
    // can construct and a fast machine could — order the same way on every read rather than however
    // the sort happened to leave them.
    return byTime !== 0 ? byTime : left.id.localeCompare(right.id);
  });
}
