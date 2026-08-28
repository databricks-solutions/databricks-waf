// The month's content, assembled from records already read, so the builder can freeze it.
//
// `document.ts` bakes a `MonthContent` into bytes and resolves nothing; this is the caller it names —
// the thing that turns live records into the presentational rows it bakes. Kept apart from the
// builder for the reason the builder is kept apart from the store, and apart from the endpoint for a
// second: a pure function of records passed in is one that a test pins against fixtures, and one that
// cannot reach a live store to compute a figure a second way that drifts from this one. The endpoint
// (28c) does the reading — a month's runs, its scans, the risks and actions standing across it — and
// hands the records here. What a run or a score *means* is decided here, once, over data that has
// already been fetched.
//
// # What a month opened at, and what it closed at
//
// Three of the sections are movements, and a movement needs two ends. The end is the last scan whose
// result landed inside the month; the start is the reading the month opened at, which is the last
// scan *before* it — `priorScan`. Comparing the month's first in-month scan to its last would measure
// only what changed after the first run of the month, missing the step between last month's close and
// this month's open, which is usually where the change is. A month with no prior scan has no opening
// reading to move from, so its movements and its finding deltas are empty rather than measured
// against themselves.
//
// # The window is passed in, not computed here
//
// Which timestamps count as "in the month" is a span in the workspace timezone, and computing that
// span is date arithmetic in a zone — the endpoint's job, beside where it resolves the zone. Here the
// window arrives as two instants, `[start, end)`, and every "in the month" test is a comparison
// against them. `end` doubles as the instant the exceptions are read in force at: an accepted risk is
// an exception of *this* month if it was standing when the month closed.

import { inForce, type AcceptedRisk } from '../accept/risk.js';
import type { ImprovementAction } from '../improve/action.js';
import type { Run } from '../run/run.js';
import { comparable } from '../scan/scan.js';
import type { ScanStamp } from '../scan/scan.js';
import type { OutcomeCounts, ScanSummary } from '../scan/store.js';
import type { DeltaRow, ExceptionRow, Fact, MonthContent, Movement, TrendPoint } from './document.js';
import { monthLabel, type MonthId } from './publication.js';
import type { FinalisationPayload } from '../../shared/api/contract.js';

/** A control's words, for a section that names it. Absent means the id stands for itself. */
export interface ControlLabel {
  readonly requirement: string;
  readonly pillar: string;
}

/**
 * The month's span in the workspace timezone, as two instants.
 *
 * Half-open, `[start, end)`, so a run at the first instant of the next month belongs to that month
 * and not to two. `end` is the instant the month closed, which is also when its exceptions are read.
 */
export interface MonthWindow {
  readonly start: Date;
  readonly end: Date;
}

/**
 * Everything a month is assembled from, already read from the stores.
 *
 * Real record types rather than a shape of this module's own, so the assembler consumes exactly what
 * the stores return and cannot be built against a fixture that carries a field the store does not.
 * The endpoint filters to the month where it can query by time and passes the rest whole; the
 * assembler does its own windowing besides, so a caller that over-fetches is corrected here rather
 * than trusted.
 */
export interface MonthSources {
  readonly month: MonthId;
  readonly window: MonthWindow;
  /** Every run the caller read for the month. Filtered to assessment runs requested in the window. */
  readonly runs: readonly Run[];
  /** Scan summaries whose result landed in the window, in any order. */
  readonly scans: readonly ScanSummary[];
  /** The last scan before the window: the reading the month opened at. Absent for a first month. */
  readonly priorScan?: ScanSummary;
  /** Every accepted risk the caller read, across controls. Grouped and read in force here. */
  readonly risks: readonly AcceptedRisk[];
  /** Every improvement action the caller read. Windowed by its own timestamps here. */
  readonly actions: readonly ImprovementAction[];
  /** A control id in the words the document carries. Absent → the id stands for itself. */
  readonly label: (controlId: string) => ControlLabel | undefined;
  /** A pillar id in the words the document carries. Absent → the id stands for itself. */
  readonly pillarTitle?: (pillarId: string) => string | undefined;
  /**
   * Where the run that closes this month stands with its review.
   *
   * Absent means this app has no record either way — an install that keeps no reviews, or a run
   * finished before they were kept — and the section is empty rather than saying nobody reviewed it.
   * Read by the endpoint against the same closing scan this module picks, because the review is of a
   * run and the month reports one.
   */
  readonly finalisation?: FinalisationPayload<Date>;
  /**
   * The months already published, oldest first, each resolved to its closing scan — the trend's stored
   * base. Excludes the month being published, whose point is taken from `scans` here, so a correction
   * does not draw its own month twice. Absent or empty means nothing was published before this, so the
   * trend is this month alone. The endpoint reads these; the assembler only places them.
   */
  readonly series?: readonly MonthPoint[];
}

