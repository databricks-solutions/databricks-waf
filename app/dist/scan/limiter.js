//#region server/scan/limiter.ts
var AdaptiveLimiter = class {
	ceiling;
	recoveryAfter;
	now;
	limit;
	inFlight = 0;
	consecutiveSuccesses = 0;
	reductions = 0;
	pausedUntil = 0;
	drainTimer;
	waiters = [];
	constructor(options) {
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
	async acquire(signal) {
		if (signal?.aborted) throw abortError();
		let onAbort;
		try {
			await new Promise((resolve, reject) => {
				const waiter = {
					resolve,
					reject
				};
				if (signal != null) {
					onAbort = () => {
						const at = this.waiters.indexOf(waiter);
						if (at >= 0) this.waiters.splice(at, 1);
						reject(abortError());
					};
					signal.addEventListener("abort", onAbort, { once: true });
				}
				this.waiters.push(waiter);
				this.drain();
			});
		} finally {
			if (onAbort != null && signal != null) signal.removeEventListener("abort", onAbort);
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
	onSuccess() {
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
	onThrottled(retryAfterMs) {
		this.limit = Math.max(1, Math.floor(this.limit / 2));
		this.consecutiveSuccesses = 0;
		this.reductions += 1;
		if (retryAfterMs != null && retryAfterMs > 0) this.pausedUntil = Math.max(this.pausedUntil, this.now() + retryAfterMs);
		this.drain();
	}
	/**
	* Report a failure that says nothing about capacity — a permission denial, a
	* missing object. Resets the recovery streak without reducing the limit, since
	* such a failure is neither evidence of pressure nor evidence of headroom.
	*/
	onNeutralFailure() {
		this.consecutiveSuccesses = 0;
	}
	state() {
		return {
			limit: this.limit,
			ceiling: this.ceiling,
			inFlight: this.inFlight,
			queued: this.waiters.length,
			pausedForMs: Math.max(0, this.pausedUntil - this.now()),
			reductions: this.reductions
		};
	}
	drain() {
		const pausedFor = this.pausedUntil - this.now();
		if (pausedFor > 0) {
			if (this.drainTimer == null && this.waiters.length > 0) this.drainTimer = setTimeout(() => {
				this.drainTimer = void 0;
				this.drain();
			}, pausedFor);
			return;
		}
		while (this.inFlight < this.limit && this.waiters.length > 0) {
			const waiter = this.waiters.shift();
			if (waiter == null) break;
			this.inFlight += 1;
			waiter.resolve();
		}
	}
};
function abortError() {
	const error = /* @__PURE__ */ new Error("Scan cancelled while waiting for a concurrency slot");
	error.name = "AbortError";
	return error;
}
//#endregion
export { AdaptiveLimiter };
