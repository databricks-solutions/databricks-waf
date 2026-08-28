// Turning somebody's file into JSON data, without trusting it first.
//
// This is the most exposed surface in the app. Everything else it reads is either a system table it
// queried or a form field it defined; this is a file, produced somewhere else, that becomes findings
// and then a score. `JSON.parse` alone is not enough for it, for three reasons that are separate and
// each have a test below.
//
// DEPTH. `JSON.parse` recurses, so a few thousand open brackets is a `RangeError` from inside V8 —
// which is catchable, but it is a stack overflow reported as a parse failure, and the honest version
// says how deep is too deep before trying. Sixty-four levels is the same bound `canonicalise` uses,
// and an envelope from the script nests five.
//
// DUPLICATE KEYS. `JSON.parse` takes the last of `{"a":1,"a":2}` and says nothing. Python's `json`
// does the same; Go's `encoding/json` does too; some parsers take the first, and a few refuse. That
// disagreement is the problem, not the ambiguity: the digest in the envelope is computed over the
// document as *its* reader understood it, and an admin auditing the same file in another language is
// entitled to reach the same conclusion this app did. A file that two conforming parsers read
// differently is a file whose digest means nothing, so it is refused rather than resolved.
//
// DANGEROUS KEYS. `JSON.parse` is not itself a prototype-pollution vector — a `__proto__` key
// becomes an ordinary own property rather than invoking the setter. The exposure is what happens to
// the parsed value afterwards: one `Object.assign`, one spread into an options object, one `merge`
// helper added a year from now, and the own property becomes a prototype write. So the key names are
// refused at the door, where the rule is one line and does not depend on every later reader
// remembering it.
//
// The scan is a lexer, not a parser: it walks the text once, tracking nesting and the keys seen at
// each level, and answers those three questions without building a value. `JSON.parse` then does the
// actual parsing, and a second pass over the result re-checks the key names — the same question
// asked twice, on purpose, because the first asker is hand-written code on the one surface where a
// bug in it is somebody else's foothold rather than our inconvenience.

/**
 * How deep a document may nest.
 *
 * The same bound as `records/canonical.ts`, and for a related reason: a document this app cannot
 * canonicalise is one it cannot digest, so accepting something deeper here would only defer the
 * failure to a worse place.
 */
export const MAX_DEPTH = 64;

/**
 * Key names refused wherever they appear.
 *
 * `__proto__` is the pollution vector. `constructor` and `prototype` are refused with it because the
 * exploit chains through them — `constructor.prototype` reaches the same place by a longer route —
 * and because no field in this envelope is called any of these, so the cost of refusing them is
 * nothing.
 */
export const FORBIDDEN_KEYS: readonly string[] = ['__proto__', 'constructor', 'prototype'];

/** Why a document was refused, as something a route can turn into a sentence. */
export type UnsafeReason = 'not-json' | 'too-deep' | 'duplicate-key' | 'forbidden-key';

export class UnsafeJsonError extends Error {
  constructor(
    readonly reason: UnsafeReason,
    message: string,
    /** Byte offset in the text, when the scan knows one. Named so a caller can quote the place. */
    readonly at?: number
  ) {
    super(message);
    this.name = 'UnsafeJsonError';
  }
}

/**
 * JSON data from untrusted text, or an `UnsafeJsonError` saying which rule it broke.
 *
 * The return type is `unknown` rather than a shape, deliberately: this function establishes that the
 * text is safe to have parsed, and nothing at all about what it says. Deciding that is the schema's
 * job, and a signature promising otherwise here is how the two get conflated.
 */
