// What a later advisory is allowed to say about an action, and the five ways it says nothing.
//
// One assertion here is the one this module exists for: a resource missing from a later run does not
// clear the action. Three of the four advisors report a ranked subset, so absence is the estate
// getting busier elsewhere as often as it is the work landing — and `advice-settle.ts` turns `cleared`
// into a `verified` transition nobody can undo by explaining.
//
// The rest are the same judgement in the other four places it can go wrong: an analysis that did not
// form, a rule this build dropped, an advisory that is not later, and two readings taken over
// different windows or under different rules.

import { describe, expect, it } from 'vitest';
import { accountScope } from '../collect/estate-scope.js';
import type { Advisory } from '../advise/advisory.js';
import type { AdviceProvenance } from './advice.js';
import { adviceReadingOf } from './advice-reading.js';

const RAISED = new Date('2026-07-01T02:00:00.000Z');
const LATER = new Date('2026-08-01T02:00:00.000Z');

function advice(over: Partial<AdviceProvenance> = {}): AdviceProvenance {
  return {
    advisoryId: 'adv-1',
    advisor: 'workload',
    rule: 'DATA_SPILL',
    severity: 'high',
    headline: 'Spilling to disk',
    detail: 'The query wrote more than it read.',
    docUrl: 'https://docs.databricks.com/spill',
    resource: { kind: 'shape', id: 'abc0000000000000', workspaceId: 'w1' },
    baseline: [{ label: 'Spilled', value: 3_221_225_472, unit: 'bytes' }],
    assumptions: [],
    versions: [
      { name: 'rulesVersion', value: '1' },
      { name: 'rankingVersion', value: 'advisor-1' },
    ],
    measuredAt: RAISED,
    lookbackDays: 30,
    ...over,
  };
}

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'adv-2',
    runId: 'run-2',
    startedAt: LATER,
    finishedAt: LATER,
    state: 'complete',
    scope: accountScope(),
    lookbackDays: 30,
    stamp: { actor: 'ada@example.com', executionMode: 'service-principal', warehouse: 'wh-1' },
    readings: [],
    ...over,
  };
}

/** A workload analysis holding one shape, with whatever findings the case wants on it. */
function withShape(findings: readonly unknown[], over: Record<string, unknown> = {}): Advisory {
  return advisory({
    workload: {
      top: [{ shape: 'abc0000000000000', workspaceId: 'w1', findings }],
      failing: [],
      rankingVersion: 'advisor-1',
      rulesVersion: 1,
      ...over,
    } as never,
  });
}

const FIRED = [
  {
    rule: 'DATA_SPILL',
    shape: 'abc0000000000000',
    severity: 'high',
    evidence: [{ label: 'Spilled', value: 1_073_741_824, unit: 'bytes' }],
  },
];

describe('a later advisory that read the resource', () => {
  it('reports the rule firing again, with both readings of every measure it shares', () => {
    const reading = adviceReadingOf(advice(), withShape(FIRED));

    expect(reading.standing).toBe('still-firing');
    expect(reading.movements).toEqual([
      { label: 'Spilled', unit: 'bytes', before: 3_221_225_472, after: 1_073_741_824 },
    ]);
    expect(reading.incomparable).toBeUndefined();
  });

  it('reports the rule not firing, and carries no movement at all', () => {
    // The outcome to aim for and the one with nothing to measure: an advisor computes its evidence
    // inside the condition that fires, so the run that shows the work landed holds no later reading of
    // what it fired on. ADR 0083's reason for counting these rather than totalling them.
    const reading = adviceReadingOf(advice(), withShape([]));

    expect(reading.standing).toBe('cleared');
    expect(reading.movements).toEqual([]);
  });

  it('names the baseline measures the later reading does not carry', () => {
    // Half a comparison that looks whole is the failure mode: three measures moved and the fourth is
    // absent reads, without this, as three measures that moved.
    const reading = adviceReadingOf(
      advice({
        baseline: [
          { label: 'Spilled', value: 3_221_225_472, unit: 'bytes' },
          { label: 'Queued', value: 4000, unit: 'ms' },
        ],
      }),
      withShape(FIRED)
    );

    expect(reading.movements.map((one) => one.label)).toEqual(['Spilled']);
    expect(reading.unmatched).toEqual(['Queued']);
  });

  it('refuses to pair two readings of one label taken in different units', () => {
    // A rule that changed what it reports a duration in would otherwise produce a movement from
    // milliseconds to seconds and read as a thousandfold improvement.
    const reading = adviceReadingOf(
      advice({ baseline: [{ label: 'Spilled', value: 3000, unit: 'ms' }] }),
      withShape(FIRED)
    );

    expect(reading.movements).toEqual([]);
    expect(reading.unmatched).toEqual(['Spilled']);
  });
});

