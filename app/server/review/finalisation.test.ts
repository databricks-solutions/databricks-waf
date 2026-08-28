// The properties a reader acts on: that a skip is never counted as a confirm, that a record with
// nothing in it is not the same answer as no record, and that the cited count comes off the result
// once there is one.

import { describe, expect, it } from 'vitest';
import { finalisationOf } from './finalisation';
import type { AssessmentResult, AssessmentReview, PillarReview, ReviewAnswer } from './review';
import type { ReviewRecord } from './store';

const PILLARS = ['reliability', 'security', 'cost-optimisation'];

const review: AssessmentReview = {
  id: 'rev-1',
  runId: 'scan-1',
  openedBy: 'system',
  openedAt: new Date('2026-08-01T00:00:00.000Z'),
};

function confirmed(pillarId: string, attestationIds: readonly string[] = []): PillarReview {
  return {
    id: `pr-${pillarId}`,
    reviewId: 'rev-1',
    runId: 'scan-1',
    pillarId,
    kind: 'confirmed',
    attestationIds,
    by: 'alice',
    at: new Date('2026-08-02T00:00:00.000Z'),
  };
}

function skipped(pillarId: string): PillarReview {
  return {
    id: `pr-${pillarId}`,
    reviewId: 'rev-1',
    runId: 'scan-1',
    pillarId,
    kind: 'skipped',
    by: 'alice',
    at: new Date('2026-08-02T00:00:00.000Z'),
  };
}

function record(
  pillars: readonly PillarReview[],
  result?: AssessmentResult,
  answers: readonly ReviewAnswer[] = []
): ReviewRecord {
  return { review, pillars, answers, ...(result != null ? { result } : {}) };
}

function result(pillars: readonly PillarReview[]): AssessmentResult {
  return {
    id: 'res-1',
    reviewId: review.id,
    runId: review.runId,
    finalisedBy: 'alice',
    finalisedAt: new Date('2026-08-03T00:00:00.000Z'),
    pillars,
    attestationIds: pillars.flatMap((one) => one.attestationIds ?? []),
  };
}

function answer(pillarId: string, attestationId: string): ReviewAnswer {
  return {
    id: `answer-${attestationId}`,
    reviewId: review.id,
    runId: review.runId,
    pillarId,
    controlId: `${pillarId}-01-01`,
    attestationId,
    by: 'alice',
    at: new Date('2026-08-02T00:00:00.000Z'),
  };
}

