import { describe, expect, it } from 'vitest';
import { certainty, isUncertain, rangeSentence, tooLittleMeasured, unmeasuredBreakdown } from './score-range';
import type { Unmeasured } from '../api/types';

const NONE: Readonly<Record<Unmeasured, number>> = {
  attestation: 0,
  unreachable: 0,
  unbuilt: 0,
  unreadable: 0,
  disabled: 0,
};

describe('deciding whether a score needs qualifying', () => {
  it('says nothing when everything was measured', () => {
    expect(isUncertain({ low: 62.5, high: 62.5 })).toBe(false);
    expect(rangeSentence({ low: 62.5, high: 62.5 }, 0)).toBeUndefined();
  });

  it('says nothing when there is no score at all', () => {
    expect(isUncertain(undefined)).toBe(false);
    expect(rangeSentence(undefined, 12)).toBeUndefined();
  });

  it('ignores a range too narrow to matter, so a rounding artefact is not a caveat', () => {
    expect(isUncertain({ low: 74.9, high: 75 })).toBe(false);
  });
});

describe('how strongly a score is qualified', () => {
  it('grades the caveat by how much is unknown', () => {
    expect(certainty({ low: 70, high: 78 })).toBe('slight');
    expect(certainty({ low: 50, high: 80 })).toBe('substantial');
    expect(certainty({ low: 1, high: 99 })).toBe('mostly');
  });

  it('withholds a verdict only in the widest band, not wherever anything is unmeasured', () => {
    // `isUncertain` is the wrong predicate for this and was the one the score cards used: it is true
    // of a range six points wide, where the sentence states the span and reads as a measured score.
    expect(tooLittleMeasured({ low: 68, high: 74 })).toBe(false);
    expect(isUncertain({ low: 68, high: 74 })).toBe(true);

    expect(tooLittleMeasured({ low: 50, high: 80 })).toBe(false);
    expect(tooLittleMeasured({ low: 1, high: 99 })).toBe(true);
    expect(tooLittleMeasured(undefined)).toBe(false);
  });

  it('tells the reader to stop reading the score when almost nothing was measured', () => {
    // The live case: security scored 50 from one requirement of 70.
    const sentence = rangeSentence({ low: 0.7, high: 99.3 }, 69);

    expect(sentence).toContain('Too little');
    expect(sentence).toContain('Read the findings rather than the score');
    expect(sentence).toContain('69 requirements without an answer');
  });

  it('states the span without alarm when most of the pillar was measured', () => {
    const sentence = rangeSentence({ low: 68, high: 74 }, 2);

    expect(sentence).toContain('between 68.0 and 74.0');
    expect(sentence).not.toContain('Too little');
  });

  it('agrees in number, so a single unknown does not read as a typo', () => {
    expect(rangeSentence({ low: 60, high: 80 }, 1)).toContain('1 requirement without an answer turns out');
    expect(rangeSentence({ low: 60, high: 80 }, 2)).toContain('2 requirements without an answer turn out');
  });

  it('names the subject it is talking about, so the estate is not called a pillar', () => {
    expect(rangeSentence({ low: 1, high: 99 }, 40, { subject: 'this estate' })).toContain('this estate');
  });
});

describe('naming the remedy for what is unknown', () => {
  it('leads with what the customer can act on today', () => {
    // Live reliability: 12 practice statements, 1 unreadable source.
    const sentence = rangeSentence({ low: 0, high: 92.3 }, 13, {
      by: { attestation: 12, unreachable: 0, unbuilt: 0, unreadable: 1, disabled: 0 },
    });

    expect(sentence).toContain('12 are practices only you can confirm');
    expect(sentence).toContain('1 could not be read from this workspace');
    expect(sentence?.indexOf('practices')).toBeLessThan(sentence?.indexOf('could not be read') ?? 0);
  });

  it('does not mention a category with nothing in it', () => {
    const sentence = rangeSentence({ low: 20, high: 80 }, 4, {
      by: { attestation: 4, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 },
    });

    expect(sentence).toContain('4 are practices only you can confirm');
    expect(sentence).not.toContain('automated check');
    expect(sentence).not.toContain('could not be read');
  });

  it("distinguishes our unfinished work from the customer's judgement", () => {
    // Presenting an unwritten check as a question only the customer can answer would ask
    // them to attest to something the app should simply have measured.
    expect(unmeasuredBreakdown({ attestation: 0, unreachable: 0, unbuilt: 3, unreadable: 0, disabled: 0 })).toContain(
      'no automated check in this version'
    );
  });

  it('says nothing when there is no breakdown to give', () => {
    expect(unmeasuredBreakdown(undefined)).toBeUndefined();
    expect(unmeasuredBreakdown({ attestation: 0, unreachable: 0, unbuilt: 0, unreadable: 0, disabled: 0 })).toBeUndefined();
  });

  it('agrees with itself about number when a reason has exactly one requirement', () => {
    // Four of the five clauses disagreed with a count of one; `attestation` read "1 are practices
    // only you can confirm" and `unreadable` was already number-neutral. A count of one is the ordinary
    // case on an estate that is nearly complete, which is the estate most likely to read this line.
    const one: readonly Unmeasured[] = ['attestation', 'unreachable', 'unbuilt', 'unreadable', 'disabled'];

    for (const kind of one) {
      const sentence = unmeasuredBreakdown({ ...NONE, [kind]: 1 }) ?? '';

      expect(sentence, `${kind} reads: ${sentence}`).not.toMatch(/\b1 (?:are|have|were|do|reads?)\b|\b[02-9]\d* (?:is|has|was|does)\b/);
    }
  });

  it('still works when the split is absent, since an older stored scan has none', () => {
    const sentence = rangeSentence({ low: 20, high: 80 }, 4);

    expect(sentence).toContain('between 20.0 and 80.0');
    expect(sentence).not.toContain('Of those');
  });
});
