// Nothing to show, and which kind of nothing it is.
//
// "No data" is the failure this component exists to prevent. It collapses six situations that
// call for six different actions into one sentence that calls for none: an estate with no
// failures reads the same as a collector that crashed, and the reader cannot tell whether they
// are finished or blocked.
//
// So the reason is a required argument, not an optional message. Every caller has to decide
// which of the six it is, and each carries its own next action.

import {
  CheckCircle2,
  CircleSlash,
  FilterX,
  Lock,
  PauseCircle,
  PlayCircle,
  ServerCrash,
  SearchX,
  type LucideIcon,
} from 'lucide-react';
import type { ReactNode } from 'react';

export type EmptyReason =
  /**
   * Nothing has been asked yet. Neutral, and the one reason that is about the reader's next
   * action rather than the estate's condition — which is why it is not folded into
   * nothing-to-report, where it would read as a clean bill of health nobody has earned.
   */
  | 'not-yet-collected'
  /** Positive. The scan ran and this set is genuinely empty. */
  | 'nothing-to-report'
  /** A problem. The scan ran and produced no evidence for this question. */
  | 'no-evidence'
  /** The user's filters excluded everything. Their state, not the estate's. */
  | 'filtered-out'
  /** A collector failed. The estate is unknown here, not clean. */
  | 'collector-failed'
  /** The identity running the scan could not read the source. */
  | 'permission-required'
  /** Excluded by design, with a stated reason. */
  | 'not-applicable'
  /**
   * Empty because a person decided it should be, not because the estate is clean.
   *
   * Distinct from nothing-to-report, and the distinction is the reason this reason exists: a green
   * tick over "everything unmet has been accepted" would be the app congratulating a reader on
   * their colleague's paperwork. Neutral, because a parked failure is neither done nor outstanding.
   */
  | 'held-by-decision';

interface Presentation {
  readonly Icon: LucideIcon;
  readonly tone: 'positive' | 'problem' | 'neutral';
  readonly heading: string;
}

const PRESENTATION: Readonly<Record<EmptyReason, Presentation>> = {
  'not-yet-collected': { Icon: PlayCircle, tone: 'neutral', heading: 'Nothing collected yet' },
  'nothing-to-report': { Icon: CheckCircle2, tone: 'positive', heading: 'Nothing to report' },
  'no-evidence': { Icon: SearchX, tone: 'problem', heading: 'No evidence was collected' },
  'filtered-out': { Icon: FilterX, tone: 'neutral', heading: 'No matches for these filters' },
  'collector-failed': { Icon: ServerCrash, tone: 'problem', heading: 'Collection failed' },
  'permission-required': { Icon: Lock, tone: 'problem', heading: 'Permission required' },
  'not-applicable': { Icon: CircleSlash, tone: 'neutral', heading: 'Not applicable to this estate' },
  'held-by-decision': { Icon: PauseCircle, tone: 'neutral', heading: 'Nothing outstanding' },
};

const ICON_TONE: Readonly<Record<Presentation['tone'], string>> = {
  positive: 'text-wa-success',
  problem: 'text-wa-warning',
  neutral: 'text-wa-text-muted',
};

export interface EmptyStateProps {
  readonly reason: EmptyReason;
  /** Overrides the default heading where the caller has something more specific to say. */
  readonly heading?: string;
  /**
   * Why, in the reader's terms. Required, because the heading states the category and the
   * category alone is never enough to act on.
   */
  readonly detail: string;
  readonly action?: ReactNode;
  /** Compact keeps a resolved state in the reading flow instead of turning it into the page. */
  readonly layout?: 'centered' | 'compact';
}

export function EmptyState({ reason, heading, detail, action, layout = 'centered' }: EmptyStateProps) {
  const presentation = PRESENTATION[reason];
  const { Icon } = presentation;

  return (
    <div
      className="wa-empty-state"
      data-layout={layout}
      // Announced politely: an empty result arriving after a scan is information the reader
      // needs, and it is the whole content of the region rather than an incidental change.
      role="status"
      data-empty-reason={reason}
    >
      <Icon aria-hidden className={`h-5 w-5 ${ICON_TONE[presentation.tone]}`} />
      <div className="wa-empty-state-copy">
        <p className="wa-title-section text-wa-text">{heading ?? presentation.heading}</p>
        <p className="wa-body-compact max-w-prose text-wa-text-secondary">{detail}</p>
      </div>
      {action != null && <div className="wa-empty-state-action">{action}</div>}
    </div>
  );
}
