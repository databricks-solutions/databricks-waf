// What may be said about a run's review, beside the score the run produced.
//
// The score a reader sees is the automated half. Whether a person has been over the other half is a
// different fact, and every sentence here is bounded by a field in `FinalisationPayload`:
//
//   - A skipped pillar is one **nobody confirmed the answers of in this review**. `kind` is `skipped`
//     and that is all it is: the run can hold attested answers for that pillar, which the review did
//     not cite, so "its requirements were not answered" would be a claim about the scan taken from a
//     field about the review. "Reviewed" is never said of a run with a skip in it without naming the
//     skips in the same breath.
//   - "Reviewed" also needs `confirmed === expected`. A review finalises against the catalogue as it
//     stood, so a pillar added since leaves a finished review that covers fewer pillars than there
//     now are, and the word would name a coverage no field carries.
//   - `cited` counts ids the run already held, copied at confirm. It may not be called the answers on
//     record now — `reusedPhrase` in review-language.ts is that other number, and the two are read
//     from different sources at different times. The plan's word for this count is "reused"; it is
//     not used here for the same reason.
//   - `refreshed` counts attestations **this review wrote**, one row per answer given through the
//     review's own action. It may not be called the reviewer's effort, the work this review caused, or
//     how many answers were brought up to date while it was open: an answer given from the
//     questionnaire in another tab is invisible to the count, so any of those readings is a claim
//     about a person taken from a field about a route. It counts answers and not requirements —
//     answering the same one twice supersedes the first and both attestations are counted — so it may
//     not be said as "requirements answered" either. Zero is said as nothing rather than as a
//     sentence: on a review whose pillars were all confirmed off the run there is nothing to report,
//     and "no answers were refreshed" reads as a reproach.
//   - An absent payload is **cannot say**, not "nobody reviewed it". An install that keeps no reviews
//     has nowhere to have recorded one, and reporting that as unreviewed would put an install's
//     wiring on a person as a thing they did not do.
//   - Nothing here says a review is due, overdue, or that the score is provisional pending one. No
//     field carries a review deadline.
//
// The pattern is schedule-language.ts: the constraint beside the sentence, and a test that fails when
// the sentence outgrows it. 43c, GAP-033.

import type { Finalisation } from '../api/types';

export interface ReviewStanding {
  /**
   * One or two words for the state, for a badge beside the score.
   *
   * Four states rather than two, because a review can be finished and still have parts nobody looked
   * at. "Reviewed" over a run with three skipped pillars would be the sentence being more specific
   * than the record under it.
   */
  readonly label: 'Reviewed' | 'Partly reviewed' | 'Not reviewed' | 'Review not finished';
  /** One line under the score. */
  readonly caption: string;
  /** The sentences behind it, for the disclosure. In reading order, none of them optional. */
  readonly detail: readonly string[];
}

/**
 * What to say about this run's review, or nothing where this app cannot say.
 *
 * `null` for an absent payload, which is the install that keeps no reviews. The caller renders
 * nothing at all in that case — not a grey "unknown", which reads as a state the review is in.
 */
export function reviewStanding(
  finalisation: Finalisation | undefined,
  pillarTitle: (pillarId: string) => string
): ReviewStanding | null {
  if (finalisation == null) return null;

  const { finalised, recorded, expected, confirmed, skipped, cited, refreshed } = finalisation;
  const skips = skipped.map(pillarTitle);

  return {
    label: labelFor(finalisation),
    caption: captionFor(finalisation),
    detail: [
      finalised
        ? `Finalised by ${finalisation.finalisedBy ?? 'somebody this app did not record'} on ${onDate(finalisation.finalisedAt)}.`
        : `${String(recorded)} of ${String(expected)} pillars have a record, so this review is not finished. ` +
          'The score is what the run measured either way.',
      confirmed === 0
        ? 'No pillar has been confirmed, so no part of this score has somebody standing behind its answers.'
        : `${plural(confirmed, 'pillar')} confirmed, citing ${plural(cited, 'answer')} this run already held. ` +
          'Not a count of what is on record now.',
      ...(refreshed === 0
        ? []
        : [
            `${plural(refreshed, 'answer')} ${refreshed === 1 ? 'was' : 'were'} given from inside this review. ` +
              'Answers recorded elsewhere while it was open are not counted here.',
          ]),
      ...(skips.length === 0
        ? []
        : [
            `${andList(skips)} ${skips.length === 1 ? 'was' : 'were'} skipped. ` +
              `Nobody confirmed ${skips.length === 1 ? 'its' : 'their'} answers in this review.`,
          ]),
    ],
  };
}

/**
 * A run finalised with every pillar skipped is finished and unreviewed at the same time.
 *
 * Which is why `finalised` alone cannot decide the word. The result record says the review is closed;
 * `confirmed` says whether anybody stood behind any of it, and a reader deciding whether to quote the
 * score is asking the second question.
 */
function labelFor(finalisation: Finalisation): ReviewStanding['label'] {
  if (!finalisation.finalised) return 'Review not finished';
  if (finalisation.confirmed === 0) return 'Not reviewed';
  // Every pillar the catalogue names now, not every pillar the review covered. A review finalises
  // against the catalogue as it stood, so a pillar added since leaves a finished review with nothing
  // recorded for it, and "Reviewed" over that names a coverage the record does not carry.
  return finalisation.skipped.length === 0 && finalisation.confirmed === finalisation.expected
    ? 'Reviewed'
    : 'Partly reviewed';
}

function captionFor(finalisation: Finalisation): string {
  const { finalised, recorded, expected, confirmed, skipped } = finalisation;
  if (!finalised) {
    return recorded === 0
      ? `No pillar of this run has been reviewed yet (0 of ${String(expected)}).`
      : `${String(recorded)} of ${String(expected)} pillars reviewed or skipped.`;
  }
  if (skipped.length === 0 && confirmed === expected) return `All ${String(expected)} pillars confirmed.`;
  if (skipped.length === 0) return `${String(confirmed)} of ${String(expected)} pillars confirmed.`;
  return `${String(confirmed)} of ${String(expected)} pillars confirmed, ${String(skipped.length)} skipped.`;
}

/*
 * There is no `publishable` here, and there was.
 *
 * The gate is the server's, and the month page disables its action on `unreviewedNote` — the server's
 * own sentence about the run that closes that month. A second implementation of the rule on this side
 * would have to pick a run to apply it to, and the page showing a score is not showing a month.
 */

function onDate(value: string | undefined): string {
  if (value == null) return 'an unrecorded date';
  const when = new Date(value);
  if (Number.isNaN(when.getTime())) return 'an unrecorded date';
  return when.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** `a`, `a and b`, `a, b and c`. Named pillars, because a count cannot say which parts went unreviewed. */
function andList(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? '';
  return `${items.slice(0, -1).join(', ')} and ${String(items.at(-1))}`;
}
