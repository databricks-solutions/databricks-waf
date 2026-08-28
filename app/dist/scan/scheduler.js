import { SURFACES, defaultLimits } from "./surfaces.js";
import { Budget } from "./budget.js";
import { RETRYABLE, classify, isDegradation } from "./errors.js";
import { AdaptiveLimiter } from "./limiter.js";
//#region server/scan/scheduler.ts
var CollectionScheduler = class {
	surfaceLimits;
	limiters = /* @__PURE__ */ new Map();
	budget;
	controller = new AbortController();
	maxAttempts;
	baseBackoffMs;
	sleep;
	random;
	counters;
	constructor(options = {}) {
		const base = defaultLimits(options.warehouse ?? "shared");
		this.surfaceLimits = Object.fromEntries(SURFACES.map((surface) => [surface, {
			...base[surface],
			...options.limits?.[surface] ?? {}
		}]));
		const budgetLimits = Object.fromEntries(SURFACES.map((surface) => [surface, options.budgets?.[surface] ?? this.surfaceLimits[surface].budget]));
		this.budget = new Budget({
			limits: budgetLimits,
			wallClockMs: options.wallClockMs ?? 27e5,
			...options.now != null ? { now: options.now } : {}
		});
		this.maxAttempts = options.maxAttempts ?? 4;
		this.baseBackoffMs = options.baseBackoffMs ?? 500;
		this.sleep = options.sleep ?? defaultSleep;
		this.random = options.random ?? Math.random;
		this.counters = Object.fromEntries(SURFACES.map((s) => [s, {
			ok: 0,
			skipped: 0,
			failed: 0,
			retries: 0,
			attempts: 0,
			terminal: {}
		}]));
	}
	get signal() {
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
	cancel() {
		this.controller.abort();
	}
	get cancelled() {
		return this.controller.signal.aborted;
	}
	/**
	* Whether the scan has hit a wall and should stop queueing work. Collectors check
	* this between units so that a paused scan stops promptly rather than grinding
	* through hundreds of refusals.
	*/
	get exhausted() {
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
	async run(task) {
		const units = task.units ?? 1;
		const limits = this.surfaceLimits[task.surface];
		if (this.controller.signal.aborted) {
			this.counters[task.surface].skipped += 1;
			return {
				status: "skipped",
				reason: "cancelled",
				detail: `${task.label} was not started: scan cancelled`
			};
		}
		if (!this.budget.tryTake(task.surface, units)) {
			this.counters[task.surface].skipped += 1;
			const reason = this.budget.exhaustion();
			return {
				status: "skipped",
				reason: "budget-exhausted",
				detail: describeExhaustion(task.label, reason)
			};
		}
		const limiter = this.limiterFor(task.surface, task.partition);
		let release;
		try {
			release = await limiter.acquire(this.controller.signal);
		} catch {
			this.budget.refund(task.surface, units);
			this.counters[task.surface].skipped += 1;
			return {
				status: "skipped",
				reason: "cancelled",
				detail: `${task.label} was cancelled while queued`
			};
		}
		try {
			return await this.attempt(task, limits, limiter);
		} finally {
			release();
		}
	}
	footprint() {
		return {
			spend: this.budget.spend(),
			tasks: copyCounters(this.counters),
			limiters: Object.fromEntries([...this.limiters].map(([key, l]) => [key, l.state()])),
			exhaustion: this.budget.exhaustion(),
			cancelled: this.controller.signal.aborted
		};
	}
	async attempt(task, limits, limiter) {
		const attemptsAllowed = limits.clientRetries ? 1 : this.maxAttempts;
		const precondition = task.skipWhen?.();
		if (precondition != null) {
			this.counters[task.surface].skipped += 1;
			return {
				status: "skipped",
				reason: "precondition",
				detail: precondition
			};
		}
		let lastFailure;
		let made = 0;
		for (let attempt = 1; attempt <= attemptsAllowed; attempt += 1) {
			if (this.controller.signal.aborted) {
				this.counters[task.surface].skipped += 1;
				return {
					status: "skipped",
					reason: "cancelled",
					detail: `${task.label} was cancelled`
				};
			}
			made = attempt;
			this.counters[task.surface].attempts += 1;
			try {
				const value = await task.run(this.controller.signal);
				limiter.onSuccess();
				this.counters[task.surface].ok += 1;
				return {
					status: "ok",
					value,
					attempts: attempt
				};
			} catch (error) {
				if (this.controller.signal.aborted) {
					this.counters[task.surface].skipped += 1;
					return {
						status: "skipped",
						reason: "cancelled",
						detail: `${task.label} was cancelled`
					};
				}
				const failure = classify(error);
				lastFailure = failure;
				if (failure.kind === "rate-limited" || failure.kind === "timeout") limiter.onThrottled(failure.retryAfterMs);
				else limiter.onNeutralFailure();
				if (isDegradation(failure.kind)) {
					this.counters[task.surface].skipped += 1;
					return {
						status: "skipped",
						reason: failure.kind === "permission-denied" ? "permission-denied" : "not-found",
						detail: failure.message
					};
				}
				if (!(RETRYABLE.includes(failure.kind) && attempt < attemptsAllowed && !asksForLongerThanAScanWaits(failure))) break;
				this.counters[task.surface].retries += 1;
				await this.backoff(attempt, failure);
			}
		}
		const terminal = lastFailure ?? {
			kind: "fatal",
			message: `${task.label} failed without an error`
		};
		this.counters[task.surface].failed += 1;
		this.counters[task.surface].terminal[terminal.kind] = (this.counters[task.surface].terminal[terminal.kind] ?? 0) + 1;
		return {
			status: "failed",
			failure: terminal,
			attempts: made
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
	async backoff(attempt, failure) {
		const exponential = this.baseBackoffMs * 2 ** (attempt - 1);
		const jittered = Math.floor(exponential * this.random());
		const delay = failure.retryAfterMs ?? jittered;
		await this.sleep(delay, this.controller.signal);
	}
	limiterFor(surface, partition) {
		const limits = this.surfaceLimits[surface];
		const key = limits.partitioned && partition != null ? `${limits.limiterGroup}:${partition}` : limits.limiterGroup;
		let limiter = this.limiters.get(key);
		if (limiter == null) {
			limiter = new AdaptiveLimiter({ ceiling: limits.concurrency });
			this.limiters.set(key, limiter);
		}
		return limiter;
	}
};
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
const LONGEST_WAIT_MS = 6e4;
function asksForLongerThanAScanWaits(failure) {
	return failure.retryAfterMs != null && failure.retryAfterMs > LONGEST_WAIT_MS;
}
function describeExhaustion(label, reason) {
	if (reason == null) return `${label} was not run: the scan budget is exhausted`;
	if (reason.kind === "wall-clock") return `${label} was not run: the scan reached its ${Math.round(reason.limitMs / 6e4)} minute time limit`;
	return `${label} was not run: the scan reached its limit of ${reason.limit} ${reason.surface} operations`;
}
function defaultSleep(ms, signal) {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}
/** A snapshot, so a caller holding a footprint does not watch it move as the scan continues. */
function copyCounters(value) {
	return Object.fromEntries(Object.entries(value).map(([surface, counters]) => [surface, {
		...counters,
		terminal: { ...counters.terminal }
	}]));
}
//#endregion
export { CollectionScheduler };