/**
 * One published month as the trend reads it: which month, the score it is on record as, and the basis
 * it was measured on.
 *
 * `score` is already rendered, because for a prior month it is the string that month's own document
 * carries: a published month is on record as what it published, and a later document drawing a
 * different number for the same month would be two frozen records contradicting each other. Absent
 * means nothing is on record — a month published with no scan closing it, which the trend says.
 *
 * The stamp is carried for the one thing it decides: whether this month sits on the same basis as the
 * base, by the server's own rule. It comes from the closing scan, so it is absent whenever that scan
 * cannot be read — and `closingScan` says which of the two reasons applies, because they are different
 * sentences to a reader. Scans are kept 730 days and publications 2555, so a month can be on record
 * with a score whose run this app can no longer read at all, and "did not record how it was measured"
 * would be false about that month.
 */
export interface MonthPoint {
  readonly month: MonthId;
  readonly score?: string;
  readonly stamp?: ScanStamp;
  /**
   * Whether the run that closed the month is in the scan history this app read.
   *
   * `read` means the summary was found, so an absent stamp is that run not recording one. `not-in-history`
   * means it was not found — aged out of retention, or past the bound on how far back the caller looked —
   * so nothing about how the month was measured can be read from it either way.
   */
  readonly closingScan: 'read' | 'not-in-history';
}

/** The count of requirements the run reached an answer for: the three outcomes that are a reading. */
function answered(counts: OutcomeCounts): number {
  return counts.pass + counts.fail + counts.partial;
}

/** Every requirement the run considered, answered or not, so a share reads against a stated whole. */
function considered(counts: OutcomeCounts): number {
  return answered(counts) + counts.unmeasurable + counts.notApplicable;
}

/**
 * A score as it appears in the bytes: a whole number, or the fact that nothing scored.
 *
 * Exported because the endpoint renders a prior month's score the same way when it has to fall back to a
 * live scan, and two renderings of one number is how a series comes to disagree with the documents in it.
 */
export function scoreText(overall: number | undefined): string {
  return overall == null ? 'not scored' : String(Math.round(overall));
}

function inWindow(at: Date, window: MonthWindow): boolean {
  const t = at.getTime();
  return t >= window.start.getTime() && t < window.end.getTime();
}

/**
 * The last scan of the month: the one whose result landed latest inside the window.
 *
 * Exported for the endpoint, which finds each prior published month's closing scan the same way to
 * build the trend's series — one definition of "the month's close" rather than two that drift.
 */
export function closingScan(scans: readonly ScanSummary[], window: MonthWindow): ScanSummary | undefined {
  return scans
    .filter((scan) => inWindow(scan.finishedAt, window))
    .reduce<ScanSummary | undefined>((latest, scan) => {
      if (latest == null) return scan;
      return scan.finishedAt.getTime() > latest.finishedAt.getTime() ? scan : latest;
    }, undefined);
}

/**
 * The health of the month's assessment runs: the total, then one fact per state a run can be left in.
 *
 * Every state, not only the four terminal ones. A run whose record still says `running` is in the total
 * and was in none of the rows, so the breakdown failed to sum against its own total on the reader's
 * screen — arithmetic a reader can do, which no caption rescues. `Unfinished` is what the record says
 * rather than what the run is doing: a worker that died leaves the row exactly as a worker still working
 * does, and this document cannot tell them apart.
 */
