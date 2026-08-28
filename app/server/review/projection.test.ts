import { describe, expect, it } from 'vitest';
import type { Attestation } from '../attest/attestation.js';
import { PostgresAttestationStore } from '../attest/postgres-store.js';
import { loadCatalogue } from '../catalogue/catalogue.js';
import { digestOf } from '../records/digest.js';
import { resolveControl, ResolverRegistry } from '../resolve/resolver.js';
import { buildRegistry } from '../resolve/resolvers/index.js';
import { scoreFindings } from '../score/score.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import type { Scan } from '../scan/scan.js';
import { PostgresScanStore } from '../scan/postgres-store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import { answered, confirmed, finalised, opened, skipped, type AssessmentResult } from './review.js';
import { PostgresReviewStore } from './postgres-store.js';
import { FinalAssessmentProjectionError, finalAssessmentProjector } from './projection.js';

const AT = new Date('2026-08-19T10:00:00.000Z');
const FINALISED = new Date('2026-08-19T11:00:00.000Z');
const catalogue = loadCatalogue();
const registry = new ResolverRegistry();
const projector = finalAssessmentProjector({ catalogue, registry });
const control =
  catalogue.controls.find((one) => one.id === 'OE-01-01') ??
  (() => {
    throw new Error('The projection fixture requires OE-01-01.');
  })();
const pillars = catalogue.pillars.map((one) => one.id);

function attestation(id: string, answer: Attestation['answer'], over: Partial<Attestation> = {}): Attestation {
  return {
    id,
    controlId: control.id,
    answer,
    statement: `${answer} at ${id}`,
    owner: 'platform@example.com',
    attestedBy: 'priya@example.com',
    attestedAt: AT,
    reviewBy: new Date('2026-11-19T00:00:00.000Z'),
    definitionId: 'definition-1',
    ...over,
  };
}

