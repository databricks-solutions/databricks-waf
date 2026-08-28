//#region server/improve/value.ts
const NO_OUTCOMES = {
	unclaimed: 0,
	awaiting: 0,
	agreed: 0,
	contradicted: 0,
	unmeasured: 0,
	unjudged: 0
};
function valueOf(input) {
	const advised = input.progress.filter((one) => one.action.advice != null);
	const outcomes = { ...NO_OUTCOMES };
	for (const one of advised) outcomes[one.agreement] += 1;
	return {
		...input.posture != null ? { posture: input.posture } : {},
		opportunity: input.opportunity ?? [],
		committed: committedFrom(advised),
		realised: realisedFrom(advised),
		cleared: clearedFrom(advised),
		outcomes
	};
}
/**
* What was accepted, by advisor and currency, over the resources it was accepted on.
*
* Cancelled work is out and everything else is in, including the verified: committed value is what
* somebody agreed to, and dropping it once the work is done would make the total fall as the programme
* succeeds. A cancelled action is the one case where the commitment was withdrawn.
*/
function committedFrom(advised) {
	const totals = /* @__PURE__ */ new Map();
	for (const one of advised) {
		const advice = one.action.advice;
		const opportunity = advice.opportunity;
		if (opportunity == null || one.action.state === "cancelled") continue;
		const key = `${advice.advisor}\u0000${opportunity.currency}`;
		const total = totals.get(key) ?? {
			advisor: advice.advisor,
			currency: opportunity.currency,
			low: 0,
			high: 0,
			region: opportunity.region,
			regions: 0,
			resources: /* @__PURE__ */ new Set(),
			actions: 0,
			assumptions: /* @__PURE__ */ new Set()
		};
		totals.set(key, total);
		total.actions += 1;
		for (const assumption of advice.assumptions) total.assumptions.add(assumption);
		if (total.resources.has(advice.resource.id)) continue;
		total.resources.add(advice.resource.id);
		total.low += opportunity.low;
		total.high += opportunity.high;
		if (total.region !== opportunity.region) total.region = void 0;
		total.regions += 1;
	}
	return [...totals.values()].map((total) => ({
		advisor: total.advisor,
		low: round(total.low),
		high: round(total.high),
		currency: total.currency,
		...total.region != null ? { region: total.region } : {},
		resources: total.resources.size,
		actions: total.actions,
		assumptions: [...total.assumptions]
	}));
}
/** Two decimal places, because these are sums of money and floating point makes long tails of them. */
function round(value) {
	return Math.round(value * 100) / 100;
}
/** Every comparable measure, summed per advisor, label and unit over the distinct measurements. */
function realisedFrom(advised) {
	const totals = /* @__PURE__ */ new Map();
	for (const one of advised) {
		const advice = one.action.advice;
		for (const movement of one.advice?.movements ?? []) {
			const key = `${advice.advisor}\u0000${movement.label}\u0000${movement.unit}`;
			const measurement = `${advice.resource.id}\u0000${advice.rule}`;
			const total = totals.get(key);
			if (total == null) {
				totals.set(key, {
					measured: {
						advisor: advice.advisor,
						label: movement.label,
						unit: movement.unit,
						before: movement.before,
						after: movement.after,
						measurements: 1
					},
					seen: /* @__PURE__ */ new Set([measurement])
				});
				continue;
			}
			if (total.seen.has(measurement)) continue;
			total.seen.add(measurement);
			totals.set(key, {
				seen: total.seen,
				measured: {
					...total.measured,
					before: total.measured.before + movement.before,
					after: total.measured.after + movement.after,
					measurements: total.measured.measurements + 1
				}
			});
		}
	}
	return [...totals.values()].map((total) => total.measured);
}
function clearedFrom(advised) {
	const cleared = advised.filter((one) => one.advice?.standing === "cleared");
	const resources = new Set(cleared.map((one) => one.action.advice.resource.id));
	return {
		actions: cleared.length,
		resources: resources.size
	};
}
//#endregion
export { valueOf };
