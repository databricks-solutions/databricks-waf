// The HTTP surface, over a real socket.
//
// A real express app on a real port rather than a mocked request object, because the
// things most likely to break here are exactly the things a mock removes: header casing,
// JSON body parsing, status codes, and the identity probe's use of a response header
// rather than its body. Two servers run: the app, and a stand-in workspace whose only job
// is to answer the current-user call the way Databricks does.

import express from 'express';
import { createHash } from 'node:crypto';
import type { RequestListener, Server } from 'node:http';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { COMPLETE, observed, type Collector, type SignalId } from '../collect/signal.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { scoreFindings } from '../score/score.js';
import { ScanRunner } from '../scan/runner.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import { InMemoryScanStore, type ScanStore } from '../scan/store.js';
import { decodeScan } from '../scan/codec.js';
import { InMemoryApplicabilityStore, type ApplicabilityStore } from '../apply/store.js';
import type { Finding } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';
import { InMemoryAttestationStore, type AttestationStore } from '../attest/store.js';
import { InMemoryReviewStore, type ReviewStore } from '../review/store.js';
import { finalAssessmentProjector } from '../review/projection.js';
import { InMemoryDecisionStore, type DecisionStore } from '../decide/store.js';
import { beyondAnyInstall, descriptorsById } from '../plan/plan.js';
import { MEANS, type VerificationReport } from '../records/verify.js';
import { define, revise } from '../define/definition.js';
import { InMemoryDefinitionStore, type DefinitionStore } from '../define/store.js';
import { AuditRecorder, type AuditPosture } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { PostgresRunStore } from '../run/run-store.js';
import { Runs } from '../run/runs.js';
import { registerApi, type CollectorFactoryContext } from './routes.js';
import { explain } from './fallback.js';
import type {
  AssessmentResultPayload,
  AssessmentReviewPayload,
  FinalResultHistoryPayload,
  ReadinessPayload,
  ScanPayload,
  ScanSummaryPayload,
} from '../../shared/api/contract.js';

const catalogue = loadCatalogue();
const registry = buildRegistry();

/** What this test build assesses. Passed to both the runner and the routes, as `server.ts` does. */
const MEASURED = ['data-and-ai-governance'] as const;
const ALL_PILLARS = catalogue.pillars.map((pillar) => pillar.id);

class UnreadableResultStore extends InMemoryReviewStore {
  override result(): Promise<never> {
    return Promise.reject(new Error('result database unavailable'));
  }
}

const ESTATE: Partial<Record<SignalId, unknown>> = {
  'sql:uc.census': {
    tableCount: 10,
    catalogCount: 2,
    schemaCount: 3,
    managedTables: 10,
    externalTables: 0,
    views: 0,
    metricViews: 0,
    foreignTables: 0,
    deltaTables: 10,
    icebergTables: 0,
    optimizedFormatTables: 10,
    describedTables: 10,
    distinctOwners: 2,
  },
};

function collector(delayMs = 0): Collector {
  return {
    surface: 'sql',
    name: 'synthetic',
    signals: Object.keys(ESTATE) as SignalId[],
    // Routes through the scheduler as the real collectors do, rather than resolving
    // directly. A fake that skipped it would report spend while the scan's footprint
    // showed no work on any surface, and no test would notice the contradiction.
    collect: async (ids, { scheduler }) => {
      const outcomes = await Promise.all(
        ids.map((id) =>
          scheduler.run({
            surface: 'sql',
            label: id,
            units: 1,
            run: async () => {
              if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
              return observed(id, ESTATE[id], 1, COMPLETE);
            },
          })
        )
      );
      return outcomes.flatMap((outcome) => (outcome.status === 'ok' ? [outcome.value] : []));
    },
    // Reports spend the way the SQL collector does, so the footprint has something to
    // carry. A collector that reported none would pass a test that only checked the
    // field existed.
    spent: () => ({
      surface: 'sql',
      name: 'synthetic',
      calls: 1,
      bytesRead: 4096,
      rowsReturned: 10,
      statementIds: ['01ef-synthetic'],
    }),
  };
}

/**
 * A collector that reads nothing, standing in for an identity with no grants.
 *
 * Not a failing collector — it declares the same signals and returns none of them, which is what
 * a service principal that may not use the warehouse actually produces. Measured against a live
 * install: a fresh service principal scanned 148 requirements and scored none of them.
 */
function blindCollector(): Collector {
  return {
    surface: 'sql',
    name: 'synthetic-blind',
    signals: Object.keys(ESTATE) as SignalId[],
    collect: () => Promise.resolve([]),
    spent: () => ({ surface: 'sql', name: 'synthetic-blind', calls: 1, bytesRead: 0, rowsReturned: 0 }),
  };
}

/**
 * Refuses every signal it is asked for, the way an under-granted identity is refused.
 *
 * Two different refusals rather than one, though only the warehouse refusal reaches the message:
 * where a requirement needed both signals, `remedyFor` keeps the worst remedy, and a grant outranks
 * enabling a schema. That is the right answer — the schema cannot be read through a warehouse the
 * identity may not use — and worth having a fixture that would notice if it changed.
 */
function refusingCollector(): Collector {
  const signals = Object.keys(ESTATE) as SignalId[];
  return {
    surface: 'sql',
    name: 'synthetic-refusing',
    signals,
    collect: () =>
      Promise.resolve(
        signals.map((id, index) => ({
          id,
          status: 'unmeasurable' as const,
          coverage: COMPLETE,
          unmeasurableReason:
            index % 2 === 0
              ? 'The warehouse refused the request with 403: You do not have permission to use the SQL Warehouse.'
              : 'SCHEMA_NOT_FOUND: system.access does not exist or you do not have permission on it.',
          collectedAt: new Date('2026-08-01T00:00:00Z'),
          durationMs: 1,
        }))
      ),
    spent: () => ({ surface: 'sql', name: 'synthetic-refusing', calls: 1, bytesRead: 0, rowsReturned: 0 }),
  };
}

/** The group this test build gates mutations on, as an install names one. */
const ASSESSORS = 'waf-assessors';

/**
 * What SCIM says the caller is in, for the run in progress.
 *
 * Mutable and reset per test rather than a second stand-in workspace per case, because the whole
 * gate turns on this one field: a member, a colleague in other groups, and a response that lists
 * no groups at all are three tests of the same route. `undefined` means the attribute is absent,
 * which is SCIM declining to say and not the same as saying "none".
 */
let scimGroups: readonly string[] | undefined = [ASSESSORS];

/** Stands in for the workspace: answers the SCIM current-user call, header and all. */
const workspace: RequestListener = (request, response) => {
  if (request.url === '/api/2.0/preview/scim/v2/Me') {
    response.writeHead(200, { 'content-type': 'application/json', 'x-databricks-org-id': '1234567890' });
    response.end(
      JSON.stringify({
        userName: 'admin@example.com',
        ...(scimGroups == null
          ? {}
          : { groups: scimGroups.map((display, at) => ({ display, type: 'direct', value: String(at) })) }),
      })
    );
    return;
  }
  response.writeHead(404).end();
};

let workspaceUrl = '';
let appUrl = '';
const servers: Server[] = [];

/**
 * An app wired the way `server.ts` wires it.
 *
 * One store shared between the runner and the routes, because that is the arrangement
 * that makes a completed scan readable afterwards; two stores would pass every test that
 * never read a scan back.
 */
interface AppOptions {
  readonly collectorDelayMs?: number;
  readonly verifyRecords?: () => Promise<VerificationReport>;
  readonly attestations?: AttestationStore;
  readonly reviews?: ReviewStore;
  readonly decisions?: DecisionStore;
  readonly scans?: ScanStore;
  /** Where applicability decisions go, as an install with Lakebase bound has somewhere to put them. */
  readonly applicability?: ApplicabilityStore;
  readonly collectors?: readonly Collector[];
  readonly measuredPillars?: readonly string[];
  readonly definitions?: DefinitionStore;
  /**
   * Where the acts go, when a test is about the acts.
   *
   * Absent for every other test, which is not laziness: an install with no recorder is a real
   * configuration — the demo one — and every route being exercised without it is what holds the
   * no-op act in `begin` to actually being a no-op rather than a crash.
   */
  readonly audit?: AuditLog;
  /** What this install does about an act it cannot record. Defaults to what a real install defaults to. */
  readonly auditPosture?: AuditPosture;
  /**
   * Set to give the app somewhere to record runs, as an install with Lakebase bound has.
   *
   * Off by default so that every other test here exercises the path an install with nothing durable
   * takes — which is a real configuration and the one where a route has to work without a coordinator.
   */
  readonly durableRuns?: boolean;
  /** The warehouse binding, as a resource-bound install reports it. Absent means nothing is bound. */
  readonly warehouse?: string;
  /** Observe the exact collection question assembled by a route without replacing its collectors. */
  readonly observeCollectorContext?: (context: CollectorFactoryContext) => void;
}

async function startApp(options: AppOptions = {}): Promise<string> {
  const store = options.scans ?? new InMemoryScanStore();
  const measuredPillars = options.measuredPillars ?? MEASURED;
  const { attestations, decisions } = options;
  const runner = new ScanRunner({
    catalogue,
    registry,
    store,
    measuredPillars,
    ...(attestations != null ? { attestations } : {}),
  });
  const runs =
    options.durableRuns !== true
      ? undefined
      : new Runs({
          store: new PostgresRunStore(
            new FakePostgres({
              keys: { run_checkpoints: ['run_id', 'signal_id'] },
              unique: { runs: ['idempotency_key'] },
            })
          ),
          runner,
        });
  const routes = express();
  routes.use(express.json());
  registerApi(routes, {
    catalogue,
    registry,
    runner,
    ...(runs != null ? { runs } : {}),
    store,
    ...(attestations != null ? { attestations } : {}),
    ...(options.reviews != null ? { reviews: options.reviews } : {}),
    ...(decisions != null ? { decisions } : {}),
    ...(options.applicability != null ? { applicability: options.applicability } : {}),
    ...(options.definitions != null ? { definitions: options.definitions } : {}),
    host: workspaceUrl,
    assessorGroup: ASSESSORS,
    pillars: measuredPillars,
    ...(options.warehouse != null ? { warehouse: () => options.warehouse } : {}),
    ...(options.verifyRecords != null ? { verifyRecords: options.verifyRecords } : {}),
    ...(options.audit != null
      ? {
          audit: new AuditRecorder(options.audit, {
            ...(options.auditPosture != null ? { posture: options.auditPosture } : {}),
          }),
        }
      : {}),
    collectorsFor: (context) => {
      options.observeCollectorContext?.(context);
      return options.collectors ?? [collector(options.collectorDelayMs ?? 0)];
    },
  });

  return servedAt(routes, servers);
}

beforeAll(async () => {
  workspaceUrl = await servedAt(workspace, servers);
  appUrl = await startApp();
});

afterAll(() => closeServed(servers));

// So that a test which makes the caller a stranger cannot leave every test after it refused.
afterEach(() => {
  scimGroups = [ASSESSORS];
});

async function post(path: string, headers: Record<string, string> = {}, url = appUrl) {
  const response = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: '{}',
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('the catalogue endpoint', () => {
  it('names which pillars this build measures, so the UI never implies more', async () => {
    const response = await fetch(`${appUrl}/api/catalogue`);
    const body = (await response.json()) as { measuredPillars: string[]; pillars: unknown[] };

    expect(response.status).toBe(200);
    expect(body.measuredPillars).toEqual(['data-and-ai-governance']);
    expect(body.pillars.length).toBeGreaterThan(0);
  });
});

describe('the fresh workspace directory', () => {
  it('uses the default scan window so a quiet day cannot erase region attribution', async () => {
    const lookbacks: number[] = [];
    const url = await startApp({
      scans: new InMemoryScanStore(),
      observeCollectorContext: ({ lookbackDays }) => lookbacks.push(lookbackDays),
    });

    expect(
      (
        await fetch(`${url}/api/workspaces`, {
          headers: { 'x-forwarded-access-token': 'token' },
        })
      ).status
    ).toBe(200);
    expect(lookbacks).toEqual([30]);
  });
});

describe('starting a scan', () => {
  it('refuses without a forwarded user token, and says what to check', async () => {
    const { status, body } = await post('/api/scan');

    expect(status).toBe(401);
    expect(body.error).toBe('no-user-token');
    // The wording matters more than the code: the reader has to know it is a setting on
    // the app rather than a fault in their estate.
    expect(String(body.message)).toContain('user authorization');
  });

  it('runs as the probed user and stamps the result with that identity and workspace', async () => {
    const { status, body } = await post('/api/scan', { 'x-forwarded-access-token': 'token' });

    expect(status).toBe(200);
    const stamp = body.stamp as {
      actor: string;
      executionMode: string;
      scope: { hostWorkspaceId?: string; narrowedTo?: string; description: string };
    };
    expect(stamp.actor).toBe('admin@example.com');
    expect(stamp.executionMode).toBe('on-behalf-of-user');
    // The host workspace is identified but not used as a filter: the scan covers the
    // account. Asserting both together is deliberate, because identifying the workspace is
    // exactly what used to imply narrowing to it.
    expect(stamp.scope.hostWorkspaceId).toBe('1234567890');
    expect(stamp.scope.narrowedTo).toBeUndefined();
    expect(stamp.scope.description).toContain('every workspace');
  });

  it('returns findings the UI can render without needing the raw signal payloads', async () => {
    const { body } = await post('/api/scan', { 'x-forwarded-access-token': 'token' });

    const findings = body.findings as { controlId: string; evidence: unknown[] }[];
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((finding) => finding.evidence.length > 0)).toBe(true);

    // Signals are summarised, never sent whole: they include per-table arrays that no
    // page renders, and shipping them would multiply the payload for nothing.
    const signals = body.signals as Record<string, unknown>[];
    expect(signals.every((signal) => !('value' in signal))).toBe(true);
  });
});

