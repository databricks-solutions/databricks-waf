// The workload analysis: which query shapes cost the most, what is wrong with them, and how much of the
// estate that describes.
//
// Assembles the pieces around it — the shapes the statement returned, the composite ranking, the rules, this
// run's query plans and the trend classification — into the thing a page renders and a record stores.
//
// The plans arrive as an index rather than a list, and most rows have none: a plan is one nominated execution
// per shape, and `33k` measured that a shape whose warehouse belongs to another workspace has none at all. So
// a plan-fed finding is present on some rows and absent on others for a reason that is about reach, and the
// only rule reading them says nothing where there is nothing to read.
//
// # The coverage disclosure is not a footnote
//
// `REFRESH` is excluded from everything here, because a materialised view is a managed service and there
// is no knob a reader could turn in response to a finding about one. On the estate this was calibrated
// against that exclusion removes 62.9% of query time and 99.6% of all spill, which means a page headed
// "your costliest queries" would be describing about a third of the query time in the workspace.
//
// So `coverage` is part of the analysis rather than a note on the surface, and it carries the measured
// figures rather than a sentence. A reader who is not told this reasonably assumes the ranked list is the
// estate, and the moment they compare it to a billing figure they will catch the app out — which costs
// more trust than the disclosure ever costs attention.
//
// # What is ranked is not what is shown
//
// The statement returns forty shapes ordered by total time, so the composite has something to reorder;
// `top` is the twelve a page shows. Both counts are here rather than in the client, because "the twelve
// worst" is a claim about the analysis and a client that sliced a longer list would be making it
// independently.

import type { QueryShapeRow } from '../collect/sql/shapes.js';
import { noPlans, readingFor, type PlanIndex } from './plan-index.js';
import { noStats, type StatsIndex } from './stats-index.js';
import { byFailure, rank, WEIGHTS_VERSION, type Ranked } from './ranking.js';
import { findingsFor, type Finding } from './rules.js';
import { classify, type Trend } from './trend.js';
import { workloadRules, type WorkloadRuleset } from './workload-rules.js';

/**
 * How many shapes a reader is shown.
 *
 * Twelve. Both design documents say the same thing in different words — *"prefer a small number of
 * high-confidence findings over a long list of generic advice"* (advisor, line 1115) — and the reason is
 * not screen space. An advisor that reports forty findings is one a reader closes, because triaging it is
 * more work than the work it is describing.
 */
export const SHOWN = 12;

/** One shape as the analysis describes it: the numbers, the score, what is wrong, and whether it is new. */
export interface WorkloadShape {
  readonly shape: string;
  readonly workspaceId: string;
  readonly statementType: string;
  readonly score: number;
  /** Which of the seven features the score came from, so a reader learns why it is here. */
  readonly features: Ranked['features'];
  readonly trend: Trend;
  readonly findings: readonly Finding[];
  /** The row itself, so a surface can show a figure the analysis did not name. */
  readonly row: QueryShapeRow;
}

/**
 * How much of the estate's query time the analysis is about.
 *
 * `coveredMs`, `excludedMs` and `selfMs` are measured by the statement, over the current window, and
 * together they are the window's query time. `percent` is absent rather than 100 when there was no query
 * time at all: an estate that ran nothing has no coverage figure, and reporting complete coverage of
 * nothing is the kind of true-but-misleading number this whole disclosure exists to avoid.
 *
 * `percent` is a percentage — 93.8, not 0.938 — which is what the field is named and what the first
 * reader of this page got wrong, printing 9,380%. Said here because the two conventions are equally
 * defensible and only one of them is what the server sends.
 */
export interface Coverage {
  readonly coveredMs: number;
  readonly excludedMs: number;
  /** What the assessment itself spent. Excluded from the analysis, and the tool's own cost. */
  readonly selfMs: number;
  readonly coveredRuns: number;
  readonly excludedRuns: number;
  readonly selfRuns: number;
  /**
   * Covered work that reaches no shape, because its shapes spanned several statement types.
   *
   * A subset of `coveredMs` and `coveredRuns`, not a fourth slice of the window. The statement computes
   * coverage before it drops those shapes, so this is the difference between the work this advisor can
   * speak about and the work it did speak about.
   */
  readonly ambiguousMs: number;
  readonly ambiguousRuns: number;
  readonly ambiguousShapes: number;
  /**
   * The share of the window's query time that grouped into a shape this advisor can describe.
   *
   * Covered less ambiguous over the total, rather than covered over the total. Those differ by 1.0% of
   * query time on the estate the homogeneity guard was measured against, and the smaller is the honest
   * one: covered counts work whose shape the statement then declined to return.
   *
   * Not the share the shapes on a page account for, and nothing here is. The statement returns at most
   * `:shape_limit` shapes and a page shows twelve, where this is over every unambiguous shape in the
   * estate — tens of thousands of them on the estate this was calibrated against. A figure about the
   * shown rows would need their total returned alongside, and it is not.
   */
  readonly percent?: number;
}

