// Publishing a month, correcting one, and reading what was published.
//
// The record and its frozen bytes are tested in `monthly/publication.test.ts` and
// `monthly/document.test.ts`, the store round-trip in `monthly/store.test.ts`, and what a month is
// made of in `monthly/content.test.ts`. What only a route can get wrong is held here: the closure
// rule gating a write, the duplicate a first publication refuses, the reason a correction must carry,
// the current copy a correction must name, who a publication is attributed to, and that the read path
// serves stored bytes rather than rebuilding them.

import express, { type Request, type Response } from 'express';
import type { Server } from 'node:http';
import { afterAll, describe, expect, it } from 'vitest';
import { closeServed, servedAt } from './test-servers.js';
import type { AuditAction, AuditTarget } from '../audit/event.js';
import { AuditRecorder, closedWhenAnswered } from '../audit/record.js';
import { InMemoryAuditLog, type AuditLog } from '../store/audit-log.js';
import type { Scan, ScanStamp } from '../scan/scan.js';
import type { ScanStore, ScanSummary } from '../scan/store.js';
import { InMemoryRiskStore, type RiskStore } from '../accept/store.js';
import type { AcceptedRisk } from '../accept/risk.js';
import { InMemoryPublicationStore, type PublicationStore } from '../monthly/store.js';
import { parseMonth, type MonthId, type Publication } from '../monthly/publication.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { InMemoryReviewStore, type ReviewStore } from '../review/store.js';
import { confirmed, opened, skipped } from '../review/review.js';
import { registerPublicationRoutes, type PublishingZone } from './publication-routes.js';

const servers: Server[] = [];

afterAll(() => closeServed(servers));

// The workspace keeps its cadence in UTC for these tests, and it is early August. So July has closed
// and August has not, which is the one distinction the closure rule draws.
const NOW = new Date('2026-08-09T00:00:00.000Z');

function month(value: string): MonthId {
  const parsed = parseMonth(value);
  if (parsed === undefined) throw new Error(`test wrote a bad month: ${value}`);
  return parsed;
}

function storedPublication(id = 'pub-1', supersedes?: string): Publication {
  return {
    id,
    month: month('2026-07'),
    publishedAt: new Date('2026-08-01T09:00:00.000Z'),
    publishedBy: 'ana@example.com',
    documentVersion: 1,
    json: `{"id":"${id}"}`,
    csv: `month,publication_id\r\n2026-07,${id}`,
    digest: 'sha256:abc',
    ...(supersedes != null ? { supersedes } : {}),
  };
}

/**
 * A scan store that answers `history` with whatever it holds, and nothing else the routes read.
 *
 * The history is replaceable, because scans are kept 730 days and publications 2555: a test about a month
 * whose closing run has aged out has to publish it while the run is readable and read it back after.
 */
class FakeScans implements ScanStore {
  readonly durable = true;
  private summaries: readonly ScanSummary[];
  constructor(summaries: readonly ScanSummary[] = []) {
    this.summaries = summaries;
  }
  keepOnly(summaries: readonly ScanSummary[]): void {
    this.summaries = summaries;
  }
  save(): Promise<void> {
    return Promise.resolve();
  }
  get(): Promise<Scan | undefined> {
    return Promise.resolve(undefined);
  }
  latest(): Promise<Scan | undefined> {
    return Promise.resolve(undefined);
  }
  history(): Promise<ScanSummary[]> {
    return Promise.resolve([...this.summaries]);
  }
}

/**
 * The basis every scan here was measured on, so two months compare cleanly unless a case says otherwise.
 *
 * One basis rather than none: a summary carrying no stamp is a scan written before the app recorded one,
 * and a harness where that is the default makes every trend refuse for a reason no case is about.
 */
const BASIS: ScanStamp = {
  publicMethodology: {
    publicVersion: 1,
    manifestDigest: 'sha256:manifest',
    state: 'released',
    effectiveDate: '2026-09-01',
  },
  catalogueVersion: 'v1',
  catalogueFingerprint: 'sha256:catalogue',
  executionMode: 'on-behalf-of-user',
  actor: 'analyst@example.com',
  scope: { description: 'the account' },
  lookbackDays: 30,
  identity: {
    build: { id: '0.1.0+aaaaaaaaaaaa' },
    methodology: { id: 'sha256:method' },
    record: { id: 'codec-2' },
    sources: ['sql'],
  },
};

/**
 * A complete scan that closes the given month, which is all the trend reads a summary for.
 *
 * `null` for the stamp rather than `undefined`, because an explicit `undefined` takes the default and a
 * case asking for a scan with no recorded basis would silently get one.
 */
function closedIn(value: string, overall = 100, stamp: ScanStamp | null = BASIS): ScanSummary {
  const finished = new Date(`${value}-28T10:00:00.000Z`);
  return {
    id: `scan-${value}`,
    startedAt: finished,
    finishedAt: finished,
    state: 'complete',
    actor: 'analyst@example.com',
    executionMode: 'on-behalf-of-user',
    catalogueVersion: 'v1',
    measuredPillars: ['reliability'],
    freshPillars: ['reliability'],
    counts: { pass: 1, fail: 0, partial: 0, unmeasurable: 0, notApplicable: 0 },
    pillarScores: {},
    overall,
    ...(stamp != null ? { stamp } : {}),
  };
}

class Refused extends Error {}

