// A paragraph the reader can choose to read.
//
// This app has to say a great deal that is true, necessary and not what anyone came for: why an
// unmeasured requirement is not a failure, what a sampled coverage claim does and does not
// license, why two runs may not be compared. Printed inline, those paragraphs pushed the numbers
// below the fold and were skipped anyway. Deleted, the app becomes the kind of tool that reports a
// score and lets the reader assume it means more than it does.
//
// So they are put behind a summary line that states the question, which is the one form of this
// the reader can act on: it is visible, it is searchable in the page, and opening it is one click.
//
// A native <details> rather than a state hook and a chevron, because the browser gives keyboard
// operation, the correct role, and find-in-page that opens the section — the last of which no
// hand-built accordion does.

import { ChevronRight } from 'lucide-react';
import type { ReactNode } from 'react';

export interface DisclosureProps {
  /** Phrased as the question it answers, not as a label. "Why X" beats "Notes". */
  readonly summary: string;
  readonly children: ReactNode;
  readonly open?: boolean;
}

export function Disclosure({ summary, children, open }: DisclosureProps) {
  return (
    <details className="group" open={open}>
      <summary className="wa-body-compact flex cursor-pointer list-none items-center gap-1 text-wa-text-secondary hover:text-wa-text">
        <ChevronRight aria-hidden className="h-3.5 w-3.5 shrink-0 transition-transform group-open:rotate-90" />
        {summary}
      </summary>
      <div className="wa-body-compact mt-1.5 space-y-1.5 border-l-2 border-wa-divider pl-3 text-wa-text-secondary">
        {children}
      </div>
    </details>
  );
}
