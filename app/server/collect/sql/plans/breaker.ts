/**
 * Stopping the plan fetch when the endpoint has stopped answering.
 *
 * What this is worth was measured rather than assumed, and the premise it was written against was wrong.
 * `33m` asked for a breaker so "a degraded API does not become hundreds of failed fetches". A fully
 * degraded endpoint cannot produce hundreds: the fetch is at most `shapeLimit` shapes, 40 by default, and
 * `maxAttempts` is 4, so the ceiling is 40 fetches and 160 requests. Measured at that ceiling on
 * 2026-08-11, with real sleeps and every response an error:
 *
 * | Response | Requests | Wall clock | Limiter |
 * |----------|----------|------------|---------|
 * | 503      | 160      | 69.6s      | narrowed to 1, 160 reductions |
 * | 500      | 160      | 33.2s      | held at 2, no reductions |
 *
 * So the cost is not a request count, it is around a minute added to every run against an endpoint that
 * is answering nothing — and the surface budget cannot stop it, because budget is taken once per task, so
 * 40 shapes spend 40 of the 200 units however many attempts each one makes.
 *
 * The 503 row costs twice the 500 row for a reason worth keeping: `errors.ts` classifies 503 as
 * `rate-limited`, so the limiter halves its concurrency to 1 and the 40 tasks serialise. The protection
 * against throttling doubles the wall clock of a storm. That is not an argument against the narrowing —
 * it is the right response to a real 429 — it is the reason this breaker is not redundant with it.
 *
 * Consecutive rather than total, because the two mean different things about the endpoint: 5 failures
 * spread through a run is an endpoint answering most of the time, and stopping there would throw away
 * plans that were going to arrive. Five in a row is not that.
 */

/** Consecutive failures before the rest of the fetch is abandoned. */
export const DEFAULT_BREAKER_THRESHOLD = 5;

/**
 * Consecutive-failure count with a threshold, and nothing else.
 *
 * Deliberately not a timer or a half-open state. A plan fetch lasts seconds inside one run, so there is
 * no interval over which to reset and nothing to probe with: the next run opens a new breaker.
 */
export class PlanBreaker {
  private consecutive = 0;
  private tripped = false;

  constructor(private readonly threshold: number = DEFAULT_BREAKER_THRESHOLD) {}

  /** True once the threshold has been reached, and from then on for this run. */
  open(): boolean {
    return this.tripped;
  }

  /**
   * A fetch that returned something the parser can read, whatever it says.
   *
   * A 404 counts as an answer. It is the expected reply for the residue `33l` does not pre-filter, and an
   * endpoint returning them is working — treating it as a failure would trip the breaker on a healthy
   * estate whose shapes mostly ran somewhere else.
   */
  answered(): void {
    this.consecutive = 0;
  }

  /** A fetch the scheduler could not complete, after its own retries. */
  failed(): void {
    this.consecutive += 1;
    if (this.consecutive >= this.threshold) this.tripped = true;
  }
}
