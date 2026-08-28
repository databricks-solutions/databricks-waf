// What is holding the line while a requirement is unmet, read-only.
//
// One component for three places — the finding pane, the exception register, and the printed report —
// because the same five facts are what a reader needs in all of them: which requirement, why it is
// unmet, what is in place instead, how much risk that leaves, and when the acceptance stops. Three
// renderings of that would drift, and the one that drifted would be the report, which is the copy
// that leaves the building.
//
// The compensating control carries the weight, and it is deliberately not last. "Accepted by Ana
// until December" is the sentence a reader takes for reassurance; "the network path is restricted to
// two subnets and reviewed monthly, which leaves medium risk on a high requirement" is the sentence
// an auditor came for. The order on the page is the order those two get read in.

import type { AcceptedRisk } from '../api/types';
import {
  acceptedPhrase,
  expiryPhrase,
  residualPhrase,
  startPhrase,
  STANDING_DETAIL,
  STANDING_ICON,
  STANDING_LABEL,
  STANDING_TONE,
} from '../pages/accept-language';
import { Badge } from './ui/StatusBadge';

export function RiskStandingBadge({ standing }: { standing: AcceptedRisk['standing'] }) {
  return (
    <Badge tone={STANDING_TONE[standing]} Icon={STANDING_ICON[standing]}>
      {STANDING_LABEL[standing]}
    </Badge>
  );
}

export interface AcceptedRiskNoteProps {
  readonly risk: AcceptedRisk;
  /** False where a badge already sits beside the title, as in the register's own pane. */
  readonly badged?: boolean;
}

export function AcceptedRiskNote({ risk, badged = true }: AcceptedRiskNoteProps) {
  const starts = startPhrase(risk);

  return (
    <div className="space-y-2 border-t border-wa-divider pt-3">
      <div className="flex items-start justify-between gap-2">
        <p className="wa-label">Accepted, with something else holding the line</p>
        {badged && <RiskStandingBadge standing={risk.standing} />}
      </div>

      {/*
       * The compensating control first, and quoted, because it is the claim being made. The reason is
       * below it as context: a reader who takes in the reason first has already formed a view on
       * whether the exposure is tolerable before reading the only sentence that bears on it.
       */}
      <div className="space-y-1">
        <p className="wa-caption">What is in place instead</p>
        <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text">
          {risk.compensatingControl}
        </blockquote>
      </div>

      <div className="space-y-1">
        <p className="wa-caption">Why the requirement is not met</p>
        <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text">
          {risk.reason}
        </blockquote>
      </div>

      <p className="wa-caption">{residualPhrase(risk)}</p>

      <p className="wa-caption">
        Accepted by {acceptedPhrase(risk)}. Answerable: {risk.owner}. {expiryPhrase(risk)}
        {starts != null && ` ${starts}`}
      </p>

      {/* What the standing means, in words, for the reason the decision note says it: a coloured
          badge on its own reads as a fault in the app rather than as an exception that has lapsed. */}
      <p className="wa-caption">{STANDING_DETAIL[risk.standing]}</p>

      {risk.revoked != null && (
        <div className="space-y-1">
          <p className="wa-caption">Ended early by {risk.revoked.by}</p>
          <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text">
            {risk.revoked.reason}
          </blockquote>
        </div>
      )}
    </div>
  );
}
