// A concurrency limiter that reduces itself when the far end complains.
//
// A fixed limit is a guess about someone else's capacity, made without knowing
// what else is running there. This one starts at the configured ceiling and halves
// on every throttling signal, so the correct value is discovered from the target's
// own behaviour rather than assumed. Recovery is deliberately slower than the
// reduction: halve immediately, climb back one step at a time, because the cost of
// being briefly too slow is a longer scan and the cost of being too fast is
// someone else's incident.

export interface AdaptiveLimiterOptions {
  /** Starting and maximum concurrency. */
  readonly ceiling: number;
  /**
   * Consecutive successes required before reclaiming one slot. Higher means
   * slower recovery. The default is deliberately more than a handful, so that a
   * limiter which halved does not immediately climb back on the strength of two
   * lucky calls.
   */
  readonly recoveryAfter?: number;
  readonly now?: () => number;
}

export interface LimiterState {
  readonly limit: number;
  readonly ceiling: number;
  readonly inFlight: number;
  readonly queued: number;
  readonly pausedForMs: number;
  /** How many times this limiter has reduced itself. Reported with the scan. */
  readonly reductions: number;
}

export class AdaptiveLimiter {
  private readonly ceiling: number;
  private readonly recoveryAfter: number;
  private readonly now: () => number;

  private limit: number;
  private inFlight = 0;
  private consecutiveSuccesses = 0;
  private reductions = 0;
  private pausedUntil = 0;
  private drainTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly waiters: Array<{ resolve: () => void; reject: (e: Error) => void }> = [];

  constructor(options: AdaptiveLimiterOptions) {
    this.ceiling = Math.max(1, options.ceiling);
    this.limit = this.ceiling;
    this.recoveryAfter = options.recoveryAfter ?? 5;
    this.now = options.now ?? Date.now;
  }

  /**
   * Wait for a slot. Resolves with the function that returns it.
   *
   * Release is returned rather than exposed as a method so that a caller cannot
   * release a slot it never acquired, which would silently raise the effective
   * concurrency above the limit and be very hard to see from the outside.
   */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    if (signal?.aborted) throw abortError();

    let onAbort: (() => void) | undefined;

    try {
      await new Promise<void>((resolve, reject) => {
        const waiter: { resolve: () => void; reject: (e: Error) => void } = { resolve, reject };

        if (signal != null) {
          onAbort = () => {
            const at = this.waiters.indexOf(waiter);
            if (at >= 0) this.waiters.splice(at, 1);
            reject(abortError());
          };
          signal.addEventListener('abort', onAbort, { once: true });
        }

        this.waiters.push(waiter);
        this.drain();
      });
    } finally {
      // Removed on both paths, and only this task's own listener. A long scan
      // acquires thousands of slots against one signal, so leaving them attached
      // accumulates thousands of listeners and Node warns about a leak; removing
      // the wrong one silently makes another task uncancellable.
      if (onAbort != null && signal != null) signal.removeEventListener('abort', onAbort);
    }

    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.inFlight -= 1;
      this.drain();
    };
  }

  /** Report success. Contributes towards reclaiming a slot. */
  onSuccess(): void {
    this.consecutiveSuccesses += 1;
    if (this.limit < this.ceiling && this.consecutiveSuccesses >= this.recoveryAfter) {
      this.limit += 1;
      this.consecutiveSuccesses = 0;
      this.drain();
    }
  }

  /**
   * Report that the far end throttled us, or timed out in a way that suggests it is
   * saturated. Halves concurrency and, when the server said how long to wait,
   * stops admitting anything at all for that long.
   */
  onThrottled(retryAfterMs?: number): void {
    this.limit = Math.max(1, Math.floor(this.limit / 2));
    this.consecutiveSuccesses = 0;
    this.reductions += 1;

    if (retryAfterMs != null && retryAfterMs > 0) {
      this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
    }
    this.drain();
  }

  /**
   * Report a failure that says nothing about capacity — a permission denial, a
   * missing object. Resets the recovery streak without reducing the limit, since
   * such a failure is neither evidence of pressure nor evidence of headroom.
   */
  onNeutralFailure(): void {
    this.consecutiveSuccesses = 0;
  }

  state(): LimiterState {
    return {
      limit: this.limit,
      ceiling: this.ceiling,
      inFlight: this.inFlight,
      queued: this.waiters.length,
      pausedForMs: Math.max(0, this.pausedUntil - this.now()),
      reductions: this.reductions,
    };
  }

  private drain(): void {
    const pausedFor = this.pausedUntil - this.now();
    if (pausedFor > 0) {
      // One timer, not one per waiter: a paused limiter with two hundred queued
      // tasks should not hold two hundred timers.
      if (this.drainTimer == null && this.waiters.length > 0) {
        this.drainTimer = setTimeout(() => {
          this.drainTimer = undefined;
          this.drain();
        }, pausedFor);
        // Deliberately not unref'd. A scan waiting out a Retry-After is doing
        // useful work, and letting the process exit underneath it would turn a
        // deliberate pause into a lost scan.
      }
      return;
    }

    while (this.inFlight < this.limit && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (waiter == null) break;
      this.inFlight += 1;
      waiter.resolve();
    }
  }
}

function abortError(): Error {
  const error = new Error('Scan cancelled while waiting for a concurrency slot');
  error.name = 'AbortError';
  return error;
}