describe('the final assessment customer boundary', () => {
  it('fails every report/export read closed when the result capability is unavailable', async () => {
    const url = await startApp();

    for (const path of [
      '/api/results/result-1/export.json',
      '/api/results/result-1/exports',
      '/api/results/result-1/changes',
    ]) {
      const response = await fetch(`${url}${path}`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: 'results-unavailable',
        eligibility: { eligible: false, state: 'unavailable' },
      });
    }
  });

  it('distinguishes an unknown result from a failed result read on report/export routes', async () => {
    const knownEmpty = await startApp({ reviews: new InMemoryReviewStore({ pillars: MEASURED }) });
    const unreadable = await startApp({ reviews: new UnreadableResultStore({ pillars: MEASURED }) });

    const missing = await fetch(`${knownEmpty}/api/results/result-1/export.json`);
    expect(missing.status).toBe(404);
    await expect(missing.json()).resolves.toMatchObject({
      error: 'unknown-result',
      eligibility: { eligible: false, state: 'unknown' },
    });

    const failed = await fetch(`${unreadable}/api/results/result-1/export.json`);
    expect(failed.status).toBe(503);
    await expect(failed.json()).resolves.toMatchObject({
      error: 'result-unreadable',
      eligibility: {
        eligible: false,
        state: 'unreadable',
        reason: { action: 'Restore the database connection and retry this exact request.' },
      },
    });
  });

  it('serves and exports the frozen result while excluding an unfinished run from result history', async () => {
    const scans = new InMemoryScanStore();
    const attestations = new InMemoryAttestationStore();
    const reviews = new InMemoryReviewStore({
      pillars: ALL_PILLARS,
      projection: {
        project: finalAssessmentProjector({ catalogue, registry }),
        scan: (id) => scans.get(id),
        attestation: (id, scope) => attestations.get(id, scope),
      },
    });
    const url = await startApp({ scans, attestations, reviews, measuredPillars: ALL_PILLARS });
    const started = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);
    const runId = String(started.body.id);
    const collected = await scans.get(runId);
    expect(collected).toBeDefined();
    if (collected == null) return;

    const source: Scan = {
      ...collected,
      stamp: {
        ...collected.stamp,
        definition: {
          id: 'definition-final-result',
          version: 1,
          fingerprint: 'sha256:definition-final-result',
          name: 'Final result test',
        },
      },
    };
    await scans.save(source);
    const scopeQuery = '?definitionId=definition-final-result';

    const openResponse = await fetch(`${url}/api/reviews${scopeQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ runId }),
    });
    expect(openResponse.status).toBe(201);
    const opened = (await openResponse.json()) as AssessmentReviewPayload;

    let finalised: AssessmentReviewPayload = opened;
    for (const pillarId of ALL_PILLARS) {
      const finalResponse = await fetch(`${url}/api/reviews/${opened.id}/pillars/${pillarId}/skip${scopeQuery}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      });
      expect(finalResponse.status).toBe(201);
      finalised = (await finalResponse.json()) as AssessmentReviewPayload;
    }
    const resultId = finalised.result?.id;
    const frozen = finalised.result?.finalAssessment;
    expect(resultId).toBeDefined();
    expect(frozen?.outcome.findings.length).toBeGreaterThan(0);
    expect(frozen?.outcome.score).toBeDefined();
    if (resultId == null || frozen == null) return;

    const unfinished: Scan = {
      ...source,
      id: 'run-still-in-review',
      startedAt: new Date(source.startedAt.getTime() + 60_000),
      finishedAt: new Date(source.finishedAt.getTime() + 60_000),
      stamp: {
        ...source.stamp,
        ...(source.stamp.identity == null
          ? {}
          : {
              identity: {
                ...source.stamp.identity,
                methodology: { id: 'sha256:different-scoring-method' },
              },
            }),
      },
    };
    await scans.save(unfinished);
    const unfinishedResponse = await fetch(`${url}/api/reviews${scopeQuery}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ runId: unfinished.id }),
    });
    expect(unfinishedResponse.status).toBe(201);
    const unfinishedReview = (await unfinishedResponse.json()) as AssessmentReviewPayload;

    const current = (await (await fetch(`${url}/api/results/current${scopeQuery}`)).json()) as {
      result?: AssessmentResultPayload;
      eligibility?: unknown;
    };
    expect(current.eligibility).toEqual({ eligible: true, state: 'eligible' });
    expect(current.result?.id).toBe(resultId);
    expect(current.result?.finalAssessment?.outcome).toEqual(frozen.outcome);

    const history = (await (await fetch(`${url}/api/results${scopeQuery}`)).json()) as FinalResultHistoryPayload;
    expect(history.results.map((one) => one.resultId)).toEqual([resultId]);

    // The raw source is only the technical envelope. Even if its provisional arithmetic differs,
    // the customer export must keep the frozen result outcome and name the immutable result it used.
    await scans.save({
      ...source,
      findings: [],
      score: { ...source.score, overall: 99 },
    });
    const exportResponse = await fetch(`${url}/api/results/${resultId}/export.json${scopeQuery}`);
    expect(exportResponse.status).toBe(200);
    const exported = (await exportResponse.json()) as {
      score: Scan['score'];
      findings: readonly { requirement: string }[];
      review: { finalResultId?: string };
    };
    expect(exported.review.finalResultId).toBe(resultId);
    expect(exported.score).toMatchObject(frozen.outcome.score);
    expect(exported.findings.map((one) => one.requirement)).toEqual(
      frozen.outcome.findings.map((one) => one.finding.controlId)
    );
    expect(exported.score.overall).not.toBe(99);

    let secondFinal: AssessmentReviewPayload = unfinishedReview;
    for (const pillarId of ALL_PILLARS) {
      const secondFinalResponse = await fetch(
        `${url}/api/reviews/${unfinishedReview.id}/pillars/${pillarId}/skip${scopeQuery}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        }
      );
      expect(secondFinalResponse.status).toBe(201);
      secondFinal = (await secondFinalResponse.json()) as AssessmentReviewPayload;
    }
    expect(secondFinal.result?.id).toBeDefined();
    const changes = (await (
      await fetch(`${url}/api/results/${secondFinal.result?.id ?? ''}/changes${scopeQuery}`)
    ).json()) as { comparable: boolean; reason?: string };
    expect(changes.comparable).toBe(false);
    expect(changes.reason).toContain('scoring method changed');
  });
});

describe('a second scan while one is running', () => {
  it('is refused and shown the running scan, rather than doubling the load for the same answer', async () => {
    const url = await startApp({ collectorDelayMs: 150 });
    const first = post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    // Long enough for the first request to have taken the lock, short enough to still be
    // inside the collector's delay.
    await new Promise((resolve) => setTimeout(resolve, 40));
    const second = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    expect(second.status).toBe(409);
    expect(second.body.error).toBe('scan-in-progress');
    expect(second.body.running).toMatchObject({ actor: 'admin@example.com' });

    const finished = await first;
    expect(finished.status).toBe(200);
  });
});

/**
 * The trigger, on an install that records runs.
 *
 * The record's own behaviour — the lease, the checkpoints, what may join what — is held in `run/`. What
 * only the route can get wrong is the join between the two: that a key reaches the coordinator at all,
 * that a run this process is collecting is named on the status the page polls, and that a refusal
 * arrives as a conflict a supervisor can read rather than as a five hundred.
 */
describe('starting a scan on an install that records runs', () => {
  it('names the run on the scheduled summary, so a job has something to poll after it stops watching', async () => {
    const url = await startApp({ durableRuns: true });

    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);

    expect(status).toBe(200);
    expect(typeof body.run).toBe('string');
    const recorded = (await (await fetch(`${url}/api/runs/${String(body.run)}`)).json()) as {
      state: string;
      scanId: string;
      trigger: string;
    };
    expect(recorded).toMatchObject({ state: 'complete', scanId: body.scan, trigger: 'scheduled' });
  });

  it('carries the key through, so a supervisor retrying its own request does not start a second run', async () => {
    const url = await startApp({ durableRuns: true });
    const headers = { 'x-forwarded-access-token': 'token', 'idempotency-key': 'nightly-2026-08-06' };

    const first = await post('/api/scan/scheduled', headers, url);
    const second = await post('/api/scan/scheduled', headers, url);

    // Two triggers, one run. The second is refused rather than joined because the first has finished —
    // and being told to read the answer is the useful reply to a retry of work that is already done.
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.error).toBe('run-not-joinable');
    expect(second.body.refusal).toBe('terminal');
    expect((second.body.run as { id: string }).id).toBe(first.body.run);

    const listed = (await (await fetch(`${url}/api/runs`)).json()) as { durable: boolean; runs: { id: string }[] };
    expect(listed.durable).toBe(true);
    expect(listed.runs.map((one) => one.id)).toEqual([first.body.run]);
  });

  it('tells the retry what the run found, not merely that it is too late to ask', async () => {
    // The case this exists for is ordinary: a job task posts, the app assesses the estate, the reply
    // is lost on the way back, and the task's retry posts the same key. Told only that the run is
    // terminal, the retry would report success — including for a run that came back blind, which is
    // the one outcome the blind check exists to prevent.
    const url = await startApp({ durableRuns: true });
    const headers = { 'x-forwarded-access-token': 'token', 'idempotency-key': 'nightly-lost-reply' };

    const first = await post('/api/scan/scheduled', headers, url);
    const retry = await post('/api/scan/scheduled', headers, url);

    expect(retry.status).toBe(409);
    expect(retry.body.refusal).toBe('terminal');
    const summary = retry.body.summary as { scan: string; measured: number; blind?: true };
    expect(summary.scan).toBe(first.body.scan);
    expect(summary.measured).toBe(first.body.measured);
    // Not blind, and said by omission rather than by a false flag, because the reader is a job whose
    // rule is "fail if the app says blind" and an absent flag is the app saying it is not.
    expect(summary.blind).toBeUndefined();
  });

  it('says so on the summary when the run it is too late to join came back blind', async () => {
    const url = await startApp({ durableRuns: true, collectors: [blindCollector()] });
    const headers = { 'x-forwarded-access-token': 'token', 'idempotency-key': 'nightly-blind' };

    const first = await post('/api/scan/scheduled', headers, url);
    const retry = await post('/api/scan/scheduled', headers, url);

    // The first attempt is told directly, with the grants named. The retry is told the same verdict
    // through the summary, which is what lets it fail the task rather than reporting a flat trend.
    expect(first.status).toBe(422);
    expect(first.body.blind).toBe(true);
    expect(retry.status).toBe(409);
    expect((retry.body.summary as { blind?: true }).blind).toBe(true);
  });

  it('names the run on the status of what this process is doing, so a page watching a scan can follow it past a restart', async () => {
    const url = await startApp({ durableRuns: true, collectorDelayMs: 150 });
    const scanning = post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    await new Promise((resolve) => setTimeout(resolve, 40));
    const running = (await (await fetch(`${url}/api/scan/status`)).json()) as { running: boolean; run?: string };

    expect(running.running).toBe(true);
    expect(typeof running.run).toBe('string');
    await scanning;

    // And it stops naming one when nothing here is collecting, because the run is no longer this
    // process's business — what became of it is `/api/runs/:id`.
    const after = (await (await fetch(`${url}/api/scan/status`)).json()) as { running: boolean; run?: string };
    expect(after.running).toBe(false);
    expect(after.run).toBeUndefined();
  });

  it('says nothing is recorded where no database is bound, rather than reporting an empty history', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const listed = (await (await fetch(`${url}/api/runs`)).json()) as { durable: boolean; unavailable?: string };
    const status = (await (await fetch(`${url}/api/scan/status`)).json()) as { run?: string };

    expect(listed.durable).toBe(false);
    expect(listed.unavailable).toContain('keeps no run records');
    expect(status.run).toBeUndefined();
  });
});

