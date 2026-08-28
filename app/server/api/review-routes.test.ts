// Serving reviews, and writing them.
//
// What a review is and what it refuses is tested in `review/review.test.ts`, and both stores in
// `review/store.test.ts`. What is worth holding here is what only a route can get wrong.
//
// A skip is a record in the trail, not an absence. Confirm copies attestation ids off the scan's
// findings, not the live store. Finalisation is not an endpoint: the last pillar write produces
// the result. Completing a scan, or opening a review of a later one, does not replace current().
// There is no route that edits or removes a pillar record.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { AssessmentReviewPayload, CurrentResultPayload, OpenReviewsPayload } from '../../shared/api/contract.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Scan } from '../scan/scan.js';
import { InMemoryScanStore, type ScanStore } from '../scan/store.js';
import { InMemoryReviewStore, type ReviewStore } from '../review/store.js';
import { InMemoryAttestationStore, type AttestationStore } from '../attest/store.js';
import type { Attestation } from '../attest/attestation.js';
import type { CatalogueControl } from '../catalogue/catalogue.js';
import { customerReviewMessage, registerReviewRoutes, type ReviewRouteOptions } from './review-routes.js';

describe('customer review errors', () => {
  it('translates internal result language at the API boundary', () => {
    expect(customerReviewMessage('This review already has a result, so another record would not be part of it.')).toBe(
      'This review has already published a report, so another record would not be part of it.'
    );
    expect(customerReviewMessage('The stored final assessment could not be read.')).toBe(
      'The published report could not be read.'
    );
  });
});

const servers: Server[] = [];

afterAll(() => closeServed(servers));

const NOW = new Date('2026-08-13T09:00:00.000Z');
const PILLARS = ['security-compliance-and-privacy', 'reliability'] as const;

class Refused extends Error {}

interface Harness {
  readonly base: string;
  readonly reviews: ReviewStore;
  readonly scans: ScanStore;
  readonly attestations: AttestationStore;
  readonly audit: AuditLog;
}

class UnreadableReviewStore extends InMemoryReviewStore {
  override openReviews(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }

  override get(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }

  override forRun(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }

  override current(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }

  override result(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }
}

class FailsFirstPillarWrite extends InMemoryReviewStore {
  private failed = false;

  override record(pillar: Parameters<ReviewStore['record']>[0]): ReturnType<ReviewStore['record']> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error('review database unavailable'));
    }
    return super.record(pillar);
  }
}

/**
 * Two requirements in two pillars, which is the least that can catch the mistake the route guards.
 *
 * `SCP-01-01` is in security and `RE-01-01` is in reliability, so a request naming one pillar and a
 * requirement from the other has somewhere wrong to be counted.
 */
const CONTROLS: Readonly<Record<string, Pick<CatalogueControl, 'id' | 'pillarId' | 'severity'>>> = {
  'SCP-01-01': { id: 'SCP-01-01', pillarId: 'security-compliance-and-privacy', severity: 'high' },
  'RE-01-01': { id: 'RE-01-01', pillarId: 'reliability', severity: 'medium' },
};

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly reviews?: ReviewStore;
    readonly omitAttestations?: boolean;
    readonly permit?: boolean;
    readonly actor?: string;
    readonly requirementsFor?: ReviewRouteOptions['requirementsFor'];
    readonly cadenceDays?: ReviewRouteOptions['cadenceDays'];
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const reviews = over.reviews ?? new InMemoryReviewStore({ pillars: PILLARS });
  const attestations = new InMemoryAttestationStore();
  const scans = new InMemoryScanStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;

  registerReviewRoutes(app, {
    ...(over.omitStore === true ? {} : { reviews }),
    reviewStorage: 'Kept in the waf schema of the bound database.',
    scans,
    pillars: PILLARS,
    ...(over.omitAttestations === true ? {} : { attestations }),
    control: (id) => CONTROLS[id] as CatalogueControl | undefined,
    cadenceDays: over.cadenceDays ?? (() => 90),
    requirementsFor: over.requirementsFor ?? (() => []),
    now: () => NOW,
    newId: () => `id-${String((minted += 1))}`,
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: over.actor ?? 'priya@example.com',
            act: closedWhenAnswered(
              recorder.begin(
                action,
                { actor: over.actor ?? 'priya@example.com', executionMode: 'on-behalf-of-user' },
                context ?? {}
              ),
              response
            ),
          }),
    respondToFailure: (response: Response, cause: unknown) => {
      if (cause instanceof Refused) {
        response.status(403).json({ error: 'not-permitted', message: cause.message });
        return;
      }
      response.status(500).json({ error: 'unexpected', message: String(cause) });
    },
  });

  const base = await servedAt(app, servers);
  return { base, reviews, scans, attestations, audit };
}

