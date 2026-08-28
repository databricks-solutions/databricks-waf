import { describe, expect, it } from 'vitest';
import {
  ACTION_STATES,
  draftFrom,
  InvalidActionError,
  MIN_PROSE,
  moved,
  movesFor,
  needsReason,
  priorityFor,
  revised,
  verifiedBy,
  type ActionState,
  type DraftContext,
  type ImprovementAction,
} from './action.js';
import type { AdviceProvenance } from './advice.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const DUE = new Date('2026-08-01T00:00:00.000Z');

function context(overrides: Partial<DraftContext> = {}): DraftContext {
  return {
    knownControl: (id) => id === 'DG-02-01' || id === 'SCP-01-01',
    siblings: [],
    now: NOW,
    ...overrides,
  };
}

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    planId: 'plan-1',
    controlIds: ['DG-02-01'],
    outcome: 'Customer data in the lakehouse is governed by Unity Catalog rather than by convention.',
    definitionOfDone: 'The legacy metastore holds no tables, and the two jobs write through the catalogue.',
    owner: 'platform-team@example.com',
    priority: 'now',
    effort: 'medium',
    due: DUE.toISOString(),
    steps: ['Inventory the legacy tables', 'Migrate the two jobs'],
    ...overrides,
  };
}

function action(overrides: Partial<ImprovementAction> = {}): ImprovementAction {
  const draft = draftFrom(body(), context());
  return {
    id: 'action-1',
    ...draft,
    state: 'draft',
    createdBy: 'lead@example.com',
    createdAt: NOW,
    history: [],
    revision: 0,
    ...overrides,
  };
}

/** An action already offered for validation, which is the state the run can speak to. */
function claimed(at = new Date('2026-06-10T00:00:00.000Z')): ImprovementAction {
  return action({
    state: 'ready-for-validation',
    history: [{ from: 'in-progress', to: 'ready-for-validation', at, by: 'person', who: 'owner@example.com' }],
  });
}

describe('writing down an action', () => {
  it('keeps the outcome, the definition of done, the owner and the steps', () => {
    const draft = draftFrom(body(), context());

    expect(draft.controlIds).toEqual(['DG-02-01']);
    expect(draft.owner).toBe('platform-team@example.com');
    expect(draft.effort).toBe('medium');
    expect(draft.steps).toHaveLength(2);
    expect(draft.due?.toISOString()).toBe(DUE.toISOString());
  });

  it('refuses an action about nothing in the framework, which no run could ever verify', () => {
    expect(() => draftFrom(body({ controlIds: [] }), context())).toThrow(/at least one requirement/);
  });

  it('refuses a requirement this framework does not have, rather than storing an orphan', () => {
    expect(() => draftFrom(body({ controlIds: ['XX-99-99'] }), context())).toThrow(/no requirement with the id/);
  });

  it('collapses a repeated requirement rather than counting it twice', () => {
    // A repeated id is a slip in the form. Refusing it teaches nobody anything; keeping it would make
    // "the requirements this answers" read high.
    const draft = draftFrom(body({ controlIds: ['DG-02-01', 'DG-02-01', 'SCP-01-01'] }), context());

    expect(draft.controlIds).toEqual(['DG-02-01', 'SCP-01-01']);
  });

  it('refuses a requirement id that is not text, rather than dropping it and storing a smaller action', () => {
    // The failure this rule exists for: dropped silently, an action sent with two requirements is
    // stored answering one, and nothing anywhere says so. A blank entry is different — that is somebody
    // who has not typed in a row yet, and refusing the submission over it would be a rule about typing.
    expect(() => draftFrom(body({ controlIds: ['DG-02-01', 42] }), context())).toThrow(/controlIds has to be text/);
    expect(() => draftFrom(body({ controlIds: 'DG-02-01' }), context())).toThrow(/list of text values/);
    expect(draftFrom(body({ controlIds: ['DG-02-01', '  '] }), context()).controlIds).toEqual(['DG-02-01']);
  });

  it('refuses a definition of done nobody could check against', () => {
    expect(() => draftFrom(body({ definitionOfDone: 'done' }), context())).toThrow(new RegExp(String(MIN_PROSE)));
  });

  it('refuses an outcome written as a task', () => {
    expect(() => draftFrom(body({ outcome: 'fix it' }), context())).toThrow(/outcome/);
  });

  it('takes a draft with no date, because an action written in a workshop does not have one yet', () => {
    const draft = draftFrom(body({ due: undefined }), context());

    expect(draft.due).toBeUndefined();
  });

  it('refuses a date already in the past, which would make every overdue count meaningless', () => {
    expect(() => draftFrom(body({ due: '2026-01-01T00:00:00.000Z' }), context())).toThrow(/in the future/);
  });

  it('refuses a priority or an effort outside the vocabulary', () => {
    expect(() => draftFrom(body({ priority: 'urgent' }), context())).toThrow(/priority must be one of/);
    expect(() => draftFrom(body({ effort: '3 days' }), context())).toThrow(/effort must be one of/);
  });
});

