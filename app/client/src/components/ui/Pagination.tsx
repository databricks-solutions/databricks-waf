// The control that makes a bounded list navigable.
//
// It states the range rather than only the page number, because "13–24 of 148" answers the
// question a page number cannot: how much of the list is left. The range is also the live region,
// so a keyboard or screen-reader user learns the list changed under them without having to go
// looking for the rows.
//
// Rendered even on a single page, showing the count alone. A control that appears and disappears
// as filters narrow makes the panel's height jump and moves whatever sits under it.

import { ChevronLeft, ChevronRight } from 'lucide-react';
import type { Paged } from './paging';

export interface PaginationProps {
  readonly paged: Paged<unknown>;
  /** Plural noun for the range line: "requirements", "runs", "checks". */
  readonly noun: string;
}

export function Pagination({ paged, noun }: PaginationProps) {
  const { page, pages, total, from, to, setPage } = paged;

  return (
    <nav className="flex items-center justify-between gap-3 px-3 py-2" aria-label={`${noun} pagination`}>
      <p className="wa-caption wa-numeric" aria-live="polite">
        {total === 0 ? `No ${noun}` : `${from}–${to} of ${total.toLocaleString()} ${noun}`}
      </p>

      {pages > 1 && (
        <span className="flex items-center gap-1">
          <button
            type="button"
            className="wa-icon-button"
            onClick={() => setPage(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft aria-hidden className="h-4 w-4" />
          </button>
          <span className="wa-caption wa-numeric px-1">
            {page} / {pages}
          </span>
          <button
            type="button"
            className="wa-icon-button"
            onClick={() => setPage(page + 1)}
            disabled={page >= pages}
            aria-label="Next page"
          >
            <ChevronRight aria-hidden className="h-4 w-4" />
          </button>
        </span>
      )}
    </nav>
  );
}
