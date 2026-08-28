// Where reviews, pillar records and results are kept.
//
// Three tables, insert-only, and the insert-only part is the state machine's guarantee rather than
// an implementation choice: there is no update and no delete, so a scheduled run cannot discard an
// open review or a previous result by overwriting them. `current()` is a read of the latest
// finalised row, not a flag on a scan.
//
// The same two-implementation shape as the other stores. The in-memory one is a fallback the UI
// warns about: a lost review is a judgement somebody made while reading a run they will not open
// again.

import {
  InvalidReviewError,
  assertReviewAccepts,
  complete,
  finalised,
  selectedPillarsOf,
  type AssessmentResult,
  type AssessmentReview,
  type PillarReview,
  type ReviewAnswer,
} from './review.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';
import type { Attestation } from '../attest/attestation.js';
import { digestOf } from '../records/digest.js';
import { encodeScan } from '../scan/codec.js';
import type { Scan } from '../scan/scan.js';
import type { FinalAssessmentProjector } from './projection.js';

export interface ReviewStore {
  /** True when reviews survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /**
   * Opens a review of a scan. A review of a scan already present is returned rather than refused.
   *
   * Returned because the only way the same scan arrives twice is a retry of a request whose answer
   * was lost, or `onFinished` running after a scan that already opened one. Refusing it would turn
   * a delivery problem into an error about a review that exists and is the one the caller wanted.
   */
  open(review: AssessmentReview): Promise<AssessmentReview>;

  /**
   * Records a confirm or a skip. When every named pillar has a record, writes the result too.
   *
   * The result is a consequence of the last pillar write, not a separate act: there is no route
   * that finalises with pillars missing, and no route that finalises twice.
   */
  record(pillar: PillarReview): Promise<{ readonly review: AssessmentReview; readonly result?: AssessmentResult }>;

  /**
   * Records an answer this review produced. Never finalises: an answer is not a decision.
   *
   * Refused once the review has a result, and once the pillar has been decided. Both are the same
   * rule — a record written after the thing it would have informed is a record that changes a count
   * nobody can act on — and the second is the one worth stating, because a reviewer who confirms a
   * pillar and then answers a requirement in it has not refreshed that review's answer for it.
   */
  answer(one: ReviewAnswer): Promise<void>;