describe('depending on another action', () => {
  const siblings = [
    { id: 'a', dependsOn: [] },
    { id: 'b', dependsOn: ['a'] },
  ];

  it('takes a dependency on an action in the same plan', () => {
    const draft = draftFrom(body({ dependsOn: ['a', 'b'] }), context({ siblings }));

    expect(draft.dependsOn).toEqual(['a', 'b']);
  });

  it('refuses a dependency on work outside the plan, because the rollup could not then be right', () => {
    expect(() => draftFrom(body({ dependsOn: ['elsewhere'] }), context({ siblings }))).toThrow(
      /same plan|two plans are one plan/
    );
  });

  it('refuses a circle when the action being revised is already waited on', () => {
    // `b` waits on `a`. Revising `a` to wait on `b` closes the circle, and nothing in it could be first.
    expect(() => draftFrom(body({ dependsOn: ['b'] }), context({ siblings, self: 'a' }))).toThrow(/circle/);
  });

  it('takes a diamond, which is an ordinary order rather than a circle', () => {
    // Two dependencies that meet further down. The walk has to guard against revisiting `a` without
    // reading the second visit as a cycle.
    const diamond = [
      { id: 'a', dependsOn: [] },
      { id: 'b', dependsOn: ['a'] },
      { id: 'c', dependsOn: ['a'] },
    ];

    const draft = draftFrom(body({ dependsOn: ['b', 'c'] }), context({ siblings: diamond, self: 'd' }));

    expect(draft.dependsOn).toEqual(['b', 'c']);
  });

  it('refuses an action depending on itself', () => {
    expect(() => draftFrom(body({ dependsOn: ['a'] }), context({ siblings, self: 'a' }))).toThrow(/depend on itself/);
  });
});

describe('the lifecycle', () => {
  it('offers only the moves a person may make from where the action is', () => {
    expect(movesFor('draft')).toEqual(['planned', 'cancelled']);
    expect(movesFor('blocked')).toEqual(['in-progress', 'cancelled']);
    // Verified is absent from `ready-for-validation`, and that absence is the point of the column.
    expect(movesFor('ready-for-validation')).not.toContain('verified');
    expect(movesFor('verified')).toEqual([]);
    expect(movesFor('cancelled')).toEqual([]);
  });

  it('records who moved it and when, appending rather than replacing', () => {
    const planned = moved(action(), { to: 'planned', who: 'lead@example.com', at: NOW });
    const started = moved(planned, { to: 'in-progress', who: 'owner@example.com', at: NOW });

    expect(started.state).toBe('in-progress');
    expect(started.history.map((entry) => entry.to)).toEqual(['planned', 'in-progress']);
    expect(started.history[0]?.who).toBe('lead@example.com');
  });

  it('leaves the action it was given alone, so a caller that refuses to persist changes nothing', () => {
    const original = action();

    moved(original, { to: 'planned', who: 'lead@example.com', at: NOW });

    expect(original.state).toBe('draft');
    expect(original.history).toEqual([]);
  });

  it('refuses to plan an action nobody could judge finished', () => {
    const vague = action({ definitionOfDone: 'later' });

    expect(() => moved(vague, { to: 'planned', who: 'lead@example.com', at: NOW })).toThrow(/finished/);
  });

  it('refuses to plan an action with no date', () => {
    const undated = action({ due: undefined });

    expect(() => moved(undated, { to: 'planned', who: 'lead@example.com', at: NOW })).toThrow(/as due/);
  });

  it('demands a reason for the two moves away from the work happening', () => {
    expect(needsReason('blocked')).toBe(true);
    expect(needsReason('cancelled')).toBe(true);
    expect(needsReason('in-progress')).toBe(false);

    const planned = moved(action(), { to: 'planned', who: 'lead@example.com', at: NOW });
    expect(() => moved(planned, { to: 'blocked', who: 'owner@example.com', at: NOW })).toThrow(/blocked on/);
    expect(() =>
      moved(planned, { to: 'blocked', who: 'owner@example.com', reason: 'waiting', at: NOW })
    ).toThrow(new RegExp(String(MIN_PROSE)));
  });

  it('names both ends when it refuses a move, so a log says which one was the surprise', () => {
    expect(() => moved(action(), { to: 'ready-for-validation', who: 'owner@example.com', at: NOW })).toThrow(
      /that is draft can only become planned or cancelled/
    );
  });

  it('says what happened to a verified action rather than that the move is invalid', () => {
    const done = action({ state: 'verified' });

    expect(() => moved(done, { to: 'in-progress', who: 'owner@example.com', at: NOW })).toThrow(
      /new finding and a new action/
    );
  });

  it('keeps a cancelled action as a record rather than letting it be restarted', () => {
    const dropped = action({ state: 'cancelled' });

    expect(() => moved(dropped, { to: 'planned', who: 'lead@example.com', at: NOW })).toThrow(/Raise a new one/);
  });

  it('refuses a state that does not exist, naming the seven', () => {
    expect(() => moved(action(), { to: 'finished' as ActionState, who: 'lead@example.com', at: NOW })).toThrow(
      /There is no state called finished/
    );
    expect(ACTION_STATES).toHaveLength(7);
  });
});

