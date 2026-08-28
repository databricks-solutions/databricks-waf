// What the assessment said it would reach, held against what the run found.
//
// The sentence is the server's, not this component's. A target reading is arithmetic — a score, a
// date, the gap between them and how long is left — and the same arithmetic written twice drifts:
// the browser would round differently, or count a day differently across a timezone, and the two
// numbers on one screen would disagree about whether a commitment had been met. So the server sends
// the sentence it computed and this shows it, and the only judgement made here is which colour to
// put beside it.
//
// Colour is not the message. Each standing has a word for it, because "short" and "gap" are two
// different situations that a red dot cannot tell apart: one is a commitment that is behind and
// still has time, the other is a date that has passed. A reader who cannot see the colour needs the
// difference, and a reader who can still has to be told which is which.

import { Link } from 'react-router';
import { CalendarClock, CircleAlert, CircleCheck, CircleDashed, CircleSlash } from 'lucide-react';
import type { TargetReading, TargetStanding } from '../api/types';

/** How each standing reads, and how it looks. */
const STANDINGS: Readonly<Record<TargetStanding, { word: string; tone: string; Icon: typeof CircleCheck }>> = {
  met: { word: 'Met', tone: 'text-wa-success', Icon: CircleCheck },
  // Behind, with time left. Warning rather than danger: a commitment three months out that is 8
  // points short is the ordinary state of a plan, and colouring it the same as a missed date would
  // make the missed dates unfindable.
  short: { word: 'Behind', tone: 'text-wa-warning', Icon: CircleAlert },
  // The date has passed and the score is under it. Called a gap rather than a miss, in the same
  // words the server uses, because the commitment is still the commitment — what has changed is
  // that there is no longer time in which to reach it.
  gap: { word: 'Gap', tone: 'text-wa-danger', Icon: CircleSlash },
  'not-scored': { word: 'Not scored', tone: 'text-wa-text-muted', Icon: CircleDashed },
  'not-assessed': { word: 'Not in this assessment', tone: 'text-wa-text-muted', Icon: CircleDashed },
};

/**
 * Every commitment this assessment made, in the order the definition holds them.
 *
 * Not sorted by urgency. The definition's order is the order the author wrote them in, and a list
 * that reshuffles itself between two runs is a list nobody can talk about in a meeting — "the third
 * one" has to keep meaning the same commitment. What is urgent is said in the words of each row.
 */
export function Commitments({
  targets,
  pillarTitle,
}: {
  readonly targets: readonly TargetReading[];
  readonly pillarTitle: (pillarId: string) => string;
}) {
  if (targets.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2 p-3" aria-label="What this assessment committed to">
      {targets.map((target) => (
        <li key={target.pillar}>
          <Commitment target={target} pillarTitle={pillarTitle} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One commitment, as a line.
 *
 * The pillar is named only where the reader could be looking at a commitment about any of them. On
 * that pillar's own page the name is the page title, the summary heading beside it, and the crumb
 * above both — a fourth would be noise, and the link would go to the page it was clicked on.
 *
 * Where it is named it links, because a commitment that is behind is a question about that pillar and
 * the reader's next move is to go and see what is failing in it. `not-assessed` is the one standing
 * that does not link: the pillar is not in this assessment, so its page would show the reader nothing
 * about the thing they clicked.
 */
export function Commitment({
  target,
  pillarTitle,
}: {
  readonly target: TargetReading;
  /** Absent where the surface has already named the pillar. */
  readonly pillarTitle?: (pillarId: string) => string;
}) {
  const { word, tone, Icon } = STANDINGS[target.standing];
  const title = pillarTitle?.(target.pillar);

  return (
    <div className="flex items-start gap-2">
      <Icon aria-hidden className={`mt-0.5 h-4 w-4 shrink-0 ${tone}`} />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2">
          {title != null &&
            (target.standing === 'not-assessed' ? (
              <span className="wa-body-compact text-wa-text font-medium">{title}</span>
            ) : (
              <Link
                to={`/pillars/${target.pillar}`}
                className="wa-body-compact text-wa-text font-medium hover:underline"
              >
                {title}
              </Link>
            ))}
          {/* The word beside the icon, so the standing survives being read in greyscale or by
              somebody who cannot see the colour at all. */}
          <span className={`wa-label ${tone}`}>{word}</span>
        </span>
        <span className="wa-caption">{target.sentence}</span>
      </div>
    </div>
  );
}

/**
 * The commitment made about one pillar, on that pillar's own page.
 *
 * Returns nothing when there is none, rather than a line saying so. An assessment that committed to
 * three pillars did not decline to commit to the other four — it made three promises, and printing
 * "no target" on every other pillar's page would turn six absences into six statements.
 */
export function CommitmentFor({
  targets,
  pillarId,
}: {
  readonly targets: readonly TargetReading[] | undefined;
  readonly pillarId: string;
}) {
  const target = (targets ?? []).find((one) => one.pillar === pillarId);
  if (target == null) return null;

  return (
    <div className="border-wa-divider flex flex-col gap-1 border-t pt-3">
      <span className="wa-label text-wa-text-secondary flex items-center gap-1.5">
        <CalendarClock aria-hidden className="h-3.5 w-3.5" />
        What this assessment committed to
      </span>
      {/* No pillar name. It is the page title, the heading beside this and the crumb above both, and
          the link would go to the page it was clicked on. */}
      <Commitment target={target} />
    </div>
  );
}
