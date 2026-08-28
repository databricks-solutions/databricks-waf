// The words the workloads page uses, in one place.
//
// Three of these carry more than wording.
//
//   `trendSentence` is the one a reader acts on soonest, and its job is to keep two different
//   answers apart. "This got 40% slower" is a regression somebody changed something to cause;
//   "this has always been slow" is a design problem. A page that phrased both as "slow" would
//   send the reader to read a diff that does not exist.
//
//   `evidencePhrase` formats the numbers behind a finding, and the payload deliberately carries
//   raw values with a unit rather than rendered strings — so this is where bytes become MB and a
//   ratio becomes a percentage. Two findings measured in bytes must read at the same scale, or a
//   reader compares 900 MB against 1.2 GB and concludes the smaller is worse.
//
//   `coverageSentence` is the disclosure. The analysis excludes `REFRESH`, which was 62.9% of
//   query time on the estate the thresholds were calibrated against, and a list headed "your
//   costliest queries" that silently described a third of the workspace is the fastest way to
//   lose a customer's trust in the rest of the app.
//
// Nothing here is scored, and the page says so in its header rather than in a footnote.

import { AlertTriangle, ArrowDown, ArrowUp, CircleHelp, Clock, Minus, Sparkles, type LucideIcon } from 'lucide-react';
import type { WorkloadCoverage, WorkloadEvidence, WorkloadFinding, WorkloadShape, WorkloadTrend } from '../api/types';
import type { Tone } from '../components/ui/StatusBadge';

type Severity = WorkloadFinding['severity'];
type TrendKind = WorkloadTrend['kind'];

/** Worst first, which is the order the list is filtered in. */
export const SEVERITIES: readonly Severity[] = ['critical', 'high', 'medium', 'info'];

export const SEVERITY_LABEL: Readonly<Record<Severity, string>> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  info: 'Worth knowing',
};

/** Only what calls for a decision is coloured. `info` is a note, not a fourth grade of alarm. */
export const SEVERITY_TONE: Readonly<Record<Severity, Tone>> = {
  critical: 'danger',
  high: 'warning',
  medium: 'neutral',
  info: 'neutral',
};

/**
 * How much the advisor is claiming, said in words.
 *
 * Shown on every finding rather than only on the weak ones. A page that annotated its guesses and
 * left its certainties bare would teach a reader that an unannotated finding is the unreliable kind.
 */
export const CONFIDENCE_LABEL: Readonly<Record<WorkloadFinding['confidence'], string>> = {
  high: 'Measured directly',
  moderate: 'Inferred from what was measured',
  low: 'A signal worth checking, not a conclusion',
};

export const TREND_LABEL: Readonly<Record<TrendKind, string>> = {
  regression: 'Getting worse',
  chronic: 'Always slow',
  volatile: 'Unpredictable',
  improving: 'Getting better',
  new: 'New',
  unmeasured: 'Not timed',
};

/**
 * What each trend means, said in full somewhere on the page.
 *
 * `volatile` and `unmeasured` are the two a label cannot carry. A shape whose worst run is eight
 * times its median has no meaningful average, so a reader comparing its mean against last
 * fortnight's is comparing two numbers that describe nothing. And a shape served entirely from
 * cache was never timed — which is not the same as being fast.
 */
export const TREND_DETAIL: Readonly<Record<TrendKind, string>> = {
  regression:
    'This ran materially slower per execution than it did in the previous window. Something changed — the query, ' +
    'the data volume, the warehouse it runs on, or what else was running at the time.',
  chronic:
    'This was as slow in the previous window as it is in this one. Nothing regressed; it has always cost this, ' +
    'which makes it a design question rather than an incident.',
  volatile:
    'Its worst execution was many times its median, so it has no meaningful average and a mean over it would ' +
    'be misleading. What varies between executions is not visible from here.',
  improving: 'This ran materially faster per execution than it did in the previous window.',
  new: 'This did not run in the previous window, so there is nothing to compare it against yet.',
  unmeasured:
    'No execution of this was timed — every run was served from cache, failed, or was cancelled. Not the same ' +
    'as fast, and the ranking below treats it as unknown rather than as good.',
};

export const TREND_TONE: Readonly<Record<TrendKind, Tone>> = {
  regression: 'danger',
  chronic: 'warning',
  volatile: 'warning',
  improving: 'success',
  new: 'neutral',
  unmeasured: 'neutral',
};

