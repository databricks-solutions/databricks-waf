import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import { define, revise, type AssessmentDefinition, type Draft } from './definition.js';
import { PostgresDefinitionStore } from './postgres-store.js';
import { DefinitionConflict, InMemoryDefinitionStore, selectable, type DefinitionStore } from './store.js';

const AT = new Date('2026-08-03T00:00:00Z');
const LATER = new Date('2026-08-04T00:00:00Z');
const BY = 'alice@example.com';

const DRAFT: Draft = {
  measurement: { scope: { kind: 'selected', workspaceIds: ['w1', 'w2'] }, lookbackDays: 30 },
  attribution: { name: 'Q3 platform review', owners: [BY] },
};

/** Both tables' keys, since the versions table is keyed on a pair rather than an `id`. */
function fake(): FakePostgres {
  return new FakePostgres({ keys: { assessment_definition_versions: ['definition_id', 'version'] } });
}

function postgres(db: FakePostgres): PostgresDefinitionStore {
  return new PostgresDefinitionStore({ db: { ...db, query: db.query.bind(db), end: db.end.bind(db) } });
}

/*
 * Run against both implementations from one list.
 *
 * The two exist so an install with no database still works, which is only true if they behave the
 * same. A conflict raised by one and swallowed by the other would mean a lost revision in exactly
 * the deployment least able to notice.
 */
const implementations: readonly [string, () => DefinitionStore][] = [
  ['in memory', () => new InMemoryDefinitionStore()],
  ['in postgres', () => postgres(fake())],
];

for (const [name, build] of implementations) {
  describe(`keeping definitions ${name}`, () => {
    it('stores a definition and reads it back with its version', async () => {
      const store = build();
      const definition = define(DRAFT, 'd1', AT, BY);
      await store.create(definition);

      const read = await store.get('d1');
      expect(read?.versions).toHaveLength(1);
      expect(read?.versions[0]?.fingerprint).toBe(definition.versions[0]?.fingerprint);
      expect(read?.versions[0]?.attribution.name).toBe('Q3 platform review');
      // Revived as a Date rather than the string a jsonb column hands back, which is the mistake
      // that only shows up once something compares two of them.
      expect(read?.versions[0]?.createdAt).toBeInstanceOf(Date);
      expect(read?.versions[0]?.createdAt.getTime()).toBe(AT.getTime());
    });

    it('appends a version and keeps the one before it', async () => {
      const store = build();
      const first = define(DRAFT, 'd1', AT, BY);
      await store.create(first);

      const second = revise(first, { attribution: { name: 'Renamed', owners: [BY] } }, LATER, BY);
      const added = second.versions[1];
      if (added == null) throw new Error('revise produced no second version');
      await store.appendVersion('d1', added);

      const read = await store.get('d1');
      expect(read?.versions.map((one) => one.version)).toEqual([1, 2]);
      expect(read?.versions[0]?.attribution.name).toBe('Q3 platform review');
      expect(read?.versions[1]?.attribution.name).toBe('Renamed');
    });

    /*
     * The property the two-table shape exists for. Both authors revise from the same read and both
     * compute version 2; the second must be told rather than allowed to replace the first.
     */
    it('refuses a version number already taken instead of replacing it', async () => {
      const store = build();
      const first = define(DRAFT, 'd1', AT, BY);
      await store.create(first);

      const mine = revise(first, { attribution: { name: 'Mine', owners: [BY] } }, LATER, BY);
      const theirs = revise(first, { attribution: { name: 'Theirs', owners: ['bob@example.com'] } }, LATER, 'bob');
      const minesVersion = mine.versions[1];
      const theirsVersion = theirs.versions[1];
      if (minesVersion == null || theirsVersion == null) throw new Error('revise produced no second version');

      await store.appendVersion('d1', minesVersion);
      await expect(store.appendVersion('d1', theirsVersion)).rejects.toThrow(DefinitionConflict);

      // And the winner's revision is intact, which is the half a silent overwrite would have lost.
      const read = await store.get('d1');
      expect(read?.versions).toHaveLength(2);
      expect(read?.versions[1]?.attribution.name).toBe('Mine');
    });

    it('refuses to create a definition twice', async () => {
      const store = build();
      await store.create(define(DRAFT, 'd1', AT, BY));
      await expect(store.create(define(DRAFT, 'd1', LATER, BY))).rejects.toThrow(DefinitionConflict);
    });

    it('archives without removing, and keeps the first archival date', async () => {
      const store = build();
      await store.create(define(DRAFT, 'd1', AT, BY));

      await store.archive('d1', LATER);
      const read = await store.get('d1');
      expect(read?.archivedAt?.getTime()).toBe(LATER.getTime());
      expect(read?.versions).toHaveLength(1);

      // Idempotent in the sense that matters: a second call does not move the date on.
      await store.archive('d1', new Date('2026-09-01T00:00:00Z'));
      expect((await store.get('d1'))?.archivedAt?.getTime()).toBe(LATER.getTime());
    });

    it('reopens an archived definition, leaving nothing that still reads as archived', async () => {
      const store = build();
      await store.create(define(DRAFT, 'd1', AT, BY));
      await store.archive('d1', LATER);

      await store.unarchive('d1');

      const read = await store.get('d1');
      // Both, because `selectable` asks `archivedAt == null` and other readers ask whether the key is
      // there at all. A row carrying the key with an undefined value satisfies one and not the other.
      expect(read?.archivedAt).toBeUndefined();
      expect(read != null && 'archivedAt' in read).toBe(false);
      expect(read?.versions).toHaveLength(1);
      expect(selectable([read as AssessmentDefinition]).map((one) => one.id)).toEqual(['d1']);
    });

    it('reopens one that was never archived without complaining', async () => {
      const store = build();
      await store.create(define(DRAFT, 'd1', AT, BY));

      await expect(store.unarchive('d1')).resolves.toBeUndefined();
      expect((await store.get('d1'))?.archivedAt).toBeUndefined();
    });

    it('can archive again after reopening, and takes the new date', async () => {
      // The pair has to survive a round trip. A store that cleared the date but left a row the update
      // no longer matches would reopen once and then refuse to close again, which is worse than never
      // having offered the button.
      const store = build();
      await store.create(define(DRAFT, 'd1', AT, BY));
      await store.archive('d1', AT);
      await store.unarchive('d1');

      await store.archive('d1', LATER);

      expect((await store.get('d1'))?.archivedAt?.getTime()).toBe(LATER.getTime());
    });

    it('answers nothing for a definition it does not have', async () => {
      const store = build();
      expect(await store.get('missing')).toBeUndefined();
      expect(await store.all()).toEqual([]);
    });

    it('lists newest first', async () => {
      const store = build();
      await store.create(define(DRAFT, 'old', AT, BY));
      await store.create(define(DRAFT, 'new', LATER, BY));

      expect((await store.all()).map((one) => one.id)).toEqual(['new', 'old']);
    });
  });
}

