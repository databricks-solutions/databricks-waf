// The only path that reaches `verified`.
//
// `attempt.test.ts` holds the rules about what a run may answer and what an answer says. What is tested
// here is the joining-up: that a passed attempt moves the action and nothing else does, that a run
// which is not entitled to answer leaves the attempt where it was, and that a pass which cannot be
// written down does not leave the action claiming a verification the record cannot support.
//
// Every test drives it the way the app does — a saved scan and a store — rather than calling the inner
// functions, because the defects this module exists to prevent all live in the joins.

import { describe, expect, it } from 'vitest';
import { CollectionScheduler } from '../scan/scheduler.js';
import { moved, verifiedBy, type ActionState, type ImprovementAction } from '../improve/action.js';
import type { ImprovementPlan } from '../improve/plan.js';
import { ConcurrentChangeError, InMemoryImprovementStore, type ImprovementStore } from '../improve/store.js';
import type { AttestedFact, Finding, Outcome } from '../resolve/finding.js';
import type { Scan } from '../scan/scan.js';
import { COMPLETE } from '../collect/signal.js';
import { requested, type AttemptDraft, type ValidationAttempt } from './attempt.js';
import { resolveValidations } from './resolve.js';
import { AlreadyAnsweredError, InMemoryValidationStore, type ValidationStore } from './store.js';