/** The shape, because two of these carry no colour and were text on a plain badge. */
export const TREND_ICON: Readonly<Record<TrendKind, LucideIcon>> = {
  regression: ArrowUp,
  chronic: Minus,
  volatile: AlertTriangle,
  improving: ArrowDown,
  new: Sparkles,
  unmeasured: CircleHelp,
};

export const SHAPE_ICON = Clock;

/**
 * How a shape's cost is moving, as a sentence with its number in it.
 *
 * The ratio is stated as a percentage of the previous window rather than as a multiple, because a
 * reader who has to translate "1.4x" has been given arithmetic instead of an answer. Absent where
 * there is nothing to compare: a trend with no prior window is not a 0% change.
 */
export function trendSentence(trend: WorkloadTrend): string {
  const base = TREND_LABEL[trend.kind];
  if (trend.ratio == null || trend.kind === 'new' || trend.kind === 'unmeasured') return base;

  const change = Math.round(Math.abs(trend.ratio - 1) * 100);
  if (change < 1) return base;
  const direction = trend.ratio > 1 ? 'slower' : 'faster';
  return `${base} — ${String(change)}% ${direction} per run than the previous window`;
}

/** One measured number, at a scale a reader can compare against the others beside it. */
export function evidencePhrase(evidence: WorkloadEvidence): string {
  return `${evidence.label}: ${amount(evidence)}`;
}

/**
 * The number on its own, at the same scale `evidencePhrase` would print it.
 *
 * Exported for the one caller that has a label already and two values under it: a measure read twice
 * writes its label once. Formatting the two readings anywhere else would let one of them come out in
 * bytes and the other in MiB.
 */
export function amountPhrase(value: number, unit: WorkloadEvidence['unit']): string {
  return amount({ value, unit });
}

function amount(evidence: Pick<WorkloadEvidence, 'value' | 'unit'>): string {
  switch (evidence.unit) {
    case 'bytes':
      return bytes(evidence.value);
    case 'ms':
      return duration(evidence.value);
    case 'percent':
      return `${round(evidence.value)}%`;
    case 'ratio':
      // A ratio is shown as a percentage, since a ratio the rules emit is a share of something
      // — spill against read, queue against execution — and "0.34" is a number a reader has to
      // convert before it means anything.
      return `${round(evidence.value * 100)}%`;
    case 'multiple':
      // A factor, and the reason it is not a `ratio`: the largest partition against the median one is 19
      // on the widest plan of the measured corpus, which as a percentage reads "1,900%". Both are true and
      // one of them is what the design document means when it writes the condition as `max/median >= 10`.
      // The multiplication sign rather than an "x", because it is beside a number.
      return `${evidence.value.toLocaleString(undefined, { maximumFractionDigits: 1 })}×`;
    case 'count':
      return evidence.value.toLocaleString(undefined, { maximumFractionDigits: 0 });
  }
}

/**
 * Bytes at one scale per magnitude, never a raw count.
 *
 * Binary units because that is what the platform reports and what a reader will see in the query
 * profile they open next. A page that reported GB where the profile says GiB would be off by 7%
 * against the thing the reader is checking it against.
 */
export function bytes(value: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
  let scaled = Math.abs(value);
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${scaled.toLocaleString(undefined, { maximumFractionDigits: scaled < 10 && unit > 0 ? 1 : 0 })} ${units[unit] ?? 'B'}`;
}

/**
 * A duration, at the coarsest unit that still says something.
 *
 * Milliseconds below a second, seconds below a minute, then minutes and hours. A query that ran for
 * 4,517,000 ms is a query nobody has read the duration of.
 */
export function duration(ms: number): string {
  if (ms < 1000) return `${round(ms)} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toLocaleString(undefined, { maximumFractionDigits: 1 })} s`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${minutes.toLocaleString(undefined, { maximumFractionDigits: 1 })} min`;
  return `${(minutes / 60).toLocaleString(undefined, { maximumFractionDigits: 1 })} h`;
}

/**
 * The figures this sentence reads, checked together because a stored analysis may carry none of them.
 *
 * The contract declares all five `readonly … : number`, so the type says a payload without them cannot
 * exist. One did: `ambiguousMs` and `ambiguousShapes` arrived with `36d`, and a run stored three days
 * earlier carried neither, which took `/workloads` to an error boundary on labs — the whole page, over a
 * sentence in its header. Two unguarded reads of two absent fields twenty-eight lines apart, which is the
 * argument for one check at the read rather than a default per field.
 */
