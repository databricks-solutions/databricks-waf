import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import type { ImprovementAction } from './action.js';
import { PostgresImprovementStore } from './postgres-store.js';
import type { AdviceProvenance } from './advice.js';
import type { ImprovementPlan } from './plan.js';
import {
  ConcurrentChangeError,
  InMemoryImprovementStore,
  MismatchedPlanError,
  revisionOf,
  type ImprovementStore,
} from './store.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date('2026-07-01T12:00:00.000Z');

/**
 * The keys the two tables use, declared because nothing in a statement says so.
 *
 * Both are keyed on the pair, which is the whole reason a lost race is visible: a fake that modelled
 * only `id` would refuse the second revision of a record rather than the second write of one
 * revision, and every test here would pass while saying the opposite of what it means.
 */
const KEYS = {
  improvement_plans: ['id', 'revision'],
  improvement_actions: ['id', 'revision'],
} as const;

function plan(overrides: Partial<ImprovementPlan> = {}): ImprovementPlan {
  return {
    id: 'plan-1',
    title: 'Close the Unity Catalog gaps',
    outcome: 'Every workspace reads from Unity Catalog and the metastore has an owner.',
    owners: ['platform@example.com'],
    createdBy: 'lead@example.com',
    createdAt: NOW,
    revision: 0,
    ...overrides,
  };
}

function action(overrides: Partial<ImprovementAction> = {}): ImprovementAction {
  return {
    id: 'action-1',
    planId: 'plan-1',
    controlIds: ['DG-1'],
    outcome: 'Migrate the two remaining Hive tables.',
    definitionOfDone: 'No table in the workspace resolves through the legacy metastore.',
    owner: 'dana@example.com',
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: 'draft',
    createdBy: 'lead@example.com',
    createdAt: NOW,
    history: [],
    revision: 0,
    ...overrides,
  };
}

/** An action one transition further on, which is what a store sees as the next revision. */
function moved(from: ImprovementAction, to: ImprovementAction['state'], at = LATER): ImprovementAction {
  return {
    ...from,
    state: to,
    revision: from.revision + 1,
    history: [...from.history, { from: from.state, to, at, by: 'person', who: 'dana@example.com' }],
  };
}

/** An action corrected rather than moved: a new revision with the history it already had. */
function corrected(from: ImprovementAction, owner: string): ImprovementAction {
  return { ...from, owner, revision: from.revision + 1 };
}

/** A plan closed, at the next revision. `plan.ts` is where the rules about closing one live. */
function shut(from: ImprovementPlan, reason = 'The work is finished.', by = 'lead@example.com'): ImprovementPlan {
  return { ...from, revision: from.revision + 1, closed: { at: LATER, by, reason } };
}

function postgres(): { store: ImprovementStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({ keys: KEYS });
  const errors: string[] = [];
  const store = new PostgresImprovementStore({
    db: Object.assign(db, { end: () => db.end() }),
    onError: (operation) => errors.push(operation),
  });
  return { store, db, errors };
}

/*
 * Both implementations are put through the same tests, and that is the point rather than thoroughness.
 * The in-memory store is what an install without a database runs on, and a difference between the two
 * is a difference in behaviour that only appears in the configuration nobody tests in.
 */
const implementations: readonly [string, () => ImprovementStore][] = [
  ['in memory', (): ImprovementStore => new InMemoryImprovementStore()],
  ['in postgres', (): ImprovementStore => postgres().store],
];

