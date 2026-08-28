import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import {
  InvalidReviewError,
  answered,
  confirmed,
  opened,
  skipped,
  type AssessmentReview,
  type PillarReview,
  type ReviewAnswer,
} from './review.js';
import { PostgresReviewStore } from './postgres-store.js';
import { InMemoryReviewStore, type ReviewStore } from './store.js';

const NOW = new Date('2026-08-13T09:00:00.000Z');
const LATER = new Date('2026-08-13T10:00:00.000Z');
const LAST = new Date('2026-08-13T11:00:00.000Z');
const PILLARS = ['security-compliance-and-privacy', 'reliability'] as const;

function review(over: Partial<AssessmentReview> = {}): AssessmentReview {
  return opened({
    id: 'rev-1',
    runId: 'scan-1',
    openedBy: 'priya@example.com',
    openedAt: NOW,
    definitionId: 'def-a',
    ...over,
  });
}

function confirm(pillarId: string, over: Partial<PillarReview> = {}): PillarReview {
  return confirmed(
    {
      id: `p-${pillarId}`,
      reviewId: 'rev-1',
      runId: 'scan-1',
      pillarId,
      by: 'priya@example.com',
      at: NOW,
      attestationIds: ['att-1'],
      ...over,
    },
    PILLARS
  );
}

function skip(pillarId: string, over: Partial<PillarReview> = {}): PillarReview {
  return skipped(
    {
      id: `p-${pillarId}`,
      reviewId: 'rev-1',
      runId: 'scan-1',
      pillarId,
      by: 'ana@example.com',
      at: LATER,
      ...over,
    },
    PILLARS
  );
}

function answer(pillarId: string, over: Partial<ReviewAnswer> = {}): ReviewAnswer {
  return answered(
    {
      id: `a-${pillarId}`,
      reviewId: 'rev-1',
      runId: 'scan-1',
      pillarId,
      controlId: 'CO-01-01',
      attestationId: 'att-new',
      by: 'ana@example.com',
      at: LATER,
      ...over,
    },
    PILLARS
  );
}

const UNIQUE = {
  assessment_reviews: ['run_id'],
  pillar_reviews: [['review_id', 'pillar_id'] as const],
  review_answers: ['attestation_id'],
  assessment_results: ['review_id'],
};

function postgres(): { store: ReviewStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({ unique: UNIQUE });
  const errors: string[] = [];
  let minted = 0;
  const store = new PostgresReviewStore({
    db,
    pillars: PILLARS,
    onError: (operation) => errors.push(operation),
    newId: () => `res-${String((minted += 1))}`,
  });
  return { store, db, errors };
}

const implementations: readonly [string, () => ReviewStore][] = [
  ['in memory', (): ReviewStore => new InMemoryReviewStore({ pillars: PILLARS })],
  ['in postgres', (): ReviewStore => postgres().store],
];

