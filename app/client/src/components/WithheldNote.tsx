// What stands where a field the reader may not see would have been.
//
// The server sends a placeholder instead of statement text, principal names or an administrator's
// imported reading, naming what is withheld and which group can see it. This renders that sentence as it
// arrived, so the page says why there is a gap and who to ask rather than leaving one. Decision D1 in
// docs/decisions.md.

import type { Evidence, Withheld } from '../api/types';

export interface WithheldNoteProps {
  readonly withheld: Withheld;
}

export function WithheldNote({ withheld }: WithheldNoteProps) {
  return (
    <span className="text-wa-text-secondary" data-withheld={withheld.withheld}>
      {withheld.reason}
    </span>
  );
}

/** What a piece of evidence observed, or the placeholder that stands where it would have been. */
export function EvidenceValue({ evidence }: { readonly evidence: Evidence }) {
  return evidence.withheld != null ? <WithheldNote withheld={evidence.withheld} /> : <>{evidence.observed}</>;
}
