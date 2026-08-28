// The single gate every outbound call passes through.
//
// This exists before any collector, on purpose. If collectors call the SDK
// directly and throttling is added later, the limits end up spread across four
// collectors that each need to be correct independently, and the one that is wrong
// is the one nobody tests against a busy workspace. One gate means the load
// discipline is a property of the app rather than a habit of its authors.
//
// It deliberately does not know what a control is, what a signal is, or what the
// Well-Architected Framework says. It knows about surfaces, budgets and failures.

import { Budget, type BudgetSpend, type ExhaustionReason } from './budget.js';
import { classify, isDegradation, RETRYABLE, type ClassifiedFailure, type FailureKind } from './errors.js';
import { AdaptiveLimiter, type LimiterState } from './limiter.js';
import {
  DEFAULT_WALL_CLOCK_MS,
  defaultLimits,
  SURFACES,
  type Surface,
  type SurfaceLimits,
  type WarehouseMode,
} from './surfaces.js';

export interface Task<T> {
  readonly surface: Surface;
  /**
   * Subdivision of a partitioned surface — the cloud service name, for `cloud`.
   * Ignored for surfaces that are not partitioned.
   */
  readonly partition?: string;
  /** Budget units this task consumes. Defaults to one. */
  readonly units?: number;
  /** Identifies the task in the footprint and in logs. Not user-facing. */
  readonly label: string;
  readonly run: (signal: AbortSignal) => Promise<T>;
  /**
   * A last check before the first attempt, returning why this task should not run after all.
   *
   * Evaluated after the limiter admits the task rather than before `run` is called, which is the whole
   * point: a caller that knew at queue time would not have submitted the task. What changes between the
   * two is what the tasks ahead in the queue found — `plans` uses it for a circuit breaker, so a shape
   * queued behind a run of failures is never asked about.
   *
   * Before the first attempt only, not before each. A task already past this check keeps its retries, so
   * a shape recorded as not run is one that made no request at all.
   */
  readonly skipWhen?: () => string | undefined;
}

export type TaskOutcome<T> =
  | { readonly status: 'ok'; readonly value: T; readonly attempts: number }
  /**
   * The task could not run and the scan should carry on without it. Covers a
   * refused budget, a cancellation, and a permission denial — three different
   * causes with the same correct response, which is to record why this piece of
   * evidence is missing and continue.
   */
  | { readonly status: 'skipped'; readonly reason: SkipReason; readonly detail: string }
  /** The task ran and failed in a way that is not a degradation. */
  | { readonly status: 'failed'; readonly failure: ClassifiedFailure; readonly attempts: number };

export type SkipReason = 'budget-exhausted' | 'cancelled' | 'permission-denied' | 'not-found' | 'precondition';

export interface SchedulerOptions {
  readonly warehouse?: WarehouseMode;
  readonly limits?: Partial<Record<Surface, Partial<SurfaceLimits>>>;
  readonly budgets?: Partial<Record<Surface, number>>;
  readonly wallClockMs?: number;
  /** Attempts per task, for surfaces the scheduler retries itself. */
  readonly maxAttempts?: number;
  readonly baseBackoffMs?: number;
  readonly now?: () => number;
  /** Injected in tests so backoff does not make the suite slow. */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random?: () => number;
}

/**
 * What one surface did, counted in tasks except where it says otherwise.
 *
 * `attempts` counts calls made rather than tasks, so `attempts - (ok + failed)` is the
 * work a retry paid for. `terminal` names the kind each failed task ended on, which is
 * the difference between a surface that was throttled and one that was refused — the
 * same `failed` count, and nothing an operator should do about them is the same.
 */
export interface SurfaceCounters {
  ok: number;
  skipped: number;
  failed: number;
  retries: number;
  attempts: number;
  terminal: Partial<Record<FailureKind, number>>;
}

export interface ScanFootprint {
  readonly spend: BudgetSpend;
  readonly tasks: Record<Surface, SurfaceCounters>;
  readonly limiters: Record<string, LimiterState>;
  readonly exhaustion: ExhaustionReason | undefined;
  readonly cancelled: boolean;
}

export class CollectionScheduler {
  private readonly surfaceLimits: Record<Surface, SurfaceLimits>;
  private readonly limiters = new Map<string, AdaptiveLimiter>();
  private readonly budget: Budget;
  private readonly controller = new AbortController();
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly counters: Record<Surface, SurfaceCounters>;

