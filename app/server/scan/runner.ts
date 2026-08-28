// One scan at a time, per workspace.
//
// The lock is not an optimisation. Under on-behalf-of, several account admins can open
// the app at once, and two of them pressing scan produces two full passes over the same
// system tables against the same warehouse, for two identical answers. The second
// caller is shown the running scan instead — which is what they wanted, since they
// wanted the answer rather than the act of scanning.
//
// It also means the warehouse sees at most one scan's worth of load from this app,
// which is the only way the per-surface budgets in the scheduler bound anything real.

import type { Catalogue } from '../catalogue/catalogue.js';
import type { Collector, SignalId, SignalResult } from '../collect/signal.js';
import type { CredentialProvider } from '../collect/credentials.js';
import type { EstateScope } from '../collect/estate-scope.js';
import type { RunDefinition } from './identity.js';
import type { ResolverRegistry } from '../resolve/resolver.js';
import type { Attestation } from '../attest/attestation.js';
import { effective, type AttestationStore } from '../attest/store.js';
import { newestFirst, type ApplicabilityDecision } from '../apply/applicability.js';
import type { ApplicabilityStore } from '../apply/store.js';
import { CollectionScheduler } from './scheduler.js';
import { carryForward } from './carry-forward.js';
import { aliasLookup, runScan, type Scan, type ScanTrigger } from './scan.js';
import type { ScanStore } from './store.js';
import type { EvidenceImportStore } from '../import/store.js';
import { readingsFrom } from '../import/signals.js';
import type { AssessmentScope } from '../store/assessment-scope.js';

export interface RunningScan {
  readonly startedAt: Date;
  readonly actor: string;
  readonly scope: EstateScope;
  /**
   * What started it, so a reader who did not can tell the nightly run from a colleague's.
   *
   * Optional for the same reason it is optional on the request: omitted means a person did.
   */
  readonly trigger?: ScanTrigger;
  /**
   * Calls that have reached a surface so far, across the system tables and the APIs.
   *
   * A count and not a fraction. How many calls a run will make is not known when it starts — a
   * permission refusal skips work, the budget can stop it early, and a targeted rerun measures a
   * subset — so a percentage here would be invented. See ADR 0055.
   *
   * Work the scheduler skipped is not counted: it was never issued, and counting it would show a
   * run that is being refused everywhere as one making brisk progress.
   */
  readonly callsMade: number;
}

export class ScanInProgressError extends Error {
  constructor(readonly running: RunningScan) {
    super(
      `A scan started by ${running.actor} at ${running.startedAt.toISOString()} is already running. ` +
        'Only one scan runs at a time so two admins cannot double the load on the warehouse for the ' +
        'same answer. Wait for it to finish; its results will be the latest scan.'
    );
    this.name = 'ScanInProgressError';
  }
}

/**
 * The window a request that names none gets.
 *
 * Exported because the run record has to hold the number a run *used* rather than the absence of one:
 * two triggers of a single intention, one of which resolved the default and one of which did not,
 * would compare as asking different things and the second would be refused. See `requestOf`.
 */
export const DEFAULT_LOOKBACK_DAYS = 30;

export interface ScanRequest {
  readonly credentials: CredentialProvider;
  readonly scope: EstateScope;
  readonly collectors: readonly Collector[];
  readonly lookbackDays?: number;
  /** The warehouse the SQL surfaces will run on, recorded on each reading it produces. */
  readonly warehouse?: string;
  /**
   * The pillars the caller asked to measure, when they asked for a subset.
   *
   * A subset is a rerun, not a narrower scan: the pillars left out are carried forward from
   * the previous scan where the two are comparable, so a targeted run never replaces the
   * assessment with a fraction of one. See carry-forward.ts.
   *
   * Deliberately not the same field as `measuredPillars` below, which is what this build
   * assesses. Conflating them made every ordinary scan record itself as a targeted rerun of
   * whatever the build happened to measure, and sent every ordinary scan through the
   * carry-forward path — a merge with nothing to merge, and a run record that lied.
   */
  readonly pillars?: readonly string[];
  /** What started this run. Omitted means a person did. */
  readonly trigger?: ScanTrigger;
  /**
   * The assessment this run answers to, already resolved to the version it names.
   *
   * Resolved by the caller rather than here, because the route is where a definition id becomes a
   * scope, a window and a pillar set — and having the runner read the definition store too would
   * mean two places deciding what "the current version" is.
   */
  readonly definition?: RunDefinition;
  /**
   * Readings an earlier attempt at this run already reached.
   *
   * Passed straight through to `runScan`, which seeds them and skips the collectors that produced
   * them. Here rather than resolved by the runner because which readings belong to a run is the run
   * store's business, and the runner is used by builds with no run store at all.
   */
  readonly resume?: ReadonlyMap<SignalId, SignalResult>;
  /** Called after each collection unit with what it read. See `RunScanOptions.checkpoint`. */
  readonly checkpoint?: (readings: readonly SignalResult[]) => Promise<void>;
  /** Asked between collection units whether a stop has been recorded. See `RunScanOptions.stopping`. */
  readonly stopping?: () => Promise<boolean>;
}

