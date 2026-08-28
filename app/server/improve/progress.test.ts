import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../attest/attestation.js';
import type { Outcome } from '../resolve/finding.js';
import type { ActionState, ImprovementAction, Transition } from './action.js';
import type { AdviceReading } from './advice-reading.js';
import { agreed, needsAttention, planProgress, progressOf, type AgreementContext } from './progress.js';

const CREATED = new Date('2026-06-01T00:00:00.000Z');
const CLAIMED = new Date('2026-06-10T00:00:00.000Z');
const NOW = new Date('2026-06-20T00:00:00.000Z');

function action(overrides: Partial<ImprovementAction> = {}): ImprovementAction {
  return {
    id: 'action-1',
    planId: 'plan-1',
    controlIds: ['DG-02-01'],
    outcome: 'Customer data is governed by the catalogue rather than by convention.',
    definitionOfDone: 'The legacy metastore holds no tables, and the two jobs write through the catalogue.',
    owner: 'owner@example.com',
    priority: 'now',
    effort: 'medium',
    due: new Date(NOW.getTime() + 30 * DAY_MS),
    steps: [],
    dependsOn: [],
    state: 'draft',
    createdBy: 'lead@example.com',
    createdAt: CREATED,
    history: [],
    revision: 0,
    ...overrides,
  };
}

function claim(at = CLAIMED): Transition {
  return { from: 'in-progress', to: 'ready-for-validation', at, by: 'person', who: 'owner@example.com' };
}

/** An action whose owner has said the work is done, which is the state a run can speak to. */
function offered(overrides: Partial<ImprovementAction> = {}): ImprovementAction {
  return action({ state: 'ready-for-validation', history: [claim()], ...overrides });
}

function ran(outcomes: Readonly<Record<string, Outcome>>, at = new Date(CLAIMED.getTime() + DAY_MS)): AgreementContext {
  return {
    findings: Object.entries(outcomes).map(([controlId, outcome]) => ({ controlId, outcome })),
    measuredAt: at,
    now: NOW,
  };
}

/** A run reporting the requirement met on the strength of an answer somebody gave on a date. */
function attested(at: Date, bearing: 'outcome' | 'record' = 'outcome'): AgreementContext {
  return {
    findings: [
      {
        controlId: 'DG-02-01',
        outcome: 'pass',
        attested: {
          bearing,
          at,
          by: 'owner@example.com',
          statement: 'Reviewed quarterly by the platform team.',
          owner: 'platform@example.com',
          reviewBy: new Date(at.getTime() + 365 * DAY_MS),
        },
      },
    ],
    measuredAt: new Date(CLAIMED.getTime() + DAY_MS),
    now: NOW,
  };
}

