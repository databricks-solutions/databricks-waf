// The wording is the product, so it gets tests.
//
// A finding's coverage note is the only place the reader learns that a green tick covers
// 50 of 103 tables, or one metastore out of three. Getting it wrong does not throw or
// render blank — it renders a confident sentence that happens to overclaim, which is the
// one failure mode nobody reports as a bug.

import { describe, expect, it } from 'vitest';
import { coverageNote, measuredTogether, scoreVerdict } from './verdict-language';
import { rangeSentence } from './score-range';
import type { Coverage } from '../api/types';

describe('what a finding says it covered', () => {
  it('adds nothing to a complete scan of the whole account', () => {
    // The unqualified claim needs no qualification, and a caveat on all 189 findings is a
    // caveat the reader learns to skip past — including on the findings that need one.
    expect(coverageNote({ mode: 'complete', reach: 'account' })).toBeUndefined();
  });

  it('says a complete scan of one metastore is not the account', () => {
    const note = coverageNote({ mode: 'complete', reach: 'metastore' });

    expect(note).toContain('metastore attached to this workspace');
    expect(note).toContain('other regions');
  });

  it('says a workspace-only result is workspace-only', () => {
    expect(coverageNote({ mode: 'complete', reach: 'workspace' })).toContain('this workspace only');
  });

  it('gives the scale of a sample and how it was picked', () => {
    const coverage: Coverage = {
      mode: 'sampled',
      reach: 'metastore',
      examined: 50,
      population: 4103,
      basis: 'the most-read tables first',
    };

    const note = coverageNote(coverage);

    expect(note).toContain('50 of 4,103');
    expect(note).toContain('the most-read tables first');
    // Both limits, because a sampled metastore result is narrowed twice and stating only
    // one of them still leaves the reader with a wrong conclusion.
    expect(note).toContain('metastore attached to this workspace');
  });

  it('still describes a sample whose size was not reported', () => {
    const note = coverageNote({ mode: 'sampled', reach: 'account' });

    expect(note).toContain('a subset');
    expect(note).not.toContain('undefined');
  });

  it('says nothing rather than guessing when the reach was not stated', () => {
    // An unstated reach is a gap in the collector. Inventing 'account' here would turn
    // that gap into an overclaim on the user's screen.
    expect(coverageNote({ mode: 'complete' })).toBeUndefined();
  });
});

describe('the word a score is given', () => {
  it('names the band where nothing qualifies the number', () => {
    expect(scoreVerdict(85, undefined)).toBe('Good');
    expect(scoreVerdict(60, undefined)).toBe('Fair');
    expect(scoreVerdict(20, undefined)).toBe('Poor');
    expect(scoreVerdict(undefined, undefined)).toBe('Not scored');
  });

  it('still names the band where the range is narrow enough to state plainly', () => {
    // The defect: the caller passed `isUncertain`, true from a tenth of a point of width, so a
    // pillar with two requirements outstanding read "Too little measured" above a sentence reading
    // "The true score is between 68.0 and 74.0". Every pillar on the labs install showed the
    // heading, and four of the five had a sentence like that one under it.
    expect(scoreVerdict(71, { low: 68, high: 74 })).toBe('Fair');
  });

  it('withholds it where almost nothing was measured', () => {
    expect(scoreVerdict(50, { low: 0.7, high: 99.3 })).toBe('Too little measured');
  });

  it('withholds it in exactly the cases the sentence beneath it tells the reader to stop reading', () => {
    // The two are the product's one claim about its own completeness, said twice on the same card.
    // Pinned across the band edges rather than at one width, so moving a threshold in `certainty`
    // moves both or fails here.
    for (const width of [0, 0.05, 0.1, 5, 14.9, 15, 30, 49.9, 50, 80]) {
      const range = { low: 10, high: 10 + width };
      const withheld = scoreVerdict(50, range) === 'Too little measured';

      expect(withheld, `a range ${String(width)} wide`).toBe((rangeSentence(range, 3) ?? '').includes('Too little'));
    }
  });
});

describe('several requirements one reading answers', () => {
  it('says both and twice, rather than all 2 and 2 times', () => {
    expect(measuredTogether(2)).toContain('answers both');
    expect(measuredTogether(2)).toContain('marked down twice');
    expect(measuredTogether(2)).not.toContain('2 times');
    // "One reading answers all two of these" is what the first draft printed on every pair, which is
    // most of them.
    expect(measuredTogether(2)).not.toContain('all two');
  });

  it('counts above two in figures', () => {
    // Four requirements share the serverless adoption reading. "marked down four times" reads as
    // prose written by hand for one case, and the next catalogue edit would make it wrong.
    expect(measuredTogether(4)).toContain('marked down 4 times');
  });

  it('says both that they share a reading and that they are counted once', () => {
    // Either half alone leaves the reader with the wrong conclusion: that the catalogue is
    // duplicated, or that the score counts one failure several times.
    const said = measuredTogether(3);

    expect(said).toContain('answers all 3');
    expect(said).toContain('counts them once');
  });

  it('does not talk about pillars', () => {
    // Three of the five groups in a real run are two requirements inside one pillar. The first
    // draft named pillars and read "asked for by Operational excellence and Operational
    // excellence".
    expect(measuredTogether(2)).not.toContain('pillar');
  });
});
