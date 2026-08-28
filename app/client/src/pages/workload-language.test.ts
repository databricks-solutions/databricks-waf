// The sentences that carry a number, asserted.
//
// Two of these are the reason the file exists. The coverage disclosure is the sentence that stops
// "your costliest queries" from being read as the whole estate when most of its query time was
// excluded, so it has to say a share and name what is missing. And the trend sentence has to keep
// "40% slower than the previous fortnight" apart from "always this slow", because those send a
// reader to two different places and one of them is a diff.

import { describe, expect, it } from 'vitest';
import {
  bytes,
  CONFIDENCE_LABEL,
  coverageSentence,
  duration,
  evidencePhrase,
  leadFinding,
  representativeCaveat,
  SEVERITIES,
  SEVERITY_LABEL,
  shapeSentence,
  TREND_DETAIL,
  TREND_LABEL,
  trendSentence,
  versionSentence,
} from './workload-language';
import type { WorkloadFinding, WorkloadShape, WorkloadTrend } from '../api/types';

function trend(overrides: Partial<WorkloadTrend> = {}): WorkloadTrend {
  return { kind: 'chronic', runsNow: 100, runsBefore: 100, ...overrides };
}

function shape(overrides: Partial<WorkloadShape> = {}): WorkloadShape {
  return {
    shape: 'aaaaaaaaaaaaaaaa',
    workspaceId: 'w1',
    statementType: 'SELECT',
    score: 0.5,
    trend: trend(),
    findings: [],
    representativeMeasured: true,
    runs: 100,
    measuredRuns: 100,
    totalMs: 100_000,
    readBytes: 0,
    spilledBytes: 0,
    shuffleBytes: 0,
    readFiles: 0,
    queueMs: 0,
    cacheHits: 0,
    failures: 0,
    warehouses: 1,
    jobs: 0,
    pipelines: 0,
    ...overrides,
  };
}

