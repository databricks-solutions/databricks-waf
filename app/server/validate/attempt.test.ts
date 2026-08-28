import { describe, expect, it } from 'vitest';
import type { ImprovementAction, Transition } from '../improve/action.js';
import {
  InvalidAttemptError,
  MAX_OBSERVE_DAYS,
  abandoned,
  answerable,
  answeredBy,
  claimedAtOf,
  draftFrom,
  methodFor,
  newestFirst,
  outstandingIn,
  requested,
  verifies,
  whyNotRequestable,
  type Observation,
  type RunReading,
  type ValidationAttempt,
} from './attempt.js';

const CLAIMED = new Date('2026-06-01T09:00:00.000Z');
const REQUESTED = new Date('2026-06-01T10:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function action(over: Partial<ImprovementAction> = {}): ImprovementAction {
  const history: Transition[] = [
    { from: 'draft', to: 'planned', at: new Date('2026-05-01T09:00:00.000Z'), by: 'person', who: 'ana' },
    { from: 'planned', to: 'in-progress', at: new Date('2026-05-02T09:00:00.000Z'), by: 'person', who: 'ana' },
    { from: 'in-progress', to: 'ready-for-validation', at: CLAIMED, by: 'person', who: 'ana' },
  ];

  return {
    id: 'action-1',
    planId: 'plan-1',
    controlIds: ['DG-01-01'],
    outcome: 'Every catalogue is governed by Unity Catalog.',
    definitionOfDone: 'No table outside Unity Catalog in the production account.',
    owner: 'ana@example.com',
    priority: 'now',
    effort: 'medium',
    steps: [],
    dependsOn: [],
    state: 'ready-for-validation',
    createdBy: 'ana@example.com',
    createdAt: new Date('2026-05-01T09:00:00.000Z'),
    history,
    revision: 3,
    ...over,
  };
}

/** Everything measurable unless a test says otherwise. */
const measured = { measurabilityOf: () => 'system-table' as const, existing: [] };
const attested = { measurabilityOf: () => 'attestation' as const, existing: [] };

function attempt(over: Partial<ValidationAttempt> = {}): ValidationAttempt {
  return {
    ...requested(draftFrom(action(), {}, measured), 'ana@example.com', 'attempt-1', REQUESTED),
    ...over,
  };
}

function run(observations: readonly Observation[], measuredAt = new Date('2026-06-02T10:00:00.000Z')): RunReading {
  return { scanId: 'scan-9', measuredAt, observations };
}

describe('which method answers a requirement', () => {
  it('is somebody’s word only where the catalogue says nothing can read it', () => {
    expect(methodFor('attestation')).toBe('attested');
    expect(methodFor('system-table')).toBe('measured');
    expect(methodFor('rest-api')).toBe('measured');
    expect(methodFor('cloud-api')).toBe('measured');
    expect(methodFor('derived')).toBe('measured');
  });

  it('is taken from the catalogue rather than from the request', () => {
    // The whole point: a requester who could choose could validate a measurable requirement by
    // attesting to it, which is the defect one layer below the one this record closes.
    const draft = draftFrom(action(), { method: 'attested', checks: ['anything'] }, measured);

    expect(draft.checks).toEqual([{ controlId: 'DG-01-01', method: 'measured' }]);
  });
});

describe('asking for a validation', () => {
  it('takes the claim date from the action’s history', () => {
    expect(draftFrom(action(), {}, measured).claimedAt).toEqual(CLAIMED);
  });

  it('takes the last claim, because an action offered again makes a new one', () => {
    const again = new Date('2026-06-10T09:00:00.000Z');
    const offered = action({
      history: [
        ...action().history,
        { from: 'ready-for-validation', to: 'in-progress', at: new Date('2026-06-05T09:00:00.000Z'), by: 'person', who: 'ana' },
        { from: 'in-progress', to: 'ready-for-validation', at: again, by: 'person', who: 'ana' },
      ],
    });

    expect(claimedAtOf(offered)).toEqual(again);
    expect(draftFrom(offered, {}, measured).claimedAt).toEqual(again);
  });

  it('refuses an action whose owner has not said the work is done', () => {
    expect(() => draftFrom(action({ state: 'in-progress' }), {}, measured)).toThrow(
      /has not said it is finished/
    );
  });

  it('refuses one that has already been verified, and says so rather than repeating itself', () => {
    expect(() => draftFrom(action({ state: 'verified' }), {}, measured)).toThrow(/already been verified/);
  });

  it('refuses a second while one is outstanding, because one run would answer both', () => {
    expect(() => draftFrom(action(), {}, { ...measured, existing: [attempt()] })).toThrow(/already outstanding/);
  });

  it('permits another once the last one was answered', () => {
    const failed = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'fail' }]));

    expect(() => draftFrom(action(), {}, { ...measured, existing: [failed] })).not.toThrow();
  });

  it('refuses a requirement the catalogue no longer has, naming what to do instead', () => {
    expect(() => draftFrom(action(), {}, { measurabilityOf: () => undefined, existing: [] })).toThrow(
      /cancel the action/
    );
  });

  it('refuses an action claiming to be ready with no claim in its history', () => {
    // Only reachable through a record written by something other than `moved`. Refused rather than
    // dated now, because an attempt measured against this moment accepts any run and any attestation.
    expect(() => draftFrom(action({ history: [] }), {}, measured)).toThrow(/does not record when that was claimed/);
  });
});

