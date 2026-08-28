// What the writes page may say, asserted over its own words.
//
// The same arrangement `jobs-language.test.ts` uses, and the negative assertions are most of the file for
// the reason the module's header gives: every sentence on this page is one step away from a recommendation
// the app cannot make. A rewrite is not a rewrite-that-should-be-a-merge, and no field here says which.
//
// The other half is `undeterminable`. A shape whose runs recorded no written figure had no rule applied to
// it, and rendering that as a shape with nothing wrong is the flattering lie ADR 0074 is about — so the
// state's own words are asserted, not just the analysis that produces it.

import { describe, expect, it } from 'vitest';
import {
  findingsSentence,
  leadWriteFinding,
  NO_WRITES,
  REPRESENTATIVE_NOTE,
  rulesSentence,
  seenSentence,
  shapeLine,
  statedRunsSentence,
  statedSentence,
  STATE_DETAIL,
  STATE_LABEL,
  STATE_TONE,
  stateFacts,
  WRITE_STATES,
  writesSentence,
} from './writes-language';
import type { WriteShape, WriteState, Writes } from '../api/types';

const GIB = 1024 * 1024 * 1024;

function shape(over: Partial<WriteShape> = {}): WriteShape {
  return {
    workspaceId: '1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementType: 'REPLACE',
    state: 'advised',
    findings: [],
    runs: 40,
    finishedRuns: 40,
    daysRun: 10,
    runsStatingBytes: 40,
    writtenBytes: 160 * GIB,
    medianWriteBytes: 4 * GIB,
    largestWriteBytes: 9 * GIB,
    readBytes: 0,
    producedRows: 0,
    totalMs: 100_000,
    ...over,
  };
}

function analysis(over: Partial<Writes> = {}): Writes {
  return {
    shapes: [shape()],
    findingCount: 1,
    undeterminable: 0,
    writeStatements: 10_472,
    writesStatingBytes: 10_472,
    estateWrittenBytes: 617 * GIB,
    otherStatements: 91_000,
    windowDays: 30,
    rulesVersion: 1,
    ...over,
  };
}

describe('the states', () => {
  it('describes every state the payload can carry', () => {
    for (const state of WRITE_STATES) {
      expect(STATE_LABEL[state]).toBeTruthy();
      expect(STATE_DETAIL[state]).toBeTruthy();
      expect(STATE_TONE[state]).toBeTruthy();
    }
  });

  /*
   * The distinction the whole module exists for. "Could not judge" must not read as a verdict, and
   * "nothing found" must not read as a verdict about the data — both rules are about *how* a statement
   * writes, and neither reads whether what it wrote was right.
   */
  it('keeps could-not-judge from reading as a clean verdict', () => {
    const detail = STATE_DETAIL['undeterminable'];
    expect(detail).toMatch(/no written figure/i);
    expect(detail).not.toMatch(/\bfine\b|\bhealthy\b|\bnothing wrong\b|\bno problem\b/i);
  });

  it('keeps nothing-found from claiming the write itself is right', () => {
    const detail = STATE_DETAIL['clean'];
    expect(detail).toMatch(/neither pattern/i);
    expect(detail).not.toMatch(/\bcorrect\b|\boptimal\b|\bwell[- ]written\b|\bnothing to improve\b/i);
  });

  it('resolves a state a later build added without handing React undefined', () => {
    const facts = stateFacts('sideways' as WriteState);
    expect(facts.label).toBe('Unrecognised');
    expect(facts.tone).toBe('neutral');
    expect(facts.Icon).toBeTruthy();
  });
});

describe('the estate sentence', () => {
  it('gives both counts and the share, so a reader can check the arithmetic', () => {
    const said = writesSentence(analysis());
    expect(said).toContain('10,472 write statements');
    expect(said).toContain('101,472 statements');
    // 10,472 of 101,472 is 10%.
    expect(said).toContain('10%');
  });

  /*
   * The contradiction the calibration estate produced on the first live read: 73 writes out of 19,300
   * statements rounds to `0%`, in the same sentence that says there are 73 of them. Both ends, because
   * the same rounding at the top says an estate that writes all but one of its statements writes all of
   * them.
   */
  it('never rounds a real share down to nothing, or an incomplete one up to everything', () => {
    expect(writesSentence(analysis({ writeStatements: 73, otherStatements: 19_227 }))).toContain('under 1%');
    expect(writesSentence(analysis({ writeStatements: 19_299, otherStatements: 1 }))).toContain('over 99%');
    expect(writesSentence(analysis({ writeStatements: 100, otherStatements: 0 }))).toContain('100%');
  });

  /*
   * The sentence a reader would most like and no field supports. Nothing in the query history names what
   * a statement wrote *to*, so "the estate rewrites 40 tables" is not sayable from here — and the tell is
   * the word, which is why it is asserted rather than reviewed.
   */
  it('never names a table, because no field here holds one', () => {
    expect(writesSentence(analysis())).not.toMatch(/\btables?\b/i);
    expect(writesSentence(analysis({ writeStatements: 0 }))).not.toMatch(/\btables?\b/i);
    expect(NO_WRITES).toMatch(/not a statement about tables/i);
  });

  it('says an estate that wrote nothing wrote nothing, without saying its tables were not written', () => {
    const said = writesSentence(analysis({ writeStatements: 0, estateWrittenBytes: 0 }));
    expect(said).toMatch(/no statement wrote anything/i);
  });

  it('withdraws the total where some writes recorded no figure, and is silent where none did', () => {
    expect(statedSentence(analysis())).toBeUndefined();
    const said = statedSentence(analysis({ writesStatingBytes: 10_470 }));
    expect(said).toContain('2 writes');
    expect(said).toMatch(/not what the estate wrote/i);
  });
});

