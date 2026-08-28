// Durable reviews, in the Lakebase schema the app owns.
//
// Three tables, insert-only. There is no update statement in this file and there is no delete, so
// a scheduled run cannot discard an open review or a previous result by reaching the table — only
// by going through the domain, which also has no such operation.
//
// Indexed copies sit beside the body the way notes do: `run_id` on a review, `review_id` and
// `pillar_id` on a pillar record, `review_id` on a result. The body is still the writer of record.

import { digestOf } from '../records/digest.js';
import type { Postgres, Sql } from '../store/postgres.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';
import { decodeScan } from '../scan/codec.js';
import type { Attestation } from '../attest/attestation.js';
import { reviveStoredAttestation } from '../attest/postgres-store.js';
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
import type { ReviewRecord, ReviewStore } from './store.js';
import { reviveFinalAssessment } from './final-assessment.js';
import type { FinalAssessmentProjector } from './projection.js';

const UNIQUE_VIOLATION = '23505';

export interface PostgresReviewStoreOptions {
  readonly db: Postgres;
  readonly pillars: readonly string[];
  readonly onError?: (operation: string, error: unknown) => void;
  readonly newId?: () => string;
  /** Version 2 projection. When present, the completing write requires one database transaction. */
  readonly projector?: FinalAssessmentProjector;
}

export class PostgresReviewStore implements ReviewStore {
  readonly durable = true;

  constructor(private readonly options: PostgresReviewStoreOptions) {}

  async open(review: AssessmentReview): Promise<AssessmentReview> {
    selectedPillarsOf(review, this.options.pillars);
    const { db } = this.options;
    await db.query(
      `insert into ${db.schema}.assessment_reviews
         (id, run_id, opened_at, body, digest, definition_id, definition_version, definition_fingerprint)
         values ($1, $2, $3, $4::jsonb, $5, $6, $7, $8)
       on conflict (run_id) do nothing`,
      [
        review.id,
        review.runId,
        review.openedAt,
        JSON.stringify(review),
        digestOf(review),
        review.definitionId ?? null,
        review.definitionVersion ?? null,
        review.definitionFingerprint ?? null,
      ]
    );
    const existing = await this.forRun(review.runId);
    if (existing == null) {
      throw new InvalidReviewError('The review was written and then could not be read back.');
    }
    return existing.review;
  }

