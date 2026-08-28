// Types for `guidance-review.mjs`, which stays JavaScript because the check that imports it is a
// plain Node script run straight from source with no build step.

/** Inside this many days, a citation is new enough that the citation is the likelier fault. */
export const OURS_WITHIN_DAYS: number;

/** Past this many months an entry should be looked at again. */
export const AGEING_MONTHS: number;

/** Past this many months it is no longer evidence that anybody has read it. */
export const STALE_MONTHS: number;

/** One authored entry, as the caller knows it. */
export interface ReviewedEntry {
  readonly id: string;
  readonly file: string;
  readonly reviewed: unknown;
}

/** One authored entry, placed against a date. */
export interface Standing extends ReviewedEntry {
  /** The parsed review date, absent only for an entry whose date could not be read. */
  readonly at?: Date;
  /** Whole months between the review date and the date it was placed against, or `null` if undated. */
  readonly months: number | null;
}

/** Every authored entry, sorted by how its review date stands. */
export interface ReviewStanding {
  readonly fresh: readonly Standing[];
  readonly ageing: readonly Standing[];
  readonly stale: readonly Standing[];
  readonly undated: readonly Standing[];
  readonly ahead: readonly Standing[];
}

/** `at` advanced by `months`, clamped to the end of the target month. */
export function addMonths(at: Date, months: number): Date;

/** Whole months from `from` to `to`, rounded down. */
export function monthsBetween(from: Date, to: Date): number;

/** A `YYYY-MM-DD` string as a UTC date, or `null` if it is not one. */
export function asDate(text: unknown): Date | null;

/** Sort every authored entry into how its review date stands against `today`. */
export function reviewStanding(entries: readonly ReviewedEntry[], today: Date): ReviewStanding;

/** What git could establish about when a citation entered the repository. */
export interface CitationHistory {
  /** Whether git answered at all. False means no repository or no git. */
  readonly known: boolean;
  /** Present and true when git answered but the URL is not in history yet. */
  readonly uncommitted?: boolean;
  /** The `YYYY-MM-DD` the URL first appeared, when there is one. */
  readonly since?: string;
}

/** What a broken citation's age says about whose fault it is, as a sentence for a report. */
export function attributeCitation(found: CitationHistory, today: Date): string;