describe('how much of the estate this is about', () => {
  /*
   * The disclosure, and the one sentence on the page that is about what is not on it. On the estate
   * the thresholds were calibrated against, refreshes were 62.9% of query time — so a page that
   * showed this list without this sentence would be describing about a third of the workspace under
   * a heading that claims all of it.
   */
  it('says the share and names what was left out', () => {
    const sentence = coverageSentence({
      coveredMs: 3_600_000,
      excludedMs: 6_100_000,
      selfMs: 0,
      coveredRuns: 400,
      excludedRuns: 25,
      selfRuns: 0,
      ambiguousMs: 0,
      ambiguousRuns: 0,
      ambiguousShapes: 0,
      percent: 37.1,
    });

    expect(sentence).toContain('37%');
    expect(sentence).toContain('refresh');
    expect(sentence).toMatch(/SET|GRANT/);
  });

  /*
   * The tool's own cost, in the reader's words rather than in the payload only.
   *
   * On the workspace this page was first opened against, 51.8% of query time over twenty days was this
   * app reading system tables — and before the exclusion existed, eight of the top twelve shapes were
   * ours. A reader who compares this page to a bill will find that time whatever the page says, so the
   * page says it.
   */
  it('names what the assessment itself spent', () => {
    const sentence = coverageSentence({
      coveredMs: 3_600_000,
      excludedMs: 0,
      selfMs: 3_900_000,
      coveredRuns: 400,
      excludedRuns: 0,
      selfRuns: 3048,
      ambiguousMs: 0,
      ambiguousRuns: 0,
      ambiguousShapes: 0,
      percent: 48,
    });

    expect(sentence).toContain('48%');
    expect(sentence).toContain('this assessment');
    expect(sentence).toContain('1.1 h');
    // Not folded into the refresh clause, which is about the estate's own work rather than the tool's.
    expect(sentence).not.toContain('refresh');
  });

  // Said rather than left out, because "this is all of it" is the answer to the question the
  // sentence above raises, and silence would leave a reader to guess which case they are in.
  it('says so when it covered everything', () => {
    const sentence = coverageSentence({
      coveredMs: 60_000,
      excludedMs: 0,
      selfMs: 0,
      coveredRuns: 10,
      excludedRuns: 0,
      selfRuns: 0,
      ambiguousMs: 0,
      ambiguousRuns: 0,
      ambiguousShapes: 0,
      percent: 100,
    });

    expect(sentence).toContain('all');
    expect(sentence).not.toContain('refresh');
  });

  // Complete coverage of nothing is true and misleading, so it is not what gets said.
  it('says nothing ran rather than claiming full coverage of an empty window', () => {
    expect(
      coverageSentence({
        coveredMs: 0,
        excludedMs: 0,
        selfMs: 0,
        coveredRuns: 0,
        excludedRuns: 0,
        selfRuns: 0,
        ambiguousMs: 0,
        ambiguousRuns: 0,
        ambiguousShapes: 0,
      })
    ).toBe('No query ran in this window, so there is nothing to rank.');
  });

  /*
   * The admission the percentage exists to make honest.
   *
   * The statement computes coverage before it drops the shapes whose recorded text spanned several
   * statement types, so covered time includes work no row on the page describes — 1.0% of query time on
   * the estate the guard was measured against. A sentence that reported the larger figure would be
   * describing a list the reader cannot find.
   */
  it('names the covered time that no shape on the page describes', () => {
    const sentence = coverageSentence({
      coveredMs: 3_600_000,
      excludedMs: 0,
      selfMs: 0,
      coveredRuns: 400,
      excludedRuns: 0,
      selfRuns: 0,
      ambiguousMs: 1_800_000,
      ambiguousRuns: 90,
      ambiguousShapes: 2,
      percent: 50,
    });

    // The half that is described, not the whole of covered.
    expect(sentence).toContain('30 min of it');
    expect(sentence).toContain('2 groups');
    // Not the "all of it" branch, which the presence of undescribed time rules out.
    expect(sentence).not.toContain('Covers all');
  });

  /*
   * A dropped group need not carry any measurable time: a shape whose every run failed or came from the
   * cache has `ms_now` of zero and still counts in `ambiguousShapes`. Gated on the milliseconds alone,
   * this printed "Covers all 3 h" over a window in which the statement had declined to describe three
   * groups — a claim of completeness the field beside it contradicted.
   */
  it('does not claim full coverage where groups were dropped without measurable time', () => {
    const sentence = coverageSentence({
      coveredMs: 10_800_000,
      excludedMs: 0,
      selfMs: 0,
      coveredRuns: 900,
      excludedRuns: 0,
      selfRuns: 0,
      ambiguousMs: 0,
      ambiguousRuns: 40,
      ambiguousShapes: 3,
      percent: 100,
    });

    expect(sentence).not.toContain('Covers all');
    expect(sentence).toContain('3 groups');
    // And it does not name a duration it does not have, which is the reason this branch is separate.
    expect(sentence).not.toContain('0 ms');
  });
});

/*
 * The caveat under a query the reader is looking at, which exists because of what the failure list is.
 *
 * A shape every one of whose runs failed has no measurable execution to represent it. The statement used
 * to return no text at all for those, and they are precisely the rows the failure list is made of — so
 * the page that exists to show a reader what is failing showed them a heading and nothing under it. The
 * text now comes from a failed run, and this sentence is what stops that being a silent substitution.
 */