interface Harness {
  readonly base: string;
  readonly publications: PublicationStore;
  readonly audit: AuditLog;
  readonly risks: RiskStore;
  readonly scans: FakeScans;
}

/**
 * A store that keeps publications in memory and says it is durable, standing in for Postgres.
 *
 * The endpoint refuses to publish where the store says it keeps nothing durable, which is the answer the
 * read path gives too — so a harness on the plain in-memory store could only test the refusal. The one
 * case that *is* about a non-durable store asks for the plain one.
 */
class StandsInForPostgres implements PublicationStore {
  readonly durable = true;
  private readonly kept = new InMemoryPublicationStore();

  publish(publication: Publication): Promise<void> {
    return this.kept.publish(publication);
  }
  ofMonth(month: MonthId, scope?: AssessmentScope): Promise<readonly Publication[]> {
    return this.kept.ofMonth(month, scope);
  }
  byId(id: string, scope?: AssessmentScope): Promise<Publication | undefined> {
    return this.kept.byId(id, scope);
  }
  months(scope?: AssessmentScope): Promise<readonly MonthId[]> {
    return this.kept.months(scope);
  }
}

class FailsFirstPublicationWrite extends StandsInForPostgres {
  private failed = false;

  override publish(publication: Publication): Promise<void> {
    if (!this.failed) {
      this.failed = true;
      return Promise.reject(new Error('publication database unavailable'));
    }
    return super.publish(publication);
  }
}

class UnreadableReviews extends InMemoryReviewStore {
  override forRun(): Promise<never> {
    return Promise.reject(new Error('review database unavailable'));
  }
}

class MissingResultReviews extends InMemoryReviewStore {
  override async forRun(runId: string, scope?: AssessmentScope) {
    const record = await super.forRun(runId, scope);
    return record == null ? undefined : { ...record, result: undefined };
  }
}

