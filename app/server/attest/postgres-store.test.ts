// What is specific to a stored answer.
//
// The log underneath is tested in store/event-log.test.ts against the same code, so what is left
// here is the part that is about attestations: both of their dates are required, and an answer whose
// review date is unreadable must not be treated as an answer at all — an expired attestation and a
// missing one lead a reader to different actions.

import { describe, expect, it } from 'vitest';
import { PostgresAttestationStore } from './postgres-store.js';
import { InMemoryAttestationStore } from './store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import type { Attestation } from './attestation.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function attestation(overrides: Partial<Attestation> = {}): Attestation {
  return {
    id: 'a1',
    controlId: 'OE-02-04',
    statement: 'Every production job is defined in a bundle and deployed from CI.',
    answer: 'met',
    owner: 'platform-team@example.com',
    attestedBy: 'platform-lead@example.com',
    attestedAt: NOW,
    reviewBy: new Date('2026-12-01T00:00:00.000Z'),
    ...overrides,
  };
}

function store(): { db: FakePostgres; store: PostgresAttestationStore } {
  const db = new FakePostgres();
  return { db, store: new PostgresAttestationStore({ db }) };
}

describe('keeping attested answers', () => {
  it('keeps them in their own table, not among the decisions', async () => {
    const { db, store: answers } = store();

    await answers.record(attestation());

    expect(db.rows('attestations')).toHaveLength(1);
    expect(db.rows('decisions')).toHaveLength(0);
  });

  it('reads back both dates as dates, because one of them decides whether the answer has expired', async () => {
    const { store: answers } = store();
    await answers.record(attestation());

    const [read] = await answers.current();

    expect(read?.attestedAt).toBeInstanceOf(Date);
    expect(read?.reviewBy).toBeInstanceOf(Date);
    expect(read?.reviewBy.toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it('treats an answer with no review date as unreadable, since expiry is not optional here', async () => {
    // The one place attestations and decisions genuinely differ: a decision may have no date, an
    // answer may not, and a revive shared between them would have to accept the looser of the two.
    const { db, store: answers } = store();
    db.seed('attestations', {
      id: 'broken',
      control_id: 'OE-02-04',
      attested_at: NOW,
      body: { ...attestation(), reviewBy: undefined },
    });

    expect(await answers.current()).toEqual([]);
  });

  it('treats an answer with no statement as unreadable, because the answer means nothing alone', async () => {
    const { db, store: answers } = store();
    db.seed('attestations', {
      id: 'broken',
      control_id: 'OE-02-04',
      attested_at: NOW,
      body: { ...attestation(), statement: undefined },
    });

    expect(await answers.current()).toEqual([]);
  });

  it('returns the newest answer per requirement and keeps the ones it replaced', async () => {
    const { store: answers } = store();

    await answers.record(attestation({ id: 'first', answer: 'not-met', attestedAt: new Date('2026-01-01T00:00:00Z') }));
    await answers.record(attestation({ id: 'second', answer: 'met', attestedAt: new Date('2026-05-01T00:00:00Z') }));

    expect((await answers.current()).map((entry) => entry.id)).toEqual(['second']);
    expect((await answers.historyFor('OE-02-04')).map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('says whether it survives a restart, which is the reason to prefer it', () => {
    expect(store().store.durable).toBe(true);
    expect(new InMemoryAttestationStore().durable).toBe(false);
  });

  it('agrees with the in-memory store on the same records', async () => {
    const records = [
      attestation({ id: 'first', attestedAt: new Date('2026-01-01T00:00:00Z') }),
      attestation({ id: 'second', attestedAt: new Date('2026-05-01T00:00:00Z'), supersedes: 'first' }),
    ];

    const { store: durable } = store();
    const memory = new InMemoryAttestationStore();
    for (const record of records) {
      await durable.record(record);
      await memory.record(record);
    }

    expect((await durable.current()).map((entry) => entry.id)).toEqual((await memory.current()).map((e) => e.id));
    expect((await durable.historyFor('OE-02-04')).map((entry) => entry.id)).toEqual(
      (await memory.historyFor('OE-02-04')).map((e) => e.id)
    );
  });
});
