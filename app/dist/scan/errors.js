//#region server/scan/errors.ts
const RETRYABLE = [
	"rate-limited",
	"timeout",
	"transient"
];
/**
* Whether the control this task was collecting should degrade rather than fail the
* scan. A permission denial says something true about the estate as this identity
* sees it, so it is data, not breakage.
*/
function isDegradation(kind) {
	return kind === "permission-denied" || kind === "not-found";
}
/**
* Read `Retry-After`, which is specified as either a number of seconds or an
* HTTP-date, and is sent in both forms in practice.
*
* Returns undefined rather than a default for anything unparseable. A wrong delay
* is worse than no delay, because the caller's own backoff is at least
* deliberately chosen.
*/
function parseRetryAfter(value, now = Date.now()) {
	if (value == null) return void 0;
	const trimmed = value.trim();
	if (trimmed === "") return void 0;
	if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1e3;
	const asDate = Date.parse(trimmed);
	if (!Number.isNaN(asDate)) return Math.max(0, asDate - now);
}
function headerOf(error, name) {
	const headers = error?.headers;
	if (headers == null) return void 0;
	if (typeof headers.get === "function") return headers.get(name) ?? void 0;
	const record = headers;
	const hit = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
	return hit == null ? void 0 : String(record[hit]);
}
/**
* How long the server asked us to wait, from whichever shape the thrower used.
*
* Three shapes because three throwers. The SDKs and fetch attach the raw response
* headers; the statement executor has already read the header and keeps it as seconds,
* because it discards the response once it has an error to throw. Reading only headers
* would silently ignore a `Retry-After` the app had already parsed, and the scan would
* back off on its own jittered guess instead of the interval the warehouse named.
*/
function retryAfterOf(error, now) {
	const e = error;
	if (typeof e?.retryAfterMs === "number" && Number.isFinite(e.retryAfterMs)) return e.retryAfterMs;
	if (typeof e?.retryAfterSeconds === "number" && Number.isFinite(e.retryAfterSeconds)) return e.retryAfterSeconds * 1e3;
	return parseRetryAfter(headerOf(error, "retry-after"), now);
}
function statusOf(error) {
	const e = error;
	for (const candidate of [
		e?.status,
		e?.statusCode,
		e?.response?.status
	]) if (typeof candidate === "number") return candidate;
}
/**
* Classify by status code first and message text only as a fallback.
*
* Message matching is here because it has to be — a Node socket timeout arrives as
* a bare `ETIMEDOUT` with no status, and the SQL execution API reports permission
* failures in the statement result rather than as an HTTP error. But it is
* checked second, so a server that says 429 is believed over a message that
* happens to contain the word "limit".
*/
function classify(error, now = Date.now()) {
	if (error?.name === "StatementDeadlineError") return {
		kind: "deadline",
		message: error instanceof Error ? error.message : String(error)
	};
	const status = statusOf(error);
	const message = error instanceof Error ? error.message : String(error);
	const retryAfterMs = retryAfterOf(error, now);
	if (status === 429) return {
		kind: "rate-limited",
		retryAfterMs,
		status,
		message
	};
	if (status === 403 || status === 401) return {
		kind: "permission-denied",
		status,
		message
	};
	if (status === 404) return {
		kind: "not-found",
		status,
		message
	};
	if (status === 408 || status === 504) return {
		kind: "timeout",
		retryAfterMs,
		status,
		message
	};
	if (status === 503) return {
		kind: "rate-limited",
		retryAfterMs,
		status,
		message
	};
	if (status != null && status >= 500) return {
		kind: "transient",
		retryAfterMs,
		status,
		message
	};
	if (status != null && status >= 400) return {
		kind: "fatal",
		status,
		message
	};
	const lower = message.toLowerCase();
	const rawCode = error?.code;
	const code = typeof rawCode === "string" ? rawCode : "";
	if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT" || lower.includes("timed out") || lower.includes("timeout")) return {
		kind: "timeout",
		retryAfterMs,
		message
	};
	if (lower.includes("too many requests") || lower.includes("rate limit") || lower.includes("throttl")) return {
		kind: "rate-limited",
		retryAfterMs,
		message
	};
	if (lower.includes("permission_denied") || lower.includes("does not have") || lower.includes("access denied")) return {
		kind: "permission-denied",
		message
	};
	if (code === "ECONNRESET" || code === "ECONNREFUSED" || code === "EAI_AGAIN" || code === "ENOTFOUND") return {
		kind: "transient",
		message
	};
	return {
		kind: "fatal",
		message
	};
}
//#endregion
export { RETRYABLE, classify, isDegradation, parseRetryAfter };
