// What moved since the last run, in words.
//
// This replaces a sparkline on every pillar card. Those lines were drawing one or two points from a
// history where most runs are not comparable with each other, which produced flat 24px boxes that
// looked like stability and were nothing of the kind. A sentence can say "no posture change, because
// no new evidence was collected"; a flat line cannot, and the reader will read the wrong meaning
// into it every time.
//
// The sentences themselves live in change-language.ts, so what the page claims about a customer's
// platform can be tested without rendering one.

import { Link } from 'react-router';
import { useResultChanges } from '../api/hooks';
import { Surface } from './system';
import { summariseChanges } from './change-language';
import type { Scan, ScanSummary } from '../api/types';

export interface ChangeSummaryProps {
  readonly scan: Scan;
  readonly resultId: string;
  readonly history: readonly ScanSummary[];
  /** False where a tab outside the plane already carries the name. */
  readonly titled?: boolean;
}

export function ChangeSummary({ scan, resultId, history, titled = true }: ChangeSummaryProps) {
  const changes = useResultChanges(resultId);
  const previous = history.find((run) => run.id !== scan.id);
  const lines = summariseChanges(scan, changes.data, previous);

  return (
    <Surface
      tone="raised"
      title={titled ? 'Since the last run' : undefined}
      label="What changed since the last run"
      action={
          <Link to={`/history/${scan.id}`} className="wa-caption wa-aside-link hover:underline">
            Run record →
          </Link>
      }
    >

      <div className="space-y-1.5">
        {changes.loading ? (
          <p className="wa-body-compact text-wa-text-secondary">Comparing with the previous run.</p>
        ) : (
          lines.map((line) => (
            <p key={line} className="wa-body-compact text-wa-text-secondary">
              {line}
            </p>
          ))
        )}
      </div>

      {/* The last four runs, as dates. A history table's worth of columns is not needed here — the
          question this answers is only "how recently, and how often". */}
      {history.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-wa-divider pt-3">
          <span className="wa-label">Recent runs</span>
          {history.slice(0, 4).map((run) => (
            <Link
              key={run.id}
              to={`/history/${run.id}`}
              className="wa-caption wa-numeric wa-aside-link hover:underline"
            >
              {new Date(run.finishedAt).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                hour: 'numeric',
                minute: '2-digit',
              })}
            </Link>
          ))}
        </div>
      )}
    </Surface>
  );
}
