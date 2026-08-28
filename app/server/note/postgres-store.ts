// Durable notes, in the Lakebase schema the app owns.
//
// One table, insert-only, and the insert-only part is the record's whole guarantee rather than an
// implementation choice — there is no update statement in this file and there is no delete, so the
// append-only rule holds for anything that can reach the table rather than only for callers who went
// through the domain.
//
// The subject is split into two columns, `subject_kind` and `subject_id`, rather than read out of the
// body. A thread is fetched by subject on every page that shows one, and a query that had to parse
// jsonb to find its rows would be the one read in this app that gets slower as prose accumulates.
// The body is still the writer of record: the columns are indexed copies of two of its fields, which
// is the same arrangement `improvement_actions` uses for `plan_id`.

import { digestOf } from '../records/digest.js';
import type { Postgres } from '../store/postgres.js';
import type { Note, NoteSubject, NoteSubjectKind } from './note.js';
import { threaded } from './note.js';
import type { NoteStore } from './store.js';
import { applyScope, type AssessmentScope } from '../store/assessment-scope.js';

export interface PostgresNoteStoreOptions {
  readonly db: Postgres;
  readonly onError?: (operation: string, error: unknown) => void;
}

export class PostgresNoteStore implements NoteStore {
  readonly durable = true;

  constructor(private readonly options: PostgresNoteStoreOptions) {}

  async add(note: Note): Promise<void> {
    const { db } = this.options;
    // `on conflict do nothing` rather than a refusal, for the reason the interface gives: the only way
    // the same id arrives twice is a retry of a request whose answer was lost, and the second attempt
    // is describing the note the first one already wrote.
    await db.query(
      `insert into ${db.schema}.notes (id, subject_kind, subject_id, noted_at, body, digest, definition_id)
         values ($1, $2, $3, $4, $5::jsonb, $6, $7)
       on conflict (id) do nothing`,
      [note.id, note.subject.kind, note.subject.id, note.at, JSON.stringify(note), digestOf(note), note.definitionId ?? null]
    );
  }

  async for(subject: NoteSubject, scope?: AssessmentScope): Promise<readonly Note[]> {
    const operation = `read notes about ${subject.kind} ${subject.id}`;
    const scoped = applyScope('where subject_kind = $1 and subject_id = $2', [subject.kind, subject.id], scope);
    const rows = await this.read(operation, scoped.fragment, scoped.values);
    return threaded(this.revived(rows, operation));
  }

  async counts(kind: NoteSubjectKind, scope?: AssessmentScope): Promise<Readonly<Record<string, number>>> {
    const { db } = this.options;
    const operation = `count notes about each ${kind}`;
    try {
      const scoped = applyScope('where subject_kind = $1', [kind], scope);
      // Counted in the database, and the reason is the one thing about this table nothing bounds.
      //
      // Every other register here is capped by the catalogue times retention over a cadence, so its
      // size can be derived and its read measured against the derivation. A note is written when
      // somebody has something to say. Transferring a row per note was cheap when measured — 10,672
      // narrow rows and 3.6 ms, because the column is a `text` id rather than a body — but the volume
      // it was measured at is a stand-in rather than a derivation, so what that number bounds is an
      // assumption. `group by` costs nothing and removes the question.
      const { rows } = await db.query<{ subject_id: string; tally: string }>(
        `select subject_id, count(*)::text as tally from ${db.schema}.notes ${scoped.fragment} group by subject_id`,
        scoped.values
      );
      const tally: Record<string, number> = {};
      // `count(*)` is `bigint`, which the driver hands over as a string rather than risk a silent
      // precision loss above 2^53. Cast in SQL and parsed here, so nothing depends on which it did.
      for (const row of rows) tally[row.subject_id] = Number(row.tally);
      return tally;
    } catch (error) {
      this.options.onError?.(operation, error);
      return {};
    }
  }

  async ofKind(kind: NoteSubjectKind, scope?: AssessmentScope): Promise<readonly Note[]> {
    const operation = `read notes about each ${kind}`;
    const scoped = applyScope('where subject_kind = $1', [kind], scope);
    const rows = await this.read(operation, scoped.fragment, scoped.values);
    return threaded(this.revived(rows, operation));
  }

  private async read(operation: string, where: string, values: readonly unknown[]): Promise<unknown[]> {
    const { db } = this.options;
    try {
      const { rows } = await db.query<{ body: unknown }>(
        `select body from ${db.schema}.notes ${where} order by noted_at asc`,
        values
      );
      return rows.map((row) => row.body);
    } catch (error) {
      // A failed read reads as empty and says so through onError, like every other store here. A run
      // page that throws because one note is unreadable is worse than one missing a note and logging it.
      this.options.onError?.(operation, error);
      return [];
    }
  }

  private revived(rows: readonly unknown[], operation: string): readonly Note[] {
    const notes = rows.map(revive);
    const unreadable = notes.filter((note) => note == null).length;
    if (unreadable > 0) {
      // Counted and reported once rather than per row: a shape change makes every row unreadable at
      // the same moment, and the number is the useful part.
      this.options.onError?.(operation, new Error(`${String(unreadable)} stored note row(s) could not be read`));
    }
    return notes.filter((note): note is Note => note != null);
  }
}

function revive(raw: unknown): Note | undefined {
  if (raw == null || typeof raw !== 'object') return undefined;
  const candidate = raw as Note & { at: string | Date };
  if (typeof candidate.id !== 'string' || typeof candidate.body !== 'string') return undefined;
  if (typeof candidate.by !== 'string') return undefined;

  const subject = candidate.subject;
  if (subject == null || typeof subject !== 'object') return undefined;
  if (typeof subject.kind !== 'string' || typeof subject.id !== 'string') return undefined;

  const at = new Date(candidate.at);
  // Unreadable rather than dated now. The date is what orders the thread and what a retention sweep
  // measures, and a note that arrives claiming to have been written this morning is worse than one
  // that is missing and has been logged.
  if (Number.isNaN(at.getTime())) return undefined;

  return { ...candidate, subject: { kind: subject.kind, id: subject.id }, at };
}
