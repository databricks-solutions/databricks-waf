// What the write analysis may and may not say.
//
// Three groups, and the middle one is the reason this file is longer than two conditions warrant. The
// conditions are arithmetic and easy to test; the states are where the honesty rule lives, and a shape
// whose runs recorded no written figure rendering as a shape with nothing wrong is the exact failure
// ADR 0074 is about. Every one of those cases is asserted here rather than left to the page.

import { describe, expect, it } from 'vitest';
import { analyseWrites } from './writes.js';
import { writeRules, WRITE_RULE_IDS } from './workload-rules.js';
import type { WritePatternRow } from '../collect/sql/shapes.js';

const GIB = 1024 * 1024 * 1024;
const MIB = 1024 * 1024;

function pattern(over: Partial<WritePatternRow> = {}): WritePatternRow {
  return {
    workspaceId: '1',
    shape: 'aaaaaaaaaaaaaaaa',
    statementType: 'INSERT',
    runs: 1,
    finishedRuns: 1,
    daysRun: 1,
    runsStatingBytes: 1,
    writtenBytes: 1024,
    medianWriteBytes: 1024,
    largestWriteBytes: 1024,
    readBytes: 0,
    producedRows: 0,
    totalMs: 100,
    writeStatements: 1,
    writesStatingBytes: 1,
    estateWrittenBytes: 1024,
    otherStatements: 0,
    ...over,
  };
}

/** A shape that fires the rewrite rule, so a test can take it away one threshold at a time. */
function rewrite(over: Partial<WritePatternRow> = {}): WritePatternRow {
  return pattern({
    statementType: 'REPLACE',
    runs: 40,
    daysRun: 10,
    runsStatingBytes: 40,
    medianWriteBytes: 4 * GIB,
    writtenBytes: 160 * GIB,
    ...over,
  });
}

/** A shape that fires the small-loads rule, on the same terms. */
function dribble(over: Partial<WritePatternRow> = {}): WritePatternRow {
  return pattern({
    statementType: 'INSERT',
    runs: 600,
    daysRun: 14,
    runsStatingBytes: 600,
    medianWriteBytes: 2 * MIB,
    writtenBytes: 1200 * MIB,
    ...over,
  });
}

describe('the ruleset', () => {
  it('declares the two rules the analysis fires and no others', () => {
    const ruleset = writeRules();
    expect([...ruleset.rules.keys()].sort()).toEqual([...WRITE_RULE_IDS].sort());
  });

  /*
   * The one thing both rules exist not to say. Each names an alternative — a MERGE, Auto Loader — and
   * neither may say the estate should be using it, because which applies is a property of the pipeline
   * behind the statement and the query history does not record it. Asserted over the shipped words
   * rather than trusted to review, because the words are in YAML and a later edit to them will not
   * pass through this module at all.
   */
  it('names the alternative as something to check and never as what to do', () => {
    for (const rule of writeRules().rules.values()) {
      const prose = `${rule.headline} ${rule.detail}`;
      expect(prose).not.toMatch(/\byou should\b|\bshould be (a |an )?(merge|auto ?loader)\b/i);
      expect(prose).not.toMatch(/\bthis should have been\b|\breplace this with\b/i);
    }
  });
});

describe('the analysis', () => {
  it('is absent where the statement returned nothing, rather than an estate that writes nothing', () => {
    expect(analyseWrites([], 30)).toBeUndefined();
  });

  it('reports the window it was actually read over, not the one it was asked for', () => {
    // The statement caps its own lookback at thirty days. A caller asking for ninety is told what was read.
    expect(analyseWrites([pattern()], 90)?.windowDays).toBe(30);
    expect(analyseWrites([pattern()], 14)?.windowDays).toBe(14);
  });

  it('carries the estate coverage the statement returned, so the shapes have a denominator', () => {
    const analysis = analyseWrites([pattern({ writeStatements: 10_472, writesStatingBytes: 10_470, otherStatements: 91_000 })], 30);
    expect(analysis?.writeStatements).toBe(10_472);
    expect(analysis?.writesStatingBytes).toBe(10_470);
    expect(analysis?.otherStatements).toBe(91_000);
  });

  it('puts the shapes with findings above the ones without, then by what they wrote', () => {
    const analysis = analyseWrites(
      [
        pattern({ shape: 'quiet-big', writtenBytes: 900 * GIB, medianWriteBytes: 900 * GIB, statementType: 'MERGE' }),
        rewrite({ shape: 'loud-small', writtenBytes: 40 * GIB }),
      ],
      30
    );
    expect(analysis?.shapes.map((one) => one.shape)).toEqual(['loud-small', 'quiet-big']);
  });
});

describe('a shape whose runs recorded no written figure', () => {
  const blind = pattern({ runsStatingBytes: 0, writtenBytes: 0, statementType: 'REPLACE', runs: 40, daysRun: 10 });

  it('is undeterminable rather than clean', () => {
    const analysis = analyseWrites([{ ...blind, medianWriteBytes: undefined }], 30);
    expect(analysis?.shapes[0]?.state).toBe('undeterminable');
    expect(analysis?.undeterminable).toBe(1);
  });

  it('has no findings, because no rule had a number to read', () => {
    const analysis = analyseWrites([{ ...blind, medianWriteBytes: undefined }], 30);
    expect(analysis?.shapes[0]?.findings).toEqual([]);
    expect(analysis?.findingCount).toBe(0);
  });

  /*
   * The failure this whole distinction exists to prevent, asserted as one sentence: an estate whose
   * writes are all unreadable must not render as an estate that writes perfectly.
   */
  it('does not let an unreadable estate count as an estate with nothing wrong', () => {
    const analysis = analyseWrites(
      [
        { ...blind, shape: 'a', medianWriteBytes: undefined },
        { ...blind, shape: 'b', medianWriteBytes: undefined },
      ],
      30
    );
    expect(analysis?.undeterminable).toBe(2);
    expect(analysis?.shapes.every((one) => one.state !== 'clean')).toBe(true);
  });
});