export interface ScanRunnerOptions {
  readonly catalogue: Catalogue;
  readonly registry: ResolverRegistry;
  readonly store: ScanStore;
  /**
   * Where the answers to the requirements no telemetry can reach are kept.
   *
   * Optional so a build or a test with no attestation store still scans; those requirements
   * simply stay unmeasured, which is what they were before this existed.
   */
  readonly attestations?: AttestationStore;
  /**
   * Where imported administrator readings are held, if anywhere.
   *
   * Optional because a build with no import surface is a valid build, and because every scan test
   * would otherwise have to supply a store to measure something that has nothing to do with imports.
   */
  readonly imports?: EvidenceImportStore;
  /**
   * Where the customer's applicability decisions are kept, if anywhere.
   *
   * Optional because an install with no durable store keeps no decisions — it has no exclusion path at
   * all (the routes refuse a write rather than lose a score-moving record), so a scan there applies
   * nothing, which is the honest behaviour for one that cannot record a decision either. Read once at the
   * start of a run for the reason the attestations and imports are, so every finding reflects the same
   * set of decisions.
   */
  readonly applicability?: ApplicabilityStore;
  /** Overrides {@link DEFAULT_LOOKBACK_DAYS} for a request that names no window of its own. */
  readonly defaultLookbackDays?: number;
  /**
   * The pillars this build assesses. Omitted means the whole catalogue.
   *
   * A property of the build, so it belongs to the runner rather than arriving on each
   * request: no caller may widen it, and it is not something a run was "asked" for.
   */
  readonly measuredPillars?: readonly string[];
  /**
   * Scopes `app.yaml` requests, for telling a stale consent from a permanent refusal.
   *
   * On the runner rather than the request because it is a property of the deployment: no caller
   * may claim the app asks for something it does not. Omitted means every scope refusal reports
   * as permanent, which understates what the app could read and never sends anybody to
   * re-authorise for a scope that would not help.
   */
  readonly declaredScopes?: readonly string[];
  /**
   * What to do with the finished run besides store it.
   *
   * One hook rather than a registry, and it exists for one caller: the validation pass that answers the
   * claims somebody asked this run to check. It is here rather than in the route that starts a scan
   * because a scheduled run has to answer them too, and a scan is started from three places.
   *
   * It is awaited, so a caller who waits for `start` knows the validations were settled, and it may not
   * fail the scan: the findings are real and worth keeping whatever happened to the validations. See
   * `settled` below.
   */
  readonly onFinished?: (scan: Scan) => Promise<void>;
}

/** What a run reports about itself that does not change once it has started. */
type StartedScan = Omit<RunningScan, 'callsMade'>;

/**
 * The claim, whose actor is mutable.
 *
 * The one concession to taking the claim before the identity is known — see `start`. Nothing reads it
 * except the refusal a second caller gets, and the alternative is the race that refusal exists to close.
 */
type Started = StartedScan & { actor: string };

export class ScanRunner {
  private inFlight: { readonly started: Started; readonly promise: Promise<Scan> } | undefined;
  private scheduler: CollectionScheduler | undefined;

  constructor(private readonly options: ScanRunnerOptions) {}

  /**
   * The run in flight, if there is one, with its progress as at this call.
   *
   * Composed rather than stored, because the count rises while the run goes: a stored one would be
   * the count as at the moment the run started, which is always zero.
   */
  running(): RunningScan | undefined {
    if (this.inFlight == null) return undefined;
    return { ...this.inFlight.started, callsMade: this.callsMade() };
  }

  /**
   * Calls that have reached a surface so far.
   *
   * Skipped work is left out on purpose — see `RunningScan.callsMade`. Retries are counted,
   * because a retry is another call the warehouse or the API actually served.
   */
  private callsMade(): number {
    if (this.scheduler == null) return 0;
    return Object.values(this.scheduler.footprint().tasks).reduce(
      (total, surface) => total + surface.ok + surface.failed + surface.retries,
      0
    );
  }

