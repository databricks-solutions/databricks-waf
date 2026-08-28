// The stores against a real Lakebase database.
//
// Skipped unless `LAKEBASE_ENDPOINT` is set, so `npm test` on a laptop with no database bound is
// unaffected and CI does not need a credential. Run it deliberately, against an Autoscaling
// project:
//
//   DATABRICKS_CONFIG_PROFILE=your-profile \
//   LAKEBASE_ENDPOINT=projects/<project>/branches/<branch>/endpoints/primary \
//   PGHOST=<endpoint host> PGDATABASE=databricks_postgres \
//   npx vitest run server/store/postgres.live.test.ts
//
// or against a Provisioned instance, which has no project path and so is named by its host alone:
//
//   DATABRICKS_CONFIG_PROFILE=your-profile \
//   LAKEBASE_ENDPOINT=<instance>.database.<region>.cloud.databricks.com \
//   npx vitest run server/store/postgres.live.test.ts
//
// Why it exists when `postgres-fake.ts` already covers the same stores: the fake models one type,
// jsonb, and models nothing else. Everything the wire does — a Date arriving back as a Date from a
// timestamptz column, `on conflict` against a real primary key, `order by` over a real index, a
// jsonb document surviving a round trip with its nesting intact — is exactly what a fake cannot
// prove and what breaks in production when a statement is wrong. This is the test that would have
// caught it, and the one to run when the fake's strict matching rejects a new statement.
//
// It creates its own schema, named per run, and drops it at the end, so two people running it at
// once do not collide and a failed run leaves at most one empty schema behind.
//
// # Nothing runs this on a schedule, and something notices when it is stale
//
// Two assertions here were wrong from #138 until `46b` ran the file for an unrelated reason five
// months later, because a file that skips unless an endpoint is bound is a file whose result is
// unknown between the times somebody remembers it. So it is still run by hand — CI has no Lakebase
// and a pull request from a fork cannot be given one — and `npm run test:live` runs it and records
// what passed, against a digest of the SQL it drove. `check:live-suite` fails `npm run verify` when
// that SQL has moved since. ADR 0090 records the decision and why the two alternatives were not
// taken.
//
// The recording also names what this file does not reach — it drives about half the modules that
// emit SQL against Postgres, and `uncovered` in the recording is the rest, which the fake alone
// stands behind. Adding a store here enrols it in the gate, because the covered set is read from
// the imports below rather than from a list somewhere else.
//
// # Why this file alone gets ninety seconds a test
//
// Every assertion here is a round trip to another region, and the reset is thirty-odd of them in
// sequence because that is what emptying every table is. At the default five seconds the tests that
// pass and the tests that fail are separated by the weather, which is worse than no test: a suite that
// fails for reasons unrelated to the code is a suite people learn to ignore. Ninety seconds is not
// generosity, it is the point past which something is actually wrong rather than merely far away — and
// it is set here rather than in `vitest.config.ts` because a unit test needing more than five seconds
// is a unit test with a bug in it.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pg from 'pg';
import { ensureSchema, openPostgres, SCHEMA_ENV, type Postgres, type Sql } from './postgres.js';
import { PostgresAuditLog } from './audit-log.js';
import { GENESIS, type AuditEvent } from '../audit/event.js';
import { describeVerification, RECORD_TABLES, verifyRecords } from '../records/verify.js';
import { PostgresScanStore } from '../scan/postgres-store.js';
import { PostgresPlanExtractStore, type RetainedPlan } from '../advise/plan-store.js';
import type { PlanExtract } from '../collect/sql/plans/parse.js';
import { PostgresAttestationStore } from '../attest/postgres-store.js';
import { PostgresDecisionStore } from '../decide/store.js';
import { PostgresDefinitionStore } from '../define/postgres-store.js';
import { PostgresImprovementStore } from '../improve/postgres-store.js';
import { ConcurrentChangeError } from '../improve/store.js';
import type { ImprovementAction } from '../improve/action.js';
import { PostgresRetentionGateway, PostgresRetentionStore } from '../admin/retention-store.js';
import { DEFAULT_PERIOD_DAYS, DEFAULT_POLICY, RETAINED, RETENTION_CLASSES, planRetention } from '../admin/retention.js';
import { PostgresRunStore, type Opening } from '../run/run-store.js';
import { joinable, resumeFrom, sameRequest, type RunRequest } from '../run/run.js';
import { observed, type SignalId } from '../collect/signal.js';
import { planReset, resetInstall } from '../admin/reset.js';
import { PostgresSetupDraftStore } from '../define/setup-postgres-store.js';
import { define, revise, type Draft } from '../define/definition.js';
import { DefinitionConflict } from '../define/store.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Scan } from '../scan/scan.js';
import type { Attestation } from '../attest/attestation.js';
import type { Decision } from '../decide/decision.js';
import { PostgresValidationStore } from '../validate/postgres-store.js';
import { answeredBy, type ValidationAttempt } from '../validate/attempt.js';
import { PostgresNoteStore } from '../note/postgres-store.js';
import { PostgresEvidenceImportStore } from '../import/store.js';
import { PostgresReviewStore } from '../review/postgres-store.js';
import { confirmed, opened, skipped } from '../review/review.js';
import { finalAssessmentProjector } from '../review/projection.js';
import { PostgresServingStore } from '../foundation/serving-postgres-store.js';
import { nextDeclaration } from '../foundation/serving-store.js';
import type { ServingDraft } from '../foundation/serving-asset.js';
import { PostgresPublicationStore } from '../monthly/store.js';
import { parseMonth, type Publication } from '../monthly/publication.js';
import { envelope } from '../import/envelope-fixture.js';
import { envelopeFrom } from '../import/envelope.js';
import { digestOf } from '../import/trust.js';
import { fromBytes } from '../records/digest.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { resolveControl, ResolverRegistry } from '../resolve/resolver.js';
import { scoreFindings } from '../score/score.js';

vi.setConfig({ testTimeout: 90_000, hookTimeout: 90_000 });

const ENDPOINT = (process.env.LAKEBASE_ENDPOINT ?? '').trim();
const bound = ENDPOINT !== '';

/** A schema this run owns, so a second run in parallel does not read or drop its rows. */
const SCHEMA = `waf_live_${String(Date.now())}_${String(process.pid)}`;

/**
 * A pool against whichever kind of Lakebase the endpoint names.
 *
 * An Autoscaling endpoint is a `projects/.../endpoints/...` path, which `@databricks/lakebase`
 * resolves for us. A Provisioned instance has no such path: it is a host, and the connection is an
 * ordinary Postgres one whose password is an OAuth token. Both are Lakebase and both are worth
 * running these checks against, so the shape of the value decides the route rather than a second
 * env var somebody has to remember to set.
 */
async function open(schema: string): Promise<Postgres> {
  const env = { ...process.env, [SCHEMA_ENV]: schema };
  return ENDPOINT.includes('/') ? openPostgres({ env }) : openPostgres({ env, connect: connectDirect });
}

async function connectDirect(): Promise<Sql> {
  const profile = process.env.DATABRICKS_CONFIG_PROFILE ?? 'DEFAULT';
  const cli = (args: readonly string[]): Record<string, unknown> =>
    JSON.parse(execFileSync('databricks', [...args, '-p', profile], { encoding: 'utf8' })) as Record<string, unknown>;

  const client = new pg.Client({
    host: ENDPOINT,
    port: 5432,
    database: process.env.PGDATABASE ?? 'databricks_postgres',
    // The Postgres role is the Databricks identity, and the password is a short-lived token for it.
    user: String(cli(['current-user', 'me', '-o', 'json']).userName),
    password: String(cli(['auth', 'token']).access_token),
    ssl: true,
  });
  await client.connect();
  const query = <T = Record<string, unknown>>(text: string, values?: readonly unknown[]) =>
    client.query<T extends pg.QueryResultRow ? T : never>(text, values as unknown[]) as Promise<{ rows: T[] }>;

  return {
    query,
    // One client rather than a pool, so the transaction is the statements themselves. The pooled
    // implementation in `postgres.ts` has to check a connection out first; here there is only one.
    session: async (run) => {
      await query('begin');
      try {
        const answer = await run({ query });
        await query('commit');
        return answer;
      } catch (cause) {
        await query('rollback').catch(() => undefined);
        throw cause;
      }
    },
    end: () => client.end(),
  } as Sql;
}

function act(id: string, event: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id,
    at: new Date(),
    actor: 'someone@example.com',
    executionMode: 'on-behalf-of-user',
    action: 'scan.start',
    outcome: 'performed',
    ...event,
  };
}

