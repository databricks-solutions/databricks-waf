// Bring the row a link asked for into view.
//
// Paging to the page that holds a row is most of the answer and not all of it. A ten-row list whose
// tenth row is the selected one puts that row at y=785 in an 800px viewport: the page is right, the
// highlight is right, and what the reader sees is nine rows they did not ask for and a sliver of the
// one they did. Measured at 1280×800, which is a real laptop rather than a contrived case; at
// 1440×900 the same row is visible, which is why it went unnoticed.
//
// `nearest` is what keeps this a correction rather than a scroll on every selection. A row already
// fully in view is left exactly where it is, so clicking rows never moves the page under the reader
// — and no separate "did they click it or arrive at it?" flag is needed to arrange that.

import { useEffect, useRef, useState } from 'react';

/** Honoured explicitly: scrollIntoView does not consult the preference itself. */
const gently = (): ScrollBehavior => (window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/**
 * Scrolls the element registered by the returned ref into view when `selected` changes.
 *
 * Keyed on the id rather than on the element, so it fires once per selection however many times the
 * list re-renders around it.
 *
 * @param selected The id of the row that should be visible, or null when nothing is named.
 * @returns A ref callback for the selected row's element.
 */
export function useRevealed(selected: string | null | undefined): (node: HTMLElement | null) => void {
  const node = useRef<HTMLElement | null>(null);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (selected == null || selected === '' || shown.current === selected) return;
    shown.current = selected;

    const element = node.current;
    if (element == null) return;

    element.scrollIntoView({ block: 'nearest', behavior: gently() });
  }, [selected]);

  return (element: HTMLElement | null) => {
    node.current = element;
  };
}

/**
 * The least of the pane worth having on screen before a scroll counts as unnecessary, in pixels.
 *
 * About a pane header and the first line under it. A pane whose top edge is the last 40px of the fold
 * is on screen by the arithmetic and shows the reader nothing, so the test cannot be "is any of it
 * visible" — that is the test that leaves the phone case broken.
 */
const ENOUGH = 120;

/**
 * Whether a pane at these bounds has answered the reader where it is, or has to be scrolled to.
 *
 * Separated from the hook for the same reason `fitted` is: this is the part that can be wrong while
 * everything still renders, and the two cases it has to get right in opposite directions cannot both
 * be produced in one browser — a two-column laptop must never scroll, and a stacked phone must always
 * scroll, and the second was broken for as long as it took to drive a phone.
 *
 * @param bounds The pane's viewport rectangle, as `getBoundingClientRect` gives it.
 * @param viewport The height of the fold.
 */
export function offscreen(bounds: { readonly top: number; readonly bottom: number }, viewport: number): boolean {
  const showing = Math.min(bounds.bottom, viewport) - Math.max(bounds.top, 0);
  return showing < ENOUGH;
}

/**
 * How long the pane's position has to hold before the decision is taken on it, in milliseconds.
 *
 * The decision has to be taken in a layout that will still be there afterwards. Fetched content and
 * responsive composition can change the height of everything above it, so a task measured before
 * that work settles has been measured in a layout that no longer exists. On
 * `/exceptions` at 390×844 the pane showed 134px when the effect ran, cleared the bar, and was at 102px
 * two frames later once the list rendered, with nothing left to run again and nothing the reader
 * could do about it: the row was already selected, so tapping it changed nothing.
 *
 * This was four animation frames, about 64ms, and four frames is not long enough on a cold arrival.
 * `/checks?pillar=cost-optimization` at 390×844 renders its pane from the static pillar list at 209ms,
 * where 147px of it showed and the bar was cleared, and the fetched content underneath pushed it to
 * 773 by 301ms — 71px, decided and done, canvas still at 0 of 840. A tap could not have hit that
 * because a tap happens on a page that has already loaded; only a deep link can.
 *
 * 150ms is `quiesce()`'s number in `scripts/browser.mjs`, measured against the same question on the
 * same pages: the disclosure openings that move at all settle at 10ms and 21ms, and two agreeing
 * samples 150ms apart clears the slowest of them by a factor of seven. The 92ms shift above is inside
 * that too.
 */
const HELD_FOR = 150;

/**
 * How long the pane is watched, in milliseconds. Not how long until the decision — see `watched`.
 *
 * A pane that never stops moving is a page with something animating in it, and waiting on that for
 * ever would leave the reader looking at a list they did not ask for. A second and a half is well past
 * anything measured here and short enough that an arrival still feels like an arrival.
 *
 * It is also, measured, past the last shift on the three routes that were failing: `/answers` moves at
 * 852ms, `/exceptions` at 850ms and `/checks` at 1300ms, on a cold load of an estate with an advisory
 * and three records in it. Those are the numbers in
 * [`72`](../../../../../docs/plan/72-reveal-decision-not-revisited.md), and they are why this row did
 * not need a longer deadline — every shift that broke the old hook was already inside this window,
 * which is what made "stop watching at the first hold" the thing to change rather than the constants.
 */