  async record(
    pillar: PillarReview
  ): Promise<{ readonly review: AssessmentReview; readonly result?: AssessmentResult }> {
    if (this.options.projector != null) return this.recordProjected(pillar);

    const assembled = await this.get(pillar.reviewId);
    if (assembled == null) {
      throw new InvalidReviewError('There is no review with that id, so there is nowhere to record a pillar against.');
    }
    if (assembled.result != null) {
      throw new InvalidReviewError(
        'This review already has a result, so another pillar record would not be part of it.'
      );
    }
    assertReviewAccepts(assembled.review, pillar.pillarId, this.options.pillars);

    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.pillar_reviews (id, review_id, pillar_id, recorded_at, body, digest)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [pillar.id, pillar.reviewId, pillar.pillarId, pillar.at, JSON.stringify(pillar), digestOf(pillar)]
      );
    } catch (error) {
      if (isDuplicate(error)) {
        // The pillar row can land and the result insert still throw. Retrying the last skip then
        // refuses as a duplicate, and `current()` has nothing to read — a complete review that
        // cannot finish. If every pillar is already recorded and there is no result, write one.
        return this.finaliseIfComplete(assembled.review, pillar, { duplicate: true });
      }
      throw error;
    }

    // Re-read after the insert, not `[...assembled.pillars, pillar]`. Two last-pillar writes
    // arriving together would each have loaded an incomplete snapshot, both inserts would
    // succeed, and neither would write the result — a review with every pillar recorded and
    // nothing `current()` can see. The result insert is `on conflict do nothing`, so if both
    // re-reads see a complete set, one result lands and the other is the same row.
    return this.finaliseIfComplete(assembled.review, pillar);
  }

  /**
   * Complete a Version 2 result while holding the review row lock.
   *
   * The lock serialises requests that can both believe they carry the last pillar. The transaction
   * then makes the terminal pillar, immutable source reads and result insert one commit point: a
   * missing, expired or digest-mismatched source rolls the pillar back as well.
   */
  private async recordProjected(
    pillar: PillarReview
  ): Promise<{ readonly review: AssessmentReview; readonly result?: AssessmentResult }> {
    const { db, projector } = this.options;
    const session = db.session?.bind(db);
    if (session == null || projector == null) {
      throw new InvalidReviewError(
        'Final assessment projection requires a database transaction, and this database binding does not provide one.'
      );
    }

    return session(async (sql) => {
      const { rows: reviewRows } = await sql.query<{ body: unknown }>(
        `select body from ${db.schema}.assessment_reviews where id = $1 for update`,
        [pillar.reviewId]
      );
      const review = reviveReview(reviewRows[0]?.body);
      if (review == null) {
        throw new InvalidReviewError(
          'There is no review with that id, so there is nowhere to record a pillar against.'
        );
      }
      const selected = assertReviewAccepts(review, pillar.pillarId, this.options.pillars);

      // A retry after commit returns the one stored result. It must not mint a second identity or
      // re-run projection against sources that may now be older.
      const existing = await this.resultOfReviewUsing(sql, review.id);
      if (existing != null) return { review, result: existing };

      const recorded = await this.pillarsOfUsing(sql, review.id);
      if (recorded.some((one) => one.pillarId === pillar.pillarId)) {
        throw new InvalidReviewError(
          `This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`
        );
      }

      await sql.query(
        `insert into ${db.schema}.pillar_reviews (id, review_id, pillar_id, recorded_at, body, digest)
           values ($1, $2, $3, $4, $5::jsonb, $6)`,
        [pillar.id, pillar.reviewId, pillar.pillarId, pillar.at, JSON.stringify(pillar), digestOf(pillar)]
      );
      const next = await this.pillarsOfUsing(sql, review.id);
      if (!complete(selected, next)) return { review };

      const completing = next.reduce((latest, one) => (one.at.getTime() > latest.at.getTime() ? one : latest));
      const base = finalised(
        {
          id: (this.options.newId ?? (() => crypto.randomUUID()))(),
          review,
          pillars: next,
          finalisedBy: completing.by,
          finalisedAt: completing.at,
        },
        selected
      );

      const { rows: scanRows } = await sql.query<{ id: string; body: unknown; digest: string }>(
        `select id, body, digest from ${db.schema}.scans where id = $1`,
        [review.runId]
      );
      const storedScan = scanRows[0];
      if (storedScan == null) {
        throw new InvalidReviewError('The run this review is of could not be read for finalisation.');
      }
      if (digestOf(storedScan.body) !== storedScan.digest) {
        throw new InvalidReviewError('The stored run body no longer matches its recorded digest.');
      }
      const scan = decodeScan(storedScan.id, JSON.stringify(storedScan.body));

      const answers = await this.answersOfUsing(sql, review.id);
      const attestations = await this.attestationsUsing(sql, base.attestationIds);
      const result = projector({
        result: base,
        scan,
        runDigest: storedScan.digest,
        answers,
        attestations,
      });
      const contract = result.finalAssessment;

      await sql.query(
        `insert into ${db.schema}.assessment_results
           (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version,
            definition_fingerprint, schema_version, public_methodology_version, catalogue_revision, eligible)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)
         on conflict (review_id) do nothing`,
        [
          result.id,
          result.reviewId,
          result.runId,
          result.finalisedAt,
          JSON.stringify(result),
          digestOf(result),
          result.definitionId ?? null,
          result.definitionVersion ?? null,
          result.definitionFingerprint ?? null,
          result.schemaVersion,
          contract.versions.methodology.publicVersion,
          contract.versions.catalogue.revision,
          contract.publication.eligible,
        ]
      );
      const stored = await this.resultOfReviewUsing(sql, review.id);
      if (stored == null)
        throw new InvalidReviewError('The final assessment was written and then could not be read back.');
      return { review, result: stored };
    }).catch((error: unknown) => {
      this.options.onError?.(`record projected pillar ${pillar.pillarId} of review ${pillar.reviewId}`, error);
      throw error;
    });
  }

  async answer(one: ReviewAnswer): Promise<void> {
    const assembled = await this.get(one.reviewId);
    if (assembled == null) {
      throw new InvalidReviewError('There is no review with that id, so there is nowhere to record an answer against.');
    }
    if (assembled.result != null) {
      throw new InvalidReviewError(
        'This review already has a result, so an answer recorded now would not be part of it.'
      );
    }
    assertReviewAccepts(assembled.review, one.pillarId, this.options.pillars);
    if (assembled.pillars.some((pillar) => pillar.pillarId === one.pillarId)) {
      throw new InvalidReviewError(
        `This review has already recorded ${one.pillarId}, so an answer to it now is not one this review acted on.`
      );
    }

    const { db } = this.options;
    // `do nothing` rather than a duplicate error, because the unique column is the attestation and
    // the only way the same one arrives twice is a retry of a request whose answer was lost. The
    // row that is already there is the row the caller wanted.
    await db.query(
      `insert into ${db.schema}.review_answers
         (id, review_id, pillar_id, attestation_id, recorded_at, body, digest)
         values ($1, $2, $3, $4, $5, $6::jsonb, $7)
       on conflict (attestation_id) do nothing`,
      [one.id, one.reviewId, one.pillarId, one.attestationId, one.at, JSON.stringify(one), digestOf(one)]
    );
  }

  async get(id: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined> {
    const scoped = applyScope('where id = $1', [id], scope);
    return this.load(`read review ${id}`, scoped.fragment, scoped.values);
  }

  async forRun(runId: string, scope?: AssessmentScope): Promise<ReviewRecord | undefined> {
    const scoped = applyScope('where run_id = $1', [runId], scope);
    return this.load(`read review of scan ${runId}`, scoped.fragment, scoped.values);
  }

  async openReviews(scope?: AssessmentScope): Promise<readonly ReviewRecord[]> {
    const { db } = this.options;
    const operation = 'read open reviews';
    try {
      // Two reads rather than a subquery. The fake cannot JOIN or `NOT IN (SELECT …)`, and the
      // number of reviews an install holds is the number of scans somebody opened a review of —
      // filtering in process is the same cost as the subquery at that size, and both stores
      // answer the same question.
      const scoped = applyScope('order by opened_at asc', [], scope);
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.assessment_reviews ${scoped.fragment}`,
        scoped.values
      );
      const { rows: done } = await db.query<{ review_id: string }>(
        `select review_id from ${db.schema}.assessment_results`
      );
      const finished = new Set(done.map((row) => row.review_id));
      const reviews = this.revivedReviews(
        rows.map((row) => row.body),
        operation
      ).filter((one) => !finished.has(one.id));
      const assembled: ReviewRecord[] = [];
      for (const review of reviews) {
        const pillars = await this.pillarsOf(review.id);
        const answers = await this.answersOf(review.id);
        assembled.push({ review, pillars, answers });
      }
      return assembled;
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  async current(scope?: AssessmentScope): Promise<AssessmentResult | undefined> {
    const scoped = applyScope('order by finalised_at desc', [], scope);
    const rows = await this.readResults('read current result', `${scoped.fragment} limit 1`, scoped.values);
    return rows[0];
  }

  async result(id: string, scope?: AssessmentScope): Promise<AssessmentResult | undefined> {
    const scoped = applyScope('where id = $1', [id], scope);
    const rows = await this.readResults(`read result ${id}`, scoped.fragment, scoped.values);
    return rows[0];
  }

  /**
   * Writes the result when every named pillar has a record.
   *
   * `duplicate` is the recovery for a last-pillar write that stored the pillar and not the result:
   * the retry is refused as a duplicate unless the set is already complete, in which case this
   * writes the missing row rather than leaving a review `openReviews` still lists.
   */
  private async finaliseIfComplete(
    review: AssessmentReview,
    pillar: PillarReview,
    from: { readonly duplicate?: boolean } = {}
  ): Promise<{ readonly review: AssessmentReview; readonly result?: AssessmentResult }> {
    const next = await this.pillarsOf(review.id);
    const selected = assertReviewAccepts(review, pillar.pillarId, this.options.pillars);
    if (!complete(selected, next)) {
      if (from.duplicate === true) {
        throw new InvalidReviewError(
          `This review already has a record for ${pillar.pillarId}. A confirm or a skip is written once.`
        );
      }
      return { review };
    }

    const existing = await this.resultOfReview(review.id);
    if (existing != null) {
      if (from.duplicate === true) {
        throw new InvalidReviewError(
          'This review already has a result, so another pillar record would not be part of it.'
        );
      }
      return { review, result: existing };
    }

    // The completing write is the stored pillar with the latest `at`, not the retry payload. A
    // duplicate recovery's `pillar` is a new id and a new instant; stamping the result from it
    // would disagree with `result.pillars` and name an actor who did not complete the set.
    const completing =
      from.duplicate === true
        ? next.reduce((latest, one) => (one.at.getTime() > latest.at.getTime() ? one : latest))
        : pillar;

    const result = finalised(
      {
        id: (this.options.newId ?? (() => crypto.randomUUID()))(),
        review,
        pillars: next,
        finalisedBy: completing.by,
        finalisedAt: completing.at,
      },
      selected
    );
    const { db } = this.options;
    try {
      await db.query(
        `insert into ${db.schema}.assessment_results
           (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version, definition_fingerprint)
           values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)
         on conflict (review_id) do nothing`,
        [
          result.id,
          result.reviewId,
          result.runId,
          result.finalisedAt,
          JSON.stringify(result),
          digestOf(result),
          result.definitionId ?? null,
          result.definitionVersion ?? null,
          result.definitionFingerprint ?? null,
        ]
      );
    } catch (error) {
      this.options.onError?.('write result', error);
      throw error;
    }
    const stored = await this.resultOfReview(review.id);
    return { review, result: stored ?? result };
  }

  private async resultOfReview(reviewId: string): Promise<AssessmentResult | undefined> {
    try {
      return await this.resultOfReviewUsing(this.options.db, reviewId);
    } catch (error) {
      this.options.onError?.(`read result of review ${reviewId}`, error);
      return undefined;
    }
  }

  private async load(operation: string, where: string, values: readonly unknown[]): Promise<ReviewRecord | undefined> {
    const reviews = await this.readReviews(operation, where, values);
    const review = reviews[0];
    if (review == null) return undefined;
    const pillars = await this.pillarsOf(review.id);
    const answers = await this.answersOf(review.id);
    const result = await this.resultOfReview(review.id);
    return { review, pillars, answers, ...(result != null ? { result } : {}) };
  }

  private async answersOf(reviewId: string): Promise<readonly ReviewAnswer[]> {
    const operation = `read answers recorded in ${reviewId}`;
    try {
      return await this.answersOfUsing(this.options.db, reviewId);
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private async pillarsOf(reviewId: string): Promise<readonly PillarReview[]> {
    const operation = `read pillar records of ${reviewId}`;
    try {
      return await this.pillarsOfUsing(this.options.db, reviewId);
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private async resultOfReviewUsing(sql: Sql, reviewId: string): Promise<AssessmentResult | undefined> {
    const { db } = this.options;
    const { rows } = await sql.query<{ body: unknown }>(
      `select body from ${db.schema}.assessment_results where review_id = $1`,
      [reviewId]
    );
    if (rows[0] == null) return undefined;
    const result = reviveResult(rows[0].body);
    if (result == null) throw new InvalidReviewError('The stored final assessment could not be read.');
    return result;
  }

  private async answersOfUsing(sql: Sql, reviewId: string): Promise<readonly ReviewAnswer[]> {
    const { db } = this.options;
    const { rows } = await sql.query<{ body: unknown }>(
      `select body from ${db.schema}.review_answers where review_id = $1 order by recorded_at asc`,
      [reviewId]
    );
    const answers = rows.map((row) => reviveAnswer(row.body));
    if (answers.some((one) => one == null)) {
      throw new InvalidReviewError('A stored answer record in this review could not be read.');
    }
    return answers as ReviewAnswer[];
  }

  private async pillarsOfUsing(sql: Sql, reviewId: string): Promise<readonly PillarReview[]> {
    const { db } = this.options;
    const { rows } = await sql.query<{ body: unknown }>(
      `select body from ${db.schema}.pillar_reviews where review_id = $1 order by recorded_at asc`,
      [reviewId]
    );
    const pillars = rows.map((row) => revivePillar(row.body));
    if (pillars.some((one) => one == null)) {
      throw new InvalidReviewError('A stored pillar record in this review could not be read.');
    }
    return pillars as PillarReview[];
  }

  private async attestationsUsing(sql: Sql, ids: readonly string[]): Promise<readonly Attestation[]> {
    if (ids.length === 0) return [];
    const { db } = this.options;
    const { rows } = await sql.query<{ id: string; body: unknown; digest: string }>(
      `select id, body, digest from ${db.schema}.attestations where id = any($1::text[])`,
      [ids]
    );
    const byId = new Map<string, Attestation>();
    for (const row of rows) {
      if (digestOf(row.body) !== row.digest) {
        throw new InvalidReviewError(`Attestation ${row.id} no longer matches its recorded digest.`);
      }
      const attestation = reviveStoredAttestation(row.body);
      if (attestation == null || attestation.id !== row.id) {
        throw new InvalidReviewError(`Attestation ${row.id} could not be read exactly by id.`);
      }
      byId.set(row.id, attestation);
    }
    if (byId.size !== ids.length || ids.some((id) => !byId.has(id))) {
      throw new InvalidReviewError('An attestation cited by this review could not be read for finalisation.');
    }
    return ids.map((id) => byId.get(id) as Attestation);
  }

  private async readReviews(operation: string, where: string, values: readonly unknown[]): Promise<AssessmentReview[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.assessment_reviews ${where}`,
        values
      );
      return this.revivedReviews(
        rows.map((row) => row.body),
        operation
      );
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private async readResults(operation: string, where: string, values: readonly unknown[]): Promise<AssessmentResult[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.assessment_results ${where}`,
        values
      );
      return this.revivedResults(
        rows.map((row) => row.body),
        operation
      );
    } catch (error) {
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private revivedReviews(rows: readonly unknown[], operation: string): AssessmentReview[] {
    return this.kept(rows.map(reviveReview), operation, 'review');
  }

  private revivedResults(rows: readonly unknown[], operation: string): AssessmentResult[] {
    return this.kept(rows.map(reviveResult), operation, 'result');
  }

  private kept<T>(rows: readonly (T | undefined)[], operation: string, kind: string): T[] {
    const unreadable = rows.filter((one) => one == null).length;
    if (unreadable > 0) {
      this.options.onError?.(operation, new Error(`${String(unreadable)} stored ${kind} row(s) could not be read`));
    }
    return rows.filter((one): one is T => one != null);
  }
}

function isDuplicate(error: unknown): boolean {
  return typeof error === 'object' && error != null && (error as { code?: unknown }).code === UNIQUE_VIOLATION;
}

function reviveReview(raw: unknown): AssessmentReview | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as AssessmentReview & { openedAt: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.runId !== 'string') return undefined;
  if (typeof candidate.openedBy !== 'string') return undefined;
  if (
    candidate.selectedPillars != null &&
    (!Array.isArray(candidate.selectedPillars) || candidate.selectedPillars.some((one) => typeof one !== 'string'))
  )
    return undefined;
  const openedAt = new Date(candidate.openedAt);
  if (Number.isNaN(openedAt.getTime())) return undefined;
  return { ...candidate, openedAt };
}

function revivePillar(raw: unknown): PillarReview | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as PillarReview & { at: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.reviewId !== 'string') return undefined;
  if (typeof candidate.runId !== 'string' || typeof candidate.pillarId !== 'string') return undefined;
  if (candidate.kind !== 'confirmed' && candidate.kind !== 'skipped') return undefined;
  if (typeof candidate.by !== 'string') return undefined;
  const at = new Date(candidate.at);
  if (Number.isNaN(at.getTime())) return undefined;
  return { ...candidate, at };
}

function reviveAnswer(raw: unknown): ReviewAnswer | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as ReviewAnswer & { at: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.reviewId !== 'string') return undefined;
  if (typeof candidate.runId !== 'string' || typeof candidate.pillarId !== 'string') return undefined;
  if (typeof candidate.controlId !== 'string' || typeof candidate.attestationId !== 'string') return undefined;
  if (typeof candidate.by !== 'string') return undefined;
  const at = new Date(candidate.at);
  if (Number.isNaN(at.getTime())) return undefined;
  return { ...candidate, at };
}

function reviveResult(raw: unknown): AssessmentResult | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as AssessmentResult & { finalisedAt: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.reviewId !== 'string') return undefined;
  if (typeof candidate.runId !== 'string' || typeof candidate.finalisedBy !== 'string') return undefined;
  if (!Array.isArray(candidate.pillars) || !Array.isArray(candidate.attestationIds)) return undefined;
  if (
    candidate.selectedPillars != null &&
    (!Array.isArray(candidate.selectedPillars) || candidate.selectedPillars.some((one) => typeof one !== 'string'))
  )
    return undefined;
  const finalisedAt = new Date(candidate.finalisedAt);
  if (Number.isNaN(finalisedAt.getTime())) return undefined;
  const pillars = candidate.pillars.map(revivePillar);
  if (pillars.some((one) => one == null)) return undefined;
  try {
    return reviveFinalAssessment({ ...candidate, finalisedAt, pillars: pillars as PillarReview[] });
  } catch {
    // Keep the failure local to this row. A malformed Version 2 outcome must be reported as one
    // unreadable result without making a valid legacy/result neighbour disappear from the read.
    return undefined;
  }
}