describe('TABLE_REWRITTEN_WHOLE', () => {
  const fired = (row: WritePatternRow) =>
    analyseWrites([row], 30)?.shapes[0]?.findings.some((one) => one.rule === 'TABLE_REWRITTEN_WHOLE') ?? false;

  it('fires on a large replace that ran repeatedly across several days', () => {
    expect(fired(rewrite())).toBe(true);
  });

  it('reads the statement type and fires on nothing else', () => {
    // The whole rule is about a statement that wrote its target from scratch. A merge of the same size
    // and cadence is the pattern this rule would have somebody move to.
    for (const type of ['MERGE', 'INSERT', 'UPDATE', 'DELETE', 'COPY']) {
      expect(fired(rewrite({ statementType: type }))).toBe(false);
    }
  });

  it('declines a table built once and rebuilt twice', () => {
    expect(fired(rewrite({ runs: 2 }))).toBe(false);
  });

  it('declines an afternoon of rebuilds, because a habit is what the rule is about', () => {
    expect(fired(rewrite({ daysRun: 1 }))).toBe(false);
  });

  it('declines a small rewrite, however often it runs', () => {
    expect(fired(rewrite({ runs: 2000, medianWriteBytes: 4 * MIB }))).toBe(false);
  });

  it('reads the middle run and not the mean, so one backfill does not make a pattern', () => {
    // Forty runs of nothing much and one enormous one. The total is well past the threshold and the
    // middle run is not, which is exactly the shape a mean would fire on and this must not.
    expect(fired(rewrite({ medianWriteBytes: 2 * MIB, writtenBytes: 900 * GIB, largestWriteBytes: 899 * GIB }))).toBe(false);
  });

  it('is critical only where the window total is past a tebibyte', () => {
    const one = analyseWrites([rewrite({ writtenBytes: 4 * 1024 * GIB })], 30)?.shapes[0]?.findings[0];
    expect(one?.severity).toBe('critical');
    expect(analyseWrites([rewrite()], 30)?.shapes[0]?.findings[0]?.severity).toBe('medium');
  });

  it('carries every figure the reader would need to check it', () => {
    const finding = analyseWrites([rewrite()], 30)?.shapes[0]?.findings[0];
    expect(finding?.evidence.map((one) => one.label)).toEqual([
      'Written across the window',
      'The middle run wrote',
      'Times it ran',
      'Days it ran on',
    ]);
  });

  it('says how many of its runs stated no figure, where any did not', () => {
    const finding = analyseWrites([rewrite({ runsStatingBytes: 31 })], 30)?.shapes[0]?.findings[0];
    expect(finding?.evidence.find((one) => one.label === 'Runs that stated no written figure')?.value).toBe(9);
  });
});

describe('INGEST_IN_SMALL_PIECES', () => {
  const fired = (row: WritePatternRow) =>
    analyseWrites([row], 30)?.shapes[0]?.findings.some((one) => one.rule === 'INGEST_IN_SMALL_PIECES') ?? false;

  it('fires on many small loads a day across several days', () => {
    expect(fired(dribble())).toBe(true);
  });

  it('reads inserts and copies and nothing else', () => {
    expect(fired(dribble({ statementType: 'COPY' }))).toBe(true);
    for (const type of ['MERGE', 'REPLACE', 'UPDATE', 'DELETE']) {
      expect(fired(dribble({ statementType: type }))).toBe(false);
    }
  });

  it('declines an hourly load, because hourly is a schedule somebody chose', () => {
    // 14 days at 24 a day is 336 runs — past the run and day floors, under the cadence one.
    expect(fired(dribble({ runs: 336, daysRun: 14 }))).toBe(false);
  });

  it('declines a burst inside an afternoon', () => {
    expect(fired(dribble({ runs: 600, daysRun: 1 }))).toBe(false);
  });

  it('declines a load whose middle run wrote a well-sized file', () => {
    expect(fired(dribble({ medianWriteBytes: 512 * MIB }))).toBe(false);
  });

  it('states the cadence it fired on, so the reader can check the arithmetic', () => {
    const finding = analyseWrites([dribble({ runs: 700, daysRun: 14 })], 30)?.shapes[0]?.findings[0];
    expect(finding?.evidence.find((one) => one.label === 'Runs a day')?.value).toBe(50);
  });
});

describe('a shape that measured and matched neither pattern', () => {
  it('is clean, with no findings', () => {
    const analysis = analyseWrites([pattern({ statementType: 'MERGE', runs: 400, daysRun: 14 })], 30);
    expect(analysis?.shapes[0]?.state).toBe('clean');
    expect(analysis?.shapes[0]?.findings).toEqual([]);
    expect(analysis?.undeterminable).toBe(0);
  });
});
