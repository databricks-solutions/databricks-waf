// The cross-context negative 42c exists to hold.
//
// Two assessments, each with answers, actions, advice and publications, and no read from either
// that returns the other's. The store tests hold the same boundary one domain at a time; this is
// the HTTP surface the UI actually calls, because a filter that holds in a store and is forgotten
// on a route is the contamination the row is for.

import express from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import type { AttestationsPayload, CurrentResultPayload, ImprovementsPayload, OpenReviewsPayload } from '../../shared/api/contract.js';
import { InMemoryAdvisoryStore } from '../advise/store.js';
import type { Advisory } from '../advise/advisory.js';
import { InMemoryAttestationStore } from '../attest/store.js';
import type { Attestation } from '../attest/attestation.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { accountScope } from '../collect/estate-scope.js';
import { InMemoryImprovementStore } from '../improve/store.js';
import type { ImprovementAction } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import { parseMonth, type Publication } from '../monthly/publication.js';
import { PostgresPublicationStore } from '../monthly/store.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { ScanRunner } from '../scan/runner.js';
import { InMemoryScanStore } from '../scan/store.js';
import { opened, skipped } from '../review/review.js';
import { InMemoryReviewStore } from '../review/store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { closeServed, servedAt } from './test-servers.js';
import { registerApi } from './routes.js';
import type { MonthsPayload } from './publication-routes.js';

const servers: Server[] = [];
afterAll(() => closeServed(servers));

const catalogue = loadCatalogue();
const registry = buildRegistry();
const AT = new Date('2026-08-01T09:00:00.000Z');
const REVIEW = new Date('2027-08-01T09:00:00.000Z');

function month(value: string) {
  const parsed = parseMonth(value);
  if (parsed == null) throw new Error(`test wrote a bad month: ${value}`);
  return parsed;
}

function answer(definitionId: string, id: string): Attestation {
  return {
    id,
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'A named platform team owns the workspace, with a rota and a runbook.',
    owner: 'platform@example.com',
    attestedBy: 'ana@example.com',
    attestedAt: AT,
    reviewBy: REVIEW,
    definitionId,
  };
}

function plan(definitionId: string, id: string): ImprovementPlan {
  return {
    id,
    title: `Work under ${definitionId}`,
    outcome: 'Every production table has a named owner and an access review behind it.',
    owners: ['priya@example.com'],
    createdBy: 'priya@example.com',
    createdAt: AT,
    revision: 0,
    assessment: { definitionId, version: 1 },
  };
}

function action(planId: string, id: string): ImprovementAction {
  return {
    id,
    planId,
    controlIds: ['DG-01-01'],
    outcome: 'Ownership is assigned on every production table, so a review has somebody to ask.',
    definitionOfDone: 'Every table in the prod catalogue has an owner recorded.',
    owner: 'sam@example.com',
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: 'draft',
    createdBy: 'priya@example.com',
    createdAt: AT,
    history: [],
    revision: 0,
  };
}

function advice(definitionId: string, id: string): Advisory {
  return {
    id,
    runId: `run-${id}`,
    startedAt: AT,
    finishedAt: new Date(AT.getTime() + 60_000),
    state: 'complete',
    scope: accountScope(),
    lookbackDays: 30,
    stamp: { actor: 'ada@example.com', executionMode: 'service-principal' },
    readings: [],
    definition: { id: definitionId, version: 1, fingerprint: 'f' },
  };
}

function publication(definitionId: string, id: string): Publication {
  return {
    id,
    month: month('2026-08'),
    publishedAt: AT,
    publishedBy: 'ana@example.com',
    documentVersion: 1,
    json: `{"documentKind":"databricks-waf-month","id":"${id}"}`,
    csv: `month,publication_id\r\n2026-08,${id}`,
    digest: 'sha256:abc' as const,
    ordinal: 1,
    definitionId,
  };
}

async function serve(): Promise<{ readonly base: string; readonly resultA: string; readonly resultB: string }> {
  const attestations = new InMemoryAttestationStore();
  const improvements = new InMemoryImprovementStore();
  const advisories = new InMemoryAdvisoryStore();
  // Durable, because the month routes refuse to read a store that would not survive a restart.
  const publications = new PostgresPublicationStore({
    db: new FakePostgres({ unique: { month_publications: [['definition_id', 'month', 'ordinal']] } }),
  });
  const scans = new InMemoryScanStore();
  const reviews = new InMemoryReviewStore({ pillars: ['operational-excellence'] });

  await attestations.record(answer('def-a', 'ans-a'));
  await attestations.record(answer('def-b', 'ans-b'));

  const planA = plan('def-a', 'plan-a');
  const planB = plan('def-b', 'plan-b');
  await improvements.addPlan(planA);
  await improvements.addPlan(planB);
  await improvements.addAction(action('plan-a', 'act-a'), planA);
  await improvements.addAction(action('plan-b', 'act-b'), planB);

  await advisories.save(advice('def-a', 'adv-a'));
  await advisories.save(advice('def-b', 'adv-b'));

  await publications.publish(publication('def-a', 'pub-a'));
  await publications.publish(publication('def-b', 'pub-b'));

  await reviews.open(
    opened({
      id: 'rev-a',
      runId: 'scan-a',
      openedBy: 'ana@example.com',
      openedAt: AT,
      definitionId: 'def-a',
    })
  );
  await reviews.open(
    opened({
      id: 'rev-b',
      runId: 'scan-b',
      openedBy: 'ana@example.com',
      openedAt: AT,
      definitionId: 'def-b',
    })
  );
  const recordedA = await reviews.record(
    skipped(
      {
        id: 'p-a',
        reviewId: 'rev-a',
        runId: 'scan-a',
        pillarId: 'operational-excellence',
        by: 'ana@example.com',
        at: AT,
      },
      ['operational-excellence']
    )
  );
  const recordedB = await reviews.record(
    skipped(
      {
        id: 'p-b',
        reviewId: 'rev-b',
        runId: 'scan-b',
        pillarId: 'operational-excellence',
        by: 'ana@example.com',
        at: AT,
      },
      ['operational-excellence']
    )
  );
  await reviews.open(
    opened({
      id: 'rev-open-a',
      runId: 'scan-open-a',
      openedBy: 'ana@example.com',
      openedAt: AT,
      definitionId: 'def-a',
    })
  );

  const app = express();
  app.use(express.json());
  registerApi(app, {
    catalogue,
    registry,
    runner: new ScanRunner({ catalogue, registry, store: scans, measuredPillars: ['operational-excellence'] }),
    store: scans,
    attestations,
    improvements,
    advisories,
    publications,
    reviews,
    collectorsFor: () => [],
    host: 'http://127.0.0.1:1',
    assessorGroup: 'assessors',
  });
  const resultA = recordedA.result?.id;
  const resultB = recordedB.result?.id;
  if (resultA == null || resultB == null) throw new Error('The isolation fixture did not finalise both reviews.');
  return { base: await servedAt(app, servers), resultA, resultB };
}

