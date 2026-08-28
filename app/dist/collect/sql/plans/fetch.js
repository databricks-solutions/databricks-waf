//#region server/collect/sql/plans/fetch.ts
/**
* The rung of the ladder this asks for.
*
* `33b` walked five rungs and measured what each returns. The two above this one add
* `include_debug_info` and then `include_json_plans`, and the richest is 110% of the 8 MB ceiling the
* advisor sets on a profile response — so the ladder ends here not because the rungs above carry nothing
* but because they do not fit. This rung came back at 29% of that ceiling on the same statement.
*
* `include_metrics` is not also requested. It is a rung *below* this one rather than an orthogonal flag,
* and the capture in `fixtures/metrics-only.json` is what it returns on its own: `plans_state: EXISTS`
* and no `plans` field at all.
*/
const LADDER_RUNG = "include_plans=true";
/** An HTTP failure that keeps what the scheduler classifies on. Shaped like `StatementHttpError`. */
var PlanHttpError = class extends Error {
	status;
	retryAfterSeconds;
	constructor(status, message, retryAfterSeconds) {
		super(message);
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
		this.name = "PlanHttpError";
	}
};
function retryAfterSeconds(response) {
	const header = response.headers.get("Retry-After");
	if (header == null) return void 0;
	const seconds = Number(header);
	return Number.isFinite(seconds) && seconds >= 0 ? seconds : void 0;
}
function summarise(body) {
	const collapsed = body.replace(/\s+/g, " ").trim();
	return collapsed.length > 200 ? `${collapsed.slice(0, 200)}…` : collapsed;
}
var PlanFetcher = class {
	options;
	doFetch;
	constructor(options) {
		this.options = options;
		this.doFetch = options.fetch ?? globalThis.fetch;
	}
	/**
	* Fetches one statement's plan, returning what the parser can read and throwing what the scheduler
	* must see.
	*
	* The `signal` is the scan's, so a cancelled run stops fetching rather than finishing its queue.
	*/
	async plan(statementId, signal) {
		const token = await this.options.token();
		const url = `${this.options.host.replace(/\/+$/, "")}/api/2.0/sql/history/queries/${encodeURIComponent(statementId)}?${LADDER_RUNG}`;
		const response = await this.doFetch(url, {
			method: "GET",
			headers: { Authorization: `Bearer ${token}` },
			...signal != null ? { signal } : {}
		});
		if (response.status === 404) {
			await response.text().catch(() => "");
			return {
				status: 404,
				body: null
			};
		}
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new PlanHttpError(response.status, `The query history service refused the plan request with ${String(response.status)}: ${summarise(body)}`, retryAfterSeconds(response));
		}
		const text = await response.text();
		try {
			return {
				status: response.status,
				body: JSON.parse(text)
			};
		} catch {
			return {
				status: response.status,
				body: null
			};
		}
	}
};
//#endregion
export { PlanFetcher, PlanHttpError };