  get(id: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined>;

  forRun(runId: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined>;

  /** Reviews that have no result yet, oldest first — the queue 43b will show. */
  openReviews(scope?: AssessmentScope): Promise<readonly ReviewRecord[]>;

  /**
   * The latest finalised result for this assessment, not the latest scan.
   *
   * Latest by `finalisedAt`. A newer scan with an open review does not move this.
   */
  current(scope?: AssessmentScope): Promise<AssessmentResult | undefined>;

  result(id: string, scope?: AssessmentScope): Promise<AssessmentResult | undefined>;
}

/** A review together with the pillar records and the answers written against it so far. */
export interface ReviewRecord {
  readonly review: AssessmentReview;
  readonly pillars: readonly PillarReview[];
  /**
   * Answers this review produced, oldest first.
   *
   * Beside the result rather than inside it, and that is deliberate. A result is a frozen document
   * with a digest over it, and adding a field to one would leave every result written before this
   * row without it — so the count would read as zero for past reviews rather than as unknown. These
   * cannot change after finalisation either: the store refuses an answer to a review that has a
   * result, so reading them alongside is stable in the one way that matters.
   */
  readonly answers: readonly ReviewAnswer[];
  readonly result?: AssessmentResult;
}

export interface InMemoryReviewStoreOptions {
  /** Catalogue pillar ids. A result is written when each of these has a record. */
  readonly pillars: readonly string[];
  /** Present in the served demo so its result has the same contract as the durable writer. */
  readonly projection?: {
    readonly project: FinalAssessmentProjector;
    readonly scan: (id: string) => Promise<Scan | undefined>;
    readonly attestation: (id: string, scope?: AssessmentScope) => Promise<Attestation | undefined>;
  };
}

export class InMemoryReviewStore implements ReviewStore {
  readonly durable = false;

  private readonly reviews = new Map<string, AssessmentReview>();
  private readonly byRun = new Map<string, string>();
  private readonly pillars = new Map<string, PillarReview[]>();
  private readonly answers = new Map<string, ReviewAnswer[]>();
  private readonly results = new Map<string, AssessmentResult>();
  private readonly resultByReview = new Map<string, string>();
  private readonly known: readonly string[];
  private readonly projection: InMemoryReviewStoreOptions['projection'];

  constructor(options: InMemoryReviewStoreOptions) {
    this.known = options.pillars;
    this.projection = options.projection;
  }

  open(review: AssessmentReview): Promise<AssessmentReview> {
    selectedPillarsOf(review, this.known);
    const existingId = this.byRun.get(review.runId);
    if (existingId != null) {
      const existing = this.reviews.get(existingId);
      if (existing != null) return Promise.resolve(existing);
    }
    this.reviews.set(review.id, review);
    this.byRun.set(review.runId, review.id);
    this.pillars.set(review.id, []);
    this.answers.set(review.id, []);
    return Promise.resolve(review);
  }

  answer(one: ReviewAnswer): Promise<void> {
    const refused = this.refusalToAnswer(one);
    if (refused != null) return Promise.reject(new InvalidReviewError(refused));

    // Unique on the attestation, which is the column the table is unique on. Kept rather than
    // appended for the reason the table does it: the only way the same attestation arrives twice is
    // a retry of a request whose answer was lost, and two rows read as two answers everywhere.
    const held = this.answers.get(one.reviewId) ?? [];
    if (held.some((was) => was.attestationId === one.attestationId)) return Promise.resolve();

    this.answers.set(one.reviewId, [...held, one]);
    return Promise.resolve();
  }

  /** The three reasons an answer has nowhere to go, in the order the caller would hit them. */
  private refusalToAnswer(one: ReviewAnswer): string | null {
    const review = this.reviews.get(one.reviewId);
    if (review == null) {
      return 'There is no review with that id, so there is nowhere to record an answer against.';
    }
    if (this.resultByReview.has(review.id)) {
      return 'This review already has a result, so an answer recorded now would not be part of it.';
    }
    try {
      assertReviewAccepts(review, one.pillarId, this.known);
    } catch (cause) {
      return cause instanceof InvalidReviewError ? cause.message : 'This review cannot accept that answer.';
    }
    const decided = (this.pillars.get(review.id) ?? []).some((pillar) => pillar.pillarId === one.pillarId);
    if (decided) {
      return `This review has already recorded ${one.pillarId}, so an answer to it now is not one this review acted on.`;
    }
    return null;
  }

  async record(
    pillar: PillarReview
  ): Promise<{ readonly review: AssessmentReview; readonly result?: AssessmentResult }> {
    const review = this.reviews.get(pillar.reviewId);
    if (review == null) {
      throw new InvalidReviewError('There is no review with that id, so there is nowhere to record a pillar against.');
    }
    if (this.resultByReview.has(review.id)) {
      throw new InvalidReviewError(
        'This review already has a result, so another pillar record would not be part of it.'
      );
    }
    const selected = assertReviewAccepts(review, pillar.pillarId, this.known);

    const recorded = this.pillars.get(review.id) ?? [];
    if (recorded.some((one) => one.pillarId === pillar.pillarId)) {
      throw new InvalidReviewError(
        `This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`
      );
    }

    const next = [...recorded, pillar];
    if (!complete(selected, next)) {
      this.pillars.set(review.id, next);
      return { review };
    }

    const base = finalised(
      {
        id: `result-${review.id}`,
        review,
        pillars: next,
        finalisedBy: pillar.by,
        finalisedAt: pillar.at,
      },
      selected
    );
    let result: AssessmentResult = base;
    const projection = this.projection;
    if (projection != null) {
      const scan = await projection.scan(review.runId);
      if (scan == null) throw new InvalidReviewError('The run this review is of could not be read for finalisation.');
      const attestations = await Promise.all(
        base.attestationIds.map((id) => projection.attestation(id, review.definitionId))
      );
      if (attestations.some((one) => one == null)) {
        throw new InvalidReviewError('An attestation cited by this review could not be read for finalisation.');
      }
      const encoded = JSON.parse(encodeScan(scan)) as unknown;
      result = projection.project({
        result: base,
        scan,
        runDigest: digestOf(encoded),
        answers: this.answers.get(review.id) ?? [],
        attestations: attestations as readonly Attestation[],
      });
    }

    // Commit the terminal pillar and result together. A projection failure above leaves the pillar
    // open, which is the in-memory equivalent of the durable transaction rolling back.
    this.pillars.set(review.id, next);
    this.results.set(result.id, result);
    this.resultByReview.set(review.id, result.id);
    return { review, result };
  }

  get(id: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined> {
    return Promise.resolve(this.assemble(this.reviews.get(id), scope));
  }

  forRun(runId: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined> {
    const id = this.byRun.get(runId);
    if (id == null) return Promise.resolve(undefined);
    return this.get(id, scope);
  }

  openReviews(scope?: AssessmentScope): Promise<readonly ReviewRecord[]> {
    const open: ReviewRecord[] = [];
    for (const review of this.reviews.values()) {
      if (this.resultByReview.has(review.id)) continue;
      const assembled = this.assemble(review, scope);
      if (assembled != null) open.push(assembled);
    }
    open.sort((left, right) => left.review.openedAt.getTime() - right.review.openedAt.getTime());
    return Promise.resolve(open);
  }

  current(scope?: AssessmentScope): Promise<AssessmentResult | undefined> {
    const mine = [...this.results.values()]
      .filter((one) => inScope(one.definitionId, scope))
      .sort((left, right) => right.finalisedAt.getTime() - left.finalisedAt.getTime());
    return Promise.resolve(mine[0]);
  }

  result(id: string, scope?: AssessmentScope): Promise<AssessmentResult | undefined> {
    const one = this.results.get(id);
    if (one == null || !inScope(one.definitionId, scope)) return Promise.resolve(undefined);
    return Promise.resolve(one);
  }

  private assemble(review: AssessmentReview | undefined, scope?: AssessmentScope): ReviewRecord | undefined {
    if (review == null || !inScope(review.definitionId, scope)) return undefined;
    const resultId = this.resultByReview.get(review.id);
    return {
      review,
      pillars: this.pillars.get(review.id) ?? [],
      answers: this.answers.get(review.id) ?? [],
      ...(resultId != null ? { result: this.results.get(resultId) } : {}),
    };
  }
}
