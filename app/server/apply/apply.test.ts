import { describe, expect, it } from 'vitest';
import { applyDecisions } from './apply.js';
import { scoreFindings } from '../score/score.js';
import type { ApplicabilityDecision, ApplicabilityLever } from './applicability.js';
import type { Finding, Outcome, Severity } from '../resolve/finding.js';

const NOW = new Date('2026-08-09T00:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

let sequence = 0;
function finding(outcome: Outcome, controlId?: string, severity: Severity = 'medium'): Finding {
  sequence += 1;
  return {
    controlId: controlId ?? `X-01-${String(sequence).padStart(2, '0')}`,
    pillarId: 'X',
    principleId: 'X-01',
    title: 'A control',
    severity,
    outcome,
    coverage: { mode: 'complete' },
    evidence: [{ signal: 'sql:cost.tags', observed: '4 of 4', coverage: { mode: 'complete' }, collectedAt: new Date(0) }],
  };
}

let decisionSequence = 0;
function decision(
  controlId: string,
  lever: ApplicabilityLever,
  overrides: Partial<ApplicabilityDecision> = {}
): ApplicabilityDecision {
  decisionSequence += 1;
  return {
    id: `dec-${String(decisionSequence)}`,
    controlId,
    lever,
    ordinal: 1,
    reason: 'This estate runs no streaming workloads, so the requirement does not apply.',
    owner: 'platform-team',
    effectiveFrom: new Date(NOW.getTime() - DAY),
    expiresAt: new Date(NOW.getTime() + 90 * DAY),
    recordedBy: 'someone@example.com',
    recordedAt: new Date(NOW.getTime() - DAY),
    ...overrides,
  };
}

/** A store lookup over a flat list of decisions, newest order left to the function under test. */
function from(decisions: readonly ApplicabilityDecision[]): (controlId: string) => readonly ApplicabilityDecision[] {
  return (controlId) => decisions.filter((d) => d.controlId === controlId);
}

describe('applying applicability decisions', () => {
  it('leaves findings untouched when no decision is in force', () => {
    const findings = [finding('pass', 'A'), finding('fail', 'B')];
    const applied = applyDecisions(findings, from([]), NOW);

    expect(applied.findings).toEqual(findings);
    expect(applied.excluded).toEqual([]);
    expect(applied.lapsed).toEqual([]);
  });

  it('rewrites a not-applicable decision to a not-applicable outcome carrying the reason', () => {
    const findings = [finding('pass', 'A')];
    const applied = applyDecisions(findings, from([decision('A', 'not-applicable')]), NOW);

    expect(applied.findings[0]?.outcome).toBe('not-applicable');
    expect(applied.findings[0]?.outcomeReason).toBe(
      'This estate runs no streaming workloads, so the requirement does not apply.'
    );
    expect(applied.excluded).toHaveLength(1);
    expect(applied.excluded[0]).toMatchObject({ controlId: 'A', lever: 'not-applicable', owner: 'platform-team' });
    expect(applied.lapsed).toEqual([]);
  });

  it('rewrites a disabled decision to unmeasurable carrying the disabled kind', () => {
    const findings = [finding('pass', 'A')];
    const applied = applyDecisions(findings, from([decision('A', 'disabled')]), NOW);

    expect(applied.findings[0]?.outcome).toBe('unmeasurable');
    expect(applied.findings[0]?.unmeasured).toBe('disabled');
    // No outcomeReason on unmeasurable: the kind is the explanation, attribution is in the exposure.
    expect(applied.findings[0]?.outcomeReason).toBeUndefined();
    expect(applied.excluded[0]).toMatchObject({ controlId: 'A', lever: 'disabled' });
  });

  /*
   * The claim `identity.ts` makes when it refuses a comparison across a lever switch: the two leave the
   * same total and give it a different range. Held here rather than restated there, because it is the
   * reason that refusal exists and a rule that stops being true silently is how the refusal outlives it.
   */
  it('gives the two levers the same score and a different range', () => {
    const findings = [finding('pass', 'A'), finding('pass', 'B'), finding('fail', 'C')];
    const scored = (lever: ApplicabilityLever) =>
      scoreFindings(applyDecisions(findings, from([decision('A', lever)]), NOW).findings);
    const width = (score: ReturnType<typeof scored>) => (score.range?.high ?? 0) - (score.range?.low ?? 0);

    const outside = scored('not-applicable');
    const off = scored('disabled');

    expect(off.overall).toBe(outside.overall);
    // A check switched off is something that could have been measured, so it leaves the wider range; a
    // requirement that does not apply is not a gap in knowledge, so it leaves none of one.
    expect(width(off)).toBeGreaterThan(0);
    expect(width(outside)).toBe(0);
  });

  it('leaves coverage and evidence as measured', () => {
    const one = finding('pass', 'A');
    const applied = applyDecisions([one], from([decision('A', 'disabled')]), NOW);

    expect(applied.findings[0]?.coverage).toEqual(one.coverage);
    expect(applied.findings[0]?.evidence).toEqual(one.evidence);
  });

  describe('the lapse', () => {
    it.each<Outcome>(['fail', 'partial'])('sets a decision aside when the reading turned %s', (reading) => {
      const one = finding(reading, 'A');
      const applied = applyDecisions([one], from([decision('A', 'not-applicable')]), NOW);

      // The finding is left exactly as it reads.
      expect(applied.findings[0]).toEqual(one);
      expect(applied.excluded).toEqual([]);
      expect(applied.lapsed).toHaveLength(1);
      expect(applied.lapsed[0]).toMatchObject({ controlId: 'A', lever: 'not-applicable', reading });
    });

    it('does not lapse on an unmeasurable reading — that is what the lever is for', () => {
      const applied = applyDecisions([finding('unmeasurable', 'A')], from([decision('A', 'not-applicable')]), NOW);

      expect(applied.findings[0]?.outcome).toBe('not-applicable');
      expect(applied.excluded).toHaveLength(1);
      expect(applied.lapsed).toEqual([]);
    });
  });

  describe('which decision is in force', () => {
    it('ignores a decision whose effective date has not arrived', () => {
      const pending = decision('A', 'disabled', { effectiveFrom: new Date(NOW.getTime() + 5 * DAY) });
      const applied = applyDecisions([finding('pass', 'A')], from([pending]), NOW);

      expect(applied.findings[0]?.outcome).toBe('pass');
      expect(applied.excluded).toEqual([]);
    });

    it('ignores a decision that has expired', () => {
      const expired = decision('A', 'disabled', {
        effectiveFrom: new Date(NOW.getTime() - 10 * DAY),
        expiresAt: new Date(NOW.getTime() - DAY),
      });
      const applied = applyDecisions([finding('pass', 'A')], from([expired]), NOW);

      expect(applied.findings[0]?.outcome).toBe('pass');
      expect(applied.excluded).toEqual([]);
    });

    it('ignores a revoked decision', () => {
      const gone = decision('A', 'disabled', {
        revoked: { by: 'someone@example.com', at: NOW, reason: 'The workload was migrated back on.' },
      });
      const applied = applyDecisions([finding('pass', 'A')], from([gone]), NOW);

      expect(applied.findings[0]?.outcome).toBe('pass');
      expect(applied.excluded).toEqual([]);
    });

    it('takes the newest effective decision when a renewal supersedes an older one', () => {
      const older = decision('A', 'not-applicable', {
        id: 'old',
        recordedAt: new Date(NOW.getTime() - 30 * DAY),
      });
      const newer = decision('A', 'disabled', {
        id: 'new',
        recordedAt: new Date(NOW.getTime() - DAY),
        supersedes: 'old',
      });
      const applied = applyDecisions([finding('pass', 'A')], from([older, newer]), NOW);

      expect(applied.findings[0]?.outcome).toBe('unmeasurable');
      expect(applied.excluded[0]?.decisionId).toBe('new');
    });
  });

  it('handles a mix across many findings, keeping the exposure per decision', () => {
    const findings = [
      finding('pass', 'A'),
      finding('fail', 'B'),
      finding('pass', 'C'),
      finding('unmeasurable', 'D'),
    ];
    const applied = applyDecisions(
      findings,
      from([
        decision('A', 'not-applicable'),
        decision('B', 'disabled'), // reads fail → lapses
        decision('C', 'disabled'),
      ]),
      NOW
    );

    expect(applied.findings.map((f) => [f.controlId, f.outcome])).toEqual([
      ['A', 'not-applicable'],
      ['B', 'fail'],
      ['C', 'unmeasurable'],
      ['D', 'unmeasurable'],
    ]);
    expect(applied.excluded.map((e) => e.controlId)).toEqual(['A', 'C']);
    expect(applied.lapsed.map((l) => l.controlId)).toEqual(['B']);
  });
});