async function serve(
  over: {
    readonly omitStore?: boolean;
    readonly keepsNothing?: boolean;
    readonly publications?: PublicationStore;
    readonly permit?: boolean;
    readonly timezone?: PublishingZone;
    readonly scans?: readonly ScanSummary[];
    /** Explicitly models an installation with no review capability. */
    readonly omitReviews?: boolean;
    /** The reviews publish is held on. Tests not about that gate receive completed reviews. */
    readonly reviews?: ReviewStore;
    readonly pillars?: readonly string[];
  } = {}
): Promise<Harness> {
  const app = express();
  app.use(express.json());

  const publications =
    over.publications ?? (over.keepsNothing === true ? new InMemoryPublicationStore() : new StandsInForPostgres());
  const sourceScans = over.scans ?? [closedIn('2026-07')];
  const scans = new FakeScans(sourceScans);
  const risks = new InMemoryRiskStore();
  const audit = new InMemoryAuditLog();
  const recorder = new AuditRecorder(audit);
  let minted = 0;
  const known = over.pillars ?? ['reliability'];
  const reviewStore =
    over.omitReviews === true ? undefined : (over.reviews ?? (await completedReviews(sourceScans, known)));

  registerPublicationRoutes(app, {
    ...(over.omitStore === true ? {} : { publications }),
    scans,
    risks,
    ...(reviewStore != null
      ? {
          reviews: {
            store: reviewStore,
            pillars: known,
            pillarTitle: (id: string) => TITLES[id],
          },
        }
      : {}),
    timezone: () => Promise.resolve(over.timezone ?? { id: 'UTC', source: 'schedule' }),
    label: () => undefined,
    now: () => NOW,
    newId: () => `pub-${String((minted += 1))}`,
    permitted: (
      _request: Request,
      response: Response,
      action: AuditAction,
      context?: { readonly target?: AuditTarget }
    ) =>
      over.permit === false
        ? Promise.reject(new Refused('not permitted'))
        : Promise.resolve({
            actor: 'priya@example.com',
            act: closedWhenAnswered(
              recorder.begin(action, { actor: 'priya@example.com', executionMode: 'on-behalf-of-user' }, context ?? {}),
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
  return { base, publications, audit, risks, scans };
}

async function completedReviews(scans: readonly ScanSummary[], pillars: readonly string[]): Promise<ReviewStore> {
  const reviews = new InMemoryReviewStore({ pillars: [...pillars] });
  for (const scan of scans) {
    const reviewId = `review-${scan.id}`;
    await reviews.open(opened({ id: reviewId, runId: scan.id, openedBy: 'system', openedAt: scan.finishedAt }));
    for (const pillarId of pillars) {
      await reviews.record(
        confirmed(
          {
            id: `${reviewId}-${pillarId}`,
            reviewId,
            runId: scan.id,
            pillarId,
            by: 'priya@example.com',
            at: scan.finishedAt,
          },
          [...pillars]
        )
      );
    }
  }
  return reviews;
}

async function send(base: string, path: string, sent?: unknown): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    ...(sent === undefined ? {} : { body: JSON.stringify(sent) }),
  });
  return { status: response.status, body: await response.json().catch(() => undefined) };
}

async function get(
  base: string,
  path: string
): Promise<{ status: number; body: unknown; headers: Headers; text: string }> {
  const response = await fetch(`${base}${path}`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: response.status, body, headers: response.headers, text };
}

/**
 * Every act the routes recorded, oldest first: action, outcome, and the fact that identifies it.
 *
 * A performed act is identified by what it acted on — the month target; a failed one by why it was
 * refused — the reason. Both are on the event, and which one matters is what the outcome decides.
 */
async function acts(audit: AuditLog): Promise<readonly (readonly [string, string, string | undefined])[]> {
  const { events } = await audit.search();
  return [...events]
    .sort((left, right) => left.sequence - right.sequence)
    .map(
      (event) => [event.action, event.outcome, event.outcome === 'performed' ? event.target?.id : event.reason] as const
    );
}

/** The catalogue's words for the pillars these tests use, which a frozen document carries instead of ids. */
const TITLES: Readonly<Record<string, string>> = {
  reliability: 'Reliability',
  security: 'Security and compliance',
};

describe('a month whose run nobody has finished reviewing', () => {
  /** A review store holding an open review of the run that closes July, with `recorded` pillars done. */
  async function reviewing(recorded: readonly string[], pillars: readonly string[]): Promise<ReviewStore> {
    const reviews = new InMemoryReviewStore({ pillars: [...pillars] });
    await reviews.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-01') })
    );
    for (const pillarId of recorded) {
      await reviews.record(
        confirmed(
          {
            id: `pr-${pillarId}`,
            reviewId: 'rev-july',
            runId: 'scan-2026-07',
            pillarId,
            by: 'priya@example.com',
            at: new Date('2026-08-02'),
          },
          [...pillars]
        )
      );
    }
    return reviews;
  }

  const july = [closedIn('2026-07')];

  it('refuses to freeze it, and says which run and how far the review got', async () => {
    const harness = await serve({
      scans: july,
      reviews: await reviewing(['reliability'], ['reliability', 'security']),
      pillars: ['reliability', 'security'],
    });

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'review-incomplete' });
    // Recorded time and progress lead; the opaque run id belongs to technical provenance.
    expect((body as { message: string }).message).toContain('28 Jul 2026, 10:00 UTC');
    expect((body as { message: string }).message).not.toContain('scan-2026-07');
    expect((body as { message: string }).message).toContain('1 of 2 pillars');
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toHaveLength(0);
    await expect(acts(harness.audit)).resolves.toEqual([['month.publish', 'failed', 'review-incomplete']]);
  });

  it('publishes it once every pillar has a record', async () => {
    const harness = await serve({
      scans: july,
      reviews: await reviewing(['reliability', 'security'], ['reliability', 'security']),
      pillars: ['reliability', 'security'],
    });

    const { status } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(201);
  });

  it('holds a correction on the same rule, since a correction freezes bytes too', async () => {
    const reviews = new InMemoryReviewStore({ pillars: ['reliability'] });
    const harness = await serve({ scans: july, reviews, pillars: ['reliability'] });
    // Seeded as an older publication so this case isolates the correction gate.
    await harness.publications.publish(storedPublication());

    // A review opened afterwards, and unfinished. The correction is held until it is done.
    await reviews.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-05') })
    );
    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: 'pub-1',
      reason: 'The June figures were restated after a late import.',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'review-incomplete' });
  });

  it('refuses unavailable, unknown, unreadable, and missing-result states separately', async () => {
    const noStore = await serve({ scans: july, omitReviews: true });
    await expect(send(noStore.base, '/api/months/2026-07/publish')).resolves.toMatchObject({
      status: 409,
      body: { error: 'reviews-unavailable', eligibility: { eligible: false, state: 'unavailable' } },
    });

    const noRecord = await serve({ scans: july, reviews: new InMemoryReviewStore({ pillars: ['reliability'] }) });
    await expect(send(noRecord.base, '/api/months/2026-07/publish')).resolves.toMatchObject({
      status: 409,
      body: { error: 'review-unknown', eligibility: { eligible: false, state: 'unknown' } },
    });

    const unreadable = await serve({ scans: july, reviews: new UnreadableReviews({ pillars: ['reliability'] }) });
    await expect(send(unreadable.base, '/api/months/2026-07/publish')).resolves.toMatchObject({
      status: 409,
      body: { error: 'review-unreadable', eligibility: { eligible: false, state: 'unreadable' } },
    });

    const noRun = await serve({ scans: [], reviews: await reviewing([], ['reliability']) });
    await expect(send(noRun.base, '/api/months/2026-07/publish')).resolves.toMatchObject({
      status: 409,
      body: { error: 'closing-run-unknown', eligibility: { eligible: false, state: 'unknown' } },
    });

    const missingResult = new MissingResultReviews({ pillars: ['reliability'] });
    await missingResult.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-01') })
    );
    await missingResult.record(
      confirmed(
        {
          id: 'pr-reliability',
          reviewId: 'rev-july',
          runId: 'scan-2026-07',
          pillarId: 'reliability',
          by: 'priya@example.com',
          at: new Date('2026-08-02'),
        },
        ['reliability']
      )
    );
    const missing = await serve({ scans: july, reviews: missingResult });
    await expect(send(missing.base, '/api/months/2026-07/publish')).resolves.toMatchObject({
      status: 409,
      body: { error: 'review-incomplete', eligibility: { eligible: false, state: 'incomplete' } },
    });
  });

  it('answers a second publish with what is wrong with the request, not with the review', async () => {
    // The month is already published, and a review opened against its run afterwards is unfinished.
    // Sending the caller to finish it would be an instruction that changes nothing, and it would put
    // the wrong reason in the audit.
    const reviews = new InMemoryReviewStore({ pillars: ['reliability'] });
    const harness = await serve({ scans: july, reviews, pillars: ['reliability'] });
    await harness.publications.publish(storedPublication());
    await reviews.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-05') })
    );

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already-published' });
  });

  it('answers a correction of a superseded copy with the id that stands, not with the review', async () => {
    // `not-current` carries the id the page needs to recover from the race; `review-incomplete` does not,
    // so a caller told the wrong one loses the only field that would have let it retry.
    const reviews = new InMemoryReviewStore({ pillars: ['reliability'] });
    const harness = await serve({ scans: july, reviews, pillars: ['reliability'] });
    await harness.publications.publish(storedPublication());
    await reviews.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-05') })
    );

    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: 'pub-nobody-has',
      reason: 'The June figures were restated after a late import.',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not-current', current: 'pub-1' });
  });

  it('freezes the review it was gated on, naming the skipped pillars in the catalogue’s words', async () => {
    const reviews = new InMemoryReviewStore({ pillars: ['reliability', 'security'] });
    await reviews.open(
      opened({ id: 'rev-july', runId: 'scan-2026-07', openedBy: 'system', openedAt: new Date('2026-08-01') })
    );
    await reviews.record(
      confirmed(
        {
          id: 'pr-reliability',
          reviewId: 'rev-july',
          runId: 'scan-2026-07',
          pillarId: 'reliability',
          by: 'priya@example.com',
          at: new Date('2026-08-02'),
        },
        ['reliability', 'security']
      )
    );
    await reviews.record(
      skipped(
        {
          id: 'pr-security',
          reviewId: 'rev-july',
          runId: 'scan-2026-07',
          pillarId: 'security',
          by: 'priya@example.com',
          at: new Date('2026-08-03'),
        },
        ['reliability', 'security']
      )
    );
    const harness = await serve({ scans: july, reviews, pillars: ['reliability', 'security'] });

    expect((await send(harness.base, '/api/months/2026-07/publish')).status).toBe(201);

    const [publication] = await harness.publications.ofMonth(month('2026-07'));
    const document = JSON.parse(publication?.json ?? '{}') as { review?: readonly { label: string; value: string }[] };
    const skipRow = document.review?.find((fact) => fact.label === 'Pillars skipped');
    expect(skipRow?.value).toContain('Security and compliance');
    // The bytes are what a recipient reads, and `security` is an identifier rather than a sentence.
    expect(publication?.json).not.toContain('"security"');
    expect(document.review).toContainEqual({ label: 'Pillars confirmed', value: '1 of 2' });
  });

  it('tells the preview why publish is held, so the page disables the action rather than taking a 409', async () => {
    const harness = await serve({
      scans: july,
      reviews: await reviewing([], ['reliability']),
      pillars: ['reliability'],
    });

    const { body } = await get(harness.base, '/api/months/2026-07/preview');

    expect(body).toMatchObject({
      reviewId: 'rev-july',
      closingRun: { id: 'scan-2026-07', finishedAt: '2026-07-28T10:00:00.000Z' },
    });
    expect((body as { unreviewedNote?: string }).unreviewedNote).toContain('review is not finished');
    expect((body as { unreviewedNote?: string }).unreviewedNote).not.toContain('scan-2026-07');
    // And absent where nothing holds it, which the page may not read as "somebody reviewed it".
    const open = await serve({ scans: july });
    const preview = await get(open.base, '/api/months/2026-07/preview');
    expect((preview.body as { unreviewedNote?: string }).unreviewedNote).toBeUndefined();
  });
});

