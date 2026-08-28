// Where scans are kept.
//
// An interface with an in-memory implementation, because the durable one belongs in
// Lakebase and the app has to be useful before that exists. The interface is what makes
// the swap a substitution rather than a rewrite, and the in-memory implementation is
// explicit about what it loses so that nobody builds a trend feature on top of it and
// discovers the problem in a demo.
//
// What it loses: everything, on every process restart. Databricks Apps restarts the
// process on deploy and on platform scaling, so an in-memory history is a history of
// the current process rather than of the estate.

import type { Outcome } from '../resolve/finding.js';
import type { ScoreRange } from '../score/score.js';
import type { Scan, ScanStamp } from './scan.js';
import type { AssessmentScope } from '../store/assessment-scope.js';
import { inScope } from '../store/assessment-scope.js';

/**
 * A run, legible without opening it.
 *
 * Carries who ran it and under which identity kind, what it was asked to measure against what
 * it measured, and what it found. The reason for all of that on the summary rather than only
 * inside the scan: a history row reading "12:04, 55.2" cannot answer the question a history is
 * for, which is why this run differs from the one before it. Two runs an hour apart with
 * different scores are explained by a different actor or a narrower request far more often than
 * by the estate changing in an hour.
 */
export interface ScanSummary {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly state: Scan['state'];
  readonly overall?: number;
  /**
   * How far `overall` could still move, so a reader of the index is told the same thing a reader of
   * the scan is.
   *
   * `scoreVerdict` withholds the word where too little was measured, and it can only do that where
   * it is given the range. Without this the history list banded 65.3 as "Fair" while the overview,
   * reading the same run out of the scan itself, withheld the verdict — one run, two surfaces, two
   * answers.
   *
   * Absent on a run recorded before this was kept. That run's scan still carries the range, so the
   * two surfaces would disagree about it for as long as it is retained; the history list renders no
   * verdict word at all where the summary has no range, rather than the band word it cannot check.
   */
  readonly range?: ScoreRange;
  readonly actor: string;
  /** What that identity called itself. On the summary because the history table reads only this. */
  readonly actorName?: string;
  /** Whether the run was the signed-in user or a service principal. They see different estates. */
  readonly executionMode: Scan['stamp']['executionMode'];
  /** Whether a person or a schedule started it. Absent on runs recorded before this was kept. */
  readonly trigger?: Scan['stamp']['trigger'];
  readonly catalogueVersion: string;
  /** Absent means the run was asked for every pillar the build assesses. */
  readonly requestedPillars?: readonly string[];
  /** The pillars the result covers, whether measured by this run or carried forward. */
  readonly measuredPillars: readonly string[];
  /** The pillars this run measured itself. A subset of `measuredPillars` for a targeted rerun. */
  readonly freshPillars: readonly string[];
  readonly counts: OutcomeCounts;
  /**
   * Each pillar's score in this run, by pillar id. Omitted for a pillar this run did not score.
   *
   * Here so a trend can be drawn from the history index alone. The alternative is opening every
   * stored scan to read seven numbers out of a hundred-kilobyte document each, which for a
   * twenty-run window is twenty volume reads to draw a sparkline — the exact cost the index
   * exists to avoid.
   */
  readonly pillarScores: Readonly<Record<string, number>>;
  /**
   * What this run found for each requirement, by control id.
   *
   * Here rather than read out of the stored run for the reason the pillar scores are: an
   * occurrence history over twenty runs would otherwise be twenty reads of a hundred-kilobyte
   * document to take one string out of each. A hundred and eighty short strings is a few kilobytes
   * beside a summary that already exists.
   *
   * Absent on a run recorded before this was kept, which is a fact and not a gap — an occurrence
   * history stops there and says so, rather than treating a run it cannot read as a run in which
   * nothing was found.
   */
  readonly outcomes?: Readonly<Record<string, Outcome>>;
  /**
   * The whole stamp, for the one reader that needs all of it: a comparison.
   *
   * This overlaps `actor`, `executionMode` and `catalogueVersion` above, and the overlap is
   * deliberate. Those three are a projection the history page renders directly and every stored
   * summary already carries; this is the record `comparable` reads, and occurrence history is only
   * honest if it refuses a run for the same reasons every other comparison in the app does. Writing
   * a second, narrower comparability rule against the flat fields would be a rule that drifts —
   * it would have silently claimed a streak across the methodology change ADR 0043 refuses.
   *
   * `summarise` derives both from the same scan and a test holds them to agreeing, so the
   * duplication cannot become a disagreement.
   *
   * Absent on a run recorded before this was kept.
   */
  readonly stamp?: ScanStamp;
}