export function parseUntrusted(text: string): unknown {
  audit(text);

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    // The scan above passes plenty of text `JSON.parse` will reject, because it checks nesting and
    // key names rather than grammar. That division is intended: a lexer that also validated the
    // grammar would be a second JSON parser to keep correct, and being wrong about a trailing comma
    // is not a security property.
    throw new UnsafeJsonError('not-json', `The file is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
  }

  reject(value, []);
  return value;
}

// ---------------------------------------------------------------------------------------------
// The scan
// ---------------------------------------------------------------------------------------------

/**
 * Where the lexer is, which is all it needs to know to tell a key from a value.
 *
 * A string in JSON is a key when it appears in an object where the previous significant character
 * was `{` or `,`. That is the whole grammar this needs: everything else is a value, and values are
 * only interesting here for the brackets they open.
 */
interface Frame {
  readonly object: boolean;
  /** Keys already seen in this object, so a repeat is detectable at the point it repeats. */
  readonly keys: Set<string>;
  /** Whether the next string token is a key rather than a value. */
  expectingKey: boolean;
}

function audit(text: string): void {
  const stack: Frame[] = [];
  let at = 0;

  while (at < text.length) {
    const char = text[at];

    if (char === '"') {
      const [word, next] = readString(text, at);
      const frame = stack[stack.length - 1];
      if (frame?.object === true && frame.expectingKey) {
        if (FORBIDDEN_KEYS.includes(word)) {
          throw new UnsafeJsonError(
            'forbidden-key',
            `The file names a key called "${word}", at character ${String(at)}. No field in an ` +
              'evidence file is called that, and a document that carries one is either not from the ' +
              'collection script or is aimed at whatever reads it next.',
            at
          );
        }
        if (frame.keys.has(word)) {
          throw new UnsafeJsonError(
            'duplicate-key',
            `The file gives "${word}" twice in the same object, at character ${String(at)}. Which of ` +
              'the two a reader takes is not settled by the JSON specification, so this file would ' +
              'mean different things to different readers and its digest would establish neither.',
            at
          );
        }
        frame.keys.add(word);
        frame.expectingKey = false;
      }
      at = next;
      continue;
    }

    if (char === '{' || char === '[') {
      if (stack.length >= MAX_DEPTH) {
        throw new UnsafeJsonError(
          'too-deep',
          `The file nests more than ${String(MAX_DEPTH)} levels deep, at character ${String(at)}. An ` +
            'evidence file nests five, and this app cannot digest a document deeper than this one, so ' +
            'reading further would only move the failure somewhere less clear.',
          at
        );
      }
      stack.push({ object: char === '{', keys: new Set(), expectingKey: char === '{' });
      at += 1;
      continue;
    }

    if (char === '}' || char === ']') {
      // A mismatched bracket is left to `JSON.parse`, which reports it precisely. Popping on either
      // keeps the lexer's depth honest for the text that is valid, which is the case that matters.
      stack.pop();
      at += 1;
      continue;
    }

    if (char === ',') {
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
function readString(text: string, from: number): [string, number] {
  const out: string[] = [];
  let at = from + 1;

  while (at < text.length) {
    const char = text[at];

    if (char === '\\') {
      const escape = text[at + 1];
      if (escape === 'u') {
        const code = Number.parseInt(text.slice(at + 2, at + 6), 16);
        // A malformed escape is `JSON.parse`'s to report. Here it only has to not become a
        // character that changes what the key is.
        if (Number.isFinite(code)) out.push(String.fromCharCode(code));
        at += 6;
        continue;
      }
      if (escape != null) out.push(UNESCAPED[escape] ?? escape);
      at += 2;
      continue;
    }

    if (char === '"') return [out.join(''), at + 1];

    out.push(char ?? '');
    at += 1;
  }

  // Unterminated. `JSON.parse` will say so; returning what was read keeps the caller's loop bounded.
  return [out.join(''), at];
}

const UNESCAPED: Readonly<Record<string, string>> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

// ---------------------------------------------------------------------------------------------
// The second look
// ---------------------------------------------------------------------------------------------

/**
 * The same key check, over the parsed value.
 *
 * Redundant if the scan is correct, which is the point. The scan is a hand-written lexer on the one
 * surface where being wrong hands somebody else a foothold, and this pass is nine lines that do not
 * depend on it — it asks `Object.keys`, which is the same question `Object.assign` would ask later.
 */
function reject(value: unknown, path: readonly string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => reject(item, [...path, String(index)]));
    return;
  }
  if (value == null || typeof value !== 'object') return;

  for (const key of Object.getOwnPropertyNames(value)) {
    if (FORBIDDEN_KEYS.includes(key)) {
      const where = path.length === 0 ? 'at the top level' : `under ${path.join('.')}`;
      throw new UnsafeJsonError(
        'forbidden-key',
        `The parsed file carries a key called "${key}" ${where}. The scan before parsing did not ` +
          'catch it, which is a fault in this app rather than only in the file, and the import is ' +
          'refused on both counts.'
      );
    }
    reject((value as Record<string, unknown>)[key], [...path, key]);
  }
}