describe('where a run stands with its review', () => {
  it('says nothing at all for a run with no review record', () => {
    // Not `finalised: false`. A scan finished before reviews existed has nobody who failed to
    // review it, and a payload saying otherwise would put that on a person.
    expect(finalisationOf(undefined, PILLARS)).toBeUndefined();
  });

  it('counts a review with nothing recorded as none of the pillars, which is not the same answer', () => {
    const standing = finalisationOf(record([]), PILLARS);

    expect(standing).toEqual({
      reviewId: 'rev-1',
      finalised: false,
      recorded: 0,
      expected: 3,
      confirmed: 0,
      skipped: [],
      cited: 0,
      refreshed: 0,
    });
  });

  it('never counts a skipped pillar among the confirmed ones, and names which were skipped', () => {
    const standing = finalisationOf(record([confirmed('reliability', ['a1']), skipped('security')]), PILLARS);

    expect(standing?.confirmed).toBe(1);
    expect(standing?.skipped).toEqual(['security']);
    // Two of three pillars have a record, and one of those two is a record of nobody reviewing it.
    expect(standing?.recorded).toBe(2);
    expect(standing?.finalised).toBe(false);
  });

  it('counts only what the confirms cited, because a skip cites nothing', () => {
    const standing = finalisationOf(
      record([confirmed('reliability', ['a1', 'a2']), skipped('security'), confirmed('cost-optimisation', ['a3'])]),
      PILLARS
    );

    expect(standing?.cited).toBe(3);
  });

  it('reads the result once there is one, so the payload is the record publication reads', () => {
    const pillars = [confirmed('reliability', ['a1']), skipped('security'), confirmed('cost-optimisation', ['a2'])];
    const result: AssessmentResult = {
      id: 'res-1',
      reviewId: 'rev-1',
      runId: 'scan-1',
      finalisedBy: 'alice',
      finalisedAt: new Date('2026-08-03T00:00:00.000Z'),
      pillars,
      attestationIds: ['a1', 'a2'],
    };

    const standing = finalisationOf(record(pillars, result), PILLARS);

    expect(standing).toEqual({
      reviewId: 'rev-1',
      resultId: 'res-1',
      finalised: true,
      recorded: 3,
      expected: 3,
      confirmed: 2,
      skipped: ['security'],
      cited: 2,
      refreshed: 0,
      finalisedAt: new Date('2026-08-03T00:00:00.000Z'),
      finalisedBy: 'alice',
    });
  });

  it('reports the pillars the catalogue names, not the ones the review happened to touch', () => {
    // A pillar added to the catalogue after the review opened leaves a finalised review short of the
    // expected count. Reporting `expected` as the recorded count would hide that.
    expect(finalisationOf(record([confirmed('reliability')]), PILLARS)?.expected).toBe(3);
    expect(finalisationOf(record([confirmed('reliability')]), [])?.expected).toBe(0);
  });

  it('reports progress over the immutable selected set when the review carries one', () => {
    const standing = finalisationOf(
      {
        ...record([confirmed('reliability')]),
        review: { ...review, selectedPillars: ['reliability'] },
      },
      PILLARS
    );

    expect(standing).toMatchObject({ recorded: 1, expected: 1, confirmed: 1 });
  });

  it('counts both halves of the fraction over the same list, so a removed pillar cannot inflate it', () => {
    // A record for a pillar the catalogue has since dropped. Counted, it read "2 of 1 pillars have a
    // record" on a review the store refuses to finalise — a refusal citing its own evidence of
    // sufficiency. The pillar is gone, so its record is not part of what this review covers.
    const standing = finalisationOf(record([confirmed('reliability'), confirmed('retired')]), ['reliability']);

    expect(standing?.recorded).toBe(1);
    expect(standing?.expected).toBe(1);
    expect(standing?.confirmed).toBe(1);
  });

  it('does not name a skipped pillar the catalogue no longer has', () => {
    const standing = finalisationOf(record([confirmed('reliability'), skipped('retired')]), ['reliability']);

    expect(standing?.skipped).toEqual([]);
  });
});

describe('counting the answers a review produced', () => {
  it('counts none for a review that produced none, which is a fact rather than an absence', () => {
    // Zero and not undefined. Every review finalised before the action existed produced no answers,
    // and that is what those reviews did — the surfaces may say so.
    expect(finalisationOf(record([confirmed('reliability')]), PILLARS)?.refreshed).toBe(0);
  });

  it('counts one per attestation, across pillars', () => {
    const standing = finalisationOf(
      record([], undefined, [answer('reliability', 'att-1'), answer('security', 'att-2')]),
      PILLARS
    );

    expect(standing?.refreshed).toBe(2);
  });

  it('counts two answers to the same requirement twice, because they are two answers', () => {
    // Answering a requirement and then answering it again supersedes the first, and both were given
    // in this review. The attestation ids differ, so both count; the word is about answers, and the
    // reviewer gave two.
    const standing = finalisationOf(
      record([], undefined, [answer('reliability', 'att-1'), answer('reliability', 'att-2')]),
      PILLARS
    );

    expect(standing?.refreshed).toBe(2);
  });

  it('counts one attestation once, however many records point at it', () => {
    // Not reachable through the route — the store is unique on the attestation — and filtered here
    // rather than trusted not to happen, because the alternative is a count that reads high with
    // nothing to say why.
    const standing = finalisationOf(
      record([], undefined, [answer('reliability', 'att-1'), answer('reliability', 'att-1')]),
      PILLARS
    );

    expect(standing?.refreshed).toBe(1);
  });

  it('does not count an answer against a pillar the catalogue no longer has', () => {
    // The same rule the fraction follows above, for the same reason: a count over a different list
    // from the one beside it is two facts about two estates presented as one.
    const standing = finalisationOf(record([], undefined, [answer('retired', 'att-1')]), ['reliability']);

    expect(standing?.refreshed).toBe(0);
  });

  it('still counts the answers of a finalised review, which cannot have gained any since', () => {
    // Read from the answer records rather than from the result, so this is the test that the two do
    // not drift: the store refuses an answer once a result exists, so the list is frozen by that
    // refusal rather than by being copied.
    const pillars = PILLARS.map((id) => confirmed(id));
    const standing = finalisationOf(record(pillars, result(pillars), [answer('reliability', 'att-1')]), PILLARS);

    expect(standing?.finalised).toBe(true);
    expect(standing?.refreshed).toBe(1);
  });
});
