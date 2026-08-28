// What somebody noticed, written down where they noticed it.
//
// Every other record in this app answers a question the app asked: is this requirement met, who
// answers for it, what is being done about it. A note answers a question nobody asked — "the two
// clusters this fails on are both in the lab account that closes in November" — and that observation
// is the single most perishable thing in a review. It is made while reading a run, it is worth
// nothing a fortnight later if nobody wrote it down, and today it goes into a chat message and is
// gone by the next meeting.
//
// Three properties, and each is a refusal.
//
// A note is append-only. There is no edit and no delete, so a reading recorded in March cannot be
// improved in June into something that was never said in March. That is not fastidiousness: a note is
// evidence about what was known at a time, and the whole reason to keep one is that the person who
// reads it later is asking what somebody understood then. A note that could be edited is a note whose
// earlier reading has been lost, and nothing records that it was there.
//
// A note cannot be wrong in a way nothing can say. Append-only would otherwise mean a mistaken note
// standing for ever with no way to mark it, so a note may name the note it corrects. The earlier one
// stays and stays readable; the surface says one corrects the other. That is what a correction is in
// every other record here, and it is why `corrects` is a note id rather than a flag on the old note.
//
// A note cannot move anything. It carries no state, no disposition and no owner, and nothing in the
// app reads one to decide anything. Somebody will eventually want a note that parks a finding or
// closes an action, and that want is exactly why this record has to stay inert: the moment prose has
// consequences, prose gets written to obtain them. A decision is a decision and an action is an
// action, both of which exist and both of which are attributed and dated.

/**
 * What a note is about.
 *
 * Three kinds because those are the three places a reader forms an opinion. A run is where somebody
 * says "this one ran during the migration, so half of the compute findings are noise". A pillar is
 * where somebody says "we deliberately do not use Unity Catalog for the archive". A requirement is
 * where the detail lives, and it is the level the other two cannot substitute for.
 *
 * Not a free-form string. A note filed against `pilar/data-governance` is a note that is never read
 * again, and a typo is the ordinary way that happens.
 */
export type NoteSubjectKind = 'run' | 'pillar' | 'control';

export const NOTE_SUBJECT_KINDS: readonly NoteSubjectKind[] = ['run', 'pillar', 'control'];

export interface NoteSubject {
  readonly kind: NoteSubjectKind;
  readonly id: string;
}

export interface Note {
  readonly id: string;
  readonly subject: NoteSubject;
  /**
   * The run the writer was reading, for a note about a pillar or a requirement.
   *
   * By reference rather than as a copy of what it said, so the observation can be checked against
   * what was actually measured that day. It is what makes "this only fails in the sandbox" a claim a
   * later reader can test rather than a remark.
   *
   * Absent for a note about a run, where the subject is the run.
   */
  readonly observedIn?: string;
  /** The note this one corrects. The corrected note is kept and stays readable. */
  readonly corrects?: string;
  readonly body: string;
  readonly by: string;
  readonly at: Date;
  /** The assessment this note was written under. Absent means it named none. */
  readonly definitionId?: string;
}

export class InvalidNoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidNoteError';
  }
}

/**
 * The shortest note worth keeping, which is much shorter than the shortest decision.
 *
 * Ten characters rather than the twenty a decision's reason or an action's outcome needs, and the
 * difference is deliberate. Those two are required fields on a record somebody has to justify; a note
 * is voluntary, and a floor long enough to force a sentence is a floor that stops people writing
 * notes at all. "Lab account only" is eighteen characters and is worth more than nothing.
 *
 * There is a floor at all because an empty note and a note reading "ok" are the same thing: a row in
 * a thread that costs the next reader a line and tells them nothing.
 */
export const MIN_NOTE = 10;

/** The longest, so one paste of a stack trace cannot make a thread unreadable. */
export const MAX_NOTE = 4000;

export interface NoteDraft {
  readonly subject: NoteSubject;
  readonly observedIn?: string;
  readonly corrects?: string;
  readonly body: string;
}

