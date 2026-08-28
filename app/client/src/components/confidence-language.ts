// The words a reader sees about how firmly a finding is established, and how long it has stood.
//
// Split from the component for the reason the change summary's prose is: these are sentences with
// judgement in them and they are worth testing on their own, where testing them through a rendered
// pane means asserting on markup to check a phrase.
//
// The server decides the standing and writes every limitation; nothing here re-derives either. What
// this adds is the two things the wire format leaves to the reader's surface: the short label a
// badge carries, and the one sentence an occurrence history reduces to.

import type { Confidence, Occurrence, Outcome } from '../api/types';

/**
 * The badge word for a standing.
 *
 * Deliberately not "high", "medium", "low". A three-point scale invites arithmetic — averaging it
 * across a pillar, sorting by it, treating two mediums as worth one high — and none of those
 * operations mean anything, because the underlying facts are categorical: an answer from a person
 * is not two-thirds of a reading. These say what the finding rests on instead.
 */
export function standingWord(confidence: Confidence): string | undefined {
  if (confidence.standing === 'established') return 'Established';
  if (confidence.standing === 'qualified') return 'Qualified';
  if (confidence.standing === 'stated') return 'Stated, not read';
  // `none` is an unmeasurable finding, where `unmeasured` already answers the reader's question and
  // a badge saying "no confidence" would read as a fault rather than as an absence.
  return undefined;
}

/**
 * How long the outcome has held, as one sentence, or nothing when there is nothing to say.
 *
 * A streak of one with no history behind it says nothing a reader cannot see from the run's own
 * date, so it renders nothing rather than "1 run" — a count of one, repeated on every requirement
 * of a first assessment, is a hundred and eighty-four rows of furniture.
 */
export function occurrenceSentence(occurrence: Occurrence, outcome: Outcome): string | undefined {
  const held = describeOutcome(outcome);

  if (occurrence.runs <= 1) {
    if (occurrence.horizon === 'changed' && occurrence.changedFrom != null) {
      return `New in this run: it was ${describeOutcome(occurrence.changedFrom.outcome)} on ${on(occurrence.changedFrom.at)}.`;
    }
    if (occurrence.horizon === 'first-run') return 'The first assessment of this estate, so there is nothing to compare it with.';
    return undefined;
  }

  const across = `${held} in ${String(occurrence.runs)} consecutive runs, since ${on(occurrence.since)}`;

  if (occurrence.horizon === 'changed' && occurrence.changedFrom != null) {
    return `${across}. Before that it was ${describeOutcome(occurrence.changedFrom.outcome)}.`;
  }
  if (occurrence.horizon === 'first-run') return `${across}, which is every run of this estate.`;
  if (occurrence.horizon === 'not-comparable') {
    return `${across}. The run before that cannot be compared with this one, so how long it had held before then is not known from here.`;
  }
  if (occurrence.horizon === 'unrecorded') {
    return `${across}. Runs before that did not record what each requirement found, so the streak may be longer.`;
  }
  // The requirement's own history, not the estate's, which is why these two read as complete
  // statements rather than as limits: a streak back to the release that introduced a requirement is
  // every run it has ever been assessed in, and one back to the release that rescoped it is every run
  // that asked the current question.
  if (occurrence.horizon === 'introduced') {
    return `${across}, which is every run since this requirement was added to the catalogue.`;
  }
  if (occurrence.horizon === 'redefined') {
    return `${across}, which is every run since a catalogue release changed what this requirement asks.`;
  }
  return `${across}, which is as far back as the runs read here go.`;
}

/**
 * The outcome as a state something has been in, rather than as a label.
 *
 * "Failing since March" reads; "fail since March" does not, and a pane that renders the wire value
 * into a sentence is a pane whose prose changes shape when an outcome is added.
 */
function describeOutcome(outcome: Outcome): string {
  if (outcome === 'pass') return 'Met';
  if (outcome === 'fail') return 'Unmet';
  if (outcome === 'partial') return 'Partly met';
  if (outcome === 'unmeasurable') return 'Unmeasured';
  if (outcome === 'not-applicable') return 'Not applicable';
  return 'Met by the platform';
}

function on(date: string): string {
  return new Date(date).toLocaleDateString();
}
