// The audit events this app could not write down, and the button that says somebody has looked.
//
// A component rather than part of the page for the reason `HealthReadings` is: what is worth holding is
// what the list says and refuses to say, and asserting that through a page that fetches means testing a
// router and a socket to find out whether a sentence carries a word.
//
// What it refuses to say matters more than what it says. A lost event is not recoverable, and an
// acknowledgement is not a repair: it says that a person has looked, and the verification of the trail
// reads the same chain it did before. So the button is labelled for what it does, and the sentence above
// the list says what it does not do. A button called "Resolve" would be the one claim here that is false.
//
// Everybody who can open the app sees the list. The acknowledgement is an assessor's act and is refused
// for anybody else with the server's own sentence, which is shown as written because it names the group
// that may do it.

import { TriangleAlert } from 'lucide-react';
import { Link } from 'react-router';
import { Badge } from './ui/StatusBadge';
import { agoPhrase, gapOutcomePhrase } from '../pages/diagnostics-language';
import { momentOf, targetLabel } from '../pages/trail-language';
import type { Diagnostics } from '../api/types';

type AuditGaps = NonNullable<Diagnostics['auditGaps']>;

export interface AuditGapListProps {
  readonly gaps: AuditGaps;
  /** When the answer was given, which is what ages are measured against. */
  readonly at: string;
  /** Acknowledges one by id. Absent where nothing can send one, as on a read-only rendering. */
  readonly onAcknowledge?: (gapId: string) => void;
  /** The gap being acknowledged now, so only its own button reads as busy. */
  readonly acknowledging?: string | undefined;
  /** The server's sentence about the last acknowledgement that failed. */
  readonly error?: string | undefined;
}

export function AuditGapList({ gaps, at, onAcknowledge, acknowledging, error }: AuditGapListProps) {
  const now = new Date(at);

  // Said in place of the list, not beside it. An empty list from a read that failed would be the one
  // answer this record cannot give, and the page above already refuses to call the trail clean.
  if (gaps.unreadable != null) {
    return (
      <p className="wa-body-compact text-wa-warning" role="status">
        The list of lost audit events could not be read ({gaps.unreadable}), so this page cannot say whether the trail
        is missing any.
      </p>
    );
  }

  if (gaps.gaps.length === 0) return null;

  return (
    <div className="space-y-2" data-audit-gaps>
      <p className="wa-body-compact max-w-prose text-wa-text-secondary">
        Each of these is an action this app took that its audit trail has no record of. They are kept in the
        database, so every instance shows the same list and a restart does not clear it. Acknowledging one says that
        somebody has looked at it. It does not recover the event or change the trail, and it is recorded under your
        name. <Link className="text-wa-action hover:underline" to="/trail">Open the trail →</Link>
      </p>
      <ul className="wa-zebra">
        {gaps.gaps.map((gap) => (
          <li key={gap.id} className="space-y-1 px-3 py-2.5" data-gap={gap.id}>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="wa-body-compact font-medium text-wa-text">
                {gap.actor} — {gap.phrase}
              </span>
              <Badge tone="warning" Icon={TriangleAlert}>
                {gapOutcomePhrase(gap.outcome)}
              </Badge>
              <span className="wa-caption">
                {momentOf(gap.at)} ({agoPhrase(new Date(gap.at), now)})
              </span>
            </div>
            <p className="wa-caption">
              {gap.target != null ? `${targetLabel(gap.target.kind)} ${gap.target.id}. ` : ''}
              The trail refused it with {gap.cause}.
            </p>
            {onAcknowledge != null && (
              <button
                type="button"
                className="wa-button-secondary"
                disabled={acknowledging != null}
                onClick={() => {
                  onAcknowledge(gap.id);
                }}
              >
                {acknowledging === gap.id ? 'Acknowledging' : 'Acknowledge'}
              </button>
            )}
          </li>
        ))}
      </ul>
      {gaps.truncated && (
        <p className="wa-caption">
          This is the newest {String(gaps.gaps.length)}. Acknowledge some, and the next ones will be listed.
        </p>
      )}
      {error != null && (
        <p className="wa-body-compact text-wa-warning" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