describe('reading a completed scan back', () => {
  it('serves the latest scan, and says the history is not durable yet', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const latest = (await (await fetch(`${url}/api/scans/latest`)).json()) as { id: string };
    expect(latest.id).toBeTypeOf('string');

    const history = (await (await fetch(`${url}/api/scans`)).json()) as {
      durable: boolean;
      durabilityNote?: string;
      scans: unknown[];
    };
    expect(history.durable).toBe(false);
    expect(history.durabilityNote).toContain('lost when the app restarts');
    expect(history.scans).toHaveLength(1);
  });

  it('accounts for its own cost, in units the customer can audit', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const scan = (await (await fetch(`${url}/api/scans/latest`)).json()) as ScanPayload;

    // Read back over HTTP rather than from the store, because the failure this guards
    // against is the footprint existing in the domain object and being dropped on the
    // way out. That is what happened to the surface counts before the shared contract.
    const [spend] = scan.spend;
    expect(spend.name).toBe('synthetic');
    expect(spend.bytesRead).toBe(4096);
    expect(spend.statementIds).toEqual(['01ef-synthetic']);

    const sql = scan.footprint.surfaces.find((surface) => surface.surface === 'sql');
    expect(sql?.succeeded).toBeGreaterThan(0);
    expect(sql?.budget).toBeGreaterThan(0);
    expect(scan.footprint.durationMs).toBeGreaterThanOrEqual(0);
    expect(scan.footprint.cancelled).toBe(false);
  });

  it('renders a stored document this build cannot construct, over the route that crashed on one', async () => {
    /*
     * Row `90`. Every other fixture here reaches the presenters through a scan this build just ran, so its
     * footprint comes from `new CollectionScheduler().footprint()` and carries exactly what the current
     * build carries. A fixture derived from the code under test cannot disagree with it about shape, which
     * is why row `81` added a field to a stored shape and left `npm run verify` green: no test anywhere
     * read a document it had not just written.
     *
     * What crashed was not the decoder — `88` is the refusal, and `codec.test.ts` holds it. It was
     * `presentFootprint`, four frames further on, calling `Object.entries` on a field the document did not
     * carry. So this reads a body written out by hand over the route that returned 502 for eleven rows,
     * and asserts the payload rather than the absence of a throw: a presenter that swallowed the field
     * would pass a test that only asked whether the request completed.
     *
     * The body is one this build cannot produce: two surfaces where a real run would report six, a
     * `terminal` map with kinds in an order the presenter has to re-sort, and a limiter reduction count.
     * Stored as text and decoded, because text is what the column holds.
     */
    const stored = JSON.stringify({
      codecVersion: 3,
      scan: {
        id: 'stored-by-hand',
        startedAt: '2026-08-01T01:00:00.000Z',
        finishedAt: '2026-08-01T01:03:07.000Z',
        state: 'complete',
        stamp: {
          catalogueVersion: '3',
          catalogueFingerprint: 'abc',
          executionMode: 'on-behalf-of-user',
          actor: 'someone@example.com',
          scope: { description: 'the account' },
          lookbackDays: 30,
        },
        score: {
          overall: 0.62,
          pillars: [],
          counts: {
            pass: 1,
            fail: 0,
            partial: 0,
            unmeasurable: 0,
            'not-applicable': 0,
            'satisfied-by-architecture': 0,
          },
          scoredControls: 1,
          composition: { observed: 1, 'admin-collected': 0, attested: 0 },
          totalControls: 1,
        },
        findings: [],
        signals: [],
        estate: { assessed: [], excluded: [] },
        measurement: [],
        spend: [],
        footprint: {
          spend: { spent: { sql: 28, rest: 2 }, limits: { sql: 400, rest: 200 }, elapsedMs: 187_000 },
          tasks: {
            sql: {
              ok: 26,
              skipped: 0,
              failed: 2,
              retries: 3,
              attempts: 31,
              terminal: { 'permission-denied': 1, 'rate-limited': 4 },
            },
            // A surface that did nothing, which the presenter drops as noise rather than rendering empty.
            rest: { ok: 0, skipped: 0, failed: 0, retries: 0, attempts: 0, terminal: {} },
          },
          limiters: { sql: { reductions: 2 } },
          cancelled: false,
        },
      },
    });

    const held = decodeScan('stored-by-hand', stored);
    const url = await startApp({
      scans: {
        durable: true,
        save: () => Promise.resolve(),
        get: () => Promise.resolve(held),
        latest: () => Promise.resolve(held),
        history: () => Promise.resolve([]),
      },
    });

    const response = await fetch(`${url}/api/scans/latest`);
    expect(response.status).toBe(200);

    const scan = (await response.json()) as ScanPayload;

    expect(scan.footprint.surfaces.map((surface) => surface.surface)).toEqual(['sql']);
    const [sql] = scan.footprint.surfaces;
    expect(sql?.succeeded).toBe(26);
    expect(sql?.failed).toBe(2);
    expect(sql?.retries).toBe(3);
    expect(sql?.attempts).toBe(31);
    expect(sql?.spent).toBe(28);
    expect(sql?.budget).toBe(400);
    // Largest first, which is a re-sort: the document lists permission-denied before rate-limited.
    expect(sql?.refusals).toEqual([
      { kind: 'rate-limited', tasks: 4 },
      { kind: 'permission-denied', tasks: 1 },
    ]);
    expect(scan.footprint.durationMs).toBe(187_000);
    expect(scan.footprint.concurrencyReductions).toBe(2);
  });

  it('explains an absent scan as an absence rather than an error', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scans/latest`);
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(404);
    expect(body.error).toBe('no-scans');
    expect(body.message).toContain('Run one');
  });
});

describe('a run started by a schedule', () => {
  it('records that nobody was watching, and answers small enough for a task log', async () => {
    const url = await startApp();
    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);

    expect(status).toBe(200);
    // A summary, not the assessment: the findings and their evidence stay on the store.
    expect(body.findings).toBeUndefined();
    expect(body).toMatchObject({ trigger: 'scheduled', ranAs: 'admin@example.com', state: 'complete' });
    expect(body.measured).toBeGreaterThan(0);
    expect(typeof body.scan).toBe('string');

    // And the run itself carries the trigger, so history can tell the two apart later.
    const saved = (await (await fetch(`${url}/api/scans/${String(body.scan)}`)).json()) as ScanPayload<string>;
    expect(saved.stamp.trigger).toBe('scheduled');
  });

  it('marks a run somebody pressed as interactive, so the two are distinguishable', async () => {
    const url = await startApp();
    const { body } = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);
    const stamp = body.stamp as ScanPayload<string>['stamp'];
    expect(stamp.trigger).toBe('interactive');
  });

  it('fails the run when it measured nothing, because no one is watching to notice', async () => {
    const url = await startApp({ collectors: [blindCollector()] });
    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);

    // Non-2xx on purpose: this is what makes the job that called it fail, and a failed job is
    // the only thing that will tell anybody an unattended assessment stopped working.
    expect(status).toBe(422);
    expect(body.error).toBe('mostly-unreadable');
    expect(body.measured).toBe(0);
    // The message has to be actionable on its own, since a task log is all the reader gets.
    expect(String(body.message)).toContain('admin@example.com');
    expect(String(body.message)).toMatch(/grant|permission|SELECT/i);
    // Kept rather than discarded, so the claim in the message can be checked.
    expect(typeof body.scan).toBe('string');
    const saved = await fetch(`${url}/api/scans/${String(body.scan)}`);
    expect(saved.status).toBe(200);
  });

  it('fails a run that measured a little and could not read most of it', async () => {
    // The case a live test caught, and the reason the rule is not "scored nothing". A service
    // principal with no grants at all still came back with one pass and one partial out of 184,
    // from the requirements answerable without reading anything — so an emptiness test passed it
    // and would have reported a healthy nightly assessment of an estate it never read.
    //
    // Reproduced by assessing every pillar with a collector that feeds only one of them: a
    // handful score, the rest are unreadable, which is the same shape.
    const everyPillar = catalogue.pillars.map((pillar) => pillar.id);
    const url = await startApp({ measuredPillars: everyPillar });
    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);

    expect(status).toBe(422);
    expect(body.error).toBe('mostly-unreadable');
    // Measured something, and still refused, which is the whole point of the comparison.
    expect(body.measured).toBeGreaterThan(0);
    expect(String(body.message)).toMatch(/could not read \d+ of the requirements/);
  });

  it('names each refusal once with a count, rather than repeating one sentence eighty times', async () => {
    // What the task log has to say. The first version of this message quoted the estate's note
    // about why a resource count was uncertain, which on a live run ended with "resource counts
    // may therefore include workspaces that have been cancelled" — true, unrelated to the missing
    // grant, and the last sentence the operator read. Grouped refusals are one grant per line.
    const everyPillar = catalogue.pillars.map((pillar) => pillar.id);
    const url = await startApp({ collectors: [refusingCollector()], measuredPillars: everyPillar });
    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);
    const message = String(body.message);

    expect(status).toBe(422);
    // The platform's own words, so an operator checking whether a grant landed can compare — and
    // once, with a count, rather than one line per affected requirement.
    expect(message).toMatch(/- \d+ requirements: The warehouse refused the request with 403/);
    expect(message.match(/You do not have permission to use the SQL Warehouse/g)).toHaveLength(1);

    // A requirement whose signals never ran is not a refusal and is not listed as one. It is
    // counted separately, because "this app has a defect" and "issue this grant" are different
    // sentences and ranking them together buried the second.
    expect(message).toMatch(/A further \d+ went unread with nothing refusing them/);
    expect(message).not.toMatch(/- \d+ requirements: The \S+ signal reported no reason/);

    expect(message).toContain('docs/scheduled-scans.md');
  });

  it('keeps a run that read most of what it can measure', async () => {
    // The other side of the comparison: the rule must not refuse an ordinary healthy run, or the
    // job fails every night and the failure stops meaning anything.
    const url = await startApp();
    const { status, body } = await post('/api/scan/scheduled', { 'x-forwarded-access-token': 'token' }, url);
    expect(status).toBe(200);
    expect(body.error).toBeUndefined();
  });

  it('still refuses a caller the proxy did not vouch for', async () => {
    const url = await startApp();
    const { status, body } = await post('/api/scan/scheduled', {}, url);
    // No separate secret guards this route: the platform authenticates the caller and the
    // forwarded token is the proof. Absent it, there is no identity to attribute a run to.
    expect(status).toBe(401);
    expect(body.error).toBe('no-user-token');
  });
});

describe('exporting the assessment', () => {
  it('serves a CSV a browser will save, named for the run', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const response = await fetch(`${url}/api/scans/latest/export.csv`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/csv');
    // Saved rather than rendered, and distinguishable from the last three downloads.
    expect(response.headers.get('content-disposition')).toMatch(
      /attachment; filename="well-architected-\d{4}-\d{2}-\d{2}-.+\.csv"/
    );
    // A cell can hold a table name this app did not choose, so the declared type has to bind:
    // without this a browser may decide a CSV starting with a tag is really a page and render it.
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');

    const [header, ...rows] = (await response.text()).split('\r\n');
    expect(header).toContain('requirement,title,outcome,severity');
    expect(rows.length).toBeGreaterThan(0);
    // Every row carries the run's identity, because a spreadsheet has no header block.
    expect(rows.every((row) => row.includes('admin@example.com'))).toBe(true);
  });

  it('serves a JSON document that names its own format', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const response = await fetch(`${url}/api/scans/latest/export.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');

    const body = (await response.json()) as {
      document: string;
      documentVersion: number;
      run: { ranAs: string };
      findings: { requirement: string; judgedBy?: string }[];
    };
    expect(body.document).toBe('databricks-waf-assessment');
    expect(body.documentVersion).toBe(4);
    expect(body.run.ranAs).toBe('admin@example.com');
    // The requirement text travels with it, so the file can be read without the app.
    expect(body.findings.some((one) => one.judgedBy != null)).toBe(true);
  });

  it('exports a named run as well as the latest one', async () => {
    const url = await startApp();
    const { body } = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const response = await fetch(`${url}/api/scans/${String(body.id)}/export.csv`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(String(body.id));
  });

  it('explains having nothing to export rather than serving an empty file', async () => {
    // An empty CSV downloaded from a fresh install reads as an estate with no requirements.
    const url = await startApp();
    const response = await fetch(`${url}/api/scans/latest/export.csv`);

    expect(response.status).toBe(404);
    expect(String(((await response.json()) as { message: string }).message)).toContain('nothing to export');
  });

  it('publishes the digest of each file without serving one, so a sender can tell a recipient what to expect', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const published = (await (await fetch(`${url}/api/scans/latest/exports`)).json()) as {
      scanId: string;
      files: { name: string; format: string; digest: string; bytes: number; href: string; verify: string[] }[];
    };

    expect(published.files.map((file) => file.format)).toEqual(['csv', 'json']);
    // The claim the page makes on the strength of this: hash the download and you get this value.
    for (const file of published.files) {
      const download = await fetch(`${url}${file.href}`);
      const served = Buffer.from(await download.arrayBuffer());

      expect(file.digest).toBe(`sha256:${createHash('sha256').update(served).digest('hex')}`);
      expect(file.bytes).toBe(served.byteLength);
      expect(download.headers.get('x-export-digest')).toBe(file.digest);
      expect(file.verify[0]).toBe(`shasum -a 256 ${file.name}`);
    }
    // The resolved run rather than the word asked for, so a link copied from the page outlives the
    // next scan — which is when `latest` would quietly start meaning a different file.
    expect(published.files.every((file) => file.href.includes(published.scanId))).toBe(true);
  });

  it('records nothing for reading a checksum, because nothing left the app', async () => {
    // A row per checksum read would be noise in the one table whose value is that every row in it
    // is an act. The download beside it is what is recorded.
    const audit = new InMemoryAuditLog();
    const url = await startApp({ audit });
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    expect((await fetch(`${url}/api/scans/latest/exports`)).status).toBe(200);
    expect((await audit.search({ action: 'export.scan' })).events).toEqual([]);
  });

  it('serves the variant asked for, and refuses a word it does not produce', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const asked = await fetch(`${url}/api/scans/latest/export.json?variant=executive`);
    expect(asked.status).toBe(200);
    expect(((await asked.json()) as { variant: string }).variant).toBe('executive');
    // The variant is in the name as well as in the file, because a digest is only the digest of one
    // of them and a recipient checking the wrong file reads a mismatch as tampering.
    expect(asked.headers.get('content-disposition')).toContain('-executive.json');

    // Refused rather than defaulted: a caller handed the complete file after asking for a summary
    // will describe it to somebody else as a summary.
    const wrong = await fetch(`${url}/api/scans/latest/export.csv?variant=summary`);
    expect(wrong.status).toBe(400);
    expect(String(((await wrong.json()) as { message: string }).message)).toContain('four exports');
  });

  it('publishes every variant with its own digest, and says who each is for', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const published = (await (await fetch(`${url}/api/scans/latest/exports`)).json()) as {
      files: { variant: string }[];
      variants: { variant: string; says: string; omits?: string; files: { digest: string; href: string }[] }[];
    };

    expect(published.variants.map((one) => one.variant)).toEqual(['executive', 'technical', 'improvement', 'audit']);
    // The top-level list stays the complete file, so a page written before variants existed still
    // shows what it always showed.
    expect(published.files.every((file) => file.variant === 'technical')).toBe(true);

    const digests = new Set(published.variants.flatMap((one) => one.files.map((file) => file.digest)));
    expect(digests.size).toBe(8);

    for (const variant of published.variants) {
      expect(variant.says.length).toBeGreaterThan(40);
      // The two files that carry every column have nothing to disclaim; the two narrower ones say
      // what they left out and where the whole of it is.
      expect(variant.omits == null).toBe(variant.variant === 'technical' || variant.variant === 'audit');
      for (const file of variant.files) {
        const served = Buffer.from(await (await fetch(`${url}${file.href}`)).arrayBuffer());
        expect(file.digest).toBe(`sha256:${createHash('sha256').update(served).digest('hex')}`);
      }
    }
  });

  it('lists what has already been taken, and whether a copy of it would still hash the same', async () => {
    // The question a sender actually has. An export describes the run and the decisions standing
    // against it, so a copy sent last week can legitimately differ from today's download — and a
    // recipient who checks reports that as tampering unless the page says otherwise first.
    const audit = new InMemoryAuditLog();
    const url = await startApp({ audit });
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    await fetch(`${url}/api/scans/latest/export.csv`, { headers: { 'x-forwarded-email': 'sender@example.com' } });

    const published = (await (await fetch(`${url}/api/scans/latest/exports`)).json()) as {
      taken: { name: string; digest: string; by: string; current?: boolean }[];
    };

    expect(published.taken).toHaveLength(1);
    expect(published.taken[0].name).toMatch(/\.csv$/);
    expect(published.taken[0].by).toBe('sender@example.com');
    expect(published.taken[0].current).toBe(true);
  });
});

describe('the scan history', () => {
  /** A durable store whose reads come back short, which is what an unreachable database looks like. */
  function unreachable(): ScanStore {
    const store = new InMemoryScanStore();
    return {
      durable: true,
      save: (scan) => store.save(scan),
      get: (id) => store.get(id),
      latest: () => store.latest(),
      history: () => Promise.resolve([]),
      unreadable: () => 'connection terminated unexpectedly',
    };
  }

  it('distinguishes a history it could not read from an estate nobody has assessed', async () => {
    const url = await startApp({ scans: unreachable() });

    const body = (await (await fetch(`${url}/api/scans`)).json()) as {
      durable: boolean;
      durabilityNote?: string;
      unreadable?: string;
      scans: readonly unknown[];
    };

    expect(body.scans).toEqual([]);
    expect(body.durable).toBe(true);
    // Not the durability note: that one says nothing is being kept, and telling an admin to bind
    // storage they already bound sends them to fix something that is not broken.
    expect(body.durabilityNote).toBeUndefined();
    expect(body.unreadable).toContain('connection terminated unexpectedly');
    expect(body.unreadable).toContain('not lost');
  });

  it('says nothing extra when the store read cleanly', async () => {
    const url = await startApp();
    const body = (await (await fetch(`${url}/api/scans`)).json()) as { unreadable?: string };

    expect(body.unreadable).toBeUndefined();
  });
});