describe.each(implementations)('keeping reviews %s', (_name, open) => {
  it('reads back a review that was opened', async () => {
    const store = open();
    await store.open(review());

    const got = await store.get('rev-1', 'def-a');
    expect(got?.review).toMatchObject({ id: 'rev-1', runId: 'scan-1', openedBy: 'priya@example.com' });
    expect(got?.review.openedAt).toEqual(NOW);
    expect(got?.pillars).toEqual([]);
    expect(got?.answers).toEqual([]);
    expect(got?.result).toBeUndefined();
  });

  it('keeps an answer this review produced, beside the pillar records rather than among them', async () => {
    const store = open();
    await store.open(review());
    await store.answer(answer('reliability'));

    const got = await store.get('rev-1', 'def-a');
    expect(got?.answers).toMatchObject([{ pillarId: 'reliability', controlId: 'CO-01-01', attestationId: 'att-new' }]);
    // Not a pillar record, which is the whole reason it is its own table: `complete` asks whether
    // every pillar has one, so an answer counted there would finalise a review nobody had decided.
    expect(got?.pillars).toEqual([]);
    expect(got?.result).toBeUndefined();
  });

  it('takes many answers for one pillar, which a pillar record cannot', async () => {
    const store = open();
    await store.open(review());
    await store.answer(answer('reliability', { id: 'a-1', attestationId: 'att-1' }));
    await store.answer(answer('reliability', { id: 'a-2', attestationId: 'att-2' }));

    expect((await store.get('rev-1', 'def-a'))?.answers).toHaveLength(2);
  });

  it('refuses an answer to a pillar this review has already recorded', async () => {
    // A reviewer who confirms a pillar and then answers a requirement in it has not refreshed this
    // review's answer for it — the confirm is already written and cited what the run held.
    const store = open();
    await store.open(review());
    await store.record(confirm('reliability'));

    await expect(store.answer(answer('reliability'))).rejects.toThrow(InvalidReviewError);
    expect((await store.get('rev-1', 'def-a'))?.answers).toEqual([]);
  });

  it('refuses an answer once the review has a result, so a finalised count cannot move', async () => {
    const store = open();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    await store.record(confirm('reliability'));

    await expect(store.answer(answer('reliability'))).rejects.toThrow(InvalidReviewError);
  });

  it('refuses an answer against a review that does not exist', async () => {
    const store = open();

    await expect(store.answer(answer('reliability'))).rejects.toThrow(InvalidReviewError);
  });

  it('lands the same row when one attestation is recorded twice, rather than counting it twice', async () => {
    // The only way the same attestation arrives twice is a retry of a request whose answer was
    // lost. Two rows would read as two answers on every surface that counts them.
    const store = open();
    await store.open(review());
    await store.answer(answer('reliability', { id: 'a-1' }));
    await store.answer(answer('reliability', { id: 'a-2' }));

    expect((await store.get('rev-1', 'def-a'))?.answers).toHaveLength(1);
  });

  it('returns the existing review when the same scan is opened twice, rather than refusing', async () => {
    const store = open();
    await store.open(review());
    const again = await store.open(review({ id: 'rev-other', openedBy: 'someone-else@example.com' }));

    expect(again.id).toBe('rev-1');
    expect(again.openedBy).toBe('priya@example.com');
    expect(await store.forRun('scan-1', 'def-a')).toMatchObject({ review: { id: 'rev-1' } });
  });

  it('records a skip as a row with actor, time, run and pillar', async () => {
    const store = open();
    await store.open(review());
    await store.record(skip('reliability'));

    const got = await store.get('rev-1', 'def-a');
    expect(got?.pillars).toHaveLength(1);
    expect(got?.pillars[0]).toMatchObject({
      kind: 'skipped',
      pillarId: 'reliability',
      runId: 'scan-1',
      by: 'ana@example.com',
    });
    expect(got?.pillars[0]?.at).toEqual(LATER);
    expect(got?.result).toBeUndefined();
  });

  it('writes a result when the last pillar is recorded, and not before', async () => {
    const store = open();
    await store.open(review());
    const first = await store.record(confirm('security-compliance-and-privacy'));
    expect(first.result).toBeUndefined();
    expect(await store.current('def-a')).toBeUndefined();

    const last = await store.record(skip('reliability'));
    expect(last.result).toMatchObject({
      reviewId: 'rev-1',
      runId: 'scan-1',
      finalisedBy: 'ana@example.com',
      definitionId: 'def-a',
    });
    expect(last.result?.pillars.map((one) => one.kind)).toEqual(['confirmed', 'skipped']);
    expect(last.result?.attestationIds).toEqual(['att-1']);
    expect(await store.current('def-a')).toMatchObject({ id: last.result?.id });
  });

  it('uses the immutable selected set for completion and refuses an excluded pillar', async () => {
    const store = open();
    await store.open(review({ selectedPillars: ['reliability'] }));

    await expect(store.record(confirm('security-compliance-and-privacy'))).rejects.toThrow(/not selected/);
    const only = await store.record(skip('reliability'));

    expect(only.result).toMatchObject({
      selectedPillars: ['reliability'],
      pillars: [expect.objectContaining({ pillarId: 'reliability' })],
    });
    expect((await store.get('rev-1', 'def-a'))?.pillars).toHaveLength(1);
  });

  it('does not discard an open review or a previous result when a later scan is reviewed', async () => {
    const store = open();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    await store.record(skip('reliability'));
    const first = await store.current('def-a');

    await store.open(review({ id: 'rev-2', runId: 'scan-2', openedAt: LATER }));
    expect(await store.get('rev-1', 'def-a')).toMatchObject({ review: { id: 'rev-1' }, result: { id: first?.id } });
    expect(await store.get('rev-2', 'def-a')).toMatchObject({ review: { id: 'rev-2' } });
    expect((await store.get('rev-2', 'def-a'))?.result).toBeUndefined();
    expect(await store.current('def-a')).toMatchObject({ id: first?.id, runId: 'scan-1' });
    expect((await store.openReviews('def-a')).map((one) => one.review.id)).toEqual(['rev-2']);
  });

  it('keeps the earlier result current until the later review is finalised', async () => {
    const store = open();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    await store.record(skip('reliability'));
    const first = await store.current('def-a');

    await store.open(review({ id: 'rev-2', runId: 'scan-2', openedAt: LATER }));
    await store.record(skip('security-compliance-and-privacy', { id: 'p2-sc', reviewId: 'rev-2', runId: 'scan-2' }));
    expect(await store.current('def-a')).toMatchObject({ id: first?.id });

    await store.record(
      confirm('reliability', {
        id: 'p2-rel',
        reviewId: 'rev-2',
        runId: 'scan-2',
        at: LAST,
        attestationIds: ['att-2'],
      })
    );
    expect(await store.current('def-a')).toMatchObject({ runId: 'scan-2', attestationIds: ['att-2'] });
  });

  it("does not return one assessment's review or result from another", async () => {
    const store = open();
    await store.open(review());
    await store.open(review({ id: 'rev-b', runId: 'scan-b', definitionId: 'def-b' }));
    await store.record(confirm('security-compliance-and-privacy'));
    await store.record(skip('reliability'));

    expect((await store.get('rev-1', 'def-a'))?.review.id).toBe('rev-1');
    expect(await store.get('rev-1', 'def-b')).toBeUndefined();
    expect(await store.get('rev-b', 'def-a')).toBeUndefined();
    expect(await store.forRun('scan-1', 'def-b')).toBeUndefined();
    expect((await store.current('def-a'))?.runId).toBe('scan-1');
    expect(await store.current('def-b')).toBeUndefined();
    expect(await store.current(null)).toBeUndefined();
    expect((await store.openReviews('def-b')).map((one) => one.review.id)).toEqual(['rev-b']);
    expect(await store.openReviews('def-a')).toEqual([]);
  });

  it('refuses a second record for a pillar that already has one', async () => {
    const store = open();
    await store.open(review());
    await store.record(skip('reliability'));
    await expect(store.record(confirm('reliability'))).rejects.toThrow(InvalidReviewError);
  });

  it('refuses a pillar record against a review that already has a result', async () => {
    const store = open();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    await store.record(skip('reliability'));
    await expect(store.record(skip('reliability', { id: 'again' }))).rejects.toThrow(/already has a result/);
  });
});