export interface WorkloadAnalysis {
  /** The twelve a page shows, best-scoring first. */
  readonly top: readonly WorkloadShape[];
  /** Shapes that failed, worst rate first, whatever they scored. Its own list for the reason in ranking.ts. */
  readonly failing: readonly WorkloadShape[];
  readonly coverage: Coverage;
  /** Shapes the statement returned, before the twelve were taken. */
  readonly considered: number;
  /** Findings across every considered shape, not only the shown ones. */
  readonly findingCount: number;
  /** The coefficient set and the ruleset version, so two runs can be told apart rather than compared. */
  readonly rankingVersion: string;
  readonly rulesVersion: number;
  /** The window the comparison is over, in days, per half. See trend.ts: fifteen is the ceiling. */
  readonly windowDays: number;
}

/**
 * The analysis, or `undefined` where there is nothing to analyse.
 *
 * `undefined` rather than an empty analysis, and the distinction is the same one the serverless analyzer
 * draws: no rows means the statement could not be read or the window held no queries, and an empty
 * analysis would render as an estate with no expensive queries — which is a finding, and not one this
 * run made. The caller reports it as unread; a run whose statement genuinely returned zero shapes over a
 * live window is indistinguishable from an unreadable one here, and the readings on the record are what
 * tell those apart.
 */
export function analyseWorkload(
  rows: readonly QueryShapeRow[],
  lookbackDays: number,
  ruleset: WorkloadRuleset = workloadRules(),
  plans: PlanIndex = noPlans(),
  stats: StatsIndex = noStats()
): WorkloadAnalysis | undefined {
  if (rows.length === 0) return undefined;

  const ranked = rank(rows);
  const described = new Map(ranked.map((one) => [one.row.shape, describe(one, ruleset, plans, stats)] as const));

  const failing = byFailure(rows).flatMap((row) => {
    const found = described.get(row.shape);
    return found == null ? [] : [found];
  });

  return {
    top: ranked.slice(0, SHOWN).flatMap((one) => {
      const found = described.get(one.row.shape);
      return found == null ? [] : [found];
    }),
    failing,
    coverage: coverageOf(rows),
    considered: rows.length,
    findingCount: [...described.values()].reduce((total, shape) => total + shape.findings.length, 0),
    rankingVersion: WEIGHTS_VERSION,
    rulesVersion: ruleset.version,
    // The window per half, which is what the trend is over. Capped the same way the statement caps it, so
    // a caller asking for ninety days is told fifteen rather than told what it asked for.
    windowDays: Math.min(lookbackDays, 15),
  };
}

function describe(one: Ranked, ruleset: WorkloadRuleset, plans: PlanIndex, stats: StatsIndex): WorkloadShape {
  return {
    shape: one.row.shape,
    workspaceId: one.row.workspaceId,
    statementType: one.row.statementType,
    score: Math.round(one.score * 1000) / 1000,
    features: one.features,
    trend: classify(one.row),
    findings: findingsFor(one.row, ruleset, readingFor(plans, one.row), stats),
    row: one.row,
  };
}

/**
 * The coverage figures, read off any row.
 *
 * The statement cross-joins one row of them onto every result row, so every row carries the same pair and
 * the first is as good as any. Taken from the first rather than summed, which would multiply the estate's
 * query time by the number of shapes returned.
 */
function coverageOf(rows: readonly QueryShapeRow[]): Coverage {
  const first = rows[0];
  const covered = first?.coveredMs ?? 0;
  const excluded = first?.excludedMs ?? 0;
  // The assessment's own queries are in the denominator, because they are on the customer's bill. Leaving
  // them out would report near-total coverage of an estate the analysis had described half of, and on the
  // workspace this was first run against half is the literal figure: 51.8% of query time was ours.
  const self = first?.selfMs ?? 0;
  const total = covered + excluded + self;
  // Subtracted from the numerator and not from the denominator: ambiguous time was spent, so it belongs
  // in the window's query time, and it is not described, so it does not belong in what this covers.
  //
  // The subset relation that makes the subtraction safe is a property of the statement, not of this
  // function: both sums are over the same rows on the same basis, so ambiguous cannot exceed covered.
  // `max(0, …)` is what keeps a change there from reaching a reader as a negative percentage, which
  // would be read as a finding about the estate rather than as the bug it would be.
  const ambiguous = first?.ambiguousMs ?? 0;
  const described = Math.max(0, covered - ambiguous);
  return {
    coveredMs: covered,
    excludedMs: excluded,
    selfMs: self,
    coveredRuns: first?.coveredRuns ?? 0,
    excludedRuns: first?.excludedRuns ?? 0,
    selfRuns: first?.selfRuns ?? 0,
    ambiguousMs: ambiguous,
    ambiguousRuns: first?.ambiguousRuns ?? 0,
    ambiguousShapes: first?.ambiguousShapes ?? 0,
    ...(total > 0 ? { percent: Math.round((1000 * described) / total) / 10 } : {}),
  };
}
