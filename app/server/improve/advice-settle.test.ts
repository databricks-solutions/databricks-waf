// The second path that reaches `verified`, driven the way the app drives it.
//
// `advice-reading.test.ts` holds the rules about what a later advisory may be said to have answered.
// What is tested here is the joining-up, and the assertions that matter are the ones about *not*
// writing: an advisory that predates the claim, one that could not read the resource, and one racing
// a person who took the work back. Each of those would otherwise produce a `verified` transition on
// the record, which is the one state ADR 0051 says a person may never reach on their own say-so and
// the one nobody can undo by explaining.

import { describe, expect, it } from 'vitest';
import { accountScope } from '../collect/estate-scope.js';
import type { Advisory } from '../advise/advisory.js';
import { moved, type ActionState, type ImprovementAction } from './action.js';
import type { AdviceProvenance } from './advice.js';
import type { ImprovementPlan } from './plan.js';
import { InMemoryImprovementStore } from './store.js';
import { settleAdvice } from './advice-settle.js';

const OPENED = new Date('2026-07-01T09:00:00.000Z');
const RAISED = new Date('2026-07-02T09:00:00.000Z');
const CLAIMED = new Date('2026-07-20T09:00:00.000Z');
const MEASURED = new Date('2026-08-01T09:00:00.000Z');

function plan(): ImprovementPlan {
  return {
    id: 'plan-1',
    title: 'Serverless migration',
    outcome: 'The nightly jobs run on serverless compute rather than on pinned classic clusters.',
    owners: ['priya@example.com'],
    createdBy: 'priya@example.com',
    createdAt: OPENED,
    revision: 0,
  };
}

function advice(over: Partial<AdviceProvenance> = {}): AdviceProvenance {
  return {
    advisoryId: 'adv-1',
    advisor: 'jobs',
    rule: 'JOB_RUNS_NOT_SUCCEEDING',
    severity: 'high',
    headline: 'Failing often',
    detail: 'More than a fifth of this job’s runs failed.',
    docUrl: 'https://docs.databricks.com/jobs',
    resource: { kind: 'job', id: '882', workspaceId: 'w1' },
    baseline: [{ label: 'Failed runs', value: 12, unit: 'count' }],
    assumptions: [],
    versions: [{ name: 'rulesVersion', value: '1' }],
    measuredAt: RAISED,
    lookbackDays: 30,
    ...over,
  };
}

/** An action raised from advice and walked to whatever state a case wants, claimed at `CLAIMED`. */
function action(over: { readonly to?: ActionState; readonly advice?: AdviceProvenance } = {}): ImprovementAction {
  const who = 'sam@example.com';
  const draft: ImprovementAction = {
    id: 'action-1',
    planId: 'plan-1',
    controlIds: [],
    outcome: 'The nightly job stops failing, so the morning report is there when people arrive.',
    definitionOfDone: 'Three consecutive weeks with no failed run of the nightly job.',
    owner: who,
    due: new Date('2026-08-14T00:00:00.000Z'),
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: 'draft',
    createdBy: 'priya@example.com',
    createdAt: OPENED,
    history: [],
    revision: 0,
    advice: over.advice ?? advice(),
  };
  if (over.to === 'draft') return draft;

  let walked = moved(draft, { to: 'planned', who, at: OPENED });
  walked = moved(walked, { to: 'in-progress', who, at: OPENED });
  walked = moved(walked, { to: 'ready-for-validation', who, at: CLAIMED });
  return over.to == null || over.to === 'ready-for-validation'
    ? walked
    : moved(walked, { to: over.to, who, at: CLAIMED, reason: 'the change did not land where we expected it to' });
}

function advisory(over: Partial<Advisory> = {}): Advisory {
  return {
    id: 'adv-2',
    runId: 'run-2',
    startedAt: MEASURED,
    finishedAt: MEASURED,
    state: 'complete',
    scope: accountScope(),
    lookbackDays: 30,
    stamp: { actor: 'priya@example.com', executionMode: 'service-principal', warehouse: 'wh-1' },
    readings: [],
    ...over,
  };
}

/** A job analysis holding the job, with whatever findings the case wants on it. */
function reporting(findings: readonly unknown[]): Advisory {
  return advisory({
    jobs: { jobs: [{ workspaceId: 'w1', jobId: '882', name: 'nightly', findings }], rulesVersion: 1 } as never,
  });
}