describe.each(implementations)('keeping plans and actions %s', (_name, open) => {
  it('reads back a plan that was written', async () => {
    const store = open();
    await store.addPlan(plan());

    expect(await store.plan('plan-1')).toMatchObject({ id: 'plan-1', title: 'Close the Unity Catalog gaps' });
    expect((await store.plans()).map((one) => one.id)).toEqual(['plan-1']);
  });

  it('has nothing to say about a plan that was never written', async () => {
    expect(await open().plan('plan-1')).toBeUndefined();
  });

  it('lists plans newest first, because a plans page is read from the top', async () => {
    const store = open();
    await store.addPlan(plan({ id: 'older', createdAt: NOW }));
    await store.addPlan(plan({ id: 'newer', createdAt: LATER }));

    expect((await store.plans()).map((one) => one.id)).toEqual(['newer', 'older']);
  });

  it('refuses a second plan with the same id, rather than replacing the first', async () => {
    const store = open();
    await store.addPlan(plan());

    await expect(store.addPlan(plan({ title: 'Something else' }))).rejects.toThrow(ConcurrentChangeError);
    expect(await store.plan('plan-1')).toMatchObject({ title: 'Close the Unity Catalog gaps' });
  });

  it('reads the closure once a plan has been closed', async () => {
    const store = open();
    const open1 = plan();
    await store.addPlan(open1);
    await store.changePlan(shut(open1));

    const read = await store.plan('plan-1');
    expect(read?.closed?.at).toEqual(LATER);
    expect(read?.closed?.reason).toBe('The work is finished.');
  });

  it('refuses a second closure of the same plan, so two people closing it do not both believe they did', async () => {
    const store = open();
    const open1 = plan();
    await store.addPlan(open1);
    await store.changePlan(shut(open1));

    // The second closer read the open plan too, so their write is at the revision the first one took.
    await expect(store.changePlan(shut(open1, 'Superseded by Q4.', 'priya@example.com'))).rejects.toThrow(
      ConcurrentChangeError
    );
    expect((await store.plan('plan-1'))?.closed?.by).toBe('lead@example.com');
  });

  it('reads back the actions of a plan, and only of that plan', async () => {
    const store = open();
    const one = plan();
    const two = plan({ id: 'plan-2' });
    await store.addPlan(one);
    await store.addPlan(two);
    await store.addAction(action({ id: 'a1' }), one);
    await store.addAction(action({ id: 'a2' }), one);
    await store.addAction(action({ id: 'a3', planId: 'plan-2' }), two);

    expect((await store.actions('plan-1')).map((each) => each.id).sort()).toEqual(['a1', 'a2']);
    expect((await store.actions('plan-2')).map((each) => each.id)).toEqual(['a3']);
  });

  it('reads the newest revision of an action, not the one it started as', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const draft = action();
    await store.addAction(draft, one);
    const planned = moved(draft, 'planned');
    await store.changeAction(planned, one);
    await store.changeAction(moved(planned, 'in-progress'), one);

    const read = await store.action('action-1');
    expect(read?.state).toBe('in-progress');
    expect(read?.history).toHaveLength(2);
  });

  it('refuses a transition somebody else has already written at that revision', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const draft = action();
    await store.addAction(draft, one);

    // Two people read the same draft and move it in different directions. The first lands.
    await store.changeAction(moved(draft, 'planned'), one);
    await expect(store.changeAction(moved(draft, 'cancelled'), one)).rejects.toThrow(ConcurrentChangeError);
    expect((await store.action('action-1'))?.state).toBe('planned');
  });

  it('finds actions naming a requirement across every plan, since the reader is looking at a finding', async () => {
    const store = open();
    const one = plan();
    const two = plan({ id: 'plan-2' });
    await store.addPlan(one);
    await store.addPlan(two);
    await store.addAction(action({ id: 'a1', controlIds: ['DG-1', 'DG-2'] }), one);
    await store.addAction(action({ id: 'a2', planId: 'plan-2', controlIds: ['DG-2'] }), two);
    await store.addAction(action({ id: 'a3', controlIds: ['SEC-9'] }), one);

    expect((await store.actionsFor('DG-2')).map((each) => each.id).sort()).toEqual(['a1', 'a2']);
    expect((await store.actionsFor('DG-1')).map((each) => each.id)).toEqual(['a1']);
    expect(await store.actionsFor('NOT-A-CONTROL')).toEqual([]);
    expect((await store.actionsRaised()).map((each) => each.id).sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('reports the newest revision when a requirement is asked about, not every revision of it', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const draft = action();
    await store.addAction(draft, one);
    await store.changeAction(moved(draft, 'planned'), one);

    const found = await store.actionsFor('DG-1');
    expect(found).toHaveLength(1);
    expect(found[0]?.state).toBe('planned');
  });

  /*
   * The Postgres store narrows this read to the actions that have ever named the requirement and
   * reduces the revisions in TypeScript, which is one statement away from the wrong answer: narrowed
   * to the revisions that name it, the revision below would be the newest one the reduction sees and
   * an action that no longer belongs to this requirement would be listed under it. The in-memory
   * store cannot get this wrong and is here to say what the right answer is.
   */
  it('leaves out an action whose newest revision has dropped the requirement', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const draft = action({ controlIds: ['DG-1', 'DG-2'] });
    await store.addAction(draft, one);
    await store.changeAction({ ...draft, controlIds: ['DG-2'], revision: 1 }, one);

    expect(await store.actionsFor('DG-1')).toEqual([]);
    expect((await store.actionsFor('DG-2')).map((each) => each.id)).toEqual(['action-1']);
  });

  it('finds an action whose newest revision has taken the requirement on', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const draft = action({ controlIds: ['DG-2'] });
    await store.addAction(draft, one);
    await store.changeAction({ ...draft, controlIds: ['DG-1', 'DG-2'], revision: 1 }, one);

    expect((await store.actionsFor('DG-1')).map((each) => each.id)).toEqual(['action-1']);
  });

  it('refuses to write an action against a plan it does not belong to', async () => {
    const store = open();
    const one = plan();
    const two = plan({ id: 'plan-2' });
    await store.addPlan(one);
    await store.addPlan(two);

    await expect(store.addAction(action({ planId: 'plan-1' }), two)).rejects.toThrow(MismatchedPlanError);
  });

  it('does not return another assessment\'s plans or their actions', async () => {
    const store = open();
    const underA = plan({ id: 'under-a', assessment: { definitionId: 'def-a', version: 1 } });
    const underB = plan({ id: 'under-b', assessment: { definitionId: 'def-b', version: 1 } });
    await store.addPlan(underA);
    await store.addPlan(underB);
    await store.addAction(action({ id: 'act-a', planId: 'under-a' }), underA);
    await store.addAction(action({ id: 'act-b', planId: 'under-b' }), underB);

    expect((await store.plans('def-a')).map((one) => one.id)).toEqual(['under-a']);
    expect((await store.plans('def-b')).map((one) => one.id)).toEqual(['under-b']);
    expect(await store.plan('under-b', 'def-a')).toBeUndefined();
    expect(await store.action('act-b', 'def-a')).toBeUndefined();
    expect((await store.action('act-a', 'def-a'))?.id).toBe('act-a');
    expect(await store.plans(null)).toEqual([]);
  });

  it('still returns an action whose plan is missing, so a validation can report it rather than hide it', async () => {
    const store = open();
    await store.addAction(action(), plan());

    expect((await store.action('action-1', 'def-a'))?.id).toBe('action-1');
    expect((await store.action('action-1', null))?.id).toBe('action-1');
  });
});