function scan(id: string, startedAt: string, overall: number): Scan {
  const started = new Date(startedAt);
  return {
    id,
    startedAt: started,
    finishedAt: new Date(started.getTime() + 60_000),
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
      overall,
      pillars: [],
      counts: { pass: 1, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 1,
      composition: { observed: 1, 'admin-collected': 0, attested: 0 },
      totalControls: 1,
    },
    findings: [],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function attestation(id: string, attestedAt: string, supersedes?: string): Attestation {
  return {
    id,
    controlId: 'OE-02-04',
    answer: 'met',
    statement: 'A live test wrote this, and it is long enough to be a real statement.',
    owner: 'platform-team@example.com',
    attestedBy: 'someone@example.com',
    attestedAt: new Date(attestedAt),
    reviewBy: new Date(new Date(attestedAt).getTime() + 86_400_000),
    ...(supersedes != null ? { supersedes } : {}),
  };
}

const projectionCatalogue = loadCatalogue();
const projectionRegistry = new ResolverRegistry();
const projectionProjector = finalAssessmentProjector({
  catalogue: projectionCatalogue,
  registry: projectionRegistry,
});
const projectionControl =
  projectionCatalogue.controls.find((one) => one.id === 'OE-01-01') ??
  (() => {
    throw new Error('The live projection fixture requires OE-01-01.');
  })();
const projectionPillars = projectionCatalogue.pillars.map((one) => one.id);

function projectionAttestation(definitionId: string): Attestation {
  return {
    id: 'live-projected-attestation',
    controlId: projectionControl.id,
    answer: 'met',
    statement: 'The live Lakebase projection fixture records this customer answer.',
    owner: 'platform-team@example.com',
    attestedBy: 'someone@example.com',
    attestedAt: new Date('2026-07-29T00:01:00.000Z'),
    reviewBy: new Date('2026-12-01T00:00:00.000Z'),
    definitionId,
  };
}

function projectionScan(
  definition: {
    readonly id: string;
    readonly version: number;
    readonly fingerprint: string;
  },
  id = 'live-projected-run'
): Scan {
  const startedAt = new Date('2026-07-29T00:00:00.000Z');
  const finishedAt = new Date('2026-07-29T00:05:00.000Z');
  const evidence = projectionAttestation(definition.id);
  const finding = resolveControl(projectionControl, new Map(), undefined, evidence);
  return {
    id,
    startedAt,
    finishedAt,
    state: 'complete',
    stamp: {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:live-public-methodology-version-1',
        state: 'candidate',
      },
      catalogueVersion: projectionCatalogue.version.version,
      catalogueFingerprint: projectionCatalogue.version.fingerprint,
      executionMode: 'on-behalf-of-user',
      actor: 'someone@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
      definition,
      identity: {
        build: { id: '0.1.0+live-projection-test' },
        methodology: { id: 'sha256:live-scoring' },
        record: { id: 'codec-4' },
        sources: [],
      },
    },
    score: scoreFindings([finding]),
    findings: [finding],
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [
      {
        pillarId: projectionControl.pillarId,
        scanId: id,
        measuredAt: finishedAt,
        actor: 'someone@example.com',
        carriedForward: false,
      },
    ],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function decision(id: string, decidedAt: string): Decision {
  return {
    id,
    controlId: 'OE-02-04',
    disposition: 'accepted',
    reason: 'A live test wrote this, and it is long enough to be a real reason.',
    decidedBy: 'someone@example.com',
    decidedAt: new Date(decidedAt),
    until: new Date(new Date(decidedAt).getTime() + 86_400_000),
  };
}

describe.skipIf(!bound)('the stores against a real Lakebase database', () => {
  let db: Postgres;

  beforeAll(async () => {
    db = await open(SCHEMA);
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    // Cascade because the tables are this schema's; nothing outside it depends on them.
    await db.query(`drop schema if exists ${SCHEMA} cascade`);
    await db.end();
  }, 60_000);

  it('creates the schema it was told to, rather than the default', () => {
    expect(db.schema).toBe(SCHEMA);
  });

  it('adds the Version 2 result handles and constraints while a legacy result still round-trips', async () => {
    const columns = await db.query<{ table_name: string; column_name: string; is_nullable: string }>(
      `select table_name, column_name, is_nullable
         from information_schema.columns
        where table_schema = $1
          and table_name in ('assessment_reviews', 'assessment_results')`,
      [SCHEMA]
    );
    const named = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}:${row.is_nullable}`));
    for (const column of [
      'assessment_reviews.definition_version:YES',
      'assessment_reviews.definition_fingerprint:YES',
      'assessment_results.schema_version:YES',
      'assessment_results.run_id:YES',
      'assessment_results.definition_version:YES',
      'assessment_results.definition_fingerprint:YES',
      'assessment_results.public_methodology_version:YES',
      'assessment_results.catalogue_revision:YES',
      'assessment_results.eligible:YES',
    ]) {
      expect(named.has(column), column).toBe(true);
    }

    const constraints = await db.query<{ conname: string }>(
      `select c.conname
         from pg_constraint c
         join pg_class t on t.oid = c.conrelid
         join pg_namespace n on n.oid = t.relnamespace
        where n.nspname = $1 and t.relname = 'assessment_results'`,
      [SCHEMA]
    );
    for (const constraint of [
      'assessment_results_review_fk',
      'assessment_results_run_fk',
      'assessment_results_definition_version_fk',
      'assessment_results_schema_version_positive',
      'assessment_results_eligible_complete',
    ]) {
      expect(
        constraints.rows.some((row) => row.conname === constraint),
        constraint
      ).toBe(true);
    }

    const indexes = await db.query<{ indexdef: string }>(
      `select indexdef
         from pg_indexes
        where schemaname = $1 and tablename = 'assessment_results'`,
      [SCHEMA]
    );
    expect(
      indexes.rows.some(
        (row) =>
          /create unique index assessment_results_of_review/i.test(row.indexdef) && /\(review_id\)/i.test(row.indexdef)
      )
    ).toBe(true);

    const runs = new PostgresScanStore({ db });
    // Earlier than the history fixtures below: this suite shares one disposable schema, so a
    // contract fixture must not silently become the newest scan that another store test reads.
    await runs.save(scan('live-final-assessment-run', '2026-07-31T00:00:00.000Z', 100));
    const pillars = ['security-compliance-and-privacy', 'reliability'] as const;
    const reviews = new PostgresReviewStore({ db, pillars });
    const review = opened({
      id: 'live-final-assessment-review',
      runId: 'live-final-assessment-run',
      openedBy: 'someone@example.com',
      openedAt: new Date('2026-07-31T00:01:00.000Z'),
    });
    await reviews.open(review);
    await reviews.record(
      confirmed(
        {
          id: 'live-final-assessment-security',
          reviewId: review.id,
          runId: review.runId,
          pillarId: pillars[0],
          by: 'someone@example.com',
          at: new Date('2026-07-31T00:02:00.000Z'),
          attestationIds: [],
        },
        pillars
      )
    );
    const completed = await reviews.record(
      skipped(
        {
          id: 'live-final-assessment-reliability',
          reviewId: review.id,
          runId: review.runId,
          pillarId: pillars[1],
          by: 'someone@example.com',
          at: new Date('2026-07-31T00:03:00.000Z'),
        },
        pillars
      )
    );
    expect(completed.result).toMatchObject({
      runId: 'live-final-assessment-run',
      reviewId: 'live-final-assessment-review',
    });
    expect(completed.result?.schemaVersion).toBeUndefined();

    await runs.save(scan('live-final-assessment-guard-run', '2026-07-30T00:00:00.000Z', 100));
    await reviews.open(
      opened({
        id: 'live-final-assessment-guard-review',
        runId: 'live-final-assessment-guard-run',
        openedBy: 'someone@example.com',
        openedAt: new Date('2026-07-30T00:01:00.000Z'),
      })
    );
    const insertGuardProbe = (
      id: string,
      runId: string | null,
      definitionId: string | null,
      definitionVersion: number | null,
      schemaVersion: number | null,
      eligible: boolean | null
    ) => {
      const body = { id, reviewId: 'live-final-assessment-guard-review' };
      return db.query(
        `insert into ${SCHEMA}.assessment_results
           (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version,
            schema_version, eligible)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          id,
          body.reviewId,
          runId,
          new Date('2026-07-30T00:02:00.000Z'),
          JSON.stringify(body),
          digestOf(body),
          definitionId,
          definitionVersion,
          schemaVersion,
          eligible,
        ]
      );
    };

    await expect(
      insertGuardProbe('live-incomplete-eligible-result', 'live-final-assessment-guard-run', null, null, 2, true)
    ).rejects.toMatchObject({ constraint: 'assessment_results_eligible_complete' });
    await expect(
      insertGuardProbe('live-missing-run-result', 'missing-run', null, null, null, null)
    ).rejects.toMatchObject({ constraint: 'assessment_results_run_fk' });
    await expect(
      insertGuardProbe(
        'live-missing-definition-result',
        'live-final-assessment-guard-run',
        'missing-definition',
        1,
        null,
        null
      )
    ).rejects.toMatchObject({ constraint: 'assessment_results_definition_version_fk' });
  });

  it('locks and projects a Version 2 result atomically, preserving retry identity and rolling back failure', async () => {
    const definitions = new PostgresDefinitionStore({ db });
    const definition = define(
      {
        measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
        attribution: { name: 'Live projected assessment', owners: ['someone@example.com'] },
      },
      'live-projected-definition',
      new Date('2026-07-28T00:00:00.000Z'),
      'someone@example.com'
    );
    await definitions.create(definition);
    const version = definition.versions[0];
    if (version == null) throw new Error('The projected definition has no first version.');
    const definitionIdentity = {
      id: definition.id,
      version: version.version,
      fingerprint: version.fingerprint,
    };

    const scans = new PostgresScanStore({ db });
    const source = projectionScan(definitionIdentity);
    await scans.save(source);
    const evidence = projectionAttestation(definition.id);
    await new PostgresAttestationStore({ db }).record(evidence);

    const reviews = new PostgresReviewStore({
      db,
      pillars: projectionPillars,
      projector: projectionProjector,
      newId: () => 'live-projected-result',
    });
    const review = opened({
      id: 'live-projected-review',
      runId: source.id,
      openedBy: 'someone@example.com',
      openedAt: new Date('2026-07-29T00:06:00.000Z'),
      definitionId: definitionIdentity.id,
      definitionVersion: definitionIdentity.version,
      definitionFingerprint: definitionIdentity.fingerprint,
    });
    await reviews.open(review);
    for (const pillarId of projectionPillars.filter((one) => one !== projectionControl.pillarId)) {
      await reviews.record(
        skipped(
          {
            id: `live-projected-decision-${pillarId}`,
            reviewId: review.id,
            runId: review.runId,
            pillarId,
            by: 'someone@example.com',
            at: new Date('2026-07-29T00:07:00.000Z'),
          },
          projectionPillars
        )
      );
    }
    const terminal = confirmed(
      {
        id: `live-projected-decision-${projectionControl.pillarId}`,
        reviewId: review.id,
        runId: review.runId,
        pillarId: projectionControl.pillarId,
        by: 'someone@example.com',
        at: new Date('2026-07-29T00:08:00.000Z'),
        attestationIds: [evidence.id],
      },
      projectionPillars
    );

    const [first, concurrent] = await (async () => {
      const concurrentDb = await open(SCHEMA);
      try {
        const concurrentReviews = new PostgresReviewStore({
          db: concurrentDb,
          pillars: projectionPillars,
          projector: projectionProjector,
          newId: () => 'live-projected-result',
        });
        return await Promise.all([reviews.record(terminal), concurrentReviews.record(terminal)]);
      } finally {
        await concurrentDb.end();
      }
    })();
    const retried = await reviews.record(terminal);

    expect(first.result?.schemaVersion).toBe(2);
    expect(concurrent.result).toEqual(first.result);
    expect(retried.result).toEqual(first.result);
    expect((await reviews.get(review.id))?.result).toEqual(first.result);
    const stored = await db.query<{
      id: string;
      review_id: string;
      run_id: string;
      definition_version: number;
      definition_fingerprint: string;
      schema_version: number;
      public_methodology_version: number;
      catalogue_revision: string;
      eligible: boolean;
      body: unknown;
      digest: string;
    }>(
      `select id, review_id, run_id, definition_version, definition_fingerprint, schema_version,
              public_methodology_version, catalogue_revision, eligible, body, digest
         from ${SCHEMA}.assessment_results where review_id = $1`,
      [review.id]
    );
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      id: 'live-projected-result',
      review_id: review.id,
      run_id: source.id,
      definition_version: definitionIdentity.version,
      definition_fingerprint: definitionIdentity.fingerprint,
      schema_version: 2,
      public_methodology_version: 1,
      catalogue_revision: projectionCatalogue.version.version,
      eligible: false,
    });
    expect(stored.rows[0]?.digest).toBe(digestOf(stored.rows[0]?.body));

    /*
     * One customer lifecycle over the stores that used to be proved only one at a time.
     *
     * The final assessment is the identity for a report and a month publication. The plan deliberately keeps
     * the raw run as its baseline, while the serving declaration and publication keep the assessment
     * definition. Re-opening the database below is the process-restart boundary: none of these reads
     * may be satisfied by an object the writer still holds in memory.
     */
    const servingDraft: ServingDraft = {
      named: [{ catalog: 'main', schema: 'gold', table: 'orders' }],
      tagged: [],
      requiredTagKeys: [],
      requiredMetadata: ['description', 'owner'],
      policy: [],
    };
    const serving = new PostgresServingStore({ db });
    const declaration = nextDeclaration(
      servingDraft,
      undefined,
      'someone@example.com',
      new Date('2026-07-29T00:09:00.000Z'),
      definition.id
    );
    await serving.declare(declaration);

    const improvements = new PostgresImprovementStore({ db });
    const lifecyclePlan = {
      id: 'live-customer-lifecycle-plan',
      title: 'Automate the remaining jobs',
      outcome: 'Every manually started job runs from a platform trigger.',
      owners: ['platform@example.com'],
      assessment: { definitionId: definition.id, version: version.version },
      raisedFrom: source.id,
      createdBy: 'someone@example.com',
      createdAt: new Date('2026-07-29T00:10:00.000Z'),
      revision: 0,
    };
    await improvements.addPlan(lifecyclePlan);
    const lifecycleDraft: ImprovementAction = {
      id: 'live-customer-lifecycle-action',
      planId: lifecyclePlan.id,
      controlIds: [projectionControl.id],
      outcome: 'The remaining manually started job runs from a Databricks workflow.',
      definitionOfDone: 'A later assessment reads an active schedule or file-arrival trigger.',
      owner: 'platform@example.com',
      priority: 'now',
      effort: 'small',
      due: new Date('2026-09-30T23:59:59.999Z'),
      steps: ['Open the job.', 'Set its trigger.', 'Run the assessment again.'],
      dependsOn: [],
      raisedFrom: source.id,
      state: 'draft',
      createdBy: 'someone@example.com',
      createdAt: new Date('2026-07-29T00:11:00.000Z'),
      history: [],
      revision: 0,
    };
    await improvements.addAction(lifecycleDraft, lifecyclePlan);
    const plannedAt = new Date('2026-07-29T00:12:00.000Z');
    await improvements.changeAction(
      {
        ...lifecycleDraft,
        state: 'planned',
        history: [{ from: 'draft', to: 'planned', at: plannedAt, by: 'person', who: 'someone@example.com' }],
        revision: 1,
      },
      lifecyclePlan
    );

    const lifecycleMonth = parseMonth('2026-07');
    if (lifecycleMonth == null || first.result == null)
      throw new Error('The lifecycle fixture has no month or result.');
    const publicationJson = JSON.stringify({
      documentKind: 'databricks-waf-month',
      documentVersion: 1,
      month: lifecycleMonth,
      publicationId: 'live-customer-lifecycle-month',
      finalResultId: first.result.id,
      reviewId: first.result.reviewId,
      runId: first.result.runId,
      definitionId: definition.id,
      definitionVersion: version.version,
    });
    const publication: Publication = {
      id: 'live-customer-lifecycle-month',
      month: lifecycleMonth,
      publishedAt: new Date('2026-08-01T00:00:00.000Z'),
      publishedBy: 'someone@example.com',
      documentVersion: 1,
      json: publicationJson,
      csv: `month,publication_id,final_result_id\r\n${lifecycleMonth},live-customer-lifecycle-month,${first.result.id}`,
      digest: fromBytes(Buffer.from(publicationJson)),
      ordinal: 1,
      definitionId: definition.id,
    };
    await new PostgresPublicationStore({ db }).publish(publication);

    let restartedIdentity:
      | {
          readonly resultId: string;
          readonly runId: string;
          readonly reviewId: string;
          readonly planId: string;
          readonly actionId: string;
          readonly foundationFingerprint: string;
          readonly monthId: string;
          readonly monthFinalResultId: string;
        }
      | undefined;
    const restarted = await open(SCHEMA);
    try {
      const restartedReviews = new PostgresReviewStore({
        db: restarted,
        pillars: projectionPillars,
        projector: projectionProjector,
      });
      const restartedResult = (await restartedReviews.get(review.id))?.result;
      const restartedImprovements = new PostgresImprovementStore({ db: restarted });
      const restartedServing = new PostgresServingStore({ db: restarted });
      const restartedPublications = new PostgresPublicationStore({ db: restarted });

      expect(restartedResult?.id).toBe(first.result.id);
      expect(restartedResult?.runId).toBe(source.id);
      expect((await restartedImprovements.plan(lifecyclePlan.id, definition.id))?.raisedFrom).toBe(source.id);
      expect((await restartedImprovements.action(lifecycleDraft.id, definition.id))?.state).toBe('planned');
      expect((await restartedImprovements.action(lifecycleDraft.id, definition.id))?.due?.toISOString()).toBe(
        lifecycleDraft.due?.toISOString()
      );
      expect((await restartedServing.current(definition.id))?.definition.fingerprint).toBe(
        declaration.definition.fingerprint
      );

      const restartedPublication = await restartedPublications.byId(publication.id, definition.id);
      expect(restartedPublication?.json).toBe(publicationJson);
      const restartedDocument = JSON.parse(restartedPublication?.json ?? '{}') as {
        readonly finalResultId?: string;
        readonly reviewId?: string;
        readonly runId?: string;
        readonly definitionId?: string;
        readonly definitionVersion?: number;
      };
      expect(restartedDocument).toMatchObject({
        finalResultId: first.result.id,
        reviewId: review.id,
        runId: source.id,
        definitionId: definition.id,
        definitionVersion: version.version,
      });
      restartedIdentity = {
        resultId: restartedResult?.id ?? '',
        runId: restartedResult?.runId ?? '',
        reviewId: restartedResult?.reviewId ?? '',
        planId: lifecyclePlan.id,
        actionId: lifecycleDraft.id,
        foundationFingerprint: (await restartedServing.current(definition.id))?.definition.fingerprint ?? '',
        monthId: publication.id,
        monthFinalResultId: restartedDocument.finalResultId ?? '',
      };
    } finally {
      await restarted.end();
    }

    const rollbackSource = projectionScan(definitionIdentity, 'live-projected-rollback-run');
    await scans.save(rollbackSource);
    const rollbackReview = opened({
      id: 'live-projected-rollback-review',
      runId: rollbackSource.id,
      openedBy: 'someone@example.com',
      openedAt: new Date('2026-07-29T00:09:00.000Z'),
      definitionId: definitionIdentity.id,
      definitionVersion: definitionIdentity.version,
      definitionFingerprint: definitionIdentity.fingerprint,
    });
    await reviews.open(rollbackReview);
    for (const pillarId of projectionPillars.filter((one) => one !== projectionControl.pillarId)) {
      await reviews.record(
        skipped(
          {
            id: `live-projected-rollback-decision-${pillarId}`,
            reviewId: rollbackReview.id,
            runId: rollbackReview.runId,
            pillarId,
            by: 'someone@example.com',
            at: new Date('2026-07-29T00:10:00.000Z'),
          },
          projectionPillars
        )
      );
    }
    await expect(
      reviews.record(
        confirmed(
          {
            id: `live-projected-rollback-decision-${projectionControl.pillarId}`,
            reviewId: rollbackReview.id,
            runId: rollbackReview.runId,
            pillarId: projectionControl.pillarId,
            by: 'someone@example.com',
            at: new Date('2026-07-29T00:11:00.000Z'),
            attestationIds: ['missing-live-projected-attestation'],
          },
          projectionPillars
        )
      )
    ).rejects.toThrow(/attestation cited by this review could not be read/i);
    const rolledBackPillars = await db.query<{ pillar_id: string }>(
      `select pillar_id from ${SCHEMA}.pillar_reviews where review_id = $1`,
      [rollbackReview.id]
    );
    const rolledBackResults = await db.query<{ id: string }>(
      `select id from ${SCHEMA}.assessment_results where review_id = $1`,
      [rollbackReview.id]
    );
    expect(rolledBackPillars.rows).toHaveLength(projectionPillars.length - 1);
    expect(rolledBackPillars.rows.map((one) => one.pillar_id)).not.toContain(projectionControl.pillarId);
    expect(rolledBackResults.rows).toHaveLength(0);

    const lifecycleReport = process.env.WAF_LIVE_LIFECYCLE_REPORT;
    if (lifecycleReport != null && restartedIdentity != null) {
      writeFileSync(
        lifecycleReport,
        `${JSON.stringify(
          {
            restarted: true,
            definition: definitionIdentity,
            ...restartedIdentity,
            rollback: {
              runId: rollbackSource.id,
              reviewId: rollbackReview.id,
              terminalPillarWritten: false,
              resultWritten: false,
            },
          },
          null,
          2
        )}\n`
      );
    }
  });

  it('reads a scan back with its dates as dates and its document intact', async () => {
    const scans = new PostgresScanStore({ db });
    const written = scan('live-a', '2026-08-01T01:00:00.000Z', 0.62);
    await scans.save(written);

    const back = await scans.get('live-a');

    expect(back?.startedAt).toBeInstanceOf(Date);
    expect(back?.startedAt.toISOString()).toBe('2026-08-01T01:00:00.000Z');
    expect(back?.score.overall).toBe(0.62);

    // The whole footprint against the one that was written, rather than three keys of `spend` against a
    // scheduler built here. Row `90`: this test had the name of the thing that broke and asserted the part
    // that could not — `81` added `tasks[*].terminal`, and the three `spend` keys it checked were untouched
    // by that change, so it stayed green while every stored scan in the served app became unreadable.
    //
    // Comparing against `written` rather than a fresh scheduler is what makes the whole document available:
    // `elapsedMs` is a clock reading, so a fixture's and a fresh scheduler's agree only when both land in
    // the same millisecond, which is why the narrow version was narrow. What the test is about is a nested
    // document surviving jsonb unchanged, and the document that went in is the only fair comparison for it.
    expect(back?.footprint).toEqual(written.footprint);
  });

  it('overwrites a re-saved scan instead of failing on its primary key', async () => {
    const scans = new PostgresScanStore({ db });
    await scans.save(scan('live-b', '2026-08-01T02:00:00.000Z', 0.4));
    await scans.save(scan('live-b', '2026-08-01T02:00:00.000Z', 0.9));

    expect((await scans.get('live-b'))?.score.overall).toBe(0.9);
  });

  it('keeps three plans of a shape, cuts the fourth, and reads both timestamps back as dates', async () => {
    // What the fake cannot prove about this store. Three things, all of them wire: `on conflict` against a
    // real composite primary key rather than an object map keyed by hand; a `timestamptz` coming back as a
    // `Date` where the fake hands back the string it was given, which is why `when` takes either; and the
    // extract surviving jsonb with its operators intact.
    const plans = new PostgresPlanExtractStore(db);
    const shape = { workspaceId: 'live-ws', shape: 'aaaabbbbccccdddd' };
    const extract = (fingerprint: string): PlanExtract => ({
      parserVersion: 'plan-parser-3',
      fingerprint,
      operatorCount: 2,
      // Two operators, an edge between them and a named metric on one, because the extract crossing jsonb
      // intact is what this test is for and `33ic` added three shapes it did not carry: an array of objects,
      // a record keyed by a label with spaces in it, and a number that must not come back as a string.
      operators: [
        { id: '1', tag: 'Scan', named: { 'Hashed relation size': 4096 } },
        { id: '2', tag: 'PHOTON_SHUFFLE_EXCHANGE_EXEC' },
      ],
      operatorsWithoutMetrics: 0,
      operatorsWithZeroMetrics: 0,
      edges: [{ from: '2', to: '1' }],
      edgesWithUnknownEndpoint: 0,
    });
    const filed = (statementId: string, day: string): RetainedPlan => ({
      ...shape,
      statementId,
      advisoryId: 'live-adv',
      advisoryAt: new Date('2026-08-10T00:00:00.000Z'),
      observedAt: new Date(`2026-08-0${day}T00:00:00.000Z`),
      shapeVersion: 'shape-live0001',
      extract: extract(`fp-${statementId}`),
    });

    await plans.keep([filed('s-1', '1'), filed('s-2', '2'), filed('s-3', '3')]);
    await plans.keep([filed('s-4', '4')]);
    // The same execution again, which is what two overlapping windows produce. The `set` list is what makes
    // this an update rather than a second row.
    await plans.keep([{ ...filed('s-4', '4'), advisoryId: 'live-adv-2', extract: extract('fp-again') }]);

    const kept = await plans.forShape(shape);

    expect(kept.map((one) => one.statementId)).toEqual(['s-4', 's-3', 's-2']);
    expect(kept[0]?.observedAt).toBeInstanceOf(Date);
    expect(kept[0]?.advisoryAt).toBeInstanceOf(Date);
    expect(kept[0]?.advisoryAt.toISOString()).toBe('2026-08-10T00:00:00.000Z');
    expect(kept[0]?.advisoryId).toBe('live-adv-2');
    expect(kept[0]?.extract.fingerprint).toBe('fp-again');
    expect(kept[0]?.extract.operators).toEqual([
      { id: '1', tag: 'Scan', named: { 'Hashed relation size': 4096 } },
      { id: '2', tag: 'PHOTON_SHUFFLE_EXCHANGE_EXEC' },
    ]);
    expect(kept[0]?.extract.edges).toEqual([{ from: '2', to: '1' }]);
    expect(kept[0]?.extract.edgesWithUnknownEndpoint).toBe(0);
    expect(await plans.forShape({ workspaceId: 'live-ws', shape: 'no-such-shape' })).toEqual([]);
  });

  it('orders history newest first, which is the index doing the work', async () => {
    const scans = new PostgresScanStore({ db });
    await scans.save(scan('live-c', '2026-08-03T00:00:00.000Z', 0.7));

    const history = await scans.history();

    expect(history.map((entry) => entry.id).slice(0, 2)).toEqual(['live-c', 'live-b']);
    expect(history[0]?.startedAt).toBeInstanceOf(Date);
    expect((await scans.latest())?.id).toBe('live-c');
  });

  it('keeps both attestations when one supersedes the other, and answers with the newer', async () => {
    const attestations = new PostgresAttestationStore({ db });
    await attestations.record(attestation('live-att-1', '2026-08-01T01:00:00.000Z'));
    await attestations.record(attestation('live-att-2', '2026-08-02T01:00:00.000Z', 'live-att-1'));

    const current = await attestations.current();
    const history = await attestations.historyFor('OE-02-04');

    expect(current.filter((one) => one.controlId === 'OE-02-04').map((one) => one.id)).toEqual(['live-att-2']);
    expect(history.map((one) => one.id)).toEqual(['live-att-2', 'live-att-1']);
    expect(history[0]?.attestedAt).toBeInstanceOf(Date);
    expect(history[0]?.reviewBy).toBeInstanceOf(Date);
  });

  it('ignores a re-appended attestation rather than rewriting the record', async () => {
    const attestations = new PostgresAttestationStore({ db });
    await attestations.record(attestation('live-att-1', '2026-08-01T01:00:00.000Z'));
    const rewritten = { ...attestation('live-att-1', '2026-08-01T01:00:00.000Z'), answer: 'not-met' as const };
    await attestations.record(rewritten);

    const [stored] = (await attestations.historyFor('OE-02-04')).filter((one) => one.id === 'live-att-1');

    // Append-only means the first write stands. A store that let the second one through would make
    // "who said what, when" unanswerable, which is the whole reason these two tables exist.
    expect(stored?.answer).toBe('met');
  });

  /*
   * The three properties of the definition tables a fake cannot prove, and each is a correctness
   * property rather than a nicety: the composite primary key is what makes a lost revision an error,
   * the conditional update is what makes archiving idempotent, and a version's nested measurement has
   * to survive the round trip or a run gets stamped with a scope nobody chose.
   */
  it('refuses a second row for a version number, which is what makes a lost race visible', async () => {
    const definitions = new PostgresDefinitionStore({ db });
    const draft: Draft = {
      measurement: { scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] }, lookbackDays: 30 },
      attribution: { name: 'Live review', owners: ['alice@example.com'] },
    };
    const first = define(draft, 'live-def', new Date('2026-08-01T00:00:00.000Z'), 'alice@example.com');
    await definitions.create(first);

    const mine = revise(first, { attribution: { name: 'Mine', owners: [] } }, new Date(), 'alice@example.com');
    const theirs = revise(first, { attribution: { name: 'Theirs', owners: [] } }, new Date(), 'bob@example.com');
    const minesVersion = mine.versions[1];
    const theirsVersion = theirs.versions[1];
    if (minesVersion == null || theirsVersion == null) throw new Error('revise produced no second version');

    await definitions.appendVersion('live-def', minesVersion);
    // The real driver's error code, translated. This is the assertion the fake can only imitate.
    await expect(definitions.appendVersion('live-def', theirsVersion)).rejects.toThrow(DefinitionConflict);

    const back = await definitions.get('live-def');
    expect(back?.versions.map((one) => one.version)).toEqual([1, 2]);
    expect(back?.versions[1]?.attribution.name).toBe('Mine');
    // The nested measurement, sorted on the way in, out of a real jsonb column.
    expect(back?.versions[0]?.measurement.scope).toEqual({ kind: 'selected', workspaceIds: ['w1', 'w2'] });
    expect(back?.versions[0]?.createdAt).toBeInstanceOf(Date);
    expect(back?.versions[0]?.createdAt.toISOString()).toBe('2026-08-01T00:00:00.000Z');
  });

  it('archives once and does not move the date on a second call', async () => {
    const definitions = new PostgresDefinitionStore({ db });
    const draft: Draft = {
      measurement: { scope: { kind: 'account' }, lookbackDays: 90 },
      attribution: { name: 'To be closed', owners: [] },
    };
    await definitions.create(define(draft, 'live-closed', new Date('2026-08-01T00:00:00.000Z'), 'alice'));

    const first = new Date('2026-08-02T00:00:00.000Z');
    await definitions.archive('live-closed', first);
    await definitions.archive('live-closed', new Date('2026-09-01T00:00:00.000Z'));

    const back = await definitions.get('live-closed');
    expect(back?.archivedAt).toBeInstanceOf(Date);
    expect(back?.archivedAt?.toISOString()).toBe(first.toISOString());
    // Archived, not removed, because a finished run points at a version of it.
    expect(back?.versions).toHaveLength(1);
  });

  /*
   * Worth a live run rather than only a fake one, because the statement is `set archived_at = null`
   * and clearing a column to a literal is exactly the shape a fake can be taught to accept without
   * proving a database accepts it. The round trip is the assertion: closed, reopened, closed again.
   */
  it('reopens an archived definition, and lets it be closed again afterwards', async () => {
    const definitions = new PostgresDefinitionStore({ db });
    const draft: Draft = {
      measurement: { scope: { kind: 'account' }, lookbackDays: 90 },
      attribution: { name: 'Closed by mistake', owners: [] },
    };
    await definitions.create(define(draft, 'live-reopened', new Date('2026-08-01T00:00:00.000Z'), 'alice'));
    await definitions.archive('live-reopened', new Date('2026-08-02T00:00:00.000Z'));

    await definitions.unarchive('live-reopened');

    const reopened = await definitions.get('live-reopened');
    expect(reopened?.archivedAt).toBeUndefined();
    expect(reopened?.versions).toHaveLength(1);

    // And the pair still works in the other direction, which a store that lost the row would not.
    const again = new Date('2026-08-05T00:00:00.000Z');
    await definitions.archive('live-reopened', again);
    expect((await definitions.get('live-reopened'))?.archivedAt?.toISOString()).toBe(again.toISOString());
  });

  /*
   * The one table here that is overwritten and deleted, so the two statements the fake can only
   * imitate are the ones worth running against a database: the `on conflict (author, definition_id)`
   * that makes a second save an update rather than a second row, and the delete that ends a draft.
   *
   * The empty-string target is the reason the upsert has to be checked here. A nullable column cannot
   * be part of a primary key and `on conflict` against a null would never match, so a mistake there
   * would leave a row behind on every save and the author would come back to a list of drafts that
   * were all the same draft — which is a fake keying on `undefined` reporting a pass.
   */
  it('replaces an unfinished assessment rather than leaving a second row, and forgets it on request', async () => {
    const drafts = new PostgresSetupDraftStore({ db });
    const first = new Date('2026-08-01T00:00:00.000Z');
    const second = new Date('2026-08-02T00:00:00.000Z');

    await drafts.save({ author: 'alice@example.com', name: 'Half written', savedAt: first });
    await drafts.save({
      author: 'alice@example.com',
      name: 'More of it',
      scope: { kind: 'selected', workspaceIds: ['w2', 'w1'] },
      lookbackDays: 30,
      savedAt: second,
    });
    // A different target for the same author, which must not have been overwritten by either.
    await drafts.save({
      author: 'alice@example.com',
      definitionId: 'live-def',
      fromVersion: 1,
      name: 'A revision',
      savedAt: second,
    });

    expect(await drafts.mine('alice@example.com')).toHaveLength(2);
    const back = await drafts.get('alice@example.com');
    expect(back?.name).toBe('More of it');
    expect(back).not.toHaveProperty('definitionId');
    // Out of a real jsonb column, with the date as a date rather than the string the driver returns.
    expect(back?.scope).toEqual({ kind: 'selected', workspaceIds: ['w2', 'w1'] });
    expect(back?.savedAt).toBeInstanceOf(Date);
    expect(back?.savedAt.toISOString()).toBe(second.toISOString());
    expect(await drafts.mine('bob@example.com')).toEqual([]);

    await drafts.discard('alice@example.com');
    expect(await drafts.get('alice@example.com')).toBeUndefined();
    expect(await drafts.get('alice@example.com', 'live-def')).toBeDefined();
    // Confirming and abandoning both end here, so a second call is not an error.
    await expect(drafts.discard('alice@example.com')).resolves.toBeUndefined();
  });

  it('keeps a decision with its dates, including the one that may be absent', async () => {
    const decisions = new PostgresDecisionStore({ db });
    await decisions.record(decision('live-dec-1', '2026-08-01T01:00:00.000Z'));
    const { until: _dropped, ...open } = decision('live-dec-2', '2026-08-02T01:00:00.000Z');
    await decisions.record(open);

    const current = await decisions.current();

    expect(current.map((one) => one.id)).toEqual(['live-dec-2']);
    expect(current[0]?.decidedAt).toBeInstanceOf(Date);
    expect(current[0]?.until).toBeUndefined();
    expect((await decisions.historyFor('OE-02-04'))[1]?.until).toBeInstanceOf(Date);
  });

  it('refuses a second writer at the same revision of an action, which is the whole claim', async () => {
    // The one thing about the improvement store a fake cannot settle. Its defence against two people
    // moving one action at the same moment is a primary key on the pair, so this asks a real database
    // whether that key is really there — the fake refuses the second write because it was told the
    // key, which is agreeing with the code rather than checking it.
    const improvements = new PostgresImprovementStore({ db });
    const plan = {
      id: 'live-plan',
      title: 'Close the Unity Catalog gaps',
      outcome: 'Every workspace reads from Unity Catalog and the metastore has an owner.',
      owners: ['platform@example.com'],
      createdBy: 'lead@example.com',
      createdAt: new Date('2026-08-01T00:00:00.000Z'),
      revision: 0,
    };
    await improvements.addPlan(plan);

    const draft: ImprovementAction = {
      id: 'live-action',
      planId: 'live-plan',
      controlIds: ['OE-02-04'],
      outcome: 'Migrate the two remaining Hive tables.',
      definitionOfDone: 'No table in the workspace resolves through the legacy metastore.',
      owner: 'dana@example.com',
      priority: 'now',
      effort: 'medium',
      steps: [],
      dependsOn: [],
      state: 'draft',
      createdBy: 'lead@example.com',
      createdAt: new Date('2026-08-02T00:00:00.000Z'),
      history: [],
      revision: 0,
    };
    await improvements.addAction(draft, plan);

    const at = new Date('2026-08-03T00:00:00.000Z');
    const move = (to: ImprovementAction['state']): ImprovementAction => ({
      ...draft,
      state: to,
      revision: 1,
      history: [{ from: 'draft', to, at, by: 'person', who: 'dana@example.com' }],
    });
    await improvements.changeAction(move('planned'), plan);
    await expect(improvements.changeAction(move('cancelled'), plan)).rejects.toThrow(ConcurrentChangeError);

    const back = await improvements.action('live-action');
    expect(back?.state).toBe('planned');
    // Out of a real jsonb column: the dates inside the history are dates, not the strings it stored.
    expect(back?.history[0]?.at).toBeInstanceOf(Date);
    expect(back?.createdAt.toISOString()).toBe('2026-08-02T00:00:00.000Z');
    expect((await improvements.actionsFor('OE-02-04')).map((one) => one.id)).toEqual(['live-action']);

    // The narrowing `46b` put on this read, against a real jsonb containment rather than the fake's
    // model of one: the ids come from `body -> 'controlIds' @> to_jsonb($1::text)` and the revisions
    // from `id = any($1::text[])`. The second action's first revision names a requirement its second
    // has dropped, which is the case that separates narrowing by id from narrowing by row.
    const edited: ImprovementAction = { ...draft, id: 'live-edited', controlIds: ['OE-02-04', 'SEC-01-99'] };
    await improvements.addAction(edited, plan);
    await improvements.changeAction({ ...edited, controlIds: ['OE-02-04'], revision: 1 }, plan);

    expect((await improvements.actionsFor('SEC-01-99')).map((one) => one.id)).toEqual([]);
    expect((await improvements.actionsFor('OE-02-04')).map((one) => one.id).sort()).toEqual([
      'live-action',
      'live-edited',
    ]);
  });

  it('verifies every record it wrote against the digest stored beside it', async () => {
    // The check the fake cannot make: `jsonb` really does return the document with its own key order
    // here, so this is where "the digest survives a round trip" is either true or was wishful.
    const report = await verifyRecords({ db });

    expect(report.intact).toBe(true);
    // Every stamped table the app has, rather than a list copied here: a table added to `verify.ts`
    // and forgotten in this test would leave the check passing over a table it no longer covers, which
    // is the failure mode a hard-coded list in a coverage assertion always eventually has.
    expect(report.tables.map((one) => one.table)).toEqual([...RECORD_TABLES]);

    // The tables this suite wrote into. The rest are empty here, and a report that claimed to have
    // checked something in them would be the defect rather than the point.
    const written = ['scans', 'attestations', 'decisions', 'improvement_plans', 'improvement_actions'];
    for (const table of report.tables) {
      if (written.includes(table.table)) expect(table.checked).toBeGreaterThan(0);
      expect(table.intact).toBe(table.checked);
      expect(table.unstamped).toBe(0);
    }
  });

  it('reports a record edited behind the app as altered', async () => {
    const scans = new PostgresScanStore({ db });
    await scans.save(scan('live-edited', '2026-08-04T00:00:00.000Z', 0.5));
    // What somebody with database access can do, done here so the check is proven against the real
    // thing rather than against a fake that agrees with it by construction.
    await db.query(`update ${SCHEMA}.scans set body = jsonb_set(body, '{scan,score,overall}', '0.99') where id = $1`, [
      'live-edited',
    ]);

    const report = await verifyRecords({ db });

    expect(report.intact).toBe(false);
    expect(report.tables.find((one) => one.table === 'scans')?.altered).toEqual(['live-edited']);
    // And the record still reads, because a digest is a statement about a record rather than a lock
    // on it. Refusing to serve it would hide the evidence from the person investigating.
    expect((await scans.get('live-edited'))?.score.overall).toBe(0.99);
  });
});

