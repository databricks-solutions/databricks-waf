// Proportional bars, drawn by hand.
//
// This file used to hold a donut, a sparkline and this. Both of the others are gone: the donut asked
// the reader to compare arc lengths across a hole to learn something a stacked bar says better in a
// tenth of the space, and the sparklines were drawing one or two comparable points per pillar, which
// produced flat lines that read as stability and meant nothing of the kind. Coverage segments replaced
// the first and a sentence replaced the second. What remains is the one shape that earns its pixels.
//
// Still no chart library. Every package that could draw this brings a renderer, an animation layer, a
// tooltip system and a palette of its own — hundreds of kilobytes, a licence to clear for a
// Marketplace listing, and colours that will not follow the theme tokens without a fight.

import type { ReactNode } from 'react';
import { Link } from 'react-router';

/**
 * The tones a chart may use, named rather than passed as classes.
 *
 * Every class name below is written out in full because Tailwind builds its stylesheet by reading the
 * source for literal class names. A tone assembled at runtime — `'bg-' + colour` — is invisible to
 * that scan, so the utility is never generated and the bar renders with no colour at all. It is a bug
 * that appears only in a production build, which is the worst kind to introduce to save three lines.
 */
export type ChartTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const BACKGROUND: Readonly<Record<ChartTone, string>> = {
  success: 'bg-wa-success',
  warning: 'bg-wa-warning',
  danger: 'bg-wa-danger',
  info: 'bg-wa-action',
  neutral: 'bg-wa-text-muted',
};

export interface Bar {
  readonly label: string;
  readonly value: number;
  readonly tone: ChartTone;
  readonly hint?: string;
}

/**
 * Proportional bars with their numbers, scaled to the largest rather than to a total.
 *
 * Scaled to the largest because these are counts of unlike things — four severities, six categories —
 * and a bar that fills 3% of its track tells the reader nothing except that the chart has a big
 * number somewhere else in it.
 *
 * `hrefFor` makes each bar a link to the rows it counted. Optional because two of the three callers
 * chart something that has no list behind it, but where there is one the bar should be the way in:
 * "2 high" is a promise that two named requirements exist, and a reader who cannot follow it has to
 * go to the findings page and rebuild the filter that produced the number.
 */
export function BarList({
  bars,
  empty,
  hrefFor,
}: {
  readonly bars: readonly Bar[];
  readonly empty?: ReactNode;
  readonly hrefFor?: (bar: Bar) => string;
}) {
  const peak = Math.max(...bars.map((bar) => bar.value), 0);
  if (peak === 0) return <>{empty}</>;

  return (
    <ul className="space-y-2">
      {bars.map((bar) => {
        const to = hrefFor?.(bar);

        return (
          <li
            key={bar.label}
            className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 ${
              to != null ? 'wa-row px-0 py-0.5' : ''
            }`}
          >
            {to != null ? (
              <Link to={to} className="wa-row-link wa-body-compact min-w-0 truncate text-wa-text-secondary">
                {bar.label}
              </Link>
            ) : (
              <span className="wa-body-compact min-w-0 truncate text-wa-text-secondary">{bar.label}</span>
            )}
            <span className="wa-numeric wa-body-compact text-right text-wa-text">{bar.value.toLocaleString()}</span>
            <div className="col-span-2 h-1.5 w-full overflow-hidden rounded-full bg-wa-surface-strong">
              <div
                className={`h-full ${BACKGROUND[bar.tone]}`}
                style={{ width: `${String((bar.value / peak) * 100)}%` }}
              />
            </div>
            {bar.hint != null && <span className="wa-caption col-span-2">{bar.hint}</span>}
          </li>
        );
      })}
    </ul>
  );
}