describe('the caveat on a representative that measured nothing', () => {
  it('says a failure is a failure, and that the timings are from elsewhere', () => {
    const sentence = representativeCaveat({ representativeMeasured: false, representativeStatus: 'FAILED' });

    expect(sentence).toContain('failed');
    expect(sentence).toContain('not in the durations recorded for this query group');
  });

  /*
   * None of these may point anywhere. The caveat renders under the query text and over the cost figures,
   * so "the figures above" — which it said for one round — named a badge row and a trend sentence. Where
   * a block sits is not something a string can know, and this is the assertion that keeps it from
   * pretending to.
   */
  it('locates the figures it excludes itself from by name rather than by direction', () => {
    for (const status of ['FAILED', 'CANCELED', 'FINISHED', undefined]) {
      const sentence = representativeCaveat({
        representativeMeasured: false,
        ...(status == null ? {} : { representativeStatus: status }),
      });

      expect(sentence).not.toMatch(/\babove\b|\bbelow\b/);
    }
  });

  it('does not call a cancelled run a failed one', () => {
    expect(representativeCaveat({ representativeMeasured: false, representativeStatus: 'CANCELED' })).toContain(
      'was cancelled'
    );
  });

  /*
   * `FINISHED` and unmeasurable is a cache hit, and it is the reason the flag alone is not enough to
   * write this sentence from. Calling it a failure would be a claim the payload contradicts.
   */
  it('reads a finished run that measured nothing as a cache hit', () => {
    const sentence = representativeCaveat({ representativeMeasured: false, representativeStatus: 'FINISHED' });

    expect(sentence).toContain('result cache');
    expect(sentence).not.toContain('failed');
  });

  // No status recorded is no basis for naming one, so the sentence narrows to what the flag carries.
  it('says only what the flag knows when the status is absent', () => {
    const sentence = representativeCaveat({ representativeMeasured: false });

    expect(sentence).toContain('no timings');
    expect(sentence).not.toMatch(/failed|cache/);
  });

  it('says nothing at all where the representative was measured', () => {
    expect(representativeCaveat({ representativeMeasured: true, representativeStatus: 'FINISHED' })).toBe('');
  });
});

describe('how a shape is moving', () => {
  it('puts a number on a regression, as a share of the window before it', () => {
    expect(trendSentence(trend({ kind: 'regression', ratio: 1.4 }))).toBe(
      'Getting worse — 40% slower per run than the previous window'
    );
  });

  it('says faster rather than a negative slower', () => {
    expect(trendSentence(trend({ kind: 'improving', ratio: 0.6 }))).toBe(
      'Getting better — 40% faster per run than the previous window'
    );
  });

  /*
   * A shape that did not run before has no ratio, and one whose runs were never timed has no
   * duration to have a ratio of. Neither is a 0% change, and printing one would be the page
   * asserting a comparison it did not make.
   */
  it('claims no comparison where there is nothing to compare', () => {
    expect(trendSentence(trend({ kind: 'new', runsBefore: 0 }))).toBe('New');
    expect(trendSentence(trend({ kind: 'unmeasured' }))).toBe('Not timed');
  });

  it('drops a change too small to be worth a number', () => {
    expect(trendSentence(trend({ kind: 'chronic', ratio: 1.004 }))).toBe('Always slow');
  });

  // Every trend a payload can carry has both a label and the longer sentence, or the page renders
  // an empty badge for one of six ordinary states.
  it('has a label and an explanation for every kind', () => {
    for (const kind of Object.keys(TREND_LABEL) as WorkloadTrend['kind'][]) {
      expect(TREND_LABEL[kind]).toBeTruthy();
      expect(TREND_DETAIL[kind].length).toBeGreaterThan(40);

      // A length floor is satisfied by any wording, which is how "that pattern is usually contention or a
      // skewed input" survived: `QueryShapeRow` is a per-shape aggregate, so nothing in it distinguishes why
      // two executions differed.
      expect(TREND_DETAIL[kind]).not.toMatch(/usually|typically|likeliest/);
    }
  });
});