const COVERAGE_FIGURES = ['coveredMs', 'excludedMs', 'selfMs', 'ambiguousMs', 'ambiguousShapes'] as const;

/**
 * How much of the estate's query time this list is about.
 *
 * Always shown, including at full coverage, because "this is all of it" is itself the answer to the
 * question a reader would otherwise have to guess at. Absent only where the window ran nothing:
 * complete coverage of nothing is true and says nothing.
 *
 * A stored analysis outlives the build that wrote it, and what is owed it is a page that survives it
 * rather than a translation of it — [ADR 0079](../../../../docs/decisions/0079-forward-only-an-older-record-is-owed-a-page-that-survives-it.md),
 * and `stateFacts` in `warehouse-language.ts` for the same behaviour after the same crash. Defaulting an
 * absent figure to zero would be the tidier fix and would put a coverage claim over a window nothing
 * measured; the sentence says instead which figures it does not have.
 */
export function coverageSentence(coverage: WorkloadCoverage): string {
  const absent = COVERAGE_FIGURES.filter((figure) => !Number.isFinite(coverage[figure]));
  if (absent.length > 0) {
    return (
      `This analysis is missing ${String(absent.length)} of the ${String(COVERAGE_FIGURES.length)} figures this ` +
      'page reads to say how much of the window it covers, so that is not said here. What it did record is shown ' +
      'as recorded. Run the advisor again for a reading this build can describe.'
    );
  }
  if (coverage.percent == null) {
    return 'No query ran in this window, so there is nothing to rank.';
  }
  // Already a percentage, to one decimal, and rounded here rather than scaled. A ratio would have been
  // the safer contract and this is not one: the field is `percent` and the server sends 93.8. Read as a
  // ratio it printed 9,380%, which is what a real workspace said the first time this page was opened.
  const percent = Math.round(coverage.percent);
  // The query time that grouped into a shape this can describe, which is the covered time less the part
  // the statement declined to describe. The server's percentage is over the same numerator, so a reader
  // multiplying the one by the window's total gets the other.
  //
  // Not what the rows on this page account for, and the sentence does not say it is. Twelve shapes are
  // shown out of however many ran, and `shapeSentence` beside this one is where that count is given.
  const described = duration(Math.max(0, coverage.coveredMs - coverage.ambiguousMs));
  if (coverage.excludedMs <= 0 && coverage.selfMs <= 0 && coverage.ambiguousMs <= 0 && coverage.ambiguousShapes <= 0) {
    return `Covers all ${described} of query time recorded in this window.`;
  }
  const rest =
    coverage.excludedMs > 0
      ? ` ${duration(coverage.excludedMs)} of the rest is work the advisor does not rank: materialised-view and ` +
        'streaming-table refreshes, which are managed and have no query to change, and statements like SET and ' +
        'GRANT that do no work.'
      : '';
  // The tool's own cost, named as the tool's. This app runs twenty system-table aggregates per scan and
  // they land in the same query history it is reading; on the workspace this page was first opened
  // against they were half of it. A reader comparing this page to a bill will find them either way, and
  // finding them unmentioned is worse than finding them accounted for.
  const own =
    coverage.selfMs > 0
      ? ` A further ${duration(coverage.selfMs)} was this assessment reading the system tables, which it ` +
        'excludes from its own ranking.'
      : '';
  // Work the advisor could have ranked and did not, which is a different admission from the two above and
  // is why it is said separately. Some submission paths record the calling expression rather than the SQL
  // it built, so statements of several kinds arrive with one identical text; grouping on it would produce
  // a row citing real time and describing nothing. The count is of groups, which is the field behind it.
  //
  // Fired on the group count rather than on the milliseconds, because the two come apart: a dropped group
  // whose every run failed or was served from cache carries no measurable time, and gating on time alone
  // printed "covers all of it" over a window where groups had been dropped. Where there is no time to
  // name, the sentence names none.
  const groups = plural(coverage.ambiguousShapes, 'group');
  const undescribed =
    coverage.ambiguousShapes > 0
      ? coverage.ambiguousMs > 0
        ? ` ${duration(coverage.ambiguousMs)} is ranked by nothing here: ${groups} of statements arrived with one ` +
          'recorded text covering several kinds of statement, which does not identify a query well enough to advise on.'
        : ` ${groups} of statements are ranked by nothing here: they arrived with one recorded text covering several ` +
          'kinds of statement, which does not identify a query well enough to advise on. No run of theirs was timed, ' +
          'so they add nothing to the figures.'
      : '';
  return `Covers ${String(percent)}% of query time in this window — ${described} of it.${rest}${own}${undescribed}`;
}

