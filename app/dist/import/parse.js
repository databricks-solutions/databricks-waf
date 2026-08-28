/**
* Key names refused wherever they appear.
*
* `__proto__` is the pollution vector. `constructor` and `prototype` are refused with it because the
* exploit chains through them — `constructor.prototype` reaches the same place by a longer route —
* and because no field in this envelope is called any of these, so the cost of refusing them is
* nothing.
*/
const FORBIDDEN_KEYS = [
	"__proto__",
	"constructor",
	"prototype"
];
var UnsafeJsonError = class extends Error {
	reason;
	at;
	constructor(reason, message, at) {
		super(message);
		this.reason = reason;
		this.at = at;
		this.name = "UnsafeJsonError";
	}
};
/**
* JSON data from untrusted text, or an `UnsafeJsonError` saying which rule it broke.
*
* The return type is `unknown` rather than a shape, deliberately: this function establishes that the
* text is safe to have parsed, and nothing at all about what it says. Deciding that is the schema's
* job, and a signature promising otherwise here is how the two get conflated.
*/
function parseUntrusted(text) {
	audit(text);
	let value;
	try {
		value = JSON.parse(text);
	} catch (cause) {
		throw new UnsafeJsonError("not-json", `The file is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
	}
	reject(value, []);
	return value;
}
function audit(text) {
	const stack = [];
	let at = 0;
	while (at < text.length) {
		const char = text[at];
		if (char === "\"") {
			const [word, next] = readString(text, at);
			const frame = stack[stack.length - 1];
			if (frame?.object === true && frame.expectingKey) {
				if (FORBIDDEN_KEYS.includes(word)) throw new UnsafeJsonError("forbidden-key", `The file names a key called "${word}", at character ${String(at)}. No field in an evidence file is called that, and a document that carries one is either not from the collection script or is aimed at whatever reads it next.`, at);
				if (frame.keys.has(word)) throw new UnsafeJsonError("duplicate-key", `The file gives "${word}" twice in the same object, at character ${String(at)}. Which of the two a reader takes is not settled by the JSON specification, so this file would mean different things to different readers and its digest would establish neither.`, at);
				frame.keys.add(word);
				frame.expectingKey = false;
			}
			at = next;
			continue;
		}
		if (char === "{" || char === "[") {
			if (stack.length >= 64) throw new UnsafeJsonError("too-deep", `The file nests more than ${String(64)} levels deep, at character ${String(at)}. An evidence file nests five, and this app cannot digest a document deeper than this one, so reading further would only move the failure somewhere less clear.`, at);
			stack.push({
				object: char === "{",
				keys: /* @__PURE__ */ new Set(),
				expectingKey: char === "{"
			});
			at += 1;
			continue;
		}
		if (char === "}" || char === "]") {
			stack.pop();
			at += 1;
			continue;
		}
		if (char === ",") {
			const frame = stack[stack.length - 1];
			if (frame?.object === true) frame.expectingKey = true;
			at += 1;
			continue;
		}
		at += 1;
	}
}
/**
* The string starting at `from`, and where it ends.
*
* Escapes are stepped over rather than interpreted, with one exception: `\uXXXX` is decoded, because
* `{"\u005f\u005fproto__": 1}` is `{"__proto__": 1}` to `JSON.parse` and would otherwise walk past a
* check written against the literal spelling. That is the whole reason this function decodes
* anything at all.
*/
function readString(text, from) {
	const out = [];
	let at = from + 1;
	while (at < text.length) {
		const char = text[at];
		if (char === "\\") {
			const escape = text[at + 1];
			if (escape === "u") {
				const code = Number.parseInt(text.slice(at + 2, at + 6), 16);
				if (Number.isFinite(code)) out.push(String.fromCharCode(code));
				at += 6;
				continue;
			}
			if (escape != null) out.push(UNESCAPED[escape] ?? escape);
			at += 2;
			continue;
		}
		if (char === "\"") return [out.join(""), at + 1];
		out.push(char ?? "");
		at += 1;
	}
	return [out.join(""), at];
}
const UNESCAPED = {
	b: "\b",
	f: "\f",
	n: "\n",
	r: "\r",
	t: "	"
};
/**
* The same key check, over the parsed value.
*
* Redundant if the scan is correct, which is the point. The scan is a hand-written lexer on the one
* surface where being wrong hands somebody else a foothold, and this pass is nine lines that do not
* depend on it — it asks `Object.keys`, which is the same question `Object.assign` would ask later.
*/
function reject(value, path) {
	if (Array.isArray(value)) {
		value.forEach((item, index) => reject(item, [...path, String(index)]));
		return;
	}
	if (value == null || typeof value !== "object") return;
	for (const key of Object.getOwnPropertyNames(value)) {
		if (FORBIDDEN_KEYS.includes(key)) throw new UnsafeJsonError("forbidden-key", `The parsed file carries a key called "${key}" ${path.length === 0 ? "at the top level" : `under ${path.join(".")}`}. The scan before parsing did not catch it, which is a fault in this app rather than only in the file, and the import is refused on both counts.`);
		reject(value[key], [...path, key]);
	}
}
//#endregion
export { FORBIDDEN_KEYS, UnsafeJsonError, parseUntrusted };
