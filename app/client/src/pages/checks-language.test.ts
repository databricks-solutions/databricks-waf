// The checks page's sentences, asserted on their arithmetic.
//
// These are prose about counts, which is the combination that fails silently: a sentence that
// says "19 of 70 requirements are decided by the checks below" when 18 of those 19 cannot run
// renders exactly as well as the true one. So the properties checked here are the ones a
// reader would act on — that blocked checks are not counted as decided, that every unanswered
// requirement is accounted for, and that a per-object cost is never reported as a fixed one.

import { describe, expect, it } from 'vitest';
import { answerCall, costPhrase, costSentence, coverageSentence, serves } from './checks-language';
import { inPillar } from './attest-language';
import type { AttestableRequirement, PillarPlan, PlannedSignal, SurfaceCost } from '../api/types';

function pillar(overrides: Partial<PillarPlan> = {}): PillarPlan {
  return {
    pillarId: 'reliability',
    title: 'Reliability',
    measured: true,
    totalControls: 18,
    answeredControls: 5,
    blockedControls: 0,
    unanswered: { attestation: 12, unreachable: 0, planned: 1, unimplemented: 0 },
    signals: [],
    requires: [],
    cost: [],
    ...overrides,
  };
}

function signal(overrides: Partial<PlannedSignal> = {}): PlannedSignal {
  return {
    id: 'sql:jobs.failures',
    surface: 'sql',
    collector: 'system-tables',
    reach: 'account',
    observes: 'Job run outcomes.',
    touches: ['system.lakeflow.job_run_timeline'],
    cost: { kind: 'one-statement' },
    requires: [],
    answers: ['REL-01-01'],
    enriches: [],
    gates: [],
    input: false,
    ...overrides,
  };
}

function asked(overrides: Partial<AttestableRequirement> = {}): AttestableRequirement {
  return {
    controlId: 'REL-01-01',
    pillarId: 'reliability',
    principleId: 'REL-01',
    title: 'Recovery is rehearsed',
    severity: 'high',
    askedBecause: 'no-telemetry',
    question: 'Is it?',
    cadenceDays: 365,
    ...overrides,
  };
}

function answered(
  state: 'current' | 'due' | 'expired',
  overrides: Partial<AttestableRequirement> = {}
): AttestableRequirement {
  const one = asked(overrides);
  return {
    ...one,
    attestation: {
      id: `att-${one.controlId}`,
      controlId: one.controlId,
      answer: 'met',
      statement: 'It is.',
      owner: 'platform',
      attestedBy: 'someone',
      attestedAt: '2026-01-01T00:00:00.000Z',
      reviewBy: '2027-01-01T00:00:00.000Z',
      state,
    },
  };
}

describe('the offer to answer what no check decides', () => {
  // The defect this replaced: the number came from two of the plan's buckets, and the page it
  // opened listed the union of three sets the plan does not hold. Measured on labs at the time,
  // the link said 23 and the answers page listed 47.
  it('counts what the answers page will list for the pillar, whatever the reason each is asked', () => {
    const requirements = [
      asked({ controlId: 'SCP-01-01', pillarId: 'security', askedBecause: 'no-telemetry' }),
      asked({ controlId: 'SCP-01-02', pillarId: 'security', askedBecause: 'not-authorised' }),
      asked({ controlId: 'SCP-01-03', pillarId: 'security', askedBecause: 'inconclusive' }),
      asked({ controlId: 'REL-01-01', pillarId: 'reliability' }),
    ];

    const call = answerCall(requirements, 'security');

    expect(call?.total).toBe(3);
    expect(call?.label).toBe('Answer the 3 requirements no check decides');
    // The property, rather than the number: the link's count is the size of the list it lands on.
    expect(call?.total).toBe(requirements.filter((one) => inPillar(one, 'security')).length);
  });

  it('says both numbers where some are already answered, because neither alone is the sentence', () => {
    const call = answerCall(
      [
        answered('current', { controlId: 'REL-01-01' }),
        answered('due', { controlId: 'REL-01-02' }),
        answered('expired', { controlId: 'REL-01-03' }),
        asked({ controlId: 'REL-01-04' }),
      ],
      'reliability'
    );

    // `due` counts toward the score and `expired` does not, which is the answers page's own split.
    expect(call).toEqual({ total: 4, outstanding: 2, label: 'Answer 2 of the 4 requirements no check decides' });
  });

  it('stops asking for answers it already has, and still offers the list', () => {
    const call = answerCall([answered('current'), answered('due', { controlId: 'REL-01-02' })], 'reliability');

    expect(call?.outstanding).toBe(0);
    expect(call?.label).toBe('All 2 requirements no check decides are answered');
  });

  it('agrees with itself when a pillar asks one question', () => {
    expect(answerCall([answered('current')], 'reliability')?.label).toBe(
      'The 1 requirement no check decides is answered'
    );
  });

  // The visibility fault the count had: a pillar whose requirements were all of the bucket this
  // arithmetic left out offered no link at all, so the page named work and hid the way to it.
  it('offers the link for a pillar whose requirements are all settings the app cannot read', () => {
    const call = answerCall(
      [asked({ controlId: 'SCP-02-01', pillarId: 'security', askedBecause: 'not-authorised' })],
      'security'
    );

    expect(call?.label).toBe('Answer the 1 requirement no check decides');
  });

  it('is absent for a pillar the answers page has nothing for, and while the request is in flight', () => {
    expect(answerCall([asked()], 'cost-optimisation')).toBeNull();
    expect(answerCall([], 'reliability')).toBeNull();
  });
});

