import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import type { ValidationAttempt } from './attempt.js';
import { answeredBy } from './attempt.js';
import { PostgresValidationStore } from './postgres-store.js';
import { AlreadyAnsweredError, InMemoryValidationStore, type ValidationStore } from './store.js';

const CLAIMED = new Date('2026-06-01T09:00:00.000Z');
const REQUESTED = new Date('2026-06-01T10:00:00.000Z');
const MEASURED = new Date('2026-06-02T10:00:00.000Z');
const PLAN_OPENED = new Date('2026-05-01T09:00:00.000Z');

function attempt(over: Partial<ValidationAttempt> = {}): ValidationAttempt {
  return {
    id: 'attempt-1',
    planId: 'plan-1',
    actionId: 'action-1',
    checks: [{ controlId: 'DG-01-01', method: 'measured' }],
    claimedAt: CLAIMED,
    requestedBy: 'ana@example.com',
    requestedAt: REQUESTED,
    observeFrom: REQUESTED,
    observeDays: 0,
    ...over,
  };
}

function answered(one: ValidationAttempt = attempt()): ValidationAttempt {
  return answeredBy(one, {
    scanId: 'scan-9',
    measuredAt: MEASURED,
    observations: [{ controlId: 'DG-01-01', outcome: 'pass' }],
  });
}

function postgres(options: { planCreatedAt?: Date } = {}): {
  store: ValidationStore;
  db: FakePostgres;
  errors: string[];
} {
  const db = new FakePostgres({ keys: { validation_attempts: ['id', 'revision'] } });
  const errors: string[] = [];
  const store = new PostgresValidationStore({
    db,
    ...(options.planCreatedAt != null ? { planCreatedAt: (): Promise<Date> => Promise.resolve(options.planCreatedAt as Date) } : {}),
    onError: (operation) => errors.push(operation),
  });
  return { store, db, errors };
}

/*
 * Both implementations through the same tests, for the reason the improvement store gives: the
 * in-memory one is what an install without a database runs on, and a difference between the two only
 * shows up in the configuration nobody tests in.
 */
const implementations: readonly [string, () => ValidationStore][] = [
  ['in memory', (): ValidationStore => new InMemoryValidationStore()],
  ['in postgres', (): ValidationStore => postgres().store],
];

describe.each(implementations)('keeping validation attempts %s', (_name, open) => {
  it('reads back an attempt that was asked for, dates and all', async () => {
    const store = open();
    await store.add(attempt());

    const [read] = await store.for('action-1');
    expect(read).toMatchObject({ id: 'attempt-1', requestedBy: 'ana@example.com', observeDays: 0 });
    expect(read?.claimedAt).toEqual(CLAIMED);
    expect(read?.observeFrom).toEqual(REQUESTED);
    expect(read?.answer).toBeUndefined();
  });

  it('has nothing to say about an action nobody has offered for validation', async () => {
    expect(await open().for('action-none')).toEqual([]);
  });

  it('keeps one action’s attempts apart from another’s', async () => {
    const store = open();
    await store.add(attempt());
    await store.add(attempt({ id: 'attempt-2', actionId: 'action-2' }));

    expect((await store.for('action-1')).map((one) => one.id)).toEqual(['attempt-1']);
    expect((await store.for('action-2')).map((one) => one.id)).toEqual(['attempt-2']);
  });

  it('reads them newest first, because the last attempt is the one being looked at', async () => {
    const store = open();
    await store.add(attempt({ id: 'first', requestedAt: REQUESTED }));
    await store.add(attempt({ id: 'second', requestedAt: new Date('2026-06-05T10:00:00.000Z') }));

    expect((await store.for('action-1')).map((one) => one.id)).toEqual(['second', 'first']);
  });

  it('reads back the answer, and the run behind it', async () => {
    const store = open();
    await store.add(attempt());
    await store.answer(answered());

    const [read] = await store.for('action-1');
    expect(read?.answer).toMatchObject({ result: 'passed', scanId: 'scan-9', unmet: [], unreadable: [] });
    expect(read?.answer?.at).toEqual(MEASURED);
  });

  it('keeps the answered reading rather than both, so an action shows one attempt not two', async () => {
    const store = open();
    await store.add(attempt());
    await store.answer(answered());

    expect(await store.for('action-1')).toHaveLength(1);
  });

  it('offers an outstanding attempt to whatever is looking for one', async () => {
    const store = open();
    await store.add(attempt());

    expect((await store.outstanding()).map((one) => one.id)).toEqual(['attempt-1']);
  });

  it('stops offering it once it has been answered', async () => {
    const store = open();
    await store.add(attempt());
    await store.answer(answered());

    expect(await store.outstanding()).toEqual([]);
  });

  it('offers outstanding attempts across actions, which is what a finished run asks for', async () => {
    const store = open();
    await store.add(attempt());
    await store.add(attempt({ id: 'attempt-2', actionId: 'action-2' }));
    await store.answer(answered(attempt({ id: 'attempt-2', actionId: 'action-2' })));
    await store.add(attempt({ id: 'attempt-3', actionId: 'action-3' }));

    expect((await store.outstanding()).map((one) => one.id).sort()).toEqual(['attempt-1', 'attempt-3']);
  });

  it('refuses a second answer, naming the attempt rather than the constraint', async () => {
    const store = open();
    await store.add(attempt());
    await store.answer(answered());

    await expect(store.answer(answered())).rejects.toThrow(AlreadyAnsweredError);
  });

  it('leaves the first answer standing when a second is refused', async () => {
    const store = open();
    await store.add(attempt());
    await store.answer(answered());

    const second = answeredBy(attempt(), {
      scanId: 'scan-10',
      measuredAt: MEASURED,
      observations: [{ controlId: 'DG-01-01', outcome: 'fail' }],
    });
    await expect(store.answer(second)).rejects.toThrow(AlreadyAnsweredError);

    const [read] = await store.for('action-1');
    expect(read?.answer).toMatchObject({ result: 'passed', scanId: 'scan-9' });
  });
});