/** What the run found, by outcome, so a history row shows a result and not only a number. */
export interface OutcomeCounts {
  readonly pass: number;
  readonly fail: number;
  readonly partial: number;
  readonly unmeasurable: number;
  readonly notApplicable: number;
}

export interface ScanStore {
  /** True when results survive a process restart. Surfaced in the UI, not assumed. */
  readonly durable: boolean;
  save(scan: Scan): Promise<void>;
  get(id: string, scope?: AssessmentScope): Promise<Scan | undefined>;
  latest(scope?: AssessmentScope): Promise<Scan | undefined>;
  history(limit?: number, scope?: AssessmentScope): Promise<ScanSummary[]>;
  /**
   * Why the last read came back short, if it did.
   *
   * `history` answers with what it could read rather than failing the request, which is right — a
   * history page that errors is worse than one missing a row, and the scan just run is still on
   * screen. What it cannot do is stay silent about it: a database that is unreachable would
   * otherwise render as an estate that has never been assessed, which is a different and much more
   * alarming statement than the true one. Optional because a store that cannot fail to read has
   * nothing to say here.
   */
  unreadable?(): string | undefined;
}

export function summarise(scan: Scan): ScanSummary {
  return {
    id: scan.id,
    startedAt: scan.startedAt,
    finishedAt: scan.finishedAt,
    state: scan.state,
    ...(scan.score.overall != null ? { overall: scan.score.overall } : {}),
    ...(scan.score.range != null ? { range: scan.score.range } : {}),
    actor: scan.stamp.actor,
    ...(scan.stamp.actorName != null ? { actorName: scan.stamp.actorName } : {}),
    executionMode: scan.stamp.executionMode,
    ...(scan.stamp.trigger != null ? { trigger: scan.stamp.trigger } : {}),
    catalogueVersion: scan.stamp.catalogueVersion,
    ...(scan.requestedPillars != null ? { requestedPillars: scan.requestedPillars } : {}),
    measuredPillars: scan.measurement.map((entry) => entry.pillarId),
    freshPillars: scan.measurement.filter((entry) => !entry.carriedForward).map((entry) => entry.pillarId),
    counts: count(scan),
    pillarScores: Object.fromEntries(
      scan.score.pillars
        .filter((pillar): pillar is typeof pillar & { score: number } => pillar.score != null)
        .map((pillar) => [pillar.pillarId, pillar.score])
    ),
    outcomes: Object.fromEntries(scan.findings.map((finding) => [finding.controlId, finding.outcome])),
    stamp: scan.stamp,
  };
}

function count(scan: Scan): OutcomeCounts {
  const of = (...outcomes: readonly string[]) =>
    scan.findings.filter((finding) => outcomes.includes(finding.outcome)).length;

  return {
    // Architecture-satisfied counts as met: it is a requirement the estate does not need to
    // meet separately, not a third kind of success the reader has to learn on a history row.
    pass: of('pass', 'satisfied-by-architecture'),
    fail: of('fail'),
    partial: of('partial'),
    unmeasurable: of('unmeasurable'),
    notApplicable: of('not-applicable'),
  };
}

export class InMemoryScanStore implements ScanStore {
  readonly durable = false;

  private readonly scans: Scan[] = [];

  constructor(private readonly capacity = 20) {}

  save(scan: Scan): Promise<void> {
    this.scans.unshift(scan);
    // Bounded, because a scan holds every finding and every signal value and the app
    // runs in a container with a memory limit. An unbounded history would eventually
    // take the process down, which is a worse failure than a short history.
    if (this.scans.length > this.capacity) this.scans.length = this.capacity;
    return Promise.resolve();
  }

  get(id: string, scope?: AssessmentScope): Promise<Scan | undefined> {
    const scan = this.scans.find((one) => one.id === id);
    if (scan == null || !inScope(scan.stamp.definition?.id, scope)) return Promise.resolve(undefined);
    return Promise.resolve(scan);
  }

  latest(scope?: AssessmentScope): Promise<Scan | undefined> {
    return Promise.resolve(this.scans.find((scan) => inScope(scan.stamp.definition?.id, scope)));
  }

  history(limit = this.capacity, scope?: AssessmentScope): Promise<ScanSummary[]> {
    return Promise.resolve(
      this.scans
        .filter((scan) => inScope(scan.stamp.definition?.id, scope))
        .slice(0, limit)
        .map(summarise)
    );
  }
}
