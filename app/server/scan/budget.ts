// Per-scan spending limits, and the wall clock.
//
// The important property is the one in the name of `tryTake`: a budget that is
// exhausted refuses new work and says so. It does not throw, and it does not
// abandon work already done. A scan that stops early with three quarters of the
// estate assessed is a partial result, and a partial result that is labelled as
// one is useful. An exception at 80% is not.

import { DEFAULT_WALL_CLOCK_MS, SURFACES, type Surface } from './surfaces.js';

export type ExhaustionReason =
  | { readonly kind: 'surface-budget'; readonly surface: Surface; readonly limit: number }
  | { readonly kind: 'wall-clock'; readonly limitMs: number; readonly elapsedMs: number };

export interface BudgetSpend {
  readonly spent: Record<Surface, number>;
  readonly limits: Record<Surface, number>;
  readonly elapsedMs: number;
  readonly wallClockMs: number;
}

export interface BudgetOptions {
  readonly limits: Record<Surface, number>;
  readonly wallClockMs?: number;
  /** Injected in tests. Production passes nothing and gets the real clock. */
  readonly now?: () => number;
}

export class Budget {
  private readonly spentBySurface: Record<Surface, number>;
  private readonly limits: Record<Surface, number>;
  private readonly wallClockMs: number;
  private readonly now: () => number;
  private readonly startedAt: number;
  private firstExhaustion: ExhaustionReason | undefined;

  constructor(options: BudgetOptions) {
    this.limits = { ...options.limits };
    this.wallClockMs = options.wallClockMs ?? DEFAULT_WALL_CLOCK_MS;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
    this.spentBySurface = Object.fromEntries(SURFACES.map((s) => [s, 0])) as Record<Surface, number>;
  }

  /**
   * Reserve `units` against `surface`, returning false if that would exceed either
   * the surface budget or the wall clock.
   *
   * Reserved before the work runs rather than counted after, so that a burst of
   * concurrent tasks cannot collectively overshoot a limit that each of them
   * individually respected.
   */
  tryTake(surface: Surface, units = 1): boolean {
    const elapsedMs = this.elapsedMs();
    if (elapsedMs >= this.wallClockMs) {
      this.recordExhaustion({ kind: 'wall-clock', limitMs: this.wallClockMs, elapsedMs });
      return false;
    }

    const limit = this.limits[surface];
    if (this.spentBySurface[surface] + units > limit) {
      this.recordExhaustion({ kind: 'surface-budget', surface, limit });
      return false;
    }

    this.spentBySurface[surface] += units;
    return true;
  }

  /**
   * Give back units for work that never ran — cancelled before it started, or
   * refused by a limiter. Without this, a cancelled scan would report having spent
   * a budget it did not spend, and the footprint would overstate the load the app
   * put on the workspace. Overstating our own impact is a smaller sin than
   * understating it, but it is still wrong.
   */
  refund(surface: Surface, units = 1): void {
    this.spentBySurface[surface] = Math.max(0, this.spentBySurface[surface] - units);
  }

  /** The reason the scan first hit a wall, for reporting on a partial result. */
  exhaustion(): ExhaustionReason | undefined {
    // Re-checked rather than only reported, so that a scan which sat idle past the
    // deadline without submitting anything still knows why it should stop.
    if (this.firstExhaustion == null) {
      const elapsedMs = this.elapsedMs();
      if (elapsedMs >= this.wallClockMs) {
        this.recordExhaustion({ kind: 'wall-clock', limitMs: this.wallClockMs, elapsedMs });
      }
    }
    return this.firstExhaustion;
  }

  remaining(surface: Surface): number {
    return Math.max(0, this.limits[surface] - this.spentBySurface[surface]);
  }

  elapsedMs(): number {
    return this.now() - this.startedAt;
  }

  spend(): BudgetSpend {
    return {
      spent: { ...this.spentBySurface },
      limits: { ...this.limits },
      elapsedMs: this.elapsedMs(),
      wallClockMs: this.wallClockMs,
    };
  }

  private recordExhaustion(reason: ExhaustionReason): void {
    // Only the first is kept. Once a scan is out of warehouse statements it will
    // fail every subsequent take, and reporting the hundredth is less informative
    // than reporting the first.
    this.firstExhaustion ??= reason;
  }
}
