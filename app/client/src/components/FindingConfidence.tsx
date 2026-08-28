// What the finding rests on, and how long it has rested there.
//
// Placed after the evidence rather than before it, and that is the whole of the argument for where
// this goes: the limitations are statements about the evidence a reader has just read, and a
// paragraph saying "this was a sample of twenty" ahead of the sample would be answering a question
// nobody has yet asked. The occurrence line goes the other way, up beside the outcome, because
// "unmet, and unmet at the last five assessments" is one fact and splitting it across a pane makes
// a reader hold half of it while they scroll.

import type { Confidence, Occurrence, Outcome } from '../api/types';
import { Surface } from './system';
import { occurrenceSentence, standingWord } from './confidence-language';

export interface FindingConfidenceProps {
  readonly confidence: Confidence;
}

/**
 * The standing, why, and every limitation.
 *
 * The limitations are a list even when there is one of them. Run together as a paragraph they read
 * as a single hedge and the reader takes the gist; as a list they read as a count of separate things
 * that are true, which is what they are — and it is the count that tells somebody whether to trust
 * the number in a steering paper.
 */
export function FindingConfidence({ confidence }: FindingConfidenceProps) {
  if (confidence.standing === 'none') return null;
  const word = standingWord(confidence);

  return (
    <Surface tone="inset" title="Confidence" description={word} headingLevel={3}>
      <p className="wa-body-compact text-wa-text-secondary">{confidence.because}</p>
      {confidence.limitations.length > 0 && (
        <ul className="wa-body-compact space-y-1 text-wa-text-secondary">
          {confidence.limitations.map((limitation) => (
            <li key={limitation.kind} className="flex gap-2">
              {/* A marker rather than a list-style, so the text of a wrapped line aligns under
                  itself instead of under the bullet. */}
              <span aria-hidden="true" className="text-wa-text-muted">
                &middot;
              </span>
              <span>{limitation.says}</span>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}

export interface FindingHistoryProps {
  readonly occurrence: Occurrence;
  readonly outcome: Outcome;
}

/** One line: how long this outcome has held, and how far back this build can see. */
export function FindingHistory({ occurrence, outcome }: FindingHistoryProps) {
  const says = occurrenceSentence(occurrence, outcome);
  if (says == null) return null;

  return <p className="wa-caption">{says}</p>;
}
