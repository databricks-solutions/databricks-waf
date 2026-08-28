// Saying what a score does not yet know.
//
// A score computed from a fifth of a pillar is arithmetically correct and reads as a
// verdict on the whole pillar. The remedy is not to hide it but to state, in the same units
// as the score, how far it could still move: if every unmeasured requirement failed the
// score would be `low`, and if every one passed it would be `high`.
//
// The wording is deliberately about requirements rather than percentages. "21% measured"
// asks the reader to work out what that means for the number in front of them; "could be
// anywhere between 23 and 100" already is that answer.

import type { ScoreRange, Unmeasured } from '../api/types';

/** True when there is anything unmeasured, and so anything worth saying. */
export function isUncertain(range: ScoreRange | undefined): boolean {
  return range != null && range.high - range.low >= 0.1;
}

/**
 * How much of the score is guesswork, as a word.
 *
 * Bands rather than a number because the point is what to do about it: a reader who sees
 * "mostly unmeasured" should stop reading the score, and one who sees "slightly" should
 * not.
 */
export function certainty(range: ScoreRange | undefined): 'measured' | 'slight' | 'substantial' | 'mostly' {
  if (!isUncertain(range) || range == null) return 'measured';
  const width = range.high - range.low;
  if (width < 15) return 'slight';
  if (width < 50) return 'substantial';
  return 'mostly';
}

/**
 * Whether the reader should be told to stop reading the score.
 *
 * Exported so the verdict word and the sentence under it come from one predicate. They did not:
 * `scoreVerdict` took `isUncertain`, which is true from a tenth of a point of width, so a card could
 * read "Too little measured" over a sentence saying the score is between 68 and 74 — a heading
 * withholding a verdict the prose beneath it was giving. Every pillar on the labs install read that
 * heading, four of the five with ranges narrow enough for `rangeSentence` to state the span plainly.
 *
 * The band rather than a second threshold, so the two cannot drift apart on a later edit.
 */
export function tooLittleMeasured(range: ScoreRange | undefined): boolean {
  return certainty(range) === 'mostly';
}

/**
 * What is unknown, phrased as what would resolve it.
 *
 * Order is by whose move it is: the customer's, then ours, then access. A reader who has 12
 * attestations outstanding and 1 unreadable source should be told about the 12 first,
 * because that is the one they can act on today.
 *
 * A disabled check is last because it is the only one already resolved — somebody decided it,
 * and the clause says what was decided rather than what to do about it.
 *
 * Each clause is written for one and for many, because a count of one is the common case on a
 * healthy estate, and four of the five clauses here disagreed with a count of one until it was —
 * `attestation` read "1 are practices only you can confirm". `unreadable` was already number-neutral.
 *
 * Keyed off `Unmeasured` so a sixth kind cannot be counted in the total above this sentence and left
 * out of the sentence. Insertion order is the order the clauses read in.
 */
const CLAUSE: Readonly<Record<Unmeasured, (count: number) => string>> = {
  attestation: (count) =>
    count === 1 ? '1 is a practice only you can confirm' : `${count.toLocaleString()} are practices only you can confirm`,
  // Second because it is also the reader's move, and phrased so they know it is not coming: an
  // earlier version of this sentence counted these as "no automated check in this version", which
  // reads as next version.
  unreachable: (count) =>
    count === 1
      ? '1 is a setting this app is not authorised to read'
      : `${count.toLocaleString()} are settings this app is not authorised to read`,
  unbuilt: (count) =>
    count === 1
      ? '1 has no automated check in this version'
      : `${count.toLocaleString()} have no automated check in this version`,
  unreadable: (count) => `${count.toLocaleString()} could not be read from this workspace`,
  disabled: (count) =>
    count === 1 ? '1 is switched off in this install' : `${count.toLocaleString()} are switched off in this install`,
};

export function unmeasuredBreakdown(by: Readonly<Record<Unmeasured, number>> | undefined): string | undefined {
  if (by == null) return undefined;

  const clauses = Object.entries(CLAUSE)
    .map(([kind, clause]) => {
      const count = by[kind as Unmeasured];

      return count > 0 ? clause(count) : undefined;
    })
    .filter((clause): clause is string => clause != null);

  if (clauses.length === 0) return undefined;
  if (clauses.length === 1) return `Of those, ${clauses[0] ?? ''}.`;

  return `Of those, ${clauses.slice(0, -1).join(', ')} and ${clauses[clauses.length - 1] ?? ''}.`;
}

export function rangeSentence(
  range: ScoreRange | undefined,
  unmeasured: number,
  options: { readonly subject?: string; readonly by?: Readonly<Record<Unmeasured, number>> } = {}
): string | undefined {
  if (!isUncertain(range) || range == null) return undefined;

  const subject = options.subject ?? 'this pillar';
  const requirements =
    unmeasured === 1
      ? '1 requirement without an answer turns'
      : `${unmeasured.toLocaleString()} requirements without an answer turn`;
  const span = `between ${range.low.toFixed(1)} and ${range.high.toFixed(1)}`;
  const breakdown = unmeasuredBreakdown(options.by);
  const tail = breakdown == null ? '' : ` ${breakdown}`;

  if (tooLittleMeasured(range)) {
    return (
      `Too little of ${subject} is known for this number to mean much: the true score is somewhere ${span}, ` +
      `depending on how the ${requirements} out.${tail} Read the findings rather than ` +
      'the score.'
    );
  }

  return (
    `The true score is ${span}, depending on how the ${requirements} out.${tail} ` +
    'They are left out of the arithmetic rather than counted as passes or failures.'
  );
}
