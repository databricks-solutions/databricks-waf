// The URL named a row that is not in the list.
//
// Four pages can be entered with a row already named — a finding's "answer this requirement"
// link, the overview's priority list, a bookmark, a link someone pasted into a ticket. Each of
// them used to fall back to the first row of the filtered list, which is the wrong-answer failure
// this component replaces: a highlighted row, a live form, and an address bar still naming a
// different requirement. See `selectionFrom` in ui/paging for what that cost.
//
// The two cases are separated because only one of them is the reader's to fix. A row excluded by
// their own filters comes back when they widen them, and the button does it for them. An id the
// data has never held is a bad link, and telling that reader to adjust their filters would send
// them round a loop that cannot close.

import { EmptyState } from './EmptyState';

export interface NotInListProps {
  /** What the URL asked for, shown so the reader can compare it with the link they followed. */
  readonly id: string;
  /** Whether the unfiltered list holds it. False means the id itself is wrong. */
  readonly known: boolean;
  /** What the rows are, in the reader's words: "requirement", "finding", "job". */
  readonly noun: string;
  /**
   * Clears the filters.
   *
   * `keepSelection` is the difference between the two buttons, and it is the whole point of the
   * one that says "and show it": clearing the filters alone returns the reader to the top of an
   * unfiltered list still having to hunt for the row their link named, which is most of the
   * original complaint. True keeps the named row selected so it is revealed on arrival; false
   * drops it, because an id the data does not hold would otherwise re-raise this same panel.
   */
  readonly onClear: (keepSelection: boolean) => void;
}

export function NotInList({ id, known, noun, onClear }: NotInListProps) {
  if (!known) {
    return (
      <EmptyState
        reason="no-evidence"
        heading={`No ${noun} called ${id}`}
        detail={
          `This link names a ${noun} this assessment does not hold. Either the id is wrong, or it comes from a ` +
          `build whose catalogue differs from this one. Nothing is shown rather than the nearest ${noun}, which ` +
          'would look like an answer to the question the link asked.'
        }
        action={
          <button type="button" className="wa-button-secondary" onClick={() => onClear(false)}>
            Show the whole list
          </button>
        }
      />
    );
  }

  return (
    <EmptyState
      reason="filtered-out"
      heading={`${id} is filtered out`}
      detail={
        `This link names ${id}, and the filters on this page exclude it. It is shown once they are cleared. ` +
        `Until then nothing is shown here rather than a different ${noun}, because a form filled in against the ` +
        `wrong ${noun} is worse than an empty pane.`
      }
      action={
        <button type="button" className="wa-button-secondary" onClick={() => onClear(true)}>
          Clear filters and show it
        </button>
      }
    />
  );
}
