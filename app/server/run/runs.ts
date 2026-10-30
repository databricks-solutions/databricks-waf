// The thing that makes a run survive the process it started in.
//
// `run.ts` decides, `run-store.ts` records, `ScanRunner` collects. This is the order those three go
// in, and it is separate from all of them because the ordering is the part that is easy to get
// subtly wrong and worth being able to test on its own:
//
//   1. **open** the run, so that a duplicate trigger collides with a row rather than with a promise;
//   2. **claim** it, so that two processes cannot both collect it;
//   3. **resume** from its checkpoints, so the attempt starts from what the last one reached;
//   4. **collect**, checkpointing each unit and reading the cancel flag between them;
//   5. **finish**, which records the outcome, releases the claim and drops the checkpoints.
//
// The in-process lock in `ScanRunner` stays, and is not made redundant by the lease. They stop
// different things: the lock stops one process running two *different* assessments at once, which is
// about load on the warehouse; the lease stops two processes running *one* assessment, which is about
// a run having a single answer. An install with one replica needs both, because the second is what a
// restart mid-run walks into.
//
// Neither of those can see another instance, and an install may be served by several. So `open` also
// admits at most one live run of each kind across all of them — see `PostgresRunStore.open` — and this
// turns that refusal into the in-progress error a caller already knows how to answer, naming the run.
// A trigger this instance can already see is refused before anything is written, so the common case of
// pressing scan twice costs no round trip and leaves no failed run behind.
//
// # Why the heartbeat is a timer and the cancel flag is a poll
//
// Both are "check the database periodically" and they are deliberately different mechanisms. The
// heartbeat has to keep going while a collector is in flight — a single statement against a cold
// warehouse can take longer than a lease — so it cannot be a step between units, and a timer is the
// only shape that runs while something else is awaited. The cancel flag must only be read *between*
// units, because obeying it mid-collector would abandon a unit half-read; so it is a poll at the
// boundary, which `runScan` asks for through `stopping`.

import { randomUUID } from 'node:crypto';

import type { SignalId, SignalResult } from '../collect/signal.js';
import type { Scan, ScanTrigger } from '../scan/scan.js';
import { DEFAULT_LOOKBACK_DAYS, ScanInProgressError, type ScanRequest, type ScanRunner } from '../scan/runner.js';
import type { Advisory } from '../advise/advisory.js';
import { AdvisoryInProgressError, type AdvisoryRunner, type AdvisoryRunRequest } from '../advise/runner.js';
import {
  HEARTBEAT_SECONDS,
  RunAdmissionRefused,
  answered,
  endedAs,
  joinable,
  live,
  refusalMeans,
  resumeFrom,
  unheld,
  type Run,
  type RunKind,
  type RunRequest,
} from './run.js';
import type { RunAttempt } from './run.js';
import type { RunStore } from './run-store.js';
import type { AssessmentScope } from '../store/assessment-scope.js';

/** A trigger that could not join the run its key names, with the reason a caller is owed. */
export class RunNotJoinable extends Error {
  constructor(
    readonly run: Run,
    readonly refusal: NonNullable<ReturnType<typeof joinable>>
  ) {
    super(refusalMeans(refusal, run));
    this.name = 'RunNotJoinable';
  }
}

/**
 * What became of a request to stop a run.
 *
 * Three answers rather than a boolean, because two of them are failures a caller has to tell apart: an
 * id nothing here knows is a fault, and a run that already finished is a request that arrived too late
 * for a reason the caller can read off the run itself.
 */
export type Cancellation = 'stopping' | 'already-ended' | 'no-such-run';

export interface Triggered {
  readonly run: Run;
  /** True when this trigger carried on a run an earlier one left behind. */
  readonly resumed: boolean;
  /** How many readings it started from. Zero on a first attempt. */
  readonly resumedFrom: number;
  readonly scan: Promise<Scan>;
}

/** What `advise` answers, which is `Triggered` with the other kind of output on it. */
export interface Advised {
  readonly run: Run;
  readonly resumed: boolean;
  readonly resumedFrom: number;
  readonly advisory: Promise<Advisory>;
}

