// When a detail pane has to scroll itself into view.
//
// The measurements are from the two layouts the app actually has, because the answer has to come out
// opposite in them and the same function decides both. A 1512×900 laptop puts the pane beside the list
// and it must never move; a 390×844 phone stacks the panes and it must always move. The second was
// broken from the day the layout was written until somebody drove a phone.

import { describe, expect, it } from 'vitest';
import { offscreen, watched, watching, type Sample, type Watch } from './reveal';

describe('deciding whether the pane has answered where it is', () => {
  it('leaves a pane that sits beside the list alone', () => {
    // 1512×900: the pane starts under the masthead and runs to the bottom of the fold.
    expect(offscreen({ top: 152, bottom: 884 }, 900)).toBe(false);
  });

  it('scrolls to a pane that starts below the fold', () => {
    // 390×844, the defect exactly: tapping a warehouse row rendered its detail at y=896 and moved
    // nothing, so the only change on screen was a 2px accent on the row that was tapped.
    expect(offscreen({ top: 896, bottom: 1720 }, 844)).toBe(true);
  });

  it('scrolls to a pane showing only a sliver, which shows the reader nothing', () => {
    // 40px of a pane is its top border and the first few pixels of its heading. "Any of it is visible"
    // is the test that passes this and leaves the reader looking at the list.
    expect(offscreen({ top: 804, bottom: 1600 }, 844)).toBe(true);
  });

  it('leaves a pane the reader has already scrolled most of the way past', () => {
    // Scrolling up to change the selection and being thrown back down is worse than not moving: the
    // reader can see the pane, and what moved was the ground under them.
    expect(offscreen({ top: -600, bottom: 300 }, 844)).toBe(false);
  });

  it('scrolls to a pane whose last few pixels are all that is left above the fold', () => {
    expect(offscreen({ top: -780, bottom: 44 }, 844)).toBe(true);
  });

  // The threshold itself, pinned either side, because `scripts/check-reveal.mjs` asserts against a
  // copy of it. That script is `.mjs` run unbuilt and this is a module in the client bundle, so there
  // is no import that would hold them together; this is what does. Move `ENOUGH` and this fails,
  // which is the prompt to move the copy.
  it('draws the line at 120px, which is the number the browser check measures against', () => {
    expect(offscreen({ top: 724, bottom: 1600 }, 844)).toBe(false);
    expect(offscreen({ top: 725, bottom: 1600 }, 844)).toBe(true);
  });
});

describe('while the pane is being watched', () => {
  // The layout is still the browser check's — the responsive page settling and re-rendering underneath
  // cannot be produced here, and `npm run check:reveal` owns it at 390×844. What is here is the sequence
  // of decisions that layout produces, which is where both previous defects lived:
  // the effect deciding once and stopping, on a page that had not finished arriving.
  //
  // A pane 700px down a fold of 844 shows 144px and has answered; pushed to 780px it shows 64px and
  // has not. Those are the two positions the three failing routes moved between.
  const answered = { place: 700, offscreen: false };
  const below = { place: 780, offscreen: true };

  /** Runs a watch over samples 50ms apart, and reports what it did at each. */
  function over(samples: readonly (Omit<Sample, 'at' | 'taken'> & { readonly taken?: boolean })[]): {
    readonly scrolls: readonly number[];
    readonly stopped: number | null;
    readonly watch: Watch;
  } {
    let watch = watching(0);
    const scrolls: number[] = [];
    let stopped: number | null = null;

    samples.forEach((sample, index) => {
      const at = (index + 1) * 50;
      if (stopped != null) return;
      const step = watched(watch, { at, taken: false, ...sample });
      watch = step.watch;
      if (step.scroll) scrolls.push(at);
      if (step.stop) stopped = at;
    });

    return { scrolls, stopped, watch };
  }

  /** As many samples of one position as fill the milliseconds given. */
  const holding = (where: Omit<Sample, 'at' | 'taken'>, ms: number): Omit<Sample, 'at' | 'taken'>[] =>
    Array.from({ length: Math.round(ms / 50) }, () => where);

  it('waits for the pane to hold still before deciding anything', () => {
    // Five samples each somewhere new is a layout still settling, and a pane measured mid-shift is
    // measured where it will not be. The decision comes 150ms after the movement stops, at 450ms,
    // and not at any of the five.
    const moving = [720, 740, 760, 780, 800].map((place) => ({ place, offscreen: true }));
    const { scrolls } = over([...moving, ...holding(below, 300)]);

    expect(scrolls).toEqual([450]);
  });

  it('scrolls once the pane has held one position, and leaves an answered pane alone', () => {
    expect(over(holding(answered, 400)).scrolls).toEqual([]);
    expect(over(holding(below, 400)).scrolls).toEqual([200]);
  });

  it('re-decides when the layout moves the pane after the decision was taken', () => {
    // The defect exactly, at `/checks?pillar=cost-optimization`: the pane holds where it is showing
    // enough of itself, the decision is correctly not to scroll, and then the content underneath
    // arrives and pushes it below the fold. The old watcher had cleared its interval by then.
    const { scrolls } = over([...holding(answered, 500), ...holding(below, 500)]);

    expect(scrolls).toEqual([700]);
  });

  it('stops at the deadline rather than following a page that never settles', () => {
    const restless = Array.from({ length: 60 }, (_, index) => ({ place: 700 + index, offscreen: true }));
    const { scrolls, stopped } = over(restless);

    // Decided on wherever it had got to, which is the old behaviour and the right one: a page that
    // is still animating at a second and a half is not going to answer, and the reader is looking at
    // a list they did not ask for while it does not.
    expect(scrolls).toEqual([1_500]);
    expect(stopped).toBe(1_500);
  });

  it('does nothing at all once the reader has taken the scroll over', () => {
    // Their scroll wins outright. The pane is below the fold and stays there, because moving the
    // ground under somebody who is reading is the worse of the two.
    let watch = watching(0);
    const step = watched(watch, { at: 400, taken: true, ...below });

    expect(step).toEqual({ watch, scroll: false, stop: true });

    // And it is not re-armed by the pane moving afterwards.
    watch = step.watch;
    expect(watched(watch, { at: 450, taken: true, place: 900, offscreen: true }).scroll).toBe(false);
  });
});