/*
 * The audit log against a real database, in its own schema because two of these checks damage the
 * table on purpose and the stores above read from the same one.
 *
 * Everything here is a property of Postgres rather than of the code: the primary key on `sequence`
 * is what makes two appends racing produce one row, the unique index on `id` is what makes a retry
 * after an insert that succeeded and failed to report it return the act already held, and the
 * inequalities in a time window are the part `postgres-fake.ts` models by hand and could model
 * wrongly. The two tampering checks are the reason the chain exists, and a fake that reported them
 * would only be agreeing with the code that wrote it.
 */
describe.skipIf(!bound)('the audit log against a real Lakebase database', () => {
  const AUDIT = `${SCHEMA}_audit`;
  let db: Postgres;
  let log: PostgresAuditLog;

  beforeAll(async () => {
    db = await open(AUDIT);
    log = new PostgresAuditLog(db);
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    await db.query(`drop schema if exists ${AUDIT} cascade`);
    await db.end();
  }, 60_000);

  it('reads an empty log as genesis rather than as an error', async () => {
    const head = await log.head();

    expect(head.sequence).toBe(0);
    expect(head.digest).toMatch(/^sha256:0+$/);
  });

  it('numbers acts contiguously and links each to the one before it', async () => {
    const one = await log.append(act('live-1', { correlation: 'run-live' }));
    const two = await log.append(
      act('live-2', {
        actor: 'someone-else@example.com',
        executionMode: 'service-principal',
        action: 'decision.record',
        outcome: 'refused',
        reason: 'not-an-owner',
        target: { kind: 'control', id: 'REL-01-01' },
      })
    );

    expect([one.sequence, two.sequence]).toEqual([1, 2]);
    expect(two.previous).toBe(one.digest);
    expect((await log.head()).digest).toBe(two.digest);
  });

  it('answers a repeated id with the act already held rather than writing a second one', async () => {
    const first = await log.append(act('live-repeat'));
    const again = await log.append(act('live-repeat'));

    // The unique index doing the work. Without it the retry would append, and the log would say an
    // administrator did something twice when they did it once and the reply was lost.
    expect(again).toEqual(first);
    expect((await log.head()).sequence).toBe(3);
  });

  it('reads newest first, with the time as a time', async () => {
    const page = await log.search({ limit: 10 });

    expect(page.events.map((one) => one.id)).toEqual(['live-repeat', 'live-2', 'live-1']);
    expect(page.events[0]?.at).toBeInstanceOf(Date);
  });

  it('narrows to refusals, which is why the log exists', async () => {
    const refused = await log.search({ outcome: 'refused' });

    expect(refused.events.map((one) => one.id)).toEqual(['live-2']);
    expect(refused.events[0]?.reason).toBe('not-an-owner');
  });

  it('narrows by what was acted on, by who acted, and by the run the act belongs to', async () => {
    expect((await log.search({ targetId: 'REL-01-01' })).events.map((one) => one.id)).toEqual(['live-2']);
    expect((await log.search({ actor: 'someone-else@example.com' })).events.map((one) => one.id)).toEqual(['live-2']);
    expect((await log.search({ correlation: 'run-live' })).events.map((one) => one.id)).toEqual(['live-1']);
  });

  it('narrows to a time window, which is the inequality the fake models by hand', async () => {
    const now = Date.now();
    const inside = await log.search({ since: new Date(now - 60_000), until: new Date(now + 60_000) });
    const after = await log.search({ since: new Date(now + 60_000) });

    expect(inside.events).toHaveLength(3);
    expect(after.events).toEqual([]);
  });

  it('pages back to the beginning without skipping a row', async () => {
    const first = await log.search({ limit: 2 });
    const second = await log.search({ limit: 2, before: first.next });

    expect(first.events.map((one) => one.id)).toEqual(['live-repeat', 'live-2']);
    expect(second.events.map((one) => one.id)).toEqual(['live-1']);
    expect(second.next).toBeUndefined();
  });

  it('verifies the chain over rows that went through jsonb, and names the head an export would cite', async () => {
    const report = await log.verify();

    expect(report.checked).toBe(3);
    expect(report.breaks).toEqual([]);
    expect(report.head?.digest).toBe((await log.head()).digest);
  });

  it('reports an act edited behind the app as one break, at the act that changed', async () => {
    // What somebody with database access can do. The digest covers `body`, so this is the edit that
    // changes what a search finds and what a verifier reads at the same time.
    await db.query(
      `update ${AUDIT}.audit_events set body = jsonb_set(body, '{actor}', '"tampered"') where sequence = 1`
    );

    const report = await log.verify();

    expect(report.breaks).toHaveLength(1);
    expect(report.breaks[0]).toMatchObject({ kind: 'digest', sequence: 1 });
  });

  it('reports a removed act as a gap, because the numbering is contiguous', async () => {
    await db.query(`delete from ${AUDIT}.audit_events where sequence = 1`);

    const report = await log.verify();

    expect(report.breaks.some((one) => one.kind === 'gap')).toBe(true);
  });
});

