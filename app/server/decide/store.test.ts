// What is tested here is what a decision does that an attestation does not.
//
// The append-only machinery underneath — the insert, the projection to newest-per-requirement, the
// tie-break by supersession chain — is store/event-log.ts and is tested there, against both tables.
// Repeating it would be testing the same lines twice and would hide the two things that are
// genuinely different: a decision may legitimately have no date, and its records go to their own
// table beside the answers rather than among them.

import { describe, expect, it } from 'vitest';
import { InMemoryDecisionStore, PostgresDecisionStore } from './store.js';
import { FakePostgres } from '../store/postgres-fake.js';
import type { Decision } from './decision.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');

function decision(overrides: Partial<Decision> = {}): Decision {
  return {
    id: 'd1',
    controlId: 'DG-02-01',
    disposition: 'accepted',
    reason: 'Lab account, no customer data, closing in November.',
    owner: 'platform-team@example.com',
    until: new Date('2026-09-01T00:00:00.000Z'),
    decidedBy: 'admin@example.com',
    decidedAt: NOW,
    ...overrides,
  };
}

function store(): { db: FakePostgres; store: PostgresDecisionStore } {
  const db = new FakePostgres();
  return { db, store: new PostgresDecisionStore({ db }) };
}

describe('keeping decisions', () => {
  it('keeps them in their own table, beside the answers rather than among them', async () => {
    const { db, store: decisions } = store();

    await decisions.record(decision());

    expect(db.rows('decisions')).toHaveLength(1);
    expect(db.rows('attestations')).toHaveLength(0);
  });

  it('reads back its dates as dates, because whether it has lapsed is a date comparison', async () => {
    const { store: decisions } = store();
    await decisions.record(decision());

    const [read] = await decisions.current();

    expect(read?.decidedAt).toBeInstanceOf(Date);
    expect(read?.until).toBeInstanceOf(Date);
    expect(read?.until?.toISOString()).toBe('2026-09-01T00:00:00.000Z');
  });

  it('keeps a fix claim, which has no date at all', async () => {
    // The one shape a stored attestation never has. A revive that required every date would drop
    // exactly the decisions this app can verify.
    const { store: decisions } = store();

    await decisions.record(decision({ disposition: 'fixed', until: undefined }));

    const [read] = await decisions.current();
    expect(read?.disposition).toBe('fixed');
    expect(read?.until).toBeUndefined();
  });

  it('treats a record whose date does not parse as unreadable rather than guessing', async () => {
    const { db, store: decisions } = store();
    db.seed('decisions', {
      id: 'broken',
      control_id: 'DG-02-01',
      decided_at: NOW,
      body: { ...decision(), until: 'the third of never' },
    });

    // Lapsed-or-current would otherwise depend on how the parser felt, which is worse than absent.
    expect(await decisions.current()).toEqual([]);
  });

  it('returns the newest decision per requirement and keeps the ones it replaced', async () => {
    const { store: decisions } = store();

    await decisions.record(decision({ id: 'first', decidedAt: new Date('2026-01-01T00:00:00Z') }));
    await decisions.record(
      decision({ id: 'second', disposition: 'fixed', until: undefined, decidedAt: new Date('2026-05-01T00:00:00Z') })
    );

    expect((await decisions.current()).map((entry) => entry.id)).toEqual(['second']);
    expect((await decisions.historyFor('DG-02-01')).map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('says whether it survives a restart, because the reader is told which install they have', () => {
    expect(store().store.durable).toBe(true);
    expect(new InMemoryDecisionStore().durable).toBe(false);
  });

  it('supersedes in memory too, so the demo build behaves the same way', async () => {
    const memory = new InMemoryDecisionStore();

    await memory.record(decision({ id: 'first', decidedAt: new Date('2026-01-01T00:00:00Z') }));
    await memory.record(decision({ id: 'second', decidedAt: new Date('2026-05-01T00:00:00Z') }));

    expect((await memory.current()).map((entry) => entry.id)).toEqual(['second']);
    expect((await memory.historyFor('DG-02-01')).map((entry) => entry.id)).toEqual(['second', 'first']);
  });

  it('gives the same answer as the in-memory store for the same records, including the tie-break', async () => {
    // Two implementations of one interface that disagree are worse than either being wrong, and the
    // case that would separate them is two records sharing a millisecond — where "newest" is
    // decided by which supersedes the other rather than by the clock.
    const tied = [
      decision({ id: 'a', decidedAt: NOW }),
      decision({ id: 'b', decidedAt: NOW, supersedes: 'a' }),
      decision({ id: 'c', decidedAt: NOW, supersedes: 'b' }),
    ];

    const { store: durable } = store();
    const memory = new InMemoryDecisionStore();
    for (const record of tied) {
      await durable.record(record);
      await memory.record(record);
    }

    expect((await durable.current()).map((entry) => entry.id)).toEqual(['c']);
    expect((await durable.historyFor('DG-02-01')).map((entry) => entry.id)).toEqual(
      (await memory.historyFor('DG-02-01')).map((entry) => entry.id)
    );
  });
});
