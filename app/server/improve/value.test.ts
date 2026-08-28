// The four figures, and mostly the arithmetic each one refuses.
//
// Every assertion below is about a number this could produce and does not: two advisors added
// together, one resource priced twice, a measure summed with a measure taken another way, or a
// realised total that is only the actions that worked. ADR 0083 is the decision; this is where a later
// change to `value.ts` that quietly makes one of them possible fails.

import { describe, expect, it } from 'vitest';
import type { AdviceReading } from './advice-reading.js';
import type { AdviceProvenance } from './advice.js';
import type { ImprovementAction } from './action.js';
import type { ActionProgress } from './progress.js';
import { valueOf } from './value.js';

const RAISED = new Date('2026-07-01T00:00:00.000Z');
const LATER = new Date('2026-08-01T00:00:00.000Z');

function advice(over: Partial<AdviceProvenance> = {}): AdviceProvenance {
  return {
    advisoryId: 'adv-1',
    advisor: 'serverless',
    rule: 'init-script',
    severity: 'high',
    headline: 'Init scripts',
    detail: 'Serverless compute does not run cluster init scripts.',
    docUrl: 'https://docs.databricks.com/serverless',
    resource: { kind: 'job', id: '882', workspaceId: 'w1' },
    baseline: [],
    assumptions: ['Priced at the list rate for the region the job ran in.'],
    versions: [],
    measuredAt: RAISED,
    lookbackDays: 30,
    ...over,
  };
}

function reading(over: Partial<AdviceReading> = {}): AdviceReading {
  return {
    advisoryId: 'adv-2',
    measuredAt: LATER,
    lookbackDays: 30,
    standing: 'still-firing',
    movements: [],
    unmatched: [],
    ...over,
  };
}

function progress(over: {
  readonly advice?: AdviceProvenance;
  readonly reading?: AdviceReading;
  readonly state?: ImprovementAction['state'];
  readonly agreement?: ActionProgress['agreement'];
  readonly id?: string;
}): ActionProgress {
  const action = {
    id: over.id ?? 'action-1',
    planId: 'plan-1',
    controlIds: [],
    outcome: 'The job runs on serverless compute.',
    definitionOfDone: 'No init script remains on any cluster the job runs on.',
    owner: 'owner@example.com',
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: over.state ?? 'in-progress',
    createdBy: 'lead@example.com',
    createdAt: RAISED,
    history: [],
    revision: 0,
    ...(over.advice != null ? { advice: over.advice } : {}),
  } as ImprovementAction;

  return {
    action,
    agreement: over.agreement ?? 'unjudged',
    lateness: 'undated',
    unmet: [],
    unreadable: [],
    ...(over.reading != null ? { advice: over.reading } : {}),
  };
}

const PRICED = { low: 1000, high: 1400, currency: 'USD', region: 'us-east-1' };

describe('what somebody accepted by raising work against it', () => {
  it('prices a resource once however many actions were raised on it', () => {
    // The advisors price a *resource* — moving one job off classic compute — and an action is raised
    // from one finding of the several a job may have. Two actions on one job are two pieces of work
    // and one saving, and adding both is how a programme books the same money twice.
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ opportunity: PRICED }) }),
        progress({ id: 'b', advice: advice({ rule: 'dbfs-mount', opportunity: PRICED }) }),
      ],
    });

    expect(value.committed).toHaveLength(1);
    expect(value.committed[0]).toMatchObject({ low: 1000, high: 1400, resources: 1, actions: 2 });
  });

  it('keeps two advisors apart rather than summing figures computed under different assumptions', () => {
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ opportunity: PRICED }) }),
        progress({
          id: 'b',
          advice: advice({
            advisor: 'sizing',
            resource: { kind: 'warehouse', id: 'wh-1', workspaceId: 'w1' },
            opportunity: { low: 500, high: 500, currency: 'USD', region: 'us-east-1' },
          }),
        }),
      ],
    });

    expect(value.committed.map((total) => [total.advisor, total.low])).toEqual([
      ['serverless', 1000],
      ['sizing', 500],
    ]);
  });

  it('keeps two currencies apart, for the same reason', () => {
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ opportunity: PRICED }) }),
        progress({
          id: 'b',
          advice: advice({
            resource: { kind: 'job', id: '883', workspaceId: 'w1' },
            opportunity: { low: 900, high: 900, currency: 'EUR', region: 'eu-west-1' },
          }),
        }),
      ],
    });

    expect(value.committed.map((total) => total.currency)).toEqual(['USD', 'EUR']);
  });

  it('drops the region once two resources were priced from different lists', () => {
    // Naming the first of two would attribute the whole range to a rate that produced half of it.
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ opportunity: PRICED }) }),
        progress({
          id: 'b',
          advice: advice({
            resource: { kind: 'job', id: '883', workspaceId: 'w1' },
            opportunity: { low: 100, high: 100, currency: 'USD', region: 'us-west-2' },
          }),
        }),
      ],
    });

    expect(value.committed[0]?.region).toBeUndefined();
    expect(value.committed[0]?.resources).toBe(2);
  });

  it('keeps what a verified action committed, and drops what a cancelled one did', () => {
    // Committed value is what somebody agreed to. Dropping it once the work lands would make the
    // total fall as the programme succeeds; a cancellation is the one case where it was withdrawn.
    const value = valueOf({
      progress: [
        progress({ id: 'a', state: 'verified', advice: advice({ opportunity: PRICED }) }),
        progress({
          id: 'b',
          state: 'cancelled',
          advice: advice({
            resource: { kind: 'job', id: '883', workspaceId: 'w1' },
            opportunity: { low: 7000, high: 7000, currency: 'USD', region: 'us-east-1' },
          }),
        }),
      ],
    });

    expect(value.committed[0]).toMatchObject({ low: 1000, resources: 1 });
  });

  it('carries the assumptions every figure in the total rests on', () => {
    const value = valueOf({ progress: [progress({ advice: advice({ opportunity: PRICED }) })] });

    expect(value.committed[0]?.assumptions).toEqual(['Priced at the list rate for the region the job ran in.']);
  });
});