describe.skipIf(!bound)('a database that predates digests', () => {
  const OLD = `${SCHEMA}_old`;
  let db: Postgres;

  beforeAll(async () => {
    db = await open(OLD);
    // The tables as the previous build created them: no digest column. `create table if not exists`
    // will not touch these, which is exactly why the column is added by `alter`.
    // `open()` created the current graph first. Replacing just this table with its pre-digest shape
    // therefore has to remove the current foreign keys that point at it; every object is inside the
    // disposable OLD schema and `ensureSchema` below restores the current relationships.
    await db.query(`drop table if exists ${OLD}.scans cascade`);
    await db.query(
      `create table ${OLD}.scans (
         id text primary key, started_at timestamptz not null, summary jsonb not null,
         body jsonb not null, written_at timestamptz not null default now()
       )`
    );
    await db.query(
      `insert into ${OLD}.scans (id, started_at, summary, body) values ($1, $2, '{}'::jsonb, '{}'::jsonb)`,
      ['before-digests', new Date('2026-07-01T00:00:00.000Z')]
    );
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    await db.query(`drop schema if exists ${OLD} cascade`);
    await db.end();
  }, 60_000);

  it('adds the column on boot and keeps the row that has no digest', async () => {
    await ensureSchema(db, OLD);
    const scans = new PostgresScanStore({ db });
    await scans.save(scan('after-digests', '2026-08-05T00:00:00.000Z', 0.6));

    const report = await verifyRecords({ db });
    const table = report.tables.find((one) => one.table === 'scans');

    // The old row is unstamped and the new one is intact, and neither is reported as altered — which
    // is the honest reading of a database that has been through this change.
    expect(table).toMatchObject({ total: 2, checked: 2, intact: 1, unstamped: 1, altered: [] });
    expect(report.intact).toBe(true);
    expect(describeVerification(report)).toContain('unstamped rather than verified');
    // Longer than the default because this is the only case that runs the whole of `ensureSchema`
    // inside the test rather than in `beforeAll`, and that is a couple of dozen round trips.
  }, 60_000);
});