describe('the run record', () => {
  it('carries who ran it, what it was asked for, and what it found', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const { scans } = (await (await fetch(`${url}/api/scans`)).json()) as { scans: ScanSummaryPayload[] };
    const [run] = scans;

    expect(run.actor).toBe('admin@example.com');
    expect(run.executionMode).toBe('on-behalf-of-user');
    // Absent rather than listing every pillar: this run was not a targeted rerun, and a
    // request field populated with the full set would make every run read as one.
    expect(run.requestedPillars).toBeUndefined();
    expect(run.measuredPillars).toEqual(['data-and-ai-governance']);
    expect(run.freshPillars).toEqual(['data-and-ai-governance']);
    // The index retains the whole basis so every client trend uses the server's comparison rule.
    // Flattened actor/mode/version fields are for display and are not a substitute for it.
    expect(run.stamp?.actor).toBe(run.actor);
    expect(run.stamp?.identity?.exclusions).toEqual([]);
    expect(run.counts.pass + run.counts.fail + run.counts.partial + run.counts.unmeasurable).toBeGreaterThan(0);
  });

  it('records a targeted rerun as one, so it cannot be read as a full scan', async () => {
    const url = await startApp();
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const response = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ pillars: ['data-and-ai-governance'] }),
    });
    expect(response.status).toBe(200);

    const { scans } = (await (await fetch(`${url}/api/scans`)).json()) as { scans: ScanSummaryPayload[] };
    expect(scans[0].requestedPillars).toEqual(['data-and-ai-governance']);
  });

  it('refuses a pillar this build does not measure rather than running nothing and reporting success', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ pillars: ['reliability'] }),
    });
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('unknown-pillar');
    expect(body.message).toContain('reliability');
  });

  /*
   * The door a definition's selected scope comes through. Recorded on the stamp because the scope is
   * what two runs are compared by: a run of six workspaces and a run of the account are not the same
   * assessment, and a reader looking at a score that moved has to be able to see that.
   */
  it('records the workspaces a run was asked to cover, so a narrowed run does not read as a full one', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ workspaces: ['1234567890', ' 1234567890 ', '99'] }),
    });
    expect(response.status).toBe(200);
    const scan = (await response.json()) as { stamp: { scope: { description: string; selected?: readonly string[] } } };

    // Deduplicated and trimmed, so the same estate asked for twice compares as one.
    expect(scan.stamp.scope.description).toContain('the 2 workspaces this assessment names');
    expect(scan.stamp.scope.selected).toEqual(['1234567890', '99']);
  });

  it('refuses a scope that names nothing rather than running the account under it', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ workspaces: [] }),
    });
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('unusable-scope');
    expect(body.message).toContain('Name at least one');
  });

  it('refuses a malformed workspace list rather than ignoring it and widening the run', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ workspaces: 'w1' }),
    });
    const body = (await response.json()) as { error: string };

    expect(response.status).toBe(400);
    expect(body.error).toBe('unusable-scope');
  });
});

/*
 * A run that answers to a saved assessment.
 *
 * The property under test throughout is that the assessment decides, and that the run says so. A run
 * that took its scope from the definition but recorded nothing about which definition would be a
 * number nobody could reproduce; a run that recorded the definition while quietly measuring
 * something else would be worse, because the record would be confidently wrong.
 */
describe('starting a scan that answers to an assessment', () => {
  const AT = new Date('2026-08-03T00:00:00Z');

  async function withDefinition(
    measurement: Parameters<typeof define>[0]['measurement'],
    over: { readonly archived?: boolean } = {}
  ): Promise<{ url: string; id: string; definitions: DefinitionStore }> {
    const definitions = new InMemoryDefinitionStore();
    await definitions.create(
      define({ measurement, attribution: { name: 'Q3 platform review', owners: [] } }, 'd1', AT, 'author@example.com')
    );
    if (over.archived === true) await definitions.archive('d1', AT);
    return { url: await startApp({ definitions }), id: 'd1', definitions };
  }

  function run(url: string, body: unknown): Promise<globalThis.Response> {
    return fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify(body),
    });
  }

  it('takes the scope and the window from the assessment, and records which one it answered', async () => {
    const { url, id } = await withDefinition({
      scope: { kind: 'selected', workspaceIds: ['1234567890'] },
      lookbackDays: 7,
      pillars: ['data-and-ai-governance'],
    });

    const response = await run(url, { definitionId: id });
    expect(response.status).toBe(200);

    const scan = (await response.json()) as ScanPayload<string>;
    expect(scan.stamp.definition?.id).toBe('d1');
    expect(scan.stamp.definition?.version).toBe(1);
    expect(scan.stamp.definition?.fingerprint).toMatch(/^sha256:/);
    expect(scan.stamp.scope.selected).toEqual(['1234567890']);
    expect(scan.stamp.lookbackDays).toBe(7);
  });

  /*
   * The fingerprint travels on the stamp rather than being looked up when a comparison is drawn,
   * because by then the assessment may have been revised — and the question the run answered is the
   * one it was started under, not the one that happens to be current.
   */
  it('stamps the version that was current when it ran, not whichever is current later', async () => {
    const { url, id, definitions } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    const before = (await (await run(url, { definitionId: id })).json()) as ScanPayload<string>;

    const stored = await definitions.get(id);
    if (stored == null) throw new Error('the definition under test went missing');
    const revised = revise(stored, { measurement: { scope: { kind: 'account' }, lookbackDays: 60 } }, AT, 'author@x');
    await definitions.appendVersion(id, revised.versions[1]);
    const after = (await (await run(url, { definitionId: id })).json()) as ScanPayload<string>;

    expect(before.stamp.definition?.version).toBe(1);
    expect(after.stamp.definition?.version).toBe(2);
    expect(after.stamp.definition?.fingerprint).not.toBe(before.stamp.definition?.fingerprint);
  });

  it('names the assessment on export download URLs, so a stamped run is still fetchable', async () => {
    const { url, id } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });
    const scan = (await (await run(url, { definitionId: id })).json()) as ScanPayload<string>;

    const published = (await (await fetch(`${url}/api/scans/${scan.id}/exports?definitionId=${id}`)).json()) as {
      files: { href: string }[];
    };

    expect(published.files[0]?.href).toContain(`definitionId=${id}`);
    expect((await fetch(`${url}${published.files[0]?.href}`)).status).toBe(200);
    expect((await fetch(`${url}/api/scans/${scan.id}/export.csv`)).status).toBe(404);
  });

  it('takes a targeted rerun from the query when the body cannot name the assessment', async () => {
    const { url, id } = await withDefinition({
      scope: { kind: 'account' },
      lookbackDays: 30,
      pillars: ['data-and-ai-governance'],
    });
    await run(url, { definitionId: id });

    const response = await fetch(`${url}/api/scan?definitionId=${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ pillars: ['data-and-ai-governance'] }),
    });
    expect(response.status).toBe(200);
    const scan = (await response.json()) as ScanPayload<string>;
    expect(scan.stamp.definition?.id).toBe(id);
    expect(scan.requestedPillars).toEqual(['data-and-ai-governance']);
  });

  /*
   * Refused rather than resolved by precedence. Either answer — the body wins, or the assessment
   * wins — produces a run stamped with a fingerprint describing a question it did not ask, and every
   * comparison drawn against it afterwards inherits that.
   */
  it('refuses a run that names an assessment and overrides it in the same breath', async () => {
    const { url, id } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    const response = await run(url, { definitionId: id, lookbackDays: 90 });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('assessment-and-overrides');
    expect(body.message).toContain('lookbackDays');
  });

  it('refuses lookback or workspaces on the body when the assessment is on the query too', async () => {
    const { url, id } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    const response = await fetch(`${url}/api/scan?definitionId=${id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ lookbackDays: 90 }),
    });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('assessment-and-overrides');
    expect(body.message).toContain('lookbackDays');
  });

  it('refuses an assessment that was closed to new runs, and says when', async () => {
    const { url, id } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 }, { archived: true });

    const response = await run(url, { definitionId: id });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('assessment-archived');
    expect(body.message).toContain('2026-08-03');
  });

  /*
   * The other half of row 14b, asserted here rather than beside the un-archive route because this is
   * where the refusal it lifts is enforced. Asserting only that `archivedAt` cleared would pass if the
   * run gate read some other field, and the reason the button exists is that a run can start again.
   */
  it('lets a run start once an assessment closed by mistake is put back', async () => {
    const { url, id, definitions } = await withDefinition(
      { scope: { kind: 'account' }, lookbackDays: 30 },
      { archived: true }
    );
    expect((await run(url, { definitionId: id })).status).toBe(400);

    await definitions.unarchive(id);

    expect((await run(url, { definitionId: id })).status).toBe(200);
  });

  it('answers 404 for an assessment that is not recorded here', async () => {
    const { url } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    expect((await run(url, { definitionId: 'nope' })).status).toBe(404);
  });

  /*
   * A definition written when this build measured more pillars than it does now. Running it against
   * the remainder would report an assessment of the author's whole framework while answering part of
   * it, at a stable fingerprint — so the trend reads as healthy and nothing says otherwise.
   */
  it('refuses an assessment naming a pillar this build no longer measures', async () => {
    const { url, id } = await withDefinition({
      scope: { kind: 'account' },
      lookbackDays: 30,
      pillars: ['reliability'],
    });

    const response = await run(url, { definitionId: id });

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe('unknown-pillar');
    expect(body.message).toContain('reliability');
  });

  it('says plainly that an install keeping no assessments cannot run one', async () => {
    const url = await startApp();

    const response = await run(url, { definitionId: 'd1' });

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe('assessments-unavailable');
  });

  it('refuses a definitionId that is not an id', async () => {
    const { url } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    expect((await run(url, { definitionId: '  ' })).status).toBe(400);
    expect((await run(url, { definitionId: 7 })).status).toBe(400);
  });

  // An ordinary run names no assessment, and the field has to be absent rather than empty: a reader
  // comparing two runs asks whether they answer to the same assessment, and `undefined` is the only
  // honest answer for a run that answers to none.
  it('leaves the assessment off a run that was started directly', async () => {
    const { url } = await withDefinition({ scope: { kind: 'account' }, lookbackDays: 30 });

    const scan = (await (await run(url, {})).json()) as ScanPayload<string>;

    expect(scan.stamp.definition).toBeUndefined();
  });
});

describe('what a run changed', () => {
  it('refuses to compare the first run against nothing', async () => {
    const url = await startApp();
    const { body } = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const changes = (await (await fetch(`${url}/api/scans/${String(body.id)}/changes`)).json()) as {
      comparable: boolean;
      reason?: string;
    };

    expect(changes.comparable).toBe(false);
    expect(changes.reason).toContain('first recorded run');
  });

  it('compares a second run against the first and names it', async () => {
    const url = await startApp();
    const first = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);
    const second = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const changes = (await (await fetch(`${url}/api/scans/${String(second.body.id)}/changes`)).json()) as {
      comparable: boolean;
      previous?: { id: string };
      changes: unknown[];
    };

    expect(changes.comparable).toBe(true);
    expect(changes.previous?.id).toBe(first.body.id);
    // Two runs against the same synthetic estate: the point is that it compares, not that
    // it found something.
    expect(changes.changes).toEqual([]);
  });

  it('finds the predecessor even when both runs finished in the same millisecond', async () => {
    /*
     * Two scans back to back against a synthetic estate finish inside one millisecond, and the
     * first version of this endpoint looked for a run finishing strictly earlier — so the second
     * scan reported itself as the first run ever recorded. A real estate never hits it, which is
     * exactly why it is worth a test: the only thing that surfaced it was an unrelated change
     * adding a round trip to the request path, and it surfaced one run in six.
     */
    const scans = new InMemoryScanStore();
    const url = await startApp({ scans });
    const first = await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);
    // The tie is made rather than raced for: waiting for two real runs to land in one millisecond
    // is how the defect stayed hidden, and a test that reproduces it one time in six is not a test.
    const ran = await scans.get(String(first.body.id));
    await scans.save({ ...(ran as NonNullable<typeof ran>), id: 'the-same-instant' });

    const changes = (await (await fetch(`${url}/api/scans/the-same-instant/changes`)).json()) as {
      comparable: boolean;
      previous?: { id: string };
    };

    expect(changes.comparable).toBe(true);
    expect(changes.previous?.id).toBe(first.body.id);
  });

  it('says a run is not in the history rather than returning an empty comparison', async () => {
    const url = await startApp();
    const response = await fetch(`${url}/api/scans/00000000-0000-0000-0000-000000000000/changes`);

    expect(response.status).toBe(404);
    expect(((await response.json()) as { error: string }).error).toBe('scan-not-found');
  });
});

