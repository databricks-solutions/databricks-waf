// The sentences the import surface says, held to what they claim.
//
// Worth testing separately from the component for the reason the module exists: each of these can be
// wrong while rendering perfectly, and the reader is using them to decide whether a number on a score
// page is evidence. The age sentence has a fixed `now` for the same reason — a test that passed today
// and failed tomorrow would be removed rather than fixed.

import { describe, expect, it } from 'vitest';
import type { EvidenceImport, EvidenceImportVerdict } from '../api/types';
import { ageSentence, collectedBySentence, durabilityWarning, importedSentence, noteKey, shortDigest, tiersSentence, verdictTitle } from './import-language';

const NOW = new Date('2026-08-03T12:00:00Z');

function imported(overrides: Partial<EvidenceImport> = {}): EvidenceImport {
  return {
    digest: `sha256:${'ab'.repeat(32)}`,
    generatedAt: '2026-08-02T10:00:00Z',
    importedAt: '2026-08-03T11:00:00Z',
    importedBy: 'assessor@example.com',
    collectedBy: 'admin@example.com',
    workspaceTier: true,
    accountTier: true,
    observed: 28,
    refused: 1,
    requirements: 55,
    scriptVersion: '1',
    cautions: [],
    ...overrides,
  };
}

function verdict(overrides: Partial<EvidenceImportVerdict> = {}): EvidenceImportVerdict {
  return { accepted: true, refusals: [], cautions: [], imported: imported(), ...overrides };
}

describe('the heading over a verdict', () => {
  it('says imported when it was, without claiming it was clean', () => {
    expect(verdictTitle(verdict())).toBe('Imported');
    expect(verdictTitle(verdict({ cautions: [{ reason: 'stale', message: 'x' }] }))).toBe(
      'Imported, with things worth reading'
    );
  });

  it('counts the reasons when it was refused, so the reader knows how many fixes there are', () => {
    expect(verdictTitle(verdict({ accepted: false, refusals: [{ reason: 'expired', message: 'x' }] }))).toBe(
      'Not imported, for one reason'
    );
    expect(
      verdictTitle(
        verdict({
          accepted: false,
          refusals: [
            { reason: 'expired', message: 'x' },
            { reason: 'wrong-workspace', message: 'y' },
          ],
        })
      )
    ).toBe('Not imported, for 2 reasons');
  });
});

describe('what an import answered', () => {
  it('states the refused calls as unmeasured rather than leaving them out', () => {
    expect(importedSentence(imported())).toBe(
      '28 readings across 55 requirements. 1 call was refused, so those stay unmeasured.'
    );
  });

  it('says nothing about refusals when there were none', () => {
    expect(importedSentence(imported({ refused: 0 }))).toBe('28 readings across 55 requirements.');
  });

  it('agrees with itself in the singular', () => {
    expect(importedSentence(imported({ observed: 1, requirements: 1, refused: 2 }))).toBe(
      '1 reading across 1 requirement. 2 calls were refused, so those stay unmeasured.'
    );
  });
});

describe('which tiers ran', () => {
  it('names the tier that did not, because that is why something is still unanswered', () => {
    expect(tiersSentence(imported({ accountTier: false }))).toBe('The workspace tier ran; the account tier did not.');
    expect(tiersSentence(imported({ workspaceTier: false }))).toBe('The account tier ran; the workspace tier did not.');
    expect(tiersSentence(imported())).toBe('Both the workspace and account tiers ran.');
  });
});

describe('who collected a reading', () => {
  it('distinguishes the two identities, which are two people in the ordinary case', () => {
    expect(collectedBySentence(imported())).toBe('Collected by admin@example.com, uploaded by assessor@example.com.');
  });

  it('says why the collector is unknown rather than showing a blank', () => {
    const sentence = collectedBySentence(imported({ collectedBy: undefined }));
    expect(sentence).toContain('not recorded');
    expect(sentence).toContain('expected for an account-only collection');
  });
});

describe('how old a collection is', () => {
  it('counts whole days and says how long is left', () => {
    expect(ageSentence('2026-08-01T12:00:00Z', 30, NOW)).toBe('Collected 2 days ago, 28 days before it expires.');
  });

  it('says today rather than nothing', () => {
    expect(ageSentence('2026-08-03T01:00:00Z', 30, NOW)).toBe('Collected today.');
  });

  it('says it is past the window rather than reporting negative days left', () => {
    expect(ageSentence('2026-06-01T12:00:00Z', 30, NOW)).toBe(
      'Collected 63 days ago, so it is past the 30 days a collection is accepted for.'
    );
  });

  it('says the timestamp is unreadable rather than producing NaN', () => {
    expect(ageSentence('not a date', 30, NOW)).toBe('Collected at an unreadable time.');
  });
});

describe('the rest', () => {
  it('shortens a digest to something two people can compare by eye', () => {
    expect(shortDigest(`sha256:${'ab'.repeat(32)}`)).toBe('abababababab');
  });

  it('warns only when nothing is kept, and says what would be lost', () => {
    expect(durabilityWarning(true)).toBeUndefined();
    expect(durabilityWarning(false)).toContain('lost when the app restarts');
  });
});

describe('a note’s list key', () => {
  it('is distinct for two notes that share a reason', () => {
    // The case: neither tier named a collecting user, so `checkTiers` emits two `unattributed` notes
    // with different sentences. One key for both would have React keep one and drop the other.
    const notes = [{ reason: 'unattributed' }, { reason: 'unattributed' }];
    const keys = notes.map((note, at) => noteKey(note, at));

    expect(new Set(keys).size).toBe(2);
  });

  it('distinguishes notes with different reasons too', () => {
    expect(noteKey({ reason: 'stale' }, 0)).not.toBe(noteKey({ reason: 'unattributed' }, 0));
  });
});
