import { describe, expect, it } from 'vitest';
import { noteCountPhrase, writtenWhen } from './note-language';

describe('how many notes something carries', () => {
  it('says nothing at all for a subject nobody has written about', () => {
    // Not "0 notes". Most runs have none, and a column of zeroes spends width saying so per row.
    expect(noteCountPhrase({}, 'run-1')).toBeUndefined();
    expect(noteCountPhrase(undefined, 'run-1')).toBeUndefined();
  });

  it('counts one in the singular, which is the commonest case there is', () => {
    expect(noteCountPhrase({ 'run-1': 1 }, 'run-1')).toBe('1 note');
  });

  it('counts more in the plural', () => {
    expect(noteCountPhrase({ 'run-1': 4 }, 'run-1')).toBe('4 notes');
  });
});

describe('when a note was written', () => {
  it('is the reader’s own locale rather than an ISO string', () => {
    const shown = writtenWhen('2026-03-01T09:00:00.000Z');

    expect(shown).not.toContain('T');
    expect(shown).toContain('2026');
  });

  it('shows an unreadable date as it arrived rather than inventing a plausible one', () => {
    expect(writtenWhen('the third of never')).toBe('the third of never');
  });
});