describe('publishing a month', () => {
  it('publishes a closed month, attributes it to the gate, and records the act against the month', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(201);
    expect(body).toMatchObject({
      id: 'pub-1',
      month: '2026-07',
      publishedAt: NOW.toISOString(),
      publishedBy: 'priya@example.com',
      documentVersion: 1,
    });
    expect((body as { digest: string }).digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toHaveLength(1);
    await expect(acts(harness.audit)).resolves.toEqual([['month.publish', 'performed', '2026-07']]);
  });

  it('records a failed write, publishes nothing, and preserves the exact retry', async () => {
    const publications = new FailsFirstPublicationWrite();
    const harness = await serve({ publications });

    const failed = await send(harness.base, '/api/months/2026-07/publish');

    expect(failed).toMatchObject({
      status: 503,
      body: {
        error: 'publication-unreadable',
        eligibility: {
          eligible: false,
          state: 'unreadable',
          reason: { action: 'Restore the failed store connection and retry this exact publication request.' },
        },
      },
    });
    await expect(publications.ofMonth(month('2026-07'))).resolves.toEqual([]);
    await expect(acts(harness.audit)).resolves.toEqual([['month.publish', 'failed', 'publication-unreadable']]);

    const retried = await send(harness.base, '/api/months/2026-07/publish');

    expect(retried.status).toBe(201);
    await expect(publications.ofMonth(month('2026-07'))).resolves.toHaveLength(1);
    await expect(acts(harness.audit)).resolves.toEqual([
      ['month.publish', 'failed', 'publication-unreadable'],
      ['month.publish', 'performed', '2026-07'],
    ]);
  });

  it('refuses to publish a development scan as Methodology Version 1', async () => {
    const { publicMethodology: _dropped, ...development } = BASIS;
    const harness = await serve({ scans: [closedIn('2026-07', 100, development)] });

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'methodology-not-released' });
    expect((body as { message: string }).message).toContain('pre-release development evidence');
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toEqual([]);
  });

  it('refuses a candidate methodology record until its release is approved', async () => {
    const candidate = {
      ...BASIS,
      publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'candidate' as const },
    };
    const harness = await serve({ scans: [closedIn('2026-07', 100, candidate)] });

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect((body as { message: string }).message).toContain('release candidate');
  });

  it('freezes only the months before the one being published, in whatever order they were published', async () => {
    /*
     * Publishing July first and June second is ordinary — a month can be published late, or a gap
     * filled after the months around it. July then belonged to June's frozen series, and `monthTrend`
     * reads the last entry as its base, so June's permanent record drew July → June under a caption
     * saying oldest first. The series is what is frozen, so nothing but a correction could undo it.
     */
    const harness = await serve({ scans: [closedIn('2026-06'), closedIn('2026-07')] });
    await send(harness.base, '/api/months/2026-07/publish');

    const { body } = await send(harness.base, '/api/months/2026-06/publish');

    const stored = await harness.publications.byId((body as { id: string }).id);
    const frozen = JSON.parse(stored?.json ?? '{}') as { trend?: readonly { month: string }[] };
    expect((frozen.trend ?? []).map((point) => point.month)).toEqual(['2026-06']);
  });

  it('refuses a month that has not closed on the zone its dates were read in', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, '/api/months/2026-08/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not-closed' });
    const { message } = body as { message: string };
    expect(message).toContain('has not ended yet in UTC, the timezone the deployed schedule carries');
    // Gone with the finding: a cadence still accumulating runs claims a schedule exists and says what it
    // will do, twenty lines from the code that defaults the zone because none does.
    expect(message).not.toContain('cadence');
    await expect(harness.publications.ofMonth(month('2026-08'))).resolves.toEqual([]);
    await expect(acts(harness.audit)).resolves.toEqual([['month.publish', 'failed', 'not-closed']]);
  });

  it('says the zone was its own default where no schedule supplied one', async () => {
    const harness = await serve({ timezone: { id: 'UTC', source: 'default' } });

    const { body } = await send(harness.base, '/api/months/2026-08/publish');

    expect((body as { message: string }).message).toContain(
      "UTC, which is this app's default because no deployed schedule supplied one"
    );
  });

  it('names the zone it was given, since that is the wall clock the month was read against', async () => {
    const harness = await serve({ timezone: { id: 'Pacific/Honolulu', source: 'schedule' } });

    const { status, body } = await send(harness.base, '/api/months/2026-08/publish');

    expect(status).toBe(409);
    expect((body as { message: string }).message).toContain(
      'Pacific/Honolulu, the timezone the deployed schedule carries'
    );
  });

  it('refuses a first publication of a month that already has one — a change is a correction', async () => {
    const harness = await serve();
    await send(harness.base, '/api/months/2026-07/publish');

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'already-published' });
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toHaveLength(1);
  });

  it('refuses a publish on an install that keeps nothing durable, and says so', async () => {
    const harness = await serve({ omitStore: true });

    const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not-durable' });
    await expect(acts(harness.audit)).resolves.toEqual([['month.publish', 'failed', 'not-durable']]);
  });

  it('refuses a caller the gate turned away, and writes nothing', async () => {
    const harness = await serve({ permit: false });

    const { status } = await send(harness.base, '/api/months/2026-07/publish');

    expect(status).toBe(403);
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toEqual([]);
    await expect(acts(harness.audit)).resolves.toEqual([]);
  });

  it('refuses a malformed month', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, '/api/months/2026-13/publish');

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'bad-month' });
  });
});

