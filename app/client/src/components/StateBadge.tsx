// Whether an answer is missing, lapsed, due or current.
//
// Its own file rather than a local in the Answers page, because the guided pass shows the same badge
// against the same states and a second set of tones would tell the reader that the two surfaces mean
// different things by "due".

import { CalendarClock, MessageSquareDashed, MessageSquareQuote, type LucideIcon } from 'lucide-react';
import { Badge, type Tone } from './ui/StatusBadge';
import { STATE_LABEL, type RequirementState } from '../pages/attest-language';

/**
 * State as its own badge rather than an outcome badge.
 *
 * Reusing OutcomeBadge here was the tempting shortcut and would have been a lie: `pass` and
 * "somebody said yes six months ago" are not the same claim, and a reader who has learnt the green
 * tick from the findings list would carry its meaning straight over.
 */
const STATE_TONE: Readonly<Record<RequirementState, Tone>> = {
  expired: 'danger',
  due: 'warning',
  unanswered: 'neutral',
  current: 'success',
};

/**
 * A shape per state, and `unanswered` is the one that needed it.
 *
 * It carries no fill — deliberately, because nobody having answered yet is not a fault — and so it
 * was a grey pill reading "Unanswered" in a list where three other states were coloured. An empty
 * speech bubble says the same thing without asking the reader to notice an absence of colour.
 */
const STATE_ICON: Readonly<Record<RequirementState, LucideIcon>> = {
  expired: CalendarClock,
  due: CalendarClock,
  unanswered: MessageSquareDashed,
  current: MessageSquareQuote,
};

export function StateBadge({ state }: { state: RequirementState }) {
  return (
    <Badge tone={STATE_TONE[state]} Icon={STATE_ICON[state]}>
      {STATE_LABEL[state]}
    </Badge>
  );
}