describe('when the app cannot start', () => {
  it('sends an unconfigured assessor group to the bundle rather than to the resources page', () => {
    // The only startup failure that is the admin's to fix and is not fixable by binding anything,
    // so the generic "check the app's resources" advice would send them to the wrong screen.
    const { kind, summary, action } = explain(
      new Error('WAF_ASSESSOR_GROUP is unset, so this app has no way to tell who is allowed to change an assessment')
    );

    expect(kind).toBe('no-assessor-group');
    expect(summary).toContain('who is allowed to change');
    expect(action).toContain('databricks.yml');
    // And says the retry cannot clear it, because an environment variable is not a binding.
    expect(action).toContain('redeploy');
  });

  it('turns an unbound warehouse into an instruction rather than a stack trace', () => {
    const { kind, summary, action } = explain(new Error('Resource not found: sql warehouse'));

    expect(kind).toBe('no-warehouse');
    expect(summary).toContain('no SQL warehouse');
    expect(action).toContain('add a SQL warehouse resource');
  });

  it('turns an unbound database into the binding to add, naming the permission that matters', () => {
    const { kind, summary, action } = explain(
      new Error('LAKEBASE_ENDPOINT is unset, so there is no Lakebase endpoint to connect to.')
    );

    expect(kind).toBe('no-database');
    expect(summary).toContain('no Lakebase database');
    expect(action).toContain('CAN_CONNECT_AND_CREATE');
  });

  it('reads a database permission failure as the database, not as the warehouse', () => {
    // Both words are in this message, and the order of the branches is what decides which
    // instruction an admin gets. Matching `permission` first would send somebody to grant CAN USE
    // on a warehouse that is bound and working, and the app would still not start.
    const { kind, action } = explain(new Error('permission denied for schema waf (postgres role lacks CREATE)'));

    expect(kind).toBe('no-database');
    expect(action).toContain('creates its own schema');
    expect(action).not.toContain('SQL warehouse resource');
  });

  it('separates a broken package from a misconfigured workspace, and does not send the admin to a form', () => {
    const { kind, action } = explain(
      new Error("ENOENT: no such file or directory, scandir '/app/dist/config/controls'")
    );

    expect(kind).toBe('app-incomplete');
    // The wording is the point: an admin told to check their resources for a file the app
    // failed to ship goes looking for something that was never theirs to bind.
    expect(action).toContain('No workspace setting will fix this');
    expect(action).not.toContain('CAN USE');
  });

  it('still says something useful for a cause it does not recognise', () => {
    const { kind, summary, action, detail } = explain(new Error('ECONNRESET'));

    expect(kind).toBe('unknown');
    expect(summary).toBe('The app could not start.');
    expect(action).toContain('resources');
    expect(detail).toBe('ECONNRESET');
  });
});

describe('answering the requirements nothing can measure', () => {
  /** An app with somewhere to keep answers, which the default one deliberately has not. */
  async function withStore(scans?: ScanStore): Promise<{ url: string; store: AttestationStore }> {
    const store = new InMemoryAttestationStore();
    return { url: await startApp({ attestations: store, ...(scans != null ? { scans } : {}) }), store };
  }

  /** A requirement this app checks and no install can be authorised to run. */
  function blocked(): string {
    const byId = descriptorsById();
    const control = catalogue.controls.find(
      (candidate) => candidate.measurability !== 'attestation' && beyondAnyInstall(candidate, registry, byId)
    );
    if (control == null) throw new Error('The catalogue holds no blocked requirement to test with.');
    return control.id;
  }

  /**
   * A store holding one finished scan that read the named requirement and found it wanting.
   *
   * Hand-built rather than run, because the situation under test is one no test environment can
   * reach: a deployment whose credentials *can* read a workspace setting the app's own
   * classification says no install may. Locally, against an admin's token, that is the normal case.
   */
  async function scanSettling(controlId: string): Promise<ScanStore> {
    const store = new InMemoryScanStore();
    const at = new Date('2026-08-01T10:00:00.000Z');
    await store.save({
      id: 'measured',
      startedAt: at,
      finishedAt: at,
      state: 'complete',
      stamp: {
        catalogueVersion: catalogue.version.version,
        catalogueFingerprint: catalogue.version.fingerprint,
        executionMode: 'on-behalf-of-user',
        actor: 'admin@example.com',
        scope: { description: 'this workspace' },
        lookbackDays: 30,
      },
      score: {
        pillars: [],
        counts: { pass: 0, fail: 1, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
        scoredControls: 1,
        composition: { observed: 1, 'admin-collected': 0, attested: 0 },
        totalControls: 1,
      },
      findings: [
        {
          controlId,
          pillarId: 'security-compliance-and-privacy',
          principleId: controlId.slice(0, 6),
          title: controlId,
          outcome: 'fail',
          severity: 'medium',
          coverage: { mode: 'complete' },
          evidence: [],
        },
      ],
      signals: [],
      estate: { assessed: [{ id: 'w1', name: 'prod', status: 'RUNNING' }], excluded: [] },
      measurement: [],
      footprint: new CollectionScheduler().footprint(),
      spend: [],
    });
    return store;
  }

  /** A requirement the catalogue says only a person can answer. */
  function attestable(): string {
    const control = catalogue.controls.find((candidate) => candidate.measurability === 'attestation');
    if (control == null) throw new Error('The catalogue holds no attestation-class requirement to test with.');
    return control.id;
  }

  const answer = (controlId: string) => ({
    controlId,
    answer: 'met',
    statement: 'Reviewed each quarter by the platform team; minutes are in the runbook.',
    owner: 'platform-team@example.com',
  });

  async function send(url: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}/api/attestations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('lists every requirement a person has to answer, with the question from the catalogue', async () => {
    const { url } = await withStore();
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as {
      requirements: { controlId: string; question: string; cadenceDays: number }[];
    };

    expect(response.status).toBe(200);
    expect(body.requirements.length).toBeGreaterThan(0);
    // The question is versioned with the framework rather than composed in the browser, so
    // what the customer is asked goes through the same review as anything else we assess.
    expect(body.requirements[0]?.question.length).toBeGreaterThan(10);
    expect(body.requirements[0]?.cadenceDays).toBeGreaterThan(0);
  });

  it('includes requirements whose check no install can be authorised to run', async () => {
    // The checks page counts these apart from the unbuilt ones and tells the reader they need an
    // answer instead. Listing only the catalogue's attestation class would make that a dead end:
    // the page would name work and the page that does the work would not show it.
    const { url } = await withStore();
    const byId = descriptorsById();
    const blocked = catalogue.controls.filter(
      (control) => control.measurability !== 'attestation' && beyondAnyInstall(control, registry, byId)
    );
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as { requirements: { controlId: string }[] };
    const listed = new Set(body.requirements.map((requirement) => requirement.controlId));

    expect(blocked.length).toBeGreaterThan(0);
    for (const control of blocked) expect(listed.has(control.id)).toBe(true);
  });

  it('lists each requirement once, even where it is both attestation-class and blocked', async () => {
    const { url } = await withStore();
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as { requirements: { controlId: string }[] };
    const ids = body.requirements.map((requirement) => requirement.controlId);

    expect(new Set(ids).size).toBe(ids.length);
  });

  it('stops asking about a setting once a scan has actually read it', async () => {
    // "No install can be authorised for this" is a property of the deployment model, and it is not
    // always true: run against an admin's own token, several of these settings are readable, and
    // the last scan read them. Continuing to ask would be asking someone to duplicate a reading —
    // and to produce a second answer the app could then contradict with the first.
    const controlId = blocked();
    const { url } = await withStore(await scanSettling(controlId));
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as { requirements: { controlId: string }[] };
    const listed = body.requirements.map((requirement) => requirement.controlId);

    expect(listed).not.toContain(controlId);
    // Only that one. A scan settling one setting must not empty the page.
    expect(listed.length).toBeGreaterThan(80);
  });

  it('can scope the question set to the run under review instead of the latest run', async () => {
    const controlId = blocked();
    const measuredOnly = await scanSettling(controlId);
    const measured = await measuredOnly.get('measured');
    if (measured == null) throw new Error('The measured scan fixture was not stored.');
    const scans = new InMemoryScanStore();
    await scans.save({
      ...measured,
      id: 'earlier-unsettled',
      startedAt: new Date('2026-07-01T10:00:00.000Z'),
      finishedAt: new Date('2026-07-01T10:00:00.000Z'),
      findings: [],
    });
    await scans.save(measured);
    const { url } = await withStore(scans);

    const latest = (await (await fetch(`${url}/api/attestations`)).json()) as {
      requirements: { controlId: string }[];
    };
    const reviewed = (await (
      await fetch(`${url}/api/attestations?runId=${encodeURIComponent('earlier-unsettled')}`)
    ).json()) as { requirements: { controlId: string }[] };

    expect(latest.requirements.map((one) => one.controlId)).not.toContain(controlId);
    expect(reviewed.requirements.map((one) => one.controlId)).toContain(controlId);
  });

  it('keeps asking about a practice a scan settled, because only an answer could have settled it', async () => {
    // An attestation-class requirement with an outcome has one because somebody answered it. Taking
    // it off this page on that basis would leave the answer nowhere to be renewed, so it would
    // silently lapse and drop out of the score.
    const controlId = attestable();
    const { url } = await withStore(await scanSettling(controlId));
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as { requirements: { controlId: string }[] };

    expect(body.requirements.map((requirement) => requirement.controlId)).toContain(controlId);
  });

  it('keeps an answered inconclusive measurement in the exact run question set', async () => {
    const control = catalogue.controls.find((candidate) => candidate.id === 'CO-01-08');
    if (control == null) throw new Error('The route regression requires CO-01-08.');
    const scans = await scanSettling(control.id);
    const measured = await scans.get('measured');
    if (measured == null) throw new Error('The measured scan fixture was not stored.');
    const stored = measured.findings[0];
    if (stored == null) throw new Error('The measured scan fixture has no finding.');
    const answeredAt = new Date('2026-08-20T10:00:00.000Z');
    const definitionId = 'definition-inconclusive-review';
    const current = {
      id: 'att-current-inconclusive',
      controlId: control.id,
      answer: 'met' as const,
      statement: 'The platform team tested a smaller cluster and retained the measured runtime.',
      owner: 'platform-team@example.com',
      attestedBy: 'admin@example.com',
      attestedAt: answeredAt,
      reviewBy: new Date('2026-11-20T10:00:00.000Z'),
      definitionId,
    };
    const finding: Finding = {
      ...stored,
      controlId: control.id,
      pillarId: control.pillarId,
      principleId: control.principleId,
      title: control.title,
      outcome: 'pass',
      attested: {
        id: current.id,
        bearing: 'outcome',
        by: current.attestedBy,
        at: current.attestedAt,
        statement: current.statement,
        owner: current.owner,
        reviewBy: current.reviewBy,
      },
    };
    await scans.save({
      ...measured,
      requestedPillars: [control.pillarId],
      stamp: {
        ...measured.stamp,
        definition: { id: definitionId, version: 1, fingerprint: 'sha256:inconclusive-review' },
      },
      findings: [finding],
      score: scoreFindings([finding]),
    });
    const store = new InMemoryAttestationStore();
    const reviews = new InMemoryReviewStore({ pillars: ALL_PILLARS });
    await store.record(current);
    const url = await startApp({ scans, attestations: store, reviews, measuredPillars: ALL_PILLARS });

    const scope = `definitionId=${encodeURIComponent(definitionId)}`;
    const response = await fetch(`${url}/api/attestations?runId=measured&${scope}`);
    const body = (await response.json()) as {
      requirements: { controlId: string; pillarId: string; askedBecause: string; attestation?: { id: string } }[];
    };
    const requirement = body.requirements.find((candidate) => candidate.controlId === control.id);

    expect(response.status).toBe(200);
    expect(requirement).toMatchObject({
      controlId: control.id,
      askedBecause: 'inconclusive',
      attestation: { id: current.id },
    });

    for (const candidate of body.requirements) {
      if (candidate.pillarId !== control.pillarId || candidate.attestation != null) continue;
      await store.record({
        ...current,
        id: `att-${candidate.controlId}`,
        controlId: candidate.controlId,
        statement: `The current recorded answer for ${candidate.controlId} was reviewed with this pillar.`,
      });
    }

    const openResponse = await fetch(`${url}/api/reviews?${scope}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ runId: measured.id }),
    });
    const opened = (await openResponse.json()) as AssessmentReviewPayload;
    expect(openResponse.status).toBe(201);

    const confirmResponse = await fetch(
      `${url}/api/reviews/${opened.id}/pillars/${control.pillarId}/confirm?${scope}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      }
    );
    const confirmed = (await confirmResponse.json()) as AssessmentReviewPayload;

    expect(confirmResponse.status).toBe(201);
    const decision = confirmed.pillars.find((candidate) => candidate.pillarId === control.pillarId);
    expect(decision).toMatchObject({ kind: 'confirmed', pillarId: control.pillarId });
    expect(decision?.attestationIds).toContain(current.id);
  });

  it('asks a question of every requirement it lists, with none of them the generated placeholder', async () => {
    // The seeder used to compose these from titles — "Use certified partner tools: is this
    // practice in place?" — which reads like a question while being unanswerable, so whatever was
    // clicked became an answer of record and moved the score. Checked at the route because that is
    // where the two authored tables and the catalogue meet.
    const { url } = await withStore();
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as {
      requirements: { controlId: string; question: string; evidenceGuidance?: string }[];
    };

    // The two exact templates the seeder produced. Not a looser `/in place\?$/`, which would also
    // catch an authored question that happens to end that way — "edited in place?" is a real
    // question about a real risk.
    const placeholder = body.requirements.filter((requirement) =>
      /(is this practice in place|is this in place across the workspace)\?$/.test(requirement.question)
    );
    const unguided = body.requirements.filter((requirement) => requirement.evidenceGuidance == null);

    expect(placeholder.map((requirement) => requirement.controlId)).toEqual([]);
    expect(unguided.map((requirement) => requirement.controlId)).toEqual([]);
  });

  it('says why each requirement is being asked, since a blocked setting is weaker evidence than a practice', async () => {
    const { url } = await withStore();
    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as {
      requirements: { controlId: string; askedBecause: string; cadenceDays: number }[];
    };

    const byId = descriptorsById();
    const blocked = new Set(
      catalogue.controls
        .filter((control) => control.measurability !== 'attestation' && beyondAnyInstall(control, registry, byId))
        .map((control) => control.id)
    );

    // The four fixed when the workspace was built: customer-managed keys, a customer-managed VPC,
    // front-end Private Link, secure cluster connectivity. Several cannot be changed afterwards
    // without a rebuild, so they are asked yearly and the quarterly rule below skips them.
    const fixedAtCreation = new Set(['SCP-02-03', 'SCP-03-03', 'SCP-03-04', 'SCP-03-06']);

    for (const requirement of body.requirements) {
      const expected = blocked.has(requirement.controlId) ? 'not-authorised' : 'no-telemetry';
      expect(requirement.askedBecause).toBe(expected);
      // A setting changes in one click, so an answer about one is reviewed quarterly rather than
      // inheriting the severity default — which for these is a year.
      if (expected === 'not-authorised' && !fixedAtCreation.has(requirement.controlId)) {
        expect(requirement.cadenceDays, requirement.controlId).toBeLessThanOrEqual(90);
      }
    }
  });

  it('renews an answer on the cadence the question was asked under, not the severity default', async () => {
    // A blocked setting is medium severity, whose default is a year, and it is asked quarterly. If
    // the POST path read a different source from the GET path, the reader would be told one thing
    // and the record would say another.
    const { url } = await withStore();
    const byId = descriptorsById();
    const blocked = catalogue.controls.find(
      (control) => control.measurability !== 'attestation' && beyondAnyInstall(control, registry, byId)
    );
    const { status, body } = await send(url, answer(blocked?.id ?? ''), {
      'x-forwarded-access-token': 'token',
    });

    expect(status).toBe(201);
    const days = Math.round(
      (new Date(String(body.reviewBy)).getTime() - new Date(String(body.attestedAt)).getTime()) / 86_400_000
    );
    expect(days).toBe(90);
  });

  it('refuses an answer without a forwarded user token, rather than storing an unattributed claim', async () => {
    const { url } = await withStore();
    const { status, body } = await send(url, answer(attestable()));

    expect(status).toBe(401);
    expect(body.error).toBe('no-user-token');
  });

  it('records an answer against the signed-in user and returns when it must be renewed', async () => {
    const { url } = await withStore();
    const { status, body } = await send(url, answer(attestable()), { 'x-forwarded-access-token': 'token' });

    expect(status).toBe(201);
    expect(body.attestedBy).toBe('admin@example.com');
    expect(body.state).toBe('current');
    expect(typeof body.reviewBy).toBe('string');
  });

  it('shows the answer against its requirement on the next read', async () => {
    const { url } = await withStore();
    const controlId = attestable();
    await send(url, answer(controlId), { 'x-forwarded-access-token': 'token' });

    const response = await fetch(`${url}/api/attestations`);
    const body = (await response.json()) as {
      requirements: { controlId: string; attestation?: { answer: string; owner: string } }[];
    };
    const answered = body.requirements.find((requirement) => requirement.controlId === controlId);

    expect(answered?.attestation?.answer).toBe('met');
    expect(answered?.attestation?.owner).toBe('platform-team@example.com');
  });

  it('refuses an answer with nothing behind it, naming what to add', async () => {
    const { url } = await withStore();
    const { status, body } = await send(
      url,
      { ...answer(attestable()), statement: 'yes' },
      { 'x-forwarded-access-token': 'token' }
    );

    expect(status).toBe(400);
    expect(body.error).toBe('invalid-attestation');
    expect(String(body.message)).toMatch(/at least/);
  });

  it('refuses an answer about a requirement the framework does not have', async () => {
    const { url } = await withStore();
    const { status, body } = await send(url, answer('NOPE-99-99'), { 'x-forwarded-access-token': 'token' });

    expect(status).toBe(400);
    expect(String(body.message)).toContain('NOPE-99-99');
  });

  it('ignores an identity in the body, so a claim cannot be attributed to a colleague', async () => {
    const { url } = await withStore();
    const { body } = await send(
      url,
      { ...answer(attestable()), attestedBy: 'someone.else@example.com' },
      { 'x-forwarded-access-token': 'token' }
    );

    expect(body.attestedBy).toBe('admin@example.com');
  });

  it('keeps superseded answers readable, rather than replacing them', async () => {
    const { url } = await withStore();
    const controlId = attestable();
    await send(url, { ...answer(controlId), answer: 'not-met' }, { 'x-forwarded-access-token': 'token' });
    await send(url, answer(controlId), { 'x-forwarded-access-token': 'token' });

    const response = await fetch(`${url}/api/attestations/${controlId}`);
    const body = (await response.json()) as { attestations: { answer: string; supersedes?: string }[] };

    expect(body.attestations).toHaveLength(2);
    expect(body.attestations[0]?.answer).toBe('met');
    expect(body.attestations[0]?.supersedes).toBeDefined();
  });

  it('says answers are not being kept when nothing keeps them, rather than accepting one it would lose', async () => {
    // The default app has no attestation store, which is what the demo flag looks like from the
    // outside. Silently accepting an answer there is the worst available behaviour: someone writes
    // a paragraph about their organisation and it disappears on the next deploy.
    const { status, body } = await send(appUrl, answer(attestable()), { 'x-forwarded-access-token': 'token' });

    expect(status).toBe(503);
    // The flag by name, because that is the string to search for. A production install cannot
    // reach this path at all — with no database bound the app serves the fallback page instead.
    expect(String(body.message)).toContain('WAF_DEMO_NO_PERSISTENCE');
  });

  it('still lists the requirements with no store, so the page explains itself', async () => {
    const response = await fetch(`${appUrl}/api/attestations`);
    const body = (await response.json()) as { durable: boolean; durabilityNote?: string };

    expect(response.status).toBe(200);
    expect(body.durable).toBe(false);
    expect(body.durabilityNote).toBeDefined();
  });

  it('puts an answered requirement into the score of the next scan', async () => {
    // End to end, and the reason the feature exists: an answered requirement leaves the
    // unmeasured pile and enters the denominator it was always in.
    const governance = catalogue.controls.find(
      (control) => control.pillarId === 'data-and-ai-governance' && control.measurability === 'attestation'
    );
    if (governance == null) throw new Error('No attestation-class requirement in the measured pillar.');

    const { url } = await withStore();
    await send(url, answer(governance.id), { 'x-forwarded-access-token': 'token' });

    const scan = await fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: '{}',
    });
    const body = (await scan.json()) as ScanPayload<string>;
    const finding = body.findings.find((candidate) => candidate.controlId === governance.id);

    expect(finding?.outcome).toBe('pass');
    expect(finding?.attested?.by).toBe('admin@example.com');
    expect(body.score.composition.attested).toBeGreaterThan(0);
  });
});

