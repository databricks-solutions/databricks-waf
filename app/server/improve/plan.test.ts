import { describe, expect, it } from 'vitest';
import { closed, draftFrom, MIN_PROSE, type ImprovementPlan } from './plan.js';
import type { ActionState, ImprovementAction } from './action.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function body(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: 'Govern the lakehouse',
    outcome: 'Every table customer data lands in is governed by Unity Catalog rather than by convention.',
    owners: ['platform-lead@example.com'],
    ...overrides,
  };
}

function plan(overrides: Partial<ImprovementPlan> = {}): ImprovementPlan {
  return {
    id: 'plan-1',
    ...draftFrom(body()),
    createdBy: 'platform-lead@example.com',
    createdAt: NOW,
    revision: 0,
    ...overrides,
  };
}

function action(state: ActionState, planId = 'plan-1'): ImprovementAction {
  return {
    id: `action-${state}`,
    planId,
    controlIds: ['DG-02-01'],
    outcome: 'Customer data is governed by the catalogue rather than by convention.',
    definitionOfDone: 'The legacy metastore holds no tables, and the two jobs write through the catalogue.',
    owner: 'owner@example.com',
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state,
    createdBy: 'platform-lead@example.com',
    createdAt: NOW,
    history: [],
    revision: 0,
  };
}

describe('writing down a plan', () => {
  it('keeps the title, the outcome and the owners', () => {
    const draft = draftFrom(body({ owners: ['a@example.com', 'b@example.com'] }));

    expect(draft.title).toBe('Govern the lakehouse');
    expect(draft.owners).toEqual(['a@example.com', 'b@example.com']);
  });

  it('refuses a plan with a title and no outcome, which is a folder', () => {
    expect(() => draftFrom(body({ outcome: 'security work' }))).toThrow(new RegExp(String(MIN_PROSE)));
  });

  it('refuses a plan nobody owns', () => {
    expect(() => draftFrom(body({ owners: [] }))).toThrow(/answerable for this plan/);
  });

  it('refuses an owner that is not text, rather than storing a plan with fewer owners than it was sent', () => {
    expect(() => draftFrom(body({ owners: ['a@example.com', { name: 'b' }] }))).toThrow(/owners has to be text/);
    expect(() => draftFrom(body({ owners: 'a@example.com' }))).toThrow(/list of text values/);
  });

  it('takes the run it was raised from, which is the baseline', () => {
    // A reference rather than a copy of the score, so the two cannot disagree.
    const draft = draftFrom(body({ raisedFrom: 'scan-12' }));

    expect(draft.raisedFrom).toBe('scan-12');
  });

  it('refuses an assessment reference that names nothing, because a dangling citation answers wrongly', () => {
    expect(() =>
      draftFrom(body({ assessment: { definitionId: 'def-1', version: 3 } }), {
        knownAssessment: (id, version) => id === 'def-1' && version === 2,
      })
    ).toThrow(/no version 3/);
  });

  it('refuses half an assessment reference rather than storing the half it understood', () => {
    expect(() => draftFrom(body({ assessment: { definitionId: 'def-1' } }))).toThrow(/whole version number/);
  });

  it('takes no assessment at all, because a plan can come out of a workshop', () => {
    expect(draftFrom(body()).assessment).toBeUndefined();
  });
});

describe('closing a plan', () => {
  it('refuses while any action is still live, naming how many', () => {
    expect(() =>
      closed(plan(), [action('verified'), action('in-progress'), action('blocked')], {
        by: 'platform-lead@example.com',
        reason: 'The programme moved to the FY27 plan and these two are tracked there.',
        at: NOW,
      })
    ).toThrow(/2 actions in this plan are still live/);
  });

  it('ignores live work in another plan, rather than refusing a closure because of it', () => {
    // Handed a wider set than it needed — every action in the install, say — an unfiltered check would
    // refuse this closure because somebody else's plan has work in it.
    const settled = closed(plan(), [action('verified'), action('in-progress', 'plan-2')], {
      by: 'platform-lead@example.com',
      reason: 'The one action landed; the other belongs to the FY27 programme and is tracked there.',
      at: NOW,
    });

    expect(settled.closed).toBeDefined();
  });

  it('closes a plan whose actions are all verified or cancelled', () => {
    const settled = closed(plan(), [action('verified'), action('cancelled')], {
      by: 'platform-lead@example.com',
      reason: 'Both actions landed and the third was answered by the platform upgrade instead.',
      at: NOW,
    });

    expect(settled.closed?.by).toBe('platform-lead@example.com');
    expect(settled.closed?.at).toEqual(NOW);
  });

  it('closes an empty plan, which is a plan nothing came of and is worth keeping as that', () => {
    const abandoned = closed(plan(), [], {
      by: 'platform-lead@example.com',
      reason: 'Written in the workshop and never taken forward; the estate was rescoped in July.',
      at: NOW,
    });

    expect(abandoned.closed).toBeDefined();
  });

  it('refuses a closing reason nobody could act on', () => {
    expect(() => closed(plan(), [], { by: 'lead@example.com', reason: 'done', at: NOW })).toThrow(
      new RegExp(String(MIN_PROSE))
    );
  });

  it('refuses to close a plan twice', () => {
    const once = closed(plan(), [], {
      by: 'lead@example.com',
      reason: 'Written in the workshop and never taken forward; the estate was rescoped in July.',
      at: NOW,
    });

    expect(() =>
      closed(once, [], {
        by: 'lead@example.com',
        reason: 'Written in the workshop and never taken forward; the estate was rescoped in July.',
        at: NOW,
      })
    ).toThrow(/already closed/);
  });
});
