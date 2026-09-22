// The consistent "show technical detail" expander that dense evidence sits behind.
//
// Every page follows the same shape — plain summary first, technical depth one disclosure away — and
// this is that disclosure, so the label reads the same everywhere rather than being reinvented per
// page. It wraps the shared Disclosure, which is a native <details>: keyboard-operable, correctly
// roled, and openable by find-in-page. Collapsed by default, because the point is that the reader
// chooses to see the tables, coverage figures and provenance rather than being handed them.

import type { ReactNode } from 'react';
import { Disclosure } from '../ui/Disclosure';

export interface DetailDisclosureProps {
  readonly children: ReactNode;
  /** The expander label. Defaults to "Show technical detail". */
  readonly label?: string;
  /** A short hint appended in parentheses, e.g. a count: "3 tables". */
  readonly hint?: string;
  /** Open on first render, for a detail-first context. Collapsed by default. */
  readonly open?: boolean;
}

export function DetailDisclosure({ children, label = 'Show technical detail', hint, open }: DetailDisclosureProps) {
  const summary = hint != null ? `${label} (${hint})` : label;
  return (
    <Disclosure summary={summary} open={open}>
      {children}
    </Disclosure>
  );
}