describe('an action no requirement covers', () => {
  /*
   * An action raised from an advisor finding names a warehouse or a job, and the framework has no
   * requirement that fails for either. The route matters because `answeredBy` computes `passed` from
   * "nothing unmet and nothing unreadable", and an attempt with no checks satisfies both: without the
   * refusal, asking for a validation would write the action `verified` off a run that read nothing
   * about it. `progress.ts` calls the same action `unjudged`, and this is the other door into it.
   */
  it('cannot be offered for validation at all', () => {
    const refusal = whyNotRequestable(action({ controlIds: [] }), measured);

    expect(refusal).toContain('names no requirement');
    expect(() => draftFrom(action({ controlIds: [] }), {}, measured)).toThrow(InvalidAttemptError);
  });

  it('is not answered as passed if an attempt with no checks reaches the answer', () => {
    const empty = { ...attempt(), checks: [] };

    expect(() =>
      answeredBy(empty, { scanId: 'scan-1', measuredAt: new Date(REQUESTED.getTime() + DAY_MS), observations: [] })
    ).toThrow(/nothing to measure/);
  });
});

describe('the observation window', () => {
  it('is nothing by default, so the next run after the claim can answer', () => {
    const asked = attempt();

    expect(asked.observeDays).toBe(0);
    expect(asked.observeFrom).toEqual(REQUESTED);
  });

  it('is the days asked for, from the request', () => {
    const asked = requested(draftFrom(action(), { observeDays: 3 }, measured), 'ana', 'attempt-2', REQUESTED);

    expect(asked.observeDays).toBe(3);
    expect(asked.observeFrom).toEqual(new Date(REQUESTED.getTime() + 3 * DAY_MS));
  });

  it('refuses a negative window, a fractional one and one beyond the cap', () => {
    expect(() => draftFrom(action(), { observeDays: -1 }, measured)).toThrow(/cannot be negative/);
    expect(() => draftFrom(action(), { observeDays: 1.5 }, measured)).toThrow(/whole number of days/);
    expect(() => draftFrom(action(), { observeDays: MAX_OBSERVE_DAYS + 1 }, measured)).toThrow(
      new RegExp(String(MAX_OBSERVE_DAYS))
    );
  });

  it('holds off a run inside the window, which is what the window is for', () => {
    const waiting = requested(draftFrom(action(), { observeDays: 7 }, measured), 'ana', 'attempt-3', REQUESTED);
    const early = { measuredAt: new Date(REQUESTED.getTime() + 2 * DAY_MS) };

    expect(answerable(waiting, early)).toBe(false);
    expect(answerable(waiting, { measuredAt: new Date(REQUESTED.getTime() + 7 * DAY_MS) })).toBe(true);
  });

  it('holds off a run that finished before the claim, whatever the window says', () => {
    // A run before the claim measured a half-finished change. Reading it as a failed validation is how
    // a correct fix gets reported as one that did not take.
    expect(answerable(attempt(), { measuredAt: new Date('2026-05-30T10:00:00.000Z') })).toBe(false);
  });

  it('is closed to a run once something has answered it', () => {
    const answered = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'pass' }]));

    expect(answerable(answered, { measuredAt: new Date('2026-06-03T10:00:00.000Z') })).toBe(false);
  });
});

describe('answering it', () => {
  it('passes when every requirement was met after the claim', () => {
    const answered = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'pass' }]));

    expect(answered.answer).toMatchObject({ result: 'passed', scanId: 'scan-9', unmet: [], unreadable: [] });
    expect(answered.answer?.why).toBeUndefined();
    expect(verifies(answered)).toBe(true);
  });

  it('counts architecture and non-applicability as met, like every other reading here', () => {
    const two = attempt({
      checks: [
        { controlId: 'A', method: 'measured' },
        { controlId: 'B', method: 'measured' },
      ],
    });
    const answered = answeredBy(
      two,
      run([
        { controlId: 'A', outcome: 'satisfied-by-architecture' },
        { controlId: 'B', outcome: 'not-applicable' },
      ])
    );

    expect(answered.answer?.result).toBe('passed');
  });

  it('fails when one is still unmet, and names which', () => {
    const two = attempt({
      checks: [
        { controlId: 'A', method: 'measured' },
        { controlId: 'B', method: 'measured' },
      ],
    });
    const answered = answeredBy(
      two,
      run([
        { controlId: 'A', outcome: 'pass' },
        { controlId: 'B', outcome: 'partial' },
      ])
    );

    expect(answered.answer).toMatchObject({ result: 'failed', unmet: ['B'] });
    expect(verifies(answered)).toBe(false);
  });

  it('puts the unmet news above the bookkeeping when both are true', () => {
    const two = attempt({
      checks: [
        { controlId: 'A', method: 'measured' },
        { controlId: 'B', method: 'measured' },
      ],
    });
    const answered = answeredBy(
      two,
      run([
        { controlId: 'A', outcome: 'fail' },
        { controlId: 'B', outcome: 'unmeasurable' },
      ])
    );

    expect(answered.answer?.result).toBe('failed');
    expect(answered.answer?.unmet).toEqual(['A']);
    expect(answered.answer?.unreadable).toEqual(['B']);
  });

  it('is incomplete, not passed, when the run could not read one', () => {
    const answered = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'unmeasurable' }]));

    expect(answered.answer?.result).toBe('incomplete');
    expect(answered.answer?.why).toContain('could not read');
    expect(verifies(answered)).toBe(false);
  });

  it('is incomplete when the run did not measure the requirement at all', () => {
    const answered = answeredBy(attempt(), run([]));

    expect(answered.answer).toMatchObject({ result: 'incomplete', unreadable: ['DG-01-01'] });
  });

  it('refuses to answer twice', () => {
    const answered = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'pass' }]));

    expect(() => answeredBy(answered, run([{ controlId: 'DG-01-01', outcome: 'fail' }]))).toThrow(
      InvalidAttemptError
    );
  });

  it('refuses a run that is not allowed to answer, naming both dates', () => {
    expect(() => answeredBy(attempt(), run([], new Date('2026-05-30T10:00:00.000Z')))).toThrow(
      /before this validation can be answered/
    );
  });
});