export interface NoteContext {
  /** The run being read, applied to a pillar or requirement note that does not name one. */
  readonly observedIn?: string;
  /** Notes already filed against this subject, so a correction must name one of them. */
  readonly existing?: readonly Note[];
}

/**
 * A request body into a draft, or a sentence saying what to fix.
 *
 * The subject comes from the route rather than the body, which is why it is a parameter here: a note
 * whose body could name its own subject is a note that can be filed against a requirement the caller
 * was never looking at, and the audit target would be the one the URL named.
 */
export function draftFrom(body: unknown, subject: NoteSubject, context: NoteContext = {}): NoteDraft {
  if (subject.id.trim() === '') {
    throw new InvalidNoteError(`A note about a ${subject.kind} has to name which ${subject.kind}.`);
  }

  const fields = body != null && typeof body === 'object' ? (body as Record<string, unknown>) : {};

  const text = typeof fields.body === 'string' ? fields.body.trim() : '';
  if (text.length < MIN_NOTE) {
    throw new InvalidNoteError(
      `Write at least ${String(MIN_NOTE)} characters. A note is read by somebody who was not in the room, and a ` +
        'thread of one-word notes costs them a line each and tells them nothing.'
    );
  }
  if (text.length > MAX_NOTE) {
    throw new InvalidNoteError(
      `That is ${String(text.length)} characters, and a note may be at most ${String(MAX_NOTE)}. Anything longer is ` +
        'a document, and a document pasted into a thread is a thread nobody reads to the bottom of.'
    );
  }

  const corrects = typeof fields.corrects === 'string' ? fields.corrects.trim() : undefined;
  if (corrects != null && corrects !== '') {
    // Checked against this subject's own notes rather than against every note, which is the same
    // reason a dependency is refused across plans: a correction pointing at a note on another
    // requirement reads, on both threads, as a correction of something the reader cannot see.
    const known = context.existing ?? [];
    if (!known.some((note) => note.id === corrects)) {
      throw new InvalidNoteError(
        `No note with id ${corrects} is filed against this ${subject.kind}. A correction names the note it corrects, ` +
          'so that both stay readable and neither is quietly replaced.'
      );
    }
  }

  // A run note's subject is the run, so naming it again would be the same fact in two fields that can
  // disagree. The other two take it from the body if given and from the reader's context otherwise.
  const observed =
    subject.kind === 'run'
      ? undefined
      : ((typeof fields.observedIn === 'string' ? fields.observedIn.trim() : undefined) ?? context.observedIn);

  return {
    subject,
    body: text,
    ...(observed != null && observed !== '' ? { observedIn: observed } : {}),
    ...(corrects != null && corrects !== '' ? { corrects } : {}),
  };
}

/** A draft and who is writing it into the note that gets stored. */
export function noted(draft: NoteDraft, by: string, id: string, at: Date): Note {
  return { id, subject: draft.subject, body: draft.body, by, at, ...spread(draft) };
}

function spread(draft: NoteDraft): Partial<Pick<Note, 'observedIn' | 'corrects'>> {
  return {
    ...(draft.observedIn != null ? { observedIn: draft.observedIn } : {}),
    ...(draft.corrects != null ? { corrects: draft.corrects } : {}),
  };
}

/**
 * A thread, oldest first.
 *
 * The opposite order from the decision register and the audit trail, and for the opposite reason.
 * Those are records somebody scans for the latest state, so the newest row is the one they want. A
 * thread is read as a conversation: a correction makes no sense above the note it corrects, and
 * reading a discussion backwards is a thing no reader does voluntarily.
 *
 * Ties broken on the id so the order is total. Two notes written in the same millisecond is a paste
 * of two observations, and an unstable sort would show them in a different order on each request.
 */
export function threaded(notes: readonly Note[]): readonly Note[] {
  return [...notes].sort((a, b) => a.at.getTime() - b.at.getTime() || a.id.localeCompare(b.id));
}
