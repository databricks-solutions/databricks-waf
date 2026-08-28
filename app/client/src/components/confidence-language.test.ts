// The sentences a reader gets about how firmly a finding is established and how long it has stood.
//
// The occurrence line is the one with a claim in it. "Unmet in five consecutive runs" is a statement
// about the estate, and it is only true if the five runs asked the same question — so most of what
// is asserted here is that the sentence says how far back the record actually goes, rather than
// implying the streak is the whole story.

import { describe, expect, it } from 'vitest';
import { occurrenceSentence, standingWord } from './confidence-language';
import type { Confidence, Occurrence, Outcome } from '../api/types';

function confidence(one: Partial<Confidence> = {}): Confidence {
  return { standing: 'established', because: 'Nothing qualifies it.', limitations: [], ...one };
}

function occurrence(one: Partial<Occurrence> = {}): Occurrence {
  return { runs: 5, since: '2026-03-02T00:00:00.000Z', horizon: 'retention', ...one };
}

describe('the badge word for a standing', () => {
  it('says what the finding rests on rather than grading it', () => {
    // "High", "medium" and "low" invite averaging a pillar's confidence, and an answer from a
    // person is not two-thirds of a reading.
    expect(standingWord(confidence())).toBe('Established');
    expect(standingWord(confidence({ standing: 'qualified' }))).toBe('Qualified');
    expect(standingWord(confidence({ standing: 'stated' }))).toBe('Stated, not read');
  });

  it('says nothing for a finding that established nothing', () => {
    expect(standingWord(confidence({ standing: 'none' }))).toBeUndefined();
  });
});

describe('how long the outcome has held', () => {
  it('names the streak and when it started', () => {
    const says = occurrenceSentence(occurrence(), 'fail');

    expect(says).toContain('Unmet in 5 consecutive runs');
  });

  it('says what it was before, when the record reaches the change', () => {
    const says = occurrenceSentence(
      occurrence({ horizon: 'changed', changedFrom: { outcome: 'pass', at: '2026-02-01T00:00:00.000Z' } }),
      'fail'
    );

    expect(says).toContain('Before that it was Met');
  });

  it('says the streak is every run, when it is', () => {
    expect(occurrenceSentence(occurrence({ horizon: 'first-run' }), 'fail')).toContain('every run of this estate');
  });

  it('does not let a refused comparison read as the beginning of the record', () => {
    const says = occurrenceSentence(occurrence({ horizon: 'not-comparable' }), 'fail');

    expect(says).toContain('cannot be compared');
    expect(says).not.toContain('every run');
  });

  it('says the streak may be longer when older runs recorded no per-requirement outcome', () => {
    expect(occurrenceSentence(occurrence({ horizon: 'unrecorded' }), 'fail')).toContain('may be longer');
  });

  it('says a streak back to a requirement being introduced is its whole life, not a limit', () => {
    // Complete rather than truncated: the earlier runs exist, but this requirement was not in them,
    // so there is nothing behind the streak to be missing.
    const says = occurrenceSentence(occurrence({ horizon: 'introduced' }), 'fail');

    expect(says).toContain('every run since this requirement was added');
    expect(says).not.toContain('may be longer');
  });

  it('says a streak back to a rescoping covers every run that asked the current question', () => {
    expect(occurrenceSentence(occurrence({ horizon: 'redefined' }), 'fail')).toContain(
      'every run since a catalogue release changed what this requirement asks'
    );
  });

  it('says how far the runs it read go, rather than claiming they are all of them', () => {
    expect(occurrenceSentence(occurrence({ horizon: 'retention' }), 'fail')).toContain('as far back as the runs read here go');
  });

  it('renders nothing for a single run with nothing behind it', () => {
    // A count of one on every requirement of a first assessment is furniture.
    expect(occurrenceSentence(occurrence({ runs: 1, horizon: 'retention' }), 'fail')).toBeUndefined();
    expect(occurrenceSentence(occurrence({ runs: 1, horizon: 'unrecorded' }), 'fail')).toBeUndefined();
  });

  it('calls out a requirement that changed in this run', () => {
    const says = occurrenceSentence(
      occurrence({ runs: 1, horizon: 'changed', changedFrom: { outcome: 'pass', at: '2026-07-20T00:00:00.000Z' } }),
      'fail'
    );

    expect(says).toContain('New in this run');
    expect(says).toContain('it was Met');
  });

  it('says the first assessment has nothing to compare with', () => {
    expect(occurrenceSentence(occurrence({ runs: 1, horizon: 'first-run' }), 'fail')).toContain('first assessment');
  });

  it('renders every outcome as a state rather than as a wire value', () => {
    const outcomes: Outcome[] = ['pass', 'fail', 'partial', 'unmeasurable', 'not-applicable', 'satisfied-by-architecture'];

    for (const outcome of outcomes) {
      const says = occurrenceSentence(occurrence(), outcome) ?? '';
      expect(says).not.toContain(outcome);
      expect(says).not.toBe('');
    }
  });
});
