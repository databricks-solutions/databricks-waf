// The decision standing against a finding, read-only.
//
// One component for three places — the finding pane, the decisions register, and the printed report
// — because the same four facts are what a reader needs in all of them: what was decided, by whom,
// why, and what has become of it since. Three renderings of that would drift, and the one that
// drifted would be the report, which is the copy that leaves the building.
//
// The standing carries the weight. "Accepted by Ana on 3 June" is bookkeeping; "recorded as fixed on
// 3 June, and the run on 14 July still measures it as unmet" is the sentence somebody acts on, and
// it is the reason this is not just a line of metadata under the title.

import type { Decision } from '../api/types';
import {
  datePhrase,
  decidedPhrase,
  DISPOSITION_LABEL,
  STANDING_DETAIL,
  STANDING_ICON,
  STANDING_LABEL,
  STANDING_TONE,
} from '../pages/decide-language';
import { Badge } from './ui/StatusBadge';

export function StandingBadge({ standing }: { standing: Decision['standing'] }) {
  return (
    <Badge tone={STANDING_TONE[standing]} Icon={STANDING_ICON[standing]}>
      {STANDING_LABEL[standing]}
    </Badge>
  );
}

export interface DecisionNoteProps {
  readonly decision: Decision;
  /** False in the finding pane, where the badge already sits beside the outcome. */
  readonly badged?: boolean;
}

export function DecisionNote({ decision, badged = true }: DecisionNoteProps) {
  const date = datePhrase(decision);

  return (
    <div className="space-y-1 border-t border-wa-divider pt-3">
      <div className="flex items-start justify-between gap-2">
        <p className="wa-label">{DISPOSITION_LABEL[decision.disposition]}</p>
        {badged && <StandingBadge standing={decision.standing} />}
      </div>
      <blockquote className="wa-body-compact border-l-2 border-wa-divider pl-2 text-wa-text">
        {decision.reason}
      </blockquote>
      <p className="wa-caption">
        {decidedPhrase(decision)}
        {decision.owner != null && `. Answerable: ${decision.owner}`}
        {date !== '' && `. ${date}`}
      </p>
      {/* What the standing means, in words. A red badge on its own reads as a fault in the app
          rather than as a fix that did not take. */}
      <p className="wa-caption">{STANDING_DETAIL[decision.standing]}</p>
    </div>
  );
}
