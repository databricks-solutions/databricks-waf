import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { PostgresSetupDraftStore } from './setup-postgres-store.js';
import { InMemorySetupDraftStore, type SetupDraftStore } from './setup-store.js';
import type { SetupDraft } from './setup.js';

const AT = new Date('2026-08-03T09:00:00Z');
const LATER = new Date('2026-08-03T10:00:00Z');
const ALICE = 'alice@example.com';
const BOB = 'bob@example.com';

function draft(fields: Partial<SetupDraft> = {}): SetupDraft {
  return { author: ALICE, name: 'Q3 platform review', savedAt: AT, ...fields };
}

/** Keyed on the pair, like the table, so the upsert is exercised rather than an insert of two rows. */
function fake(): FakePostgres {
  return new FakePostgres({ keys: { assessment_setup_drafts: ['author', 'definition_id'] } });
}

/*
 * Run against both implementations from one list, for the reason the definition store does: the two
 * exist so an install with no database still works, which is only true if they agree. A draft one
 * of them scopes to its author and the other hands to anybody would be a disclosure bug in whichever
 * deployment was least likely to be looked at.
 */
const implementations: readonly [string, () => SetupDraftStore][] = [
  ['in memory', () => new InMemorySetupDraftStore()],
  [
    'in postgres',
    () => {
      const db = fake();
      return new PostgresSetupDraftStore({ db: { ...db, query: db.query.bind(db), end: db.end.bind(db) } });
    },
  ],
];

for (const [name, build] of implementations) {
  describe(`keeping an unfinished assessment ${name}`, () => {
    it('reads back what was written, with its date as a date', async () => {
      const store = build();
      await store.save(draft({ purpose: 'Because the board asked.', lookbackDays: 30 }));

      const read = await store.get(ALICE);
      expect(read?.name).toBe('Q3 platform review');
      expect(read?.purpose).toBe('Because the board asked.');
      expect(read?.lookbackDays).toBe(30);
      // The mistake that only surfaces once something compares two of them.
      expect(read?.savedAt).toBeInstanceOf(Date);
      expect(read?.savedAt.getTime()).toBe(AT.getTime());
    });

    it('a second save replaces the first rather than leaving two', async () => {
      const store = build();
      await store.save(draft());
      await store.save(draft({ name: 'Renamed', savedAt: LATER }));

      expect(await store.mine(ALICE)).toHaveLength(1);
      expect((await store.get(ALICE))?.name).toBe('Renamed');
    });

    /*
     * The key includes the target, so an author revising one assessment while writing another does
     * not have the second overwrite the first. Getting this wrong would lose work with nothing
     * saying so, since both saves succeed.
     */
    it('a new assessment and a revision are different drafts for the same author', async () => {
      const store = build();
      await store.save(draft({ name: 'A new one' }));
      await store.save(draft({ definitionId: 'd1', fromVersion: 2, name: 'A revision' }));

      expect((await store.get(ALICE))?.name).toBe('A new one');
      expect((await store.get(ALICE, 'd1'))?.name).toBe('A revision');
      expect(await store.mine(ALICE)).toHaveLength(2);
    });

    it('the target comes back as an absent id rather than as an empty string', async () => {
      const store = build();
      await store.save(draft());
      expect(await store.get(ALICE)).not.toHaveProperty('definitionId');
    });

    it("one author cannot read another author's", async () => {
      const store = build();
      await store.save(draft({ author: ALICE }));

      expect(await store.get(BOB)).toBeUndefined();
      expect(await store.mine(BOB)).toEqual([]);
    });

    it('two authors writing the same revision keep their own', async () => {
      const store = build();
      await store.save(draft({ author: ALICE, definitionId: 'd1', name: "Alice's" }));
      await store.save(draft({ author: BOB, definitionId: 'd1', name: "Bob's" }));

      expect((await store.get(ALICE, 'd1'))?.name).toBe("Alice's");
      expect((await store.get(BOB, 'd1'))?.name).toBe("Bob's");
    });

    it('lists newest first, which is the order somebody picking work up wants', async () => {
      const store = build();
      await store.save(draft({ name: 'Older', savedAt: AT }));
      await store.save(draft({ definitionId: 'd1', name: 'Newer', savedAt: LATER }));

      expect((await store.mine(ALICE)).map((one) => one.name)).toEqual(['Newer', 'Older']);
    });

    it("discards one and leaves the author's others alone", async () => {
      const store = build();
      await store.save(draft());
      await store.save(draft({ definitionId: 'd1' }));

      await store.discard(ALICE);

      expect(await store.get(ALICE)).toBeUndefined();
      expect(await store.get(ALICE, 'd1')).toBeDefined();
    });

    it('discarding one that is not there is not an error, because confirming and abandoning both end here', async () => {
      const store = build();
      await expect(store.discard(ALICE, 'never-existed')).resolves.toBeUndefined();
    });

    it('says whether it will survive a restart', () => {
      expect(typeof build().durable).toBe('boolean');
    });
  });
}

