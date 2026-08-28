// One document, one sequence of bytes.
//
// A digest is only worth recording if the same record hashes to the same value every time, and
// `JSON.stringify` does not promise that. It emits keys in insertion order, so a scan written by
// this build and the same scan read back out of Lakebase hash differently for a reason that has
// nothing to do with anybody editing it: `jsonb` does not store bytes, it stores a parsed document,
// and it hands back the keys in its own order. Without a canonical form the verification in
// `verify.ts` would report every row as altered on the first read.
//
// So this is the format the digest is over, and it is RFC 8785 (JSON Canonicalisation Scheme)
// rather than one invented here. That matters for the property the plan actually asks for —
// somebody outside this app being able to check an artefact it produced. A recipient can reach for
// a JCS library in whatever language they audit in; they cannot reach for ours.
//
// What follows RFC 8785 and why it is spelled out rather than assumed:
//
//   Object keys sort by UTF-16 code unit, which is what `Array.prototype.sort` on strings already
//   does, and is not the same as sorting by code point for characters outside the BMP. Ours are
//   ASCII field names, but the rule is the format's, not ours to relax.
//
//   Numbers serialise as ECMAScript does, which `String(number)` gives directly. It is worth being
//   clear that this is lossy in one direction that cannot be recovered here: an integer beyond 2^53
//   arrives from `JSON.parse` already rounded, so the digest covers the rounded value. Nothing in a
//   scan carries such a number, and if something ever does, the fix is a string in the document,
//   not a change of format.
//
//   No insignificant whitespace, and strings escaped minimally — which `JSON.stringify` of a single
//   string already does correctly, including surrogate pairs and the control characters that have
//   short forms.

/**
 * The canonical bytes of a JSON document, as a string.
 *
 * Input is JSON data: the result of `JSON.parse`, or an object built to be serialised. Anything
 * that is not — a `Map`, a class instance with behaviour, a `bigint` — is refused rather than
 * quietly rendered as `{}`, which is the failure this app has already had once elsewhere (see the
 * dropped signal values in `codec.ts`).
 */
export function canonicalise(value: unknown): string {
  const out: string[] = [];
  write(value, out, 0);
  return out.join('');
}

/** UTF-8 bytes of the canonical form, which is what a digest is computed over. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalise(value), 'utf8');
}

/**
 * How deep a document may nest.
 *
 * The recursion is bounded so a cyclic or pathological structure fails with a sentence instead of
 * `RangeError: Maximum call stack size exceeded` from somewhere inside a hash. A scan nests about
 * eight levels; evidence tables and their rows are the deepest part.
 */
const MAX_DEPTH = 64;

function write(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_DEPTH) {
    throw new CanonicalisationError(`a document nested more than ${String(MAX_DEPTH)} levels deep`);
  }

  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number':
      out.push(number(value));
      return;
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'object':
      writeObject(value, out, depth);
      return;
    default:
      // `undefined`, `function`, `symbol` and `bigint`. The first three are what `JSON.stringify`
      // drops from an object and turns into `null` in an array; both of those sites handle them
      // before recursing, so reaching here means one was the whole document.
      throw new CanonicalisationError(`a ${typeof value} where JSON data was expected`);
  }
}

function writeObject(value: object, out: string[], depth: number): void {
  // `toJSON` first, because `Date` has one and a scan is full of dates. The write path canonicalises
  // the text the codec produced, where they are already strings, but a caller hashing a domain
  // object directly would otherwise get `{}` for every timestamp — so this removes a way to be
  // silently wrong rather than serving a case this app has today.
  const custom = (value as { toJSON?: unknown }).toJSON;
  if (typeof custom === 'function') {
    write((custom as () => unknown).call(value), out, depth + 1);
    return;
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (const [at, element] of value.entries()) {
      if (at > 0) out.push(',');
      // Matching `JSON.stringify`: an array is positional, so a hole cannot be dropped without
      // shifting everything after it, and `null` is what JSON has to say instead.
      write(absent(element) ? null : element, out, depth + 1);
    }
    out.push(']');
    return;
  }

  // Everything object-shaped that is not a plain object is refused. A `Map` is the case that
  // matters — one probe in this app answers with one — and `JSON.stringify` renders it as `{}`
  // without complaint, which is exactly the kind of empty document that would hash consistently
  // and mean nothing.
  const prototype = Object.getPrototypeOf(value) as unknown;
  if (prototype !== Object.prototype && prototype !== null) {
    const name = (value as { constructor?: { name?: string } }).constructor?.name;
    throw new CanonicalisationError(`a ${name ?? 'non-plain object'}, which is not JSON data`);
  }

  const object = value as Record<string, unknown>;
  out.push('{');
  let first = true;
  // Sorted here rather than by the caller, which is the whole point: two documents that differ only
  // in the order their keys were assigned have to produce the same bytes.
  for (const key of Object.keys(object).sort()) {
    const property = object[key];
    if (absent(property)) continue;
    if (!first) out.push(',');
    first = false;
    out.push(JSON.stringify(key), ':');
    write(property, out, depth + 1);
  }
  out.push('}');
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
function number(value: number): string {
  if (!Number.isFinite(value)) {
    throw new CanonicalisationError(`${String(value)}, which JSON cannot represent`);
  }
  return Object.is(value, -0) ? '0' : String(value);
}

/** What `JSON.stringify` leaves out of an object entirely. */
function absent(value: unknown): boolean {
  return value === undefined || typeof value === 'function' || typeof value === 'symbol';
}

export class CanonicalisationError extends Error {
  constructor(what: string) {
    super(`This record cannot be given a digest because it contains ${what}.`);
    this.name = 'CanonicalisationError';
  }
}