describe('a durable store finishing a review the last write left incomplete', () => {
  it('mints a result id without an injected newId, which is how production constructs the store', async () => {
    const db = new FakePostgres({ unique: UNIQUE });
    const store = new PostgresReviewStore({ db, pillars: PILLARS });
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    const last = await store.record(skip('reliability'));

    expect(last.result?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    expect(await store.current('def-a')).toMatchObject({ id: last.result?.id });
  });

  it('writes the result when a last pillar is retried after the pillar row landed and the result did not', async () => {
    const { store, db } = postgres();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    const last = skip('reliability');
    db.seed('pillar_reviews', {
      id: last.id,
      review_id: last.reviewId,
      pillar_id: last.pillarId,
      recorded_at: last.at,
      body: last,
      digest: 'sha256:whatever',
    });

    const recovered = await store.record(skip('reliability', { id: 'again', by: 'other@example.com', at: LAST }));
    expect(recovered.result).toMatchObject({
      reviewId: 'rev-1',
      runId: 'scan-1',
      finalisedBy: 'ana@example.com',
      finalisedAt: LATER,
    });
    expect(await store.current('def-a')).toMatchObject({ id: recovered.result?.id });
    expect((await store.openReviews('def-a')).map((one) => one.review.id)).toEqual([]);
  });
});

describe('what each implementation says about itself', () => {
  it('is honest about durability, because the UI warns on the answer', () => {
    expect(new InMemoryReviewStore({ pillars: PILLARS }).durable).toBe(false);
    expect(postgres().store.durable).toBe(true);
  });
});

describe('a durable store reading rows it cannot use', () => {
  it('reads legacy and Version 2 bodies side by side, reviving dates inside the new frozen outcome', async () => {
    const { store, db } = postgres();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    const written = await store.record(skip('reliability'));
    const legacy = written.result;
    expect(legacy).toBeDefined();

    const finding = {
      controlId: 'SC-01-01',
      pillarId: 'security-compliance-and-privacy',
      principleId: 'security-1',
      title: 'Identity is reviewed',
      outcome: 'pass',
      severity: 'high',
      coverage: { mode: 'complete' },
      evidence: [
        {
          signal: 'rest:workspace:current-user',
          observed: 'Identity was readable.',
          coverage: { mode: 'complete' },
          collectedAt: NOW.toISOString(),
        },
      ],
    };
    db.seed('assessment_results', {
      id: 'res-v2',
      review_id: 'review-v2',
      finalised_at: LATER,
      definition_id: 'def-a',
      body: {
        ...legacy,
        id: 'res-v2',
        reviewId: 'review-v2',
        schemaVersion: 2,
        finalAssessment: {
          outcome: {
            findings: [
              {
                id: 'finding-1',
                finding,
                evidenceIds: ['evidence-1'],
                confidence: { standing: 'established', because: 'Complete.', limitations: [] },
              },
            ],
          },
        },
      },
      digest: 'sha256:whatever',
    });

    expect((await store.result(legacy?.id ?? '', 'def-a'))?.schemaVersion).toBeUndefined();
    const v2 = await store.result('res-v2', 'def-a');
    expect(v2?.schemaVersion).toBe(2);
    const frozen = (
      v2?.finalAssessment as { outcome: { findings: { finding: { evidence: { collectedAt: Date }[] } }[] } }
    ).outcome.findings[0]?.finding;
    expect(frozen?.evidence[0]?.collectedAt).toBeInstanceOf(Date);
  });

  it('drops one malformed Version 2 outcome without dropping its readable legacy neighbour', async () => {
    const { store, db, errors } = postgres();
    await store.open(review());
    await store.record(confirm('security-compliance-and-privacy'));
    const legacy = (await store.record(skip('reliability'))).result;
    db.seed('assessment_results', {
      id: 'res-malformed-v2',
      review_id: 'review-malformed-v2',
      finalised_at: LATER,
      definition_id: 'def-a',
      body: {
        ...legacy,
        id: 'res-malformed-v2',
        reviewId: 'review-malformed-v2',
        schemaVersion: 2,
        finalAssessment: { outcome: { findings: [{ finding: null }] } },
      },
      digest: 'sha256:whatever',
    });

    expect(await store.result('res-malformed-v2', 'def-a')).toBeUndefined();
    expect(errors).toContain('read result res-malformed-v2');
    expect((await store.current('def-a'))?.id).toBe(legacy?.id);
  });

  it('reports and drops a review whose date will not parse, rather than dating it now', async () => {
    const { store, db, errors } = postgres();
    await store.open(review());
    db.seed('assessment_reviews', {
      id: 'broken',
      run_id: 'scan-x',
      opened_at: NOW,
      body: { ...review({ id: 'broken', runId: 'scan-x' }), openedAt: 'the third of never' },
      digest: 'sha256:whatever',
      definition_id: 'def-a',
    });

    expect(await store.get('broken', 'def-a')).toBeUndefined();
    expect(errors).toEqual(['read review broken']);
  });

  it('reads nothing and says why when the query fails', async () => {
    const { store, db, errors } = postgres();
    await db.end();

    expect(await store.get('rev-1', 'def-a')).toBeUndefined();
    expect(await store.current('def-a')).toBeUndefined();
    expect(await store.openReviews('def-a')).toEqual([]);
    expect(errors.length).toBeGreaterThan(0);
  });
});