describe('a month holding two publications neither of which superseded the other', () => {
  /*
   * Finding 7's other half. The store now refuses to create this, and data written before it can hold it,
   * so the read path has to render it. It used to stamp the earlier one with a `supersededAt` taken from
   * whichever publication came next in order — on an append-only record, the read path writing a
   * supersession that never happened, which is the one thing the record type exists to make impossible.
   */
  function first(id: string, at: string): Publication {
    return {
      id,
      month: month('2026-07'),
      publishedAt: new Date(at),
      publishedBy: 'ana@example.com',
      documentVersion: 1,
      json: `{"id":"${id}"}`,
      csv: `month,publication_id\r\n2026-07,${id}`,
      digest: 'sha256:abc',
    };
  }

  async function twoFirsts(): Promise<Harness> {
    const harness = await serve();
    await harness.publications.publish(first('pub-a', '2026-08-01T09:00:00.000Z'));
    await harness.publications.publish(first('pub-b', '2026-08-01T10:00:00.000Z'));
    return harness;
  }

  it('says neither was superseded, rather than stamping the earlier from its neighbour', async () => {
    const harness = await twoFirsts();

    const standing = (await get(harness.base, '/api/months/2026-07')).body as {
      standing: readonly string[];
      publications: { id: string; current: boolean; supersededAt?: string }[];
    };

    expect(standing.publications.map((one) => one.id)).toEqual(['pub-a', 'pub-b']);
    expect(standing.publications[0]?.supersededAt).toBeUndefined();
    expect(standing.publications[1]?.supersededAt).toBeUndefined();
    expect(standing.publications.map((one) => one.current)).toEqual([true, true]);
  });

  it('reports both as standing rather than choosing one', async () => {
    const harness = await twoFirsts();

    const standing = (await get(harness.base, '/api/months/2026-07')).body as { standing: readonly string[] };

    expect(standing.standing).toEqual(['pub-a', 'pub-b']);
  });

  it('counts how many stand on the months list, and names only the last published', async () => {
    const harness = await twoFirsts();

    const { months } = (await get(harness.base, '/api/months')).body as {
      months: { month: string; publications: number; standing: number; latest: { id: string } }[];
    };

    expect(months[0]).toMatchObject({ month: '2026-07', publications: 2, standing: 2 });
    // The last in publication order, which is a fact about the order and not a claim about supersession.
    expect(months[0]?.latest.id).toBe('pub-b');
  });

  it('answers a publish that lost the race as a conflict rather than a failure', async () => {
    // The endpoint's own check refuses every duplicate it can see. This is the one it cannot: the store
    // refuses, and a reader gets a conflict that tells them to read the month again.
    const harness = await serve();
    await harness.publications.publish({ ...first('pub-a', '2026-08-01T09:00:00.000Z'), ordinal: 1 });

    // Straight at the store, because the endpoint would refuse this on its own read first.
    await expect(
      harness.publications.publish({ ...first('pub-b', '2026-08-01T10:00:00.000Z'), ordinal: 1 })
    ).rejects.toThrow(/Read the month again/);
  });
});

