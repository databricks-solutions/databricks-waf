import { describe, expect, it } from 'vitest';
import { FakePostgres } from '../store/postgres-fake.js';
import type { Note } from './note.js';
import { PostgresNoteStore } from './postgres-store.js';
import { InMemoryNoteStore, type NoteStore } from './store.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const LATER = new Date('2026-06-02T12:00:00.000Z');

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'note-1',
    subject: { kind: 'control', id: 'DG-1' },
    body: 'Both clusters this fails on are in the lab account, which closes in November.',
    by: 'ana@example.com',
    at: NOW,
    ...over,
  };
}

function postgres(): { store: NoteStore; db: FakePostgres; errors: string[] } {
  const db = new FakePostgres({});
  const errors: string[] = [];
  const store = new PostgresNoteStore({ db, onError: (operation) => errors.push(operation) });
  return { store, db, errors };
}

/*
 * Both implementations through the same tests, for the reason the improvement store gives: the
 * in-memory one is what an install without a database runs on, and a difference between the two only
 * shows up in the configuration nobody tests in.
 */
const implementations: readonly [string, () => NoteStore][] = [
  ['in memory', (): NoteStore => new InMemoryNoteStore()],
  ['in postgres', (): NoteStore => postgres().store],
];

describe.each(implementations)('keeping notes %s', (_name, open) => {
  it('reads back a note that was written', async () => {
    const store = open();
    await store.add(note());

    const thread = await store.for({ kind: 'control', id: 'DG-1' });
    expect(thread).toHaveLength(1);
    expect(thread[0]).toMatchObject({ id: 'note-1', by: 'ana@example.com' });
    expect(thread[0]?.at).toEqual(NOW);
  });

  it('has nothing to say about a subject nobody has written about', async () => {
    expect(await open().for({ kind: 'pillar', id: 'security' })).toEqual([]);
  });

  it('keeps threads apart, including two subjects that share an id', async () => {
    // A pillar and a requirement could both be called `security` in some future catalogue, and a store
    // keyed on the id alone would put one thread's notes on the other's page.
    const store = open();
    await store.add(note({ id: 'a', subject: { kind: 'pillar', id: 'security' } }));
    await store.add(note({ id: 'b', subject: { kind: 'control', id: 'security' } }));

    expect((await store.for({ kind: 'pillar', id: 'security' })).map((one) => one.id)).toEqual(['a']);
    expect((await store.for({ kind: 'control', id: 'security' })).map((one) => one.id)).toEqual(['b']);
  });

  it('reads a thread oldest first, whatever order the notes were written in', async () => {
    const store = open();
    await store.add(note({ id: 'second', at: LATER }));
    await store.add(note({ id: 'first', at: NOW }));

    expect((await store.for({ kind: 'control', id: 'DG-1' })).map((one) => one.id)).toEqual(['first', 'second']);
  });

  it('ignores a note it already has, because arriving twice is a retry rather than a second note', async () => {
    const store = open();
    await store.add(note());
    await store.add(note({ body: 'Something the first request did not say.' }));

    const thread = await store.for({ kind: 'control', id: 'DG-1' });
    expect(thread).toHaveLength(1);
    expect(thread[0]?.body).toContain('lab account');
  });

  it('keeps what a note was observed in and what it corrects', async () => {
    const store = open();
    await store.add(note({ id: 'first' }));
    await store.add(note({ id: 'second', at: LATER, observedIn: 'scan-4', corrects: 'first' }));

    const thread = await store.for({ kind: 'control', id: 'DG-1' });
    expect(thread[1]).toMatchObject({ observedIn: 'scan-4', corrects: 'first' });
  });

  it('counts notes per subject of one kind, so a list can show which have been written about', async () => {
    const store = open();
    await store.add(note({ id: 'a', subject: { kind: 'pillar', id: 'security' } }));
    await store.add(note({ id: 'b', subject: { kind: 'pillar', id: 'security' }, at: LATER }));
    await store.add(note({ id: 'c', subject: { kind: 'pillar', id: 'reliability' } }));
    await store.add(note({ id: 'd', subject: { kind: 'control', id: 'DG-1' } }));

    expect(await store.counts('pillar')).toEqual({ security: 2, reliability: 1 });
    expect(await store.counts('control')).toEqual({ 'DG-1': 1 });
    expect(await store.counts('run')).toEqual({});
  });

  it('reads every note of one kind, and keeps the other kinds out', async () => {
    const store = open();
    await store.add(note({ id: 'a', subject: { kind: 'control', id: 'DG-1' } }));
    await store.add(note({ id: 'b', subject: { kind: 'control', id: 'DG-2' }, at: LATER }));
    await store.add(note({ id: 'c', subject: { kind: 'pillar', id: 'security' } }));

    expect((await store.ofKind('control')).map((one) => one.id)).toEqual(['a', 'b']);
    expect((await store.ofKind('pillar')).map((one) => one.id)).toEqual(['c']);
    expect(await store.ofKind('run')).toEqual([]);
  });
});

describe('what each implementation says about itself', () => {
  it('is honest about durability, because the UI warns on the answer', () => {
    expect(new InMemoryNoteStore().durable).toBe(false);
    expect(postgres().store.durable).toBe(true);
  });
});

/** A row as it sits in the table, so a test can put a body in that the store would never write. */
function row(body: unknown, id = 'broken'): Record<string, unknown> {
  return {
    id,
    subject_kind: 'control',
    subject_id: 'DG-1',
    noted_at: NOW,
    body,
    digest: 'sha256:whatever',
  };
}

describe('a durable store reading rows it cannot use', () => {
  it('reports and drops a note whose date will not parse, rather than dating it now', async () => {
    // A note that arrives claiming to have been written this morning is worse than one that is missing
    // and logged: the date is what orders the thread and what a retention sweep measures.
    const { store, db, errors } = postgres();
    await store.add(note());
    db.seed('notes', row({ ...note({ id: 'broken' }), at: 'the third of never' }));

    const thread = await store.for({ kind: 'control', id: 'DG-1' });
    expect(thread.map((one) => one.id)).toEqual(['note-1']);
    expect(errors).toEqual(['read notes about control DG-1']);
  });

  it('reports a note with no subject rather than serving one nothing can place', async () => {
    const { store, db, errors } = postgres();
    db.seed('notes', row({ id: 'broken', body: 'text enough to pass', by: 'ana@example.com', at: NOW }));

    expect(await store.for({ kind: 'control', id: 'DG-1' })).toEqual([]);
    expect(errors).toHaveLength(1);
  });

  it('reads an empty thread and says why when the query fails', async () => {
    const { store, db, errors } = postgres();
    await db.end();

    expect(await store.for({ kind: 'run', id: 'scan-1' })).toEqual([]);
    expect(await store.counts('run')).toEqual({});
    expect(await store.ofKind('run')).toEqual([]);
    expect(errors).toEqual(['read notes about run scan-1', 'count notes about each run', 'read notes about each run']);
  });
});
