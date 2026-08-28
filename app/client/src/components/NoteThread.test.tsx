// The thread, rendered, because two of its claims are only true if the markup says them.
//
// A correction is meaningless on its own — "December, not November" — so the note it corrects has to be
// quoted above it rather than linked from it. And there must be no control anywhere on the pane that
// edits or removes a note: the API has neither, and a button that offered one would be promising
// something the record refuses.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { NoteThreadView } from './NoteThread';
import type { Note, NoteSubject } from '../api/types';

const SUBJECT: NoteSubject = { kind: 'control', id: 'SEC-01' };

const FIRST: Note = {
  id: 'note-1',
  subject: SUBJECT,
  body: 'Both clusters this fails on are in the lab account, which closes in November.',
  by: 'ana@example.com',
  at: '2026-03-01T09:00:00.000Z',
  observedIn: 'run-7',
};

const CORRECTION: Note = {
  id: 'note-2',
  subject: SUBJECT,
  body: 'The account closes in December, not November.',
  by: 'raj@example.com',
  at: '2026-03-02T09:00:00.000Z',
  corrects: 'note-1',
};

const view = (notes: readonly Note[], over: Partial<Parameters<typeof NoteThreadView>[0]> = {}): string =>
  renderToStaticMarkup(
    <NoteThreadView
      subject={SUBJECT}
      label="Notes on this requirement"
      notes={notes}
      minNote={10}
      maxNote={4000}
      saving={false}
      onWrite={() => Promise.resolve(true)}
      {...over}
    />
  );

/** Every button on the pane, in order, which is the whole of what it offers a reader to press. */
function controls(markup: string): readonly string[] {
  return [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) => match[1] ?? '');
}

describe('a thread', () => {
  it('shows each note with who wrote it and which run they were reading', () => {
    const markup = view([FIRST]);

    expect(markup).toContain('are in the lab account');
    expect(markup).toContain('ana@example.com');
    expect(markup).toContain('run-7');
  });

  it('quotes what a correction corrects, because the correction says nothing alone', () => {
    const markup = view([FIRST, CORRECTION]);

    expect(markup).toContain('Corrects:');
    // Both readings present, and the earlier one above the later.
    expect(markup.indexOf('closes in November')).toBeLessThan(markup.indexOf('closes in December, not November'));
  });

  it('keeps the corrected note readable rather than striking it out or hiding it', () => {
    const markup = view([FIRST, CORRECTION]);

    expect(markup).not.toContain('<del');
    expect(markup).not.toContain('line-through');
  });

  it('counts the thread beside its heading', () => {
    expect(view([FIRST, CORRECTION])).toContain('2 notes');
  });
});

describe('what it does not offer', () => {
  it('has no way to edit a note and no way to delete one', () => {
    // Read off the controls rather than the whole pane: the copy under the box says the words "edit"
    // and "delete" on purpose, and a search of the markup would find its own explanation.
    expect(controls(view([FIRST]))).toEqual(['Correct this', 'Write it down']);
  });

  it('says a note cannot be unsaid, before somebody writes one they would retract', () => {
    const markup = view([]);

    expect(markup).toContain('no edit and no delete');
  });

  it('says it changes nothing, so nobody writes a note instead of parking a finding', () => {
    expect(view([])).toContain('Changes nothing but the record.');
  });
});

describe('the box', () => {
  it('will not submit an empty note', () => {
    // Disabled rather than refused on submit: the server would answer with its own sentence, and a
    // reader who has typed nothing has not made a mistake worth a message.
    expect(view([])).toContain('disabled=""');
  });

  it('offers one box at a time, so a half-written correction has one place to go', () => {
    // Both boxes carry the same label text, so counting the labels is counting the boxes.
    const markup = view([FIRST]);

    expect(markup.match(/Write a note/g)).toHaveLength(1);
  });

  it('shows the server’s own sentence when a write was refused', () => {
    const markup = view([], { writeError: 'No note with id note-9 is filed against this control.' });

    expect(markup).toContain('No note with id note-9');
  });

  it('warns when notes are being kept somewhere a restart empties', () => {
    const markup = view([], { durabilityNote: 'Notes are being kept in memory on this installation.' });

    expect(markup).toContain('kept in memory');
  });

  it('says why the thread could not be read, rather than showing an empty one as if it were', () => {
    expect(view([], { error: 'The request failed with status 500.' })).toContain('status 500');
  });
});

/*
 * The same thread as part of an artefact rather than part of the app.
 *
 * The report renders one of these per finding, which put a box asking the holder of a printed page to
 * write something under every one of them, and — measured on the labs report — the warning that notes
 * are held in memory thirty-four times. That warning is true and is advice to whoever runs the app,
 * which is not who is reading a report.
 */
describe('a thread on a report', () => {
  const printed = (notes: readonly Note[], over = {}): string => view(notes, { writable: false, ...over });

  it('reads what was written', () => {
    expect(printed([FIRST])).toContain('are in the lab account');
  });

  it('offers nothing to press, there being nothing here anybody may change', () => {
    expect(controls(printed([FIRST, CORRECTION]))).toEqual([]);
  });

  it('asks the holder of a printed page for nothing', () => {
    const markup = printed([FIRST]);

    expect(markup).not.toContain('Write a note');
    expect(markup).not.toContain('<textarea');
  });

  it('keeps a correction quoting what it corrects, since that is the record and not a control', () => {
    expect(printed([FIRST, CORRECTION])).toContain('Corrects:');
  });

  it('does not print advice about where the notes are being kept', () => {
    // Once per finding on a report is thirty-four copies of a sentence for somebody who is not reading it.
    expect(printed([FIRST], { durabilityNote: 'Notes are being kept in memory on this installation.' })).not.toContain(
      'kept in memory'
    );
  });

  it('says nothing at all while the thread is still being read', () => {
    // Live, "reading what has been written" is a promise the box is coming. Printed, nothing is coming.
    expect(printed([], { reading: true })).not.toContain('Reading what has been written');
  });

  it('is withheld until the thread has been read, so nobody writes beside notes they cannot see', () => {
    const markup = view([], { reading: true });

    expect(markup).toContain('Reading what has been written');
    expect(controls(markup)).toEqual([]);
  });
});
