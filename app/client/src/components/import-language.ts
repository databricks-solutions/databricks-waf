// The words the import surface puts around a verdict.
//
// Separated from the component because these are the part that can be wrong without failing to
// render. A refused upload reported as "imported", a caution rendered in the voice of a refusal, or an
// age sentence that rounds 29 days to "a month ago" all read perfectly and mislead — and the reader
// they mislead is deciding whether a number on a score page is evidence or not.
//
// The server writes every message; nothing here restates one. What this module does is decide how a
// verdict is titled, how a note is weighted, and how a collection is summarised in one line, which is
// the part that has to be consistent between the two places a verdict appears.

import type { EvidenceImport, EvidenceImportVerdict } from '../api/types';

/** How prominent a note is, which is what the component picks a colour and an icon from. */
export type NoteWeight = 'refusal' | 'caution';

/**
 * The heading over a verdict.
 *
 * Named for what happened rather than for how it went. "Imported" and "Not imported" are both facts
 * the reader can check against the list below; "Success" and "Error" are judgements that leave them
 * asking what was actually recorded.
 */
export function verdictTitle(verdict: EvidenceImportVerdict): string {
  if (verdict.accepted) {
    return verdict.cautions.length === 0 ? 'Imported' : 'Imported, with things worth reading';
  }
  return verdict.refusals.length === 1 ? 'Not imported, for one reason' : `Not imported, for ${String(verdict.refusals.length)} reasons`;
}

/**
 * What an accepted collection answered, in one sentence.
 *
 * The refused count is stated rather than omitted when it is zero, because a reader who imported a
 * file with three denials and later imports one with none needs to see that the number changed. A
 * sentence that appears only sometimes cannot carry that.
 */
export function importedSentence(imported: EvidenceImport): string {
  const parts = [
    `${String(imported.observed)} ${imported.observed === 1 ? 'reading' : 'readings'} across ${String(imported.requirements)} ${imported.requirements === 1 ? 'requirement' : 'requirements'}`,
  ];
  if (imported.refused > 0) {
    parts.push(
      `${String(imported.refused)} ${imported.refused === 1 ? 'call was' : 'calls were'} refused, so those stay unmeasured`
    );
  }
  return `${parts.join('. ')}.`;
}

/**
 * Which authority tiers ran.
 *
 * Both halves named even when only one ran, because the absent one is the point: an account tier that
 * did not run is why a set of requirements is still unanswered after an import, and a reader looking
 * at that set needs the connection made for them.
 */
export function tiersSentence(imported: EvidenceImport): string {
  if (imported.workspaceTier && imported.accountTier) return 'Both the workspace and account tiers ran.';
  if (imported.workspaceTier) return 'The workspace tier ran; the account tier did not.';
  if (imported.accountTier) return 'The account tier ran; the workspace tier did not.';
  // Unreachable through the endpoint, which refuses a file where neither tier ran. Stated rather
  // than thrown, because a component is not the place to discover a server contract has changed.
  return 'Neither tier ran.';
}

/**
 * Who is accountable for a reading.
 *
 * Two different sentences for two different situations, and neither is a blank. An account-tier
 * collection genuinely cannot name its collector — the CLI resolves no identity for an account
 * profile — and "unattributed" said plainly is the honest version of that. Showing an empty field
 * would read as data this app failed to display.
 */
export function collectedBySentence(imported: EvidenceImport): string {
  return imported.collectedBy != null
    ? `Collected by ${imported.collectedBy}, uploaded by ${imported.importedBy}.`
    : `Uploaded by ${imported.importedBy}. The collecting identity is not recorded, which is expected for an account-only collection.`;
}

/**
 * How old a collection is, and how long it has left.
 *
 * Whole days from the collection date rather than a relative phrase, because the number is load
 * bearing: it is what expires the file, and a reader deciding whether to re-run the script needs the
 * figure the rule is applied to rather than a rounding of it.
 */
export function ageSentence(generatedAt: string, acceptedForDays: number, now: Date = new Date()): string {
  const collected = Date.parse(generatedAt);
  if (Number.isNaN(collected)) return 'Collected at an unreadable time.';

  const days = Math.max(0, Math.floor((now.getTime() - collected) / 86_400_000));
  const left = acceptedForDays - days;

  if (days === 0) return 'Collected today.';
  const ago = `Collected ${String(days)} ${days === 1 ? 'day' : 'days'} ago`;
  if (left <= 0) return `${ago}, so it is past the ${String(acceptedForDays)} days a collection is accepted for.`;
  return `${ago}, ${String(left)} ${left === 1 ? 'day' : 'days'} before it expires.`;
}

/** The first twelve hex characters, which is enough to compare two by eye and short enough to read. */
export function shortDigest(digest: string): string {
  return digest.replace(/^sha256:/, '').slice(0, 12);
}

/**
 * What the reader should understand about where an import is kept.
 *
 * Only said when it is not kept. A sentence confirming that records persist is noise on every install
 * that works; the warning is the case somebody has to act on, and it has to say what is lost rather
 * than that storage is "not configured".
 */
export function durabilityWarning(durable: boolean): string | undefined {
  return durable
    ? undefined
    : 'This install keeps imported evidence in memory, so anything imported here is lost when the app restarts — ' +
        'which happens on every deploy. The requirements it answers would revert to unanswered with no record that ' +
        'they had ever been answered. Bind a Lakebase database before relying on an import.';
}

/**
 * A list key for one note, unique among its siblings even when two share a reason.
 *
 * Extracted from the component so the rule can be asserted, because the failure it prevents cannot be
 * rendered: `renderToStaticMarkup` emits every child whatever its key, so a static test of the list
 * passes with duplicate keys and proves nothing. The damage happens on re-render, when React reconciles
 * two siblings that claim the same identity and keeps one.
 *
 * Reasons are not unique. `checkTiers` emits one `unattributed` caution per tier, so an envelope where
 * neither tier named a collecting user carries two notes with one reason and two different sentences —
 * and a verdict whose entire contract is that every reason is stated would show one of them.
 */
export function noteKey(note: { readonly reason: string }, at: number): string {
  return `${note.reason}-${String(at)}`;
}
