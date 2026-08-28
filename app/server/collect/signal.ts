// Signals: the evidence layer, kept separate from the controls it answers.
//
// The reason for the split is a ratio. There are 183 scored units in the catalogue
// and nothing like 183 independent things to measure — one query over
// `system.billing.usage` speaks to compute choice, autoscaling, auto-termination
// and serverless adoption at once, across three different pillars. Collect per
// control and that query runs four times, four ways, drifting apart as each is
// maintained separately.
//
// So collectors produce signals, and resolvers turn signals into control outcomes.
// A signal knows nothing about scoring. That boundary is also what makes the
// applicability model workable, since a precondition is just another signal read.

import type { Surface } from '../scan/surfaces.js';
import type { CredentialProvider } from './credentials.js';
import type { Provenance } from './provenance.js';
import type { CollectionScheduler } from '../scan/scheduler.js';

/**
 * A signal identifier, matching the `collector:` field in the control catalogue —
 * `sql:maintenance.recency`, `cloud:storage.volume`.
 *
 * The prefix is the surface, which means the catalogue itself declares what a
 * control costs to evaluate. That is what lets a scan be planned before it runs
 * rather than discovered as it goes.
 */
export type SignalId = `${Surface}:${string}`;

export function surfaceOf(id: SignalId): Surface {
  return id.slice(0, id.indexOf(':')) as Surface;
}

export type SignalStatus =
  | 'observed'
  /**
   * The signal could not be collected and the controls depending on it must say so
   * rather than fail. Distinguished from `observed` with an empty value, which is a
   * real observation that the estate contains none of something.
   */
  | 'unmeasurable';

/**
 * How far a signal sees, which is a property of the data it reads rather than a choice.
 *
 * Measured on labs from one install: `system.billing.usage` carried 11 workspaces,
 * `system.compute.warehouses` 70, `system.access.audit` 10. Those tables are
 * account-wide. `system.information_schema` is not — it belongs to the metastore
 * attached to the querying workspace, so a multi-region account needs one install
 * per region. And a workspace-scoped token was refused by all three sibling
 * workspaces, so anything only a workspace API can answer stops at this workspace.
 *
 * A query's reach is the narrowest reach of any table it reads: joining
 * `information_schema` onto an account-wide table yields a metastore-wide answer,
 * not an account-wide one. See ADR 0015.
 */
export type Reach = 'account' | 'metastore' | 'workspace';

/** Narrowest first, so a combination can be reduced without a comparator per call site. */
const REACH_ORDER: readonly Reach[] = ['workspace', 'metastore', 'account'];

/**
 * Whether a signal describes the whole estate or a declared subset of it.
 *
 * Present on the signal rather than only on the finding, because the collector is
 * the only layer that knows. A per-table deep dive over a sample cannot be turned
 * into an estate-wide claim by anything downstream, and the asymmetry matters when
 * scoring: a failure in a sample is a real failure, a pass in a sample is not
 * estate-wide compliance.
 *
 * Mode and reach are independent axes and collapsing them would lose information.
 * Mode answers "how much of the population was examined", reach answers "which
 * population". A complete scan of one workspace and a complete scan of eleven are
 * both `complete`, and reporting them identically is how this app came to tell
 * users their account was assessed when a tenth of it was.
 */
export interface Coverage {
  readonly mode: 'complete' | 'sampled';
  /** Which estate the mode is a statement about. Absent means the collector did not say. */
  readonly reach?: Reach;
  /** For a sample: what was examined, and out of how many. Both shown to the user. */
  readonly examined?: number;
  readonly population?: number;
  /** How the sample was chosen, in words the user reads verbatim. */
  readonly basis?: string;
}

export const COMPLETE: Coverage = { mode: 'complete' };

/** The narrower of two reaches, treating an unstated one as narrowing nothing. */
export function narrowerReach(a: Reach | undefined, b: Reach | undefined): Reach | undefined {
  if (a == null) return b;
  if (b == null) return a;
  return REACH_ORDER.indexOf(a) < REACH_ORDER.indexOf(b) ? a : b;
}

/** What to tell the user this result is a statement about. */
export function describeReach(reach: Reach | undefined, workspaces?: number): string {
  if (reach === 'account') {
    return workspaces != null && workspaces > 0
      ? `every workspace the scanning identity can see in the system tables, ${String(workspaces)} of them in this scan`
      : 'every workspace the scanning identity can see in the system tables';
  }
  if (reach === 'metastore') {
    return (
      'the Unity Catalog metastore attached to this workspace. An account with metastores in ' +
      'more than one region needs this app installed once per region to cover them all'
    );
  }
  if (reach === 'workspace') {
    return 'this workspace only, because no system table carries the setting and a workspace token is not accepted by other workspaces';
  }
  return 'an unstated part of the estate, which is a gap in this app rather than a finding about yours';
}