describe('a measure read twice', () => {
  const moved = reading({
    movements: [{ label: 'Failed runs', unit: 'count', before: 12, after: 4 }],
  });

  it('reports both readings and never their difference', () => {
    const value = valueOf({
      progress: [progress({ advice: advice({ advisor: 'jobs', rule: 'JOB_RUNS_NOT_SUCCEEDING' }), reading: moved })],
    });

    expect(value.realised).toEqual([
      { advisor: 'jobs', label: 'Failed runs', unit: 'count', before: 12, after: 4, measurements: 1 },
    ]);
  });

  it('counts one reading per resource and rule, however many actions were raised from it', () => {
    // Two commitments and one measurement. Adding the reading twice would report a movement that half
    // happened, on a total whose `measurements` said it was two.
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ advisor: 'jobs', rule: 'JOB_RUNS_NOT_SUCCEEDING' }), reading: moved }),
        progress({ id: 'b', advice: advice({ advisor: 'jobs', rule: 'JOB_RUNS_NOT_SUCCEEDING' }), reading: moved }),
      ],
    });

    expect(value.realised[0]).toMatchObject({ before: 12, after: 4, measurements: 1 });
  });

  it('sums two resources measured the same way, and says how many are in the total', () => {
    const value = valueOf({
      progress: [
        progress({ id: 'a', advice: advice({ advisor: 'jobs', rule: 'JOB_RUNS_NOT_SUCCEEDING' }), reading: moved }),
        progress({
          id: 'b',
          advice: advice({
            advisor: 'jobs',
            rule: 'JOB_RUNS_NOT_SUCCEEDING',
            resource: { kind: 'job', id: '883', workspaceId: 'w1' },
          }),
          reading: moved,
        }),
      ],
    });

    expect(value.realised[0]).toMatchObject({ before: 24, after: 8, measurements: 2 });
  });

  it('keeps one label measured in two units apart', () => {
    const value = valueOf({
      progress: [
        progress({
          id: 'a',
          advice: advice({ advisor: 'jobs' }),
          reading: reading({ movements: [{ label: 'Runtime', unit: 'ms', before: 900, after: 400 }] }),
        }),
        progress({
          id: 'b',
          advice: advice({ advisor: 'jobs', resource: { kind: 'job', id: '883', workspaceId: 'w1' } }),
          reading: reading({ movements: [{ label: 'Runtime', unit: 'count', before: 9, after: 4 }] }),
        }),
      ],
    });

    expect(value.realised.map((one) => one.unit)).toEqual(['ms', 'count']);
  });
});

describe('the work that landed', () => {
  it('counts it rather than totalling it, because a cleared finding leaves no reading', () => {
    // The apparatus, not a preference: an advisor computes its evidence inside the condition that
    // fires, so the run showing the work landed is the run with nothing left to measure.
    const value = valueOf({
      progress: [
        progress({
          id: 'a',
          state: 'verified',
          agreement: 'agreed',
          advice: advice({ opportunity: PRICED }),
          reading: reading({ standing: 'cleared' }),
        }),
      ],
    });

    expect(value.cleared).toEqual({ actions: 1, resources: 1 });
    expect(value.realised).toEqual([]);
  });

  it('reports every advice-raised action by what the estate says, not only the ones that worked', () => {
    const value = valueOf({
      progress: [
        progress({ id: 'a', agreement: 'agreed', advice: advice(), reading: reading({ standing: 'cleared' }) }),
        progress({ id: 'b', agreement: 'contradicted', advice: advice(), reading: reading() }),
        progress({ id: 'c', agreement: 'unmeasured', advice: advice(), reading: reading({ standing: 'resource-absent' }) }),
        progress({ id: 'd', agreement: 'unjudged', advice: advice() }),
      ],
    });

    expect(value.outcomes).toMatchObject({ agreed: 1, contradicted: 1, unmeasured: 1, unjudged: 1 });
  });

  it('leaves an action raised from a finding out of every figure when it names no advice', () => {
    // The board holds both kinds. A WAF action has no advisor behind it, and counting it here would
    // put the assessment's work into the advisors' arithmetic.
    const value = valueOf({ progress: [progress({}), progress({ id: 'b', advice: advice() })] });

    expect(Object.values(value.outcomes).reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});

describe('the assessment’s own answer', () => {
  it('is restated rather than recomputed, and nothing else is derived from it', () => {
    const value = valueOf({
      progress: [],
      posture: { runId: 'run-9', at: LATER, overall: 61.4, scoredControls: 84, totalControls: 120, unmeasured: 6 },
    });

    expect(value.posture).toEqual({
      runId: 'run-9',
      at: LATER,
      overall: 61.4,
      scoredControls: 84,
      totalControls: 120,
      unmeasured: 6,
    });
    expect(value.opportunity).toEqual([]);
    expect(value.committed).toEqual([]);
    expect(value.realised).toEqual([]);
  });
});