const OPENED = new Date('2026-08-01T09:00:00.000Z');
const CLAIMED = new Date('2026-08-03T09:00:00.000Z');
const REQUESTED = new Date('2026-08-03T10:00:00.000Z');
const MEASURED = new Date('2026-08-04T09:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

const PILLAR = 'data-and-ai-governance';
const OTHER_PILLAR = 'security-compliance-and-privacy';

function plan(): ImprovementPlan {
  return {
    id: 'plan-1',
    title: 'Q3 governance',
    outcome: 'Every production table has a named owner and an access review behind it.',
    owners: ['priya@example.com'],
    createdBy: 'priya@example.com',
    createdAt: OPENED,
    revision: 0,
  };
}

/** An action claimed done at `CLAIMED`, or left in whatever state a test names. */
function action(over: { readonly to?: ActionState; readonly controlIds?: readonly string[] } = {}): ImprovementAction {
  const who = 'sam@example.com';
  const draft: ImprovementAction = {
    id: 'action-1',
    planId: 'plan-1',
    controlIds: over.controlIds ?? ['DG-01-01'],
    outcome: 'Ownership is assigned on every production table, so an access review has somebody to ask.',
    definitionOfDone: 'Every table in the prod catalogue has an owner recorded, checked by the ownership query.',
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
  };
  if (over.to === 'draft') return draft;

  let walked = moved(draft, { to: 'planned', who, at: OPENED });
  walked = moved(walked, { to: 'in-progress', who, at: OPENED });
  walked = moved(walked, { to: 'ready-for-validation', who, at: CLAIMED });
  return over.to == null || over.to === 'ready-for-validation'
    ? walked
    : moved(walked, { to: over.to, who, at: REQUESTED, reason: 'the change did not land where we expected it to' });
}

function attempt(
  over: { readonly observeDays?: number; readonly claimedAt?: Date; readonly controlIds?: readonly string[] } = {}
): ValidationAttempt {
  const draft: AttemptDraft = {
    planId: 'plan-1',
    actionId: 'action-1',
    checks: (over.controlIds ?? ['DG-01-01']).map((controlId) => ({ controlId, method: 'measured' as const })),
    claimedAt: over.claimedAt ?? CLAIMED,
    observeDays: over.observeDays ?? 0,
  };
  return requested(draft, 'priya@example.com', 'validation-1', REQUESTED);
}

interface RunSpec {
  readonly outcomes?: Readonly<Record<string, Outcome>>;
  readonly finishedAt?: Date;
  /** Pillars this run carried forward from an earlier one, as a targeted rerun does. */
  readonly carried?: readonly string[];
  readonly pillarOf?: Readonly<Record<string, string>>;
  readonly attested?: Readonly<Record<string, AttestedFact>>;
}

function scan(spec: RunSpec = {}): Scan {
  const outcomes = spec.outcomes ?? { 'DG-01-01': 'pass' };
  const finishedAt = spec.finishedAt ?? MEASURED;
  const findings: Finding[] = Object.entries(outcomes).map(([controlId, outcome]) => ({
    controlId,
    pillarId: spec.pillarOf?.[controlId] ?? PILLAR,
    principleId: 'unify',
    title: controlId,
    outcome,
    severity: 'high',
    coverage: COMPLETE,
    evidence: [],
    ...(spec.attested?.[controlId] != null ? { attested: spec.attested[controlId] } : {}),
  }));

  return {
    id: 'run-1',
    startedAt: new Date(finishedAt.getTime() - 60_000),
    finishedAt,
    state: 'complete',
    stamp: {
      catalogueVersion: '10',
      catalogueFingerprint: 'sha256:abc',
      executionMode: 'on-behalf-of-user',
      actor: 'priya@example.com',
      scope: { description: 'the account' },
      lookbackDays: 30,
    },
    score: {
      pillars: [],
      counts: { pass: 0, fail: 0, partial: 0, unmeasurable: 0, 'not-applicable': 0, 'satisfied-by-architecture': 0 },
      scoredControls: 0,
      composition: { observed: 0, 'admin-collected': 0, attested: 0 },
      totalControls: 0,
      overall: 0,
    },
    findings,
    signals: [],
    estate: { assessed: [], excluded: [] },
    measurement: [...new Set(findings.map((finding) => finding.pillarId))].map((pillarId) => ({
      pillarId,
      scanId: 'run-1',
      measuredAt: finishedAt,
      actor: 'priya@example.com',
      carriedForward: spec.carried?.includes(pillarId) ?? false,
    })),
    footprint: new CollectionScheduler().footprint(),
    spend: [],
  };
}

interface Harness {
  readonly validations: ValidationStore;
  readonly improvements: ImprovementStore;
  readonly errors: readonly string[];
  readonly options: Parameters<typeof resolveValidations>[1];
}

async function harness(
  over: {
    readonly action?: ImprovementAction | null;
    readonly attempts?: readonly ValidationAttempt[];
    readonly validations?: ValidationStore;
    readonly improvements?: ImprovementStore;
    readonly withPlan?: boolean;
  } = {}
): Promise<Harness> {
  const improvements = over.improvements ?? new InMemoryImprovementStore();
  const held = over.action === undefined ? action() : over.action;
  if (held != null) {
    if (over.withPlan !== false) await improvements.addPlan(plan());
    await improvements.addAction(held, plan());
  }

  const validations = over.validations ?? new InMemoryValidationStore();
  for (const one of over.attempts ?? [attempt()]) await validations.add(one);

  const errors: string[] = [];
  return {
    validations,
    improvements,
    errors,
    options: {
      validations,
      improvements,
      onError: (operation: string) => {
        errors.push(operation);
      },
    },
  };
}

async function stateOf(improvements: ImprovementStore): Promise<string | undefined> {
  return (await improvements.action('action-1'))?.state;
}

async function answerOf(validations: ValidationStore): Promise<ValidationAttempt['answer']> {
  return (await validations.for('action-1'))[0]?.answer;
}

describe('a run that agrees with the claim', () => {
  it('answers the attempt and marks the action verified by that run', async () => {
    const held = await harness();

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ answered: 1, verified: 1, failed: 0, incomplete: 0, waiting: 0 });
    expect(await answerOf(held.validations)).toMatchObject({ result: 'passed', scanId: 'run-1', at: MEASURED });
    const verified = await held.improvements.action('action-1');
    expect(verified?.state).toBe('verified');
    // The run is on the transition as well as on the attempt, so a verification can be checked from
    // either end without the reader having to join them.
    expect(verified?.history.at(-1)).toMatchObject({ to: 'verified', by: 'run', who: 'run-1' });
    expect(held.errors).toEqual([]);
  });

  it('leaves nothing outstanding, so the next run has nothing to answer', async () => {
    const held = await harness();
    await resolveValidations(scan(), held.options);

    const again = await resolveValidations(scan({ finishedAt: new Date(MEASURED.getTime() + DAY_MS) }), held.options);

    expect(again).toMatchObject({ answered: 0, verified: 0, waiting: 0 });
  });

  it('answers each of several attempts on its own, across actions', async () => {
    const second: ValidationAttempt = { ...attempt(), id: 'validation-2', actionId: 'action-2' };
    const held = await harness({ attempts: [attempt(), second] });

    const resolution = await resolveValidations(scan(), held.options);

    // The second names an action that is not in the store, so it is closed rather than left waiting on
    // a run that could never answer it — and the first is answered regardless.
    expect(resolution).toMatchObject({ answered: 1, verified: 1, withdrawn: 1 });
    expect(await stateOf(held.improvements)).toBe('verified');
  });
});