export interface SignalResult<T = unknown> {
  readonly id: SignalId;
  readonly status: SignalStatus;
  readonly coverage: Coverage;
  /** Present when observed. Shape is the collector's business and the resolver's. */
  readonly value?: T;
  /**
   * Why this could not be measured, in terms a user can act on: which permission,
   * which unconfigured resource. "Unavailable" on its own generates a support
   * ticket; naming the missing grant does not.
   */
  readonly unmeasurableReason?: string;
  readonly collectedAt: Date;
  /** Wall-clock cost of collecting it, for the scan footprint. */
  readonly durationMs: number;
  /**
   * Which surface produced it, under whose authority, and from where.
   *
   * Stamped by the scan for every collector, so it is optional here only for the moment between a
   * collector returning a result and the scan recording it — and for the collector that sets its own
   * because it read under a different authority than the scan is running as. See collect/provenance.
   */
  readonly provenance?: Provenance;
}

export interface CollectorContext {
  readonly credentials: CredentialProvider;
  readonly scheduler: CollectionScheduler;
  /** Signals already collected in this scan, for collectors that build on others. */
  readonly collected: ReadonlyMap<SignalId, SignalResult>;
  /**
   * Report one signal as finished, before the rest of this collector's are.
   *
   * How a collector makes its progress resumable at its own grain rather than at the grain of its
   * `collect` call. Calling this is what lets an interrupted run keep the signal, so a collector that
   * reads nineteen statements one after another loses the statement in flight rather than all
   * nineteen.
   *
   * Optional to call and optional to provide: a collector that ignores it behaves exactly as it did,
   * and a scan with nowhere to record progress supplies nothing. So this is an offer of finer
   * resumption, never a requirement — the readings a collector returns are still the readings the scan
   * uses, and this is only about when they become durable.
   *
   * Call it once per signal, with the reading as `collect` would return it. Awaiting it is what makes
   * it worth anything: a reading reported and not yet written is a reading a kill still loses.
   *
   * Reporting a signal does not excuse returning it. `collect` returns everything it read, as before,
   * so a collector cannot make a reading disappear from the scan by reporting it and then omitting it.
   * What reporting does settle is the reading: the scan takes the reported one and ignores a later,
   * differing copy of the same signal in the returned array, because the reported one may already be
   * on the record and two versions of one signal is not a state worth having. Report a reading once,
   * when it is final.
   *
   * Reporting is half of finer resumption and the cheaper half. It makes a reading durable; what saves
   * the work is skipping the signals already in `collected`, which is where an earlier attempt's
   * readings arrive. A collector that reports and does not skip has made its progress resumable and
   * then re-read all of it, which is the cost of the mechanism without the benefit — so a collector
   * taking this up should do both. The scan does not impose the skip, because a collector is entitled
   * to need its whole signal set to answer for any of it, and handing one a subset it did not expect
   * would trade a performance question for a correctness one.
   */
  readonly settled?: (reading: SignalResult) => Promise<void>;
}

/**
 * A collector owns a set of signals on one surface.
 *
 * It receives the scheduler rather than calling out directly, which is the only
 * reason the per-surface limits can be enforced. A collector that reached for the
 * SDK itself would be invisible to every budget in the app.
 */
export interface Collector {
  readonly surface: Surface;
  readonly name: string;
  /** Every signal this collector can produce. Checked against the catalogue in CI. */
  readonly signals: readonly SignalId[];
  /**
   * Signals this collector reads as input, produced by a collector that runs before it.
   *
   * Declared rather than assumed, because the scan collects only what something asks
   * for. A collector whose input no resolver happens to need would otherwise find that
   * input absent — which is precisely what happened to the per-table pass: it depends on
   * a table sample that no control reads directly, so the sample was filtered out of the
   * scan and the pass had nothing to describe.
   */
  readonly requires?: readonly SignalId[];
  collect(ids: readonly SignalId[], context: CollectorContext): Promise<SignalResult[]>;
  /**
   * What this collector consumed, for the scan's own footprint.
   *
   * Optional because the scheduler already counts tasks per surface, and that is
   * enough for a collector whose calls are all alike. It is implemented where the
   * collector knows something the scheduler cannot: how much data a warehouse
   * actually scanned, and which statement ids the customer can look the work up by.
   */
  spent?: () => CollectorSpend;
}

/**
 * A collector's own consumption, in the units the surface reports.
 *
 * This exists because a tool that assesses someone's cost discipline should be able
 * to answer what it cost to run. Every field is measured rather than estimated — the
 * byte and row counts come from the result manifest the warehouse returns, so they
 * are exact and available immediately, unlike DBUs, which land in the billing tables
 * up to a day later and are resolved separately.
 */
export interface CollectorSpend {
  readonly surface: Surface;
  readonly name: string;
  readonly calls: number;
  readonly bytesRead?: number;
  readonly rowsReturned?: number;
  /**
   * Identifiers for the work this scan caused, so the customer can find it in their
   * own `system.query.history` rather than taking our word for the footprint.
   */
  readonly statementIds?: readonly string[];
}

export function unmeasurable(id: SignalId, reason: string, coverage: Coverage = COMPLETE): SignalResult {
  return { id, status: 'unmeasurable', coverage, unmeasurableReason: reason, collectedAt: new Date(), durationMs: 0 };
}

export function observed<T>(
  id: SignalId,
  value: T,
  durationMs: number,
  coverage: Coverage = COMPLETE
): SignalResult<T> {
  return { id, status: 'observed', coverage, value, collectedAt: new Date(), durationMs };
}
