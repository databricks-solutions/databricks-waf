import { SELF_TAGS, mark } from "./self.js";
//#region server/collect/sql/statements.ts
/** A status the API returns while a statement is still going. */
const PENDING = /* @__PURE__ */ new Set(["PENDING", "RUNNING"]);
/** Ten minutes. See `deadlineMs` for why this is a preference rather than a reading. */
const STATEMENT_DEADLINE_MS = 600 * 1e3;
/**
* An HTTP failure that keeps its status and `Retry-After` for the scheduler to read.
*
* The scheduler decides whether a surface backs off, halves its concurrency or gives
* up, and it decides on the status. A generic Error here would collapse 403 and 429
* into the same thing: one means stop asking, the other means ask again shortly.
*/
var StatementHttpError = class extends Error {
	status;
	retryAfterSeconds;
	constructor(status, message, retryAfterSeconds) {
		super(message);
		this.status = status;
		this.retryAfterSeconds = retryAfterSeconds;
		this.name = "StatementHttpError";
	}
};
/**
* A statement this app stopped waiting for, and cancelled on the warehouse.
*
* Its own class rather than a message, because two things read it and neither should read
* prose: `classify` decides what the scan does about it, and it has to tell this apart from
* the platform timing something out. The difference matters in both directions — this is not
* a throttle, so concurrency should not halve for it, and it is not worth another attempt,
* because the second one costs what the first one did.
*/
var StatementDeadlineError = class extends Error {
	statementId;
	waitedMs;
	cancelled;
	constructor(statementId, waitedMs, cancelled) {
		super(`The statement did not finish within ${Math.round(waitedMs / 1e3)}s, so the scan stopped waiting for it and ${cancelled ? "cancelled it on the warehouse" : "could not confirm it was cancelled on the warehouse"}.`);
		this.statementId = statementId;
		this.waitedMs = waitedMs;
		this.cancelled = cancelled;
		this.name = "StatementDeadlineError";
	}
};
/** A statement that ran and failed, as opposed to one the transport refused. */
var StatementFailedError = class extends Error {
	errorCode;
	constructor(message, errorCode) {
		super(message);
		this.errorCode = errorCode;
		this.name = "StatementFailedError";
	}
};
/**
* The result size past which the warehouse trims the result instead of refusing it.
*
* An `INLINE` result over 25 MiB is aborted: `status.state` comes back `FAILED` and there is no result
* at all, which is how a large estate came to get no serverless analysis rather than a smaller one.
* `byte_limit` changes the failure into a fact — the rows stop and `manifest.truncated` says they were
* stopped — and a fact is something the caller can act on. `sliced.ts` acts on it by re-executing the
* slice as hash buckets; the collector acts on it, for a statement that cannot be sliced, by reporting
* the signal unmeasured rather than presenting a trimmed result as an estate.
*
* Twenty of the twenty-five, not twenty-five: the cap is enforced on the API's internal
* representation, `byte_limit` is documented as measured the same way, and neither is the size of the
* JSON that comes back. A limit set at the cap would be a limit set at approximately the cap, and the
* failure it exists to prevent is what happens when the approximation is high.
*/
const BYTE_LIMIT = 20 * 1024 * 1024;
/**
* The manifest's column types, keyed by column name.
*
* Undefined rather than an empty object when the manifest carries none, so a caller can tell "this
* response did not say" from "this response said nothing is numeric" — the first falls back to
* inference and the second would silently sort every count as text.
*/
function typesOf(manifest) {
	const named = (manifest?.schema?.columns ?? []).flatMap((column) => column.name != null && column.type_name != null ? [[column.name, column.type_name]] : []);
	return named.length > 0 ? Object.fromEntries(named) : void 0;
}
var StatementExecutor = class {
	options;
	doFetch;
	waitSeconds;
	pollIntervalMs;
	deadlineMs;
	constructor(options) {
		this.options = options;
		this.doFetch = options.fetch ?? globalThis.fetch;
		this.waitSeconds = options.waitSeconds ?? 30;
		this.pollIntervalMs = options.pollIntervalMs ?? 1e3;
		this.deadlineMs = options.deadlineMs ?? 6e5;
	}
	/**
	* Runs the statement and resolves to `{ data }` with rows keyed by column name.
	*
	* Named rather than positional because that is what the shape parsers read, and
	* because a positional row silently survives a column being added to the middle of
	* a query while meaning something different afterwards.
	*/
	async query(statement, parameters, signal) {
		const started = Date.now();
		let response = await this.submit(statement, parameters, signal);
		const statementId = response.statement_id;
		while (PENDING.has(response.status?.state ?? "")) {
			if (statementId == null) throw new StatementFailedError("The warehouse reported a pending statement with no id to poll.");
			const waited = Date.now() - started;
			if (waited >= this.deadlineMs) throw new StatementDeadlineError(statementId, waited, await this.cancel(statementId));
			await this.pause(signal, statementId);
			response = await this.get(`/api/2.0/sql/statements/${statementId}`, signal);
		}
		const state = response.status?.state;
		if (state !== "SUCCEEDED") {
			const detail = response.status?.error;
			throw new StatementFailedError(detail?.message ?? `The statement finished in state ${state ?? "UNKNOWN"} without an error message.`, detail?.error_code);
		}
		const columnTypes = typesOf(response.manifest);
		return {
			data: await this.rows(response, signal),
			...statementId != null ? { statementId } : {},
			...columnTypes == null ? {} : { columnTypes },
			...typeof response.manifest?.total_byte_count === "number" ? { bytesRead: response.manifest.total_byte_count } : {},
			...typeof response.manifest?.total_row_count === "number" ? { rowCount: response.manifest.total_row_count } : {},
			...response.manifest?.truncated === true ? { truncated: true } : {}
		};
	}
	async rows(response, signal) {
		const columns = (response.manifest?.schema?.columns ?? []).map((column, index) => column.name ?? `col_${index}`);
		const rows = [];
		let chunk = response.result;
		while (chunk != null) {
			for (const values of chunk.data_array ?? []) {
				const row = {};
				columns.forEach((name, index) => {
					row[name] = values[index] ?? null;
				});
				rows.push(row);
			}
			const next = chunk.next_chunk_internal_link;
			if (next == null) break;
			chunk = (await this.get(next, signal)).result;
		}
		return rows;
	}
	async submit(statement, parameters, signal) {
		return this.call("/api/2.0/sql/statements", signal, {
			method: "POST",
			body: JSON.stringify({
				statement: mark(statement),
				query_tags: SELF_TAGS,
				warehouse_id: this.options.warehouseId,
				disposition: "INLINE",
				format: "JSON_ARRAY",
				byte_limit: BYTE_LIMIT,
				wait_timeout: `${this.waitSeconds}s`,
				on_wait_timeout: "CONTINUE",
				parameters: Object.entries(parameters).map(([name, marker]) => ({
					name,
					value: marker.value,
					type: marker.__sql_type
				}))
			})
		});
	}
	get(path, signal) {
		return this.call(path, signal, { method: "GET" });
	}
	async call(path, signal, init) {
		const token = await this.options.token();
		const response = await this.doFetch(`${this.options.host.replace(/\/+$/, "")}${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json"
			},
			...signal != null ? { signal } : {}
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new StatementHttpError(response.status, `The warehouse refused the request with ${response.status}: ${summarise(body)}`, retryAfter(response));
		}
		return await response.json();
	}
	/**
	* Waits between polls, and cancels the statement if the scan was abandoned.
	*
	* Cancelling matters more than it looks: without it, a cancelled scan leaves its
	* statements running on the customer's warehouse, which is the opposite of what
	* cancelling a scan is for.
	*/
	async pause(signal, statementId) {
		if (signal?.aborted === true) {
			await this.cancel(statementId);
			throw new Error("The scan was cancelled while a statement was still running.");
		}
		await new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			}, this.pollIntervalMs);
			const onAbort = () => {
				clearTimeout(timer);
				this.cancel(statementId);
				reject(/* @__PURE__ */ new Error("The scan was cancelled while a statement was still running."));
			};
			signal?.addEventListener("abort", onAbort, { once: true });
		});
	}
	/**
	* Asks the warehouse to stop, and says whether it accepted.
	*
	* Best effort by design on the cancellation path — the scan is already being torn down, and a
	* failure to cancel is not worth replacing the cancellation error the caller is waiting for. On
	* the deadline path the caller reports what happened to a reader, so the boolean is the
	* difference between "we stopped it" and "we stopped waiting", and only one of those is true
	* when the POST fails.
	*/
	async cancel(statementId) {
		try {
			await this.call(`/api/2.0/sql/statements/${statementId}/cancel`, void 0, { method: "POST" });
			return true;
		} catch {
			return false;
		}
	}
};
function retryAfter(response) {
	const raw = response.headers.get("retry-after");
	if (raw == null) return void 0;
	const seconds = Number(raw);
	return Number.isFinite(seconds) ? seconds : void 0;
}
/** Enough of an error body to act on, without pasting a page of HTML into a finding. */
function summarise(body) {
	const trimmed = body.trim();
	if (trimmed === "") return "no detail was returned";
	try {
		const parsed = JSON.parse(trimmed);
		if (typeof parsed.message === "string") return parsed.message;
	} catch {}
	return trimmed.length > 400 ? `${trimmed.slice(0, 400)}…` : trimmed;
}
//#endregion
export { STATEMENT_DEADLINE_MS, StatementDeadlineError, StatementExecutor, StatementFailedError, StatementHttpError };
