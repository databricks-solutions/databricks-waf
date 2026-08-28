//#region server/import/read.ts
/**
* The largest evidence file this endpoint will read.
*
* Sized against the envelope rather than guessed. The script's 29 probes project a few fields each,
* and the two that scale with the estate are the cluster and job inventories: a thousand clusters at
* six projected fields is about 150KB, so a large estate lands in the low megabytes and this leaves
* several times that. It is deliberately not generous beyond that — the file is a projection, and one
* arriving at fifty megabytes is not a large estate, it is not this script's output.
*/
const MAX_BYTES = 8 * 1024 * 1024;
/** What the caller must send, so the framework's JSON parser leaves the stream alone. */
const REQUIRED_CONTENT_TYPE = "application/octet-stream";
var UnreadableBodyError = class extends Error {
	reason;
	constructor(reason, message) {
		super(message);
		this.reason = reason;
		this.name = "UnreadableBodyError";
	}
};
/**
* One header's value, or undefined.
*
* A header can arrive repeated, in which case Node hands over an array. Taking the first is the same
* choice Express makes for everything except `set-cookie`; what matters here is that a repeated
* `Content-Type` cannot slip past the check below by making the comparison happen against an array.
*/
function header(request, name) {
	const value = request.headers[name];
	return typeof value === "string" ? value : value?.[0];
}
/**
* The request body as text, or an `UnreadableBodyError` saying why not.
*
* `limit` is a parameter rather than a constant read from module scope so a test can drive the cap
* with eight bytes instead of eight megabytes. It defaults to the real one, so a caller cannot get an
* uncapped read by omitting it.
*/
async function readUploaded(request, limit = MAX_BYTES) {
	const declared = header(request, "content-type")?.split(";")[0]?.trim().toLowerCase();
	if (declared !== "application/octet-stream") throw new UnreadableBodyError("wrong-content-type", `Send the file as ${REQUIRED_CONTENT_TYPE}, not ${declared == null || declared === "" ? "an unstated type" : declared}. This endpoint reads the body as bytes so it can apply its own size limit and its own parse rules, and a body declared as JSON is parsed by the framework before either can run.`);
	if (request.body != null && typeof request.body === "object" && Object.keys(request.body).length > 0) throw new UnreadableBodyError("already-parsed", `The request body had already been parsed before this route read it, so it could not be capped or checked as text. That is a fault in how this app is assembled rather than in the upload: the route expects a ${REQUIRED_CONTENT_TYPE} body that no middleware claims.`);
	const claimed = Number(header(request, "content-length"));
	if (Number.isFinite(claimed) && claimed > limit) throw new UnreadableBodyError("too-large", `The upload declares ${describe(claimed)}, and this endpoint reads at most ${describe(limit)}. ` + tooLarge());
	const chunks = [];
	let read = 0;
	try {
		for await (const chunk of request) {
			const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
			read += bytes.length;
			if (read > limit) throw new UnreadableBodyError("too-large", `The upload passed ${describe(limit)} while being read${Number.isFinite(claimed) ? `, having declared ${describe(claimed)}` : ""}. ${tooLarge()}`);
			chunks.push(bytes);
		}
	} catch (cause) {
		if (cause instanceof UnreadableBodyError) throw cause;
		throw new UnreadableBodyError("read-failed", `The upload stopped partway: ${cause instanceof Error ? cause.message : String(cause)}. Nothing was imported, so retrying is safe.`);
	}
	try {
		return strip(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
	} catch {
		throw new UnreadableBodyError("not-utf8", "The upload is not valid UTF-8. The collection script writes UTF-8, so this file has been re-encoded somewhere between there and here — which also means its digest can no longer establish anything about it. Send the file the script wrote.");
	}
}
/**
* A leading byte-order mark, removed.
*
* Not laxity for its own sake: `Set-Content` and several Windows editors add one, `JSON.parse` fails
* on it with "Unexpected token", and a mark before the first brace changes nothing about what the
* document says. Anywhere other than the front it is left alone, because there it is content.
*/
function strip(text) {
	return text.startsWith("﻿") ? text.slice(1) : text;
}
function tooLarge() {
	return "An evidence file is a projection of a handful of fields per probe, so one this size is either not the script’s output or comes from an estate larger than a single unpaged call describes. Re-run the script and send the file it writes.";
}
function describe(bytes) {
	if (bytes < 1024) return `${String(bytes)} bytes`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
//#endregion
export { MAX_BYTES, REQUIRED_CONTENT_TYPE, UnreadableBodyError, readUploaded };