describe('nobody verifies their own work', () => {
  it('refuses a person moving an action to verified, and says what does', () => {
    expect(() => moved(claimed(), { to: 'verified', who: 'owner@example.com', at: NOW })).toThrow(
      /Nobody can mark their own work verified/
    );
  });

  it('records a verification against the run that made it, not against a person', () => {
    const at = new Date('2026-06-20T00:00:00.000Z');

    const verified = verifiedBy(claimed(), 'scan-77', at);

    expect(verified.state).toBe('verified');
    expect(verified.history.at(-1)).toMatchObject({ to: 'verified', by: 'run', who: 'scan-77' });
  });

  it('refuses to verify work whose owner has not said it is done', () => {
    expect(() => verifiedBy(action({ state: 'in-progress' }), 'scan-77', NOW)).toThrow(
      InvalidActionError
    );
  });
});

describe('correcting an action', () => {
  it('keeps its identity, its state and its history, and changes the rest', () => {
    const planned = action({
      state: 'planned',
      history: [{ from: 'draft', to: 'planned', at: NOW, by: 'person', who: 'lead@example.com' }],
    });

    const after = revised(planned, body({ owner: 'raj@example.com', priority: 'later', steps: [] }), context());

    expect(after).toMatchObject({
      id: 'action-1',
      planId: 'plan-1',
      state: 'planned',
      owner: 'raj@example.com',
      priority: 'later',
      createdBy: 'lead@example.com',
      createdAt: NOW,
    });
    expect(after.steps).toEqual([]);
    // Not a transition, so the history says what it said. What changed is in the audit log.
    expect(after.history).toEqual(planned.history);
  });

  it('will not let a revision move an action to another plan, whatever the body says', () => {
    const after = revised(action(), body({ planId: 'plan-99' }), context());

    expect(after.planId).toBe('plan-1');
  });

  it('lets a draft change what it is about, because nothing about it has been agreed', () => {
    const after = revised(action(), body({ controlIds: ['SCP-01-01'] }), context());

    expect(after.controlIds).toEqual(['SCP-01-01']);
  });

  it('refuses to change what agreed work is about, naming the fields and the way out', () => {
    const live = action({ state: 'in-progress' });

    expect(() =>
      revised(live, body({ controlIds: ['SCP-01-01'], definitionOfDone: body().definitionOfDone }), context())
    ).toThrow(/cannot have its controlIds changed/);
    expect(() => revised(live, body({ outcome: 'A shorter outcome that is still long enough to pass.' }), context()))
      .toThrow(/cancel it with a reason/);
  });

  it('accepts a revision that leaves the agreed fields alone', () => {
    const after = revised(action({ state: 'in-progress' }), body({ owner: 'raj@example.com' }), context());

    expect(after.owner).toBe('raj@example.com');
  });

  it('permits the date it already had, even once that date has passed', () => {
    const late = new Date('2026-09-01T00:00:00.000Z');

    // The stored date is behind the clock, and the revision is not touching it.
    const after = revised(action(), body({ owner: 'raj@example.com' }), context({ now: late }));
    expect(after.due).toEqual(DUE);

    // A new date still has to be in the future, which is the rule this exception is carved out of.
    expect(() => revised(action(), body({ due: '2026-08-15T00:00:00.000Z' }), context({ now: late }))).toThrow(
      /has to be in the future/
    );
  });

  it('clears a date that the revision leaves out', () => {
    const after = revised(action(), { ...body(), due: undefined }, context());

    expect(after.due).toBeUndefined();
  });

  it('refuses to edit either terminal state, for opposite reasons', () => {
    expect(() => revised(action({ state: 'verified' }), body(), context())).toThrow(/a run agreed with/);
    expect(() => revised(action({ state: 'cancelled' }), body(), context())).toThrow(/record of what was considered/);
  });

  it('refuses a dependency that would close a circle through the action being revised', () => {
    const siblings = [{ id: 'action-2', dependsOn: ['action-1'] }];

    expect(() => revised(action(), body({ dependsOn: ['action-2'] }), context({ siblings }))).toThrow(
      /run in a circle/
    );
  });
});

