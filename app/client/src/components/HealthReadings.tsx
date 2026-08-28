// The four dependency readings, as a list.
//
// A component rather than part of the page for the reason the other panels here are: the ordering and
// the two-channel standing are the parts worth asserting on, and asserting on them through a page that
// fetches means testing a router and a socket to find out whether a badge carries a word.
//
// The prose is the server's — a reading's detail and its action are about the app's own internals and
// belong beside the code that knows them. What is decided here is the order, the shape beside the
// word, and the fact that an observed reading shows its age.

import { useMemo } from 'react';
import { Link } from 'react-router';
import { Badge } from './ui/StatusBadge';
import {
  DEPENDENCY_LABEL,
  DEPENDENCY_PURPOSE,
  provenancePhrase,
  STANDING_LABEL,
  standingPresentation,
} from '../pages/diagnostics-language';
import type { HealthReading } from '../api/types';

/**
 * Faults first, then the rest in the order a repair would be attempted.
 *
 * The database before the warehouse, which is the reverse of the order the server builds them in and
 * deliberate: a silent database is what makes the trail degrade, so a reader working down the list
 * meets the cause before the consequence.
 */
const REPAIR_ORDER: readonly HealthReading['dependency'][] = ['database', 'audit-log', 'warehouse', 'identity'];

/** Silent, degraded, unbound, unknown, answering. The order somebody triaging would pick them up in. */
function severityOf(reading: HealthReading): number {
  if (reading.standing === 'silent') return 0;
  if (reading.standing === 'degraded') return 1;
  if (reading.standing === 'unbound') return 2;
  if (reading.standing === 'unknown') return 3;
  return 4;
}

export interface HealthReadingsProps {
  readonly readings: readonly HealthReading[];
  /**
   * When the answer was given, which is what ages are measured against.
   *
   * Not `Date.now()`: a page left open would slowly turn "just now" into a lie about a reading it
   * never retook.
   */
  readonly at: string;
}

export function HealthReadings({ readings, at }: HealthReadingsProps) {
  const ordered = useMemo(
    () =>
      [...readings].sort(
        (a, b) =>
          severityOf(a) - severityOf(b) || REPAIR_ORDER.indexOf(a.dependency) - REPAIR_ORDER.indexOf(b.dependency)
      ),
    [readings]
  );
  const now = useMemo(() => new Date(at), [at]);

  return (
    <ul className="wa-zebra">
      {ordered.map((reading) => (
        <ReadingRow key={reading.dependency} reading={reading} now={now} />
      ))}
    </ul>
  );
}

/**
 * One dependency.
 *
 * Not a `Row`: nothing here is selectable, and each reading is three lines of prose rather than a
 * record in a comparable list. The zebra and the dividers still come from the list, so four readings
 * read as one surface rather than four cards.
 */
function ReadingRow({ reading, now }: { reading: HealthReading; now: Date }) {
  const { tone, Icon } = standingPresentation(reading.standing);

  return (
    <li className="space-y-1.5 px-3 py-2.5" data-dependency={reading.dependency}>
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="wa-body-compact font-medium text-wa-text">{DEPENDENCY_LABEL[reading.dependency]}</span>
        <Badge tone={tone} Icon={Icon}>
          {STANDING_LABEL[reading.standing]}
        </Badge>
        <span className="wa-caption">{provenancePhrase(reading, now)}</span>
      </div>
      <p className="wa-caption">{DEPENDENCY_PURPOSE[reading.dependency]}.</p>
      <p className="wa-body-compact max-w-prose text-wa-text-secondary">{reading.detail}</p>
      {/* Marked as an instruction rather than run together with the detail, because one is a diagnosis
          and the other is a next step, and an operator scanning for the second should not have to read
          the first to find it. */}
      {reading.action != null && (
        <div className="flex flex-wrap items-start justify-between gap-2">
          <p className="wa-body-compact max-w-prose text-wa-text">
            <span className="font-medium">What to do: </span>
            {reading.action}
          </p>
          {reading.dependency === 'warehouse' && (
            <Link className="wa-button-secondary shrink-0" to="/checks">
              Open Checks
            </Link>
          )}
        </div>
      )}
    </li>
  );
}
