import { describe, expect, it } from 'vitest';
import {
  ATTENTION_REASONS,
  attentionReason,
  pillarToWrite,
  recordedOf,
  resumePillar,
  summarisePillars,
} from './review-summary';
import type { AssessmentReview, AttestableRequirement, Finding, PillarReview } from '../api/types';

const PILLARS = ['operational-excellence', 'security', 'reliability'] as const;

function requirement(
  over: Partial<AttestableRequirement> & Pick<AttestableRequirement, 'controlId' | 'pillarId'>
): AttestableRequirement {
  return {
    principleId: 'p',
    title: over.controlId,
    severity: 'high',
    askedBecause: 'no-telemetry',
    question: 'Is it so?',
    cadenceDays: 180,
    ...over,
  };
}

function answered(state: 'current' | 'due' | 'expired'): NonNullable<AttestableRequirement['attestation']> {
  return {
    id: 'a1',
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Yes.',
    owner: 'platform@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: '2026-01-01T00:00:00.000Z',
    reviewBy: '2026-07-01T00:00:00.000Z',
    state,
  };
}

function finding(over: Partial<Finding> & Pick<Finding, 'controlId' | 'pillarId'>): Finding {
  return {
    principleId: 'p',
    title: over.controlId,
    outcome: 'pass',
    severity: 'low',
    coverage: { mode: 'complete' },
    evidence: [],
    ...over,
  };
}

function review(pillars: readonly PillarReview[] = []): AssessmentReview {
  return {
    id: 'rev-1',
    runId: 'run-1',
    openedBy: 'admin@example.com',
    openedAt: '2026-08-01T00:00:00.000Z',
    pillars,
    answers: [],
    durable: true,
  };
}

function recorded(pillarId: string, kind: PillarReview['kind'] = 'confirmed'): PillarReview {
  return {
    id: `rec-${pillarId}`,
    reviewId: 'rev-1',
    runId: 'run-1',
    pillarId,
    kind,
    by: 'admin@example.com',
    at: '2026-08-02T00:00:00.000Z',
    ...(kind === 'confirmed' ? { attestationIds: ['a1'] } : {}),
  };
}

describe('why a requirement needs attention', () => {
  it('leaves a current answer off the list', () => {
    expect(
      attentionReason(
        requirement({ controlId: 'OE-01-01', pillarId: 'operational-excellence', attestation: answered('current') })
      )
    ).toBeNull();
  });

  it('asks an unanswered requirement', () => {
    expect(attentionReason(requirement({ controlId: 'OE-01-01', pillarId: 'operational-excellence' }))).toBe(
      'unanswered'
    );
  });

  it('asks a lapsed answer as expired, not as unanswered', () => {
    expect(
      attentionReason(
        requirement({ controlId: 'OE-01-01', pillarId: 'operational-excellence', attestation: answered('expired') })
      )
    ).toBe('expired');
  });

  it('asks a due answer as due', () => {
    expect(
      attentionReason(
        requirement({ controlId: 'OE-01-01', pillarId: 'operational-excellence', attestation: answered('due') })
      )
    ).toBe('due');
  });

  it('names inconclusive only when the scan handed over a question nobody has answered', () => {
    expect(
      attentionReason(
        requirement({
          controlId: 'SE-01-01',
          pillarId: 'security',
          askedBecause: 'inconclusive',
        })
      )
    ).toBe('inconclusive');
  });

  it('does not relabel a due inconclusive answer as inconclusive', () => {
    // The field that moved is the attestation state. Calling it inconclusive would hide that it still
    // counts and is close to its review date.
    expect(
      attentionReason(
        requirement({
          controlId: 'SE-01-01',
          pillarId: 'security',
          askedBecause: 'inconclusive',
          attestation: answered('due'),
        })
      )
    ).toBe('due');
  });

  it('has no changed or event-triggered reason, because no field carries either', () => {
    expect(ATTENTION_REASONS).toEqual(['expired', 'due', 'unanswered', 'inconclusive']);
    expect(ATTENTION_REASONS).not.toContain('changed');
    expect(ATTENTION_REASONS).not.toContain('event-triggered');
  });
});