describe('the starting priority', () => {
  it('follows severity, and is a suggestion rather than a rule', () => {
    expect(priorityFor('critical')).toBe('now');
    expect(priorityFor('medium')).toBe('next');
    expect(priorityFor('informational')).toBe('later');

    // The field is on the draft, so an owner can disagree with the framework about their own estate.
    const draft = draftFrom(body({ controlIds: ['SCP-01-01'], priority: 'later' }), context());
    expect(draft.priority).toBe('later');
  });
});

describe('an action raised from advisor advice', () => {
  /** What the resolver would answer, standing in for a stored advisory. */
  const PROVENANCE: AdviceProvenance = {
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
    assumptions: [],
    measuredAt: NOW,
    lookbackDays: 30,
  };

  const reference = { advisoryId: 'adv-1', advisor: 'sizing', resource: 'wh-1', rule: 'WAREHOUSE_QUEUEING' };
  const resolving = (overrides: Partial<DraftContext> = {}) =>
    context({ adviceFor: () => PROVENANCE, ...overrides });

  it('may name no requirement, because no requirement in the framework measures a warehouse', () => {
    const draft = draftFrom(body({ controlIds: [], advice: reference }), resolving());

    expect(draft.controlIds).toEqual([]);
    expect(draft.advice).toEqual(PROVENANCE);
  });

  it('still refuses an action about neither a requirement nor a finding', () => {
    expect(() => draftFrom(body({ controlIds: [] }), resolving())).toThrow(/or the advisor finding it came from/);
  });

  it('stores what the record says rather than what the body says the record says', () => {
    // The body carries a headline, a baseline and a version of its own, and none of them reach the
    // draft. A client posting a copy would be posting whatever page it had open — see advice.ts.
    const draft = draftFrom(
      body({
        controlIds: [],
        advice: { ...reference, headline: 'Something else entirely', baseline: [{ label: 'Made up', value: 9 }] },
      }),
      resolving()
    );

    expect(draft.advice?.headline).toBe('Statements are queueing');
    expect(draft.advice?.baseline).toEqual([{ label: 'Queued', value: 0.4, unit: 'ratio' }]);
  });

  it('refuses a reference short of one of its four ids, which names a set rather than a thing', () => {
    expect(() =>
      draftFrom(body({ controlIds: [], advice: { advisoryId: 'adv-1', advisor: 'sizing', rule: 'WAREHOUSE_QUEUEING' } }), resolving())
    ).toThrow(/all four/);
  });

  it('refuses an advisor this app does not have', () => {
    expect(() => draftFrom(body({ advice: { ...reference, advisor: 'clusters' } }), resolving())).toThrow(
      /must be one of/
    );
  });

  it('refuses the reference where no advisory can be read, rather than storing an unverifiable one', () => {
    // An install with no advisory store. An action recording advice nobody can look up reads as
    // checkable and is not, which is worse than an action with no provenance at all.
    expect(() => draftFrom(body({ advice: reference }), context())).toThrow(/not keeping advisories/);
  });

  it('keeps the provenance across a revision, without re-reading the advisory', () => {
    const raised = action({ ...draftFrom(body({ controlIds: [], advice: reference }), resolving()) });
    const moved = revised(
      raised,
      { ...body({ controlIds: [], owner: 'someone-else@example.com' }), advice: { ...reference, advisoryId: 'adv-2' } },
      // No resolver at all: a revision that needed one would be a revision that re-read the advice,
      // and a correction to an owner's name would silently move what the action is about.
      context()
    );

    expect(moved.owner).toBe('someone-else@example.com');
    expect(moved.advice).toEqual(PROVENANCE);
  });
});