describe('what a new run may be started from', () => {
  it('offers the unarchived, newest first', () => {
    const live = define(DRAFT, 'live', LATER, BY);
    const closed: AssessmentDefinition = { ...define(DRAFT, 'closed', AT, BY), archivedAt: LATER };

    expect(selectable([closed, live]).map((one) => one.id)).toEqual(['live']);
  });
});

describe('a definition store on a database that answers oddly', () => {
  it('skips a version row it cannot read rather than returning a broken definition', async () => {
    const db = fake();
    const store = postgres(db);
    await store.create(define(DRAFT, 'd1', AT, BY));

    db.seed('assessment_definition_versions', {
      definition_id: 'd1',
      version: 2,
      // No fingerprint and no date, which is what a row written by a future build or edited by hand
      // could look like. Stamping a run with this would put an unmeasured claim in the history.
      body: { version: 2 },
    });

    const reported: string[] = [];
    const loud = new PostgresDefinitionStore({
      db: { ...db, query: db.query.bind(db), end: db.end.bind(db) },
      onError: (operation) => reported.push(operation),
    });

    const read = await loud.get('d1');
    expect(read?.versions.map((one) => one.version)).toEqual([1]);
    expect(reported).toEqual(['read every assessment definition']);
  });

  it('hides a definition whose every version is unreadable, rather than showing an empty shell', async () => {
    const db = fake();
    db.seed('assessment_definitions', { id: 'orphan', created_at: AT, archived_at: null });

    expect(await postgres(db).all()).toEqual([]);
  });

  it('reports a failed read and re-throws, so a caller cannot mistake it for an empty estate', async () => {
    const db = new FakePostgres({
      keys: { assessment_definition_versions: ['definition_id', 'version'] },
      failOn: (text) => (text.startsWith('select id') ? new Error('connection reset') : undefined),
    });
    const reported: string[] = [];
    const store = new PostgresDefinitionStore({
      db: { ...db, query: db.query.bind(db), end: db.end.bind(db) },
      onError: (operation) => reported.push(operation),
    });

    await expect(store.all()).rejects.toThrow('connection reset');
    expect(reported).toEqual(['read every assessment definition']);
  });
});
