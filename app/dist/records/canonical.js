//#region server/records/canonical.ts
/**
* The canonical bytes of a JSON document, as a string.
*
* Input is JSON data: the result of `JSON.parse`, or an object built to be serialised. Anything
* that is not — a `Map`, a class instance with behaviour, a `bigint` — is refused rather than
* quietly rendered as `{}`, which is the failure this app has already had once elsewhere (see the
* dropped signal values in `codec.ts`).
*/
function canonicalise(value) {
	const out = [];
	write(value, out, 0);
	return out.join("");
}
/** UTF-8 bytes of the canonical form, which is what a digest is computed over. */
function canonicalBytes(value) {
	return Buffer.from(canonicalise(value), "utf8");
}
/**
* How deep a document may nest.
*
* The recursion is bounded so a cyclic or pathological structure fails with a sentence instead of
* `RangeError: Maximum call stack size exceeded` from somewhere inside a hash. A scan nests about
* eight levels; evidence tables and their rows are the deepest part.
*/
const MAX_DEPTH = 64;
function write(value, out, depth) {
	if (depth > MAX_DEPTH) throw new CanonicalisationError(`a document nested more than ${String(MAX_DEPTH)} levels deep`);
	if (value === null) {
		out.push("null");
		return;
	}
	switch (typeof value) {
		case "boolean":
			out.push(value ? "true" : "false");
			return;
		case "number":
			out.push(number(value));
			return;
		case "string":
			out.push(JSON.stringify(value));
			return;
		case "object":
			writeObject(value, out, depth);
			return;
		default: throw new CanonicalisationError(`a ${typeof value} where JSON data was expected`);
	}
}
function writeObject(value, out, depth) {
	const custom = value.toJSON;
	if (typeof custom === "function") {
		write(custom.call(value), out, depth + 1);
		return;
	}
	if (Array.isArray(value)) {
		out.push("[");
		for (const [at, element] of value.entries()) {
			if (at > 0) out.push(",");
			write(absent(element) ? null : element, out, depth + 1);
		}
		out.push("]");
		return;
	}
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) {
		const name = value.constructor?.name;
		throw new CanonicalisationError(`a ${name ?? "non-plain object"}, which is not JSON data`);
	}
	const object = value;
	out.push("{");
	let first = true;
	for (const key of Object.keys(object).sort()) {
		const property = object[key];
		if (absent(property)) continue;
		if (!first) out.push(",");
		first = false;
		out.push(JSON.stringify(key), ":");
		write(property, out, depth + 1);
	}
	out.push("}");
}
/**
* A number as RFC 8785 wants it, which is as ECMAScript prints it.
*
* `String` gives that directly for every finite double, including the exponent forms for very large
* and very small magnitudes. Two cases are called out because they are the ones that would
* otherwise differ between a document and itself: `-0` prints as `0`, which is deliberate — JSON
* has no signed zero and a digest that depended on one would flip when a value went through
* arithmetic that normalised it. And the non-finite values are refused rather than written as
* `null`, which is what `JSON.stringify` does: a NaN in a score is a bug worth a stack trace, not a
* hole worth hashing.
*/
function number(value) {
	if (!Number.isFinite(value)) throw new CanonicalisationError(`${String(value)}, which JSON cannot represent`);
	return Object.is(value, -0) ? "0" : String(value);
}
/** What `JSON.stringify` leaves out of an object entirely. */
function absent(value) {
	return value === void 0 || typeof value === "function" || typeof value === "symbol";
}
var CanonicalisationError = class extends Error {
	constructor(what) {
		super(`This record cannot be given a digest because it contains ${what}.`);
		this.name = "CanonicalisationError";
	}
};
//#endregion
export { CanonicalisationError, canonicalBytes, canonicalise };
