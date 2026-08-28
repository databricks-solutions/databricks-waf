import { COMPLETE, observed, unmeasurable } from "../signal.js";
import { PROBES } from "./probes.js";
//#region server/collect/rest/collector.ts
const REST_SIGNALS = PROBES.map((probe) => probe.id);
var RestCollector = class {
	options;
	surface = "rest";
	name = "control-plane";
	signals = REST_SIGNALS;
	pageLimit;
	calls = 0;
	constructor(options) {
		this.options = options;
		this.pageLimit = options.pageLimit ?? 1e3;
	}
	spent() {
		return {
			surface: this.surface,
			name: this.name,
			calls: this.calls
		};
	}
	async collect(ids, context) {
		const results = [];
		for (const id of ids) {
			if (context.collected.has(id)) continue;
			const probe = PROBES.find((candidate) => candidate.id === id);
			const result = probe == null ? unmeasurable(id, `No REST probe is implemented for ${id}.`) : await this.runProbe(probe, context);
			results.push(result);
			await context.settled?.(result);
		}
		return results;
	}
	async runProbe(probe, context) {
		const started = Date.now();
		const outcome = await context.scheduler.run({
			surface: "rest",
			label: `rest:${probe.label}`,
			run: async () => {
				const client = await this.options.client();
				this.calls += 1;
				return probe.run(client, { pageLimit: this.pageLimit });
			}
		});
		if (outcome.status === "ok") return observed(probe.id, outcome.value, Date.now() - started, {
			...COMPLETE,
			reach: REST_REACH
		});
		if (outcome.status === "skipped") return unmeasurable(probe.id, skipReason(probe, outcome.reason, outcome.detail), {
			...COMPLETE,
			reach: REST_REACH
		});
		return unmeasurable(probe.id, failureReason(probe, outcome.failure.kind, outcome.failure.message), {
			...COMPLETE,
			reach: REST_REACH
		});
	}
};
/**
* Every REST probe is workspace-reach, and this is not a simplification.
*
* Measured under ADR 0015: a workspace token is rejected by another workspace's control
* plane outright, so unlike the system tables — which answer for the whole account from
* one install — these endpoints describe the workspace the app is installed in and
* nothing else. An account with eleven workspaces needs eleven installs to have these
* eleven answers.
*/
const REST_REACH = "workspace";
function skipReason(probe, reason, detail) {
	if (reason === "permission-denied" || reason === "not-found") return failureReason(probe, reason, detail);
	if (reason === "budget-exhausted") return `${probe.what} was not read because the scan reached its limit on control-plane calls. ${detail}`;
	return `${probe.what} was not read: ${detail}`;
}
/**
* The reason a probe did not answer, in terms of what the reader can do about it.
*
* The scope case is separated because it is the one the reader cannot act on from inside
* the workspace: no amount of granting the user admin will help if the app never
* requested authority over that API. Naming the scope turns it from a dead end into a
* line in an issue report.
*/
function failureReason(probe, kind, message) {
	if (kind === "not-found") return `${probe.what} is not available in this workspace. The endpoint answered that it does not exist, which usually means the feature is not offered on this cloud or tier. Reported as unmeasured rather than as a failure, since a setting that cannot exist cannot be misconfigured. (${message})`;
	if (kind === "permission-denied") {
		if (looksLikeScope(message)) {
			const preamble = `${probe.what} was refused for want of an authorization scope, not for want of permission. This call needs the "${probe.scope}" scope, and the token the app is given does not carry it. Granting the identity this scan ran as more permission will not change that.`;
			return probe.grantable ? `${preamble} The scope can be requested, so this is fixable: the app has to declare it and be redeployed, and each user re-authorises the app the first time the wider set is asked for. (${message})` : `${preamble} And it cannot be fixed from here: Databricks Apps does not offer "${probe.scope}" as a scope an app may request, so no install of this app can read it as the calling identity. Reading it as the app's own identity instead would show you an estate you may not have the right to see, which is why the app does not. Until the platform offers the scope, this control is answered by attestation rather than by measurement. (${message})`;
		}
		return `${probe.what} was refused: the identity this scan ran as may not read it. Most control-plane settings are workspace-admin only. This is reported as unmeasured rather than as a failure, because not being allowed to look is not evidence of a problem. (${message})`;
	}
	return `${probe.what} could not be read: ${message}`;
}
/**
* Whether a refusal was about scopes rather than about the user.
*
* Text matching, which is fragile, and the fragility is bounded on purpose: a wrong
* guess here changes only which of two sentences a reader sees, never whether the
* control degrades. Both paths already report unmeasurable.
*/
function looksLikeScope(message) {
	const lower = message.toLowerCase();
	return lower.includes("scope") || lower.includes("not authorized to access this api") || lower.includes("insufficient_scope");
}
//#endregion
export { REST_SIGNALS, RestCollector };