describe('the coverage sentence', () => {
  it('does not count a blocked check as one that decides a requirement', () => {
    // The security pillar's real shape: 19 checks exist, 18 of them cannot be authorised.
    const sentence = coverageSentence(
      pillar({
        pillarId: 'security-compliance-and-privacy',
        totalControls: 70,
        answeredControls: 19,
        blockedControls: 18,
        unanswered: { attestation: 6, unreachable: 0, planned: 45, unimplemented: 0 },
      })
    );

    expect(sentence).toContain('1 of 70 requirements are decided');
    expect(sentence).toContain('18 more have a check that no install of this app can be authorised to run');
  });

  it('accounts for every unanswered requirement rather than only the largest group', () => {
    const sentence = coverageSentence(
      pillar({
        totalControls: 10,
        answeredControls: 4,
        unanswered: { attestation: 3, unreachable: 0, planned: 2, unimplemented: 1 },
      })
    );

    expect(sentence).toContain('3 are practice statements');
    expect(sentence).toContain('2 have a check planned but not built');
    expect(sentence).toContain('1 have no check and none planned');
  });

  it('says nothing about groups that are empty', () => {
    const sentence = coverageSentence(
      pillar({ answeredControls: 18, unanswered: { attestation: 0, unreachable: 0, planned: 0, unimplemented: 0 } })
    );

    expect(sentence).toBe('18 of 18 requirements are decided by the checks below.');
  });
});

describe('the cost sentence', () => {
  it('keeps a per-object cost out of the fixed count and states its ceiling', () => {
    const costs: readonly SurfaceCost[] = [
      { surface: 'sql', fixed: 13, variable: [], budget: 250 },
      {
        surface: 'describe',
        fixed: 0,
        variable: [
          { signal: 'describe:predictive_optimization.coverage', objects: 'catalog holding at least one table' },
          { signal: 'describe:storage.table_details', objects: 'table in the sample', ceiling: 50 },
        ],
        budget: 250,
      },
    ];

    const sentence = costSentence(costs);

    expect(sentence).toContain('System table queries: 13 statements, within a budget of 250.');
    expect(sentence).toContain(
      'one per catalog holding at least one table, plus one per table in the sample (up to 50)'
    );
    // A surface with no fixed statements must not claim zero of them, which would read as a
    // free surface when it is the expensive one.
    expect(sentence).not.toContain('0 statements');
  });

  it('says a pillar with no checks executes nothing rather than showing an empty list', () => {
    expect(costSentence([])).toBe('A run for this pillar executes nothing.');
  });
});

describe('the per-signal phrasing', () => {
  it('reports a per-object cost as per-object', () => {
    expect(costPhrase(signal({ cost: { kind: 'per-object', objects: 'table in the sample', ceiling: 50 } }))).toBe(
      'One statement per table in the sample, up to 50'
    );
    expect(costPhrase(signal({ cost: { kind: 'per-object', objects: 'catalog' } }))).toBe('One statement per catalog');
    expect(costPhrase(signal({ cost: { kind: 'one-call' } }))).toBe('One API call');
  });

  it('explains a signal nothing reads directly rather than leaving it looking pointless', () => {
    expect(serves(signal({ answers: [], input: true }))).toEqual([{ label: 'Collected because other checks need it' }]);
  });

  it('counts the three ways a signal is read separately', () => {
    expect(serves(signal({ answers: ['a', 'b'], gates: ['c'], enriches: ['d'] }))).toEqual([
      { role: 'decides', label: 'decides 2 requirements' },
      { role: 'scopes', label: 'scopes 1 requirement' },
      { role: 'details', label: 'details 1 requirement' },
    ]);
  });

  // Each part carries the role the findings page filters by, because that link is the only way to
  // see the requirements a count counted. A part without one is prose and must not be given a link.
  it('marks the countable parts as followable and the prose as not', () => {
    expect(serves(signal({ answers: [], gates: [], enriches: [] }))).toEqual([
      { label: 'Collected but read by nothing' },
    ]);
    expect(serves(signal({ answers: ['a'] })).every((part) => part.role != null)).toBe(true);
  });
});