const DEADLINE = 1_500;

/**
 * How often the pane's position is read while waiting for it to hold, in milliseconds.
 *
 * A timer rather than `requestAnimationFrame`, which this used: rAF fires per frame, so measuring a
 * 150ms window through it means nine callbacks to answer a question that needs two. It also stops
 * entirely in a background tab, which would leave a reader returning to a page that had decided
 * nothing.
 */
const SAMPLE = 50;

/**
 * What the watcher knows between two samples of the pane.
 *
 * A separate value from the hook for the reason `offscreen` is: this is the part that can be wrong
 * while everything still renders. The two previous versions of this timing were both wrong in a
 * browser and invisible to a test, so what a test can hold now is the sequence of decisions rather
 * than the layout that produced them.
 */
export interface Watch {
  /** When the watch began, so it can end on time. */
  readonly startedAt: number;
  /** When the pane was last somewhere else. */
  readonly movedAt: number;
  /** Where the pane was, in the document. `NaN` before the first sample. */
  readonly place: number;
  /** Whether a decision has been taken about the pane where it is now. */
  readonly decided: boolean;
}

/** A watch that has seen nothing yet. */
export function watching(at: number): Watch {
  return { startedAt: at, movedAt: at, place: Number.NaN, decided: false };
}

/** One reading of the pane, in the terms the watcher decides on. */
export interface Sample {
  readonly at: number;
  /**
   * The pane's top edge in **document** coordinates, not the viewport's.
   *
   * The distinction is the whole of the reader-took-over problem. In viewport coordinates a layout
   * shift and a scroll move the pane identically, so a watcher that kept scrolling to it could not
   * tell the page settling from the reader leaving. In document coordinates only the layout moves it.
   */
  readonly place: number;
  /** Whether the pane at its current viewport position has answered the reader. */
  readonly offscreen: boolean;
  /** Whether the reader has taken the scroll over since the watch began — see `TOOK_OVER`. */
  readonly taken: boolean;
}

/** What to do about this sample, and what to remember for the next one. */
export interface Step {
  readonly watch: Watch;
  readonly scroll: boolean;
  readonly stop: boolean;
}

/**
 * Whether this sample of the pane calls for a scroll, and whether there is any point sampling again.
 *
 * **The decision is re-taken every time the pane moves, and the watch runs to `DEADLINE` rather than
 * to the first decision.** That is the defect this replaces. Deciding at the first hold and clearing
 * the interval was right about the layout it measured and wrong a second later:
 * `/checks?pillar=cost-optimization` held at 697px from 228ms, was correctly judged to be showing
 * 147px of itself, and was pushed to 773px at 1300ms by content that had not arrived — 71px showing,
 * decided and done. `HELD_FOR` answers "has the layout settled?" with "it has not moved for a while",
 * and a page waiting on a fetch has not moved for a while several times before it is finished.
 *
 * So `held` still governs *when* a decision may be taken — a pane measured mid-shift is measured in a
 * layout that will not be there — and it no longer governs when to stop looking.
 *
 * **A reader who scrolls ends it, with no scroll of ours.** Re-deciding means the hook can now move
 * the page a second time, a second later, which is the one way this could be worse than the defect.
 * Their scroll wins outright rather than being weighed: the alternative is guessing, and the pane
 * being off screen is a smaller problem than the ground moving under someone who is reading.
 */
export function watched(watch: Watch, sample: Sample): Step {
  if (sample.taken) return { watch, scroll: false, stop: true };

  const moved = sample.place !== watch.place;
  const seen: Watch = moved
    ? { ...watch, place: sample.place, movedAt: sample.at, decided: false }
    : watch;

  const over = sample.at - watch.startedAt >= DEADLINE;
  const held = sample.at - seen.movedAt >= HELD_FOR;

  // Still moving, and there is still time: nothing to decide on yet.
  if (seen.decided || !(held || over)) return { watch: seen, scroll: false, stop: over };

  return { watch: { ...seen, decided: true }, scroll: sample.offscreen, stop: over };
}