describe('what the estate says about an action', () => {
  it('says nothing while nobody has claimed the work is done', () => {
    // Including when a run has since measured the requirement as failing: an action in progress has
    // made no claim, and reading the run as a contradiction would make every action that spans a
    // scheduled scan look like a failed fix.
    expect(progressOf(action({ state: 'in-progress' }), ran({ 'DG-02-01': 'fail' })).agreement).toBe('unclaimed');
  });

  it('reports a claim the run since contradicts, which is the reason to have this reading at all', () => {
    const reading = progressOf(offered(), ran({ 'DG-02-01': 'fail' }));

    expect(reading.agreement).toBe('contradicted');
    expect(reading.unmet).toEqual(['DG-02-01']);
  });

  it('reports a partial as a contradiction, because the requirement is still not met', () => {
    expect(progressOf(offered(), ran({ 'DG-02-01': 'partial' })).agreement).toBe('contradicted');
  });

  it('contradicts an action a run already verified, once a later run disagrees', () => {
    // The question a terminal `verified` invites. A fix that regressed in July is contradicted, and the
    // action stays `verified` — the state records that a run did agree, on a date named in the history,
    // and the agreement records what the estate says now. Moving it back out would rewrite the record
    // of a verification that genuinely happened, and add a transition on every scan that disagreed.
    const done = action({
      state: 'verified',
      history: [claim(), { from: 'ready-for-validation', to: 'verified', at: NOW, by: 'run', who: 'scan-9' }],
    });

    expect(progressOf(done, ran({ 'DG-02-01': 'pass' })).agreement).toBe('agreed');
    expect(progressOf(done, ran({ 'DG-02-01': 'fail' })).agreement).toBe('contradicted');
    expect(needsAttention(progressOf(done, ran({ 'DG-02-01': 'fail' })))).toBe(true);
  });

  it('agrees only when every requirement the action names is met', () => {
    const both = offered({ controlIds: ['DG-02-01', 'SCP-01-01'] });

    expect(progressOf(both, ran({ 'DG-02-01': 'pass', 'SCP-01-01': 'fail' })).agreement).toBe('contradicted');
    expect(progressOf(both, ran({ 'DG-02-01': 'pass', 'SCP-01-01': 'not-applicable' })).agreement).toBe('agreed');
    expect(agreed(both, ran({ 'DG-02-01': 'pass', 'SCP-01-01': 'satisfied-by-architecture' }))).toBe(true);
  });

  it('does not let a permission the app lost count as agreement', () => {
    // A run that could not read the setting has not agreed with anything, and reporting it as
    // agreement would verify a fix by the app being granted less than it was before.
    const reading = progressOf(offered(), ran({ 'DG-02-01': 'unmeasurable' }));

    expect(reading.agreement).toBe('unmeasured');
    expect(reading.unreadable).toEqual(['DG-02-01']);
    expect(agreed(offered(), ran({ 'DG-02-01': 'unmeasurable' }))).toBe(false);
  });

  it('does not count somebody’s answer from before the claim as agreement', () => {
    // AUD-DEC-107, in the one shape it takes here: fifty-five requirements in this catalogue are
    // answered by a person, a run reports them met because the answer says so, and an answer given in
    // March says what was true in March. A run "agreeing" with a fix claimed in June on the strength of
    // it is the agreement this reading exists to refuse.
    const stale = attested(new Date(CLAIMED.getTime() - 30 * DAY_MS));
    const reading = progressOf(offered(), stale);

    expect(reading.agreement).toBe('unmeasured');
    expect(reading.unreadable).toEqual(['DG-02-01']);
    expect(agreed(offered(), stale)).toBe(false);
  });

  it('counts one given after it, which is what asking again produces', () => {
    expect(progressOf(offered(), attested(new Date(CLAIMED.getTime() + DAY_MS))).agreement).toBe('agreed');
  });

  it('counts an answer recorded beside a measurement, because the measurement decided it', () => {
    // `bearing: 'record'` means the outcome does not rest on the answer. Refusing it as stale evidence
    // would refuse the stronger of the two answers on the strength of the weaker one's date.
    const beside = attested(new Date(CLAIMED.getTime() - 30 * DAY_MS), 'record');

    expect(progressOf(offered(), beside).agreement).toBe('agreed');
  });

  it('reports a stale answer as unmeasured rather than as the estate disagreeing', () => {
    // The half that matters: nobody has said the work did not land. A `contradicted` here would send an
    // owner to re-do work that is done, when what is needed is a colleague answering the question again.
    const reading = progressOf(offered(), attested(new Date(CLAIMED.getTime() - DAY_MS)));

    expect(reading.agreement).not.toBe('contradicted');
    expect(reading.unmet).toEqual([]);
  });

  it('waits where no run has measured the requirement since the claim', () => {
    expect(progressOf(offered(), { findings: [], measuredAt: new Date(CLAIMED.getTime() + DAY_MS), now: NOW }).agreement).toBe(
      'unmeasured'
    );
    expect(progressOf(offered(), { now: NOW }).agreement).toBe('awaiting');
  });

  it('ignores a run that finished before the claim was made', () => {
    const before = ran({ 'DG-02-01': 'fail' }, new Date(CLAIMED.getTime() - DAY_MS));

    expect(progressOf(offered(), before).agreement).toBe('awaiting');
  });

  it('judges the latest claim rather than the first, when an action was sent back and offered again', () => {
    // The run that contradicted the first attempt has already had its say. Judging against the first
    // claim would leave a re-offered action permanently contradicted by a run that predates the rework.
    const reoffered = offered({
      history: [
        claim(new Date('2026-06-02T00:00:00.000Z')),
        { from: 'ready-for-validation', to: 'in-progress', at: new Date('2026-06-05T00:00:00.000Z'), by: 'person', who: 'owner@example.com' },
        claim(new Date('2026-06-18T00:00:00.000Z')),
      ],
    });

    const between = ran({ 'DG-02-01': 'fail' }, new Date('2026-06-10T00:00:00.000Z'));

    expect(progressOf(reoffered, between).agreement).toBe('awaiting');
  });

  it('makes no claim for a cancelled action, however the requirement is now measured', () => {
    // A board that said "cancelled — agreed" would invite the reading that cancelling counts as fixing.
    const dropped = action({ state: 'cancelled', history: [claim()] });

    expect(progressOf(dropped, ran({ 'DG-02-01': 'pass' })).agreement).toBe('unclaimed');
  });
});