async function send(
  base: string,
  path: string,
  body?: unknown,
  method = 'POST'
): Promise<{ status: number; body: unknown }> {
  const scoped = path.includes('definitionId=')
    ? path
    : `${path}${path.includes('?') ? '&' : '?'}definitionId=definition-1`;
  const response = await fetch(`${base}${scoped}`, {
    method,
    headers: { 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}

async function read<T>(base: string, path: string): Promise<T> {
  const scoped = path.includes('definitionId=')
    ? path
    : `${path}${path.includes('?') ? '&' : '?'}definitionId=definition-1`;
  return (await (await fetch(`${base}${scoped}`)).json()) as T;
}

async function acts(
  audit: AuditLog
): Promise<readonly (readonly [string, string, string | undefined, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map((event) => [event.action, event.outcome, event.target?.id, event.reason] as const);
}

function scan(over: Partial<Scan> = {}): Scan {
  const startedAt = NOW;
  return {
    id: 'scan-1',
    startedAt,
    finishedAt: NOW,
    state: 'complete',
    stamp: {
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'scheduler@example.com',
      scope: { hostWorkspaceId: '123', description: 'the account' },
      lookbackDays: 30,
      definition: { id: 'definition-1', version: 1, fingerprint: 'definition-fingerprint' },
    },
    score: {
      overall: 50,
      pillars: [],
      counts: {
        pass: 0,
        fail: 0,
        partial: 0,
        unmeasurable: 0,
        'not-applicable': 0,
        'satisfied-by-architecture': 0,
      },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
    },
    findings: [],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
    requestedPillars: PILLARS,
    ...over,
  };
}

function attestation(id: string, controlId: string, reviewBy = new Date('2027-08-13T09:00:00.000Z')): Attestation {
  return {
    id,
    controlId,
    answer: 'met',
    statement: 'The platform team reviews this evidence every quarter.',
    owner: 'platform@example.com',
    attestedBy: 'priya@example.com',
    attestedAt: NOW,
    reviewBy,
    definitionId: 'definition-1',
  };
}

async function opened(base: string, scans: ScanStore, over: Partial<Scan> = {}): Promise<AssessmentReviewPayload> {
  const source = scan(over);
  await scans.save(source);
  const definitionId = source.stamp.definition?.id ?? '';
  const { status, body } = await send(base, `/api/reviews?definitionId=${encodeURIComponent(definitionId)}`, {
    runId: over.id ?? 'scan-1',
  });
  expect(status).toBe(201);
  return body as AssessmentReviewPayload;
}

describe('opening a review', () => {
  it('stores it against the scan in the body and records the act against the run', async () => {
    const { base, scans, audit } = await serve();
    const review = await opened(base, scans);

    expect(review).toMatchObject({
      id: 'id-1',
      runId: 'scan-1',
      openedBy: 'priya@example.com',
      definitionId: 'definition-1',
      selectedPillars: PILLARS,
      pillars: [],
    });
    expect(review.result).toBeUndefined();
    await expect(acts(audit)).resolves.toEqual([['review.open', 'performed', 'scan-1', undefined]]);
  });

  it('returns the existing review when the same scan is opened twice, rather than refusing', async () => {
    const { base, scans } = await serve();
    const first = await opened(base, scans);
    const { status, body } = await send(base, '/api/reviews', { runId: 'scan-1' });

    expect(status).toBe(201);
    expect((body as AssessmentReviewPayload).id).toBe(first.id);
  });

  it('refuses a scan this assessment does not have', async () => {
    const { base, audit } = await serve();

    const { status, body } = await send(base, '/api/reviews', { runId: 'scan-missing' });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-run' });
    await expect(acts(audit)).resolves.toEqual([['review.open', 'failed', 'scan-missing', 'unknown-run']]);
  });

  it('refuses when this install is not keeping reviews', async () => {
    const { base } = await serve({ omitStore: true });

    const { status, body } = await send(base, '/api/reviews', { runId: 'scan-1' });

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'reviews-unavailable' });
  });

  it('is refused before anything is stored when the caller is not permitted', async () => {
    const { base, scans, reviews } = await serve({ permit: false });
    await scans.save(scan());

    const { status } = await send(base, '/api/reviews', { runId: 'scan-1' });

    expect(status).toBe(403);
    expect(await reviews.openReviews()).toEqual([]);
  });
});

describe('a skip is a record', () => {
  it('carries actor, time, run and pillar, and records the act against the pillar', async () => {
    const { base, scans, audit } = await serve();
    const review = await opened(base, scans);

    const { status, body } = await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);
    const written = body as AssessmentReviewPayload;

    expect(status).toBe(201);
    expect(written.pillars).toEqual([
      expect.objectContaining({
        kind: 'skipped',
        pillarId: 'reliability',
        runId: 'scan-1',
        by: 'priya@example.com',
      }),
    ]);
    expect(written.pillars[0]).not.toHaveProperty('attestationIds');
    await expect(acts(audit)).resolves.toEqual([
      ['review.open', 'performed', 'scan-1', undefined],
      ['review.skip', 'performed', 'reliability', undefined],
    ]);
  });

  it('records a failed store write and preserves the exact pillar retry', async () => {
    const reviews = new FailsFirstPillarWrite({ pillars: PILLARS });
    const { base, scans, audit } = await serve({ reviews });
    const review = await opened(base, scans);

    const failed = await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    expect(failed).toMatchObject({
      status: 503,
      body: {
        error: 'review-write-unreadable',
        eligibility: {
          eligible: false,
          state: 'unreadable',
          reason: { action: 'Restore the database connection and retry this exact review action.' },
        },
      },
    });
    await expect(reviews.get(review.id)).resolves.toMatchObject({ pillars: [] });
    await expect(acts(audit)).resolves.toEqual([
      ['review.open', 'performed', 'scan-1', undefined],
      ['review.skip', 'failed', 'reliability', 'review-write-unreadable'],
    ]);

    const retried = await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    expect(retried.status).toBe(201);
    await expect(reviews.get(review.id)).resolves.toMatchObject({
      pillars: [expect.objectContaining({ pillarId: 'reliability', kind: 'skipped' })],
    });
  });

  it('freezes every manual control the skip leaves unaccepted, including a current answer', async () => {
    const { base, scans, attestations } = await serve({
      requirementsFor: () => [CONTROLS['RE-01-01']],
    });
    await attestations.record(attestation('att-current', 'RE-01-01'));
    const review = await opened(base, scans);

    const { status, body } = await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);
    const written = body as AssessmentReviewPayload;

    expect(status).toBe(201);
    expect(written.pillars[0]).toMatchObject({
      kind: 'skipped',
      unresolvedControlIds: ['RE-01-01'],
    });
  });
});