const FIRED = [
  { rule: 'JOB_RUNS_NOT_SUCCEEDING', severity: 'high', evidence: [{ label: 'Failed runs', value: 9, unit: 'count' }] },
];

async function stored(one: ImprovementAction): Promise<InMemoryImprovementStore> {
  const store = new InMemoryImprovementStore();
  const kept = plan();
  await store.addPlan(kept);
  await store.addAction(one, kept);
  return store;
}

describe('an advisory that no longer reports the finding', () => {
  it('verifies the action, and names the advisory rather than a person', () => {
    // ADR 0051's rule, in the form this row needs it: an action naming no requirement can never be
    // answered by a scan, so the advisory is the only thing entitled to write this transition.
    return (async () => {
      const store = await stored(action());
      const settled = await settleAdvice(reporting([]), { improvements: store });

      expect(settled).toMatchObject({ read: 1, cleared: 1, firing: 0, stalled: 0 });

      const after = await store.action('action-1', null);
      expect(after?.state).toBe('verified');
      expect(after?.history.at(-1)).toMatchObject({ to: 'verified', by: 'advisor', who: 'adv-2' });
    })();
  });
});

describe('an advisory that answers nothing about it', () => {
  it('leaves an action alone while the rule is still firing', async () => {
    const store = await stored(action());
    const settled = await settleAdvice(reporting(FIRED), { improvements: store });

    expect(settled).toMatchObject({ cleared: 0, firing: 1 });
    expect((await store.action('action-1', null))?.state).toBe('ready-for-validation');
  });

  it('leaves it alone where the run says nothing about the resource', async () => {
    // Not a fix. The job advisor reports a ranked population, so a job that has left it may have been
    // fixed or may simply not have run — and verifying on absence clears work by the estate quietening.
    const store = await stored(action());
    const settled = await settleAdvice(advisory({ jobs: { jobs: [], rulesVersion: 1 } as never }), {
      improvements: store,
    });

    expect(settled).toMatchObject({ cleared: 0, unreadable: 1 });
    expect((await store.action('action-1', null))?.state).toBe('ready-for-validation');
  });

  it('leaves it alone where the analysis never formed', async () => {
    const store = await stored(action());

    expect(await settleAdvice(advisory(), { improvements: store })).toMatchObject({ cleared: 0, unreadable: 1 });
  });

  it('refuses an advisory that finished before the work was claimed done', async () => {
    // The argument `validate/attempt.ts` opens with, and it holds identically here: a run between the
    // work starting and the owner finishing it measured a half-done change.
    const store = await stored(action());
    const early = reporting([]);
    const settled = await settleAdvice({ ...early, finishedAt: new Date(CLAIMED.getTime() - 1000) }, {
      improvements: store,
    });

    expect(settled).toMatchObject({ read: 0, cleared: 0 });
    expect((await store.action('action-1', null))?.state).toBe('ready-for-validation');
  });
});

describe('what the pass will not touch', () => {
  it('reads only the actions whose owner has claimed the work is done', async () => {
    const store = await stored(action({ to: 'in-progress' }));

    expect(await settleAdvice(reporting([]), { improvements: store })).toMatchObject({ read: 0, cleared: 0 });
  });

  it('leaves an action that names requirements to the scan that can answer it', async () => {
    // Both surfaces can hold a claim about one action, and the assessment is the stronger reading.
    // This pass verifying it would take the requirement's answer out of the requirement's hands.
    const store = new InMemoryImprovementStore();
    const kept = plan();
    await store.addPlan(kept);
    const both = { ...action(), controlIds: ['DG-01-01'] };
    await store.addAction(both, kept);

    const settled = await settleAdvice(reporting([]), { improvements: store });

    expect(settled).toMatchObject({ read: 0, cleared: 0 });
    expect((await store.action('action-1', null))?.state).toBe('ready-for-validation');
  });

  it('settles nothing and reports nothing thrown when the plans cannot be read', async () => {
    // The pass runs after the advisory is saved and may not fail it: the advice is real and worth
    // keeping whatever happens to somebody's board.
    const errors: string[] = [];
    const broken = {
      plans: () => Promise.reject(new Error('the database is not there')),
    } as never;

    const settled = await settleAdvice(reporting([]), {
      improvements: broken,
      onError: (operation) => errors.push(operation),
    });

    expect(settled).toMatchObject({ read: 0, cleared: 0 });
    expect(errors).toEqual(['read the actions waiting on an advisory']);
  });
});
