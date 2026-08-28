// Whether a person has been over this run, beside the number they would quote from it.
//
// The score is the automated half. A reader taking 58 into a steering meeting is entitled to know
// whether anybody confirmed the half no check can reach, and — where a review is finished — which
// pillars nobody looked at. Every sentence is `finalisation-language.ts`'s; this places them.
//
// Renders nothing where the payload is absent. An install that keeps no reviews has nowhere to have
// recorded one, and a grey "unknown" badge beside a score reads as a state the review is in.

import { reviewStanding } from './finalisation-language';
import type { Finalisation } from '../api/types';

export interface ReviewStandingProps {
  readonly finalisation?: Finalisation;
  /** A pillar's own words, so a skip names the pillar rather than its id. */
  readonly pillarTitle?: (pillarId: string) => string;
}

/**
 * The state and its one-line reading, for the block that carries a score.
 *
 * The label is a word and the caption is the arithmetic behind it, because the word alone is where
 * "Reviewed" gets quoted from and the fraction is what makes it checkable.
 */
export function ReviewStandingNote({ finalisation, pillarTitle }: ReviewStandingProps) {
  const words = reviewStanding(finalisation, pillarTitle ?? ((id) => id));
  if (words == null) return null;

  return (
    <div>
      <p className="wa-label">Review</p>
      <p className="wa-body-compact font-medium text-wa-text">{words.label}</p>
      <p className="wa-caption mt-0.5">{words.caption}</p>
    </div>
  );
}

/**
 * The sentences behind the state, for a disclosure or a report section.
 *
 * Separate from the note above rather than folded into it: on the report these print, and in the
 * application they sit under "How this number is derived" with the other qualifications of the same
 * number. Same sentences either way — the module is the single source of what may be said.
 */
export function ReviewStandingDetail({ finalisation, pillarTitle }: ReviewStandingProps) {
  const words = reviewStanding(finalisation, pillarTitle ?? ((id) => id));
  if (words == null) return null;

  return (
    <>
      {words.detail.map((sentence) => (
        <p key={sentence}>{sentence}</p>
      ))}
    </>
  );
}