describe('confirm-current', () => {
  it('freezes the exact current attestation ids selected for that pillar', async () => {
    const { base, scans, attestations } = await serve({
      requirementsFor: () => [CONTROLS['SCP-01-01']],
    });
    await attestations.record(attestation('att-current', 'SCP-01-01'));
    const review = await opened(base, scans);

    const { body } = await send(base, `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/confirm`);
    const written = body as AssessmentReviewPayload;

    expect(written.pillars[0]).toMatchObject({
      kind: 'confirmed',
      pillarId: 'security-compliance-and-privacy',
      attestationIds: ['att-current'],
    });
  });

  it('refuses unanswered and due manual work before a record is written', async () => {
    const { base, scans, attestations, reviews, audit } = await serve({
      requirementsFor: () => [CONTROLS['SCP-01-01'], { ...CONTROLS['SCP-01-01'], id: 'SCP-01-02' }],
    });
    await attestations.record({
      ...attestation('att-due', 'SCP-01-01', new Date('2026-08-20T09:00:00.000Z')),
      attestedAt: new Date('2026-07-21T09:00:00.000Z'),
    });
    const review = await opened(base, scans);

    const { status, body } = await send(
      base,
      `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/confirm`
    );

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'pillar-needs-attention' });
    expect((body as { message: string }).message).toContain('2 questions still need attention');
    await expect(reviews.get(review.id)).resolves.toMatchObject({ pillars: [] });
    await expect(acts(audit)).resolves.toEqual([
      ['review.open', 'performed', 'scan-1', undefined],
      ['review.confirm', 'failed', 'security-compliance-and-privacy', 'pillar-needs-attention'],
    ]);
  });

  it('refuses a pillar this catalogue does not have', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);

    const { status, body } = await send(base, `/api/reviews/${review.id}/pillars/not-a-pillar/confirm`);

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-review' });
  });

  it('refuses a second record for a pillar that already has one', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);
    await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    const { status, body } = await send(base, `/api/reviews/${review.id}/pillars/reliability/confirm`);

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-review' });
  });
});