describe('a run that contradicts the claim', () => {
  it('records the failure with the requirement that was still unmet, and leaves the action claimed', async () => {
    const held = await harness();

    const resolution = await resolveValidations(scan({ outcomes: { 'DG-01-01': 'fail' } }), held.options);

    expect(resolution).toMatchObject({ answered: 1, failed: 1, verified: 0 });
    expect(await answerOf(held.validations)).toMatchObject({ result: 'failed', unmet: ['DG-01-01'] });
    // Sending the work back is the owner's move to make, and doing it here would move an action from a
    // path with no person in it. The failed attempt is what tells them.
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('records an unreadable requirement as incomplete rather than as a failure', async () => {
    const held = await harness();

    const resolution = await resolveValidations(scan({ outcomes: { 'DG-01-01': 'unmeasurable' } }), held.options);

    expect(resolution).toMatchObject({ answered: 1, incomplete: 1, failed: 0, verified: 0 });
    expect(await answerOf(held.validations)).toMatchObject({ result: 'incomplete', unreadable: ['DG-01-01'] });
  });

  it('does not verify on human evidence that predates the claim', async () => {
    // The reason the freshness rule exists: the run reports the requirement met because an attestation
    // says so, and the attestation was given before the work it is being read as evidence of.
    const held = await harness({ attempts: [{ ...attempt(), checks: [{ controlId: 'DG-01-01', method: 'attested' }] }] });

    const resolution = await resolveValidations(
      scan({
        attested: {
          'DG-01-01': {
            bearing: 'outcome',
            by: 'sam@example.com',
            at: new Date(CLAIMED.getTime() - DAY_MS),
            statement: 'Ownership is reviewed quarterly by the platform team.',
            owner: 'sam@example.com',
            reviewBy: new Date(MEASURED.getTime() + 90 * DAY_MS),
          },
        },
      }),
      held.options
    );

    expect(resolution).toMatchObject({ answered: 1, incomplete: 1, verified: 0 });
    expect((await answerOf(held.validations))?.why).toContain('attest to it again');
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('verifies on human evidence given after the claim', async () => {
    const held = await harness({ attempts: [{ ...attempt(), checks: [{ controlId: 'DG-01-01', method: 'attested' }] }] });

    const resolution = await resolveValidations(
      scan({
        attested: {
          'DG-01-01': {
            bearing: 'outcome',
            by: 'sam@example.com',
            at: new Date(CLAIMED.getTime() + 60_000),
            statement: 'Ownership is now recorded on every table in the prod catalogue.',
            owner: 'sam@example.com',
            reviewBy: new Date(MEASURED.getTime() + 90 * DAY_MS),
          },
        },
      }),
      held.options
    );

    expect(resolution).toMatchObject({ verified: 1 });
    expect(await stateOf(held.improvements)).toBe('verified');
  });
});

describe('an attempt with no requirements under it', () => {
  /*
   * Nothing this app writes produces one: an action raised from advisor advice names no requirement,
   * and `whyNotRequestable` refuses a validation of it. The record is still worth a test, because the
   * two ways of getting this wrong are the two worst outcomes in this module. Answering it would read
   * "nothing unmet, nothing unreadable" as a pass and write the action verified off a run that
   * measured nothing about it. Leaving it alone would have every later run pick it up, fail on it and
   * report it again.
   */
  it('is closed with a reason rather than answered, and leaves the action where it was', async () => {
    const held = await harness({ attempts: [{ ...attempt(), checks: [] }] });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution.withdrawn).toBe(1);
    expect(resolution.verified).toBe(0);
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
    // `abandoned` closes an attempt as incomplete, which is what every other closure here reads as:
    // nothing was measured, and the reason says why nothing could be.
    expect((await answerOf(held.validations))?.result).toBe('incomplete');
    expect((await answerOf(held.validations))?.why).toContain('names no requirement');
  });

  it('is not picked up again by the next run, and reports no error', async () => {
    const held = await harness({ attempts: [{ ...attempt(), checks: [] }] });
    await resolveValidations(scan(), held.options);

    const again = await resolveValidations(scan({ finishedAt: new Date(MEASURED.getTime() + DAY_MS) }), held.options);

    expect(again).toMatchObject({ withdrawn: 0, waiting: 0, answered: 0 });
    expect(held.errors).toEqual([]);
  });
});

describe('a run that is not entitled to answer', () => {
  it('leaves an attempt whose observation window has not passed outstanding', async () => {
    const held = await harness({ attempts: [attempt({ observeDays: 7 })] });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ answered: 0, waiting: 1 });
    expect(await answerOf(held.validations)).toBeUndefined();
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('answers it once a run finishes after the window', async () => {
    const held = await harness({ attempts: [attempt({ observeDays: 3 })] });
    await resolveValidations(scan(), held.options);

    const later = await resolveValidations(scan({ finishedAt: new Date(REQUESTED.getTime() + 4 * DAY_MS) }), held.options);

    expect(later).toMatchObject({ verified: 1 });
  });

  it('leaves it outstanding when the pillar was carried forward rather than measured', async () => {
    // The defect this is here to stop: a targeted rerun of an unrelated pillar carries this one forward
    // from last Tuesday, and reading last Tuesday's finding as this run's answer would verify a claim
    // nothing has measured since it was made.
    const held = await harness();

    const resolution = await resolveValidations(scan({ carried: [PILLAR] }), held.options);

    expect(resolution).toMatchObject({ answered: 0, waiting: 1 });
    expect(await answerOf(held.validations)).toBeUndefined();
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('answers when the pillar it needs was measured and another was carried forward', async () => {
    const held = await harness();

    const resolution = await resolveValidations(
      scan({
        outcomes: { 'DG-01-01': 'pass', 'SEC-02-04': 'fail' },
        pillarOf: { 'SEC-02-04': OTHER_PILLAR },
        carried: [OTHER_PILLAR],
      }),
      held.options
    );

    expect(resolution).toMatchObject({ verified: 1 });
  });

  it('waits for a run that measures every requirement in the attempt, not some of them', async () => {
    const held = await harness({
      action: action({ controlIds: ['DG-01-01', 'SEC-02-04'] }),
      attempts: [attempt({ controlIds: ['DG-01-01', 'SEC-02-04'] })],
    });

    const resolution = await resolveValidations(
      scan({
        outcomes: { 'DG-01-01': 'pass', 'SEC-02-04': 'pass' },
        pillarOf: { 'SEC-02-04': OTHER_PILLAR },
        carried: [OTHER_PILLAR],
      }),
      held.options
    );

    expect(resolution).toMatchObject({ answered: 0, waiting: 1 });
  });

  it('answers a requirement this build produced no finding for rather than waiting for ever', async () => {
    const held = await harness();

    const resolution = await resolveValidations(scan({ outcomes: { 'SEC-02-04': 'pass' } }), held.options);

    expect(resolution).toMatchObject({ answered: 1, incomplete: 1 });
    expect((await answerOf(held.validations))?.unreadable).toEqual(['DG-01-01']);
  });
});

describe('a claim that has moved on', () => {
  it('closes the attempt when the owner took the work back', async () => {
    const held = await harness({ action: action({ to: 'in-progress' }) });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ withdrawn: 1, answered: 0, verified: 0 });
    const answer = await answerOf(held.validations);
    expect(answer).toMatchObject({ result: 'incomplete' });
    expect(answer?.scanId).toBeUndefined();
    expect(answer?.why).toContain('withdrawn');
    expect(await stateOf(held.improvements)).toBe('in-progress');
  });

  it('closes an attempt about an earlier claim rather than answering it with this run', async () => {
    // Taken back and offered again is a new claim. Answering the old attempt would date the evidence
    // against a claim nobody is making any more, which is the whole of what `claimedAt` is for.
    const reclaimed = moved(
      moved(action(), { to: 'in-progress', who: 'sam@example.com', at: REQUESTED }),
      { to: 'ready-for-validation', who: 'sam@example.com', at: new Date(REQUESTED.getTime() + 60_000) }
    );
    const held = await harness({ action: reclaimed });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ withdrawn: 1, verified: 0 });
    expect((await answerOf(held.validations))?.why).toContain('claimed done again');
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('closes an attempt whose action is no longer in the record', async () => {
    const held = await harness({ action: null });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ withdrawn: 1 });
    expect((await answerOf(held.validations))?.why).toContain('no longer in the record');
  });

  it('does not verify an action that has already been verified', async () => {
    const already = verifiedBy(action(), 'run-0', new Date(CLAIMED.getTime() + 60_000));
    const held = await harness({ action: already });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ withdrawn: 1, verified: 0 });
    expect((await held.improvements.action('action-1'))?.history.at(-1)).toMatchObject({ who: 'run-0' });
  });
});

