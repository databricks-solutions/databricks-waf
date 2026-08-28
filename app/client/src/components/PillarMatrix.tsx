// Seven pillars, one table.
//
// This replaces a grid of large score cards, and the reason is comparison. Seven cards give seven
// numbers equal visual weight in seven separate frames, so finding the pillar that needs attention
// means reading all of them and holding the results in your head. In a table the eye runs down one
// column: postures compare against each other, coverage bars compare against each other, and the
// row that stands out is found rather than deduced.
//
// It is also the only layout that can hold a pillar the build does not measure. A card for a pillar
// with no data is either a hole in the grid or a card reading 0.0, and both of those are lies.

import { Link } from 'react-router';
import { PillarIcon } from './shell/PillarIcon';
import { CONFIDENCE_LABEL } from './coverage';
import { scoreTone } from './verdict-language';
import { ScoreDisclaimerMark } from './ui/ScoreDisclaimer';
import { MiniBar } from './ui/Segments';
import type { Posture } from './coverage';
import type { PillarRow } from './pillar-rows';

export interface PillarMatrixProps {
  readonly rows: readonly PillarRow[];
  /** Drops the change and confidence columns, for a column narrower than the page. */
  readonly compact?: boolean;
}

export function PillarMatrix({ rows, compact = false }: PillarMatrixProps) {
  return (
    <table className="wa-table">
      <caption className="sr-only">
        Every pillar in the framework with its posture, how much of it was assessed, unmet requirements by severity, and
        the confidence that follows from its coverage.
      </caption>
      <thead>
        <tr>
          <th scope="col">Pillar</th>
          <th scope="col" className="text-right">
            {/* The qualifier belongs in the column header rather than in a footnote: this is the
                column that gets screenshotted, and "rated by whom?" is the first fair question. */}
            <span className="flex flex-col items-end">
              Posture
              <ScoreDisclaimerMark />
            </span>
          </th>
          <th scope="col">Assessed</th>
          <th scope="col">Unmet</th>
          {!compact && <th scope="col">Confidence</th>}
          {!compact && (
            <th scope="col" className="text-right">
              Change
            </th>
          )}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.pillarId}>
            <td data-label="Pillar">
              <span className="flex items-center gap-2">
                <PillarIcon pillarId={row.pillarId} className="h-4 w-4 shrink-0 text-wa-text-muted" />
                {/* The row's one link. Its ::after covers the row, so the whole row is clickable
                    while there is still exactly one thing to tab to and one name to announce. */}
                {/* Truncated rather than wrapped. "Security, compliance, and privacy" wrapping to a
                    second line makes one row of a comparison table taller than the others, and the
                    eye reads the taller row as the more important one. */}
                <Link to={row.to} className="wa-row-link min-w-0 truncate font-medium text-wa-text" title={row.title}>
                  {row.title}
                </Link>
              </span>
            </td>

            <td data-label="Posture" className="text-right">
              <PostureCell posture={row.posture} />
            </td>

            <td data-label="Assessed">
              <span className="flex flex-col gap-1">
                <span className="wa-numeric wa-body-compact text-wa-text">
                  {row.coverage.assessed} / {row.coverage.applicable}
                  <span className="wa-caption"> ({Math.round(row.coverage.percent)}%)</span>
                </span>
                <MiniBar
                  percent={row.coverage.percent}
                  // Coverage is not posture. Thin coverage warns about the reading above it; it is
                  // never good news, so it never borrows the success colour.
                  tone={row.coverage.percent < 30 ? 'warning' : 'success'}
                  label={`${row.title}: ${String(Math.round(row.coverage.percent))}% of applicable requirements assessed`}
                />
                {/* A line rather than a column of its own. The table already carries six, and this
                    fact belongs to the coverage number it qualifies: a pillar reading 15/16 assessed
                    where 12 of those were answered by somebody is not the same pillar as one that
                    measured all fifteen, and the two must not present identically. */}
                {row.coverage.attested > 0 && (
                  <span className="wa-caption">{row.coverage.attested} answered by a person</span>
                )}
                {row.coverage.adminCollected > 0 && (
                  <span className="wa-caption">{row.coverage.adminCollected} imported by an administrator</span>
                )}
              </span>
            </td>

            <td data-label="Unmet">
              <UnmetCell unmet={row.unmet} assessed={row.assessed} pillarId={row.pillarId} />
            </td>

            {!compact && (
              <td data-label="Confidence">
                <span className="wa-body-compact text-wa-text-secondary">{CONFIDENCE_LABEL[row.confidence]}</span>
              </td>
            )}

            {!compact && (
              <td data-label="Change" className="wa-numeric text-right">
                <span className="wa-body-compact text-wa-text-secondary">
                  {row.delta == null
                    ? '—'
                    : Math.abs(row.delta) < 0.05
                      ? 'unchanged'
                      : `${row.delta > 0 ? '+' : ''}${row.delta.toFixed(1)}`}
                </span>
              </td>
            )}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The number, or the reason there isn't one.
 *
 * `Insufficient evidence` is the whole point of this cell. Reliability scores 0.0 from one
 * requirement of sixteen, and a column of numbers containing a 0.0 says the estate failed a pillar
 * nobody assessed — the worst misreading this app can produce.
 */
function PostureCell({ posture }: { posture: Posture }) {
  // Both phrases hold their line. Wrapped, "Insufficient / evidence" reads as two facts and takes
  // the row's height with it, in the column whose whole job is to be scanned downward.
  if (posture.kind === 'unassessed') {
    return <span className="wa-caption whitespace-nowrap">Not assessed</span>;
  }
  if (posture.kind === 'insufficient') {
    return <span className="wa-caption whitespace-nowrap">Insufficient evidence</span>;
  }
  if (posture.kind === 'directional') {
    return (
      <span className="flex flex-col items-end">
        {/* Muted rather than banded: a directional number that arrives in danger red is read as a
            verdict, which is precisely what it is not. */}
        <span className="wa-numeric font-semibold text-wa-text-secondary">{posture.score.toFixed(1)}</span>
        <span className="wa-caption">
          {posture.range == null
            ? 'directional'
            : `could be ${posture.range.low.toFixed(0)}–${posture.range.high.toFixed(0)}`}
        </span>
      </span>
    );
  }
  return <span className={`wa-numeric font-semibold ${scoreTone(posture.score)}`}>{posture.score.toFixed(1)}</span>;
}

const SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;

/** Critical and high spend colour, because they are the two that change what somebody does today. */
const SEVERITY_TONE: Readonly<Record<(typeof SEVERITIES)[number], string>> = {
  critical: 'font-medium text-wa-danger',
  high: 'font-medium text-wa-warning',
  medium: '',
  low: '',
};

/**
 * Unmet by severity, as words, each one a link to the requirements it counted.
 *
 * "3 critical" that cannot be followed is the reader being told a number and then asked to
 * reconstruct which three requirements produced it — from a findings page of 148 rows, by filtering
 * to this pillar and that severity by hand. The row's own link goes to the pillar, which is a
 * different and coarser answer, so these are inset above it rather than left to it.
 */
function UnmetCell({ unmet, assessed, pillarId }: { unmet: PillarRow['unmet']; assessed: boolean; pillarId: string }) {
  const total = unmet.critical + unmet.high + unmet.medium + unmet.low;
  if (!assessed) return <span className="wa-caption">—</span>;
  if (total === 0) return <span className="wa-caption">None found</span>;

  return (
    <span className="wa-body-compact flex flex-wrap items-baseline gap-x-2 text-wa-text-secondary">
      {SEVERITIES.filter((severity) => unmet[severity] > 0).map((severity) => (
        <Link
          key={severity}
          to={`/findings?pillar=${pillarId}&severity=${severity}&outcome=unmet`}
          className={`wa-row-inset wa-aside-link wa-numeric hover:underline ${SEVERITY_TONE[severity]}`}
        >
          {unmet[severity]} {severity}
        </Link>
      ))}
    </span>
  );
}
