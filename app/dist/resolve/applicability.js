//#region server/resolve/applicability.ts
/**
* The scalar a precondition compares against.
*
* Signal values are shaped by their collectors and are usually structured. A
* precondition needs one comparable value, so collectors expose it under `summary`
* and this reads that, falling back to the value only when it is already scalar.
* There is deliberately no path expression: a precondition that has to reach into a
* collector's payload shape is coupled to it, and would break silently whenever the
* query changed.
*/
function scalarOf(result) {
	const value = result.value;
	if (value != null && typeof value === "object" && "summary" in value) return value.summary;
	if (value === null || [
		"string",
		"number",
		"boolean"
	].includes(typeof value)) return value;
}
function compare(operator, observed, expected) {
	if (operator === "present") return observed != null;
	if (operator === "absent") return observed == null;
	if (observed == null) return false;
	if (operator === "eq") return observed === expected;
	if (operator === "neq") return observed !== expected;
	if (typeof observed !== "number" || typeof expected !== "number") return void 0;
	switch (operator) {
		case "gt": return observed > expected;
		case "gte": return observed >= expected;
		case "lt": return observed < expected;
		case "lte": return observed <= expected;
	}
}
/**
* Resolve a control's applicability from its preconditions.
*
* First match wins, and `satisfied-by-architecture` is preferred over
* `not-applicable` when both match. A control the platform genuinely satisfies
* should be credited rather than quietly removed: dropping it makes the pillar look
* the same as one where the control was never relevant, and the customer loses the
* evidence that their architecture earned the pass.
*/
function resolveApplicability(preconditions, signals) {
	if (preconditions.length === 0) return { kind: "applicable" };
	const matches = [];
	for (const precondition of preconditions) {
		if ((precondition.scope ?? "segment") === "segment") {
			matches.push({
				kind: "needs-segments",
				signal: precondition.signal,
				reason: precondition.reason
			});
			continue;
		}
		const result = signals.get(precondition.signal);
		if (result == null) {
			matches.push({
				kind: "undetermined",
				signal: precondition.signal,
				detail: `Signal ${precondition.signal} was not collected, so this control is assessed as applicable.`
			});
			continue;
		}
		if (result.status === "unmeasurable") {
			matches.push({
				kind: "undetermined",
				signal: precondition.signal,
				detail: result.unmeasurableReason ?? `Signal ${precondition.signal} could not be measured, so this control is assessed as applicable.`
			});
			continue;
		}
		const outcome = compare(precondition.operator, scalarOf(result), precondition.value);
		if (outcome === void 0) {
			matches.push({
				kind: "undetermined",
				signal: precondition.signal,
				detail: `Precondition on ${precondition.signal} could not be evaluated: ${precondition.operator} needs comparable numbers.`
			});
			continue;
		}
		if (outcome) matches.push({
			kind: precondition.outcome,
			reason: precondition.reason,
			signal: precondition.signal
		});
	}
	return matches.find((m) => m.kind === "satisfied-by-architecture") ?? matches.find((m) => m.kind === "not-applicable") ?? matches.find((m) => m.kind === "needs-segments") ?? matches.find((m) => m.kind === "undetermined") ?? { kind: "applicable" };
}
//#endregion
export { resolveApplicability };