describe('what a revision number is', () => {
  it('is the record\u2019s own, raised by whatever produced the new version', () => {
    const draft = action();

    expect(revisionOf(draft)).toBe(0);
    expect(revisionOf(moved(draft, 'planned'))).toBe(1);
    expect(revisionOf(plan())).toBe(0);
    expect(revisionOf(shut(plan()))).toBe(1);
  });

  /*
   * The reason the number is not derived from the history, which is what it was first. A correction —
   * a new owner, a date that slipped — is a new version of the record and not a transition, so a
   * revision counted from the history would land on the row it came from and the store would tell a
   * lone author that somebody else had beaten them to it.
   */
  it('advances for a correction that is not a transition, so an edit is not read as a race', async () => {
    const store = new InMemoryImprovementStore();
    const one = plan();
    await store.addPlan(one);
    const draft = action();
    await store.addAction(draft, one);

    await store.changeAction(corrected(draft, 'raj@example.com'), one);

    const read = await store.action('action-1');
    expect(read?.owner).toBe('raj@example.com');
    expect(read?.history).toEqual([]);
    expect(revisionOf(read as ImprovementAction)).toBe(1);
  });
});

describe.each(implementations)('the advice an action was raised from, %s', (_name, open) => {
  const ADVICE: AdviceProvenance = {
    advisoryId: 'adv-1',
    advisor: 'sizing',
    rule: 'WAREHOUSE_QUEUEING',
    versions: [{ name: 'rulesVersion', value: '1' }],
    resource: { kind: 'warehouse', id: 'wh-1', workspaceId: 'w1', name: 'finance-bi' },
    headline: 'Statements are queueing',
    detail: 'Work waited for a cluster more often than the ruleset allows.',
    docUrl: 'https://docs.databricks.com/warehouses',
    severity: 'high',
    baseline: [{ label: 'Queued', value: 0.4, unit: 'ratio' }],
    assumptions: ['Priced at the list rate for the region the warehouse ran in.'],
    measuredAt: NOW,
    lookbackDays: 30,
  };

  it('comes back whole, with its date as a date', async () => {
    // The date is the half a type check cannot see: the provenance is jsonb, so `measuredAt` returns as
    // a string, and a pane formatting it prints an ISO timestamp beside a dozen formatted dates — only
    // on a record that has been through the database, never on the one the request that raised it held.
    const store = open();
    const one = plan();
    await store.addPlan(one);
    await store.addAction(action({ controlIds: [], advice: ADVICE }), one);

    const read = await store.action('action-1');
    expect(read?.advice?.measuredAt).toBeInstanceOf(Date);
    expect(read?.advice).toEqual(ADVICE);
  });

  it('survives a revision of the action, which does not carry it', async () => {
    const store = open();
    const one = plan();
    await store.addPlan(one);
    const raised = action({ controlIds: [], advice: ADVICE });
    await store.addAction(raised, one);
    await store.changeAction(moved(raised, 'planned'), one);

    expect((await store.action('action-1'))?.advice?.rule).toBe('WAREHOUSE_QUEUEING');
  });
});

