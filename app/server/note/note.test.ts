// What a note will and will not accept.
//
// Most of these are about the two things that could quietly make the record useless. A note whose
// subject comes from the body could be filed against a requirement the writer was never looking at,
// with the audit trail naming the one in the URL. And a correction pointing at a note on some other
// subject reads, on both threads, as correcting something the reader cannot see.

import { describe, expect, it } from 'vitest';
import {
  InvalidNoteError,
  MAX_NOTE,
  MIN_NOTE,
  NOTE_SUBJECT_KINDS,
  draftFrom,
  noted,
  threaded,
  type Note,
  type NoteSubject,
} from './note.js';

const CONTROL: NoteSubject = { kind: 'control', id: 'SEC-01' };
const RUN: NoteSubject = { kind: 'run', id: 'scan-1' };
const BODY = 'Both clusters this fails on are in the lab account, which closes in November.';

const note = (over: Partial<Note> = {}): Note => ({
  id: 'note-1',
  subject: CONTROL,
  body: BODY,
  by: 'ana@example.com',
  at: new Date('2026-03-01T09:00:00.000Z'),
  ...over,
});

describe('drafting a note', () => {
  it('takes the subject from the caller and not from the body', () => {
    // The body naming its own subject is how a note gets filed against a requirement the writer was
    // never reading, with the trail recording the one the URL named.
    const draft = draftFrom({ body: BODY, subject: { kind: 'control', id: 'SEC-99' } }, CONTROL);

    expect(draft.subject).toEqual(CONTROL);
  });

  it('refuses a subject with no id, rather than filing a note nobody can find', () => {
    expect(() => draftFrom({ body: BODY }, { kind: 'pillar', id: '  ' })).toThrow(InvalidNoteError);
  });

  it('refuses a note too short to tell the next reader anything', () => {
    expect(() => draftFrom({ body: 'ok' }, CONTROL)).toThrow(/at least 10 characters/);
  });

  it('accepts a short note that says something, because a high floor collects no notes at all', () => {
    expect(draftFrom({ body: 'Lab account only.' }, CONTROL).body).toBe('Lab account only.');
    expect(MIN_NOTE).toBe(10);
  });

  it('refuses a document pasted into a thread', () => {
    expect(() => draftFrom({ body: 'x'.repeat(MAX_NOTE + 1) }, CONTROL)).toThrow(/at most 4000/);
  });

  it('trims, so trailing whitespace is not what clears the floor', () => {
    expect(() => draftFrom({ body: `        ${'a'.repeat(4)}        ` }, CONTROL)).toThrow(InvalidNoteError);
  });

  it('records the run the writer was reading, for a note about a requirement', () => {
    const draft = draftFrom({ body: BODY }, CONTROL, { observedIn: 'scan-4' });

    expect(draft.observedIn).toBe('scan-4');
  });

  it('lets the body name a different run than the one being read', () => {
    // Somebody writing about last month's run from this month's page. The context is a default rather
    // than an override, because the writer knows which run they mean and the page only guesses.
    const draft = draftFrom({ body: BODY, observedIn: 'scan-2' }, CONTROL, { observedIn: 'scan-4' });

    expect(draft.observedIn).toBe('scan-2');
  });

  it('does not record a run against a note about a run, which is the same fact twice', () => {
    const draft = draftFrom({ body: BODY, observedIn: 'scan-9' }, RUN, { observedIn: 'scan-9' });

    expect(draft.observedIn).toBeUndefined();
  });

  it('accepts a correction that names a note on this subject', () => {
    const draft = draftFrom({ body: BODY, corrects: 'note-1' }, CONTROL, { existing: [note()] });

    expect(draft.corrects).toBe('note-1');
  });

  it('refuses a correction of a note filed somewhere else', () => {
    expect(() => draftFrom({ body: BODY, corrects: 'note-7' }, CONTROL, { existing: [note()] })).toThrow(
      /No note with id note-7/
    );
  });

  it('refuses a correction when the subject has no notes at all', () => {
    expect(() => draftFrom({ body: BODY, corrects: 'note-1' }, CONTROL)).toThrow(InvalidNoteError);
  });

  it('treats an empty correction as no correction, rather than as an unknown note', () => {
    expect(draftFrom({ body: BODY, corrects: '   ' }, CONTROL).corrects).toBeUndefined();
  });

  it('ignores a body that is not an object at all', () => {
    expect(() => draftFrom('a note', CONTROL)).toThrow(InvalidNoteError);
    expect(() => draftFrom(undefined, CONTROL)).toThrow(InvalidNoteError);
  });
});

describe('the note that gets stored', () => {
  it('carries who wrote it and when, from the caller rather than from the body', () => {
    const at = new Date('2026-03-02T10:00:00.000Z');
    const stored = noted(draftFrom({ body: BODY }, CONTROL), 'raj@example.com', 'note-9', at);

    expect(stored).toEqual({ id: 'note-9', subject: CONTROL, body: BODY, by: 'raj@example.com', at });
  });

  it('omits what was not given, rather than storing undefined fields', () => {
    const stored = noted(draftFrom({ body: BODY }, CONTROL), 'ana@example.com', 'note-9', new Date());

    expect('observedIn' in stored).toBe(false);
    expect('corrects' in stored).toBe(false);
  });
});

describe('a thread', () => {
  it('reads oldest first, because a correction makes no sense above what it corrects', () => {
    const first = note({ id: 'note-1', at: new Date('2026-03-01T09:00:00.000Z') });
    const second = note({ id: 'note-2', at: new Date('2026-03-02T09:00:00.000Z'), corrects: 'note-1' });

    expect(threaded([second, first]).map((entry) => entry.id)).toEqual(['note-1', 'note-2']);
  });

  it('orders two notes written in the same millisecond the same way on every request', () => {
    const at = new Date('2026-03-01T09:00:00.000Z');
    const b = note({ id: 'note-b', at });
    const a = note({ id: 'note-a', at });

    expect(threaded([b, a]).map((entry) => entry.id)).toEqual(['note-a', 'note-b']);
    expect(threaded([a, b]).map((entry) => entry.id)).toEqual(['note-a', 'note-b']);
  });

  it('does not mutate what it was given', () => {
    const notes = [note({ id: 'note-2', at: new Date('2026-03-02T09:00:00.000Z') }), note({ id: 'note-1' })];

    threaded(notes);

    expect(notes.map((entry) => entry.id)).toEqual(['note-2', 'note-1']);
  });
});

describe('the subjects', () => {
  it('is the three places a reader forms an opinion, and no free-form fourth', () => {
    expect(NOTE_SUBJECT_KINDS).toEqual(['run', 'pillar', 'control']);
  });
});
