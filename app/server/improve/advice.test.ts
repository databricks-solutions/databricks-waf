// What a reference resolves to, and what it refuses.
//
// The assertions worth reading are the second kind. `adviceFrom` exists so that an action's provenance
// comes from the record rather than from whoever posted the form, and a resolver that quietly returned
// a half-filled provenance for a reference naming nothing would leave that guarantee looking intact
// while doing none of it.

import { describe, expect, it } from 'vitest';
import { accountScope } from '../collect/estate-scope.js';
import type { Advisory } from '../advise/advisory.js';
import { UnknownAdviceError, adviceFrom } from './advice.js';

const AT = new Date('2026-08-06T02:00:00.000Z');

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'adv-1',
    runId: 'run-1',
    startedAt: AT,
    finishedAt: new Date(AT.getTime() + 120_000),
    state: 'complete',
    scope: accountScope(),
    lookbackDays: 30,
    stamp: { actor: 'ada@example.com', executionMode: 'service-principal', warehouse: 'wh-1' },
    readings: [],
    ...over,
  };
}

/** A workload analysis with one shape, one finding on it. Partial: only what the walk reads. */
function withWorkload(): Advisory {
  return advisory({
    workload: {
      top: [
        {
          shape: 'abc0000000000000',
          workspaceId: 'w1',
          findings: [
            {
              rule: 'DATA_SPILL',
              shape: 'abc0000000000000',
              severity: 'high',
              confidence: 'high',
              evidence: [{ label: 'Spilled', value: 3_221_225_472, unit: 'bytes' }],
            },
          ],
        },
      ],
      failing: [],
      rankingVersion: 'advisor-1',
      rulesVersion: 1,
    } as never,
  });
}

describe('the provenance a reference resolves to', () => {
  it('assembles the four fields from where each of them actually lives', () => {
    const advice = adviceFrom(withWorkload(), {
      advisoryId: 'adv-1',
      advisor: 'workload',
      resource: 'abc0000000000000',
      rule: 'DATA_SPILL',
    });

    expect(advice.rule).toBe('DATA_SPILL');
    expect(advice.resource).toEqual({ kind: 'shape', id: 'abc0000000000000', workspaceId: 'w1' });
    expect(advice.baseline).toEqual([{ label: 'Spilled', value: 3_221_225_472, unit: 'bytes' }]);
    expect(advice.measuredAt).toEqual(new Date(AT.getTime() + 120_000));
    expect(advice.lookbackDays).toBe(30);
  });

  it('cites both versions the workload analysis declares, because they move independently', () => {
    // 44a's census: an action citing one of the two would be citing half of what produced its advice.
    const advice = adviceFrom(withWorkload(), {
      advisoryId: 'adv-1',
      advisor: 'workload',
      resource: 'abc0000000000000',
      rule: 'DATA_SPILL',
    });

    expect(advice.versions).toEqual([
      { name: 'rulesVersion', value: '1' },
      { name: 'rankingVersion', value: 'advisor-1' },
    ]);
  });

  it('takes the words from the ruleset rather than from the finding', () => {
    // The finding carries a rule id and numbers and no prose at all, which is why this is worth an
    // assertion: the headline a reader sees on an action is the shipped ruleset's, so an action raised
    // today and read next year says what the rule said, not what a page had rendered.
    const advice = adviceFrom(withWorkload(), {
      advisoryId: 'adv-1',
      advisor: 'workload',
      resource: 'abc0000000000000',
      rule: 'DATA_SPILL',
    });

    expect(advice.headline).not.toBe('');
    expect(advice.detail).not.toBe('');
    expect(advice.docUrl).toMatch(/^https:/);
  });

  it('finds a shape among the failing ones as well as among the top ones', () => {
    // Two lists for one population — `ranking.ts` says why — and a resolver that read only `top` would
    // refuse exactly the findings a reader is most likely to act on.
    const record = advisory({
      workload: {
        top: [],
        failing: [
          {
            shape: 'def0000000000000',
            workspaceId: 'w1',
            findings: [{ rule: 'FAILURE_RATE', shape: 'def0000000000000', severity: 'critical', evidence: [] }],
          },
        ],
        rankingVersion: 'advisor-1',
        rulesVersion: 1,
      } as never,
    });

    expect(
      adviceFrom(record, { advisoryId: 'adv-1', advisor: 'workload', resource: 'def0000000000000', rule: 'FAILURE_RATE' })
        .resource.id
    ).toBe('def0000000000000');
  });

  it('names the warehouse the estate calls it, not only its id', () => {
    const record = advisory({
      sizing: {
        warehouses: [
          {
            workspaceId: 'w1',
            warehouseId: 'wh-1',
            name: 'finance-bi',
            findings: [{ rule: 'WAREHOUSE_QUEUEING', severity: 'high', evidence: [] }],
          },
        ],
        rulesVersion: 2,
      } as never,
    });

    const advice = adviceFrom(record, {
      advisoryId: 'adv-1',
      advisor: 'sizing',
      resource: 'wh-1',
      rule: 'WAREHOUSE_QUEUEING',
    });

    expect(advice.resource).toEqual({ kind: 'warehouse', id: 'wh-1', workspaceId: 'w1', name: 'finance-bi' });
    expect(advice.versions).toEqual([{ name: 'rulesVersion', value: '2' }]);
  });

  it('resolves a job health finding to the job it fired on', () => {
    const record = advisory({
      jobs: {
        jobs: [
          {
            workspaceId: 'w1',
            jobId: '471148922192497',
            name: 'daily_ingest',
            findings: [{ rule: 'JOB_LONG_RUNNING', severity: 'medium', evidence: [] }],
          },
        ],
        rulesVersion: 1,
      } as never,
    });

    const advice = adviceFrom(record, {
      advisoryId: 'adv-1',
      advisor: 'jobs',
      resource: '471148922192497',
      rule: 'JOB_LONG_RUNNING',
    });

    expect(advice.resource.name).toBe('daily_ingest');
    expect(advice.severity).toBe('medium');
  });
});