describe('an action raised from advice, which names no requirement', () => {
  /** The same action, with the four fields the record keeps of the finding it came from. */
  function fromAdvice(overrides: Partial<ImprovementAction> = {}): ImprovementAction {
    return offered({
      controlIds: [],
      advice: {
        advisoryId: 'adv-1',
        advisor: 'sizing',
        rule: 'WAREHOUSE_QUEUEING',
        versions: [{ name: 'rulesVersion', value: '1' }],
        resource: { kind: 'warehouse', id: 'wh-1', workspaceId: 'w1' },
        headline: 'Statements are queueing',
        detail: 'Work waited for a cluster more often than the ruleset allows.',
        docUrl: 'https://docs.databricks.com/warehouses',
        baseline: [],
        assumptions: [],
        measuredAt: CREATED,
        lookbackDays: 30,
      },
      ...overrides,
    });
  }

  it('is unjudged rather than agreed once a run has been taken', () => {
    // The defect this exists for: every branch below `awaiting` decides on the set of requirements the
    // action names, and the last of them answers `agreed` for an empty one. So an action about a
    // warehouse would have been verified by its owner saying so and a scan happening afterwards —
    // which is the single move `action.ts` is built to refuse.
    expect(progressOf(fromAdvice(), ran({ 'DG-02-01': 'pass' })).agreement).toBe('unjudged');
    expect(agreed(fromAdvice(), ran({ 'DG-02-01': 'pass' }))).toBe(false);
  });

  it('is unjudged whether or not a run has happened at all', () => {
    expect(progressOf(fromAdvice(), { now: NOW }).agreement).toBe('unjudged');
  });

  it('is unclaimed while nobody has said it is done, like any other action', () => {
    expect(progressOf(fromAdvice({ state: 'in-progress', history: [] }), ran({})).agreement).toBe('unclaimed');
  });

  it('is judged on its requirements where it names some as well as advice', () => {
    // Both is ordinary — a job with no isolation is an advisor finding and a requirement — and the
    // requirement is the half a run can speak to.
    const both = fromAdvice({ controlIds: ['DG-02-01'] });

    expect(progressOf(both, ran({ 'DG-02-01': 'fail' })).agreement).toBe('contradicted');
    expect(progressOf(both, ran({ 'DG-02-01': 'pass' })).agreement).toBe('agreed');
  });

  it('is still overdue when its date has passed, because lateness is not about the estate', () => {
    const late = fromAdvice({ due: new Date(NOW.getTime() - DAY_MS) });

    expect(progressOf(late, ran({})).lateness).toBe('overdue');
    expect(needsAttention(progressOf(late, ran({})))).toBe(true);
  });

  /** What a later advisory said, at whatever standing the case is about. */
  function read(standing: AdviceReading['standing'], at = new Date(CLAIMED.getTime() + DAY_MS)): AgreementContext {
    return {
      now: NOW,
      adviceReading: () => ({ advisoryId: 'adv-2', measuredAt: at, lookbackDays: 30, standing, movements: [], unmatched: [] }),
    };
  }

  it('is contradicted where the advisory still reports the rule that was raised against', () => {
    // The mapping is the assessment's own rather than a softer version of it: a rule that fired again
    // is the estate disagreeing with the claim, and it belongs on the board beside a failing
    // requirement rather than in a category of its own.
    expect(progressOf(fromAdvice(), read('still-firing')).agreement).toBe('contradicted');
  });

  it('is agreed where the advisory read the resource and did not report the rule', () => {
    expect(progressOf(fromAdvice(), read('cleared')).agreement).toBe('agreed');
    expect(agreed(fromAdvice(), read('cleared'))).toBe(true);
  });

  it('is unmeasured where the advisory could not speak to the resource at all', () => {
    // Each of these is a fact about the run rather than about the work: a ranked list the resource has
    // left, an analysis that did not form, a rule this build dropped.
    for (const standing of ['resource-absent', 'advisor-unread', 'rule-withdrawn', 'not-later'] as const) {
      expect(progressOf(fromAdvice(), read(standing)).agreement).toBe('unmeasured');
    }
  });

  it('is awaiting where the advisory finished before the work was claimed done', () => {
    // Only this knows the claim date: the reading knows whether the advisory is later than the advice,
    // which is a different question and one an advisory run in the middle of the work answers yes to.
    expect(progressOf(fromAdvice(), read('cleared', new Date(CLAIMED.getTime() - DAY_MS))).agreement).toBe('awaiting');
  });

  it('carries the reading beside the agreement even where a requirement decides it', () => {
    const both = fromAdvice({ controlIds: ['DG-02-01'] });
    const reading = progressOf(both, { ...ran({ 'DG-02-01': 'fail' }), ...read('cleared') });

    expect(reading.agreement).toBe('contradicted');
    expect(reading.advice?.standing).toBe('cleared');
  });
});