  /** The in-flight scan's promise, for a caller content to wait rather than be refused. */
  join(): Promise<Scan> | undefined {
    return this.inFlight?.promise;
  }

  /**
   * Starts a scan, or refuses because one is already running.
   *
   * **Nothing is awaited between the check and the claim.** Two admins pressing scan in the same tick
   * both run the synchronous prologue before either suspends, so a claim taken after
   * `await credentials.databricks()` is one both of them pass — and the lock that exists to stop two
   * full passes over the same system tables would allow exactly the case it was written for. Everything
   * that needs awaiting therefore happens inside `pass`, and the actor on the claim is filled in when
   * the credentials arrive: a second caller in that window is told the truth about the timing and
   * "somebody" about the person, which is better than being let through.
   *
   * `async` with nothing awaited before the claim, which is not a contradiction: the body of an async
   * function runs synchronously up to its first `await`, so the claim is taken in the same tick and the
   * refusal still reaches a caller as a rejection rather than as a throw from a method whose signature
   * promises one.
   */
  async start(request: ScanRequest): Promise<Scan> {
    const already = this.running();
    if (already != null) throw new ScanInProgressError(already);

    const scheduler = new CollectionScheduler();
    const started: Started = {
      startedAt: new Date(),
      actor: 'somebody',
      scope: request.scope,
      ...(request.trigger != null && { trigger: request.trigger }),
    };

    const promise = this.pass(request, scheduler, started).finally(() => {
      // Released in `finally` rather than after the save, so a scan that throws does
      // not leave the app permanently refusing to start another.
      this.inFlight = undefined;
      this.scheduler = undefined;
    });

    // The scheduler is set alongside the run rather than after it, because `running()` counts the
    // calls made through it and a reader asking a moment too early should see zero, not nothing.
    this.inFlight = { started, promise };
    this.scheduler = scheduler;
    return promise;
  }

  /** The scan itself, from the first thing that has to be awaited onwards. */
  private async pass(request: ScanRequest, scheduler: CollectionScheduler, started: Started): Promise<Scan> {
    const identity = await request.credentials.databricks();
    started.actor = identity.actor;

    // A targeted request narrows what this build measures; it cannot reach past it. Validated
    // at the route as well, so this is the second of two rather than the only one.
    const evaluate = request.pillars ?? this.options.measuredPillars;

    // Read once, at the start, so every finding in one scan reflects the same set of answers.
    // Reading per control would let an attestation recorded mid-scan apply to some
    // requirements and not others, and the resulting score would not correspond to any state
    // the records were ever in.
    const scope = request.definition?.id ?? null;
    const attestations = await this.answers(scope);
    // Read alongside the answers and for the same reason: one read per run, so a file imported
    // mid-scan does not apply to some requirements and not others.
    const imported = await this.importedReadings();
    // The customer's applicability decisions, read once for the same reason, so a decision recorded
    // mid-scan does not take a requirement out of some pillars and not others.
    const decisions = await this.decisions(scope);

    const fresh = await runScan({
      catalogue: this.options.catalogue,
      registry: this.options.registry,
      collectors: request.collectors,
      credentials: request.credentials,
      scope: request.scope,
      lookbackDays: request.lookbackDays ?? this.options.defaultLookbackDays ?? DEFAULT_LOOKBACK_DAYS,
      scheduler,
      attestations,
      ...(decisions.size > 0 ? { decisions } : {}),
      ...(imported.size > 0 ? { imported } : {}),
      ...(request.warehouse != null ? { warehouse: request.warehouse } : {}),
      ...(request.trigger != null ? { trigger: request.trigger } : {}),
      ...(request.definition != null ? { definition: request.definition } : {}),
      ...(evaluate != null ? { pillars: evaluate } : {}),
      ...(this.options.declaredScopes != null ? { declaredScopes: this.options.declaredScopes } : {}),
      ...(request.resume != null ? { resume: request.resume } : {}),
      ...(request.checkpoint != null ? { checkpoint: request.checkpoint } : {}),
      ...(request.stopping != null ? { stopping: request.stopping } : {}),
    });

    const scan = await this.merge(fresh, request.pillars, decisions, scope);
    // A cancelled scan is saved too. It reached some of its signals, those findings are real, and the
    // scan is labelled partial with the reason — which is more useful than discarding the work.
    await this.options.store.save(scan);
    await this.settled(scan);
    return scan;
  }

