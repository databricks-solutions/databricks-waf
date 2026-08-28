// What the advisor produced, as a record.
//
// The counterpart of a `Scan`, and deliberately not a kind of one. ADR 0061 separated the two because
// five things differ — the window, the cost, the cadence, the versioning and how fast the answer goes
// stale — and the record is where that separation has to hold: an assessment export that carried
// advisory content would be a sealed artifact making claims that expired weeks after it was signed.
//
// # Why the analysis is stored rather than recomputed
//
// The same reason a scan stores its serverless readiness. `encodeScan` drops `value` from every reading
// before it is written, so the raw rows an analysis was derived from are not on the record. Recomputing
// when somebody opens the page would mean re-reading the estate, and the answer would then be from a
// different moment than the run it was attributed to. So an advisory run analyses once, at the end, and
// what it writes down is the analysis.
//
// The readings are kept too, but as evidence of what was reachable rather than as the analysis's input:
// a page has to be able to say "this could not be read" and name the reason.

import type { SignalResult } from '../collect/signal.js';
import type { EstateScope } from '../collect/estate-scope.js';
import type { ExecutionMode } from '../collect/credentials.js';
import type { RunDefinition } from '../scan/identity.js';
import type { ServerlessReadiness } from '../analyze/serverless.js';
import type { JobAnalysis } from './jobs.js';
import type { SizingAnalysis } from './sizing.js';
import type { WorkloadAnalysis } from './workload.js';
import type { WriteAnalysis } from './writes.js';
import type { PlanRetrievalSummary } from '../collect/sql/plans/retrieve.js';
import type { PlanCapabilityAlert } from './plan-capability.js';

/**
 * How completely an advisory run got through what it set out to read.
 *
 * The same two words a scan uses, and for the same reason: a reader deciding whether to act on advice
 * needs to know whether the advice was formed from the whole window or from part of it.
 */
export type AdvisoryState = 'complete' | 'partial';

/** Who ran it and under what authority, so a finding can be traced to the identity that read it. */
export interface AdvisoryStamp {
  readonly actor: string;
  readonly executionMode: ExecutionMode;
  /** The warehouse its statements ran on. Absent where none was bound. */
  readonly warehouse?: string;
}