describe('excluding a requirement the last run did not cover', () => {
  /*
   * Finding 11. The reading the write-time guard judges came from the latest scan's findings, and an
   * absent finding was read as "nothing measured this requirement" — the case the applicability levers
   * exist for. A targeted rerun that could not carry its other pillars forward leaves exactly that: no
   * finding, on a requirement an earlier run measured as failing. So the guard saw nothing and admitted
   * the requirement it exists to refuse, and the failure left the score with a decision behind it.
   */
  const AT = new Date('2026-08-01T10:00:00.000Z');

  /** Two requirements of one pillar, from the catalogue rather than named: one to read, one to leave alone. */
  function two(): { readonly measured: string; readonly untouched: string } {
    const pillar = 'security-compliance-and-privacy';
    const ids = catalogue.controls.filter((control) => control.pillarId === pillar).map((control) => control.id);
    const [measured, untouched] = ids;
    if (measured == null || untouched == null) throw new Error('The catalogue holds too few security requirements.');
    return { measured, untouched };
  }

  function scan(id: string, finishedAt: Date, findings: readonly Finding[]): Scan {
    return {
      id,
      startedAt: finishedAt,
      finishedAt,
      state: 'complete',
      stamp: {
        catalogueVersion: catalogue.version.version,
        catalogueFingerprint: catalogue.version.fingerprint,
        executionMode: 'on-behalf-of-user',
        actor: 'admin@example.com',
        scope: { description: 'this workspace' },
        lookbackDays: 30,
      },
      score: {
        pillars: [],
        counts: { pass: 0, fail: 1, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
        scoredControls: findings.length,
        composition: { observed: findings.length, 'admin-collected': 0, attested: 0 },
        totalControls: findings.length,
      },
      findings,
      signals: [],
      estate: { assessed: [{ id: 'w1', name: 'prod', status: 'RUNNING' }], excluded: [] },
      measurement: [],
      footprint: new CollectionScheduler().footprint(),
      spend: [],
    };
  }

  function failing(controlId: string, pillarId = 'security-compliance-and-privacy'): Finding {
    return {
      controlId,
      pillarId,
      principleId: controlId.slice(0, 6),
      title: controlId,
      outcome: 'fail',
      severity: 'medium',
      coverage: { mode: 'complete' },
      evidence: [],
    };
  }

  /** A store whose newest run is a rerun of another pillar, over a run that read this one as failing. */
  async function rerunOver(controlId: string): Promise<ScanStore> {
    const scans = new InMemoryScanStore();
    await scans.save(scan('measured', AT, [failing(controlId)]));
    const elsewhere = catalogue.controls.find((control) => control.pillarId === 'data-and-ai-governance');
    if (elsewhere == null) throw new Error('The catalogue holds no governance requirement to rerun.');
    await scans.save({
      ...scan('rerun', new Date(AT.getTime() + 60_000), [failing(elsewhere.id, elsewhere.pillarId)]),
      requestedPillars: ['data-and-ai-governance'],
      notCarried: 'The previous run was measured against a different catalogue.',
    });
    return scans;
  }

  const body = (controlId: string, lever = 'not-applicable') => ({
    controlId,
    lever,
    reason: 'This estate runs no external sharing, so the requirement is about a thing it does not have.',
    owner: 'platform-engineering',
    expiresAt: '2026-09-01T00:00:00.000Z',
  });

  async function exclude(url: string, controlId: string, lever?: string) {
    const response = await fetch(`${url}/api/applicability`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify(body(controlId, lever)),
    });
    return { status: response.status, body: (await response.json()) as Record<string, string> };
  }

  it('refuses the requirement, and says the reading was not the latest run’s', async () => {
    const { measured: controlId } = two();
    const applicability = new InMemoryApplicabilityStore();
    const url = await startApp({ scans: await rerunOver(controlId), applicability });

    const refusal = await exclude(url, controlId);

    expect(refusal.status).toBe(400);
    expect(refusal.body.error).toBe('invalid-applicability');
    expect(refusal.body.message).toContain('was read as fail by a run before the most recent one');
    // And nothing was kept, so the failure is still in the score with no decision behind it.
    await expect(applicability.all()).resolves.toEqual([]);
  });

  it('refuses the other lever the same way, since both take the requirement out of the score', async () => {
    const { measured: controlId } = two();
    const url = await startApp({ scans: await rerunOver(controlId), applicability: new InMemoryApplicabilityStore() });

    expect((await exclude(url, controlId, 'disabled')).status).toBe(400);
  });

  it('still records one for a requirement no run in the history read', async () => {
    // The case the lever is for, which the look-back must not close: nothing has ever measured this.
    const { measured, untouched } = two();
    const applicability = new InMemoryApplicabilityStore();
    const url = await startApp({ scans: await rerunOver(measured), applicability });

    const recorded = await exclude(url, untouched);

    expect(recorded.status).toBe(201);
    await expect(applicability.all()).resolves.toHaveLength(1);
  });
});