describe('a pillar summary', () => {
  it('splits automatic, reused and attention from the fields rather than from a second opinion', () => {
    const summaries = summarisePillars(
      PILLARS,
      review(),
      [
        finding({ controlId: 'OE-MEASURED', pillarId: 'operational-excellence' }),
        finding({ controlId: 'OE-01-01', pillarId: 'operational-excellence' }),
      ],
      [
        requirement({
          controlId: 'OE-01-01',
          pillarId: 'operational-excellence',
          title: 'Rehearse recovery',
          attestation: answered('current'),
        }),
        requirement({ controlId: 'OE-01-02', pillarId: 'operational-excellence', title: 'Name an owner' }),
        requirement({
          controlId: 'SE-01-01',
          pillarId: 'security',
          title: 'Review access',
          attestation: answered('expired'),
        }),
      ]
    );

    const excellence = summaries[0];
    expect(excellence?.automatic.map((one) => one.controlId)).toEqual(['OE-MEASURED']);
    expect(excellence?.reused.map((one) => one.controlId)).toEqual(['OE-01-01']);
    expect(excellence?.attention.map((one) => one.requirement.controlId)).toEqual(['OE-01-02']);

    const security = summaries[1];
    expect(security?.attention.map((one) => one.reason)).toEqual(['expired']);
    expect(security?.reused).toEqual([]);
  });

  it('counts the exact current answers a confirm freezes', () => {
    const [excellence] = summarisePillars(
      ['operational-excellence'],
      review(),
      [
        finding({
          controlId: 'OE-01-01',
          pillarId: 'operational-excellence',
          attested: {
            id: 'att-lapsed-since',
            bearing: 'outcome',
            by: 'admin@example.com',
            at: '2026-01-01T00:00:00.000Z',
            statement: 'Yes.',
            owner: 'platform@example.com',
            reviewBy: '2026-07-01T00:00:00.000Z',
          },
        }),
      ],
      [
        requirement({
          controlId: 'OE-01-01',
          pillarId: 'operational-excellence',
          attestation: answered('expired'),
        }),
        requirement({
          controlId: 'OE-01-02',
          pillarId: 'operational-excellence',
          attestation: answered('current'),
        }),
      ]
    );

    expect(excellence?.reused.map((one) => one.controlId)).toEqual(['OE-01-02']);
    expect(excellence?.cited).toBe(1);
  });

  it('accepts a current answer even when the earlier run finding predates attestation ids', () => {
    const [excellence] = summarisePillars(
      ['operational-excellence'],
      review(),
      [finding({ controlId: 'OE-01-01', pillarId: 'operational-excellence' })],
      [
        requirement({
          controlId: 'OE-01-01',
          pillarId: 'operational-excellence',
          attestation: answered('current'),
        }),
      ]
    );

    expect(excellence?.reused).toHaveLength(1);
    expect(excellence?.cited).toBe(1);
  });

  it('does not treat an attestable finding as automatic', () => {
    const [excellence] = summarisePillars(
      ['operational-excellence'],
      review(),
      [finding({ controlId: 'OE-01-01', pillarId: 'operational-excellence' })],
      [requirement({ controlId: 'OE-01-01', pillarId: 'operational-excellence' })]
    );
    expect(excellence?.automatic).toEqual([]);
    expect(excellence?.attention).toHaveLength(1);
  });

  it('carries the pillar record when one exists', () => {
    const skip = recorded('reliability', 'skipped');
    const [row] = summarisePillars(['reliability'], review([skip]), [], []);
    expect(row?.recorded).toEqual(skip);
  });

  it('orders attention expired, then due, then unanswered', () => {
    const [row] = summarisePillars(
      ['operational-excellence'],
      review(),
      [],
      [
        requirement({ controlId: 'OE-01-03', pillarId: 'operational-excellence', title: 'Unanswered later' }),
        requirement({
          controlId: 'OE-01-01',
          pillarId: 'operational-excellence',
          title: 'Due one',
          attestation: answered('due'),
        }),
        requirement({
          controlId: 'OE-01-02',
          pillarId: 'operational-excellence',
          title: 'Lapsed one',
          attestation: answered('expired'),
        }),
      ]
    );
    expect(row?.attention.map((one) => one.reason)).toEqual(['expired', 'due', 'unanswered']);
  });
});

describe('resume', () => {
  it('keeps the pillar the URL named', () => {
    const summaries = summarisePillars(PILLARS, review([recorded('operational-excellence')]), [], []);
    expect(resumePillar(summaries, 'reliability')).toBe('reliability');
  });

  it('resumes at the first pillar with no record when the URL names none', () => {
    const summaries = summarisePillars(PILLARS, review([recorded('operational-excellence')]), [], []);
    expect(resumePillar(summaries, null)).toBe('security');
  });

  it('falls to the first pillar when every one has a record', () => {
    const summaries = summarisePillars(PILLARS, review(PILLARS.map((id) => recorded(id))), [], []);
    expect(resumePillar(summaries, null)).toBe('operational-excellence');
  });

  it('ignores a pillar the catalogue does not name', () => {
    const summaries = summarisePillars(PILLARS, review([recorded('operational-excellence')]), [], []);
    expect(resumePillar(summaries, 'not-a-pillar')).toBe('security');
  });

  it('rewrites the URL when the named pillar is not one it can show', () => {
    expect(pillarToWrite('not-a-pillar', 'security')).toBe('security');
    expect(pillarToWrite(null, 'security')).toBe('security');
    expect(pillarToWrite('security', 'security')).toBeNull();
    expect(pillarToWrite('security', undefined)).toBeNull();
  });
});

describe('recordedOf', () => {
  it('returns the record for that pillar and nothing else', () => {
    const skip = recorded('security', 'skipped');
    expect(recordedOf(review([recorded('operational-excellence'), skip]), 'security')).toEqual(skip);
    expect(recordedOf(review([skip]), 'reliability')).toBeUndefined();
  });
});