describe('whether an action is late', () => {
  it('is a separate reading from what the estate says, because the worst action is both', () => {
    const late = offered({ due: new Date(NOW.getTime() - DAY_MS) });

    const reading = progressOf(late, ran({ 'DG-02-01': 'fail' }));

    expect(reading.agreement).toBe('contradicted');
    expect(reading.lateness).toBe('overdue');
    expect(needsAttention(reading)).toBe(true);
  });

  it('warns before the date rather than after it, in a window an action can act on', () => {
    // A week rather than the thirty days an attestation renews inside. Three weeks out is `on-time`,
    // because an action planned three weeks ahead that reads as due on the day it was agreed teaches
    // the reader to ignore the badge.
    expect(progressOf(action({ state: 'planned', due: new Date(NOW.getTime() + 3 * DAY_MS) }), { now: NOW }).lateness).toBe(
      'due'
    );
    expect(
      progressOf(action({ state: 'planned', due: new Date(NOW.getTime() + 21 * DAY_MS) }), { now: NOW }).lateness
    ).toBe('on-time');
  });

  it('stops counting a finished action as late, whatever its date was', () => {
    const overdueAndDone = action({ state: 'verified', due: new Date(NOW.getTime() - 90 * DAY_MS) });

    expect(progressOf(overdueAndDone, { now: NOW }).lateness).toBe('undated');
  });

  it('has nothing to be late against on a draft with no date', () => {
    expect(progressOf(action({ due: undefined }), { now: NOW }).lateness).toBe('undated');
  });
});

describe('the plan rollup', () => {
  function of(state: ActionState, overrides: Partial<ImprovementAction> = {}): ImprovementAction {
    return action({ id: `action-${state}`, state, ...overrides });
  }

  it('counts every state, so nothing is a percentage of an unstated denominator', () => {
    const rollup = planProgress('plan-1', [of('draft'), of('planned'), of('verified'), of('verified')], { now: NOW });

    expect(rollup.states.verified).toBe(2);
    expect(rollup.states.draft).toBe(1);
    expect(rollup.states.cancelled).toBe(0);
  });

  it('names the actions worth reading about by id rather than counting them', () => {
    const contradicted = offered({ id: 'action-contradicted' });
    const late = of('in-progress', { id: 'action-late', due: new Date(NOW.getTime() - DAY_MS) });

    const rollup = planProgress('plan-1', [contradicted, late, of('blocked')], ran({ 'DG-02-01': 'fail' }));

    expect(rollup.contradicted).toEqual(['action-contradicted']);
    expect(rollup.overdue).toEqual(['action-late']);
    expect(rollup.blocked).toEqual(['action-blocked']);
  });

  it('ignores actions belonging to another plan', () => {
    const rollup = planProgress('plan-1', [of('draft'), action({ id: 'elsewhere', planId: 'plan-2' })], { now: NOW });

    expect(rollup.states.draft).toBe(1);
  });

  it('reports settled rather than finished, because a plan of cancelled actions achieved nothing', () => {
    const nothingHappened = planProgress('plan-1', [of('cancelled'), of('cancelled')], { now: NOW });

    expect(nothingHappened.settled).toBe(true);
    expect(nothingHappened.states.verified).toBe(0);
  });

  it('takes the nearest date from the actions that are still live', () => {
    const soon = new Date(NOW.getTime() + 2 * DAY_MS);
    const rollup = planProgress(
      'plan-1',
      [
        of('planned', { id: 'a', due: new Date(NOW.getTime() + 20 * DAY_MS) }),
        of('in-progress', { id: 'b', due: soon }),
        // A verified action's date is not the plan's next date, however early it was.
        of('verified', { id: 'c', due: new Date(NOW.getTime() - 40 * DAY_MS) }),
      ],
      { now: NOW }
    );

    expect(rollup.nextDue).toEqual(soon);
  });

  it('has no next date when nothing live carries one', () => {
    expect(planProgress('plan-1', [of('draft', { due: undefined })], { now: NOW }).nextDue).toBeUndefined();
  });
});
