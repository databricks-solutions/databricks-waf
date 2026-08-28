// What a run's review amounts to, for the surfaces that show the run's score.
//
// Separate from the store because it is arithmetic over records rather than a read of them, and
// arithmetic about a score is the class of thing this repository asks to be tested on its own: a
// count that includes a skipped pillar among the reviewed ones renders exactly as well as the true
// one. 43c.
//
// Three of the four counts the row named came out of the records as they stood. The fourth did not,
// and this file said so rather than approximating it until row `60` gave the review the action —
// see `refreshed` at the foot for what that did and did not change.

import { refreshedIn, selectedPillarsOf, type AssessmentResult, type PillarReview } from './review.js';
import type { ReviewRecord } from './store.js';
import type { FinalisationPayload } from '../../shared/api/contract.js';

/**
 * The run's standing with its review, or nothing where there is no review record for it.
 *
 * `undefined` for a run this app has no record of — a scan finished before reviews existed, or one
 * whose review this scope cannot see. That is distinct from a review with nothing recorded, which
 * counts zero of seven: the first is an absence of a record and the second is a record of an
 * absence, and only the second says a person has not done something.
 */
export function finalisationOf(
  record: ReviewRecord | undefined,
  known: readonly string[]
): FinalisationPayload<Date> | undefined {
  if (record == null) return undefined;
  const selected = selectedPillarsOf(record.review, known);

  // The result's pillars where there is one, because those are the records the result was written
  // from and the ones publication reads. Before a result exists they are the same list.
  const all: readonly PillarReview[] = record.result?.pillars ?? record.pillars;
  // Counted over the pillars the catalogue names now, because that is what `expected` counts and a
  // fraction whose halves come from different lists reads as its own contradiction: a review holding a
  // record for a pillar since removed said "2 of 1 pillars have a record" while refusing to finalise.
  // Which way the two can differ is not symmetric — `complete()` needs every known pillar recorded, so
  // a removed pillar leaves a spare record and an added one leaves a gap.
  const named = new Set(selected);
  const pillars = all.filter((one) => named.has(one.pillarId));
  const skipped = pillars.filter((one) => one.kind === 'skipped').map((one) => one.pillarId);

  return {
    reviewId: record.review.id,
    ...(record.result != null ? { resultId: record.result.id } : {}),
    finalised: record.result != null,
    recorded: pillars.length,
    expected: selected.length,
    confirmed: pillars.filter((one) => one.kind === 'confirmed').length,
    skipped: [...skipped].sort(),
    cited: citedBy(record.result, pillars),
    // From the answer records rather than the result, and unlike `cited` there is no frozen copy to
    // prefer: the store refuses an answer to a review that has a result, so the list cannot move
    // after finalisation and a second copy inside the result would be a second thing to keep true.
    refreshed: refreshedIn(record.answers, selected).length,
    ...(record.result != null
      ? { finalisedAt: record.result.finalisedAt, finalisedBy: record.result.finalisedBy }
      : {}),
  };
}

/**
 * How many attestations the confirmed pillars cited.
 *
 * From the result where there is one, because that is the list publication reads, and from the
 * pillar records before then. A skip contributes none — its `attestationIds` is absent rather than
 * empty, which is the distinction that stops a skipped pillar counting as confirmed with nothing.
 */
function citedBy(result: AssessmentResult | undefined, pillars: readonly PillarReview[]): number {
  if (result != null) return result.attestationIds.length;
  return pillars.reduce((total, one) => total + (one.attestationIds?.length ?? 0), 0);
}

/*
 * What `refreshed` counts, and what it still cannot.
 *
 * The row that asked for these counts asked for four: reused, refreshed, skipped and unmeasured.
 * Three were readable — skipped from `kind`, cited from `attestationIds`, unmeasured from the run's
 * own score — and the fourth had no field behind it, so this file counted nothing rather than
 * approximating it. The two approximations available were both worse than an absence: attestations
 * written between the review opening and finalising counts everything anybody answered in that
 * window, and attestations cited by the confirm that postdate the scan is a claim about *when* an
 * answer was written rather than about a reviewer replacing one.
 *
 * `60` gave the review the action instead, so the count is now a read of a record: `review_answers`
 * holds one row per attestation this review produced, written by the request that produced it.
 *
 * **It is still not a count of the reviewer's effort, and must not be described as one.** An answer
 * given from the questionnaire in another tab, during this review, about a requirement in a pillar
 * this review is looking at, is invisible here — nothing joins it to the review, which is the same
 * reason the approximations were refused. The word this supports is "answered here", and the
 * sentence carrying it is constrained accordingly in `finalisation-language.ts`.
 */