describe('deciding what to do about a finding', () => {
  /** A requirement the synthetic estate measures and fails, so a decision has something to be about. */
  const FAILING = 'DG-02-01';

  async function withDecisions(scans?: ScanStore): Promise<string> {
    return startApp({ decisions: new InMemoryDecisionStore(), ...(scans != null ? { scans } : {}) });
  }

  /** A store holding one run that finished after the given moment and measured `FAILING` as stated. */
  async function ranAt(finishedAt: Date, outcome: 'fail' | 'pass'): Promise<ScanStore> {
    const store = new InMemoryScanStore();
    await store.save({
      id: 'measured',
      startedAt: finishedAt,
      finishedAt,
      state: 'complete',
      stamp: {
        catalogueVersion: catalogue.version.version,
        catalogueFingerprint: catalogue.version.fingerprint,
        executionMode: 'on-behalf-of-user',
        actor: 'admin@example.com',
        scope: { description: 'this workspace' },
        lookbackDays: 30,
      },
      score: {
        pillars: [],
        counts: {
          pass: outcome === 'pass' ? 1 : 0,
          fail: outcome === 'fail' ? 1 : 0,
          partial: 0,
          unmeasurable: 0,
          'not-applicable': 0,
          'satisfied-by-architecture': 0,
        },
        scoredControls: 1,
        composition: { observed: 1, 'admin-collected': 0, attested: 0 },
        totalControls: 1,
      },
      findings: [
        {
          controlId: FAILING,
          pillarId: 'data-and-ai-governance',
          principleId: 'DG-02',
          title: FAILING,
          outcome,
          severity: 'medium',
          coverage: { mode: 'complete' },
          evidence: [],
        },
      ],
      signals: [],
      estate: { assessed: [{ id: 'w1', name: 'prod', status: 'RUNNING' }], excluded: [] },
      measurement: [],
      footprint: new CollectionScheduler().footprint(),
      spend: [],
    });
    return store;
  }

  function decision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      controlId: FAILING,
      disposition: 'accepted',
      reason: 'Two clusters in a lab account with no customer data; the account closes in November.',
      owner: 'platform-team@example.com',
      until: new Date(Date.now() + 60 * 86_400_000).toISOString(),
      ...overrides,
    };
  }

  async function decide(url: string, body: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${url}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('refuses a decision without a forwarded user token, rather than storing an unattributed one', async () => {
    // "The risk is accepted", with nobody's name against it, is the sentence this record exists
    // to prevent.
    const url = await withDecisions();
    const { status, body } = await decide(url, decision());

    expect(status).toBe(401);
    expect(body.error).toBe('no-user-token');
  });

  it('records who decided from the token, not from the body', async () => {
    const url = await withDecisions();
    const { status, body } = await decide(url, decision({ decidedBy: 'someone.else@example.com' }), {
      'x-forwarded-access-token': 'token',
    });

    expect(status).toBe(201);
    expect(body.decidedBy).toBe('admin@example.com');
    expect(body.standing).toBe('current');
  });

  it('reports a claimed fix the latest run still finds unmet as contradicted', async () => {
    // The whole reason `fixed` is a disposition rather than a note. A fix that was attempted and
    // did not take is the most useful line in the assessment, and only the app can notice it.
    const url = await withDecisions(await ranAt(new Date(), 'fail'));
    // Recorded a moment after the run, which is the real order: read the finding, change the
    // estate, say so.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const { body } = await decide(url, decision({ disposition: 'fixed', until: undefined }), {
      'x-forwarded-access-token': 'token',
    });

    // Nothing has measured it since the claim, so the claim stands unverified for now.
    expect(body.standing).toBe('unverified');

    // A later run that still finds it failing is what contradicts it.
    const laterUrl = await withDecisions(await ranAt(new Date(Date.now() + 86_400_000), 'fail'));
    await decide(laterUrl, decision({ disposition: 'fixed', until: undefined }), {
      'x-forwarded-access-token': 'token',
    });
    const listed = (await (await fetch(`${laterUrl}/api/decisions`)).json()) as {
      decisions: { standing: string; outcome?: string; title?: string }[];
    };

    expect(listed.decisions[0]?.standing).toBe('contradicted');
    expect(listed.decisions[0]?.outcome).toBe('fail');
  });

  it('carries the requirement’s title, so a list of decisions reads without the catalogue', async () => {
    const url = await withDecisions();
    await decide(url, decision(), { 'x-forwarded-access-token': 'token' });

    const body = (await (await fetch(`${url}/api/decisions`)).json()) as {
      decisions: { title?: string; pillarId?: string; severity?: string }[];
    };

    expect(body.decisions[0]?.title).not.toBe(FAILING);
    expect(body.decisions[0]?.pillarId).toBe('data-and-ai-governance');
    expect(body.decisions[0]?.severity).toBeDefined();
  });

  it('refuses a decision with no reason, naming what to add', async () => {
    const url = await withDecisions();
    const { status, body } = await decide(url, decision({ reason: 'later' }), {
      'x-forwarded-access-token': 'token',
    });

    expect(status).toBe(400);
    expect(body.error).toBe('invalid-decision');
    expect(String(body.message)).toMatch(/at least/);
  });

  it('refuses to park a finding for longer than its severity allows', async () => {
    const url = await withDecisions();
    const { status, body } = await decide(
      url,
      decision({ until: new Date(Date.now() + 400 * 86_400_000).toISOString() }),
      { 'x-forwarded-access-token': 'token' }
    );

    expect(status).toBe(400);
    expect(String(body.message)).toMatch(/at most/);
  });

  it('keeps superseded decisions readable, rather than replacing them', async () => {
    const url = await withDecisions();
    await decide(url, decision(), { 'x-forwarded-access-token': 'token' });
    await decide(url, decision({ disposition: 'reopened', owner: undefined, until: undefined }), {
      'x-forwarded-access-token': 'token',
    });

    const body = (await (await fetch(`${url}/api/decisions/${FAILING}`)).json()) as {
      decisions: { disposition: string; supersedes?: string }[];
    };

    expect(body.decisions.map((entry) => entry.disposition)).toEqual(['reopened', 'accepted']);
    expect(body.decisions[0]?.supersedes).toBeDefined();
  });

  it('says decisions are not being kept when nothing keeps them, rather than accepting one it would lose', async () => {
    const { status, body } = await decide(appUrl, decision(), { 'x-forwarded-access-token': 'token' });

    expect(status).toBe(503);
    expect(String(body.message)).toContain('WAF_DEMO_NO_PERSISTENCE');
  });

  it('answers with an empty list and a warning when nothing is bound, so the page explains itself', async () => {
    const response = await fetch(`${appUrl}/api/decisions`);
    const body = (await response.json()) as { durable: boolean; durabilityNote?: string; decisions: unknown[] };

    expect(response.status).toBe(200);
    expect(body.durable).toBe(false);
    expect(body.durabilityNote).toBeDefined();
    expect(body.decisions).toEqual([]);
  });

  it('carries the decision into the exported spreadsheet, beside the outcome rather than instead of it', async () => {
    // The file is where a decision does most of its work: somebody hands the sheet to the team that
    // owns the requirement, and "accepted until November, by the platform team, because…" is the
    // column that stops the same conversation happening twice.
    const url = await withDecisions(await ranAt(new Date(), 'fail'));
    await decide(url, decision(), { 'x-forwarded-access-token': 'token' });

    const file = await (await fetch(`${url}/api/scans/latest/export.csv`)).text();
    const [header, ...rows] = file.split('\r\n');
    const row = rows.find((one) => one.includes(FAILING)) ?? '';
    const cell = (name: string) => row.split(',')[header.split(',').indexOf(name)];

    expect(cell('decision')).toBe('risk accepted');
    expect(cell('decision_standing')).toBe('holding');
    expect(cell('decision_owner')).toBe('platform-team@example.com');
    // Still failing, in the same row. A file that reported the outcome as anything else would be a
    // way to close a finding by agreeing with it.
    expect(cell('outcome')).toBe('fail');
  });

  it('leaves the decision columns empty when exporting an earlier run', async () => {
    /*
     * A standing is a judgement about one run. The export of a six-week-old scan is the artefact
     * somebody produces to show what the estate looked like then, and writing today's standings
     * into it would put a claim in the file that the rest of the file cannot support.
     */
    const scans = new InMemoryScanStore();
    const url = await startApp({ decisions: new InMemoryDecisionStore(), scans });
    const older = (await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url)).body;
    await decide(url, decision(), { 'x-forwarded-access-token': 'token' });
    // A second run, so the one being exported is no longer the newest.
    await post('/api/scan', { 'x-forwarded-access-token': 'token' }, url);

    const file = await (await fetch(`${url}/api/scans/${String(older.id)}/export.csv`)).text();

    expect(file).not.toContain('risk accepted');
    // And the newest one still carries it, so the emptiness above is the guard and not a bug.
    expect(await (await fetch(`${url}/api/scans/latest/export.csv`)).text()).toContain('risk accepted');
  });

  it('does not move the score, whatever anybody decided', async () => {
    // The rule the feature is safe because of. Accepting a risk does not make the estate meet the
    // requirement, so the finding keeps failing and keeps costing its points.
    const url = await withDecisions();
    const before = (await (
      await fetch(`${url}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: '{}',
      })
    ).json()) as ScanPayload<string>;

    await decide(url, decision(), { 'x-forwarded-access-token': 'token' });

    const after = (await (
      await fetch(`${url}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: '{}',
      })
    ).json()) as ScanPayload<string>;

    expect(after.score.counts).toEqual(before.score.counts);
    expect(after.findings.find((finding) => finding.controlId === FAILING)?.outcome).toBe(
      before.findings.find((finding) => finding.controlId === FAILING)?.outcome
    );
  });
});

/*
 * The gate, from outside.
 *
 * `authorize/group.test.ts` proves the decision; this proves that every route which changes
 * something asks for it, and that no route which only reads does. The second half is the one that
 * would rot silently: a gate accidentally applied to a GET turns the assessment into something only
 * the assessors can read, which is not what anybody asked for and is a change nobody would notice
 * in a unit test of the gate itself.
 */
describe('changing an assessment', () => {
  const AS_A_COLLEAGUE = ['users', 'analysts'];

  /** Every route that changes something, with a body each one accepts. */
  const mutations: readonly { readonly what: string; readonly path: string; readonly body: unknown }[] = [
    { what: 'starting a scan', path: '/api/scan', body: {} },
    { what: 'starting a scheduled scan', path: '/api/scan/scheduled', body: {} },
    { what: 'cancelling a scan', path: '/api/scan/cancel', body: {} },
    {
      what: 'answering a requirement',
      path: '/api/attestations',
      body: { controlId: 'DAG-01-01', answer: 'met', evidence: 'A paragraph long enough to be an answer.' },
    },
    {
      what: 'deciding a finding',
      path: '/api/decisions',
      body: {
        controlId: 'DAG-01-01',
        disposition: 'accepted',
        reason: 'Two clusters in a lab account with no customer data; the account closes in November.',
        owner: 'platform-team@example.com',
      },
    },
  ];

  async function send(path: string, body: unknown, url: string) {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it.each(mutations)('is refused to a colleague outside the group: $what', async ({ path, body }) => {
    const url = await startApp({
      attestations: new InMemoryAttestationStore(),
      decisions: new InMemoryDecisionStore(),
    });
    scimGroups = AS_A_COLLEAGUE;

    const response = await send(path, body, url);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not-a-member');
    expect(String(response.body.message)).toContain(ASSESSORS);
  });

  it.each(mutations)('is refused when membership cannot be established: $what', async ({ path, body }) => {
    // Deny by default, in the case that decides whether this is authorization or a courtesy: SCIM
    // answered without listing groups, so the app does not know, so the change does not happen.
    const url = await startApp({
      attestations: new InMemoryAttestationStore(),
      decisions: new InMemoryDecisionStore(),
    });
    scimGroups = undefined;

    const response = await send(path, body, url);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('membership-unknown');
  });

  it('is allowed to a member, so the gate is a gate and not a wall', async () => {
    const url = await startApp({ decisions: new InMemoryDecisionStore() });
    scimGroups = ['users', ASSESSORS];

    expect((await send('/api/scan', {}, url)).status).toBe(200);
    expect((await send('/api/scan/cancel', {}, url)).status).toBe(200);
  });

  it('refuses a stranger before the body is read, so nothing half-applies', async () => {
    // The refusal has to precede validation for the same reason attribution does: a change nobody
    // is permitted to make should not be validated, stored, or reported as invalid — a 400 would
    // tell a stranger which fields the endpoint wants.
    const url = await startApp({ decisions: new InMemoryDecisionStore() });
    scimGroups = AS_A_COLLEAGUE;

    const response = await send('/api/decisions', { nonsense: true }, url);

    expect(response.status).toBe(403);
    expect(response.body.error).toBe('not-a-member');
  });

  it('leaves nothing behind when it refuses', async () => {
    const decisions = new InMemoryDecisionStore();
    const url = await startApp({ decisions });
    scimGroups = AS_A_COLLEAGUE;

    await send(
      '/api/decisions',
      {
        controlId: 'DAG-01-01',
        disposition: 'accepted',
        reason: 'Two clusters in a lab account with no customer data; the account closes in November.',
        owner: 'platform-team@example.com',
      },
      url
    );

    expect(await decisions.current()).toEqual([]);
  });

  it('still lets an outsider read everything', async () => {
    /*
     * The half of this that is easy to break. The gate is about who may change the assessment, not
     * who may see it: an install that refused reads to everybody outside one group would stop the
     * report reaching the teams who have to act on it, which is most of the app's value.
     */
    const url = await startApp({
      attestations: new InMemoryAttestationStore(),
      decisions: new InMemoryDecisionStore(),
    });
    await send('/api/scan', {}, url);
    scimGroups = AS_A_COLLEAGUE;

    for (const path of [
      '/api/scans',
      '/api/scans/latest',
      '/api/scans/latest/export.csv',
      '/api/scan/status',
      '/api/catalogue',
      '/api/plan',
      '/api/attestations',
      '/api/decisions',
    ]) {
      expect((await fetch(`${url}${path}`)).status, path).toBe(200);
    }
  });
});

describe('asking whether a scan would run, before starting one', () => {
  async function readiness(url: string) {
    const response = await fetch(`${url}/api/scan/readiness`, {
      headers: { 'x-forwarded-access-token': 'token' },
    });
    return { status: response.status, body: (await response.json()) as ReadinessPayload };
  }

  /** The refusal, for a payload that carries one. Narrows rather than asserts, so a permitted caller fails here. */
  function refusal(payload: ReadinessPayload) {
    if (payload.may.start) throw new Error('The caller may start a scan, so there is no refusal to read.');
    return payload.may;
  }

  it('tells a member they may start one, and names what is bound', async () => {
    const url = await startApp({ durableRuns: true, warehouse: 'wh1' });
    scimGroups = ['users', ASSESSORS];

    const response = await readiness(url);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      actor: 'admin@example.com',
      group: ASSESSORS,
      may: { start: true },
      warehouse: true,
      runs: true,
    });
  });

  it('answers a caller who may not start one, rather than refusing the question', async () => {
    // The distinction the whole route rests on. A preflight is asked by the identity whose
    // permission is in doubt, so gating it behind the same permission would answer "no" to
    // everyone who needed to ask and "yes" to everyone who did not need to.
    const url = await startApp();
    scimGroups = ['users', 'analysts'];

    const response = await readiness(url);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ may: { start: false, refusal: 'not-a-member' } });
    // The gate's own sentence, not a second phrasing of it: whoever reads the failed task is who
    // has to fix the membership, and the words that say how already exist.
    expect(refusal(response.body).message).toContain(ASSESSORS);
  });

  it('separates a membership it could not establish from one it established as absent', async () => {
    const url = await startApp();
    scimGroups = undefined;

    expect((await readiness(url)).body).toMatchObject({ may: { start: false, refusal: 'membership-unknown' } });
  });

  it('says when nothing is bound to read the estate with, or to resume a run from', async () => {
    // Two different sentences on a Monday. No warehouse means the run would start and read nothing;
    // no run records means it would read the estate and could not be resumed if the app went away.
    const url = await startApp();
    scimGroups = [ASSESSORS];

    expect((await readiness(url)).body).toMatchObject({ warehouse: false, runs: false });
  });

  it('agrees with the gate about every caller, which is the only thing that makes it worth asking', async () => {
    /*
     * A preflight that disagrees with the gate is worse than none. Passing where the gate refuses
     * moves the failure to the task that has already paid the startup — the cost this exists to
     * avoid — and refusing where the gate would allow it stops an assessment that would have run.
     * So the two are held against each other for all three states of the same caller.
     */
    const url = await startApp({ warehouse: 'wh1' });

    for (const groups of [[ASSESSORS], ['users', 'analysts'], undefined]) {
      scimGroups = groups;
      const asked = await readiness(url);
      const started = await fetch(`${url}/api/scan/scheduled`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: '{}',
      });

      expect(asked.body.may.start, JSON.stringify(groups)).toBe(started.status !== 403);
    }
  });
});

describe('whether the stored records are still what was written', () => {
  const report = (over: Partial<VerificationReport> = {}): VerificationReport => ({
    checkedAt: new Date('2026-08-02T00:00:00.000Z'),
    intact: true,
    tables: [{ table: 'scans', total: 3, checked: 3, intact: 3, unstamped: 0, altered: [], unreadable: [] }],
    means: MEANS,
    ...over,
  });

  it('reports the check, with a sentence the caller does not have to compose', async () => {
    const url = await startApp({ verifyRecords: () => Promise.resolve(report()) });
    const response = await fetch(`${url}/api/records/verification`);
    const body = (await response.json()) as { checked: boolean; intact: boolean; summary: string; means: string };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ checked: true, intact: true });
    expect(body.summary).toBe(
      'All 3 stored records were checked and each one still matches the digest written with it.'
    );
    expect(body.means).toContain('not that they are authentic');
  });

  it('names the records that no longer match', async () => {
    const altered = report({
      intact: false,
      tables: [{ table: 'decisions', total: 2, checked: 2, intact: 1, unstamped: 0, altered: ['d1'], unreadable: [] }],
    });
    const url = await startApp({ verifyRecords: () => Promise.resolve(altered) });
    const body = (await (await fetch(`${url}/api/records/verification`)).json()) as {
      intact: boolean;
      summary: string;
    };

    expect(body.intact).toBe(false);
    expect(body.summary).toContain('d1');
  });

  it('says nothing is stored rather than reporting a pass, when nothing is', async () => {
    // The demo install. A vacuous "verified" here is the overclaim this endpoint exists to prevent.
    const body = (await (await fetch(`${appUrl}/api/records/verification`)).json()) as {
      checked: boolean;
      intact?: boolean;
      summary: string;
    };

    expect(body.checked).toBe(false);
    expect(body.intact).toBeUndefined();
    expect(body.summary).toContain('keeps no records');
  });

  it('fails rather than claiming a pass when the records cannot be read back', async () => {
    const url = await startApp({ verifyRecords: () => Promise.reject(new Error('connection refused')) });
    const response = await fetch(`${url}/api/records/verification`);
    const body = (await response.json()) as { error: string; message: string };

    expect(response.status).toBe(503);
    expect(body.error).toBe('verification-unavailable');
    expect(body.message).toContain('connection refused');
    expect(body.message).toContain('nothing about their integrity is being claimed');
  });

  it('is open to a caller who may not change anything, like every other read', async () => {
    scimGroups = [];
    const url = await startApp({ verifyRecords: () => Promise.resolve(report()) });
    expect((await fetch(`${url}/api/records/verification`)).status).toBe(200);
  });
});