describe('durability, which the page has to be able to say', () => {
  it('says so, either way', () => {
    expect(new InMemoryImprovementStore().durable).toBe(false);
    expect(postgres().store.durable).toBe(true);
  });
});

describe('when the database is the problem', () => {
  it('ages an action from its plan, so a sweep takes the plan and its work together', async () => {
    const { store, db } = postgres();
    const one = plan({ createdAt: NOW });
    await store.addPlan(one);
    // Raised eleven months into the plan. Its own date is late; the column retention reads is not.
    await store.addAction(action({ createdAt: LATER }), one);

    const [row] = db.rows('improvement_actions');
    expect(row?.plan_created_at).toEqual(NOW);
    expect(row?.created_at).toEqual(LATER);
  });

  it('stamps every revision with the digest of what was written, so a later edit is detectable', async () => {
    const { store, db } = postgres();
    await store.addPlan(plan());

    expect(db.rows('improvement_plans')[0]?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('keys every revision of a plan from that revision’s own citation', async () => {
    // A property of the store, not a claim about the product: no route rewrites a plan's assessment
    // today, so this is what holds if one ever does. The column is a handle on the body rather than a
    // copy of what the body said first, and the failure it catches is a revision keyed to what the
    // previous one cited — which `42c` would list under an assessment the plan no longer claims.
    const { store, db } = postgres();
    await store.addPlan(plan({ assessment: { definitionId: 'def-1', version: 2 } }));
    await store.addPlan(plan({ revision: 1, assessment: { definitionId: 'def-2', version: 1 } }));
    await store.addPlan(plan({ id: 'plan-2' }));

    const keyed = db.rows('improvement_plans').map((row) => [row.id, row.revision, row.definition_id]);
    expect(keyed).toEqual([
      ['plan-1', 0, 'def-1'],
      ['plan-1', 1, 'def-2'],
      ['plan-2', 0, null],
    ]);
  });

  it('reads as empty and reports the operation, rather than failing the page', async () => {
    const db = new FakePostgres({
      keys: KEYS,
      failOn: (sql) => (sql.startsWith('select') ? new Error('connection reset') : undefined),
    });
    const errors: string[] = [];
    const store = new PostgresImprovementStore({ db: Object.assign(db, { end: () => db.end() }), onError: (op) => errors.push(op) });

    expect(await store.plans()).toEqual([]);
    expect(errors).toEqual(['read every plan']);
  });

  it('skips a row it cannot read and says how many, rather than presenting a half-revived record', async () => {
    const { store, db, errors } = postgres();
    db.seed('improvement_plans', {
      id: 'plan-1',
      revision: 0,
      created_at: NOW,
      changed_at: NOW,
      body: { ...plan(), createdAt: 'the fourteenth' },
      digest: 'x',
    });

    expect(await store.plans()).toEqual([]);
    expect(errors).toEqual(['read every plan']);
  });

  it('treats a plan whose closure will not parse as unreadable, rather than as open again', async () => {
    // The dangerous revival. A closed plan read as open accepts new work, which is what closing it was
    // meant to stop — so the row is refused rather than returned with the closure dropped.
    const { store, db } = postgres();
    const closed = { ...plan(), closed: { at: 'never', by: 'lead@example.com', reason: 'Finished the work.' } };
    db.seed('improvement_plans', {
      id: 'plan-1',
      revision: 1,
      created_at: NOW,
      changed_at: NOW,
      body: closed,
      digest: 'x',
    });

    expect(await store.plan('plan-1')).toBeUndefined();
  });

  it('treats an action with an unreadable transition as unreadable, rather than as one with a shorter history', async () => {
    const { store, db } = postgres();
    const broken = moved(action(), 'planned');
    db.seed('improvement_actions', {
      id: 'action-1',
      revision: 1,
      plan_id: 'plan-1',
      plan_created_at: NOW,
      created_at: NOW,
      changed_at: NOW,
      body: { ...broken, history: [{ ...broken.history[0], at: 'sometime' }] },
      digest: 'x',
    });

    expect(await store.action('action-1')).toBeUndefined();
  });
});
