// When a pillar was measured, and by whom, shown wherever its score is.
//
// The whole point of a targeted rerun is that a result's pillars are of different ages. If the
// UI dates them all by the scan's own timestamp, then rerunning Security makes six week-old
// pillars appear to have been measured minutes ago — which would be a worse failure than not
// offering reruns, because it is invisible.
//
// So a carried-forward pillar states its own date and the run it came from, and a freshly
// measured one is left unlabelled. Labelling both would put a line of provenance on every
// pillar in the common case, and the reader would stop seeing it before the one that mattered.

import { History } from 'lucide-react';
import { Link } from 'react-router';
import type { Measurement, Scan } from '../api/types';

/** The measurement for one pillar, or undefined for a scan written before this existed. */
export function measurementOf(scan: Scan | undefined, pillarId: string): Measurement | undefined {
  return scan?.measurement.find((entry) => entry.pillarId === pillarId);
}

export function MeasuredWhen({ scan, pillarId }: { scan: Scan | undefined; pillarId: string }) {
  const measurement = measurementOf(scan, pillarId);
  if (measurement == null || !measurement.carriedForward) return null;

  return (
    <span className="wa-caption inline-flex items-center gap-1">
      <History aria-hidden className="h-3 w-3 shrink-0" />
      {/* The run it came from is named, so it is also reachable. A reader told their Security score
          is three weeks old wants to see that run — what it was asked to measure, what identity it
          ran as, and what changed — and the date was the only handle on it. */}
      Carried forward from{' '}
      <Link to={`/history/${measurement.scanId}`} className="hover:text-wa-text hover:underline">
        the scan of {when(measurement.measuredAt)}
      </Link>
    </span>
  );
}

/**
 * The same fact as a sentence, for a page that has no room for a badge.
 *
 * Returns undefined for a freshly measured pillar rather than "measured just now", so a caller
 * can omit the line entirely instead of printing a redundant one.
 */
export function measuredSentence(measurement: Measurement | undefined): string | undefined {
  if (measurement == null || !measurement.carriedForward) return undefined;
  return (
    `This pillar was not measured by the latest run. It was measured on ${when(measurement.measuredAt)} by ` +
    `${measurement.actor} and carried forward unchanged, so its evidence is as old as that run.`
  );
}

function when(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}