describe('a later advisory that answers nothing', () => {
  it('does not read a shape missing from the later run as a shape that was fixed', () => {
    // The assertion this module exists for. The workload advisor reports a ranked subset, so a shape
    // that has left the list may have been fixed, may have been overtaken, or may not have run — and
    // `cleared` here would verify work by the estate getting busier elsewhere.
    const reading = adviceReadingOf(advice(), advisory({
      workload: { top: [], failing: [], rankingVersion: 'advisor-1', rulesVersion: 1 } as never,
    }));

    expect(reading.standing).toBe('resource-absent');
  });

  it('does not read an analysis that never formed as an absence of findings', () => {
    expect(adviceReadingOf(advice(), advisory()).standing).toBe('advisor-unread');
  });

  it('does not read a rule this build no longer carries as a rule that stopped firing', () => {
    const reading = adviceReadingOf(advice({ rule: 'A_RULE_FROM_A_LATER_BUILD' }), withShape([]));

    expect(reading.standing).toBe('rule-withdrawn');
  });

  it('refuses the advisory the advice itself came from', () => {
    // The commonest thing to be handed here: until the next run, the advisory an action was raised
    // from is the latest one, and it agrees with itself by construction.
    const reading = adviceReadingOf(advice({ measuredAt: LATER }), withShape([]));

    expect(reading.standing).toBe('not-later');
  });
});

describe('two readings that may not be subtracted', () => {
  it('withholds the movements where the later run looked back over a different span', () => {
    const reading = adviceReadingOf(advice(), advisory({
      lookbackDays: 7,
      workload: {
        top: [{ shape: 'abc0000000000000', workspaceId: 'w1', findings: FIRED }],
        failing: [],
        rankingVersion: 'advisor-1',
        rulesVersion: 1,
      } as never,
    }));

    expect(reading.standing).toBe('still-firing');
    expect(reading.incomparable).toBe('window');
    expect(reading.movements).toEqual([]);
  });

  it('withholds them where the rules that produced the two readings differ', () => {
    const reading = adviceReadingOf(advice(), withShape(FIRED, { rulesVersion: 2 }));

    expect(reading.incomparable).toBe('rules-version');
    expect(reading.movements).toEqual([]);
  });

  it('withholds them where the later analysis declares a version the action never carried', () => {
    // A version that has appeared since is the same problem as one that changed: the later reading was
    // produced by an apparatus the baseline was not.
    const reading = adviceReadingOf(
      advice({ versions: [{ name: 'rulesVersion', value: '1' }] }),
      withShape(FIRED)
    );

    expect(reading.incomparable).toBe('rules-version');
  });

  it('compares a serverless reading on its window alone, because that analysis declares no version', () => {
    // 44a's census found the serverless analysis records no rules version, and 44b left that as an
    // empty list rather than inventing one. Two empty lists agree.
    const reading = adviceReadingOf(
      advice({
        advisor: 'serverless',
        rule: 'init-script',
        resource: { kind: 'job', id: '882', workspaceId: 'w1' },
        baseline: [{ label: 'Clusters running an init script', value: 4, unit: 'count' }],
        versions: [],
      }),
      advisory({
        serverless: {
          jobs: [
            {
              workspaceId: 'w1',
              jobId: '882',
              reasons: [
                {
                  ruleId: 'init-script',
                  headline: 'Init scripts',
                  detail: 'Serverless compute does not run cluster init scripts.',
                  docUrl: 'https://docs.databricks.com/serverless',
                  observed: '2 clusters it ran on had at least one init script.',
                  evidence: [{ label: 'Clusters running an init script', value: 2, unit: 'count' }],
                },
              ],
            },
          ],
          assumptions: [],
        } as never,
      })
    );

    expect(reading.incomparable).toBeUndefined();
    expect(reading.movements).toEqual([
      { label: 'Clusters running an init script', unit: 'count', before: 4, after: 2 },
    ]);
  });
});