/** One run of the advisor, and what it concluded. */
export interface Advisory {
  readonly id: string;
  /**
   * The run that produced it.
   *
   * Both ids, rather than the run id standing in for both. A run exists from the moment somebody asks
   * for one and may end with nothing; an advisory exists only once there is something to read. The
   * same distinction the audit trail draws between a run and a scan, for the same reason.
   */
  readonly runId: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly state: AdvisoryState;
  /** Named when the run stopped short of its plan, for the reason `Scan.incompleteReason` gives. */
  readonly incompleteReason?: string;
  readonly scope: EstateScope;
  readonly lookbackDays: number;
  readonly stamp: AdvisoryStamp;
  /** The assessment whose scope this ran against, when it was started from one. */
  readonly definition?: RunDefinition;
  /**
   * What it managed to read, without the values.
   *
   * Kept so a page can say which part of the estate was unreadable and why, which is the difference
   * between "no classic jobs to move" and "the jobs table refused". Not the analysis's input — see the
   * note at the top of this file.
   */
  readonly readings: readonly SignalResult[];
  /**
   * Per-job serverless readiness.
   *
   * The advisor's first analysis, and until row 33 its only one. Optional because a run whose signals
   * were all unreadable has nothing to put here, which is different from a run that found no jobs to
   * move: `analyseServerless` answers `undefined` for the first and an empty analysis for the second.
   */
  readonly serverless?: ServerlessReadiness;
  /**
   * The costliest query shapes, what is wrong with them, and how much of the estate that covers.
   *
   * Optional on the same terms as `serverless`, and the distinction matters more here because of what
   * the empty case would say. An estate with no expensive queries is a real and reportable finding; a
   * window whose query history could not be read is not, and rendering the second as the first would be
   * the app's most flattering possible lie about a workspace it could not see.
   */
  readonly workload?: WorkloadAnalysis;
  /**
   * What each warehouse was asked to do, and what its size and shape should be.
   *
   * Optional on the same terms as the two above. The empty case here is the one most worth not
   * misreading: a run that could not read `system.compute.warehouse_events` has nothing to say about
   * sizing, and an empty analysis would render as an estate whose warehouses are all correctly sized —
   * which is a conclusion this run did not reach.
   */
  readonly sizing?: SizingAnalysis;
  /**
   * How the estate writes, and which of its write shapes are worth looking at.
   *
   * Optional on the same terms as the three above, and the empty case here is the most flattering absence
   * on the record: an estate whose query history could not be read would render as one that writes
   * nothing, which on a lakehouse nobody should conclude from a failed read. `analyseWrites` answers
   * `undefined` for that and an analysis with no shapes cannot occur — the statement returns rows or it
   * does not.
   */
  readonly writes?: WriteAnalysis;
  /**
   * How the estate's longest-running jobs ran, and what is wrong with the runs.
   *
   * Optional on the same terms as the three above, and the empty case here has a second way to mislead
   * beyond theirs: this analysis reads four rules, where the audit document has eight, because the other
   * six need compute relations that hold no row for serverless compute. So a reader who takes an absence
   * of findings for a healthy job estate would be wrong twice over — once about what was read, and once
   * about what this can read at all. `JobAnalysis` carries `eligible` and `population` so a surface can
   * say the first; the second is in the ruleset's own words.
   */
  readonly jobs?: JobAnalysis;
  /**
   * What asking the query history service for the costly shapes' plans came to.
   *
   * Optional for a different reason from the three above: those are absent when an analysis could not be
   * formed, and this is absent when the run did not reach the point of trying — a run whose shapes were
   * unreadable has no nominations to fetch plans for. Present-and-empty is therefore meaningful here,
   * where for the others it would be the flattering lie they each warn about.
   *
   * A summary rather than the plans. `33b` measured the extracts at 2 MB per workspace per scan and this
   * record is one jsonb document; they are kept in `plan_extracts` — see `plan-store.ts`.
   */
  readonly plans?: PlanRetrievalSummary;

  /**
   * How many extracts this run filed in `plan_extracts`.
   *
   * Here so that filing them is not silent. The runner does not fail a run over a plan write, so without
   * a number on the record a table that had stopped accepting rows would look exactly like an estate
   * whose plans were all unreadable — and the summary above would keep reporting plans read.
   *
   * So: absent on a record whose `plans.available` is above zero means the write did not finish. Not "did
   * not happen" — the store writes a shape at a time, so a failure partway through has filed some of them
   * and this says only that it stopped. Three things make the reading hold, none of them local: `available`
   * and the plans themselves are set on the same branch in `retrievePlans`, so one cannot be above zero
   * while the other is empty; a run where every plan lacked a start time returns 0 rather than nothing;
   * and `chooseStore` binds this store in the same breath as the advisory store, so a record that could be
   * saved at all had somewhere to file plans.
   *
   * It can be lower than `available` without anything being wrong, because a plan whose execution carried
   * no start time is not filed; `retrievePlans` says when that is possible.
   *
   * Read by querying the record, not from a surface: `advisoryPayload` carries neither this nor `plans`,
   * so the comparison this describes is one an operator with database access makes. Whatever surface reads
   * `plan_extracts` is where both of them should appear.
   */
  readonly retainedPlans?: number;

  /**
   * The one thing worth saying about how this run's plan reach compares with an earlier one, where there
   * is one. Absent means either that reach held up or that there was nothing to compare against, which
   * this field cannot tell apart; `PlanCapabilityPayload` says why.
   */
  readonly planCapability?: PlanCapabilityAlert;
}

/**
 * Whether a run found anything worth showing.
 *
 * Asked by the route before it answers, because the honest response to a run that read nothing is not
 * an empty page — it is that this run could not see the estate. A scan makes the same distinction
 * through its footprint; an advisory run has no score to make it visible, so it is asked directly.
 */
export function sighted(advisory: Advisory): boolean {
  return advisory.readings.some((reading) => reading.status === 'observed');
}
