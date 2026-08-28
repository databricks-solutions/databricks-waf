// Which runs may be drawn together.
//
// ADR 0072 owns the rule: every measured point stays in the series. The server's `comparable`
// decides whether it is an ordinary point, a permitted point carrying a caveat, or a refused point
// carrying the exact reason. Refused points break the line instead of disappearing, because a line
// that silently jumps across a change of scope or denominator is a claim of continuity the app did
// not establish.
//
// The rule is imported rather than restated. The narrower one this replaced compared two fields of
// the stamp and dropped what did not match, which claimed a trend straight across the methodology
// change ADR 0043 refuses — the same defect, in the same shape, that `occurrence.ts` records
// resisting on the server.

import { comparable, stampEnough, type Comparability } from '../../../shared/api/comparability';
import type { ScanStamp, ScanSummary } from '../api/types';

/**
 * What is known about drawing a point beside the run in hand.
 *
 * `read` is apart from the verdict for the reason `occurrence.ts` keeps `readable` apart from `ok`: a
 * run this build could not read is one it cannot speak for, and a run it read and found incomparable
 * is one it can say asked a different question. Collapsing them would report a damaged record, or one
 * older than the stamp, as a refusal — a verdict about a comparison that was never attempted.
 */
export type PointBasis =
  | { readonly read: true; readonly verdict: Comparability }
  | { readonly read: false; readonly why: string };

export interface SeriesPoint {
  readonly value: number;
  readonly basis: PointBasis;
}

export interface Series {
  /** Every measured run, oldest to newest, including the points that carry no comparison. */
  readonly points: readonly SeriesPoint[];
  /** Values whose comparison was permitted, kept for compact textual summaries and deltas. */
  readonly values: readonly number[];
  /** Change from the first permitted point to the last, when there are two to compare. */
  readonly delta?: number;
}

/** Whether a point's comparison was attempted and permitted, which is what may be drawn on the line. */
export function drawable(point: SeriesPoint): boolean {
  return point.basis.read && point.basis.verdict.ok;
}

const UNRECORDED_STAMP =
  'This run does not record the full basis a comparison reads, so whether it belongs on this trend was never established.';

/**
 * A pillar's own trend, over the runs that measured it.
 *
 * A run that carried the pillar forward is still excluded: its number is the previous run's number,
 * and repeating it would present an unobserved pillar as a fresh stable result. A run that measured
 * the pillar but cannot be compared is retained with its reason.
 */
export function pillarSeries(history: readonly ScanSummary[], pillarId: string, stamp: ScanStamp): Series {
  const measured = history.filter((run) => run.freshPillars.includes(pillarId) && run.pillarScores[pillarId] != null);
  // The basis of the run in hand, checked once. A truncated stamp here is every comparison unreadable
  // rather than one, since there is nothing to compare the history against.
  const against = stampEnough(stamp) ? stamp : undefined;
  const newestFirst = measured.map((run): SeriesPoint => {
    const value = run.pillarScores[pillarId] ?? 0;
    if (against == null || !stampEnough(run.stamp)) return { value, basis: { read: false, why: UNRECORDED_STAMP } };
    return { value, basis: { read: true, verdict: comparable(against, run.stamp) } };
  });

  return build([...newestFirst].reverse());
}

function build(points: readonly SeriesPoint[]): Series {
  const values = points.filter(drawable).map((point) => point.value);
  const first = values[0];
  const last = values.at(-1);

  return {
    points,
    values,
    ...(values.length >= 2 && first != null && last != null ? { delta: last - first } : {}),
  };
}
