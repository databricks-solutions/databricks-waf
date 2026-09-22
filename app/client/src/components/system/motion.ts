// The shared motion language: a few duration and easing tokens, and one hook that reads the
// reader's reduced-motion preference.
//
// Quiet and purposeful. This is a productivity tool, so the school is Emil Kowalski's restraint —
// short durations, a real easing curve rather than a bare `ease`, and no motion at all where a
// reader would trigger it dozens of times a session. The values here are mirrored as CSS custom
// properties in wa-theme.css (--wa-duration-*, --wa-ease-*, --wa-reveal-rise) so CSS-driven and
// JS-driven motion stay in step, and wa-tailwind.css carries a global prefers-reduced-motion rule
// that neutralises every animation and transition. Components that animate in JS still gate on
// usePrefersReducedMotion so they emit the final state with no animation attributes at all, rather
// than relying on that rule to switch a running animation off.

import { useEffect, useState } from 'react';

/**
 * Durations, in milliseconds.
 *
 * `fast` is the app's established 140ms control transition — hover, press, focus. `base` is for a
 * small state change; `slow` is for a page or section arriving. Nothing here reaches the half-second
 * that starts to feel like a show rather than a response.
 */
export const duration = {
  fast: 140,
  base: 200,
  slow: 320,
} as const;

/**
 * Easing curves, as CSS timing-function strings.
 *
 * `out` is the arriving curve — fast in, gentle settle — and is what reveals and enters use. `in` is
 * its opposite for the rare exit. `standard` is for something changing while it stays on screen.
 */
export const easing = {
  standard: 'cubic-bezier(0.2, 0, 0, 1)',
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  in: 'cubic-bezier(0.4, 0, 1, 1)',
} as const;

/** How far a reveal rises as it fades in, in pixels. Mirrors --wa-reveal-rise. */
export const REVEAL_RISE_PX = 8;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Whether the reader has asked their system for reduced motion, read once and synchronously.
 *
 * Safe off a browser: with no `window`, no `matchMedia`, or a `matchMedia` that throws, it answers
 * false — motion on — which is the right default for a page that has not been told otherwise. It is
 * read from a useState initializer below so a component's first render already knows the answer,
 * which matters because that first render is the only one a server render (and the test suite, which
 * renders to static markup) ever produces.
 */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches;
  } catch {
    return false;
  }
}

/**
 * Tracks the reduced-motion preference, settling it on the first render and keeping it in step if the
 * reader changes it while the page is open.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(prefersReducedMotion);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(REDUCED_MOTION_QUERY);
    const sync = (): void => setReduced(query.matches);
    sync();
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  return reduced;
}
