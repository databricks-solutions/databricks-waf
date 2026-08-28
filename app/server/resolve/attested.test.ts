// What an answer may and may not do to a finding.
//
// One rule carries the credibility of the whole feature: an attestation answers what the app
// could not read, and never overturns what it did. If a statement could override a
// measurement then any finding a customer disliked could be attested away, and the assessment
// would be worth nothing. Every test in the second block is a way that could go wrong.

import { describe, expect, it } from 'vitest';
import { resolveControl, type ControlResolver, type ControlSpec } from './resolver.js';
import { DAY_MS, type Attestation } from '../attest/attestation.js';
import type { SignalId, SignalResult } from '../collect/signal.js';

const NO_SIGNALS = new Map<SignalId, SignalResult>();
const NOW = new Date('2026-06-01T12:00:00.000Z');

function spec(overrides: Partial<ControlSpec> = {}): ControlSpec {
  return {
    id: 'OE-01-01',
    pillarId: 'operational-excellence',
    principleId: 'operational-excellence-01',
    title: 'Rehearse recovery',
    severity: 'high',
    measurability: 'attestation',
    ...overrides,
  };
}

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'a1',
    controlId: 'OE-01-01',
    answer: 'met',
    statement: 'Rehearsed each quarter; the last exercise was in April and is minuted in the runbook.',
    owner: 'platform-team@example.com',
    attestedBy: 'admin@example.com',
    attestedAt: NOW,
    reviewBy: new Date(NOW.getTime() + 180 * DAY_MS),
    ...overrides,
  };
}

function decides(outcome: 'pass' | 'fail' | 'unmeasurable'): ControlResolver {
  return {
    controls: ['OE-01-01'],
    requires: [],
    resolve: () => ({
      outcome,
      evidence:
        outcome === 'unmeasurable'
          ? []
          : [
              {
                signal: 'sql:oe.recovery',
                observed: 'Two of nine workloads have a tested recovery path.',
                coverage: { mode: 'complete' },
                collectedAt: NOW,
              },
            ],
      ...(outcome === 'unmeasurable' ? { outcomeReason: 'The source held no rows.' } : {}),
    }),
  };
}

describe('an answer to a requirement nothing can measure', () => {
  it('settles it, rather than leaving it unmeasured', () => {
    // The whole point: 82 of the framework's requirements are organisational, and without this
    // they are permanently absent from the score.
    const finding = resolveControl(spec(), NO_SIGNALS, undefined, attestation());

    expect(finding.outcome).toBe('pass');
    expect(finding.unmeasured).toBeUndefined();
  });

  it('maps each answer to the outcome vocabulary the rest of the assessment uses', () => {
    const outcomeFor = (answer: Attestation['answer']) =>
      resolveControl(spec(), NO_SIGNALS, undefined, attestation({ answer })).outcome;

    expect(outcomeFor('met')).toBe('pass');
    expect(outcomeFor('partially-met')).toBe('partial');
    expect(outcomeFor('not-met')).toBe('fail');
    expect(outcomeFor('not-applicable')).toBe('not-applicable');
  });

  it('says who answered, who owns the practice, and when it must be renewed', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, undefined, attestation());

    expect(finding.attested?.by).toBe('admin@example.com');
    expect(finding.attested?.owner).toBe('platform-team@example.com');
    expect(finding.attested?.statement).toContain('April');
    expect(finding.attested?.reviewBy).toBeInstanceOf(Date);
  });

  it('marks the answer as bearing the outcome, so the score can report how much is self-reported', () => {
    expect(resolveControl(spec(), NO_SIGNALS, undefined, attestation()).attested?.bearing).toBe('outcome');
  });

  it('claims no coverage fraction, because a statement is not a sample of an estate', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, undefined, attestation());

    expect(finding.coverage).toEqual({ mode: 'complete' });
    expect(finding.evidence).toEqual([]);
  });

  it('quotes the statement when the answer is that it does not apply', () => {
    // A smaller denominator has to read as explained fact. "Not applicable" with no reason is
    // indistinguishable from the tool skipping the hard parts.
    const finding = resolveControl(spec(), NO_SIGNALS, undefined, attestation({ answer: 'not-applicable' }));

    expect(finding.outcomeReason).toContain('Rehearsed each quarter');
    expect(finding.outcomeReason).toContain('admin@example.com');
  });

  it('is still unmeasured when there is no answer, with attestation named as the remedy', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, undefined);

    expect(finding.outcome).toBe('unmeasurable');
    expect(finding.unmeasured).toBe('attestation');
  });
});

describe('an answer against a requirement the app measured', () => {
  it('does not overturn a failure', () => {
    // The test that protects the product. If this ever passes with `pass`, the assessment can
    // be self-certified and is worthless.
    const finding = resolveControl(spec(), NO_SIGNALS, decides('fail'), attestation({ answer: 'met' }));

    expect(finding.outcome).toBe('fail');
  });

  it('does not overturn a pass into a failure either, because the measurement governs both ways', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, decides('pass'), attestation({ answer: 'not-met' }));

    expect(finding.outcome).toBe('pass');
  });

  it('is still recorded on the finding, so a reader can see the claim was made', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, decides('fail'), attestation({ answer: 'met' }));

    expect(finding.attested?.by).toBe('admin@example.com');
    // Recorded, not counted. This is what keeps it out of the attested tally in the score.
    expect(finding.attested?.bearing).toBe('record');
  });

  it('keeps the measurement evidence rather than replacing it with the statement', () => {
    const finding = resolveControl(spec(), NO_SIGNALS, decides('fail'), attestation());

    expect(finding.evidence).toHaveLength(1);
    expect(finding.evidence[0]?.observed).toContain('nine workloads');
  });

  it('answers a control whose check ran and could not decide', () => {
    // The one case where an answer and a resolver coexist productively: the app asked, was
    // refused, and a person can still say. The evidence of the attempt is kept.
    const finding = resolveControl(spec(), NO_SIGNALS, decides('unmeasurable'), attestation());

    expect(finding.outcome).toBe('pass');
    expect(finding.attested?.bearing).toBe('outcome');
  });

  it('leaves a requirement that does not apply alone, answer or not', () => {
    const clusters = 'sql:compute.clusters' as SignalId;
    const finding = resolveControl(
      spec({
        preconditions: [
          {
            signal: clusters,
            scope: 'estate',
            operator: 'eq',
            value: 0,
            outcome: 'not-applicable',
            reason: 'This estate runs no classic clusters.',
          },
        ],
      }),
      new Map([[clusters, { id: clusters, status: 'observed', value: 0, collectedAt: NOW, coverage: { mode: 'complete' }, durationMs: 1 }]]),
      undefined,
      attestation({ answer: 'met' })
    );

    // Applicability is decided before evidence of any kind, so an answer cannot bring a
    // requirement back into a denominator it does not belong in.
    expect(finding.outcome).toBe('not-applicable');
    expect(finding.attested).toBeUndefined();
  });
});