function scan(using: Attestation): Scan {
  const finding = resolveControl(control, new Map(), undefined, using);
  return {
    id: 'scan-1',
    startedAt: AT,
    finishedAt: new Date('2026-08-19T10:05:00.000Z'),
    state: 'complete',
    stamp: {
      publicMethodology: {
        publicVersion: 1,
        manifestDigest: 'sha256:public-methodology-version-1',
        state: 'candidate',
      },
      catalogueVersion: catalogue.version.version,
      catalogueFingerprint: catalogue.version.fingerprint,
      executionMode: 'on-behalf-of-user',
      actor: 'priya@example.com',
      scope: { hostWorkspaceId: '123', description: 'the account' },
      lookbackDays: 30,
      definition: { id: 'definition-1', version: 3, fingerprint: 'sha256:definition-1' },
      identity: {
        build: { id: '0.1.0+projection-test' },
        methodology: { id: 'sha256:scoring' },
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
        pillarId: control.pillarId,
        scanId: 'scan-1',
        measuredAt: new Date('2026-08-19T10:05:00.000Z'),
        actor: 'priya@example.com',
        carriedForward: false,
      },
    ],
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

function result(
  attestationIds: readonly string[],
  skippedOperational = false,
  target: Pick<(typeof catalogue.controls)[number], 'id' | 'pillarId'> = control
): AssessmentResult {
  const review = opened({
    id: 'review-1',
    runId: 'scan-1',
    openedBy: 'priya@example.com',
    openedAt: AT,
    definitionId: 'definition-1',
    definitionVersion: 3,
    definitionFingerprint: 'sha256:definition-1',
  });
  const decisions = pillars.map((pillarId) =>
    pillarId === target.pillarId && !skippedOperational
      ? confirmed(
          {
            id: `decision-${pillarId}`,
            reviewId: review.id,
            runId: review.runId,
            pillarId,
            by: 'priya@example.com',
            at: FINALISED,
            attestationIds,
          },
          pillars
        )
      : skipped(
          {
            id: `decision-${pillarId}`,
            reviewId: review.id,
            runId: review.runId,
            pillarId,
            by: 'priya@example.com',
            at: FINALISED,
            unresolvedControlIds: pillarId === target.pillarId ? [target.id] : [],
          },
          pillars
        )
  );
  return finalised(
    {
      id: 'result-1',
      review,
      pillars: decisions,
      finalisedBy: 'priya@example.com',
      finalisedAt: FINALISED,
    },
    pillars
  );
}

describe('the final assessment projection', () => {
  it('projects findings, scores and decisions only for the immutable selected pillar set', () => {
    const old = attestation('att-old', 'met');
    const source = scan(old);
    const selected = [control.pillarId];
    const narrowReview = opened({
      id: 'review-1',
      runId: 'scan-1',
      openedBy: 'priya@example.com',
      openedAt: AT,
      definitionId: 'definition-1',
      definitionVersion: 3,
      definitionFingerprint: 'sha256:definition-1',
      selectedPillars: selected,
    });
    const narrowResult = finalised(
      {
        id: 'result-1',
        review: narrowReview,
        pillars: [
          confirmed(
            {
              id: `decision-${control.pillarId}`,
              reviewId: narrowReview.id,
              runId: narrowReview.runId,
              pillarId: control.pillarId,
              by: 'priya@example.com',
              at: FINALISED,
              attestationIds: [old.id],
            },
            pillars
          ),
        ],
        finalisedBy: 'priya@example.com',
        finalisedAt: FINALISED,
      },
      selected
    );
    const excluded = {
      ...source.findings[0],
      controlId: 'EXCLUDED-01',
      pillarId: 'reliability',
    };
    const projected = projector({
      result: narrowResult,
      scan: { ...source, findings: [...source.findings, excluded] },
      runDigest: 'sha256:run',
      answers: [],
      attestations: [old],
    });

    expect(projected.finalAssessment.outcome.findings.map((one) => one.finding.pillarId)).toEqual(selected);
    expect(projected.finalAssessment.outcome.score.pillars.map((one) => one.pillarId)).toEqual(selected);
    expect(projected.finalAssessment.decisions.map((one) => one.pillarId)).toEqual(selected);
    expect(projected.finalAssessment.publication.reasons).toEqual(['methodology-not-released']);
  });

  it('uses a refreshed answer without changing the immutable run', () => {
    const old = attestation('att-old', 'not-met');
    const refreshed = attestation('att-new', 'met', { supersedes: old.id });
    const source = scan(old);
    const before = digestOf(source);
    const projected = projector({
      result: result([refreshed.id]),
      scan: source,
      runDigest: 'sha256:run',
      answers: [
        answered(
          {
            id: 'answer-1',
            reviewId: 'review-1',
            runId: 'scan-1',
            pillarId: control.pillarId,
            controlId: control.id,
            attestationId: refreshed.id,
            by: 'priya@example.com',
            at: FINALISED,
          },
          pillars
        ),
      ],
      attestations: [refreshed],
    });

    expect(source.findings[0]?.outcome).toBe('fail');
    expect(projected.finalAssessment.outcome.findings[0]?.finding.outcome).toBe('pass');
    expect(projected.finalAssessment.disclosure.refreshedAttestationIds).toEqual([refreshed.id]);
    expect(projected.finalAssessment.automatedEvidence.runDigest).toBe('sha256:run');
    expect(digestOf(source)).toBe(before);
  });

  it('turns skipped human evidence into an explicit unmeasured outcome', () => {
    const old = attestation('att-old', 'met');
    const projected = projector({
      result: result([], true),
      scan: scan(old),
      runDigest: 'sha256:run',
      answers: [],
      attestations: [],
    });

    expect(projected.finalAssessment.outcome.findings[0]?.finding).toMatchObject({
      outcome: 'unmeasurable',
      unmeasured: 'attestation',
    });
    expect(projected.finalAssessment.disclosure.skippedPillarIds).toContain(control.pillarId);
    expect(projected.finalAssessment.disclosure).toMatchObject({
      unresolvedControlIds: [control.id],
      unmeasuredControlIds: [control.id],
    });
  });

  it('preserves an unreadable automated finding when the review supplied no human evidence', () => {
    const source = scan(attestation('att-old', 'met'));
    const costControl = catalogue.controls.find((one) => one.id === 'CO-01-03');
    if (costControl == null) throw new Error('The projection regression requires CO-01-03.');
    const original = source.findings[0];
    if (original == null) throw new Error('The projection fixture has no finding.');
    const { attested: _attested, ...withoutAttestation } = original;
    const unreadable = {
      ...withoutAttestation,
      controlId: costControl.id,
      pillarId: costControl.pillarId,
      outcome: 'unmeasurable' as const,
      unmeasured: 'unreadable' as const,
      evidence: [],
    };
    const productionLike: Scan = {
      ...source,
      findings: [unreadable],
      score: scoreFindings([unreadable]),
      measurement: source.measurement.map((one) => ({ ...one, pillarId: costControl.pillarId })),
    };

    const projected = finalAssessmentProjector({ catalogue, registry: buildRegistry() })({
      result: result([], true),
      scan: productionLike,
      runDigest: 'sha256:run',
      answers: [],
      attestations: [],
    });

    expect(projected.finalAssessment.outcome.findings[0]?.finding).toEqual(unreadable);
  });

  it('settles a stored unmeasurable finding without re-running its resolver over a sparse payload', () => {
    const source = scan(attestation('att-old', 'met'));
    const costControl = catalogue.controls.find((one) => one.id === 'CO-01-03');
    if (costControl == null) throw new Error('The projection regression requires CO-01-03.');
    const original = source.findings[0];
    if (original == null) throw new Error('The projection fixture has no finding.');
    const { attested: _attested, ...withoutAttestation } = original;
    const unreadable = {
      ...withoutAttestation,
      controlId: costControl.id,
      pillarId: costControl.pillarId,
      outcome: 'unmeasurable' as const,
      unmeasured: 'unreadable' as const,
      evidence: [],
    };
    const selected = attestation('att-cost', 'met', { controlId: costControl.id });
    const productionLike: Scan = {
      ...source,
      findings: [unreadable],
      score: scoreFindings([unreadable]),
      signals: [
        {
          id: 'sql:workload.sql_paths',
          status: 'observed',
          coverage: { mode: 'complete' },
          collectedAt: AT,
          durationMs: 1,
        },
      ],
      measurement: source.measurement.map((one) => ({ ...one, pillarId: costControl.pillarId })),
    };

    const projected = finalAssessmentProjector({ catalogue, registry: buildRegistry() })({
      result: result([selected.id], false, costControl),
      scan: productionLike,
      runDigest: 'sha256:run',
      answers: [],
      attestations: [selected],
    });

    expect(projected.finalAssessment.outcome.findings[0]?.finding).toMatchObject({
      controlId: costControl.id,
      outcome: 'pass',
      attested: { id: selected.id, bearing: 'outcome' },
    });
  });

  it('removes an uncited outcome answer without replaying a resolver over a sparse stored signal', () => {
    const source = scan(attestation('att-old', 'met'));
    const costControl = catalogue.controls.find((one) => one.id === 'CO-01-08');
    if (costControl == null) throw new Error('The projection regression requires CO-01-08.');
    const original = source.findings[0];
    if (original == null) throw new Error('The projection fixture has no finding.');
    const evidence = [
      {
        signal: 'sql:compute.node_utilization' as const,
        observed: 'The stored reading did not settle whether classic compute was right-sized.',
        coverage: { mode: 'complete' as const },
        collectedAt: AT,
      },
    ];
    const answered = {
      ...original,
      controlId: costControl.id,
      pillarId: costControl.pillarId,
      principleId: costControl.principleId,
      title: costControl.title,
      evidence,
    };
    const productionLike: Scan = {
      ...source,
      findings: [answered],
      score: scoreFindings([answered]),
      signals: [
        {
          id: 'sql:compute.node_utilization',
          status: 'observed',
          coverage: { mode: 'complete' },
          collectedAt: AT,
          durationMs: 1,
        },
      ],
      measurement: source.measurement.map((one) => ({ ...one, pillarId: costControl.pillarId })),
    };

    const projected = finalAssessmentProjector({ catalogue, registry: buildRegistry() })({
      result: result([], false, costControl),
      scan: productionLike,
      runDigest: 'sha256:run',
      answers: [],
      attestations: [],
    });

    expect(projected.finalAssessment.outcome.findings[0]?.finding).toEqual({
      ...answered,
      attested: undefined,
      outcome: 'unmeasurable',
      unmeasured: 'attestation',
      outcomeReason:
        'The completed review cited no current answer for this requirement, so the published report records it as unmeasured.',
    });
  });

  it('derives unresolved controls only for legacy skips that predate the frozen manifest', () => {
    const old = attestation('att-old', 'met');
    const legacy = result([], true);
    const pillarsWithoutManifest = legacy.pillars.map((pillar) => {
      if (pillar.kind !== 'skipped') return pillar;
      const { unresolvedControlIds: _legacyMissing, ...withoutManifest } = pillar;
      return withoutManifest;
    });
    const projected = projector({
      result: { ...legacy, pillars: pillarsWithoutManifest },
      scan: scan(old),
      runDigest: 'sha256:run',
      answers: [],
      attestations: [],
    });

    expect(projected.finalAssessment.disclosure.unresolvedControlIds).toContain(control.id);
  });

  it('records an answer beside a measured outcome without letting it override the measurement', () => {
    const contrary = attestation('att-contrary', 'not-met');
    const source = scan(contrary);
    const measured = {
      ...source.findings[0],
      outcome: 'pass' as const,
      evidence: [
        {
          signal: 'sql:account.operation-audit' as const,
          observed: 'The estate measurement passed.',
          coverage: { mode: 'complete' as const },
          collectedAt: AT,
        },
      ],
      attested: undefined,
    };
    const measuredScan: Scan = { ...source, findings: [measured], score: scoreFindings([measured]) };
    const projected = projector({
      result: result([contrary.id]),
      scan: measuredScan,
      runDigest: 'sha256:run',
      answers: [],
      attestations: [contrary],
    });

    expect(projected.finalAssessment.outcome.findings[0]?.finding).toMatchObject({
      outcome: 'pass',
      attested: { id: contrary.id, bearing: 'record' },
    });
  });

  it('is byte-stable on retry and distinguishes reused evidence', () => {
    const old = attestation('att-old', 'met');
    const input = {
      result: result([old.id]),
      scan: scan(old),
      runDigest: 'sha256:run',
      answers: [],
      attestations: [old],
    };
    const first = projector(input);
    const second = projector(input);

    expect(second).toEqual(first);
    expect(digestOf(second)).toBe(digestOf(first));
    expect(first.finalAssessment.disclosure.reusedAttestationIds).toEqual([old.id]);
    expect(first.finalAssessment.automatedEvidence.findingIds[0]).toMatch(/^finding-/);
    expect(first.finalAssessment.publication).toEqual({
      eligible: false,
      reasons: ['methodology-not-released'],
    });
  });

  it('refuses expired and cross-definition evidence', () => {
    const old = attestation('att-old', 'met');
    const base = {
      result: result([old.id]),
      scan: scan(old),
      runDigest: 'sha256:run',
      answers: [],
    };

    expect(() => projector({ ...base, attestations: [{ ...old, reviewBy: FINALISED }] })).toThrow(
      FinalAssessmentProjectionError
    );
    expect(() => projector({ ...base, attestations: [{ ...old, definitionId: 'definition-other' }] })).toThrow(
      /different assessment definition/
    );
  });
});

describe('the durable final assessment transaction', () => {
  function database(): FakePostgres {
    return new FakePostgres({
      unique: {
        assessment_reviews: ['run_id'],
        pillar_reviews: [['review_id', 'pillar_id']],
        review_answers: ['attestation_id'],
        assessment_results: ['review_id'],
      },
    });
  }

  async function prepared(recordAttestation: boolean): Promise<{
    db: FakePostgres;
    store: PostgresReviewStore;
    old: Attestation;
  }> {
    const db = database();
    const old = attestation('att-old', 'met');
    await new PostgresScanStore({ db }).save(scan(old));
    if (recordAttestation) await new PostgresAttestationStore({ db }).record(old);
    const store = new PostgresReviewStore({
      db,
      pillars,
      projector,
      newId: () => 'result-durable',
    });
    await store.open(
      opened({
        id: 'review-1',
        runId: 'scan-1',
        openedBy: 'priya@example.com',
        openedAt: AT,
        definitionId: 'definition-1',
        definitionVersion: 3,
        definitionFingerprint: 'sha256:definition-1',
      })
    );
    for (const pillarId of pillars.filter((one) => one !== control.pillarId)) {
      await store.record(
        skipped(
          {
            id: `decision-${pillarId}`,
            reviewId: 'review-1',
            runId: 'scan-1',
            pillarId,
            by: 'priya@example.com',
            at: FINALISED,
          },
          pillars
        )
      );
    }
    return { db, store, old };
  }

  function last(old: Attestation) {
    return confirmed(
      {
        id: `decision-${control.pillarId}`,
        reviewId: 'review-1',
        runId: 'scan-1',
        pillarId: control.pillarId,
        by: 'priya@example.com',
        at: FINALISED,
        attestationIds: [old.id],
      },
      pillars
    );
  }

  it('locks, writes one promoted Version 2 row and returns it unchanged on retry', async () => {
    const { db, store, old } = await prepared(true);
    const first = await store.record(last(old));
    const retried = await store.record(last(old));

    expect(first.result?.schemaVersion).toBe(2);
    expect(retried.result).toEqual(first.result);
    expect(db.rows('assessment_results')).toHaveLength(1);
    expect(db.rows('assessment_results')[0]).toMatchObject({
      id: 'result-durable',
      review_id: 'review-1',
      run_id: 'scan-1',
      schema_version: 2,
      public_methodology_version: 1,
      catalogue_revision: catalogue.version.version,
      eligible: false,
    });
    expect(db.statements.some((statement) => /assessment_reviews where id = \$1 for update$/i.test(statement))).toBe(
      true
    );
  });

  it('rolls the terminal pillar back when exact cited evidence is missing', async () => {
    const { db, store, old } = await prepared(false);
    const before = db.rows('pillar_reviews').length;

    await expect(store.record(last(old))).rejects.toThrow(/attestation cited by this review could not be read/i);
    expect(db.rows('pillar_reviews')).toHaveLength(before);
    expect(db.rows('assessment_results')).toHaveLength(0);
  });
});
