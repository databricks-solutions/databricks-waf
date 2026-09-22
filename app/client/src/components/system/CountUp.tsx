// A number that counts up to its value on mount.
//
// The one flourish this design allows on a metric, because a score settling into place reads as the
// tool arriving at an answer rather than asserting one. It is decorative, so it earns its keep only
// where a reader meets it rarely — a page's headline figure, not a cell repeated down a table.
//
// The value shown is state, but the destination is always in the markup as data-countup-value, so a
// reader of the DOM (and a test) can read the final number without waiting for the count. Under
// prefers-reduced-motion the number is its final value from the first render, with no frame ever
// scheduled — decided synchronously so a server render shows the answer too.

import { useEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { duration, usePrefersReducedMotion } from './motion';

export interface CountUpProps {
  /** The value to settle on. */
  readonly value: number;
  /** The value to count from. Defaults to 0. */
  readonly from?: number;
  /** How long the count takes, in milliseconds. Defaults to the slow motion token. */
  readonly durationMs?: number;
  /** Decimal places to render. Ignored when `format` is given. Defaults to 0. */
  readonly decimals?: number;
  /** Formats the current (possibly mid-count) number for display. */
  readonly format?: (value: number) => string;
  readonly className?: string;
}

export function CountUp({ value, from = 0, durationMs, decimals = 0, format, className }: CountUpProps) {
  const reduced = usePrefersReducedMotion();
  const [display, setDisplay] = useState<number>(from);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    // No synchronous setState here: under reduced motion the final value is chosen at render below,
    // so this effect only ever schedules the count when motion is allowed.
    if (reduced) return;

    const total = durationMs ?? duration.slow;
    const startValue = from;
    const startedAt = performance.now();

    const tick = (now: number): void => {
      const progress = total <= 0 ? 1 : Math.min(1, (now - startedAt) / total);
      // Ease-out cubic: quick to move, gentle to land, matching easing.out.
      const eased = 1 - Math.pow(1 - progress, 3);
      setDisplay(startValue + (value - startValue) * eased);
      if (progress < 1) frame.current = requestAnimationFrame(tick);
    };

    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
    };
  }, [reduced, value, from, durationMs]);

  // Under reduced motion the value is its destination from the first render; otherwise it is whatever
  // the count has reached. Either way the destination rides along in data-countup-value and the label.
  const shown = reduced ? value : display;
  const render = (input: number): string => (format != null ? format(input) : input.toFixed(decimals));

  return (
    <span className={clsx('wa-numeric', className)} data-countup-value={value} aria-label={render(value)}>
      {render(shown)}
    </span>
  );
}