describe('a prior month in the frozen trend', () => {
  /*
   * The series was re-derived from live scan history at every publish, so a month's score in a later
   * month's document was whatever its closing scan read that day. Scans are kept 730 days and
   * publications 2555: once the run aged out, a month that *was* scored was drawn as "not scored" and as
   * one that did not record how it was measured. Both are false about the month — what is true is that
   * this app can no longer read the run. The score now comes from the month's own published document,
   * which is what it is on record as.
   */
  async function trendOf(
    harness: Harness,
    id: string
  ): Promise<readonly { month: string; score: string; note?: string }[]> {
    const stored = await harness.publications.byId(id);
    const frozen = JSON.parse(stored?.json ?? '{}') as {
      trend?: readonly { month: string; score: string; note?: string }[];
    };
    return frozen.trend ?? [];
  }

  it('keeps the score June published once June’s closing run has left the history', async () => {
    const harness = await serve({ scans: [closedIn('2026-06', 42), closedIn('2026-07', 61)] });
    await send(harness.base, '/api/months/2026-06/publish');

    harness.scans.keepOnly([closedIn('2026-07', 61)]);
    const { body } = await send(harness.base, '/api/months/2026-07/publish');

    const trend = await trendOf(harness, (body as { id: string }).id);
    expect(trend.map((row) => [row.month, row.score])).toEqual([
      ['2026-06', '42'],
      ['2026-07', '61'],
    ]);
    expect(trend[0]?.note).toContain('not in the scan history this app reads');
  });

  it('does not create a publication whose run recorded no methodology basis', async () => {
    // June's run is still readable and carries no stamp, so it cannot be promoted into Version 1.
    const harness = await serve({ scans: [closedIn('2026-06', 42, null), closedIn('2026-07', 61)] });
    const { status, body } = await send(harness.base, '/api/months/2026-06/publish');

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'methodology-not-released' });
    await expect(harness.publications.ofMonth(month('2026-06'))).resolves.toEqual([]);
  });

  it('draws the score June is on record as, not a rereading of June’s scan', async () => {
    const harness = await serve({ scans: [closedIn('2026-06', 42), closedIn('2026-07', 61)] });
    await send(harness.base, '/api/months/2026-06/publish');

    // June re-scanned after it was published — a carried-forward rerun, or a scan repaired and run again.
    harness.scans.keepOnly([closedIn('2026-06', 99), closedIn('2026-07', 61)]);
    const { body } = await send(harness.base, '/api/months/2026-07/publish');

    expect((await trendOf(harness, (body as { id: string }).id))[0]?.score).toBe('42');
  });
});

describe('a month published again after an exception in it ended', () => {
  /*
   * A frozen month has to be the same document whenever it is assembled, and the exceptions section is
   * the one part built from a register that keeps moving. It reads the register as of the month's close,
   * so an acceptance revoked in August is still July's exception — it covered the requirement for the
   * whole of July, and July says so. `standingOf` used to answer `revoked` on the presence of the
   * revocation whatever instant it was asked about, so a July published in August lost it.
   */
  const carried: AcceptedRisk = {
    id: 'risk-1',
    controlId: 'C1',
    ordinal: 1,
    reason: 'The review is manual until the platform team finishes the rota tooling.',
    compensatingControl: 'Both workspaces are read-only outside the platform group, checked weekly.',
    residual: 'low',
    owner: 'platform-engineering',
    effectiveFrom: new Date('2026-06-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-01T00:00:00.000Z'),
    recordedBy: 'ana@example.com',
    recordedAt: new Date('2026-06-01T00:00:00.000Z'),
  };

  async function exceptionsOf(harness: Harness, id: string): Promise<readonly { control: string }[]> {
    const stored = await harness.publications.byId(id);
    const frozen = JSON.parse(stored?.json ?? '{}') as { exceptions?: readonly { control: string }[] };
    return frozen.exceptions ?? [];
  }

  it('carries the same exception into a correction published after the acceptance was revoked', async () => {
    const harness = await serve();
    await harness.risks.record(carried);
    const { body } = await send(harness.base, '/api/months/2026-07/publish');
    const first = (body as { id: string }).id;

    // Revoked in August, after July closed and before the correction is published.
    await harness.risks.revoke({
      ...carried,
      revoked: {
        by: 'raj@example.com',
        at: new Date('2026-08-05T00:00:00.000Z'),
        reason: 'The workspace was locked down properly, so nothing is being carried any more.',
      },
    });
    const corrected = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: first,
      reason: 'A misconfigured warehouse understated the closing scan; corrected.',
    });

    expect(corrected.status).toBe(201);
    const before = await exceptionsOf(harness, first);
    expect(before.map((row) => row.control)).toEqual(['C1']);
    expect(await exceptionsOf(harness, (corrected.body as { id: string }).id)).toEqual(before);
  });

  it('leaves out one revoked inside the month, which is not the same thing', async () => {
    const harness = await serve();
    await harness.risks.record({
      ...carried,
      revoked: {
        by: 'raj@example.com',
        at: new Date('2026-07-14T00:00:00.000Z'),
        reason: 'The workspace was locked down properly, so nothing is being carried any more.',
      },
    });

    const { body } = await send(harness.base, '/api/months/2026-07/publish');

    expect(await exceptionsOf(harness, (body as { id: string }).id)).toEqual([]);
  });
});

