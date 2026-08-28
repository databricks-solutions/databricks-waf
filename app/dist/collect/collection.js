import { attributed, locate } from "./provenance.js";
//#region server/collect/collection.ts
/**
* Reads the signals in `needed`, and answers what reading them produced.
*
* Every signal asked for is in the answer, or was already in `resume`. A signal nothing collects is
* simply absent, which is the caller's problem to notice: this cannot tell an unregistered id from one
* whose collector was not in the list.
*/
async function collectSignals(needed, options, scheduler, identity) {
	const collected = /* @__PURE__ */ new Map();
	for (const [id, reading] of options.resume ?? []) if (needed.has(id)) collected.set(id, reading);
	for (const collector of options.collectors) {
		const mine = collector.signals.filter((signal) => needed.has(signal));
		if (mine.length === 0) continue;
		if (mine.every((signal) => collected.has(signal))) continue;
		if (options.stopping != null && await options.stopping()) {
			scheduler.cancel();
			break;
		}
		const from = locate(collector.surface, {
			...options.warehouse != null ? { warehouse: options.warehouse } : {},
			host: identity.host
		});
		const origin = {
			surface: collector.surface,
			collector: collector.name,
			authority: identity.mode,
			actor: identity.actor,
			...from != null ? { from } : {}
		};
		const reported = /* @__PURE__ */ new Set();
		const written = /* @__PURE__ */ new Set();
		const reached = [];
		const context = {
			credentials: options.credentials,
			scheduler,
			collected,
			...options.checkpoint == null ? {} : { settled: async (result) => {
				const reading = attributed(result, origin);
				collected.set(reading.id, reading);
				reached.push(reading);
				reported.add(reading.id);
				try {
					await options.checkpoint?.([reading]);
					written.add(reading.id);
				} catch {}
			} }
		};
		try {
			for (const result of await collector.collect(mine, context)) {
				if (reported.has(result.id)) continue;
				const reading = attributed(result, origin);
				collected.set(result.id, reading);
				reached.push(reading);
			}
		} catch (cause) {
			const detail = cause instanceof Error ? cause.message : String(cause);
			for (const signal of mine) {
				if (collected.has(signal)) continue;
				const reading = {
					id: signal,
					status: "unmeasurable",
					coverage: { mode: "complete" },
					unmeasurableReason: `The ${collector.name} collector failed: ${detail}`,
					collectedAt: /* @__PURE__ */ new Date(),
					durationMs: 0,
					provenance: origin
				};
				collected.set(signal, reading);
				reached.push(reading);
			}
		}
		const rest = reached.filter((reading) => !written.has(reading.id));
		if (options.checkpoint != null && rest.length > 0) await options.checkpoint(rest);
	}
	return collected;
}
/**
* Every signal the collectors in this list need in order to produce the ones asked for.
*
* Looped until it settles rather than resolved in one sweep, because an input can itself be produced
* by a collector with inputs. One pass would satisfy the case in front of us today and quietly fail
* the first two-step chain anyone adds.
*/
function withInputs(needed, collectors) {
	for (let added = true; added;) {
		added = false;
		for (const collector of collectors) {
			if (!collector.signals.some((signal) => needed.has(signal))) continue;
			for (const input of collector.requires ?? []) if (!needed.has(input)) {
				needed.add(input);
				added = true;
			}
		}
	}
	return needed;
}
//#endregion
export { collectSignals, withInputs };