describe('the findings sentence', () => {
  it('says no rule fired without saying the shapes are fine', () => {
    const said = findingsSentence(analysis({ findingCount: 0 }));
    expect(said).toMatch(/largest writers, not the worst/i);
    expect(said).not.toMatch(/\bhealthy\b|\bno problems\b/i);
  });

  /*
   * The two counts in one sentence, because they answer one question: forty shapes with no findings reads
   * very differently when thirty of them had no number to read.
   */
  it('says how many of the listed shapes could not be judged, in the same breath', () => {
    const said = findingsSentence(
      analysis({ shapes: [shape(), shape(), shape()], findingCount: 0, undeterminable: 2 })
    );
    expect(said).toContain('3 write groups');
    expect(said).toContain('2 of them');
    expect(said).toMatch(/no rule could read one/i);
  });

  it('omits the caveat where every shape carried a figure', () => {
    expect(findingsSentence(analysis())).not.toMatch(/could read one/i);
  });
});

describe('the ruleset sentence', () => {
  it('names the version the analysis was read under', () => {
    expect(rulesSentence(analysis({ rulesVersion: 4 }))).toContain('rule set 4');
  });

  /*
   * The claim neither rule can support, and the reason it is worth a test: both rule names in the YAML
   * sound like claims about a table, and the sentence introducing them must not.
   */
  it('says the rules do not read what the statement wrote to', () => {
    expect(rulesSentence(analysis())).toMatch(/does not record it/i);
  });
});

describe('a shape line', () => {
  it('uses the platform’s own word for what the statement was', () => {
    expect(shapeLine(shape({ statementType: 'MERGE' }))).toContain('merge');
  });

  /*
   * No verb the field does not carry. A `REPLACE` replaced; it did not "rebuild a table", and nothing in
   * this payload says it did.
   */
  it('never turns a statement type into a claim about a table', () => {
    const said = shapeLine(shape());
    expect(said).not.toMatch(/\brebuil|\btable\b/i);
  });

  it('says the middle run recorded no figure rather than showing a zero', () => {
    const said = shapeLine(shape({ medianWriteBytes: undefined }));
    expect(said).toMatch(/no written figure recorded/i);
    expect(said).not.toContain('0 B');
  });

  it('has nothing to lead with where the shape has no findings', () => {
    expect(leadWriteFinding(shape())).toBeUndefined();
  });
});

describe('a shape’s own coverage', () => {
  it('is silent where every run stated a figure', () => {
    expect(statedRunsSentence(shape())).toBeUndefined();
  });

  it('gives both counts rather than a share, so nobody has to multiply', () => {
    const said = statedRunsSentence(shape({ runsStatingBytes: 31 }));
    expect(said).toContain('31 of its 40 runs');
    expect(said).not.toContain('%');
  });
});

describe('when a shape was seen', () => {
  it('gives both ends or neither', () => {
    expect(seenSentence(shape())).toBeUndefined();
    expect(seenSentence(shape({ firstSeen: '2026-08-01T00:00:00Z' }))).toBeUndefined();
    expect(seenSentence(shape({ lastSeen: '2026-08-14T00:00:00Z' }))).toBeUndefined();
    expect(seenSentence(shape({ firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-14T00:00:00Z' }))).toBeTruthy();
  });

  it('says nothing where a stored date cannot be read', () => {
    expect(seenSentence(shape({ firstSeen: 'not a date', lastSeen: '2026-08-14T00:00:00Z' }))).toBeUndefined();
  });

  /*
   * Deixis and prediction, the two traps `schedule-language.ts` records. This sentence is about the window
   * and may not be about what the shape will do next.
   */
  it('never says the shape stopped or will run again', () => {
    const said = seenSentence(shape({ firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-14T00:00:00Z' }));
    expect(said).not.toMatch(/\bwill\b|\bstopped\b|\bno longer\b|\bstill runs?\b/i);
  });
});

describe('the representative note', () => {
  it('says which run it is and that the others differ', () => {
    expect(REPRESENTATIVE_NOTE).toMatch(/wrote the most/i);
    expect(REPRESENTATIVE_NOTE).toMatch(/other runs .* differ/i);
  });
});