  constructor(options: SchedulerOptions = {}) {
    const base = defaultLimits(options.warehouse ?? 'shared');

    this.surfaceLimits = Object.fromEntries(
      SURFACES.map((surface) => [surface, { ...base[surface], ...(options.limits?.[surface] ?? {}) }])
    ) as Record<Surface, SurfaceLimits>;

    const budgetLimits = Object.fromEntries(
      SURFACES.map((surface) => [surface, options.budgets?.[surface] ?? this.surfaceLimits[surface].budget])
    ) as Record<Surface, number>;

    this.budget = new Budget({
      limits: budgetLimits,
      wallClockMs: options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS,
      ...(options.now != null ? { now: options.now } : {}),
    });

    this.maxAttempts = options.maxAttempts ?? 4;
    this.baseBackoffMs = options.baseBackoffMs ?? 500;
    this.sleep = options.sleep ?? defaultSleep;
    this.random = options.random ?? Math.random;

    this.counters = Object.fromEntries(
      SURFACES.map((s) => [s, { ok: 0, skipped: 0, failed: 0, retries: 0, attempts: 0, terminal: {} }])
    ) as Record<Surface, SurfaceCounters>;
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  /**
   * Stop admitting work and interrupt what is in flight.
   *
   * Cooperative rather than forceful: tasks are handed the signal and are expected
   * to abandon themselves. A task that ignores it runs to completion, which is the
   * right trade — killing a statement mid-flight on someone's warehouse to save a
   * few seconds is not an improvement.
   */
  cancel(): void {
    this.controller.abort();
  }

  get cancelled(): boolean {
    return this.controller.signal.aborted;
  }

  /**
   * Whether the scan has hit a wall and should stop queueing work. Collectors check
   * this between units so that a paused scan stops promptly rather than grinding
   * through hundreds of refusals.
   */
  get exhausted(): boolean {
    return this.budget.exhaustion() != null;
  }

  /**
   * Run a task under this surface's limits, returning an outcome rather than
   * throwing.
   *
   * Not throwing is the point. A scan makes hundreds of independent calls of which
   * some are expected to be refused — under on-behalf-of-user execution a
   * permission denial is the normal case, not an exception — and any caller that
   * had to try/catch each one would end up flattening those cases together.
   */
  async run<T>(task: Task<T>): Promise<TaskOutcome<T>> {
    const units = task.units ?? 1;
    const limits = this.surfaceLimits[task.surface];

    if (this.controller.signal.aborted) {
      this.counters[task.surface].skipped += 1;
      return { status: 'skipped', reason: 'cancelled', detail: `${task.label} was not started: scan cancelled` };
    }

    if (!this.budget.tryTake(task.surface, units)) {
      this.counters[task.surface].skipped += 1;
      const reason = this.budget.exhaustion();
      return {
        status: 'skipped',
        reason: 'budget-exhausted',
        detail: describeExhaustion(task.label, reason),
      };
    }

    const limiter = this.limiterFor(task.surface, task.partition);
    let release: (() => void) | undefined;

    try {
      release = await limiter.acquire(this.controller.signal);
    } catch {
      // Cancelled while queued. The budget was reserved and never used.
      this.budget.refund(task.surface, units);
      this.counters[task.surface].skipped += 1;
      return { status: 'skipped', reason: 'cancelled', detail: `${task.label} was cancelled while queued` };
    }

    try {
      return await this.attempt(task, limits, limiter);
    } finally {
      release();
    }
  }

  footprint(): ScanFootprint {
    return {
      spend: this.budget.spend(),
      tasks: copyCounters(this.counters),
      limiters: Object.fromEntries([...this.limiters].map(([key, l]) => [key, l.state()])),
      exhaustion: this.budget.exhaustion(),
      cancelled: this.controller.signal.aborted,
    };
  }

  private async attempt<T>(task: Task<T>, limits: SurfaceLimits, limiter: AdaptiveLimiter): Promise<TaskOutcome<T>> {
    // A surface whose client retries gets exactly one attempt here. The retrying
    // has already happened underneath; doing it again multiplies the request count
    // the operator thinks they capped.
    const attemptsAllowed = limits.clientRetries ? 1 : this.maxAttempts;

    // Counted as skipped rather than ok, because `callsMade` is served to a reader as calls that reached a
    // surface and this task is about to reach nothing.
    const precondition = task.skipWhen?.();
    if (precondition != null) {
      this.counters[task.surface].skipped += 1;
      return { status: 'skipped', reason: 'precondition', detail: precondition };
    }

    let lastFailure: ClassifiedFailure | undefined;
    let made = 0;

    for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
      if (this.controller.signal.aborted) {
        this.counters[task.surface].skipped += 1;
        return { status: 'skipped', reason: 'cancelled', detail: `${task.label} was cancelled` };
      }

      made = attempt;
      this.counters[task.surface].attempts += 1;

      try {
        const value = await task.run(this.controller.signal);
        limiter.onSuccess();
        this.counters[task.surface].ok += 1;
        return { status: 'ok', value, attempts: attempt };
      } catch (error) {
        if (this.controller.signal.aborted) {
          this.counters[task.surface].skipped += 1;
          return { status: 'skipped', reason: 'cancelled', detail: `${task.label} was cancelled` };
        }

        const failure = classify(error);
        lastFailure = failure;

        // Concurrency is adjusted even when the scheduler is not the one retrying,
        // because the throttling signal is about the target's capacity and remains
        // true regardless of who handles the retry.
        // `deadline` is deliberately not in this pair, though it reads like a timeout: it is this
        // app deciding to stop waiting, so it says nothing about the warehouse's capacity, and
        // halving concurrency on it would punish the estate for holding a large catalogue.
        if (failure.kind === 'rate-limited' || failure.kind === 'timeout') {
          limiter.onThrottled(failure.retryAfterMs);
        } else {
          limiter.onNeutralFailure();
        }

        if (isDegradation(failure.kind)) {
          this.counters[task.surface].skipped += 1;
          return {
            status: 'skipped',
            reason: failure.kind === 'permission-denied' ? 'permission-denied' : 'not-found',
            detail: failure.message,
          };
        }

        const worthRetrying =
          RETRYABLE.includes(failure.kind) && attempt < attemptsAllowed && !asksForLongerThanAScanWaits(failure);
        if (!worthRetrying) break;

        this.counters[task.surface].retries += 1;
        await this.backoff(attempt, failure);
      }
    }

    const terminal = lastFailure ?? { kind: 'fatal' as const, message: `${task.label} failed without an error` };
    this.counters[task.surface].failed += 1;
    this.counters[task.surface].terminal[terminal.kind] = (this.counters[task.surface].terminal[terminal.kind] ?? 0) + 1;

    return {
      status: 'failed',
      failure: terminal,
      // Attempts made, not attempts allowed. Reported as the latter until ADR 0093, which
      // said four on every `sql` failure while the surface was making one — and the whole
      // reason this number is on the record is to tell a signal refused once from one
      // refused repeatedly.
      attempts: made,
    };
  }

