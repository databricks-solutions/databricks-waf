// Paging, tested through a component because that is the only way the hook exists.
//
// The assertion that matters is the first paint. A reader arriving from "Answer this requirement"
// gets one render before they judge whether the app understood them, so a hook that lands on page one
// and corrects itself afterwards fails this test even though it ends up on the right page. Rendering
// to static markup is exactly one paint, which is why it is the harness here.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { onlySelection, pageHolding, selectionFrom, usePaged } from './paging';

const ROWS = Array.from({ length: 45 }, (_, index) => `row-${String(index)}`);

function Probe({ reveal }: { reveal?: number }) {
  const paged = usePaged(ROWS, 10, reveal);
  return (
    <p>
      page {paged.page} of {paged.pages}: {paged.rows.join(' ')} [{paged.from}–{paged.to} of {paged.total}]
    </p>
  );
}

function shown(reveal?: number): string {
  return renderToStaticMarkup(<Probe {...(reveal == null ? {} : { reveal })} />);
}

describe('a paged list', () => {
  it('starts at the top when nothing is being revealed', () => {
    expect(shown()).toContain('page 1 of 5');
    expect(shown()).toContain('row-0 row-1');
    expect(shown()).toContain('[1–10 of 45]');
  });

  it('opens on the page holding the revealed row, in the first paint', () => {
    // 32 is on page 4. The bug this replaces showed page 1 with the fourth page's row selected
    // somewhere off it, so a reader saw ten rows they had not asked for and no highlight among them.
    expect(shown(32)).toContain('page 4 of 5');
    expect(shown(32)).toContain('row-30 row-31 row-32');
  });

  it('puts a row at a page boundary on its own page rather than the one before it', () => {
    // Off-by-one country. Index 10 is the first row of page 2, index 9 the last of page 1.
    expect(shown(9)).toContain('page 1 of 5');
    expect(shown(10)).toContain('page 2 of 5');
  });

  it('treats no selection as no instruction, rather than as row zero', () => {
    // The pages pass -1 from findIndex when the deep link names something the filters exclude.
    expect(shown(-1)).toContain('page 1 of 5');
    expect(shown(-1)).toContain('row-0 row-1');
  });
});

describe('which page holds a row', () => {
  /*
   * The size is measured rather than chosen, so this is asked again every time the measurement moves.
   *
   * `/findings?control=OE-04-01` landed on page 4 of 15 showing rows 40 to 52 with the pane showing
   * OE-04-01, which is at index 9. The page had been derived while the cold-load measurement was still
   * three rows — `floor(9/3) + 1` is 4 — and kept when it settled at thirteen. Same row, same list, two
   * answers, and only one of them has the row on screen.
   */
  it('is asked of the size in effect, not the size it was first asked at', () => {
    expect(pageHolding(9, 3, 15)).toBe(4);
    expect(pageHolding(9, 13, 15)).toBe(1);
  });

  it('puts the first row of a page on that page rather than the one before', () => {
    expect(pageHolding(12, 13, 15)).toBe(1);
    expect(pageHolding(13, 13, 15)).toBe(2);
  });

  it('reads no selection as the top', () => {
    // -1 is what findIndex returns for a deep link the filters exclude, and 0 is the first row. Both
    // mean "start at the beginning" here; which of them it was is `selectionFrom`'s question.
    expect(pageHolding(-1, 13, 15)).toBe(1);
    expect(pageHolding(0, 13, 15)).toBe(1);
  });

  it('clamps to the pages there are', () => {
    // A filter shortening the list otherwise leaves the reader on page 7 of 3, which paints an empty
    // table that reads as a data failure rather than as a stale page number.
    expect(pageHolding(90, 13, 3)).toBe(3);
    expect(pageHolding(90, 13, 1)).toBe(1);
  });
});

describe('the row a URL asked for', () => {
  const page = ROWS.slice(0, 10);

  const resolve = (asked: string | null, at: number, known: boolean) =>
    selectionFrom({ all: ROWS, page, asked, at, known });

  it('is the named row when the list holds it', () => {
    expect(resolve('row-32', 32, true)).toEqual({ row: 'row-32' });
  });

  it('is the top of the list when nothing was named', () => {
    // Not a substitution: the reader asked for the list, and this is the first thing in it.
    expect(resolve(null, -1, false)).toEqual({ row: 'row-0' });
    expect(resolve('', -1, false)).toEqual({ row: 'row-0' });
  });

  // The bug. A named row the filters exclude used to resolve to the first row of the filtered list,
  // highlighted, with a live form beside it and the URL still naming the other one.
  it('is nothing at all when the filters exclude the named row', () => {
    expect(resolve('row-32', -1, true)).toEqual({ row: undefined, missing: { id: 'row-32', known: true } });
  });

  it('says whether the id is merely filtered out or not held at all', () => {
    // The two need different advice: one is cleared by widening the filters, the other is a bad
    // link, and telling that reader to adjust their filters sends them round a loop.
    expect(resolve('row-32', -1, true).missing?.known).toBe(true);
    expect(resolve('nonsense', -1, false).missing?.known).toBe(false);
  });

  it('does not substitute for an id that differs only in case', () => {
    // Matching is exact everywhere else in the app, so `?control=co-01-03` misses. It has to miss
    // visibly: this is the shape a hand-typed or lower-cased link arrives in.
    expect(resolve('ROW-32', -1, false).row).toBeUndefined();
  });

  // The button says "clear filters and show it", and dropping the id would only do the first half.
  it('keeps the named row when clearing filters is meant to reveal it', () => {
    expect(onlySelection('control', 'CO-01-03').toString()).toBe('control=CO-01-03');
    expect(onlySelection('job', '100').toString()).toBe('job=100');
  });

  it('drops the id when the list does not hold it, so the same panel does not reappear', () => {
    expect(onlySelection('control', null).toString()).toBe('');
    expect(onlySelection('control', '').toString()).toBe('');
  });

  it('holds nothing back when the list is empty', () => {
    expect(selectionFrom({ all: [], page: [], asked: null, at: -1, known: false }).row).toBeUndefined();
    expect(selectionFrom({ all: [], page: [], asked: 'row-1', at: -1, known: false }).missing?.id).toBe('row-1');
  });
});