describe('correcting a month', () => {
  async function published(harness: Harness): Promise<string> {
    const { body } = await send(harness.base, '/api/months/2026-07/publish');
    return (body as { id: string }).id;
  }

  it('supersedes the current publication, keeping the old one readable at its own digest', async () => {
    const harness = await serve();
    const first = await published(harness);

    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: first,
      reason: 'A misconfigured warehouse understated the closing scan; corrected.',
    });

    expect(status).toBe(201);
    expect(body).toMatchObject({ id: 'pub-2', supersedes: first });
    const standing = (await get(harness.base, '/api/months/2026-07')).body as {
      standing: readonly string[];
      publications: { id: string; ordinal: number; total: number; current: boolean; supersededAt?: string }[];
    };
    expect(standing.standing).toEqual(['pub-2']);
    expect(standing.publications).toHaveLength(2);
    expect(standing.publications[0]).toMatchObject({ id: first, ordinal: 1, total: 2, current: false });
    expect(standing.publications[0]?.supersededAt).toBe(NOW.toISOString());
    expect(standing.publications[1]).toMatchObject({ id: 'pub-2', ordinal: 2, total: 2, current: true });
    // The superseded copy is still served, verbatim.
    expect((await get(harness.base, `/api/months/2026-07/publications/${first}.json`)).status).toBe(200);
    await expect(acts(harness.audit)).resolves.toEqual([
      ['month.publish', 'performed', '2026-07'],
      ['month.supersede', 'performed', '2026-07'],
    ]);
  });

  it('refuses a correction with no reason', async () => {
    const harness = await serve();
    const first = await published(harness);

    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: first,
      reason: 'oops',
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({ error: 'no-reason' });
    await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toHaveLength(1);
  });

  it('refuses a correction of a month with nothing to correct', async () => {
    const harness = await serve();

    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: 'pub-none',
      reason: 'There is nothing here to correct at all.',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'nothing-to-supersede' });
  });

  it('refuses a correction that names a copy other than the one that stands', async () => {
    const harness = await serve();
    const first = await published(harness);
    await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: first,
      reason: 'The first correction, which moves the current copy on.',
    });

    const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
      supersedes: first,
      reason: 'A second correction still naming the original, which is no longer current.',
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: 'not-current', current: 'pub-2' });
  });
});

