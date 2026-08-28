//#region server/advise/plan-capability.ts
/**
* How many shapes a request was actually issued for.
*
* Deliberately excludes `abandoned` and `notRun`. Those are shapes nothing was asked about — the first by
* the breaker, the second by cancellation or a spent budget — and counting them as asked was how a
* cancelled run came to look like an endpoint answering nothing.
*/
function asked(plans) {
	return plans.available + plans.withoutPlan + plans.failed;
}
/**
* True where this summary is fit to be a later run's baseline.
*
* Reach, not merely activity. A run that read no plans establishes no floor to fall from, and taking one as
* the baseline would silence the alert for the run after it while the older run that did have reach is never
* reached — the same floor a refused warehouse list would set, arriving by a different cause.
*/
function isBaseline(plans) {
	return plans.warehousesKnown && plans.available > 0;
}
/**
* The one thing worth saying about this run's plan reach, or nothing.
*
* Ordered by what a reader can act on. `cannot-tell` comes first because it makes every other reading
* uninformative, and `gave-up` outranks `lost-reach` because it names the cause of whatever was not read.
* It does not imply nothing was read: the branch fires whenever any shape was abandoned, and a run can
* abandon some shapes and still return plans for others.
*/
function planCapability(plans, baseline) {
	if (plans == null) return void 0;
	if (!plans.warehousesKnown) return { kind: "cannot-tell" };
	if (plans.abandoned > 0) return {
		kind: "gave-up",
		failed: plans.failed,
		abandoned: plans.abandoned
	};
	if (baseline == null || baseline.plans.available === 0) return void 0;
	if (plans.available > 0 || asked(plans) === 0) return void 0;
	return {
		kind: "lost-reach",
		baselineAdvisoryId: baseline.advisoryId,
		baselineAvailable: baseline.plans.available
	};
}
//#endregion
export { isBaseline, planCapability };