export interface RunsOptions {
  readonly store: RunStore;
  readonly runner: ScanRunner;
  /**
   * What executes an advisory run, where this install has the advisor.
   *
   * Optional because a build without it is a build with no Optimisation group, and the coordinator is
   * constructed by tests that only care about assessments. `advise` refuses rather than throws where it
   * is absent, which is the honest answer to asking a build for a run it cannot do.
   */
  readonly advisor?: AdvisoryRunner;
  /**
   * What identifies this process in a lease.
   *
   * A value per process rather than per install: the whole purpose is telling "the holder is me" from
   * "the holder is someone else", and two replicas sharing a name would each renew the other's claim.
   */
  readonly holder?: string;
  /** Overridable so a test does not have to wait fifteen seconds to watch a lease be renewed. */
  readonly heartbeatMs?: number;
  /**
   * The window a request that names none gets, which must be the same number the runner would use.
   *
   * Here rather than defaulted locally because the record has to hold the window the run *used*: a
   * record saying thirty days for a run the runner gave ninety would make two triggers of one
   * intention compare as different requests, and the second would be refused as asking something else.
   */
  readonly defaultLookbackDays?: number;
  readonly now?: () => Date;
}

export class Runs {
  private readonly holder: string;
  private readonly heartbeatMs: number;
  private readonly now: () => Date;
  /**
   * The run this process is collecting, per kind, while it is collecting it.
   *
   * Kept here rather than read back from the store because the question it answers is about this
   * process: the in-progress refusal and the status of a scan this process started need the run's name,
   * and which run *another* instance holds is for `live` to say. Per kind because an assessment and an
   * advisory run may be going at once, and one pointer would have whichever started last hide the other.
   *
   * Set only for an attempt that actually started collecting, and cleared only by that attempt: a
   * trigger that was refused must leave the pointer of the run that is still going as it found it.
   */
  private readonly held: Partial<Record<RunKind, string>> = {};