function runHealth(runs: readonly Run[], window: MonthWindow): Fact[] {
  const assessment = runs.filter((run) => run.kind === 'assessment' && inWindow(run.requestedAt, window));
  const count = (state: Run['state']): string => String(assessment.filter((run) => run.state === state).length);
  return [
    { label: 'Assessment runs', value: String(assessment.length) },
    { label: 'Completed', value: count('complete') },
    { label: 'Partial', value: count('partial') },
    { label: 'Failed', value: count('failed') },
    { label: 'Cancelled', value: count('cancelled') },
    { label: 'Unfinished', value: count('running') },
  ];
}

/**
 * The month's coverage movement, from what it opened at to what it closed at, both ends carried.
 *
 * Empty unless there is both an opening reading and a closing one: a movement with one end is a
 * current figure dressed as a change, which is the thing `Movement` carries two ends to refuse. Score
 * and answered-of-considered and pillars-measured are the three the scan summary can state without
 * opening the stored run; confidence is not among them and is left out rather than invented, since
 * the summary does not carry it.
 */
function movement(from: ScanSummary | undefined, to: ScanSummary | undefined): Movement[] {
  if (from == null || to == null) return [];
  return [
    { label: 'Overall score', from: scoreText(from.overall), to: scoreText(to.overall) },
    {
      label: 'Requirements answered',
      from: `${String(answered(from.counts))} of ${String(considered(from.counts))}`,
      to: `${String(answered(to.counts))} of ${String(considered(to.counts))}`,
    },
    {
      label: 'Pillars measured',
      from: String(from.measuredPillars.length),
      to: String(to.measuredPillars.length),
    },
  ];
}

/**
 * The requirements whose finding changed between the month's opening and closing readings.
 *
 * Over the controls both readings measured, because a requirement one run scored and the other did
 * not has not "changed" — it went unread, which the coverage movement above already accounts for, and
 * reporting it here as a delta from an outcome to nothing would double-count a gap as a regression.
 * Sorted by control id so the bytes are a function of the readings and not of a map's iteration order.
 */
function findingDeltas(
  from: ScanSummary | undefined,
  to: ScanSummary | undefined,
  label: (controlId: string) => ControlLabel | undefined
): DeltaRow[] {
  const before = from?.outcomes;
  const after = to?.outcomes;
  if (before == null || after == null) return [];

  const rows: DeltaRow[] = [];
  for (const controlId of Object.keys(before).sort()) {
    const was = before[controlId];
    const now = after[controlId];
    if (now == null || was === now) continue;
    const words = label(controlId);
    rows.push({
      control: controlId,
      requirement: words?.requirement ?? controlId,
      pillar: words?.pillar ?? 'unclassified',
      from: was,
      to: now,
    });
  }
  return rows;
}

/**
 * The month's exceptions: the requirements carried as an accepted risk that was standing at its close.
 *
 * Grouped by requirement, one row for the acceptance in force at the month's end — `inForce` picks it
 * out of a requirement's history, and a requirement with none in force at that instant contributes
 * nothing. `until` is the expiry as a plain date, not the stored timestamp, for the reason the risk
 * module renders it as one: the milliseconds and the zone are the record's business and read as a
 * fault to somebody being told which day the requirement comes back. Sorted by control id.
 */
function exceptions(
  risks: readonly AcceptedRisk[],
  asOf: Date,
  label: (controlId: string) => ControlLabel | undefined
): ExceptionRow[] {
  const byControl = new Map<string, AcceptedRisk[]>();
  for (const risk of risks) {
    const group = byControl.get(risk.controlId);
    if (group == null) byControl.set(risk.controlId, [risk]);
    else group.push(risk);
  }

  const rows: ExceptionRow[] = [];
  for (const controlId of [...byControl.keys()].sort()) {
    const standing = inForce(byControl.get(controlId) ?? [], asOf);
    if (standing == null) continue;
    const words = label(controlId);
    rows.push({
      control: controlId,
      requirement: words?.requirement ?? controlId,
      owner: standing.owner,
      residual: standing.residual,
      until: standing.expiresAt.toISOString().slice(0, 10),
    });
  }
  return rows;
}