describe('reading a row that is not a draft', () => {
  function store(db: FakePostgres): PostgresSetupDraftStore {
    return new PostgresSetupDraftStore({ db: { ...db, query: db.query.bind(db), end: db.end.bind(db) } });
  }

  it('drops a row with no readable date rather than returning one with an invalid one', async () => {
    const db = fake();
    await db.query(
      'insert into waf.assessment_setup_drafts (author, definition_id, saved_at, body) values ($1, $2, $3, $4::jsonb)',
      [ALICE, '', AT, JSON.stringify({ name: 'Broken', savedAt: 'not a date' })]
    );

    expect(await store(db).get(ALICE)).toBeUndefined();
    expect(await store(db).mine(ALICE)).toEqual([]);
  });

  /*
   * A lookback of "thirty" would otherwise reach `troubles`, which asks whether it is an integer and
   * would report the answer as though the author had typed it.
   */
  it('drops a field of the wrong shape and keeps the rest', async () => {
    const db = fake();
    await db.query(
      'insert into waf.assessment_setup_drafts (author, definition_id, saved_at, body) values ($1, $2, $3, $4::jsonb)',
      [ALICE, '', AT, JSON.stringify({ name: 'Kept', lookbackDays: 'thirty', owners: [1, 2], savedAt: AT })]
    );

    const read = await store(db).get(ALICE);
    expect(read?.name).toBe('Kept');
    expect(read).not.toHaveProperty('lookbackDays');
    expect(read).not.toHaveProperty('owners');
  });

  /*
   * The author and the target come from the key columns, not the body. A body edited in `psql` to
   * name somebody else must not hand one author's draft to another.
   */
  it('takes the author from the key column and not from the body', async () => {
    const db = fake();
    await db.query(
      'insert into waf.assessment_setup_drafts (author, definition_id, saved_at, body) values ($1, $2, $3, $4::jsonb)',
      [ALICE, 'd1', AT, JSON.stringify({ author: BOB, definitionId: 'd9', name: 'Claimed', savedAt: AT })]
    );

    const read = await store(db).get(ALICE, 'd1');
    expect(read?.author).toBe(ALICE);
    expect(read?.definitionId).toBe('d1');
    expect(await store(db).mine(BOB)).toEqual([]);
  });

  it('keeps a scope only when its kind is one of the two, and drops ids that are not strings', async () => {
    const db = fake();
    await db.query(
      'insert into waf.assessment_setup_drafts (author, definition_id, saved_at, body) values ($1, $2, $3, $4::jsonb)',
      [ALICE, '', AT, JSON.stringify({ scope: { kind: 'everything', workspaceIds: ['w1'] }, savedAt: AT })]
    );
    expect(await store(db).get(ALICE)).not.toHaveProperty('scope');

    const other = fake();
    await other.query(
      'insert into waf.assessment_setup_drafts (author, definition_id, saved_at, body) values ($1, $2, $3, $4::jsonb)',
      [ALICE, '', AT, JSON.stringify({ scope: { kind: 'selected', workspaceIds: [7] }, savedAt: AT })]
    );
    expect((await store(other).get(ALICE))?.scope).toEqual({ kind: 'selected' });
  });
});
