import { describe, expect, it } from 'vitest';
import type { Attestation } from '../attest/attestation.js';
import { digestOf } from '../records/digest.js';
import type { Scan } from '../scan/scan.js';
import { CollectionScheduler } from '../scan/scheduler.js';
import {
  InvalidReviewError,
  complete,
  confirmed,
  finalised,
  opened,
  openedFor,
  pillarEvidenceManifest,
  skipped,
  type AssessmentReview,
  type PillarReview,
} from './review.js';

const NOW = new Date('2026-08-13T09:00:00.000Z');
const LATER = new Date('2026-08-13T10:00:00.000Z');
const PILLARS = ['security-compliance-and-privacy', 'reliability'] as const;

function review(over: Partial<AssessmentReview> = {}): AssessmentReview {
  return opened({
    id: 'rev-1',
    runId: 'scan-1',
    openedBy: 'priya@example.com',
    openedAt: NOW,
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
      by: 'priya@example.com',
      at: NOW,
      ...over,
    },
    PILLARS
  );
}

function scan(over: Partial<Scan> = {}): Scan {
  const startedAt = NOW;
  return {
    id: 'scan-1',
    startedAt,
    finishedAt: LATER,
    state: 'complete',
    stamp: {
      catalogueVersion: '3',
      catalogueFingerprint: 'abc',
      executionMode: 'on-behalf-of-user',
      actor: 'scheduler@example.com',
      scope: { hostWorkspaceId: '123', description: 'the account' },
      lookbackDays: 30,
      definition: { id: 'def-a', version: 1, fingerprint: 'f' },
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
    ...over,
  };
}

describe('opening a review', () => {
  it('names the scan, who opened it, and when', () => {
    expect(review()).toMatchObject({
      id: 'rev-1',
      runId: 'scan-1',
      openedBy: 'priya@example.com',
      openedAt: NOW,
    });
  });

  it('stamps the assessment the scan was of, and leaves it off when the scan named none', () => {
    expect(openedFor(scan(), { id: 'rev-1' })).toMatchObject({
      definitionId: 'def-a',
      definitionVersion: 1,
      definitionFingerprint: 'f',
    });
    const unscoped = scan();
    const { definition: _dropped, ...stamp } = unscoped.stamp;
    expect(openedFor({ ...unscoped, stamp }, { id: 'rev-1' }).definitionId).toBeUndefined();
  });

  it('copies the run requested pillar set onto the immutable review scope', () => {
    expect(openedFor(scan({ requestedPillars: ['reliability'] }), { id: 'rev-1' }).selectedPillars).toEqual([
      'reliability',
    ]);
    expect(openedFor(scan(), { id: 'rev-1' }).selectedPillars).toBeUndefined();
  });

  it("attributes an auto-opened review to the scan's actor, not to a person who was not there", () => {
    const opened = openedFor(scan(), { id: 'rev-1' });
    expect(opened.openedBy).toBe('scheduler@example.com');
    expect(opened.runId).toBe('scan-1');
    expect(opened.openedAt).toEqual(LATER);
  });

  it('refuses a review that names no scan', () => {
    expect(() => review({ runId: '  ' })).toThrow(InvalidReviewError);
  });
});

describe('a skip is a record', () => {
  it('carries actor, time, run and pillar — the four things an absence cannot', () => {
    const recorded = skip('reliability', { by: 'ana@example.com', at: LATER });
    expect(recorded).toMatchObject({
      kind: 'skipped',
      pillarId: 'reliability',
      runId: 'scan-1',
      by: 'ana@example.com',
      at: LATER,
    });
    expect(recorded.attestationIds).toBeUndefined();
    expect(recorded.unresolvedControlIds).toEqual([]);
  });

  it('is not a confirm: a skipped pillar cites no attestation', () => {
    expect(skip('reliability')).not.toHaveProperty('attestationIds');
    expect(confirm('reliability').kind).toBe('confirmed');
  });
});

describe('a pillar evidence manifest', () => {
  const controls = [
    { id: 'SCP-01-01', pillarId: 'security-compliance-and-privacy' },
    { id: 'SCP-01-02', pillarId: 'security-compliance-and-privacy' },
    { id: 'RE-01-01', pillarId: 'reliability' },
  ];

  function answer(id: string, controlId: string, reviewBy: Date): Attestation {
    return {
      id,
      controlId,
      answer: 'met',
      statement: 'The platform team reviews this evidence every quarter.',
      owner: 'platform@example.com',
      attestedBy: 'priya@example.com',
      attestedAt: NOW,
      reviewBy,
    };
  }

  it('accepts current ids, keeps due work in attention, and freezes the complete skip set', () => {
    const manifest = pillarEvidenceManifest(
      controls,
      [
        answer('att-current', 'SCP-01-01', new Date('2027-08-13T09:00:00.000Z')),
        {
          ...answer('att-due', 'SCP-01-02', new Date('2026-08-20T09:00:00.000Z')),
          attestedAt: new Date('2026-07-21T09:00:00.000Z'),
        },
        answer('att-other', 'RE-01-01', new Date('2027-08-13T09:00:00.000Z')),
      ],
      'security-compliance-and-privacy',
      NOW
    );

    expect(manifest.attestationIds).toEqual(['att-current']);
    expect(manifest.attentionControlIds).toEqual(['SCP-01-02']);
    expect(manifest.unresolvedControlIds).toEqual(['SCP-01-01', 'SCP-01-02']);
  });
});

describe('confirm-current', () => {
  it('copies the attestation ids it was given, including none', () => {
    expect(confirm('reliability').attestationIds).toEqual(['att-1']);
    expect(confirm('reliability', { attestationIds: [] }).attestationIds).toEqual([]);
  });

  it('refuses a pillar this catalogue does not have', () => {
    expect(() => confirm('not-a-pillar')).toThrow(/no pillar called not-a-pillar/);
  });
});

describe('when a result exists', () => {
  it('is written only when every named pillar has a confirm or a skip', () => {
    expect(complete(PILLARS, [confirm('reliability')])).toBe(false);
    expect(complete(PILLARS, [confirm('reliability'), skip('security-compliance-and-privacy')])).toBe(true);
    expect(complete([], [])).toBe(false);
  });

  it('cites the scan, the confirmed attestations, and not the skipped pillar as reviewed', () => {
    const result = finalised(
      {
        id: 'res-1',
        review: review({ definitionId: 'def-a' }),
        pillars: [confirm('security-compliance-and-privacy'), skip('reliability')],
        finalisedBy: 'priya@example.com',
        finalisedAt: LATER,
      },
      PILLARS
    );

    expect(result.runId).toBe('scan-1');
    expect(result.reviewId).toBe('rev-1');
    expect(result.definitionId).toBe('def-a');
    expect(result.definitionVersion).toBeUndefined();
    expect(result.pillars.map((one) => one.kind)).toEqual(['confirmed', 'skipped']);
    expect(result.attestationIds).toEqual(['att-1']);
    expect(result.pillars[1]).toMatchObject({ kind: 'skipped', pillarId: 'reliability' });
    expect(digestOf(result)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => JSON.stringify(result)).not.toThrow();
  });

  it('carries the immutable definition version and fingerprint from review to result', () => {
    const result = finalised(
      {
        id: 'res-1',
        review: review({ definitionId: 'def-a', definitionVersion: 4, definitionFingerprint: 'sha256:def' }),
        pillars: [confirm('security-compliance-and-privacy'), skip('reliability')],
        finalisedBy: 'priya@example.com',
        finalisedAt: LATER,
      },
      PILLARS
    );

    expect(result).toMatchObject({
      definitionId: 'def-a',
      definitionVersion: 4,
      definitionFingerprint: 'sha256:def',
    });
  });

  it('carries the immutable selected pillar set from review to result', () => {
    const result = finalised(
      {
        id: 'res-1',
        review: review({ selectedPillars: ['reliability'] }),
        pillars: [skip('reliability')],
        finalisedBy: 'priya@example.com',
        finalisedAt: LATER,
      },
      ['reliability']
    );

    expect(result.selectedPillars).toEqual(['reliability']);
    expect(result.pillars.map((one) => one.pillarId)).toEqual(['reliability']);
  });

  it('orders pillars as the catalogue named them, not as they were clicked', () => {
    const result = finalised(
      {
        id: 'res-1',
        review: review(),
        pillars: [skip('reliability'), confirm('security-compliance-and-privacy', { attestationIds: ['a'] })],
        finalisedBy: 'priya@example.com',
        finalisedAt: LATER,
      },
      PILLARS
    );
    expect(result.pillars.map((one) => one.pillarId)).toEqual([...PILLARS]);
    expect(result.attestationIds).toEqual(['a']);
  });

  it('refuses to write a result while a pillar is still unrecorded', () => {
    expect(() =>
      finalised(
        {
          id: 'res-1',
          review: review(),
          pillars: [confirm('reliability')],
          finalisedBy: 'priya@example.com',
          finalisedAt: LATER,
        },
        PILLARS
      )
    ).toThrow(/still short of that/);
  });
});
