// The machinery both record stores sit on, tested once.
//
// Attestations and decisions differ in which fields are dates and in what makes a record
// unreadable; everything else — the append, the newest-per-requirement projection, the tie-break,
// what a failed read reports — is this file, and testing it through either store would leave the
// other's behaviour asserted by implication.
//
// The record type here is deliberately not either domain type. A test that used `Attestation` would
// couple this file to a shape it never reads, and would make it easy to assert something about
// attestations that only holds because of the log.

import { describe, expect, it, vi } from 'vitest';
import { PostgresEventLog, type LoggedEvent } from './event-log.js';
import { FakePostgres } from './postgres-fake.js';
import { digestOf } from '../records/digest.js';

interface Note extends LoggedEvent {
  readonly said: string;
  readonly at: Date;
  readonly definitionId?: string;
}

const NOW = new Date('2026-06-01T12:00:00.000Z');

function note(overrides: Partial<Note> = {}): Note {
  return { id: 'n1', controlId: 'DG-02-01', said: 'something', at: NOW, ...overrides };
}

function revive(raw: unknown): Note | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Note & { at: string | Date };
  const at = new Date(candidate.at);
  if (Number.isNaN(at.getTime())) return undefined;
  return { ...candidate, at };
}

function log(options: { readonly db?: FakePostgres; readonly onError?: (op: string, e: unknown) => void } = {}) {
  const db = options.db ?? new FakePostgres();
  return {
    db,
    log: new PostgresEventLog<Note>({
      db,
      table: 'attestations',
      stampColumn: 'attested_at',
      stampOf: (record) => record.at,
      revive,
      noun: 'note',
      ...(options.onError ? { onError: options.onError } : {}),
    }),
  };
}