describe('a requirement only somebody can answer', () => {
  const human = (): ValidationAttempt =>
    requested(draftFrom(action(), {}, attested), 'ana@example.com', 'attempt-h', REQUESTED);

  it('is not verified by an answer given before the work was claimed', () => {
    // The defect AUD-DEC-107 is about: the run agrees, on the strength of an attestation from March,
    // with a fix claimed in June.
    const answered = answeredBy(
      human(),
      run([{ controlId: 'DG-01-01', outcome: 'pass', attestedAt: new Date('2026-03-01T09:00:00.000Z') }])
    );

    expect(answered.answer?.result).toBe('incomplete');
    expect(answered.answer?.unreadable).toEqual(['DG-01-01']);
    expect(answered.answer?.why).toContain('attest to it again');
  });

  it('is verified by an answer given after it', () => {
    const answered = answeredBy(
      human(),
      run([{ controlId: 'DG-01-01', outcome: 'pass', attestedAt: new Date('2026-06-01T15:00:00.000Z') }])
    );

    expect(answered.answer?.result).toBe('passed');
  });

  it('is verified where the app measured it after all, since no answer carried the outcome', () => {
    // An attestation-only requirement whose finding carries no attested date was not decided by
    // somebody's word — the app measured it, or the answer sits beside a measurement. Refusing that
    // would be refusing the stronger evidence.
    const answered = answeredBy(human(), run([{ controlId: 'DG-01-01', outcome: 'pass' }]));

    expect(answered.answer?.result).toBe('passed');
  });

  it('says which requirements need answering again and which could not be read, separately', () => {
    const mixed = attempt({
      checks: [
        { controlId: 'READ', method: 'measured' },
        { controlId: 'SAY', method: 'attested' },
      ],
    });
    const answered = answeredBy(
      mixed,
      run([
        { controlId: 'READ', outcome: 'unmeasurable' },
        { controlId: 'SAY', outcome: 'pass', attestedAt: new Date('2026-01-01T09:00:00.000Z') },
      ])
    );

    expect(answered.answer?.why).toContain('could not read READ');
    expect(answered.answer?.why).toContain('SAY');
    expect(answered.answer?.why).toContain('attest to it again');
  });
});

describe('a claim taken back', () => {
  it('closes the attempt as incomplete rather than leaving it waiting for ever', () => {
    const gone = abandoned(attempt(), 'The owner withdrew the claim on 2026-06-03.', new Date('2026-06-03T09:00:00.000Z'));

    expect(gone.answer).toMatchObject({ result: 'incomplete', unmet: [] });
    expect(gone.answer?.scanId).toBeUndefined();
    expect(gone.answer?.why).toContain('withdrew');
    expect(verifies(gone)).toBe(false);
  });

  it('cannot rewrite an answer that already cites a run', () => {
    const answered = answeredBy(attempt(), run([{ controlId: 'DG-01-01', outcome: 'pass' }]));

    expect(() => abandoned(answered, 'too late', new Date())).toThrow(InvalidAttemptError);
  });
});

describe('reading a set of attempts', () => {
  it('finds the outstanding one, and nothing when they are all answered', () => {
    const open = attempt({ id: 'open' });
    const done = answeredBy(attempt({ id: 'done' }), run([{ controlId: 'DG-01-01', outcome: 'fail' }]));

    expect(outstandingIn([done, open])?.id).toBe('open');
    expect(outstandingIn([done])).toBeUndefined();
  });

  it('orders them newest first, because the last attempt is the one being read', () => {
    const first = attempt({ id: 'first', requestedAt: REQUESTED });
    const second = attempt({ id: 'second', requestedAt: new Date(REQUESTED.getTime() + DAY_MS) });

    expect(newestFirst([first, second]).map((one) => one.id)).toEqual(['second', 'first']);
  });
});