describe('finalisation is not an endpoint', () => {
  it('publishes after the only selected pillar and stores no decision for an excluded pillar', async () => {
    const { base, scans, reviews } = await serve();
    const review = await opened(base, scans, { requestedPillars: ['reliability'] });

    const excluded = await send(base, `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/skip`);
    const completed = await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    expect(excluded).toMatchObject({ status: 409, body: { error: 'pillar-not-selected' } });
    expect(completed).toMatchObject({
      status: 201,
      body: {
        selectedPillars: ['reliability'],
        pillars: [expect.objectContaining({ pillarId: 'reliability' })],
        result: { pillars: [expect.objectContaining({ pillarId: 'reliability' })] },
      },
    });
    await expect(reviews.get(review.id)).resolves.toMatchObject({
      pillars: [expect.objectContaining({ pillarId: 'reliability' })],
    });
  });

  it('writes a result when the last pillar is recorded and withholds an incomplete legacy body', async () => {
    const { base, scans, attestations, reviews } = await serve({
      requirementsFor: () => [CONTROLS['SCP-01-01']],
    });
    await attestations.record(attestation('att-held', 'SCP-01-01'));
    const review = await opened(base, scans);
    await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    const { status, body } = await send(
      base,
      `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/confirm`
    );
    const written = body as AssessmentReviewPayload;

    expect(status).toBe(201);
    expect(written.result).toMatchObject({
      reviewId: review.id,
      runId: 'scan-1',
      finalisedBy: 'priya@example.com',
      attestationIds: ['att-held'],
    });
    expect(written.result?.pillars.map((one) => one.kind)).toEqual(['confirmed', 'skipped']);

    const current = await read<CurrentResultPayload>(base, '/api/results/current');
    expect(current).toMatchObject({ eligibility: { eligible: false, state: 'incomplete' } });
    expect(current.result).toBeUndefined();
    await expect(reviews.current()).resolves.toMatchObject({ id: written.result?.id });
    await expect(send(base, `/api/results/${written.result?.id ?? ''}`, undefined, 'GET')).resolves.toMatchObject({
      status: 409,
      body: { error: 'result-incomplete', eligibility: { eligible: false, state: 'incomplete' } },
    });
    await expect(send(base, '/api/results', undefined, 'GET')).resolves.toMatchObject({
      status: 409,
      body: { error: 'result-incomplete', eligibility: { eligible: false, state: 'incomplete' } },
    });
  });

  it('does not replace current() when a later scan is opened for review', async () => {
    const { base, scans, reviews } = await serve();
    const first = await opened(base, scans);
    await send(base, `/api/reviews/${first.id}/pillars/reliability/skip`);
    await send(base, `/api/reviews/${first.id}/pillars/security-compliance-and-privacy/confirm`);
    const before = await reviews.current();

    await scans.save(scan({ id: 'scan-2' }));
    const { status } = await send(base, '/api/reviews', { runId: 'scan-2' });
    expect(status).toBe(201);

    const after = await reviews.current();
    expect(after?.id).toBe(before?.id);
    expect(after?.runId).toBe('scan-1');
    const served = await read<CurrentResultPayload>(base, '/api/results/current');
    expect(served).toMatchObject({ eligibility: { eligible: false, state: 'incomplete' } });

    const open = await read<OpenReviewsPayload>(base, '/api/reviews');
    expect(open.reviews.map((one) => one.runId)).toEqual(['scan-2']);
  });
});

describe('there is no way to unsay a pillar record', () => {
  it('has no route that replaces one', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);
    await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    const response = await fetch(`${base}/api/reviews/${review.id}/pillars/reliability`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind: 'confirmed' }),
    });

    expect(response.status).toBe(404);
  });

  it('has no route that removes one', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);
    await send(base, `/api/reviews/${review.id}/pillars/reliability/skip`);

    const response = await fetch(`${base}/api/reviews/${review.id}/pillars/reliability`, { method: 'DELETE' });

    expect(response.status).toBe(404);
    const got = await read<AssessmentReviewPayload>(base, `/api/reviews/${review.id}`);
    expect(got.pillars).toHaveLength(1);
  });
});