/**
 * What the review of the closing run was made of, frozen with the month.
 *
 * Empty where there is a closing run and no record of a review of it. A row reading "not reviewed"
 * would be this document saying somebody had failed to do something, on a record that only says this
 * app has no review of that run.
 *
 * The skipped pillars are named rather than counted, because a permanent record of a month that
 * reports a score nobody reviewed part of has to say which part — and named in the catalogue's words,
 * like every other string here, because the document displays what it carries and `cost-optimization`
 * is not a sentence. The cited count says what it is counted from in the same cell: it is answers the
 * run already held, not answers on record at publish.
 */
function review(
  finalisation: FinalisationPayload<Date> | undefined,
  title: (pillarId: string) => string | undefined
): Fact[] {
  if (finalisation == null) return [];
  const { finalised, recorded, expected, confirmed, skipped, cited } = finalisation;
  const named = skipped.map((id) => title(id) ?? id);

  return [
    {
      label: 'Review',
      value: finalised
        ? `Finalised${finalisation.finalisedBy != null ? ` by ${finalisation.finalisedBy}` : ''}`
        : `Not finished: ${String(recorded)} of ${String(expected)} pillars have a record`,
    },
    { label: 'Pillars confirmed', value: `${String(confirmed)} of ${String(expected)}` },
    {
      label: 'Pillars skipped',
      value:
        named.length === 0
          ? 'None'
          : `${named.join(', ')} — nobody confirmed ${named.length === 1 ? 'its' : 'their'} answers in this review`,
    },
    { label: 'Answers cited', value: `${String(cited)}, which the run already held` },
  ];
}

/** The closing reading's outcome census: one fact per outcome the counts distinguish. */
function outcomes(closing: ScanSummary | undefined): Fact[] {
  if (closing == null) return [];
  const { counts } = closing;
  return [
    { label: 'Met', value: String(counts.pass) },
    { label: 'Failing', value: String(counts.fail) },
    { label: 'Partial', value: String(counts.partial) },
    { label: 'Not applicable', value: String(counts.notApplicable) },
    { label: 'Unmeasured', value: String(counts.unmeasurable) },
  ];
}

/**
 * What moved on the improvement board during the month, counted from the actions' own timestamps.
 *
 * Raised is a creation in the window; verified and cancelled are transitions into those states in the
 * window, read from the history rather than from the current state — an action verified in the month
 * and reopened since was still verified in the month, and the history is where that stays true. No
 * "open at close" count, which would need the state reconstructed as at the window's end rather than
 * read as it is now, and that reconstruction is a claim this section does not need to make.
 */
function actionsMoved(actions: readonly ImprovementAction[], window: MonthWindow): Fact[] {
  const raised = actions.filter((action) => inWindow(action.createdAt, window)).length;
  const enteredIn = (state: ImprovementAction['state']): number =>
    actions.filter((action) => action.history.some((step) => step.to === state && inWindow(step.at, window))).length;
  return [
    { label: 'Actions raised', value: String(raised) },
    { label: 'Actions verified', value: String(enteredIn('verified')) },
    { label: 'Actions cancelled', value: String(enteredIn('cancelled')) },
  ];
}

/**
 * The month's whole content, ready for the builder to freeze.
 *
 * A pure function of the records passed in: the same sources produce the same rows, which is what lets
 * the same publication produce the same bytes and therefore the same digest. The trend is a snapshot of
 * the published series as it reads at this publish, anchored to this month and frozen with the document
 * — a month published before any other carries only itself.
 */
export function monthContent(sources: MonthSources): MonthContent {
  const closing = closingScan(sources.scans, sources.window);
  const finalisation = sources.finalisation;
  return {
    ...(closing != null && finalisation?.resultId != null
      ? {
          assessment: {
            runId: closing.id,
            reviewId: finalisation.reviewId,
            finalResultId: finalisation.resultId,
            ...(closing.stamp?.definition != null
              ? {
                  definition: {
                    id: closing.stamp.definition.id,
                    version: closing.stamp.definition.version,
                    fingerprint: closing.stamp.definition.fingerprint,
                  },
                }
              : {}),
          },
        }
      : {}),
    runHealth: runHealth(sources.runs, sources.window),
    findingDeltas: findingDeltas(sources.priorScan, closing, sources.label),
    movement: movement(sources.priorScan, closing),
    actions: actionsMoved(sources.actions, sources.window),
    exceptions: exceptions(sources.risks, sources.window.end, sources.label),
    outcomes: outcomes(closing),
    // No section at all where no run closed the month: an empty one says this app has no record of a
    // review, and there is nothing here for a review to have been of.
    ...(closing != null ? { review: review(sources.finalisation, sources.pillarTitle ?? (() => undefined)) } : {}),
    trend: monthTrend(sources, closing),
  };
}

