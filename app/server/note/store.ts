// Where notes are kept.
//
// The simplest store in the app, and the interface says why: one write, three reads, and no update or
// delete anywhere. That is not an omission to be filled in later — a note is append-only, and the
// cheapest way to keep it that way for ever is for the only way to change one to not exist.
//
// The same two-implementation shape as the other stores. The in-memory one is a fallback the UI warns
// about rather than a reasonable place to run from: a lost scan can be re-run by pressing a button,
// and a lost note is an observation somebody made once while reading something they will not read
// again.

import type { Note, NoteSubject } from './note.js';
import { threaded } from './note.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

export interface NoteStore {
  /** True when notes survive a process restart. Surfaced in the UI, never assumed. */
  readonly durable: boolean;

  /**
   * Appends a note. An id already present is ignored rather than refused.
   *
   * Ignored because an id that arrives twice is the same note twice: it is minted per note, so the
   * second attempt is a write being retried after an answer was lost rather than a second thing
   * somebody wrote. Refusing it would turn a delivery problem into an error message about a note that
   * exists and says what its author wanted it to say.
   *
   * This does not make writing a note idempotent from outside. A resubmitted POST mints a new id and
   * appends a second note saying the same thing, and the record has no way to tell that from somebody
   * writing the same sentence twice — which is the reading it takes, because a note is inert prose and
   * two identical lines in a thread cost a reader one line. An idempotency key on the request would
   * remove the duplicate and buy a 201 that describes bytes other than the ones stored, which is the
   * more expensive of the two.
   */
  add(note: Note): Promise<void>;

  /** Every note about one subject, oldest first, because a thread is read as a conversation. */
  for(subject: NoteSubject, scope?: AssessmentScope): Promise<readonly Note[]>;

  /**
   * How many notes each subject of one kind carries.
   *
   * So a list of pillars can show which ones have been written about without fetching every thread.
   * A count rather than the notes themselves: the pillars page shows six rows, and six threads is six
   * requests for prose nobody has opened yet.
   */
  counts(kind: NoteSubject['kind'], scope?: AssessmentScope): Promise<Readonly<Record<string, number>>>;

  /**
   * Every note of one kind, oldest first across subjects.
   *
   * What the report asks: it used to fetch one thread per requirement. The per-subject read stays
   * for a pane that shows one thing; this is the collection that pane cannot share.
   */
  ofKind(kind: NoteSubject['kind'], scope?: AssessmentScope): Promise<readonly Note[]>;
}

/**
 * Notes in memory, for a demo and for tests.
 *
 * Keyed by subject so `for` is a lookup rather than a scan, which matters not at all at this size and
 * keeps the two implementations answering the same shape of question.
 */
export class InMemoryNoteStore implements NoteStore {
  readonly durable = false;

  private readonly notes = new Map<string, Note>();

  add(note: Note): Promise<void> {
    if (!this.notes.has(note.id)) this.notes.set(note.id, note);
    return Promise.resolve();
  }

  for(subject: NoteSubject, scope?: AssessmentScope): Promise<readonly Note[]> {
    const mine = [...this.notes.values()].filter(
      (note) =>
        note.subject.kind === subject.kind &&
        note.subject.id === subject.id &&
        inScope(note.definitionId, scope)
    );
    return Promise.resolve(threaded(mine));
  }

  counts(kind: NoteSubject['kind'], scope?: AssessmentScope): Promise<Readonly<Record<string, number>>> {
    const tally: Record<string, number> = {};
    for (const note of this.notes.values()) {
      if (note.subject.kind !== kind || !inScope(note.definitionId, scope)) continue;
      tally[note.subject.id] = (tally[note.subject.id] ?? 0) + 1;
    }
    return Promise.resolve(tally);
  }

  ofKind(kind: NoteSubject['kind'], scope?: AssessmentScope): Promise<readonly Note[]> {
    const mine = [...this.notes.values()].filter(
      (note) => note.subject.kind === kind && inScope(note.definitionId, scope)
    );
    return Promise.resolve(threaded(mine));
  }
}