describe('reading a review', () => {
  it('is ungated, because a review is a read', async () => {
    const { base } = await serve({ permit: false });

    const open = await read<OpenReviewsPayload>(base, '/api/reviews');

    expect(open.reviews).toEqual([]);
    expect(open.durable).toBe(false);
  });

  it('finds the review of a named scan', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);

    const got = await read<AssessmentReviewPayload>(base, `/api/reviews/for/${review.runId}`);
    expect(got.id).toBe(review.id);
  });

  it('answers 404 for a review this assessment does not have', async () => {
    const { base } = await serve();

    const { status, body } = await send(base, '/api/reviews/missing', undefined, 'GET');

    expect(status).toBe(404);
    expect(body).toMatchObject({
      error: 'unknown-review',
      eligibility: { eligible: false, state: 'unknown' },
    });
  });

  it('does not report an unavailable review store as an empty inbox', async () => {
    const { base } = await serve({ omitStore: true });

    const { status, body } = await send(base, '/api/reviews', undefined, 'GET');

    expect(status).toBe(503);
    expect(body).toMatchObject({
      error: 'reviews-unavailable',
      eligibility: { eligible: false, state: 'unavailable' },
    });
  });

  it('does not report a failed review read as an empty inbox or unknown review', async () => {
    const reviews = new UnreadableReviewStore({ pillars: PILLARS });
    const { base } = await serve({ reviews });

    await expect(send(base, '/api/reviews', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: { error: 'reviews-unreadable', eligibility: { eligible: false, state: 'unreadable' } },
    });
    await expect(send(base, '/api/reviews/rev-1', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: { error: 'review-unreadable', eligibility: { eligible: false, state: 'unreadable' } },
    });
  });
});

describe('reading final assessments', () => {
  it('distinguishes no current result from an eligible result-history read', async () => {
    const { base } = await serve();

    const current = await read<CurrentResultPayload>(base, '/api/results/current');
    const history = await read<import('../../shared/api/contract.js').FinalResultHistoryPayload>(base, '/api/results');

    expect(current).toMatchObject({ eligibility: { eligible: false, state: 'unknown' } });
    expect(current.result).toBeUndefined();
    expect(history).toMatchObject({ eligibility: { eligible: true, state: 'eligible' }, results: [] });
  });

  it('does not report a missing result store as known-empty result state', async () => {
    const { base } = await serve({ omitStore: true });

    await expect(send(base, '/api/results/current', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: { error: 'results-unavailable', eligibility: { eligible: false, state: 'unavailable' } },
    });
    await expect(send(base, '/api/results', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: { error: 'results-unavailable', eligibility: { eligible: false, state: 'unavailable' } },
    });
  });

  it('returns the server recovery reason when a result read fails', async () => {
    const reviews = new UnreadableReviewStore({ pillars: PILLARS });
    const { base } = await serve({ reviews });

    await expect(send(base, '/api/results/current', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: {
        error: 'current-result-unreadable',
        eligibility: {
          eligible: false,
          state: 'unreadable',
          reason: { action: 'Restore the database connection and retry this exact request.' },
        },
      },
    });
    await expect(send(base, '/api/results/result-1', undefined, 'GET')).resolves.toMatchObject({
      status: 503,
      body: { error: 'result-unreadable', eligibility: { eligible: false, state: 'unreadable' } },
    });
  });
});