describe('when something else is writing at the same time', () => {
  it('treats an attempt answered by another instance as that instance’s success', async () => {
    class Lost extends InMemoryValidationStore {
      override answer(): Promise<void> {
        return Promise.reject(new AlreadyAnsweredError('validation-1'));
      }
    }
    const held = await harness({ validations: new Lost() });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ answered: 0, verified: 0, waiting: 1 });
    // Nothing reported: the other instance verified the same action from the same run, so there is no
    // failure here to tell anybody about.
    expect(held.errors).toEqual([]);
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('retries the verification once when somebody wrote the action meanwhile', async () => {
    class Racing extends InMemoryImprovementStore {
      private first = true;

      override async changeAction(...args: Parameters<ImprovementStore['changeAction']>): Promise<void> {
        if (!this.first) return super.changeAction(...args);
        this.first = false;
        // The competing write the retry has to survive: somebody correcting the owner while this pass
        // was composing its verification. A new revision of the same action, still claimed done.
        const current = (await super.action(args[0].id)) as ImprovementAction;
        await super.changeAction({ ...current, owner: 'dana@example.com', revision: current.revision + 1 }, args[1]);
        throw new ConcurrentChangeError('action', args[0].id);
      }
    }
    const held = await harness({ improvements: new Racing() });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ verified: 1 });
    expect(await stateOf(held.improvements)).toBe('verified');
    expect(held.errors).toEqual([]);
  });

  it('reports a verification it could not write and leaves the passed attempt on the record', async () => {
    class Refusing extends InMemoryImprovementStore {
      override changeAction(): Promise<void> {
        return Promise.reject(new ConcurrentChangeError('action', 'action-1'));
      }
    }
    const held = await harness({ improvements: new Refusing() });

    const resolution = await resolveValidations(scan(), held.options);

    // The attempt is answered and the action is not verified, which is visible rather than silent: it
    // is counted as stalled, the pass is on the record, and the way out is to ask for another
    // validation, which nothing is outstanding to stop.
    expect(resolution).toMatchObject({ answered: 1, stalled: 1, verified: 0, waiting: 0 });
    expect(await answerOf(held.validations)).toMatchObject({ result: 'passed' });
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
    expect(held.errors).toEqual(['verify action action-1']);
  });
});

