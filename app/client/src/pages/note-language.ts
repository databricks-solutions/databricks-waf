// The words the notes surfaces use.
//
// Its own module for the reason `improve-language.ts` is: a component file that also exports helpers
// cannot be hot-reloaded, and both of these are read by a page that has no reason to render a thread.

/**
 * How many notes something carries, as a phrase, or nothing at all.
 *
 * Nothing rather than "0 notes", because the absence of a note is not a fact about a run — most runs
 * have none — and a column of zeroes is width spent saying so once per row.
 */
export function noteCountPhrase(counts: Readonly<Record<string, number>> | undefined, id: string): string | undefined {
  const written = counts?.[id] ?? 0;
  if (written === 0) return undefined;
  return `${String(written)} note${written === 1 ? '' : 's'}`;
}

/**
 * When a note was written, in the reader's own locale, to the minute.
 *
 * To the minute rather than to the second, unlike the audit trail. Two notes in the same minute is one
 * person typing, the thread is already shown in the order they were written, and the second would be
 * precision about nothing.
 *
 * An unparseable date is shown as it arrived. It cannot happen through the API — the store refuses a
 * note whose date will not parse — and inventing a plausible one here is the failure worth avoiding.
 */
export function writtenWhen(at: string): string {
  const parsed = new Date(at);
  return Number.isNaN(parsed.getTime()) ? at : parsed.toLocaleString();
}