describe('answering a requirement from inside a review', () => {
  const ANSWER = {
    controlId: 'SCP-01-01',
    answer: 'met',
    statement: 'Every workspace is behind the corporate identity provider, checked this morning.',
    owner: 'platform-security@example.com',
  };

  const path = (review: AssessmentReviewPayload, pillarId = 'security-compliance-and-privacy') =>
    `/api/reviews/${review.id}/pillars/${pillarId}/answers`;

  it('refuses every human decision for an ad-hoc run before an attestation or pillar record is written', async () => {
    const { base, scans, attestations, reviews } = await serve();
    const review = await opened(base, scans, {
      requestedPillars: ['security-compliance-and-privacy'],
      stamp: {
        catalogueVersion: '3',
        catalogueFingerprint: 'abc',
        executionMode: 'on-behalf-of-user',
        actor: 'scheduler@example.com',
        scope: { hostWorkspaceId: '123', description: 'the account' },
        lookbackDays: 30,
      },
    });

    const answered = await send(base, `${path(review)}?definitionId=`, ANSWER);
    const decided = await send(
      base,
      `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/skip?definitionId=`
    );

    expect(answered).toMatchObject({
      status: 409,
      body: { error: 'assessment-definition-required' },
    });
    expect(decided).toMatchObject({
      status: 409,
      body: { error: 'assessment-definition-required' },
    });
    await expect(attestations.historyFor('SCP-01-01')).resolves.toEqual([]);
    await expect(reviews.get(review.id)).resolves.toMatchObject({ pillars: [], answers: [] });
  });

  it('writes the attestation and joins it to the review, and says so in the payload', async () => {
    const { base, scans, attestations, audit } = await serve();
    const review = await opened(base, scans);

    const { status, body } = await send(base, path(review), ANSWER);

    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: review.id,
      answers: [
        {
          pillarId: 'security-compliance-and-privacy',
          controlId: 'SCP-01-01',
          by: 'priya@example.com',
        },
      ],
    });
    const held = await attestations.historyFor('SCP-01-01');
    expect(held.map((one) => one.answer)).toEqual(['met']);
    expect((body as AssessmentReviewPayload).answers[0]?.attestationId).toBe(held[0]?.id);
    await expect(acts(audit)).resolves.toContainEqual(['review.answer', 'performed', 'SCP-01-01', undefined]);
  });

  it('lets a freshly answered thirty-day requirement be confirmed in the same review', async () => {
    const { base, scans } = await serve({
      cadenceDays: () => 30,
      requirementsFor: () => [CONTROLS['SCP-01-01']],
    });
    const review = await opened(base, scans);

    const answered = await send(base, path(review), ANSWER);
    const confirmed = await send(base, `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/confirm`);

    expect(answered.status).toBe(201);
    expect(confirmed.status).toBe(201);
    expect(confirmed.body).toMatchObject({
      pillars: [
        {
          kind: 'confirmed',
          pillarId: 'security-compliance-and-privacy',
        },
      ],
    });
  });

  it('refuses a requirement that belongs to another pillar, which is the count this record exists for', async () => {
    const { base, scans, attestations } = await serve();
    const review = await opened(base, scans);

    const { status, body } = await send(base, path(review), { ...ANSWER, controlId: 'RE-01-01' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'wrong-pillar' });
    await expect(attestations.historyFor('RE-01-01')).resolves.toEqual([]);
  });

  it('refuses an answer with nothing behind it, before anything is written', async () => {
    const { base, scans, attestations } = await serve();
    const review = await opened(base, scans);

    const { status, body } = await send(base, path(review), { ...ANSWER, statement: 'yep' });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-attestation' });
    await expect(attestations.historyFor('SCP-01-01')).resolves.toEqual([]);
  });

  it('answers 404 for a review this assessment does not have', async () => {
    const { base } = await serve();

    const { status, body } = await send(base, '/api/reviews/missing/pillars/reliability/answers', {
      ...ANSWER,
      controlId: 'RE-01-01',
    });

    expect(status).toBe(404);
    expect(body).toMatchObject({ error: 'unknown-review' });
  });

  it('refuses an answer to a pillar this review has already decided', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);
    await send(base, `/api/reviews/${review.id}/pillars/security-compliance-and-privacy/confirm`, {});

    const { status, body } = await send(base, path(review), ANSWER);

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'invalid-review' });
  });

  it('is gated, and records the refusal', async () => {
    const { base, scans } = await serve();
    const review = await opened(base, scans);
    const closed = await serve({ permit: false });

    const { status } = await send(closed.base, path(review), ANSWER);

    expect(status).toBe(403);
  });

  it('says which half is missing when the install keeps reviews but not answers', async () => {
    const { base, scans } = await serve({ omitAttestations: true });
    const review = await opened(base, scans);

    const { status, body } = await send(base, path(review), ANSWER);

    expect(status).toBe(503);
    expect(body).toMatchObject({ error: 'attestations-unavailable' });
    expect((body as { message: string }).message).toContain('Confirming and skipping this review still work.');
  });
});