describe('the numbers behind a finding', () => {
  /*
   * The payload carries raw values and a unit rather than rendered strings, and this is the reason:
   * two findings measured in bytes have to read at the same scale, or a reader compares 900 MB
   * against 1.2 GB and takes the smaller for the worse one.
   */
  it('scales bytes to one unit per magnitude', () => {
    expect(bytes(900)).toBe('900 B');
    expect(bytes(1024 * 1024 * 4)).toBe('4 MiB');
    expect(bytes(1024 * 1024 * 1024 * 1.5)).toBe('1.5 GiB');
  });

  it('writes a duration at the coarsest unit that still says something', () => {
    expect(duration(450)).toBe('450 ms');
    expect(duration(4_500)).toBe('4.5 s');
    expect(duration(300_000)).toBe('5 min');
    expect(duration(7_200_000)).toBe('2 h');
  });

  // A ratio is a share of something, and 0.34 is a number a reader has to convert before it means
  // anything.
  it('shows a ratio as a percentage', () => {
    expect(evidencePhrase({ label: 'Spill against read', value: 0.34, unit: 'ratio' })).toBe('Spill against read: 34%');
  });

  // A multiple is a factor rather than a share, which is why it is a second unit and not the same one. 19 is
  // the widest max-to-median partition ratio in the measured corpus, and it is the number this distinction
  // exists for: as a percentage it reads "1,900%", which is true and is not what a reader means by skew.
  it('shows a multiple as a factor rather than as a percentage', () => {
    expect(evidencePhrase({ label: 'Largest partition against the median', value: 19, unit: 'multiple' })).toBe(
      'Largest partition against the median: 19×'
    );
    expect(evidencePhrase({ label: 'Widest', value: 1.25, unit: 'multiple' })).toBe('Widest: 1.3×');
  });

  it('keeps a count a count', () => {
    expect(evidencePhrase({ label: 'Runs', value: 12_400, unit: 'count' })).toBe('Runs: 12,400');
  });

  // Shown on every finding, not only the weak ones: annotating the guesses and leaving the
  // certainties bare teaches a reader that an unannotated finding is the unreliable kind.
  it('has words for all three confidences', () => {
    for (const confidence of Object.keys(CONFIDENCE_LABEL) as WorkloadFinding['confidence'][]) {
      expect(CONFIDENCE_LABEL[confidence]).toBeTruthy();
    }
  });

  it('has a label for every severity a payload can carry', () => {
    for (const severity of SEVERITIES) expect(SEVERITY_LABEL[severity]).toBeTruthy();
  });
});

describe('where the estate stands', () => {
  it('names the window as two halves so a fortnight is not read as a quarter', () => {
    const sentence = shapeSentence({ considered: 240, findingCount: 9, windowDays: 14, top: [shape()] });

    expect(sentence).toContain('14 days against the 14 before them');
    expect(sentence).toContain('240 query groups');
    expect(sentence).toContain('9 findings');
  });

  /*
   * The case that matters most for trust: a ranked list with nothing wrong on it. Without this
   * sentence the page presents twelve expensive queries under an advisor's heading and a reader
   * concludes the advisor found twelve problems.
   */
  it('says the list is the costliest and not the worst when no rule fired', () => {
    const sentence = shapeSentence({ considered: 240, findingCount: 0, windowDays: 14, top: [shape()] });

    expect(sentence).toContain('No rule fired');
    expect(sentence).toContain('costliest, not the worst');
  });

  it('says there is nothing to rank rather than reporting zero of everything', () => {
    expect(shapeSentence({ considered: 0, findingCount: 0, windowDays: 14, top: [] })).toBe(
      'No query group ran in the last 14 days against the 14 before them, so there is nothing to rank.'
    );
  });

  /*
   * The consequence, not just the version string. Features are capped at the window's own 99th
   * percentile, so a score means something against the other shapes in the same run and nothing
   * against the same shape last month — and a reader who trends it is reading the tuning as a
   * change in their estate.
   */
  it('says a score compares query groups within a run and not across runs', () => {
    const sentence = versionSentence({ rankingVersion: 'advisor-1', rulesVersion: 1 });

    expect(sentence).toContain('advisor-1');
    expect(sentence).toContain('not across runs');
  });
});

describe('the one line a row has', () => {
  it('leads with the worst thing found, which is the first finding', () => {
    const finding = (severity: WorkloadFinding['severity'], headline: string): WorkloadFinding => ({
      rule: headline,
      severity,
      confidence: 'high',
      action: 'Open this query and fix the measured issue',
      headline,
      detail: 'detail',
      docUrl: 'https://docs.databricks.com/',
      evidence: [{ label: 'Runs', value: 1, unit: 'count' }],
    });

    expect(leadFinding(shape({ findings: [finding('critical', 'Spilling to disk'), finding('info', 'Cache')] }))).toBe(
      'Spilling to disk'
    );
  });

  it('says nothing where nothing fired', () => {
    expect(leadFinding(shape())).toBeUndefined();
  });
});