async function get(base: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`);
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

function answered(body: unknown): string | undefined {
  const payload = body as AttestationsPayload;
  return payload.requirements.find((one) => one.controlId === 'OE-01-01')?.attestation?.id;
}

describe('two assessments on one install', () => {
  it('does not return one assessment\'s answers, actions, advice, publications, reviews or results from the other', async () => {
    const { base, resultA, resultB } = await serve();

    const answersA = await get(base, '/api/attestations?definitionId=def-a');
    const answersB = await get(base, '/api/attestations?definitionId=def-b');
    expect(answered(answersA.body)).toBe('ans-a');
    expect(answered(answersB.body)).toBe('ans-b');
    expect(answered((await get(base, '/api/attestations')).body)).toBeUndefined();

    const plansA = ((await get(base, '/api/improvements?definitionId=def-a')).body as ImprovementsPayload).plans.map(
      (one) => one.id
    );
    const plansB = ((await get(base, '/api/improvements?definitionId=def-b')).body as ImprovementsPayload).plans.map(
      (one) => one.id
    );
    expect(plansA).toEqual(['plan-a']);
    expect(plansB).toEqual(['plan-b']);
    expect(((await get(base, '/api/improvements')).body as ImprovementsPayload).plans).toEqual([]);
    expect((await get(base, '/api/improvements/plan-b?definitionId=def-a')).status).toBe(404);
    expect((await get(base, '/api/improvements/for/DG-01-01?definitionId=def-a')).body).toMatchObject({
      actions: [{ id: 'act-a' }],
    });
    expect((await get(base, '/api/improvements/for/DG-01-01?definitionId=def-b')).body).toMatchObject({
      actions: [{ id: 'act-b' }],
    });

    expect((await get(base, '/api/advisory/latest?definitionId=def-a')).body).toMatchObject({ id: 'adv-a' });
    expect((await get(base, '/api/advisory/latest?definitionId=def-b')).body).toMatchObject({ id: 'adv-b' });
    expect((await get(base, '/api/advisory/latest')).status).toBe(404);
    expect((await get(base, '/api/advisory/adv-b?definitionId=def-a')).status).toBe(404);

    const monthsA = ((await get(base, '/api/months?definitionId=def-a')).body as MonthsPayload).months.map(
      (one) => one.latest.id
    );
    const monthsB = ((await get(base, '/api/months?definitionId=def-b')).body as MonthsPayload).months.map(
      (one) => one.latest.id
    );
    expect(monthsA).toEqual(['pub-a']);
    expect(monthsB).toEqual(['pub-b']);
    expect(((await get(base, '/api/months')).body as MonthsPayload).months).toEqual([]);

    const currentA = (await get(base, '/api/results/current?definitionId=def-a')).body as CurrentResultPayload;
    const currentB = (await get(base, '/api/results/current?definitionId=def-b')).body as CurrentResultPayload;
    expect(currentA).toMatchObject({ eligibility: { eligible: false, state: 'incomplete' } });
    expect(currentB).toMatchObject({ eligibility: { eligible: false, state: 'incomplete' } });
    expect(currentA.result).toBeUndefined();
    expect(currentB.result).toBeUndefined();
    expect((await get(base, `/api/results/${resultA}?definitionId=def-a`)).status).toBe(409);
    expect((await get(base, `/api/results/${resultB}?definitionId=def-b`)).status).toBe(409);
    expect((await get(base, '/api/results/current')).body).toMatchObject({
      eligibility: { eligible: false, state: 'unknown' },
    });
    expect((await get(base, `/api/results/${resultB}?definitionId=def-a`)).status).toBe(404);

    const openA = ((await get(base, '/api/reviews?definitionId=def-a')).body as OpenReviewsPayload).reviews.map(
      (one) => one.id
    );
    const openB = ((await get(base, '/api/reviews?definitionId=def-b')).body as OpenReviewsPayload).reviews.map(
      (one) => one.id
    );
    expect(openA).toEqual(['rev-open-a']);
    expect(openB).toEqual([]);
    expect((await get(base, '/api/reviews/rev-b?definitionId=def-a')).status).toBe(404);
    expect((await get(base, '/api/reviews/for/scan-b?definitionId=def-a')).status).toBe(404);
  });
});
