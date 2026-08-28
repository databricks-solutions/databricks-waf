// Tests for the load discipline, not for the plumbing.
//
// Each of these corresponds to a way a scan could mistreat a customer's workspace:
// exceeding a budget under concurrency, retrying on top of a retrying SDK,
// ignoring Retry-After, failing a whole scan over one permission denial.

import { describe, expect, it, vi } from 'vitest';

import { Budget } from '../server/scan/budget.js';
import { classify, parseRetryAfter } from '../server/scan/errors.js';
import { AdaptiveLimiter } from '../server/scan/limiter.js';
import { CollectionScheduler } from '../server/scan/scheduler.js';
import { defaultLimits } from '../server/scan/surfaces.js';

function httpError(status: number, headers: Record<string, string> = {}): Error & { status: number } {
  const error = new Error(`HTTP ${status}`) as Error & { status: number; headers: Record<string, string> };
  error.status = status;
  error.headers = headers;
  return error;
}

const noSleep = () => Promise.resolve();

describe('failure classification', () => {
  it('reads Retry-After in both of its specified forms', () => {
    expect(parseRetryAfter('30')).toBe(30_000);

    const now = Date.parse('2026-07-31T00:00:00Z');
    expect(parseRetryAfter('Fri, 31 Jul 2026 00:00:30 GMT', now)).toBe(30_000);

    // A date already past means retry now, not in negative time.
    expect(parseRetryAfter('Fri, 31 Jul 2026 00:00:00 GMT', now + 5_000)).toBe(0);
  });

  it('returns undefined for an unparseable value rather than guessing', () => {
    expect(parseRetryAfter('soon')).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
  });

  it('believes the status code over the message text', () => {
    // The message says "rate limit" but the server said 403. Trusting the message
    // would make the scheduler back off from a permission problem for ever.
    const error = httpError(403);
    error.message = 'rate limit exceeded';
    expect(classify(error).kind).toBe('permission-denied');
  });

  it('recognises a Unity Catalog denial that arrives without a status', () => {
    // The statement execution API reports these in the result rather than as an
    // HTTP error, so message matching is the only signal available.
    expect(classify(new Error('PERMISSION_DENIED: User does not have SELECT on table')).kind).toBe('permission-denied');
  });

  it('treats 503 as throttling rather than a generic server error', () => {
    expect(classify(httpError(503)).kind).toBe('rate-limited');
  });
});

describe('budget', () => {
  it('refuses the take that would exceed the limit, and reports why', () => {
    const budget = new Budget({ limits: { ...zeroLimits(), sql: 3 } });

    expect(budget.tryTake('sql', 2)).toBe(true);
    // Would reach 4 against a limit of 3, so it is refused whole rather than
    // partially admitted.
    expect(budget.tryTake('sql', 2)).toBe(false);
    expect(budget.remaining('sql')).toBe(1);

    expect(budget.exhaustion()).toEqual({ kind: 'surface-budget', surface: 'sql', limit: 3 });
  });

  it('stops on the wall clock even with budget to spare', () => {
    let clock = 0;
    const budget = new Budget({ limits: { ...zeroLimits(), sql: 100 }, wallClockMs: 1_000, now: () => clock });

    expect(budget.tryTake('sql')).toBe(true);
    clock = 1_001;
    expect(budget.tryTake('sql')).toBe(false);
    expect(budget.exhaustion()?.kind).toBe('wall-clock');
  });

  it('refunds work that never ran, so the footprint does not overstate our load', () => {
    const budget = new Budget({ limits: { ...zeroLimits(), rest: 10 } });
    budget.tryTake('rest', 4);
    budget.refund('rest', 4);
    expect(budget.spend().spent.rest).toBe(0);
  });
});