describe('an append-only log in Lakebase', () => {
  it('stores the whole record as one row, keyed by its id', async () => {
    const { db, log: notes } = log();

    await notes.append(note({ id: 'n1' }));
    await notes.append(note({ id: 'n2' }));

    expect(db.rows('attestations').map((row) => row.id)).toEqual(['n1', 'n2']);
  });

  it('columns out the two fields a query needs and leaves the rest in the body', async () => {
    // `control_id` and the timestamp are indexed, so they are columns; nothing else is queried on,
    // and promoting fields nobody filters by would be a schema to migrate for no gain. `digest` is
    // the exception and not a counter-example: it is not in the body because it is a statement
    // *about* the body, and a digest inside the document it covers cannot be computed.
    const { db, log: notes } = log();
    await notes.append(note({ id: 'n1', said: 'kept whole' }));

    const [row] = db.rows('attestations');
    expect(Object.keys(row ?? {}).sort()).toEqual([
      'attested_at',
      'body',
      'control_id',
      'definition_id',
      'digest',
      'id',
    ]);
    expect((row?.body as Note).said).toBe('kept whole');
  });

  it('stamps the record with the digest of what was written', async () => {
    const { db, log: notes } = log();
    const written = note({ id: 'n1', said: 'kept whole' });
    await notes.append(written);

    const [row] = db.rows('attestations');
    // Computed from the row's own body rather than from `written`, which is the check that matters:
    // the stored document is what a reader will hash, and it has been through JSON on the way in.
    expect(row?.digest).toBe(digestOf(row?.body));
    expect(row?.digest).toBe(digestOf(written));
  });

  it('never updates a row, so a correction cannot destroy what it replaced', async () => {
    const { db, log: notes } = log();
    await notes.append(note({ id: 'n1', said: 'original' }));
    await notes.append(note({ id: 'n1', said: 'rewritten' }));

    // Two appends of one id is not a correction — a correction is a new id naming the old one — so
    // the second is dropped rather than allowed to overwrite.
    expect(db.rows('attestations')).toHaveLength(1);
    expect((db.rows('attestations')[0]?.body as Note).said).toBe('original');
    expect(db.statements.some((sql) => sql.startsWith('update'))).toBe(false);
    expect(db.statements.some((sql) => sql.startsWith('delete'))).toBe(false);
  });

  it('returns the newest record per requirement, not one row per requirement per revision', async () => {
    const { log: notes } = log();
    await notes.append(note({ id: 'old', at: new Date('2026-01-01T00:00:00Z') }));
    await notes.append(note({ id: 'new', at: new Date('2026-05-01T00:00:00Z') }));
    await notes.append(note({ id: 'other', controlId: 'CO-01-01', at: new Date('2026-02-01T00:00:00Z') }));

    const current = await notes.current();
    expect(current.map((record) => record.id).sort()).toEqual(['new', 'other']);
  });

  it('breaks a tied timestamp by the supersession chain, which the clock cannot', async () => {
    // Two records typed in the same millisecond. Ordering by the timestamp alone would put either
    // at the top depending on the sort's stability, and a reader shown the superseded one is being
    // told the wrong thing.
    const { log: notes } = log();
    await notes.append(note({ id: 'first', at: NOW }));
    await notes.append(note({ id: 'second', at: NOW, supersedes: 'first' }));

    expect((await notes.current()).map((record) => record.id)).toEqual(['second']);
    expect((await notes.historyFor('DG-02-01')).map((record) => record.id)).toEqual(['second', 'first']);
  });

  it('follows the chain further than one link', async () => {
    const { log: notes } = log();
    await notes.append(note({ id: 'a', at: NOW }));
    await notes.append(note({ id: 'b', at: NOW, supersedes: 'a' }));
    await notes.append(note({ id: 'c', at: NOW, supersedes: 'b' }));

    expect((await notes.historyFor('DG-02-01')).map((record) => record.id)).toEqual(['c', 'b', 'a']);
  });

  it('does not hang on a chain that points at itself', async () => {
    // Unreachable through the app, which only ever names a record that already exists. Reachable
    // from the database, which anyone with access can edit, and a comparator that looped would take
    // the request down with it.
    const db = new FakePostgres();
    db.seed('attestations', {
      id: 'x',
      control_id: 'DG-02-01',
      attested_at: NOW,
      body: { ...note({ id: 'x' }), supersedes: 'y' },
    });
    db.seed('attestations', {
      id: 'y',
      control_id: 'DG-02-01',
      attested_at: NOW,
      body: { ...note({ id: 'y' }), supersedes: 'x' },
    });
    const { log: notes } = log({ db });

    expect((await notes.historyFor('DG-02-01')).map((record) => record.id)).toEqual(['x', 'y']);
  });

  it('reads one requirement’s history from the index rather than filtering every row', async () => {
    const { db, log: notes } = log();
    await notes.append(note({ id: 'mine' }));
    await notes.append(note({ id: 'theirs', controlId: 'CO-01-01' }));

    expect((await notes.historyFor('DG-02-01')).map((record) => record.id)).toEqual(['mine']);
    expect(db.statements.some((sql) => sql.includes('where control_id = $1'))).toBe(true);
  });

  it('has nothing rather than failing on a fresh install', async () => {
    const { log: notes } = log();

    expect(await notes.current()).toEqual([]);
    expect(await notes.historyFor('DG-02-01')).toEqual([]);
  });

  it('skips a row it cannot read and reports the count once, not once per row', async () => {
    const onError = vi.fn();
    const db = new FakePostgres();
    db.seed('attestations', { id: 'ok', control_id: 'DG-02-01', attested_at: NOW, body: note({ id: 'ok' }) });
    for (const id of ['bad1', 'bad2', 'bad3']) {
      db.seed('attestations', { id, control_id: 'DG-02-01', attested_at: NOW, body: { id, at: 'not a date' } });
    }
    const { log: notes } = log({ db, onError });

    expect((await notes.historyFor('DG-02-01')).map((record) => record.id)).toEqual(['ok']);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[1])).toContain('3 stored note record(s)');
  });

  it('reads as empty and explains itself when the query fails, rather than failing the request', async () => {
    // A resolution pass that threw because one row was unreadable would take an otherwise complete
    // assessment down with it.
    const onError = vi.fn();
    const db = new FakePostgres({
      failOn: (sql) => (sql.startsWith('select body') ? new Error('connection terminated unexpectedly') : undefined),
    });
    const { log: notes } = log({ db, onError });

    expect(await notes.current()).toEqual([]);
    expect(onError).toHaveBeenCalledWith('read every note', expect.any(Error));
  });

  it('lets a failed append fail, because a write that was reported as saved and was not is worse', async () => {
    const db = new FakePostgres({
      failOn: (sql) => (sql.startsWith('insert') ? new Error('read-only role') : undefined),
    });
    const { log: notes } = log({ db, onError: vi.fn() });

    await expect(notes.append(note())).rejects.toThrow('read-only role');
  });

  it('does not return another assessment\'s records when a definition is named', async () => {
    const { log: notes } = log();
    await notes.append(note({ id: 'a', definitionId: 'def-a' }));
    await notes.append(note({ id: 'b', definitionId: 'def-b' }));
    await notes.append(note({ id: 'none' }));

    expect((await notes.current('def-a')).map((record) => record.id)).toEqual(['a']);
    expect((await notes.current('def-b')).map((record) => record.id)).toEqual(['b']);
    expect((await notes.current(null)).map((record) => record.id)).toEqual(['none']);
    expect((await notes.historyFor('DG-02-01', 'def-a')).map((record) => record.id)).toEqual(['a']);
    expect((await notes.historyFor('DG-02-01', 'def-b')).map((record) => record.id)).toEqual(['b']);
  });
});
