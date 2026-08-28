//#region server/collect/signal.ts
/** Narrowest first, so a combination can be reduced without a comparator per call site. */
const REACH_ORDER = [
	"workspace",
	"metastore",
	"account"
];
const COMPLETE = { mode: "complete" };
/** The narrower of two reaches, treating an unstated one as narrowing nothing. */
function narrowerReach(a, b) {
	if (a == null) return b;
	if (b == null) return a;
	return REACH_ORDER.indexOf(a) < REACH_ORDER.indexOf(b) ? a : b;
}
function unmeasurable(id, reason, coverage = COMPLETE) {
	return {
		id,
		status: "unmeasurable",
		coverage,
		unmeasurableReason: reason,
		collectedAt: /* @__PURE__ */ new Date(),
		durationMs: 0
	};
}
function observed(id, value, durationMs, coverage = COMPLETE) {
	return {
		id,
		status: "observed",
		coverage,
		value,
		collectedAt: /* @__PURE__ */ new Date(),
		durationMs
	};
}
//#endregion
export { COMPLETE, narrowerReach, observed, unmeasurable };