/*
 * What reaches the log, through the real gate.
 *
 * The definition and import suites inject their own gate, which is right for testing those routes and
 * means the gate's own audit behaviour is only exercised here. The refusal is the case that matters
 * most: it is the whole reason the table was written, it happens inside `permitted` where no handler
 * can see it, and it is the one event with nothing else in the app to corroborate it.
 */
describe('the acts the gate and the scan routes record', () => {
  async function acted(audit: AuditLog) {
    return (await audit.search()).events;
  }

  it('records a refusal with the kind of refusal, before the body is read', async () => {
    const audit = new InMemoryAuditLog();
    const url = await startApp({ audit, decisions: new InMemoryDecisionStore() });
    scimGroups = ['users'];

    const response = await fetch(`${url}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ nonsense: true }),
    });
    expect(response.status).toBe(403);

    const [event] = await acted(audit);
    expect(event).toMatchObject({ action: 'decision.record', outcome: 'refused', reason: 'not-a-member' });
    // No target, because the gate refused before anything read the body that names the control.
    expect(event).not.toHaveProperty('target');
  });

  it('records a cancellation that stopped nothing as failed, rather than as a cancellation', async () => {
    // The reading an auditor takes from "somebody cancelled at 14:02" is that a run ended there, and
    // this route answers 200 with `cancelled: false` when there was no run at all.
    const audit = new InMemoryAuditLog();
    const url = await startApp({ audit });

    const response = await fetch(`${url}/api/scan/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: '{}',
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { cancelled: boolean }).cancelled).toBe(false);

    expect(await acted(audit)).toMatchObject([{ action: 'scan.cancel', outcome: 'failed', reason: 'nothing-running' }]);
  });

  it('records an export against the file it produced, correlated to the run so the two are one story', async () => {
    // The target is the artefact rather than the run, and carries the digest of the bytes served, so
    // the row answers "is the copy I was sent the copy that left". The run is the correlation, which
    // is how an export is found beside the scan it is of. ADR 0050.
    const audit = new InMemoryAuditLog();
    const url = await startApp({ audit });

    const started = (await (
      await fetch(`${url}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: '{}',
      })
    ).json()) as { id: string };
    const response = await fetch(`${url}/api/scans/${started.id}/export.csv`);
    expect(response.status).toBe(200);

    const served = createHash('sha256')
      .update(Buffer.from(await response.arrayBuffer()))
      .digest('hex');
    const exported = (await audit.search({ action: 'export.scan' })).events[0];

    expect(exported).toMatchObject({
      outcome: 'performed',
      target: { kind: 'artefact', digest: `sha256:${served}` },
      correlation: started.id,
    });
    expect(exported?.target?.id).toMatch(/^well-architected-\d{4}-\d{2}-\d{2}-.+\.csv$/);
    // The same digest travels with the bytes, so a client that downloaded need not ask again.
    expect(response.headers.get('x-export-digest')).toBe(`sha256:${served}`);
  });

  it('serves the same bytes for two downloads of one run, which is what makes the digest worth checking', async () => {
    const url = await startApp({});
    const started = (await (
      await fetch(`${url}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: '{}',
      })
    ).json()) as { id: string };

    const first = await fetch(`${url}/api/scans/${started.id}/export.json`);
    const second = await fetch(`${url}/api/scans/${started.id}/export.json`);

    expect(await second.text()).toBe(await first.text());
    expect(second.headers.get('x-export-digest')).toBe(first.headers.get('x-export-digest'));
  });
});

/*
 * What a strict install does with a change it could not have recorded.
 *
 * Here rather than in the recorder's own tests because the property being asserted is not "the
 * recorder throws" — it is that the mutation did not happen, and only a route can show that. The
 * amendment to ADR 0046 is explicit that refusing after the act would be worse than the gap, so the
 * test that matters is the one that reads the store afterwards.
 */
describe('an act that could not be recorded, on an install that refuses those', () => {
  const CONTROL = 'DG-02-01';

  /** Reachable for nothing. The shape a database that is down presents to this app. */
  const unreachable: AuditLog = {
    durable: true,
    append: () => Promise.reject(new Error('the database is unreachable')),
    head: () => Promise.reject(new Error('the database is unreachable')),
    floor: () => Promise.resolve(undefined),
    search: () => Promise.resolve({ events: [], more: false }),
    verify: () => Promise.reject(new Error('the database is unreachable')),
  };

  function decision(): Record<string, unknown> {
    return {
      controlId: CONTROL,
      disposition: 'accepted',
      reason: 'Two clusters in a lab account with no customer data; the account closes in November.',
      owner: 'platform-team@example.com',
      until: new Date(Date.now() + 60 * 86_400_000).toISOString(),
    };
  }

  async function decide(url: string) {
    const response = await fetch(`${url}/api/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify(decision()),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it('refuses the change, and does not make it', async () => {
    const decisions = new InMemoryDecisionStore();
    const url = await startApp({ audit: unreachable, auditPosture: 'strict', decisions });

    const { status, body } = await decide(url);

    expect(status).toBe(503);
    expect(body.error).toBe('trail-unwritable');
    // The assertion the setting exists for. A 503 with the decision stored anyway would be the worst
    // of both: the customer's control reports satisfied and the record it was protecting is missing.
    expect(await decisions.current()).toEqual([]);
  });

  it('names the trail rather than the caller, so nobody goes looking at their group membership', async () => {
    const url = await startApp({ audit: unreachable, auditPosture: 'strict', decisions: new InMemoryDecisionStore() });

    const { body } = await decide(url);

    expect(String(body.message)).toContain('audit trail');
    expect(String(body.message)).toContain('refuse an action it cannot record');
  });

  it('tells a caller who may not do this that, rather than blaming the database', async () => {
    // The order inside the gate. Permission first: it is the narrower answer, it is the more useful
    // one, and unlike this refusal it is an event the app can still record.
    const url = await startApp({ audit: unreachable, auditPosture: 'strict', decisions: new InMemoryDecisionStore() });
    scimGroups = ['users'];

    const { status } = await decide(url);

    expect(status).toBe(403);
  });

  it('makes the change when the trail answers, so the setting costs a reachable install nothing', async () => {
    const decisions = new InMemoryDecisionStore();
    const url = await startApp({ audit: new InMemoryAuditLog(), auditPosture: 'strict', decisions });

    const { status } = await decide(url);

    expect(status).toBe(201);
    expect((await decisions.current()).map((one) => one.controlId)).toEqual([CONTROL]);
  });

  it('leaves the default install performing the change and counting the loss', async () => {
    // The same unreachable trail, without the setting. This is ADR 0046's default and the reason it
    // is the default: a database blip does not stop somebody deciding a finding.
    const decisions = new InMemoryDecisionStore();
    const url = await startApp({ audit: unreachable, decisions });

    const { status } = await decide(url);

    expect(status).toBe(201);
    expect((await decisions.current()).map((one) => one.controlId)).toEqual([CONTROL]);
  });
});

/*
 * What the assessment committed to, held against the run that just answered it.
 *
 * The reading itself is `server/programme/targets.ts` and is tested there. What is worth holding here
 * is which version's commitment a run is reported against, because that is decided by the fingerprint
 * and neither the domain nor the reading module can see it. Two revisions with opposite consequences:
 * one that only moves a target leaves the question alone and applies to the run in hand, and one that
 * moves the measurement asks something else and cannot.
 */
describe('a run held against what the assessment committed to', () => {
  const AT = new Date('2026-08-03T00:00:00Z');
  const PILLAR = 'data-and-ai-governance';
  const SOON = new Date(Date.now() + 60 * 86_400_000);
  const GONE = new Date(Date.now() - 60 * 86_400_000);

  async function committing(
    targets: readonly { pillar: string; atLeast: number; by: Date }[]
  ): Promise<{ url: string; definitions: DefinitionStore }> {
    const definitions = new InMemoryDefinitionStore();
    await definitions.create(
      define(
        {
          measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
          attribution: { name: 'Q3 platform review', owners: [] },
          targets,
        },
        'd1',
        AT,
        'author@example.com'
      )
    );
    return { url: await startApp({ definitions }), definitions };
  }

  function scan(url: string): Promise<globalThis.Response> {
    return fetch(`${url}/api/scan`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
      body: JSON.stringify({ definitionId: 'd1' }),
    });
  }

  async function targetsOf(url: string) {
    const payload = (await (await scan(url)).json()) as ScanPayload<string>;
    return payload.targets;
  }

  it('reports the commitment beside the score, in one sentence', async () => {
    const { url } = await committing([{ pillar: PILLAR, atLeast: 80, by: SOON }]);

    const targets = await targetsOf(url);

    expect(targets).toHaveLength(1);
    expect(targets?.[0]?.pillar).toBe(PILLAR);
    expect(targets?.[0]?.atLeast).toBe(80);
    expect(targets?.[0]?.due).toBe(false);
    expect(targets?.[0]?.sentence).toContain('target of 80');
  });

  it('says nothing at all when the assessment committed to nothing', async () => {
    const { url } = await committing([]);

    expect(await targetsOf(url)).toBeUndefined();
  });

  it('says nothing for a run that answers to no assessment', async () => {
    // Every run before assessment definitions existed, and every ad-hoc run since. Absent is a fact
    // rather than a gap, so there is nothing to report rather than an empty commitment to report.
    const url = await startApp();

    const payload = (await (
      await fetch(`${url}/api/scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-access-token': 'token' },
        body: JSON.stringify({}),
      })
    ).json()) as ScanPayload<string>;

    expect(payload.targets).toBeUndefined();
  });

  it('picks up a target set after the run, when the question did not change', async () => {
    // A revision that only moves a target leaves the fingerprint alone, so it is a commitment about
    // exactly the measurement this run performed. Requiring a re-run before a new target appeared
    // anywhere would mean setting one and seeing nothing.
    const { url, definitions } = await committing([]);
    const first = (await (await scan(url)).json()) as ScanPayload<string>;
    expect(first.targets).toBeUndefined();

    const stored = await definitions.get('d1');
    if (stored == null) throw new Error('the definition under test went missing');
    const revised = revise(stored, { targets: [{ pillar: PILLAR, atLeast: 70, by: SOON }] }, AT, 'author@x');
    await definitions.appendVersion('d1', revised.versions[1]);

    const again = (await (await fetch(`${url}/api/scans/${first.id}?definitionId=d1`)).json()) as ScanPayload<string>;

    expect(again.stamp.definition?.version).toBe(1);
    expect(again.targets?.[0]?.atLeast).toBe(70);
  });

  it('keeps to the run\u2019s own commitment when a later version asks a different question', async () => {
    // The other side of the same rule. Version 2 widens the window, so its targets are about a
    // measurement this run is not of, and reporting them here would hold a run against a commitment
    // made for a different question.
    const { url, definitions } = await committing([{ pillar: PILLAR, atLeast: 80, by: GONE }]);
    const first = (await (await scan(url)).json()) as ScanPayload<string>;

    const stored = await definitions.get('d1');
    if (stored == null) throw new Error('the definition under test went missing');
    const revised = revise(
      stored,
      {
        measurement: { scope: { kind: 'account' }, lookbackDays: 60 },
        targets: [{ pillar: PILLAR, atLeast: 95, by: GONE }],
      },
      AT,
      'author@x'
    );
    await definitions.appendVersion('d1', revised.versions[1]);

    const again = (await (await fetch(`${url}/api/scans/${first.id}?definitionId=d1`)).json()) as ScanPayload<string>;

    expect(again.targets?.[0]?.atLeast).toBe(80);
  });

  it('reports a passed date as a gap, and never as a miss', async () => {
    const { url } = await committing([{ pillar: PILLAR, atLeast: 100, by: GONE }]);

    const targets = await targetsOf(url);

    expect(targets?.[0]?.due).toBe(true);
    expect(targets?.[0]?.standing).toBe('gap');
    expect(targets?.[0]?.sentence.toLowerCase()).not.toContain('miss');
  });

  it('still serves the run when the definitions cannot be read', async () => {
    // A page that will not render because a definition lookup failed is worse than one without its
    // targets, which is the bargain `historyFor` already makes for the occurrence history.
    //
    // Two apps over one scan store, because a scan cannot be *started* against a store that will not
    // answer — the runner needs the definition to resolve the scope. So the run is made against a
    // working store and read back through a broken one, which is also the real shape of this failure:
    // the database went away between the run and somebody opening the page.
    const definitions = new InMemoryDefinitionStore();
    await definitions.create(
      define(
        {
          measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
          attribution: { name: 'Q3 platform review', owners: [] },
          targets: [{ pillar: PILLAR, atLeast: 80, by: SOON }],
        },
        'd1',
        AT,
        'author@example.com'
      )
    );
    const scans = new InMemoryScanStore();
    const working = await startApp({ definitions, scans });
    const first = (await (await scan(working)).json()) as ScanPayload<string>;
    expect(first.targets).toHaveLength(1);

    const broken = await startApp({
      definitions: Object.assign(Object.create(Object.getPrototypeOf(definitions) as object), definitions, {
        get: () => Promise.reject(new Error('the database is unreachable')),
      }) as DefinitionStore,
      scans,
    });

    const response = await fetch(`${broken}/api/scans/${first.id}?definitionId=d1`);
    const payload = (await response.json()) as ScanPayload<string>;

    expect(response.status).toBe(200);
    expect(payload.score.overall).toBe(first.score.overall);
    expect(payload.targets).toBeUndefined();
  });
});