describe('a measurement the advisor wrote as a sentence', () => {
  function withServerless(): Advisory {
    return advisory({
      serverless: {
        jobs: [
          {
            workspaceId: 'w1',
            jobId: '882',
            name: 'nightly_model',
            reasons: [
              {
                ruleId: 'INIT_SCRIPTS',
                kind: 'blocker',
                headline: 'Cluster-scoped init scripts',
                detail: 'Serverless compute does not run cluster init scripts.',
                docUrl: 'https://docs.databricks.com/serverless',
                observed: '8.0 days',
              },
            ],
          },
        ],
        assumptions: [{ id: 'rate', statement: 'Priced at the list rate for the region the job ran in.' }],
      } as never,
    });
  }

  it('keeps it as an observation and leaves the baseline empty', () => {
    // The census in 44a: `observed` is `"8.0 days"`, and the difference between two sentences is not a
    // number. An empty baseline is the honest record of that, and ADR 0083 is what reads it — such an
    // action can hold an opportunity and cannot hold a realised value.
    const advice = adviceFrom(withServerless(), {
      advisoryId: 'adv-1',
      advisor: 'serverless',
      resource: '882',
      rule: 'INIT_SCRIPTS',
    });

    expect(advice.baseline).toEqual([]);
    expect(advice.observation).toBe('8.0 days');
  });

  it('takes the numbers as the baseline where the reason fires on a quantity', () => {
    // The other half of 44b: a reason firing on a count now carries the count, so an action raised
    // from it has something a later reading can be subtracted from. The sentence is kept as well.
    const record = advisory({
      serverless: {
        jobs: [
          {
            workspaceId: 'w1',
            jobId: '882',
            name: 'nightly_model',
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
    });

    const advice = adviceFrom(record, {
      advisoryId: 'adv-1',
      advisor: 'serverless',
      resource: '882',
      rule: 'init-script',
    });

    expect(advice.baseline).toEqual([{ label: 'Clusters running an init script', value: 2, unit: 'count' }]);
    expect(advice.observation).toContain('2 clusters');
  });

  it('carries the analysis assumptions, because every figure under it rests on them', () => {
    expect(
      adviceFrom(withServerless(), { advisoryId: 'adv-1', advisor: 'serverless', resource: '882', rule: 'INIT_SCRIPTS' })
        .assumptions
    ).toEqual(['Priced at the list rate for the region the job ran in.']);
  });

  it('records no version rather than inventing one, because that analysis declares none', () => {
    expect(
      adviceFrom(withServerless(), { advisoryId: 'adv-1', advisor: 'serverless', resource: '882', rule: 'INIT_SCRIPTS' })
        .versions
    ).toEqual([]);
  });
});

describe('a reference that names nothing', () => {
  it('refuses an advisor the run has no analysis for', () => {
    expect(() =>
      adviceFrom(advisory(), { advisoryId: 'adv-1', advisor: 'sizing', resource: 'wh-1', rule: 'WAREHOUSE_SPILL' })
    ).toThrow(UnknownAdviceError);
  });

  it('names the resource it could not find, rather than the whole reference', () => {
    expect(() =>
      adviceFrom(withWorkload(), {
        advisoryId: 'adv-1',
        advisor: 'workload',
        resource: 'not-a-shape',
        rule: 'DATA_SPILL',
      })
    ).toThrow(/not-a-shape/);
  });

  it('refuses a rule that did not fire on that resource in this advisory', () => {
    // Not "no such rule": the rule exists and this run did not report it here. Advice changes between
    // runs, and an action raised from a finding that has gone would be work with no measurement under it.
    expect(() =>
      adviceFrom(withWorkload(), {
        advisoryId: 'adv-1',
        advisor: 'workload',
        resource: 'abc0000000000000',
        rule: 'LARGE_SORT',
      })
    ).toThrow(/LARGE_SORT/);
  });

  it('refuses a rule this build has no words for, rather than storing an action that says nothing', () => {
    const record = advisory({
      workload: {
        top: [
          {
            shape: 'abc0000000000000',
            workspaceId: 'w1',
            findings: [{ rule: 'RULE_FROM_A_LATER_BUILD', shape: 'abc0000000000000', severity: 'high', evidence: [] }],
          },
        ],
        failing: [],
        rankingVersion: 'advisor-1',
        rulesVersion: 1,
      } as never,
    });

    expect(() =>
      adviceFrom(record, {
        advisoryId: 'adv-1',
        advisor: 'workload',
        resource: 'abc0000000000000',
        rule: 'RULE_FROM_A_LATER_BUILD',
      })
    ).toThrow(UnknownAdviceError);
  });
});