  /**
   * Runs the after-the-scan work, and swallows a failure in it.
   *
   * After the save rather than before, so the run is on the record before anything reads it, and
   * swallowed because the two are not the same claim: a scan that measured the estate and could not
   * settle a validation has still measured the estate, and rejecting here would turn that into a scan
   * the caller is told failed and can nonetheless find in the history. The hook's own job is to report
   * what it could not do.
   */
  private async settled(scan: Scan): Promise<void> {
    if (this.options.onFinished == null) return;
    try {
      await this.options.onFinished(scan);
    } catch {
      // Nothing to add: a hook that throws rather than reporting has already lost the detail, and the
      // one caller of this reports its own failures.
    }
  }

  /**
   * The attested answers that still count, by control id.
   *
   * A store that cannot be read yields none rather than failing the scan. An unreachable
   * volume should cost the attested requirements, which then report as unmeasured with a
   * reason — not the other five pillars, which do not depend on it at all.
   */
  private async answers(scope: AssessmentScope): Promise<ReadonlyMap<string, Attestation>> {
    if (this.options.attestations == null) return new Map();
    try {
      return effective(await this.options.attestations.current(scope));
    } catch {
      return new Map();
    }
  }

  /**
   * The readings imported administrators collected, newest collection winning.
   *
   * Read here for the same reasons the answers are: one read at the start of the run, so every
   * finding reflects the same set of imports, and a store that cannot be read yields none rather
   * than failing the scan — an unreachable table should cost the imported requirements, which then
   * report as unmeasured with a reason, not the pillars that never depended on it.
   *
   * Oldest applied first so that a newer collection of the same signal overwrites an older one. That
   * ordering is this method's business and not `merged`'s, which is deliberately ignorant of dates:
   * it enforces the class rule between observed and imported, and both of these are imported.
   */
  private async importedReadings(): Promise<ReadonlyMap<SignalId, SignalResult>> {
    if (this.options.imports == null) return new Map();
    try {
      const held = await this.options.imports.all();
      const applied = new Map<SignalId, SignalResult>();
      for (const one of [...held].sort((a, b) => a.generatedAt.getTime() - b.generatedAt.getTime())) {
        for (const [id, reading] of readingsFrom(one).signals) applied.set(id, reading);
      }
      return applied;
    } catch {
      return new Map();
    }
  }

  /**
   * The customer's applicability decisions, by control id, newest first.
   *
   * Grouped here so `runScan` and `carryForward` are handed a lookup rather than a store to query per
   * control. A store that cannot be read yields none rather than failing the scan — the same choice the
   * answers and imports make — because an unreadable decisions table should cost the exclusions, which
   * then simply do not apply this run, not the whole assessment.
   */
  private async decisions(scope: AssessmentScope): Promise<ReadonlyMap<string, readonly ApplicabilityDecision[]>> {
    if (this.options.applicability == null) return new Map();
    try {
      const byControl = new Map<string, ApplicabilityDecision[]>();
      for (const decision of await this.options.applicability.all(scope)) {
        const group = byControl.get(decision.controlId) ?? [];
        group.push(decision);
        byControl.set(decision.controlId, group);
      }
      return new Map([...byControl].map(([controlId, group]) => [controlId, newestFirst(group)]));
    } catch {
      return new Map();
    }
  }

  /**
   * A targeted run's result, with the pillars it left alone brought forward.
   *
   * Read here rather than inside `runScan` because the previous scan is the store's
   * business, and a scan that fetched its own predecessor would be a scan that cannot be
   * run against a store at all.
   */
  private async merge(
    fresh: Scan,
    pillars: readonly string[] | undefined,
    decisions: ReadonlyMap<string, readonly ApplicabilityDecision[]>,
    scope: AssessmentScope
  ): Promise<Scan> {
    if (pillars == null) return fresh;

    const previous = await this.options.store.latest(scope);
    return carryForward({
      // Stamped here rather than in `runScan`, which cannot tell a caller's request from the
      // build's own restriction and would record both as a rerun.
      fresh: { ...fresh, requestedPillars: pillars },
      previous,
      measuredPillars: pillars,
      aliasGroupOf: aliasLookup(this.options.catalogue),
      ...(decisions.size > 0 ? { decisions } : {}),
      now: fresh.finishedAt,
    });
  }

  /** Cancels the running scan cooperatively. Its partial results are still saved. */
  cancel(): boolean {
    if (this.scheduler == null) return false;
    this.scheduler.cancel();
    return true;
  }
}