/**
 * The events that mean the reader is doing the scrolling now.
 *
 * Read as intent rather than as movement, because `window.scrollY` cannot tell the two apart: this
 * hook's own `scrollIntoView` moves it too, and under `smooth` it moves it for a few hundred
 * milliseconds afterwards. A watcher that stopped on `scrollY` changing would stop on its own scroll
 * every time — which is the old defect with an extra step.
 *
 * `keydown` is every key and not the scrolling ones, because a reader typing in a filter is as much
 * "somebody is using this page" as a reader pressing Page Down.
 */
const TOOK_OVER = ['wheel', 'touchstart', 'keydown'] as const;

/**
 * Scrolls the detail pane registered by the returned ref into view when the selection the reader
 * *asked for* changes, if the pane is not already showing enough of itself to have answered.
 *
 * This is the other half of a two-pane page and it went missing until a phone was driven. Selecting a
 * row does two things — it marks the row and it fills the pane beside it — and beside is only true
 * above 900px. Below that the panes stack, and on a 390×844 phone the warehouse list's own pane ended
 * at 896px: tapping a row set `aria-current`, rendered the whole detail, scrolled nothing, and left
 * the reader looking at an unchanged screen with a 2px accent on the row they tapped. The page had
 * answered them below the fold.
 *
 * **Pass the id from the URL, not the id of the row on screen.** They differ in the case that decides
 * whether this hook is an improvement or a regression: a list with nothing named in the query string
 * selects its own first row, so keying on the selection fires this on every arrival — and a phone
 * opening `/warehouses` was scrolled to the bottom of the page, one warehouse's detail filling the
 * screen and the list of warehouses gone off the top. That is a worse page than the one this set out
 * to fix. Keyed on what was asked for, an arrival with no selection scrolls nothing, a deep link to a
 * row scrolls to it, and a tap scrolls to what the tap opened.
 *
 * That the id comes from the URL is also why this hook needed the arrival of the pane to be a state
 * change and `useRevealed` above did not. `useRevealed` is keyed on the selected row, which does not
 * exist until the data does — so by the time its id changes, the row is in the DOM and the ref is set.
 * A URL id is there on the first render of a cold load, before there is a pane to scroll.
 *
 * Measuring what is on screen rather than asking a media query is deliberate, and is what keeps this
 * from being a second place that has to agree with the stylesheet about where the layout breaks. Two
 * columns means the pane is beside the list and always showing, so the measurement declines to move
 * anything without being told the width it is at.
 *
 * `start` rather than `nearest` because a pane taller than the fold is the common case, and `nearest`
 * on a tall element scrolls its *bottom* into view — the reader would be dropped at the last finding
 * with the heading somewhere above them.
 *
 * @param asked The id the query string names, or null where it names none. See above.
 */
export function useRevealedPane(asked: string | null | undefined): (node: HTMLElement | null) => void {
  const [node, setNode] = useState<HTMLElement | null>(null);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (asked == null || asked === '' || shown.current === asked) return;

    const element = node;
    if (element == null) return;

    // The deciding is in `watched`; this reads the pane and does as it says. Decided when the pane
    // has held one position for `HELD_FOR`, decided again wherever it moves to next, and left alone
    // for good once the reader scrolls.
    let watch = watching(Date.now());
    let taken = false;
    const tookOver = (): void => {
      taken = true;
    };
    for (const event of TOOK_OVER) window.addEventListener(event, tookOver, { passive: true });

    const pending = setInterval(() => {
      const box = element.getBoundingClientRect();
      const step = watched(watch, {
        at: Date.now(),
        place: box.top + window.scrollY,
        offscreen: offscreen(box, window.innerHeight),
        taken,
      });
      watch = step.watch;

      if (step.scroll) element.scrollIntoView({ block: 'start', behavior: gently() });

      if (step.stop) {
        clearInterval(pending);

        // Marked when the watch ends and not when it starts, and not at the first decision either.
        // Recorded up front it spent the one attempt on a run that could not take it: a deep link has
        // its id on the first render and its pane on a later one, so the first run found no element
        // and refused every run after it. `/findings?control=CO-03-01` at 390×844 left the pane 818px
        // down a fold of 844, showing the same 26px as a page that names no row at all. Recorded at
        // the first decision, an effect that re-ran mid-watch — a remount of the pane, say — would
        // bail on a selection whose layout had not finished moving, which is the same defect wearing
        // this row's clothes.
        shown.current = asked;
      }
    }, SAMPLE);

    return () => {
      clearInterval(pending);
      for (const event of TOOK_OVER) window.removeEventListener(event, tookOver);
    };
    // `node` as well as `asked`, which is the whole of the fix above: a ref set by a callback changes
    // nothing React can see, so the pane mounting has to be a state change or the effect never learns
    // it happened. `shown` is what keeps that from firing twice for one selection.
  }, [asked, node]);

  return setNode;
}
