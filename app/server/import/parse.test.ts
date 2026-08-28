// The parse, attacked.
//
// Almost every test here is negative, which is what this surface is. The positive case is one line
// and `JSON.parse` already had it; the value of the module is entirely in what it refuses, so a
// suite that mostly asserted successful parses would be measuring the wrong thing.
//
// Two of these were written from the wrong end and are worth keeping in mind while reading: the
// escaped-`__proto__` case exists because the first version of the scan compared the literal
// spelling of a key against the deny-list and `"\u005f\u005fproto__"` walked straight past it, and
// the string-contents cases exist because a scan that tracks brackets without understanding strings
// counts `"{{{{"` as four levels of nesting.

import { describe, expect, it } from 'vitest';
import { MAX_DEPTH, UnsafeJsonError, parseUntrusted } from './parse';

function refusal(text: string): UnsafeJsonError {
  try {
    parseUntrusted(text);
  } catch (cause) {
    if (cause instanceof UnsafeJsonError) return cause;
    throw cause;
  }
  throw new Error(`Expected ${text.slice(0, 60)} to be refused, and it was accepted.`);
}

describe('parseUntrusted', () => {
  it('reads an ordinary document', () => {
    expect(parseUntrusted('{"schema":"waf-admin-evidence/1","probes":[{"status":"observed"}]}')).toEqual({
      schema: 'waf-admin-evidence/1',
      probes: [{ status: 'observed' }],
    });
  });

  it('says the file is not JSON rather than throwing V8 at the caller', () => {
    const problem = refusal('{"schema": }');
    expect(problem.reason).toBe('not-json');
    expect(problem.message).toContain('not JSON');
  });

  describe('prototype pollution', () => {
    it('refuses a __proto__ key', () => {
      expect(refusal('{"__proto__":{"admin":true}}').reason).toBe('forbidden-key');
    });

    it('refuses one spelled in escapes, which is the same key to JSON.parse', () => {
      // Proof the two spellings are one key, so this is not a test of a distinction without one.
      expect(Object.keys(JSON.parse('{"\\u005f\\u005fproto__":1}') as object)).toEqual(['__proto__']);
      expect(refusal('{"\\u005f\\u005fproto__":1}').reason).toBe('forbidden-key');
    });

    it('refuses constructor and prototype, which reach the same place by a longer route', () => {
      expect(refusal('{"constructor":{"prototype":{}}}').reason).toBe('forbidden-key');
      expect(refusal('{"probes":[{"prototype":1}]}').reason).toBe('forbidden-key');
    });

    it('refuses one nested inside an otherwise valid envelope', () => {
      const problem = refusal('{"schema":"waf-admin-evidence/1","tiers":{"workspace":{"__proto__":{}}}}');
      expect(problem.reason).toBe('forbidden-key');
    });

    it('allows the words as values, since only a key can pollute anything', () => {
      expect(parseUntrusted('{"label":"__proto__","detail":"constructor"}')).toEqual({
        label: '__proto__',
        detail: 'constructor',
      });
    });

    it('does not pollute anything while deciding to refuse', () => {
      const before = Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted');
      try {
        parseUntrusted('{"__proto__":{"polluted":true}}');
      } catch {
        // The refusal is asserted above; here the point is what did not happen to the realm.
      }
      expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'polluted')).toBe(before);
      expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    });
  });

  describe('duplicate keys', () => {
    it('refuses a repeated key rather than taking the last one', () => {
      // What JSON.parse does with it, stated so the refusal reads as a choice rather than a quirk.
      expect(JSON.parse('{"status":"denied","status":"observed"}')).toEqual({ status: 'observed' });

      const problem = refusal('{"status":"denied","status":"observed"}');
      expect(problem.reason).toBe('duplicate-key');
      expect(problem.message).toContain('status');
    });

    it('refuses a repeat deep inside a probe, not only at the top', () => {
      expect(refusal('{"probes":[{"tier":"workspace","tier":"account"}]}').reason).toBe('duplicate-key');
    });

    it('allows the same key in sibling objects, which is not a duplicate', () => {
      expect(parseUntrusted('{"probes":[{"tier":"workspace"},{"tier":"account"}]}')).toEqual({
        probes: [{ tier: 'workspace' }, { tier: 'account' }],
      });
    });

    it('allows a key that matches a value elsewhere in the same object', () => {
      expect(parseUntrusted('{"label":"tier","tier":"account"}')).toEqual({ label: 'tier', tier: 'account' });
    });

    it('does not mistake an array element for a repeated key', () => {
      expect(parseUntrusted('{"fields":["name","name"]}')).toEqual({ fields: ['name', 'name'] });
    });
  });

  describe('depth', () => {
    it('accepts a document at the limit', () => {
      const text = `${'['.repeat(MAX_DEPTH)}1${']'.repeat(MAX_DEPTH)}`;
      expect(() => parseUntrusted(text)).not.toThrow();
    });

    it('refuses one past it, before JSON.parse recurses', () => {
      const text = `${'['.repeat(MAX_DEPTH + 1)}1${']'.repeat(MAX_DEPTH + 1)}`;
      const problem = refusal(text);
      expect(problem.reason).toBe('too-deep');
      expect(problem.message).toContain(String(MAX_DEPTH));
    });

    it('refuses the depth a bare JSON.parse answers with a stack overflow', () => {
      // 200k levels: the input a naive implementation reports as `RangeError: Maximum call stack
      // size exceeded`, which is a true statement about our stack and no help about their file.
      const text = '['.repeat(200_000);
      expect(refusal(text).reason).toBe('too-deep');
    });

    it('counts objects and arrays together, since either one is a frame', () => {
      const half = Math.ceil((MAX_DEPTH + 2) / 2);
      const text = `${'{"a":['.repeat(half)}1${']}'.repeat(half)}`;
      expect(refusal(text).reason).toBe('too-deep');
    });
  });

  describe('strings the scan must not misread', () => {
    it('does not count brackets inside a string as nesting', () => {
      const text = JSON.stringify({ detail: '['.repeat(MAX_DEPTH * 4) });
      expect(parseUntrusted(text)).toEqual({ detail: '['.repeat(MAX_DEPTH * 4) });
    });

    it('does not read a quote inside a string as the end of it', () => {
      const value = { detail: 'he said "__proto__" and left' };
      expect(parseUntrusted(JSON.stringify(value))).toEqual(value);
    });

    it('does not read an escaped backslash as escaping the closing quote', () => {
      const value = { detail: 'C:\\path\\', tier: 'workspace' };
      expect(parseUntrusted(JSON.stringify(value))).toEqual(value);
    });

    it('does not treat a comma inside a string as the start of a new key', () => {
      const value = { detail: 'one, two, three', label: 'clusters' };
      expect(parseUntrusted(JSON.stringify(value))).toEqual(value);
    });

    it('handles a surrogate pair without losing its place', () => {
      const value = { label: 'clusters \u{1F600}', tier: 'workspace' };
      expect(parseUntrusted(JSON.stringify(value))).toEqual(value);
    });
  });

  describe('shapes that are legal JSON but not a document', () => {
    it.each(['null', '"a string"', '42', 'true', '[]'])('parses %s, leaving the shape to the schema', (text) => {
      expect(() => parseUntrusted(text)).not.toThrow();
    });
  });
});
