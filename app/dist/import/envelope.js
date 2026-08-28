//#region server/import/envelope.ts
/** The one schema this app reads. A version it does not know is refused rather than guessed at. */
const SCHEMA = "waf-admin-evidence/1";
/** Longest a single string field may be. Generous against the longest real one — a 900-char detail. */
const MAX_STRING = 4e3;
var MalformedEnvelopeError = class extends Error {
	reason;
	at;
	constructor(reason, message, at) {
		super(message);
		this.reason = reason;
		this.at = at;
		this.name = "MalformedEnvelopeError";
	}
};
const STATUSES = [
	"observed",
	"denied",
	"error",
	"skipped"
];
function fail(reason, message, at) {
	throw new MalformedEnvelopeError(reason, message, at);
}
function object(value, at) {
	if (value == null || typeof value !== "object" || Array.isArray(value)) fail("bad-field", `${at} must be an object.`, at);
	return value;
}
function text(holder, key, at) {
	const value = holder[key];
	if (typeof value !== "string") fail("bad-field", `${at} must be a string.`, at);
	if (value === "") fail("bad-field", `${at} must not be empty.`, at);
	if (value.length > 4e3) fail("bad-field", `${at} is ${String(value.length)} characters, over the ${String(MAX_STRING)} allowed.`, at);
	return value;
}
function optionalText(holder, key, at) {
	return key in holder && holder[key] !== null ? text(holder, key, at) : void 0;
}
function flag(holder, key, at) {
	const value = holder[key];
	if (typeof value !== "boolean") fail("bad-field", `${at} must be true or false.`, at);
	return value;
}
function list(holder, key, at, limit) {
	const value = holder[key];
	if (!Array.isArray(value)) fail("bad-field", `${at} must be an array.`, at);
	if (value.length > limit) fail("bad-field", `${at} holds ${String(value.length)} entries, over the ${String(limit)} allowed.`, at);
	return value;
}
/** An array of non-empty strings, which is what every identifier list in here is. */
function names(holder, key, at) {
	return list(holder, key, at, 500).map((entry, index) => {
		if (typeof entry !== "string" || entry === "" || entry.length > 4e3) fail("bad-field", `${at}[${String(index)}] must be a non-empty string.`, `${at}[${String(index)}]`);
		return entry;
	});
}
/**
* A timestamp the script wrote, refused unless it is the form the script writes.
*
* Strict rather than `new Date(value)` because that accepts almost anything and invents a value for
* much of it: `new Date('30 days ago')` is Invalid Date, but `new Date('2026')` is a real instant, and
* a freshness window built on it would be measuring from January.
*/
function instant(holder, key, at) {
	const value = text(holder, key, at);
	if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(value)) fail("bad-field", `${at} must be a UTC timestamp of the form 2026-08-03T10:41:52Z.`, at);
	const parsed = new Date(value);
	if (Number.isNaN(parsed.getTime()) || parsed.toISOString().replace(".000Z", "Z") !== value) fail("bad-field", `${at} is not a real instant.`, at);
	return value;
}
/** A `sha256:` digest, refused unless it is one — a truncated digest must not compare equal to itself. */
function digestOf(holder, key, at) {
	const value = text(holder, key, at);
	if (!/^sha256:[0-9a-f]{64}$/.test(value)) fail("bad-field", `${at} must be sha256: followed by 64 lowercase hex characters.`, at);
	return value;
}
function identityFrom(value, at) {
	const held = object(value, at);
	return {
		username: optionalText(held, "username", `${at}.username`),
		host: text(held, "host", `${at}.host`),
		accountId: optionalText(held, "account_id", `${at}.account_id`),
		workspaceId: optionalText(held, "workspace_id", `${at}.workspace_id`),
		authType: optionalText(held, "auth_type", `${at}.auth_type`),
		profile: optionalText(held, "profile", `${at}.profile`),
		read: optionalText(held, "read", `${at}.read`)
	};
}
function tierFrom(value, at) {
	const held = object(value, at);
	const ran = flag(held, "ran", `${at}.ran`);
	const identity = "identity" in held ? identityFrom(held.identity, `${at}.identity`) : void 0;
	if (ran && identity == null) fail("inconsistent", `${at} says it ran but carries no identity, so nothing can be held against it.`, at);
	if (!ran && identity != null) fail("inconsistent", `${at} says it did not run yet carries an identity.`, at);
	return {
		ran,
		identity,
		reason: optionalText(held, "reason", `${at}.reason`)
	};
}
function probeFrom(value, index) {
	const at = `probes[${String(index)}]`;
	const held = object(value, at);
	const tier = text(held, "tier", `${at}.tier`);
	if (tier !== "workspace" && tier !== "account") fail("bad-field", `${at}.tier must be workspace or account.`, `${at}.tier`);
	const status = text(held, "status", `${at}.status`);
	if (!STATUSES.includes(status)) fail("bad-field", `${at}.status must be one of ${STATUSES.join(", ")}.`, `${at}.status`);
	const shape = text(held, "shape", `${at}.shape`);
	if (shape !== "projected" && shape !== "shallow") fail("bad-field", `${at}.shape must be projected or shallow.`, `${at}.shape`);
	const observed = status === "observed";
	if (observed && !("value" in held)) fail("inconsistent", `${at} is observed but carries no value.`, at);
	if (!observed && "value" in held) fail("inconsistent", `${at} is ${status} yet carries a value.`, at);
	return {
		signals: names(held, "signals", `${at}.signals`),
		tier,
		label: text(held, "label", `${at}.label`),
		endpoint: text(held, "endpoint", `${at}.endpoint`),
		controls: names(held, "controls", `${at}.controls`),
		fields: names(held, "fields", `${at}.fields`),
		shape,
		status,
		...observed ? { value: held.value } : {},
		detail: optionalText(held, "detail", `${at}.detail`),
		..."truncated" in held ? { truncated: flag(held, "truncated", `${at}.truncated`) } : {}
	};
}
function deferredFrom(value, index) {
	const at = `deferred[${String(index)}]`;
	const held = object(value, at);
	return {
		signal: text(held, "signal", `${at}.signal`),
		reason: text(held, "reason", `${at}.reason`)
	};
}
/**
* An `Envelope`, or a `MalformedEnvelopeError` naming the field that stopped it.
*
* Takes the already-parsed value rather than text, so that being safe to parse and being an envelope
* stay two separate claims with two separate failures.
*/
function envelopeFrom(value) {
	const held = object(value, "the file");
	const schema = text(held, "schema", "schema");
	if (schema !== "waf-admin-evidence/1") fail("unknown-schema", `This app reads ${SCHEMA} and the file says ${schema}.`, "schema");
	const tiers = object(held.tiers, "tiers");
	const probes = list(held, "probes", "probes", 500).map(probeFrom);
	if (probes.length === 0) fail("inconsistent", "The file carries no probes, so there is nothing to import.", "probes");
	return {
		schema: SCHEMA,
		generatedAt: instant(held, "generated_at", "generated_at"),
		script: {
			name: text(object(held.script, "script"), "name", "script.name"),
			version: text(object(held.script, "script"), "version", "script.version"),
			digest: digestOf(object(held.script, "script"), "digest", "script.digest")
		},
		cli: { version: text(object(held.cli, "cli"), "version", "cli.version") },
		tiers: {
			workspace: tierFrom(tiers.workspace, "tiers.workspace"),
			account: tierFrom(tiers.account, "tiers.account")
		},
		probes,
		deferred: list(held, "deferred", "deferred", 100).map(deferredFrom),
		digest: digestOf(held, "digest", "digest")
	};
}
//#endregion
export { MAX_STRING, MalformedEnvelopeError, SCHEMA, envelopeFrom };