/**
 * The month's trend: each published month as a point, carrying what the server's comparability rule
 * decided about placing it on the same line as the month being published.
 *
 * The base is the month being published — the newest point — so the series answers the question a
 * reader of this publication has: which earlier months sit on the same basis as this one. A point that
 * cannot be compared is drawn with its reason rather than dropped, because a line that omits the month
 * the catalogue changed, or the identity switched, is a smooth curve across a discontinuity — the lie
 * `trend.ts` documents at length. The rule is the server's own `comparable`, not a second one that
 * could drift from it: the same decision the live series and the carry-forward guard already make, over
 * the whole stamp rather than the two fields the client narrowed to before this.
 */
function monthTrend(sources: MonthSources, closing: ScanSummary | undefined): TrendPoint[] {
  const current: MonthPoint | undefined =
    closing == null
      ? undefined
      : {
          month: sources.month,
          score: scoreText(closing.overall),
          ...(closing.stamp != null ? { stamp: closing.stamp } : {}),
          // The month being published is closed by a scan this run just read.
          closingScan: 'read',
        };
  // Oldest first, the direction a line is read, with the month being published last as the base. The
  // series excludes the current month, so a correction of an already-published month does not draw it
  // twice — once from the store and once from this run's own closing scan.
  const ordered: MonthPoint[] = [...(sources.series ?? []), ...(current != null ? [current] : [])];
  const base = ordered.at(-1);
  if (base == null) return [];

  return ordered.map((point) => {
    // The base still passes through the shared rule. Most bases compare to themselves, but a
    // development run deliberately does not: absence of a public methodology identity keeps it out
    // of a customer trend even when it is the only point. Hard-coding the base to `permitted` made the
    // same monthly preview say both “cannot be published as Version 1” and “Comparable”.
    const [comparability, note] = placeAgainst(base, point);
    return {
      month: point.month,
      label: monthLabel(point.month),
      score: point.score ?? 'not scored',
      comparability,
      ...(note != null ? { note } : {}),
    };
  });
}

/** Where a point sits relative to the base, by the server's own comparability rule. */
function placeAgainst(
  base: MonthPoint,
  point: MonthPoint
): readonly ['permitted' | 'caveat' | 'refused', string | undefined] {
  if (base.stamp == null) return ['refused', whyUnplaceable(base)];
  if (point.stamp == null) return ['refused', whyUnplaceable(point)];
  // Base is the later run — the month being published — and the point is the earlier one, which is the
  // order `comparable` reads its two arguments in, so the reason it returns reads from earlier to later.
  const verdict = comparable(base.stamp, point.stamp);
  if (!verdict.ok) return ['refused', verdict.reason];
  if (verdict.caveat != null) return ['caveat', verdict.caveat];
  return ['permitted', undefined];
}

/**
 * Why a month with no measurement basis cannot go on the line, in the words its own case allows.
 *
 * Two cases, and the difference is what the reader can do about it. A run that did not record a basis is
 * a fact about that run and permanent. A run this app can no longer read is a fact about this app's
 * retention — the month is still on record with a score, and its own published document says how it was
 * measured, which is where somebody goes next. Saying the first about the second was false about the
 * month, and it pointed the reader at the wrong thing.
 */
function whyUnplaceable(point: MonthPoint): string {
  const label = monthLabel(point.month);
  return point.closingScan === 'not-in-history'
    ? `The run that closed ${label} is not in the scan history this app reads, so how it was measured ` +
        `cannot be read from it. That month’s own published document is where it is recorded.`
    : `The run that closed ${label} did not record how it was measured, so it cannot be placed on the ` +
        `same line as the others.`;
}