describe('validation attempts in postgres', () => {
  it('writes two rows for one attempt, the second being the answer', async () => {
    const { store, db } = postgres();
    await store.add(attempt());
    await store.answer(answered());

    const rows = db.rows('validation_attempts');
    expect(rows.map((row) => row.revision)).toEqual([0, 1]);
    expect(rows.map((row) => row.answered)).toEqual([false, true]);
    expect(rows.every((row) => row.id === 'attempt-1')).toBe(true);
  });

  it('digests each row, so a body edited in the database is detectable', async () => {
    const { store, db } = postgres();
    await store.add(attempt());

    const [row] = db.rows('validation_attempts');
    expect(row?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('ages an attempt from its plan, so the two are swept together', async () => {
    const { store, db } = postgres({ planCreatedAt: PLAN_OPENED });
    await store.add(attempt());

    expect(db.rows('validation_attempts')[0]?.plan_created_at).toEqual(PLAN_OPENED);
  });

  it('falls back to the attempt’s own date where the plan has gone', async () => {
    const { store, db } = postgres();
    await store.add(attempt());

    expect(db.rows('validation_attempts')[0]?.plan_created_at).toEqual(REQUESTED);
  });

  it('reads a failed read as empty and says which read failed', async () => {
    const db = new FakePostgres({
      keys: { validation_attempts: ['id', 'revision'] },
      failOn: (text) => (text.startsWith('select') ? new Error('connection reset') : undefined),
    });
    const errors: string[] = [];
    const store = new PostgresValidationStore({ db, onError: (operation) => errors.push(operation) });

    expect(await store.for('action-1')).toEqual([]);
    expect(await store.outstanding()).toEqual([]);
    // Once for `outstanding`, which is one statement. It read twice and subtracted the second from the
    // first until the exclusion moved into SQL, and the pair reported twice because a log saying one
    // read failed while two did would describe a database that answered half of a pair it never
    // answered. One statement, one report, and the same rule.
    expect(errors).toEqual(['read validations of action action-1', 'read outstanding validations']);
  });

  it('raises a failed write rather than reporting it, because a lost attempt is not a validation', async () => {
    const db = new FakePostgres({
      keys: { validation_attempts: ['id', 'revision'] },
      failOn: (text) => (text.startsWith('insert') ? new Error('disk full') : undefined),
    });
    const store = new PostgresValidationStore({ db });

    await expect(store.add(attempt())).rejects.toThrow('disk full');
  });

  it('reports a repeated request id as itself, since nothing legitimate produces one', async () => {
    // A duplicate at revision 0 is not a lost race: an id is minted per request, so two requests
    // carrying one id is a caller that is not minting them. Answering it as AlreadyAnswered would
    // describe a race that did not happen.
    const { store } = postgres();
    await store.add(attempt());

    await expect(store.add(attempt())).rejects.toThrow(/duplicate key/);
  });

  it('counts a row it cannot read rather than throwing, and leaves the attempt outstanding', async () => {
    // The safe direction: an unreadable answer row means the attempt is offered to the next run, which
    // answers it again. An attempt dropped entirely would lose the record that a claim was checked.
    const { store, db, errors } = postgres();
    await store.add(attempt());
    db.seed('validation_attempts', {
      id: 'attempt-1',
      revision: 1,
      action_id: 'action-1',
      plan_id: 'plan-1',
      answered: false,
      requested_at: REQUESTED,
      body: { id: 'attempt-1', actionId: 'action-1', planId: 'plan-1' },
      digest: 'x',
    });

    const read = await store.for('action-1');
    expect(read).toHaveLength(1);
    expect(read[0]?.answer).toBeUndefined();
    expect(errors).toEqual(['read validations of action action-1']);
  });

  it('does not read an answered attempt back as outstanding when its answer will not parse', async () => {
    // The one case worth being explicit about: a row whose answer date is unreadable is dropped rather
    // than read as an attempt nobody has answered, because that would produce a second answer to a
    // question already settled.
    const { store, db, errors } = postgres();
    const one = answered();
    db.seed('validation_attempts', {
      id: 'attempt-1',
      revision: 1,
      action_id: 'action-1',
      plan_id: 'plan-1',
      answered: true,
      requested_at: REQUESTED,
      // Serialised as the driver hands it back, with one unparseable date in it.
      body: { ...one, answer: { ...one.answer, at: 'the second Tuesday' } },
      digest: 'x',
    });

    expect(await store.outstanding()).toEqual([]);
    expect(await store.for('action-1')).toEqual([]);
    expect(errors).toEqual(['read validations of action action-1']);
  });
});