describe('adaptive limiter', () => {
  it('halves on a throttling signal and recovers only after a run of successes', () => {
    const limiter = new AdaptiveLimiter({ ceiling: 8, recoveryAfter: 3 });

    limiter.onThrottled();
    expect(limiter.state().limit).toBe(4);
    limiter.onThrottled();
    expect(limiter.state().limit).toBe(2);

    // Two successes are not enough; the third reclaims one slot.
    limiter.onSuccess();
    limiter.onSuccess();
    expect(limiter.state().limit).toBe(2);
    limiter.onSuccess();
    expect(limiter.state().limit).toBe(3);

    expect(limiter.state().reductions).toBe(2);
  });

  it('never halves below one, so a throttled surface still makes progress', () => {
    const limiter = new AdaptiveLimiter({ ceiling: 2 });
    for (let i = 0; i < 10; i += 1) limiter.onThrottled();
    expect(limiter.state().limit).toBe(1);
  });

  it('holds admissions for the whole Retry-After window', async () => {
    vi.useFakeTimers();
    try {
      const limiter = new AdaptiveLimiter({ ceiling: 2 });
      limiter.onThrottled(5_000);

      let admitted = false;
      void limiter.acquire().then(() => {
        admitted = true;
      });

      await vi.advanceTimersByTimeAsync(4_000);
      expect(admitted).toBe(false);

      await vi.advanceTimersByTimeAsync(1_100);
      expect(admitted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not reduce the limit for a permission denial', () => {
    // A denial says nothing about the target's capacity. Treating it as pressure
    // would make a scan slower and slower the less it is allowed to see.
    const limiter = new AdaptiveLimiter({ ceiling: 4, recoveryAfter: 2 });
    limiter.onNeutralFailure();
    expect(limiter.state().limit).toBe(4);
  });

  it('releases a slot once however many times release is called', async () => {
    const limiter = new AdaptiveLimiter({ ceiling: 1 });
    const release = await limiter.acquire();
    release();
    release();
    // A second decrement would leave inFlight negative and admit two tasks against
    // a limit of one.
    expect(limiter.state().inFlight).toBe(0);
  });

  it('drops a queued task on cancellation instead of leaving it waiting', async () => {
    const limiter = new AdaptiveLimiter({ ceiling: 1 });
    await limiter.acquire();

    const controller = new AbortController();
    const queued = limiter.acquire(controller.signal);
    controller.abort();

    await expect(queued).rejects.toThrow(/cancelled/i);
    expect(limiter.state().queued).toBe(0);
  });
});

describe('scheduler', () => {
  it('holds concurrent tasks to the surface limit', async () => {
    const scheduler = new CollectionScheduler({ limits: { rest: { concurrency: 3 } }, sleep: noSleep });

    let inFlight = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        scheduler.run({
          surface: 'rest',
          label: `call-${i}`,
          run: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((r) => setTimeout(r, 5));
            inFlight -= 1;
            return i;
          },
        })
      )
    );

    expect(peak).toBe(3);
    expect(scheduler.footprint().tasks.rest.ok).toBe(12);
  });

  it('shares one concurrency ceiling between sql and describe, because they share a warehouse', async () => {
    // Two limiters of two against one warehouse would be four concurrent
    // statements, which is not what either limit says.
    const scheduler = new CollectionScheduler({ warehouse: 'shared', sleep: noSleep });

    let inFlight = 0;
    let peak = 0;
    const work = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
    };

    await Promise.all([
      ...Array.from({ length: 4 }, (_, i) => scheduler.run({ surface: 'sql', label: `q${i}`, run: work })),
      ...Array.from({ length: 4 }, (_, i) => scheduler.run({ surface: 'describe', label: `d${i}`, run: work })),
    ]);

    expect(peak).toBe(2);
    expect(Object.keys(scheduler.footprint().limiters)).toEqual(['warehouse']);
  });

  it('limits cloud concurrency per service, so a slow one does not starve the others', async () => {
    const scheduler = new CollectionScheduler({ limits: { cloud: { concurrency: 1 } }, sleep: noSleep });

    const order: string[] = [];
    await Promise.all([
      scheduler.run({
        surface: 'cloud',
        partition: 's3',
        label: 's3',
        run: async () => {
          await new Promise((r) => setTimeout(r, 20));
          order.push('s3');
        },
      }),
      scheduler.run({
        surface: 'cloud',
        partition: 'ec2',
        label: 'ec2',
        run: async () => {
          order.push('ec2');
        },
      }),
    ]);

    // ec2 finished first despite being submitted second: separate limiters.
    expect(order).toEqual(['ec2', 's3']);
    expect(Object.keys(scheduler.footprint().limiters).sort()).toEqual(['cloud:ec2', 'cloud:s3']);
  });

  it('does not exceed the budget under concurrency', async () => {
    const scheduler = new CollectionScheduler({
      budgets: { rest: 5 },
      limits: { rest: { concurrency: 8 } },
      sleep: noSleep,
    });

    let ran = 0;
    const outcomes = await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        scheduler.run({
          surface: 'rest',
          label: `call-${i}`,
          run: async () => {
            ran += 1;
          },
        })
      )
    );

    // Reserved before running, so eight concurrent tasks cannot collectively
    // overshoot a limit each of them individually respected.
    expect(ran).toBe(5);
    expect(outcomes.filter((o) => o.status === 'skipped')).toHaveLength(15);
    expect(scheduler.footprint().spend.spent.rest).toBe(5);
  });

  it('pauses rather than failing when the budget runs out, and says which limit was hit', async () => {
    const scheduler = new CollectionScheduler({ budgets: { sql: 1 }, sleep: noSleep });

    await scheduler.run({ surface: 'sql', label: 'first', run: async () => 'ok' });
    const second = await scheduler.run({ surface: 'sql', label: 'second', run: async () => 'ok' });

    expect(second.status).toBe('skipped');
    if (second.status !== 'skipped') throw new Error('expected skipped');
    expect(second.reason).toBe('budget-exhausted');
    expect(second.detail).toContain('limit of 1 sql operations');
    expect(scheduler.exhausted).toBe(true);
  });

  it('does not retry a surface whose client already retries', async () => {
    // The whole point: the SDK retries underneath, so retrying here would multiply
    // the request count the operator thinks they capped. `rest` is the surface where
    // that is still true and checked — ADR 0093 names the SDK's own retry loop.
    expect(defaultLimits().rest.clientRetries).toBe(true);

    const scheduler = new CollectionScheduler({ sleep: noSleep });
    let attempts = 0;

    const outcome = await scheduler.run({
      surface: 'rest',
      label: 'listing',
      run: async () => {
        attempts += 1;
        throw httpError(429);
      },
    });

    expect(attempts).toBe(1);
    expect(outcome.status).toBe('failed');
  });

  it('retries a throttled statement, because ADR 0012 left nothing underneath that would', async () => {
    // The regression this whole row is: `sql` said its client retried while
    // `StatementExecutor` throws on the first non-`ok` response, so a 429 was lost on
    // first sight and `RETRYABLE` classified it for nobody.
    expect(defaultLimits().sql.clientRetries).toBe(false);
    expect(defaultLimits().describe.clientRetries).toBe(false);

    const scheduler = new CollectionScheduler({ maxAttempts: 3, sleep: noSleep });
    let attempts = 0;

    const outcome = await scheduler.run({
      surface: 'sql',
      label: 'sql:table_health',
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(429);
        return 'rows';
      },
    });

    expect(attempts).toBe(3);
    expect(outcome.status).toBe('ok');
  });

  it('does not retry a statement the identity may not run, however many attempts are allowed', async () => {
    // A permission denial is data about the estate rather than a fault, so the extra
    // attempts the flag now permits must not be spent re-asking a question already answered.
    const scheduler = new CollectionScheduler({ maxAttempts: 4, sleep: noSleep });
    let attempts = 0;

    const outcome = await scheduler.run({
      surface: 'sql',
      label: 'sql:denied',
      run: async () => {
        attempts += 1;
        throw httpError(403);
      },
    });

    expect(attempts).toBe(1);
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') throw new Error('expected skipped');
    expect(outcome.reason).toBe('permission-denied');
  });

  it('gives up rather than waiting out a Retry-After longer than a scan will sit still for', async () => {
    // Neither waiting nor retrying early. Ten minutes on one signal is a quarter of the
    // wall clock, and retrying before the server said is the amplification the flags exist
    // to prevent — so the only remaining move is to record the refusal. ADR 0093.
    const slept: number[] = [];
    const scheduler = new CollectionScheduler({
      maxAttempts: 4,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    let attempts = 0;

    const outcome = await scheduler.run({
      surface: 'sql',
      label: 'sql:throttled',
      run: async () => {
        attempts += 1;
        throw httpError(429, { 'retry-after': '600' });
      },
    });

    expect(attempts).toBe(1);
    expect(slept).toEqual([]);
    expect(outcome.status).toBe('failed');
  });

  it('waits out a Retry-After the scan can afford, for the interval the server named', async () => {
    const slept: number[] = [];
    const scheduler = new CollectionScheduler({
      maxAttempts: 2,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    let attempts = 0;

    await scheduler.run({
      surface: 'sql',
      label: 'sql:throttled',
      run: async () => {
        attempts += 1;
        throw httpError(429, { 'retry-after': '5' });
      },
    });

    expect(attempts).toBe(2);
    // The server's figure verbatim, not the jittered guess it displaces.
    expect(slept).toEqual([5_000]);
  });

  it('reports the attempts it made rather than the attempts it was allowed', async () => {
    // Reported `maxAttempts` on every failure before ADR 0093, which said four on a
    // statement that had been refused once — and telling those two apart is the reason
    // the number is on the record at all.
    const scheduler = new CollectionScheduler({ maxAttempts: 4, sleep: noSleep });

    const outcome = await scheduler.run({
      surface: 'sql',
      label: 'sql:broken',
      run: async () => {
        throw httpError(400);
      },
    });

    expect(outcome.status).toBe('failed');
    if (outcome.status !== 'failed') throw new Error('expected failed');
    expect(outcome.attempts).toBe(1);
  });

  it('records what a surface failed of, so six failures are not six of the same thing', async () => {
    const scheduler = new CollectionScheduler({ maxAttempts: 2, sleep: noSleep });

    await scheduler.run({ surface: 'sql', label: 'a', run: async () => Promise.reject(httpError(429)) });
    await scheduler.run({ surface: 'sql', label: 'b', run: async () => Promise.reject(httpError(429)) });
    await scheduler.run({ surface: 'sql', label: 'c', run: async () => Promise.reject(httpError(400)) });

    const sql = scheduler.footprint().tasks.sql;
    expect(sql.failed).toBe(3);
    expect(sql.terminal).toEqual({ 'rate-limited': 2, fatal: 1 });
    // Two attempts each on the throttled pair, one on the fatal, which is what the
    // retries cost and what `failed` alone cannot say.
    expect(sql.attempts).toBe(5);
  });

  it('snapshots the counters, so a footprint taken mid-scan does not move afterwards', async () => {
    const scheduler = new CollectionScheduler({ sleep: noSleep });
    await scheduler.run({ surface: 'sql', label: 'a', run: async () => Promise.reject(httpError(400)) });

    const before = scheduler.footprint().tasks.sql;
    await scheduler.run({ surface: 'sql', label: 'b', run: async () => Promise.reject(httpError(400)) });

    expect(before.failed).toBe(1);
    expect(before.terminal).toEqual({ fatal: 1 });
  });

  it('retries the AI surface itself, because nothing underneath it does', async () => {
    expect(defaultLimits().ai.clientRetries).toBe(false);

    const scheduler = new CollectionScheduler({ maxAttempts: 3, sleep: noSleep });
    let attempts = 0;

    const outcome = await scheduler.run({
      surface: 'ai',
      label: 'narrative',
      run: async () => {
        attempts += 1;
        if (attempts < 3) throw httpError(429);
        return 'narrative text';
      },
    });

    expect(attempts).toBe(3);
    expect(outcome.status).toBe('ok');
    expect(scheduler.footprint().tasks.ai.retries).toBe(2);
  });

  it('halves concurrency on a 429 even when it is not the one retrying', async () => {
    const scheduler = new CollectionScheduler({ limits: { rest: { concurrency: 8 } }, sleep: noSleep });

    await scheduler.run({
      surface: 'rest',
      label: 'throttled',
      run: async () => {
        throw httpError(429);
      },
    });

    expect(scheduler.footprint().limiters.rest?.limit).toBe(4);
    expect(scheduler.footprint().limiters.rest?.reductions).toBe(1);
  });

  it('prefers the server Retry-After over its own backoff', async () => {
    const slept: number[] = [];
    const scheduler = new CollectionScheduler({
      maxAttempts: 2,
      baseBackoffMs: 10_000,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await scheduler.run({
      surface: 'ai',
      label: 'narrative',
      run: async () => {
        throw httpError(429, { 'retry-after': '2' });
      },
    });

    expect(slept).toEqual([2_000]);
  });

  it('jitters its own backoff, so tasks throttled together do not retry together', async () => {
    const slept: number[] = [];
    const scheduler = new CollectionScheduler({
      maxAttempts: 3,
      baseBackoffMs: 1_000,
      random: () => 0.5,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });

    await scheduler.run({
      surface: 'ai',
      label: 'narrative',
      run: async () => {
        throw httpError(500);
      },
    });

    // Full jitter at 0.5: half of 1000, then half of 2000.
    expect(slept).toEqual([500, 1_000]);
  });

  it('degrades a permission denial to a skip instead of failing the scan', async () => {
    // Expected under on-behalf-of-user execution. A scan of 3000 REST calls where
    // one is denied is a scan with one unmeasurable control, not a failed scan.
    const scheduler = new CollectionScheduler({ sleep: noSleep });

    const outcome = await scheduler.run({
      surface: 'rest',
      label: 'workspace-conf',
      run: async () => {
        throw httpError(403);
      },
    });

    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') throw new Error('expected skipped');
    expect(outcome.reason).toBe('permission-denied');
    expect(scheduler.footprint().tasks.rest.failed).toBe(0);
  });

  it('stops admitting work once cancelled, and refunds what never ran', async () => {
    const scheduler = new CollectionScheduler({ limits: { rest: { concurrency: 1 } }, sleep: noSleep });

    // Waited on, so the first task is genuinely running when the cancel arrives.
    // Without this the test proves something weaker and more confusing: that a task
    // which had not yet begun is declined, which is also true but is the next case
    // down.
    let running!: () => void;
    const isRunning = new Promise<void>((resolve) => {
      running = resolve;
    });

    const started = scheduler.run({
      surface: 'rest',
      label: 'first',
      run: async () => {
        running();
        await new Promise((r) => setTimeout(r, 10));
        return 'done';
      },
    });
    const queued = scheduler.run({ surface: 'rest', label: 'second', run: async () => 'done' });

    await isRunning;
    scheduler.cancel();

    expect((await started).status).toBe('ok');
    expect((await queued).status).toBe('skipped');

    const after = await scheduler.run({ surface: 'rest', label: 'third', run: async () => 'done' });
    expect(after.status).toBe('skipped');

    // One task ran; the cancelled ones gave their reservations back.
    expect(scheduler.footprint().spend.spent.rest).toBe(1);
    expect(scheduler.footprint().cancelled).toBe(true);
  });

  it('hands the task a signal so it can abandon itself', async () => {
    const scheduler = new CollectionScheduler({ sleep: noSleep });
    let sawAbort = false;

    let listening!: () => void;
    const isListening = new Promise<void>((resolve) => {
      listening = resolve;
    });

    const running = scheduler.run({
      surface: 'rest',
      label: 'long',
      run: (signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(new Error('aborted by scan'));
          });
          listening();
        }),
    });

    await isListening;
    scheduler.cancel();
    const outcome = await running;

    expect(sawAbort).toBe(true);
    expect(outcome.status).toBe('skipped');
    if (outcome.status !== 'skipped') throw new Error('expected skipped');
    expect(outcome.reason).toBe('cancelled');
  });
});

function zeroLimits() {
  return { sql: 0, describe: 0, rest: 0, cloud: 0, ai: 0 } as const;
}