/**
 * Where the estate stands, for the page's opening line.
 *
 * The window is named in days rather than as "recently", because every number under it is a
 * comparison of one half of the window against the other and a reader who does not know the span
 * cannot tell a fortnight's regression from a quarter's.
 */
export function shapeSentence(analysis: {
  readonly considered: number;
  readonly findingCount: number;
  readonly windowDays: number;
  readonly top: readonly WorkloadShape[];
}): string {
  const { considered, findingCount, top, windowDays } = analysis;
  const window = `${String(windowDays)} days against the ${String(windowDays)} before them`;
  if (considered === 0) return `No query group ran in the last ${window}, so there is nothing to rank.`;

  const groups = plural(considered, 'query group');
  if (findingCount === 0) {
    return `${groups} ran in the last ${window}. No rule fired on any of them. The analysis ranked the costliest, not the worst; query groups without a recommendation are not listed.`;
  }
  return `${groups} ran in the last ${window}. ${plural(findingCount, 'finding')} across the ${plural(top.length, 'query group')} shown.`;
}

/**
 * Which coefficients and rules produced this, for the reader comparing two runs.
 *
 * Said plainly rather than as a version string alone, because the consequence is the part that
 * matters: a score is comparable between two shapes in one run and not between two runs, since
 * every feature is capped at the window's own 99th percentile.
 */
export function versionSentence(analysis: { readonly rankingVersion: string; readonly rulesVersion: number }): string {
  return (
    `Ranked by ${analysis.rankingVersion} against rule set ${String(analysis.rulesVersion)}. Scores compare query groups ` +
    'within this run and not across runs. The window is half the history the run reads, because the trend holds it ' +
    'against an equal window before it.'
  );
}

/**
 * Why the query shown is from a run that measured nothing.
 *
 * Only ever rendered where `representativeMeasured` is false, which is a shape with no finished,
 * uncached execution in the window at all — the failure list is largely made of those. Two branches
 * because the flag alone cannot tell the cases apart: a run that failed and a run served from the cache
 * are both unmeasurable, and `representativeStatus` is the field that separates them. Where the status
 * was not recorded, the sentence says only what the flag knows.
 *
 * No sentence here says "above". This rendered under the query text and over the cost figures it was
 * describing, so for one review round "the figures above" pointed at a badge row. What the fields
 * support is that this run's timings are not in the shape's durations, which is true wherever the
 * caveat is put; where it is put is not something the string is entitled to know.
 */
export function representativeCaveat(shape: {
  readonly representativeStatus?: string;
  readonly representativeMeasured: boolean;
}): string {
  if (shape.representativeMeasured) return '';
  const status = shape.representativeStatus;
  if (status === 'FAILED' || status === 'CANCELED') {
    const verb = status === 'FAILED' ? 'failed' : 'was cancelled';
    return (
      `Shown from a run that ${verb}, because no run in this query group both finished and missed the ` +
      'result cache. Its timings are not in the durations recorded for this query group.'
    );
  }
  if (status === 'FINISHED') {
    // Not "no run executed": what the two fields say is that none both finished and missed the cache, and
    // a shape with nine hundred failures and one cache hit lands here having executed nine hundred times.
    return (
      'Shown from a run served out of the result cache, because no run in this query group both finished ' +
      'and missed it. Its duration describes a lookup rather than the query.'
    );
  }
  return (
    'Shown from a run that produced no timings, so none of the durations recorded for this query group is measured ' +
    'from this execution.'
  );
}

/** The single worst thing found on a shape, for the row that has one line to say it in. */
export function leadFinding(shape: WorkloadShape): string | undefined {
  const first = shape.findings[0];
  return first == null ? undefined : first.headline;
}

function round(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: value < 10 ? 1 : 0 });
}

function plural(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`;
}