/*
 * Retention against a real database, in its own schema because everything here removes rows.
 *
 * Four things are properties of Postgres rather than of the code, and `postgres-fake.ts` either
 * models them by hand or does not model them at all. The `on conflict (retention_class)` upsert is
 * what makes two administrators setting different periods at the same time not overwrite each other.
 * `covers` goes out as jsonb and has to come back as an array of strings rather than as a string.
 * The eligibility count and the oldest row are an inequality and an `order by ... limit 1` over a
 * real index. And the audit trim is the one that matters most: it deletes by sequence over rows
 * whose `at` values are deliberately out of order, and the surviving log has to verify from the
 * floor it wrote — which is the claim the whole chain rests on and the fake can only agree with the
 * code that wrote it.
 */
describe.skipIf(!bound)('retention against a real Lakebase database', () => {
  const KEPT = `${SCHEMA}_kept`;
  let db: Postgres;
  let store: PostgresRetentionStore;
  let gateway: PostgresRetentionGateway;
  let log: PostgresAuditLog;

  beforeAll(async () => {
    db = await open(KEPT);
    store = new PostgresRetentionStore(db);
    gateway = new PostgresRetentionGateway(db);
    log = new PostgresAuditLog(db);
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    await db.query(`drop schema if exists ${KEPT} cascade`);
    await db.end();
  }, 60_000);

  /*
   * Both of these read the defaults out of `DEFAULT_PERIOD_DAYS` rather than restating them, and did
   * not until `46b`. Restated, they named three classes; `advisory` was added as a fourth in #138 and
   * these two have failed ever since, unnoticed, because nothing runs this file without a database
   * bound. The class list is the thing that moves, so the expectation reads it.
   */
  it('reads the approved defaults from a database nobody has configured', async () => {
    const policy = await store.policy();

    expect(policy.periods).toEqual(DEFAULT_PERIOD_DAYS);
    expect(policy.setBy).toBeUndefined();
  });

  it('sets one class without restating the others, and keeps the most recent attribution', async () => {
    await store.setPeriods({ temporary: 14 }, 'first@example.com', new Date('2026-08-01T00:00:00.000Z'));
    await store.setPeriods({ assessment: 400 }, 'second@example.com', new Date('2026-08-02T00:00:00.000Z'));

    const policy = await store.policy();

    expect(policy.periods).toEqual({ ...DEFAULT_PERIOD_DAYS, temporary: 14, assessment: 400 });
    // The later of the two changes, because "who set the retention policy" is one question.
    expect(policy.setBy).toBe('second@example.com');
    expect(policy.setAt).toBeInstanceOf(Date);
  });

  it('upserts a period rather than writing a second row for the same class', async () => {
    await store.setPeriods({ temporary: 21 }, 'third@example.com', new Date('2026-08-03T00:00:00.000Z'));

    const { rows } = await db.query<{ total: number | string }>(
      `select count(*) as total from ${KEPT}.retention_periods where retention_class = 'temporary'`
    );

    expect(Number(rows[0]?.total)).toBe(1);
    expect((await store.policy()).periods.temporary).toBe(21);
  });

  it('reads a hold back with its classes as classes and its dates as dates', async () => {
    await store.place({
      id: 'hold-live',
      reason: 'A live test placed this, and it is longer than ten characters.',
      covers: ['assessment', 'governance'],
      placedBy: 'legal@example.com',
      placedAt: new Date('2026-08-04T00:00:00.000Z'),
    });

    const [hold] = await store.holds();

    // `covers` went out as jsonb. Coming back as `["assessment"]` the string rather than the array is
    // exactly the failure a fake modelling one type cannot produce.
    expect(hold?.covers).toEqual(['assessment', 'governance']);
    expect(hold?.placedAt).toBeInstanceOf(Date);
    expect(hold?.releasedAt).toBeUndefined();
  });

  it('lifts a hold once, and tells the second caller there was nothing to lift', async () => {
    const lifted = await store.release('hold-live', 'legal@example.com', new Date('2026-08-05T00:00:00.000Z'));
    const again = await store.release('hold-live', 'somebody-else@example.com', new Date());

    expect([lifted, again]).toEqual([true, false]);

    const [hold] = await store.holds();
    // Kept rather than deleted: who lifted it and when is part of the record it was protecting.
    expect(hold).toMatchObject({ releasedBy: 'legal@example.com' });
    expect(hold?.releasedAt).toBeInstanceOf(Date);
  });

  it('counts what is past a cutoff, and the age of the oldest row beside it', async () => {
    const scans = new PostgresScanStore({ db });
    await scans.save(scan('kept-old', '2020-01-01T00:00:00.000Z', 0.4));
    await scans.save(scan('kept-new', '2026-08-01T00:00:00.000Z', 0.8));

    const counted = await gateway.count('scans', 'started_at', new Date('2026-01-01T00:00:00.000Z'));

    expect(counted).toMatchObject({ table: 'scans', total: 2, eligible: 1 });
    expect(counted.oldest?.toISOString()).toBe('2020-01-01T00:00:00.000Z');
  });

  it('removes only what is past the cutoff, and answers how many', async () => {
    const removed = await gateway.remove('scans', 'started_at', new Date('2026-01-01T00:00:00.000Z'));

    expect(removed).toBe(1);
    expect(await gateway.count('scans', 'started_at')).toMatchObject({ total: 1, eligible: 0 });
  });

  /*
   * Every narrowing predicate, sent at a real database, which is the check `86` was the absence of.
   *
   * Two of the four name a second table, and for four months they named it bare. Nothing caught it:
   * the fake refuses a subquery predicate rather than evaluating one, the unit test asserted that
   * `and` and `where` did not mangle a copy of the clause, and this file — the one place a real
   * database was available — only ever counted `scans`, which has no predicate at all. So the
   * retention page raised `relation "runs" does not exist` on every install and every test agreed
   * it was fine.
   *
   * Every entry rather than the two that were broken, and no fixture rows: what is being checked is
   * that the statement *resolves*, and a count of zero resolves exactly as well as a count of four.
   * Seeding runs and attempts here would test what the sweep counts, which the tests above already
   * do on `scans`, and would not have caught this any better.
   */
  it('sends every narrowing predicate at a real database, including the two that name a second table', async () => {
    const narrowed = RETAINED.filter((one) => one.only != null);
    expect(narrowed.length).toBeGreaterThan(0);

    const failed: string[] = [];
    for (const entry of narrowed) {
      try {
        await gateway.count(entry.table, entry.stamp, new Date('2026-01-01T00:00:00.000Z'), entry.only);
      } catch (cause) {
        failed.push(`${entry.table}/${entry.retentionClass}: ${(cause as Error).message}`);
      }
    }

    expect(failed).toEqual([]);
  });

  it('plans a sweep of every class without a statement failing, which is what the page asks for', async () => {
    // `eligibility` counts every table in a class together, so one unresolvable predicate rejects
    // the whole page rather than one row of it. That is the shape of `86`'s blast radius and the
    // reason this asserts on the plan rather than on the counts inside it.
    const planned = await planRetention(gateway, DEFAULT_POLICY, [], new Date('2026-08-01T00:00:00.000Z'));

    expect(planned.classes.map((one) => one.retentionClass)).toEqual([...RETENTION_CLASSES]);
    expect(planned.classes.flatMap((one) => one.tables).length).toBe(RETAINED.length);
  });

  it('cuts the audit log by sequence over events whose times are out of order, and verifies from the floor', async () => {
    // Deliberately not chronological. Sequence 3 is older than sequence 2, which is the case that
    // makes deletion by age leave a gap — and a gap in a chained log reads as tampering.
    await log.append(act('kept-a', { at: new Date('2020-01-01T00:00:00.000Z') }));
    await log.append(act('kept-b', { at: new Date('2020-03-01T00:00:00.000Z') }));
    await log.append(act('kept-c', { at: new Date('2020-02-01T00:00:00.000Z') }));
    await log.append(act('kept-d', { at: new Date('2026-08-01T00:00:00.000Z') }));

    // Counted before it is cut, because the page reports this number and the sweep is confirmed
    // against it. The two are one rule in the gateway; this is the check that they stay one.
    const counted = await gateway.countAuditPrefix(new Date('2026-01-01T00:00:00.000Z'));
    expect(counted).toMatchObject({ table: 'audit_events', total: 4, eligible: 3 });

    const { removed, floor } = await gateway.trimAuditPrefix(new Date('2026-01-01T00:00:00.000Z'), 'admin@example.com');
    expect(removed).toBe(counted.eligible);

    // All three of the 2020 events go, because they are a contiguous prefix. The floor is the last of
    // them, which is the digest the surviving log now begins after.
    expect({ removed, floor }).toEqual({ removed: 3, floor: 3 });

    const declared = await log.floor();
    expect(declared).toMatchObject({ sequence: 3, trimmedBy: 'admin@example.com' });

    const report = await log.verify();
    // The point of the floor. Without it the first surviving event names a predecessor nothing can
    // produce, and every verification from here to the end of the install reports a break.
    expect(report.breaks).toEqual([]);
    expect(report.checked).toBe(1);
  });

  it('keeps numbering above a floor rather than reissuing a sequence somebody already used', async () => {
    await db.query(`delete from ${KEPT}.audit_events`);

    const head = await log.head();
    const next = await log.append(act('kept-after-floor'));

    // The floor stands in for the events that are gone. Reading an emptied log as genesis would hand
    // sequence 1 to a second event and make the numbering a lie.
    expect(head.sequence).toBe(3);
    expect(next.sequence).toBe(4);
  });

  /*
   * The reset, last in this block because it empties the schema the tests above filled.
   *
   * Three things here are properties of the database rather than of `reset.ts`, and the fake can only
   * agree with the code that wrote it: an unqualified `delete from` over every table this app owns
   * actually leaves each one empty; a log with no rows and no floor reads as genesis again; and the
   * event appended afterwards lands at sequence 1 naming genesis as its predecessor, which is the whole
   * of what ADR 0048's amendment decided. The state going in is what the preceding tests left —
   * periods set, a hold placed and lifted, a floor declared by the trim, a surviving event above it —
   * which is a more interesting install to empty than one this test would have built for itself.
   */
  /*
   * The rollback, before the reset that empties everything — this has to run against an install with
   * rows in it, and the test below leaves none.
   *
   * Only a database can answer this. The fake models a transaction by copying its rows, so a fake-only
   * test proves that the copy works, not that Lakebase rolled anything back. What is asserted is the
   * combination the feature depends on: a throw part way through the emptying leaves every table it had
   * already emptied exactly as it was.
   */
  it('leaves the install untouched when the emptying throws part way through', async () => {
    const before = await planReset(gateway, await store.holds());
    expect(before.records).toBeGreaterThan(0);

    const failed = gateway.resetting(async (within) => {
      await within.empty('scans');
      await within.empty('decisions');
      throw new Error('and then the connection went');
    });

    await expect(failed).rejects.toThrow('and then the connection went');

    const after = await planReset(gateway, await store.holds());
    expect(after.records).toBe(before.records);
    expect(after.tables.map((one) => one.rows)).toEqual(before.tables.map((one) => one.rows));
  });

  it('empties every table, and the trail then restarts at genesis rather than above the old floor', async () => {
    // Seed both restricted edges the original reset order violated. The result cites a scan and the
    // definition version cites its definition; this is the real Lakebase shape behind the Labs
    // `assessment_results_run_fk` refusal, not a fake that merely accepts the declared order.
    const resetDefinition = define(
      {
        measurement: { scope: { kind: 'account' }, lookbackDays: 30 },
        attribution: { name: 'Reset ordering proof', owners: ['admin@example.com'] },
      },
      'kept-reset-definition',
      new Date('2026-08-06T00:00:00.000Z'),
      'admin@example.com'
    );
    await new PostgresDefinitionStore({ db }).create(resetDefinition);
    const resetVersion = resetDefinition.versions[0];
    if (resetVersion == null) throw new Error('The reset-order definition has no first version.');

    const resetScan = scan('kept-reset-final-run', '2026-08-06T00:01:00.000Z', 0.8);
    await new PostgresScanStore({ db }).save(resetScan);
    const resetReview = opened({
      id: 'kept-reset-review',
      runId: resetScan.id,
      openedBy: 'admin@example.com',
      openedAt: new Date('2026-08-06T00:02:00.000Z'),
    });
    await new PostgresReviewStore({ db, pillars: [] }).open(resetReview);
    const resetResult = {
      id: 'kept-reset-result',
      reviewId: resetReview.id,
      runId: resetScan.id,
      finalisedAt: new Date('2026-08-06T00:03:00.000Z'),
      definitionId: resetDefinition.id,
      definitionVersion: resetVersion.version,
      definitionFingerprint: resetVersion.fingerprint,
      schemaVersion: 2,
      publicMethodologyVersion: 1,
      catalogueRevision: 'reset-order-proof',
      eligible: false,
    };
    await db.query(
      `insert into ${KEPT}.assessment_results
         (id, review_id, run_id, finalised_at, body, digest, definition_id, definition_version,
          definition_fingerprint, schema_version, public_methodology_version, catalogue_revision, eligible)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        resetResult.id,
        resetResult.reviewId,
        resetResult.runId,
        resetResult.finalisedAt,
        JSON.stringify(resetResult),
        digestOf(resetResult),
        resetResult.definitionId,
        resetResult.definitionVersion,
        resetResult.definitionFingerprint,
        resetResult.schemaVersion,
        resetResult.publicMethodologyVersion,
        resetResult.catalogueRevision,
        resetResult.eligible,
      ]
    );

    const before = await planReset(gateway, await store.holds());
    // Non-trivial going in, or the assertions below would hold over an install that was already empty.
    expect(before.records).toBeGreaterThan(0);
    expect(await log.floor()).not.toBeUndefined();

    const reset = await resetInstall(gateway, () => store.holds(), 'admin@example.com');
    expect(reset.rows).toBe(before.records + before.events);

    const after = await planReset(gateway, await store.holds());
    expect(after.tables.filter((one) => one.rows > 0)).toEqual([]);

    // No rows and no floor, so the fallback in `head()` has nothing to continue from — which is the
    // point of emptying `audit_floor` at all. A floor left behind would put the next event at the old
    // sequence and chain it to a digest whose event is gone.
    expect(await log.head()).toEqual({ sequence: 0, digest: GENESIS });

    const root = await log.append(act('kept-reset', { action: 'retention.reset' }));
    expect(root).toMatchObject({ sequence: 1, previous: GENESIS });

    const report = await log.verify();
    expect(report.breaks).toEqual([]);
    // And the reading no longer mentions a trim, because there is no floor to explain. A reader who
    // finds a one-event chain finds the reason for it in the chain rather than in a sentence about
    // retention that would no longer be true.
    expect(report.means).not.toContain('begins at event');
  });
});

/**
 * The run record, whose every interesting statement is a race the fake cannot lose.
 *
 * The fake runs one statement at a time in one process, so a conditional update that ought to keep two
 * callers apart passes there whether the condition is in the `where` or in an `if` above it. Against a
 * real database, two claims issued at once are two transactions and only one may win — which is the
 * whole of the two-processes defence and the only place it can be demonstrated.
 *
 * The rest is what the wire does to these particular statements: a real unique index on
 * `idempotency_key` deciding a duplicate trigger rather than a read-then-insert; `attempts = attempts +
 * 1` incrementing in the database rather than in whichever caller read the number last; `state in
 * ($5, $6)` accepting a failed run back and refusing one that answered; a reading going out as jsonb
 * and coming back as a reading rather than as a string.
 */
describe.skipIf(!bound)('the run record against a real Lakebase database', () => {
  const RUNS = `${SCHEMA}_runs`;
  const REQUEST: RunRequest = { scope: { description: 'the account' }, lookbackDays: 30 };
  const AT = new Date('2026-08-06T00:00:00.000Z');
  let db: Postgres;
  let store: PostgresRunStore;

  beforeAll(async () => {
    db = await open(RUNS);
    store = new PostgresRunStore(db);
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    await db.query(`drop schema if exists ${RUNS} cascade`);
    await db.end();
  }, 60_000);

  function opening(id: string, key?: string): Opening {
    return {
      id,
      kind: 'assessment',
      actor: 'someone@example.com',
      trigger: 'scheduled',
      ...(key != null ? { idempotencyKey: key } : {}),
      request: REQUEST,
      requestedAt: AT,
    };
  }

  it('reads a run back with its dates as dates and what was asked for intact', async () => {
    const { run, created } = await store.open(opening('live-run-1', 'live-key-1'));

    expect(created).toBe(true);
    expect(run.requestedAt).toBeInstanceOf(Date);
    // Through jsonb and back. A scope that arrived as a string would resume a run against an estate
    // nobody chose, and the fake models jsonb well enough never to notice.
    expect(run.request).toEqual(REQUEST);
    expect((await store.byKey('live-key-1'))?.id).toBe('live-run-1');
  });

  it('reads a scope back as the same request, whatever order jsonb chose to keep its keys in', async () => {
    // The bug a live scheduled run found, pinned here because nothing smaller can see it. `jsonb` keeps
    // an object by its own key order, not the one it was written in, so the app's own scope and the app's
    // own scope read back stringified to two different strings — and the supervisor's retry after the app
    // was killed mid-scan was refused as a request measuring something else. Two keys, because with one
    // there is no order to disagree about, and the fake cannot disagree at all.
    const scope = { hostWorkspaceId: '7000000000000023', description: 'the whole account' };
    const asked: RunRequest = { scope, lookbackDays: 30 };
    const { run } = await store.open({ ...opening('live-run-scope'), request: asked });

    const readBack = await store.get('live-run-scope');

    expect(sameRequest(run.request, asked)).toBe(true);
    expect(sameRequest(readBack!.request, asked)).toBe(true);
    expect(
      joinable(readBack!, { actor: 'someone@example.com', kind: 'assessment', request: asked }, AT)
    ).toBeUndefined();
  });

  it('lets the database decide a duplicate trigger, rather than a read followed by an insert', async () => {
    const second = await store.open(opening('live-run-2', 'live-key-1'));

    expect(second.created).toBe(false);
    expect(second.run.id).toBe('live-run-1');
  });

  it('gives the run to exactly one of two claims issued at the same time', async () => {
    await store.open(opening('live-run-3'));

    // The assertion the fake cannot make. Both statements are in flight together against one row, and
    // the condition that keeps them apart is in the `where` of each.
    const [one, other] = await Promise.all([
      store.claim('live-run-3', 'process-a', AT),
      store.claim('live-run-3', 'process-b', AT),
    ]);

    expect([one, other].filter((attempt) => attempt != null)).toHaveLength(1);
    // And one attempt, not two: the increment happened in the database, so the loser did not also
    // count itself.
    expect((await store.get('live-run-3'))?.attempts).toBe(1);
  });

  it('keeps a checkpoint per signal, and hands it back as a reading', async () => {
    await store.open(opening('live-run-4'));
    const attempt = await store.claim('live-run-4', 'process-a', AT);
    const signal: SignalId = 'rest:workspace:token.list';
    await store.checkpoint('live-run-4', [observed(signal, { tokens: 3 }, 12)], AT);
    await store.checkpoint('live-run-4', [observed(signal, { tokens: 4 }, 12)], new Date(AT.getTime() + 1000));

    const reached = resumeFrom(await store.checkpoints('live-run-4'));

    // Upserted on the real composite key, so the second reading replaced the first rather than adding
    // a second copy of the estate for this attempt.
    expect(reached.size).toBe(1);
    expect(reached.get(signal)?.value).toEqual({ tokens: 4 });

    // And they go when the run has a scan holding the same readings.
    await store.finish(attempt!, { state: 'complete', at: AT, scanId: 'live-scan-4' });
    expect(await store.checkpoints('live-run-4')).toEqual([]);
    expect(await store.claim('live-run-4', 'process-b', new Date(AT.getTime() + 999_000))).toBeUndefined();
  });

  it('takes a failed run back up under its own key, keeping what the broken attempt reached', async () => {
    await store.open(opening('live-run-5', 'live-key-5'));
    const broke = await store.claim('live-run-5', 'process-a', AT);
    const signal: SignalId = 'rest:workspace:token.list';
    await store.checkpoint('live-run-5', [observed(signal, { tokens: 1 }, 9)], AT);
    await store.finish(broke!, { state: 'failed', at: AT, why: 'the warehouse went away' });

    expect(await store.checkpoints('live-run-5')).toHaveLength(1);

    const retry = await store.claim('live-run-5', 'process-b', new Date(AT.getTime() + 999_000));

    expect(retry?.number).toBe(2);
    const run = await store.get('live-run-5');
    expect(run?.state).toBe('running');
    expect(run?.finishedAt).toBeUndefined();
    // `failed` rather than `abandoned`: this attempt ended itself and said why, which is the difference
    // between a process that broke and one that was killed and had its run taken from it.
    expect((await store.attempts('live-run-5')).map((one) => one.outcome)).toEqual(['failed', undefined]);
  });

  it('writes nothing from an attempt that no longer holds the run, and says which one it was', async () => {
    // `finish` decides this from `returning` on its own conditional update rather than from a read, so
    // that a takeover between the read and the write cannot be missed. That distinction does not exist in
    // the fake, where nothing can happen between two statements.
    await store.open(opening('live-run-6'));
    const stalled = await store.claim('live-run-6', 'process-a', AT);
    const signal: SignalId = 'rest:workspace:token.list';
    await store.checkpoint('live-run-6', [observed(signal, { tokens: 2 }, 7)], AT);
    const took = await store.claim('live-run-6', 'process-b', new Date(AT.getTime() + 999_000));

    expect(await store.finish(stalled!, { state: 'complete', at: AT, scanId: 'live-scan-stale' })).toBe(false);

    // The readings the holder is resuming from are still there, and the run is still that holder's.
    expect(await store.checkpoints('live-run-6')).toHaveLength(1);
    const during = await store.get('live-run-6');
    expect(during?.state).toBe('running');
    expect(during?.scanId).toBeUndefined();
    expect(await store.finish(took!, { state: 'complete', at: AT, scanId: 'live-scan-6' })).toBe(true);
    expect((await store.get('live-run-6'))?.scanId).toBe('live-scan-6');
  });

  it('records a cancel as a date and nothing else, so it cannot overwrite an outcome', async () => {
    await store.cancel('live-run-5', new Date(AT.getTime() + 5000));
    await store.cancel('live-run-5', new Date(AT.getTime() + 9000));

    const run = await store.get('live-run-5');
    expect(run?.state).toBe('running');
    // The first request, so the date says when the decision was made rather than when it was repeated.
    expect(run?.cancelRequestedAt).toEqual(new Date(AT.getTime() + 5000));
    expect(await store.cancelRequested('live-run-5')).toBe(true);
  });

  it('reads the unfinished runs newest first, over a real index', async () => {
    const unfinished = (await store.unfinished()).map((one) => one.id);

    // `live-run-4` finished; the rest were left running by the tests above.
    expect(unfinished).not.toContain('live-run-4');
    expect(unfinished).toContain('live-run-5');
  });
});

/*
 * The two reads `36i` moved into SQL, against a real planner.
 *
 * Here rather than only in the fake because of what the fake is: a matcher that recognises the shapes
 * the stores emit. It was taught both of these statements in the same change that wrote them, so it
 * agrees with them by construction — it would agree with a correlated subquery whose correlation was
 * on the wrong column just as readily. What these two prove is that Postgres reads them the way the
 * fake was told to.
 */
describe.skipIf(!bound)('the reads that count and exclude in SQL, against a real Lakebase database', () => {
  let db: Postgres;
  const REQUESTED = new Date('2026-08-14T09:00:00.000Z');

  beforeAll(async () => {
    db = await open(`${SCHEMA}_reads`);
  }, 60_000);

  afterAll(async () => {
    if (db == null) return;
    await db.query(`drop schema if exists ${SCHEMA}_reads cascade`);
    await db.end();
  }, 60_000);

  it('offers the attempts with no answered sibling, and no others', async () => {
    const store = new PostgresValidationStore({ db });
    const asked = (id: string, actionId: string): ValidationAttempt => ({
      id,
      planId: 'live-plan',
      actionId,
      checks: [{ controlId: 'DG-01-01', method: 'measured' }],
      claimedAt: REQUESTED,
      requestedBy: 'ana@example.com',
      requestedAt: REQUESTED,
      observeFrom: REQUESTED,
      observeDays: 0,
    });

    await store.add(asked('live-open', 'live-action-1'));
    await store.add(asked('live-settled', 'live-action-2'));
    await store.answer(
      answeredBy(asked('live-settled', 'live-action-2'), {
        scanId: 'live-scan',
        measuredAt: new Date('2026-08-15T09:00:00.000Z'),
        observations: [{ controlId: 'DG-01-01', outcome: 'pass' }],
      })
    );

    // The answered attempt's revision-0 row still reads `answered = false` and is still in the table.
    // What keeps it out of this answer is the subquery, so a correlation on the wrong column shows up
    // here as a second id.
    expect((await store.outstanding()).map((one) => one.id)).toEqual(['live-open']);
  });

  it('counts notes per subject in the database, with the bigint parsed rather than passed on', async () => {
    const notes = new PostgresNoteStore({ db });
    const write = (id: string, subjectId: string): Promise<void> =>
      notes.add({
        id,
        subject: { kind: 'control', id: subjectId },
        body: 'A live test wrote this note, and it is long enough to be a real one.',
        by: 'ana@example.com',
        at: REQUESTED,
      });

    await write('live-note-1', 'DG-01-01');
    await write('live-note-2', 'DG-01-01');
    await write('live-note-3', 'OE-02-04');
    // A different kind of subject, which the count must not fold in.
    await notes.add({
      id: 'live-note-4',
      subject: { kind: 'pillar', id: 'DG-01-01' },
      body: 'About the pillar rather than the requirement, and long enough to keep.',
      by: 'ana@example.com',
      at: REQUESTED,
    });

    const counted = await notes.counts('control');

    // Numbers, not the strings `count(*)` arrives as: `int8` comes over the wire as text so nothing is
    // silently rounded, and a store that passed it through would put "2" on a page that adds it up.
    expect(counted).toEqual({ 'DG-01-01': 2, 'OE-02-04': 1 });
    expect(Object.values(counted).every((one) => typeof one === 'number')).toBe(true);
  });

  it('lists imports from the summary column, and summarises a row that predates it', async () => {
    // The two halves of `85` the fake cannot settle. The first is that `summary` survives the round
    // trip through a real driver as an object rather than the text it was sent — the same failure the
    // note at the top of `postgres-fake.ts` describes, which only a real database can disprove. The
    // second is the repair: it reads bodies, writes summaries back, and the write has to land.
    const store = new PostgresEvidenceImportStore({ db });
    const raw = envelope();
    const held = envelopeFrom({ ...raw, digest: digestOf(raw.probes) });
    const one = {
      digest: `sha256:${'a7'.repeat(32)}`,
      generatedAt: new Date(held.generatedAt),
      importedAt: REQUESTED,
      importedBy: 'importer@example.com',
      envelope: held,
      cautions: [],
    };
    await store.record(one);

    const [listed] = await store.summaries();
    expect(listed?.summary.observed).toBe(1);
    // The text the file carries, not the column's round trip of it. A driver that handed back the
    // parsed timestamp would show a collection time the digest does not cover.
    expect(listed?.summary.generatedAt).toBe(held.generatedAt);

    // Now the upgrade case: a row with no summary, which is every row an install already holds.
    await db.query(`update ${db.schema}.imported_evidence set summary = null where digest = $1`, [one.digest]);
    const [repaired] = await store.summaries();
    expect(repaired?.summary.observed).toBe(1);

    const { rows } = await db.query<{ summary: unknown }>(
      `select summary from ${db.schema}.imported_evidence where digest = $1`,
      [one.digest]
    );
    // Written back, and written back as jsonb. A row still null here would mean every list read of
    // this install's legacy imports fetches their envelopes forever.
    expect(rows[0]?.summary).not.toBeNull();
    expect(typeof rows[0]?.summary).toBe('object');
  });
});