  constructor(private readonly options: RunsOptions) {
    this.holder = options.holder ?? `${process.pid.toString()}-${randomUUID().slice(0, 8)}`;
    this.heartbeatMs = options.heartbeatMs ?? HEARTBEAT_SECONDS * 1000;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Starts a run, or carries on the one this key already names.
   *
   * Throws `RunNotJoinable` where the key names a run this trigger may not continue, which is four
   * different mistakes with four different answers — see `refusalMeans`. It does not throw for the
   * ordinary duplicate: a retry arriving while the first attempt is dead is the case this is for.
   */
  async trigger(
    request: ScanRequest,
    who: { readonly actor: string; readonly idempotencyKey?: string }
  ): Promise<Triggered> {
    const asked = requestOf(request, this.options.defaultLookbackDays);
    const at = this.now();
    await this.refuseIfBusy('assessment', who.idempotencyKey);
    const { run, created } = await this.options.store
      .open({
        id: randomUUID(),
        kind: 'assessment',
        actor: who.actor,
        trigger: request.trigger ?? 'interactive',
        ...(who.idempotencyKey != null ? { idempotencyKey: who.idempotencyKey } : {}),
        request: asked,
        requestedAt: at,
      })
      .catch((cause: unknown) => {
        throw this.inProgress('assessment', cause);
      });

    if (!created) {
      const refusal = joinable(run, { actor: who.actor, kind: 'assessment', request: asked }, at);
      if (refusal != null) throw new RunNotJoinable(run, refusal);
      // A run being taken back up is claimed before the runner is asked, so a scan already collecting
      // here has to be seen now: claiming first would leave the run an attempt it never made.
      const busy = this.busy('assessment');
      if (busy != null) throw busy;
    }

    const attempt = await this.options.store.claim(run.id, this.holder, at);
    // Only reachable when the row was claimed between the read above and this write, which is exactly
    // the race the conditional update exists to lose safely. Reported as held rather than retried,
    // because the process that won it is about to do the work.
    if (attempt == null) {
      const now = (await this.options.store.get(run.id)) ?? run;
      throw new RunNotJoinable(now, 'held');
    }

    // Read after the claim, not before. Before, another process could have finished the run and
    // dropped its checkpoints in between, and this attempt would resume from readings that no longer
    // belong to anything.
    const reached = resumeFrom(await this.options.store.checkpoints(run.id));

    return {
      run: (await this.options.store.get(run.id)) ?? run,
      resumed: !created || reached.size > 0,
      resumedFrom: reached.size,
      scan: this.collect(
        'assessment',
        attempt,
        reached,
        () => this.options.runner.running() != null,
        (resumption) => this.options.runner.start({ ...request, ...resumption }),
        (scan) => ({ scanId: scan.id })
      ),
    };
  }

  /**
   * Starts an advisory run, or carries on the one this key already names.
   *
   * The same five steps in the same order as `trigger`, and deliberately the same code for four of
   * them: what differs between the two kinds is what gets collected and what the run points at when it
   * ends, and neither of those is a reason for a second copy of the lease, the checkpoints, the
   * idempotency key and the cancel flag. See ADR 0069, which argues this at length because the
   * temptation to fork was strong and the bug it would reintroduce is a specific one.
   */
  async advise(
    request: AdvisoryRunRequest,
    who: { readonly actor: string; readonly trigger?: ScanTrigger; readonly idempotencyKey?: string }
  ): Promise<Advised> {
    const advisor = this.options.advisor;
    if (advisor == null) {
      throw new Error(
        'This build has no workload advisor, so there is nothing to run. An install without it has no ' +
          'Optimisation section either, so reaching here means something called the coordinator directly.'
      );
    }

    const asked = adviceOf(request, this.options.defaultLookbackDays);
    const at = this.now();
    await this.refuseIfBusy('advisory', who.idempotencyKey);
    const { run, created } = await this.options.store
      .open({
        id: randomUUID(),
        kind: 'advisory',
        actor: who.actor,
        trigger: who.trigger ?? 'interactive',
        ...(who.idempotencyKey != null ? { idempotencyKey: who.idempotencyKey } : {}),
        request: asked,
        requestedAt: at,
      })
      .catch((cause: unknown) => {
        throw this.inProgress('advisory', cause);
      });

    if (!created) {
      const refusal = joinable(run, { actor: who.actor, kind: 'advisory', request: asked }, at);
      if (refusal != null) throw new RunNotJoinable(run, refusal);
      const busy = this.busy('advisory');
      if (busy != null) throw busy;
    }

    const attempt = await this.options.store.claim(run.id, this.holder, at);
    if (attempt == null) {
      const now = (await this.options.store.get(run.id)) ?? run;
      throw new RunNotJoinable(now, 'held');
    }

    const reached = resumeFrom(await this.options.store.checkpoints(run.id));

    return {
      run: (await this.options.store.get(run.id)) ?? run,
      resumed: !created || reached.size > 0,
      resumedFrom: reached.size,
      advisory: this.collect(
        'advisory',
        attempt,
        reached,
        () => advisor.running() != null,
        (resumption) => advisor.start({ ...request, ...resumption, runId: run.id }),
        (advisory) => ({ advisoryId: advisory.id })
      ),
    };
  }

  /**
   * Records that somebody asked a run to stop, and then makes sure something stops it.
   *
   * Which is three different situations, and the record alone only settles one of them. Where this
   * process holds the run, the in-process cancel makes it take effect between units rather than at the
   * next trigger. Where another process holds it, the flag is what reaches it, and that process ends
   * the run.
   *
   * Where **nothing** holds it — a run whose attempt was killed, which is the ordinary way a run is
   * left lying about — there is no attempt to obey the flag. An earlier version stopped at the record
   * and left that run `running` for ever unless somebody happened to trigger it again, so cancelling
   * the abandoned run a supervisor could see was the one cancel that did nothing at all. So this
   * concludes it here: take the lease, which nothing else may then take, and end it as cancelled.
   *
   * A run that already said something about the estate is refused rather than flagged, and the check
   * comes before the write. Answering a cancel of last night's finished assessment with "stopped" tells
   * a supervisor its retry was called off when nothing was called off, and writes a cancel date onto a
   * complete run for a reader to make what they can of later. A `failed` run is not refused: nothing
   * about the estate came of it, it can be taken back up, and "do not pick this one up again" is a real
   * thing to ask for.
   */
  async cancel(runId: string): Promise<Cancellation> {
    const run = await this.options.store.get(runId);
    if (run == null) return 'no-such-run';
    const at = this.now();
    if (answered(run.state)) return 'already-ended';

    await this.options.store.cancel(runId, at);
    if (run.lease?.holder === this.holder) {
      // The kind decides which executor to reach into. Cancelling both would be tempting and wrong: the
      // other one may be part-way through a run of its own that nobody asked to stop, and a cancel that
      // takes down an unrelated run is worse than one that misses.
      if (run.kind === 'advisory') this.options.advisor?.cancel();
      else this.options.runner.cancel();
      return 'stopping';
    }
    if (!unheld(run, at)) return 'stopping';

    // Conditional, so a trigger that claimed the run between the read and here keeps it — that attempt
    // will read the flag at its next unit boundary, which is the better of the two outcomes.
    const attempt = await this.options.store.claim(runId, this.holder, at);
    if (attempt == null) return 'stopping';
    await this.options.store.finish(attempt, {
      state: 'cancelled',
      at,
      why: 'Somebody asked for this run to stop while no process was working on it.',
    });
    return 'stopping';
  }

  /** The run of a kind this process is collecting, or undefined when it is collecting none. */
  holding(kind: RunKind = 'assessment'): string | undefined {
    return this.held[kind];
  }

  /** Whether a run is this process's own, either because it is collecting it or has just claimed its lease. */
  owns(run: Pick<Run, 'id' | 'kind' | 'lease'>): boolean {
    return this.held[run.kind] === run.id || run.lease?.holder === this.holder;
  }

  /**
   * The run of a kind that something is working on, wherever it is working.
   *
   * Read from the record, so that every instance answers the same: the status of a scan is a fact about
   * the install, and a page that happened to be served by a different instance from the one that started
   * it should still be told. Newest first, though admission keeps it to one.
   */
  async live(kind: RunKind): Promise<Run | undefined> {
    const at = this.now();
    return (await this.options.store.unfinished()).find((run) => run.kind === kind && live(run, at));
  }

  async get(runId: string, scope?: AssessmentScope): Promise<Run | undefined> {
    return this.options.store.get(runId, scope);
  }

  async recent(limit: number, scope?: AssessmentScope): Promise<readonly Run[]> {
    return this.options.store.recent(limit, scope);
  }

  /**
   * The run a key names, for a caller that has its own key and not the id.
   *
   * Which is the ordinary case for a supervisor whose trigger did not come back: it knows what it asked
   * for, because it chose the key, and it never saw the id the app minted.
   */
  async byKey(key: string): Promise<Run | undefined> {
    return this.options.store.byKey(key);
  }

  /** The runs nothing has finished, anywhere — not only the one this process is collecting. */
  async unfinished(): Promise<readonly Run[]> {
    return this.options.store.unfinished();
  }

  /**
   * The refusal for a run of this kind already collecting in this process, or undefined where none is.
   *
   * Named with the run this process holds, where it holds one: a scan started outside the coordinator
   * has no record, and the refusal then says so by carrying none.
   */
  private busy(kind: RunKind): ScanInProgressError | AdvisoryInProgressError | undefined {
    if (kind === 'advisory') {
      const going = this.options.advisor?.running();
      return going == null ? undefined : new AdvisoryInProgressError(going.startedAt, going.actor, this.held.advisory);
    }
    const going = this.options.runner.running();
    return going == null ? undefined : new ScanInProgressError(going, this.held.assessment);
  }

  /**
   * Turns away a trigger this process can already see will not start, before anything is written.
   *
   * Skipped for a key that already names a run. That is a retry, and what it is owed is the answer
   * `joinable` gives — still being worked on, already finished, somebody else's — rather than a
   * statement that something is running. A key that names nothing is a new intention like any other and
   * is refused here; the read costs one round trip against the write and the failed run it avoids.
   */
  private async refuseIfBusy(kind: RunKind, key: string | undefined): Promise<void> {
    const busy = this.busy(kind);
    if (busy == null) return;
    if (key != null && (await this.options.store.byKey(key)) != null) return;
    throw busy;
  }

  /**
   * The in-progress error for a run another instance is working on, in the form each kind of run
   * already answers with. Anything else the store raised passes through as it was.
   *
   * What another instance has done so far is not known here, so a scan's call count is reported as zero
   * rather than guessed: the count is a progress figure for the process doing the work.
   */
  private inProgress(kind: RunKind, cause: unknown): unknown {
    if (!(cause instanceof RunAdmissionRefused)) return cause;
    const { run } = cause;
    if (kind === 'advisory') return new AdvisoryInProgressError(run.requestedAt, run.actor, run.id);
    return new ScanInProgressError(
      {
        startedAt: run.requestedAt,
        actor: run.actor,
        scope: run.request.scope,
        trigger: run.trigger,
        callsMade: 0,
      },
      run.id
    );
  }

  /**
   * Runs the collection under a claim, and ends the run whatever happens.
   *
   * Every exit writes an ending, including the throw. A run left `running` by a failure is one the
   * lease will eventually free, so nothing is stuck — but for the minute until then the app reports a
   * run in progress that is not, and the reason it failed is nowhere. `failed` with the message is
   * both true and readable.
   */
  private async collect<T extends { readonly id: string; readonly state: 'complete' | 'partial' }>(
    kind: RunKind,
    attempt: RunAttempt,
    reached: ReadonlyMap<SignalId, SignalResult>,
    occupied: () => boolean,
    execute: (resumption: {
      readonly resume?: ReadonlyMap<SignalId, SignalResult>;
      readonly checkpoint: (readings: readonly SignalResult[]) => Promise<void>;
      readonly stopping: () => Promise<boolean>;
    }) => Promise<T>,
    produced: (result: T) => { readonly scanId?: string; readonly advisoryId?: string }
  ): Promise<T> {
    const beating = setInterval(() => {
      // Not awaited, and a failure is ignored on purpose: a renewal that fails because the run was
      // taken is answered by the takeover, and one that fails because the database is briefly away is
      // answered by the next beat. Throwing out of a timer would take the process down mid-scan.
      void this.options.store.renew(attempt, this.now()).catch(() => undefined);
    }, this.heartbeatMs);
    // Node keeps a process alive for a pending timer, which for a fifteen-second beat means a
    // command-line run hanging after its scan is saved.
    beating.unref?.();
    // Whether the executor is free is read here, in the same tick that asks it to start, so that an
    // attempt it is about to refuse does not take the pointer of the one it is refused for.
    const started = !occupied();
    if (started) this.held[kind] = attempt.runId;

    try {
      const result = await execute({
        ...(reached.size > 0 ? { resume: reached } : {}),
        checkpoint: (readings) => this.options.store.checkpoint(attempt.runId, readings, this.now()),
        stopping: () => this.options.store.cancelRequested(attempt.runId),
      });

      const asked = await this.options.store.cancelRequested(attempt.runId);
      // The answer is not read, and the result is returned either way. Where this attempt lost the run
      // while collecting, what it produced is still a reading of the estate and the caller that waited
      // for it should have it; what it is not is this run's outcome, and the store is what refuses to
      // record it as one.
      await this.options.store.finish(attempt, {
        state: endedAs(result, asked),
        at: this.now(),
        ...produced(result),
        ...(asked ? { why: 'Somebody asked for this run to stop, and it saved what it had reached.' } : {}),
      });
      return result;
    } catch (cause) {
      await this.options.store.finish(attempt, {
        state: 'failed',
        at: this.now(),
        why: cause instanceof Error ? cause.message : String(cause),
      });
      throw cause;
    } finally {
      clearInterval(beating);
      // Only where it is still this attempt. A takeover started here while this one was finishing would
      // otherwise be forgotten by the attempt it replaced.
      if (started && this.held[kind] === attempt.runId) delete this.held[kind];
    }
  }
}

/**
 * What an advisory trigger asked for, as the record keeps it.
 *
 * `pillars` is never set, because an advisory run has none — nothing here scores, so there is no subset
 * to narrow to. Its absence is what makes the same key mean the same request across a retry, so it is
 * left off rather than set to an empty list, which would compare as a different ask.
 */
export function adviceOf(request: AdvisoryRunRequest, defaultLookbackDays = DEFAULT_LOOKBACK_DAYS): RunRequest {
  return {
    scope: request.scope,
    lookbackDays: request.lookbackDays ?? defaultLookbackDays,
    ...(request.warehouse != null ? { warehouse: request.warehouse } : {}),
    ...(request.definition != null ? { definition: request.definition } : {}),
  };
}

/** What was asked for, as the record keeps it, with the window resolved to the number the run will use. */
export function requestOf(request: ScanRequest, defaultLookbackDays = DEFAULT_LOOKBACK_DAYS): RunRequest {
  return {
    scope: request.scope,
    lookbackDays: request.lookbackDays ?? defaultLookbackDays,
    ...(request.pillars != null ? { pillars: request.pillars } : {}),
    ...(request.warehouse != null ? { warehouse: request.warehouse } : {}),
    ...(request.definition != null ? { definition: request.definition } : {}),
  };
}
