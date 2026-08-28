/**
* Consecutive-failure count with a threshold, and nothing else.
*
* Deliberately not a timer or a half-open state. A plan fetch lasts seconds inside one run, so there is
* no interval over which to reset and nothing to probe with: the next run opens a new breaker.
*/
var PlanBreaker = class {
	threshold;
	consecutive = 0;
	tripped = false;
	constructor(threshold = 5) {
		this.threshold = threshold;
	}
	/** True once the threshold has been reached, and from then on for this run. */
	open() {
		return this.tripped;
	}
	/**
	* A fetch that returned something the parser can read, whatever it says.
	*
	* A 404 counts as an answer. It is the expected reply for the residue `33l` does not pre-filter, and an
	* endpoint returning them is working — treating it as a failure would trip the breaker on a healthy
	* estate whose shapes mostly ran somewhere else.
	*/
	answered() {
		this.consecutive = 0;
	}
	/** A fetch the scheduler could not complete, after its own retries. */
	failed() {
		this.consecutive += 1;
		if (this.consecutive >= this.threshold) this.tripped = true;
	}
};
//#endregion
export { PlanBreaker };