  /**
   * Exponential with full jitter, and the server's own figure wins outright where it
   * arrives — capped by the refusal to wait at all, above, rather than by shortening it.
   *
   * Jitter is not a refinement here. Narratives are generated one per pillar and
   * fired together, so without it seven tasks throttled at the same moment retry
   * at the same moment, and the endpoint sees the same burst that throttled it.
   */
  private async backoff(attempt: number, failure: ClassifiedFailure): Promise<void> {
    const exponential = this.baseBackoffMs * 2 ** (attempt - 1);
    const jittered = Math.floor(exponential * this.random());
    const delay = failure.retryAfterMs ?? jittered;
    await this.sleep(delay, this.controller.signal);
  }

  private limiterFor(surface: Surface, partition: string | undefined): AdaptiveLimiter {
    const limits = this.surfaceLimits[surface];
    const key = limits.partitioned && partition != null ? `${limits.limiterGroup}:${partition}` : limits.limiterGroup;

    let limiter = this.limiters.get(key);
    if (limiter == null) {
      limiter = new AdaptiveLimiter({ ceiling: limits.concurrency });
      this.limiters.set(key, limiter);
    }
    return limiter;
  }
}

/**
 * The longest `Retry-After` a scan will sit out before giving the signal up.
 *
 * A judgement, not a reading, and `36t` is the reason it has to be: it fired 1,110
 * requests at labs and the platform sent no `Retry-After` on any of them, so there is no
 * measured interval to fit this to. What decides it is the shape of the choice rather
 * than a number. Waiting is bounded by the operator's patience — a scan has a 45 minute
 * wall clock, and three sleeps of ten minutes on one task spends a quarter of it on one
 * signal — while retrying sooner than the server asked is the amplification the surface
 * flags exist to prevent.
 *
 * So past this the scan neither waits nor disobeys: it records the refusal and moves on,
 * which costs one unmeasurable control and is the outcome the app is built to report.
 */
const LONGEST_WAIT_MS = 60_000;

function asksForLongerThanAScanWaits(failure: ClassifiedFailure): boolean {
  return failure.retryAfterMs != null && failure.retryAfterMs > LONGEST_WAIT_MS;
}

function describeExhaustion(label: string, reason: ExhaustionReason | undefined): string {
  if (reason == null) return `${label} was not run: the scan budget is exhausted`;
  if (reason.kind === 'wall-clock') {
    return `${label} was not run: the scan reached its ${Math.round(reason.limitMs / 60000)} minute time limit`;
  }
  return `${label} was not run: the scan reached its limit of ${reason.limit} ${reason.surface} operations`;
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}

/** A snapshot, so a caller holding a footprint does not watch it move as the scan continues. */
function copyCounters(value: Record<Surface, SurfaceCounters>): Record<Surface, SurfaceCounters> {
  return Object.fromEntries(
    Object.entries(value).map(([surface, counters]) => [surface, { ...counters, terminal: { ...counters.terminal } }])
  ) as Record<Surface, SurfaceCounters>;
}