describe('reading what was published', () => {
  it('serves the stored JSON bytes verbatim, with their digest, as a download', async () => {
    const harness = await serve();
    const { body: result } = await send(harness.base, '/api/months/2026-07/publish');
    const { id, digest } = result as { id: string; digest: string };

    const served = await get(harness.base, `/api/months/2026-07/publications/${id}.json`);

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('application/json');
    expect(served.headers.get('content-disposition')).toContain('attachment');
    expect(served.headers.get('x-export-digest')).toBe(digest);
    // Byte-for-byte what the store holds, not a rebuild.
    const stored = await harness.publications.byId(id);
    expect(served.text).toBe(stored?.json);
  });

  it('serves the CSV bytes verbatim too', async () => {
    const harness = await serve();
    const { body: result } = await send(harness.base, '/api/months/2026-07/publish');
    const { id } = result as { id: string };

    const served = await get(harness.base, `/api/months/2026-07/publications/${id}.csv`);

    expect(served.status).toBe(200);
    expect(served.headers.get('content-type')).toContain('text/csv');
    const stored = await harness.publications.byId(id);
    expect(served.text).toBe(stored?.csv);
  });

  it('lists the months that have been published, newest first', async () => {
    const harness = await serve({ scans: [closedIn('2026-06'), closedIn('2026-07')] });
    await send(harness.base, '/api/months/2026-06/publish');
    await send(harness.base, '/api/months/2026-07/publish');

    const { body } = await get(harness.base, '/api/months');

    expect(body).toMatchObject({ durable: true, currentMonth: '2026-08', zone: { id: 'UTC', source: 'schedule' } });
    const months = (body as { months: { month: string }[] }).months.map((one) => one.month);
    expect(months).toEqual(['2026-07', '2026-06']);
  });

  it('answers a month nobody has published as durable but empty', async () => {
    const harness = await serve();

    const { status, body } = await get(harness.base, '/api/months/2026-07');

    expect(status).toBe(200);
    expect(body).toMatchObject({ month: '2026-07', durable: true, publications: [] });
    expect((body as { current?: string }).current).toBeUndefined();
  });

  it('reports no publish path on an install that keeps nothing durable', async () => {
    const harness = await serve({ omitStore: true });

    const { body } = await get(harness.base, '/api/months');

    expect(body).toMatchObject({ durable: false, months: [], currentMonth: '2026-08' });
  });

  describe('the live preview', () => {
    it('assembles a closed month without writing, and carries no digest', async () => {
      const harness = await serve({ scans: [closedIn('2026-07', 72)] });

      const { status, body } = await get(harness.base, '/api/months/2026-07/preview');

      expect(status).toBe(200);
      expect(body).toMatchObject({
        month: '2026-07',
        label: 'July 2026',
        durable: true,
        closed: true,
        zone: { id: 'UTC', source: 'schedule' },
      });
      expect((body as { digest?: string }).digest).toBeUndefined();
      expect((body as { closedNote?: string }).closedNote).toBeUndefined();
      const content = (body as { content: { outcomes: { label: string; value: string }[]; trend: unknown[] } }).content;
      expect(content.outcomes.some((row) => row.label === 'Met' && row.value === '1')).toBe(true);
      expect(await harness.publications.ofMonth(month('2026-07'))).toEqual([]);
    });

    it('names why an open month cannot be published yet, and when it can', async () => {
      const harness = await serve();

      const { body } = await get(harness.base, '/api/months/2026-08/preview');

      expect(body).toMatchObject({
        month: '2026-08',
        closed: false,
        availableFrom: '1 September 2026',
      });
      expect((body as { closedNote: string }).closedNote).toContain('has not ended yet');
      expect((body as { closedNote: string }).closedNote).toContain('UTC, the timezone the deployed schedule carries');
    });

    it('does not call the selected run a closing run while the month is open', async () => {
      const candidate = {
        ...BASIS,
        publicMethodology: { publicVersion: 1, manifestDigest: 'sha256:manifest', state: 'candidate' as const },
      };
      const harness = await serve({ scans: [closedIn('2026-08', 100, candidate)] });

      const { body } = await get(harness.base, '/api/months/2026-08/preview');
      const preview = body as { methodologyNote: string; eligibility: { reason: { message: string } } };

      expect(preview.methodologyNote).toContain(
        'currently uses the run finished 28 Aug 2026, 10:00 UTC in this preview'
      );
      expect(preview.methodologyNote).not.toContain('scan-2026-08');
      expect(preview.eligibility.reason.message).toBe(preview.methodologyNote);
      expect(preview.methodologyNote).not.toContain('closed on run');
    });

    it('still previews when the install cannot keep a publication', async () => {
      const harness = await serve({ omitStore: true, scans: [closedIn('2026-07')] });

      const { status, body } = await get(harness.base, '/api/months/2026-07/preview');

      expect(status).toBe(200);
      expect(body).toMatchObject({ month: '2026-07', durable: false, closed: true });
    });

    it('refuses a month that is not YYYY-MM', async () => {
      const harness = await serve();

      const { status, body } = await get(harness.base, '/api/months/2026-13/preview');

      expect(status).toBe(400);
      expect(body).toMatchObject({ error: 'bad-month' });
    });

    it('matches the content a publish would freeze, while nothing live has moved', async () => {
      const harness = await serve({ scans: [closedIn('2026-07', 64)] });

      const preview = (await get(harness.base, '/api/months/2026-07/preview')).body as {
        content: { outcomes: unknown; trend: unknown };
      };
      const published = await send(harness.base, '/api/months/2026-07/publish');
      const id = (published.body as { id: string }).id;
      const frozen = JSON.parse((await get(harness.base, `/api/months/2026-07/publications/${id}.json`)).text) as {
        outcomes: unknown;
        trend: unknown;
      };

      expect(frozen.outcomes).toEqual(preview.content.outcomes);
      expect(frozen.trend).toEqual(preview.content.trend);
    });
  });

  /*
   * `durable` was hardcoded `true` whenever a store was present, so the field that exists to answer this
   * question was not the field being read — and the test asserted `true` against the in-memory store, which
   * guaranteed the wrong answer if that store were ever wired. The wiring gives an in-memory install no
   * store at all, so this is about the claim rather than about a case in production today.
   */
  describe('a store that is there and keeps nothing that survives a restart', () => {
    it('reports what the store says rather than that a store exists', async () => {
      const harness = await serve({ keepsNothing: true });

      expect(await get(harness.base, '/api/months')).toMatchObject({ body: { durable: false, months: [] } });
      expect(await get(harness.base, '/api/months/2026-07')).toMatchObject({ body: { durable: false } });
    });

    it('refuses to publish into it, because the read path and the write path make one claim', async () => {
      const harness = await serve({ keepsNothing: true });

      const { status, body } = await send(harness.base, '/api/months/2026-07/publish');

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'not-durable' });
      expect((body as { message: string }).message).toContain('nothing that survives a restart');
      await expect(harness.publications.ofMonth(month('2026-07'))).resolves.toEqual([]);
    });

    it('refuses a correction into it as well', async () => {
      const harness = await serve({ keepsNothing: true });

      const { status, body } = await send(harness.base, '/api/months/2026-07/supersede', {
        supersedes: 'pub-1',
        reason: 'A misconfigured warehouse understated the closing scan; corrected.',
      });

      expect(status).toBe(409);
      expect(body).toMatchObject({ error: 'not-durable' });
    });
  });
});
