// The whole framework as one bar, in the proportions it actually has.
//
// This replaces a donut, and the reason is not fashion. A donut of six outcomes asks the reader to
// compare arc lengths across a hole, which nobody does accurately, and it spends the most visually
// prominent element on the page saying something a single line can say better. A stacked bar reads
// left to right in the order the outcomes matter, keeps the unmeasured span physically adjacent to
// the measured one so the ratio is unmissable, and costs 8px of height.
//
// The unmeasured span is hatched rather than tinted. It is not a weaker kind of result — it is the
// part nobody looked at, and a flat grey block reads as a category of finding.

import type { ReactNode } from 'react';
import { Link } from 'react-router';

export type SegmentTone = 'success' | 'warning' | 'danger' | 'unknown' | 'excluded';

const FILL: Readonly<Record<SegmentTone, string>> = {
  success: 'bg-wa-success',
  warning: 'bg-wa-warning',
  danger: 'bg-wa-danger',
  // Hatched via a named class, because the hatch encodes "not looked at" and its colour belongs
  // in the theme rather than in this component.
  unknown: 'wa-segment-unknown',
  excluded: 'bg-wa-text-placeholder',
};

export interface Segment {
  readonly label: string;
  readonly value: number;
  readonly tone: SegmentTone;
  /**
   * Where the requirements this segment counted can be read, when they can be.
   *
   * Optional because two of the five segments on some surfaces count something the findings page has
   * no filter for. Where it is set the legend entry becomes a link, which is the difference between
   * "Unanswered 112" as a fact and as a way in — and 112 is the largest number on most estates'
   * summary, so it is the one a reader most wants to open.
   */
  readonly to?: string;
}

export interface SegmentsProps {
  readonly segments: readonly Segment[];
  /** The denominator. Passed rather than summed so a caller cannot silently drop a category. */
  readonly total: number;
  /** What the bar is of, for the text alternative: "the 148 requirements in the framework". */
  readonly of: string;
}

export function Segments({ segments, total, of }: SegmentsProps) {
  const present = segments.filter((segment) => segment.value > 0);
  const share = (value: number) => (total === 0 ? 0 : (value / total) * 100);

  return (
    <div
      className="wa-segment-track"
      // One label rather than a labelled child per span: a screen reader reading six adjacent
      // unlabelled divs announces nothing, and six labelled ones announce six times.
      role="img"
      aria-label={`Of ${of}: ${present.map((segment) => `${segment.value} ${segment.label.toLowerCase()}`).join(', ')}.`}
    >
      {present.map((segment) => (
        <span
          key={segment.label}
          className={FILL[segment.tone]}
          style={{ width: `${String(share(segment.value))}%` }}
          title={`${segment.label}: ${segment.value.toLocaleString()}`}
        />
      ))}
    </div>
  );
}

/**
 * The bar's key, as counts.
 *
 * Not optional. The bar carries proportion and the legend carries the numbers and the words, and
 * the design system's rule — and the accessibility floor — is that colour is never the only
 * channel a status arrives on.
 */
export function SegmentLegend({ segments, total }: { segments: readonly Segment[]; total: number }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1">
      {segments
        .filter((segment) => segment.value > 0)
        .map((segment) => {
          const share =
            total > 0
              ? `${String(Math.round((segment.value / total) * 100))}% of ${total.toLocaleString()}`
              : undefined;

          /*
           * The swatch, the word and the count are one link where the segment has somewhere to go.
           * Wrapping all three rather than the number alone, because a 2-digit numeral is a 16px
           * target and the word beside it is the part a reader reads.
           *
           * 24px tall, which is the target floor rather than a spacing choice. The entries are 18px
           * of text and the legend wraps, so on the pillar with five outcomes "Not applicable" sat
           * 22px under "Unanswered" — measured — and two targets 22px apart are 2.5.8's failure
           * whichever way the gap is closed. Closing it with the row gap would put the pitch at
           * exactly the 24px the criterion asks for, passing on a boundary a half-pixel of rounding
           * could cross; making the target itself 24px passes on its own size. The height is on both
           * branches, because a linked entry that is taller than an unlinked one beside it turns the
           * legend into two rows of text at different heights.
           */
          const body = (
            <>
              <span aria-hidden className={`h-2 w-2 shrink-0 rounded-xs ${FILL[segment.tone]}`} />
              <dt className="wa-body-compact text-wa-text-secondary">{segment.label}</dt>
              {/* Count only. The percentage was carried three times over — in the bar's own widths, in
                  the count against a stated denominator, and here — and the third copy was what wrapped
                  the legend onto a second line at 1280. */}
              <dd className="wa-body-compact wa-numeric font-medium text-wa-text">{segment.value.toLocaleString()}</dd>
            </>
          );

          return segment.to != null ? (
            <Link
              key={segment.label}
              to={segment.to}
              className="flex min-h-6 items-center gap-1.5 rounded-xs hover:underline"
              {...(share != null ? { title: share } : {})}
            >
              {body}
            </Link>
          ) : (
            <div key={segment.label} className="flex min-h-6 items-center gap-1.5" {...(share != null ? { title: share } : {})}>
              {body}
            </div>
          );
        })}
    </dl>
  );
}

/** A thin bar for a table cell: proportion only, with the numbers in the cell beside it. */
export function MiniBar({ percent, tone, label }: { percent: number; tone: SegmentTone; label: string }) {
  return (
    <span className="wa-minibar" role="img" aria-label={label}>
      <span className={FILL[tone]} style={{ width: `${String(Math.max(0, Math.min(100, percent)))}%` }} />
    </span>
  );
}

/** A labelled figure: the number, then what it counts. Used across the summary surfaces. */
export function Figure({ label, children, tone }: { label: string; children: ReactNode; tone?: 'lead' | 'normal' }) {
  return (
    <div className="min-w-0">
      <p className={`wa-numeric ${tone === 'lead' ? 'text-2xl' : 'text-lg'} leading-none font-semibold text-wa-text`}>
        {children}
      </p>
      <p className="wa-caption mt-0.5">{label}</p>
    </div>
  );
}
