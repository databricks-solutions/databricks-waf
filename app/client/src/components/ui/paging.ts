// Showing part of a list, on purpose.
//
// This app produces 148 requirements, 20 signals and an unbounded run history, and every page
// that held one of those rendered all of it. A 148-card scroll is not a list the reader browses,
// it is a list they abandon: the useful rows are the first few, the page takes seconds to paint,
// and nothing below the fold is ever read. Bounding the page is what makes the rows above it
// worth ranking.
//
// The page size is the caller's because it is a layout decision — how many rows fit beside
// whatever else that page is showing — not a property of the data.
//
// `reveal` is how a deep link and a pager coexist. A caller that can be entered with one row already
// selected passes that row's index, and the page containing it is the page shown until the reader
// pages away themselves.

// `selectionFrom` is the other half of the same problem: which row the URL asked for, and what
// to do when the list does not hold it.
//
// What is paged is a row rather than a page number, so changing a caller's bounded page size keeps
// the same record in view. See `usePaged`.

import { useMemo, useState } from 'react';

export interface Paged<T> {
  /** The rows to render. */
  readonly rows: readonly T[];
  readonly page: number;
  readonly pages: number;
  readonly total: number;
  /** 1-based, for "5–12 of 148". Both zero when there is nothing at all. */
  readonly from: number;
  readonly to: number;
  readonly setPage: (page: number) => void;
}

/**
 * Which page holds a given row.
 *
 * Exported because it is the whole of the page arithmetic, and because the case it gets wrong when it
 * is not a function of the size — a page number computed at one size and kept at another — cannot be
 * provoked in a one-paint render test. Clamped, so a filter that shortens the list cannot leave a
 * reader on page 7 of 3, which paints an empty table that reads as a data failure rather than as a
 * stale page number.
 */
export function pageHolding(at: number, size: number, pages: number): number {
  return Math.min(Math.max(1, Math.floor(Math.max(at, 0) / size) + 1), pages);
}

export function usePaged<T>(all: readonly T[], size: number, reveal = -1): Paged<T> {
  const pages = Math.max(1, Math.ceil(all.length / size));

  /*
   * The row the page is anchored on, and the `reveal` that anchor was taken for.
   *
   * An anchor rather than a page number, and that is the fix rather than the style. A page number is
   * only meaningful alongside the size it was computed at. A caller can change that bounded size as
   * its composition changes; keeping a page number would then point at a different set of rows.
   *
   * That is not hypothetical. `/findings?control=OE-04-01` landed on page 4 of 15 with the pane
   * showing OE-04-01 and the list showing rows 40 to 52, none of them it. The row is at index 9: the
   * scan arrives a render after the mount, so the page can be derived before its eventual caller state
   * has settled. Anchoring the record rather than the page keeps that transition correct.
   *
   * Anchored, both cases stay right: an unpaged list keeps the revealed row visible whatever the size
   * settles at, and a reader who has paged away keeps the row they paged to rather than being yanked
   * back by a font swap that rewrapped a row.
   *
   * Compared during render rather than corrected in an effect, so the first paint after arriving at a
   * deep link is already the right page — an effect would paint the wrong one and the list would jump.
   *
   * The reveal half of this exists because of the answers page. A finding's remedy links to
   * `/answers?control=X`, the page selected X correctly, and the list beside it stayed on page 1: a
   * reader arriving from a cost requirement got its form on the right and ten unrelated security
   * requirements on the left, none of them highlighted. Nothing was broken and nothing looked right —
   * the app had understood them and had no way of showing it.
   */
  const [chosen, setChosen] = useState({ at: Math.max(reveal, 0), reveal });
  if (chosen.reveal !== reveal) setChosen({ at: Math.max(reveal, 0), reveal });

  const anchor = chosen.reveal === reveal ? chosen.at : Math.max(reveal, 0);
  const page = pageHolding(anchor, size, pages);

  // The reader's own move anchors on the first row of the page they asked for, taken at the size in
  // effect when they asked. So a later resize keeps that row on screen rather than the number.
  const setPage = (wanted: number) => {
    setChosen({ at: (Math.max(1, wanted) - 1) * size, reveal });
  };

  const start = (page - 1) * size;
  const rows = useMemo(() => all.slice(start, start + size), [all, start, size]);

  return {
    rows,
    page,
    pages,
    total: all.length,
    from: all.length === 0 ? 0 : start + 1,
    to: Math.min(start + size, all.length),
    setPage,
  };
}

/** What a page should show beside its list, and why, when the URL named a particular row. */
export interface Selection<T> {
  /** The row to show. Undefined when the URL named one the list does not hold. */
  readonly row: T | undefined;
  /**
   * Set when the URL named a row that is not in the list, with whether the unfiltered list holds
   * it — which is the difference between a filter the reader can widen and an id that is wrong.
   */
  readonly missing?: { readonly id: string; readonly known: boolean };
}

/**
 * The row a URL asked for, or an admission that it is not here.
 *
 * The falling-back-to-the-first-row version of this was a correctness bug rather than a rough
 * edge. `/answers?control=CO-01-03` combined with a pillar filter that excludes CO-01-03 showed
 * the first row of the filtered list instead: highlighted, with a live answer form on the right,
 * and the address bar still reading `control=CO-01-03`. A reader following a link and typing what
 * they knew would have recorded it against a requirement they were never shown the name of. The
 * same substitution happened for an id that does not exist at all, and for one differing only in
 * case, since the match is exact.
 *
 * So a named row that is not in the list produces no row. The caller shows the reason instead,
 * which is the one thing the fallback could not do: say that the link and the filters disagree,
 * and offer to clear them.
 *
 * A visit with nothing named still gets the first row, because there the first row is not
 * standing in for anything — it is the top of the list the reader asked to see.
 */
export function selectionFrom<T>(options: {
  /** The filtered, sorted rows the list is drawn from. */
  readonly all: readonly T[];
  /** The current page of them, for the nothing-was-asked-for case. */
  readonly page: readonly T[];
  /** What the URL named, if anything. */
  readonly asked: string | null | undefined;
  /** Where `asked` sits in `all`, or -1. The same index passed to `usePaged` as `reveal`. */
  readonly at: number;
  /** Whether the list before filtering holds `asked`. Decides which reason the caller shows. */
  readonly known: boolean;
}): Selection<T> {
  const { all, asked, at, known, page } = options;
  if (asked == null || asked === '') return { row: page[0] };
  if (at >= 0) return { row: all[at] };
  return { row: undefined, missing: { id: asked, known } };
}

/**
 * Every filter cleared, and optionally one row still named.
 *
 * For the button offered when a link and the page's filters disagree. Clearing the whole query
 * string is the obvious implementation and the wrong one: it drops the row the reader followed a
 * link to reach, so a button reading "clear filters and show it" cleared the filters and showed
 * them the top of the list instead. Keeping the id is what makes the second half of that sentence
 * true — the row is then found, paged to and revealed by the ordinary path.
 *
 * @param param The query parameter that names a row on this page — `control`, or `job`.
 * @param id The row to keep named, or null to clear that too.
 */
export function onlySelection(param: string, id: string | null): URLSearchParams {
  const next = new URLSearchParams();
  if (id != null && id !== '') next.set(param, id);
  return next;
}