describe('when the records cannot be read', () => {
  it('answers nothing and says so, rather than failing the scan that had just been saved', async () => {
    class Unreadable extends InMemoryValidationStore {
      override outstanding(): Promise<readonly ValidationAttempt[]> {
        return Promise.reject(new Error('the database is not answering'));
      }
    }
    const held = await harness({ validations: new Unreadable() });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toEqual({
      answered: 0,
      verified: 0,
      failed: 0,
      incomplete: 0,
      stalled: 0,
      withdrawn: 0,
      waiting: 0,
    });
    expect(held.errors).toEqual(['read the validations waiting on a run']);
  });

  it('does not read the actions at all when nothing is waiting', async () => {
    let reads = 0;
    class Counting extends InMemoryImprovementStore {
      override action(id: string): Promise<ImprovementAction | undefined> {
        reads += 1;
        return super.action(id);
      }
    }
    const held = await harness({ attempts: [], improvements: new Counting() });

    expect(await resolveValidations(scan(), held.options)).toMatchObject({ answered: 0, waiting: 0 });
    expect(reads).toBe(0);
  });

  it('reports an action whose plan is missing rather than inventing one to write against', async () => {
    const held = await harness({ withPlan: false });

    const resolution = await resolveValidations(scan(), held.options);

    expect(resolution).toMatchObject({ answered: 1, verified: 0, stalled: 1 });
    expect(held.errors).toEqual(['verify action action-1']);
    expect(await stateOf(held.improvements)).toBe('ready-for-validation');
  });

  it('counts every answer under exactly one outcome, so a log line of it adds up', async () => {
    const held = await harness({
      attempts: [attempt(), { ...attempt(), id: 'validation-2', actionId: 'action-2' }, attempt({ observeDays: 7 })],
    });

    const resolution = await resolveValidations(scan({ outcomes: { 'DG-01-01': 'fail' } }), held.options);

    expect(resolution.answered).toBe(
      resolution.verified + resolution.failed + resolution.incomplete + resolution.stalled
    );
  });
});
