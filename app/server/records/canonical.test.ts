import { describe, expect, it } from 'vitest';
import { canonicalise, canonicalBytes, CanonicalisationError } from './canonical.js';
import { digestOf } from './digest.js';

describe('the canonical form of a record', () => {
  it('does not depend on the order the keys were assigned in', () => {
    // The reason this module exists. Lakebase stores `jsonb`, which returns keys in its own order,
    // so a scan read back has to hash to what it hashed to when it was written.
    const written = { id: 'scan-1', score: { overall: 62 }, actor: 'someone@example.com' };
    const read = { actor: 'someone@example.com', score: { overall: 62 }, id: 'scan-1' };

    expect(canonicalise(read)).toBe(canonicalise(written));
    expect(digestOf(read)).toBe(digestOf(written));
  });

  it('sorts nested keys too, not only the outermost', () => {
    expect(canonicalise({ a: { z: 1, y: 2 } })).toBe('{"a":{"y":2,"z":1}}');
  });

  it('keeps array order, which is content and not presentation', () => {
    expect(canonicalise([3, 1, 2])).toBe('[3,1,2]');
    expect(canonicalise({ pillars: ['security', 'cost', 'reliability'] })).toBe(
      '{"pillars":["security","cost","reliability"]}'
    );
  });

  it('leaves out an absent property, exactly as JSON does', () => {
    // A scan is full of optional fields built with `...(x != null ? { x } : {})`, so a build that
    // sets one to undefined instead of omitting it must not produce a different digest.
    expect(canonicalise({ overall: 62, trigger: undefined })).toBe('{"overall":62}');
    expect(canonicalise({ overall: 62 })).toBe(canonicalise({ trigger: undefined, overall: 62 }));
  });

  it('writes a hole in an array as null, because position is content', () => {
    expect(canonicalise([1, undefined, 3])).toBe('[1,null,3]');
  });

  it('has no insignificant whitespace', () => {
    expect(canonicalise({ a: 1, b: [2, { c: 3 }] })).toBe('{"a":1,"b":[2,{"c":3}]}');
  });

  it('escapes strings as JSON does, including what is outside the BMP', () => {
    expect(canonicalise('a\nb')).toBe('"a\\nb"');
    expect(canonicalise('quote " backslash \\')).toBe('"quote \\" backslash \\\\"');
    // An emoji is a surrogate pair, and the bytes have to survive a round trip through a database
    // and a file. Evidence carries values copied out of the customer's estate, which is where a
    // name like this arrives from.
    expect(JSON.parse(canonicalise('cluster 🚀'))).toBe('cluster 🚀');
    expect(canonicalBytes('cluster 🚀').toString('utf8')).toBe('"cluster 🚀"');
  });

  it('prints numbers as ECMAScript does', () => {
    expect(canonicalise([1, 1.5, -2, 1e21, 1e-7, 0.1])).toBe('[1,1.5,-2,1e+21,1e-7,0.1]');
  });

  it('treats negative zero as zero, so arithmetic cannot move a digest', () => {
    expect(canonicalise(-0)).toBe('0');
    expect(digestOf({ delta: -0 })).toBe(digestOf({ delta: 0 }));
  });

  it('refuses a number JSON cannot represent rather than writing null', () => {
    expect(() => canonicalise({ score: Number.NaN })).toThrow(CanonicalisationError);
    expect(() => canonicalise({ score: Infinity })).toThrow(/cannot represent/);
  });

  it('honours toJSON, so a Date is its ISO string and not an empty object', () => {
    const at = new Date('2026-08-02T04:05:06.000Z');
    expect(canonicalise({ startedAt: at })).toBe('{"startedAt":"2026-08-02T04:05:06.000Z"}');
    // The same document after a round trip through JSON, which is what the store hashes.
    expect(digestOf({ startedAt: at })).toBe(digestOf(JSON.parse(JSON.stringify({ startedAt: at }))));
  });

  it('refuses a Map instead of hashing it as {}', () => {
    // One probe in this app answers with a Map, and `JSON.stringify` renders it as `{}` without
    // complaint. A digest over an empty document is stable and worthless, which is the failure
    // mode worth a thrown error.
    expect(() => canonicalise({ settings: new Map([['a', 1]]) })).toThrow(/Map, which is not JSON data/);
  });

  it('refuses a bigint, which JSON.stringify throws on too', () => {
    expect(() => canonicalise({ rows: 10n })).toThrow(CanonicalisationError);
  });

  it('accepts a null-prototype object, which is what a parsed document can be', () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { b: 2, a: 1 });
    expect(canonicalise(bare)).toBe('{"a":1,"b":2}');
  });

  it('refuses a document nested past the depth it will follow', () => {
    let deep: unknown = 'bottom';
    for (let at = 0; at < 70; at += 1) deep = { deep };
    expect(() => canonicalise(deep)).toThrow(/nested more than 64 levels/);
  });

  it('refuses a cycle with a sentence rather than exhausting the stack', () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => canonicalise(cycle)).toThrow(CanonicalisationError);
  });

  it('round-trips through JSON.parse to the same bytes', () => {
    // The property the whole design leans on: the canonical form is itself JSON, so a recipient
    // parsing an exported file and re-canonicalising it gets the file back.
    const document = { b: [1, { d: null, c: 'x' }], a: true, z: 'ünïcödé' };
    const once = canonicalise(document);
    expect(canonicalise(JSON.parse(once))).toBe(once);
  });

  it('is byte-for-byte what RFC 8785 specifies for its own example', () => {
    // The RFC's own input and output, verbatim, as text rather than as an object literal — which is
    // both more faithful (the spec states its input as JSON) and the only way to write
    // `333333333.33333329`, whose whole purpose is that a double cannot hold it.
    //
    // Pinned because "we follow JCS" is worth nothing to somebody auditing an artefact in another
    // language unless it is true, and this is the cheapest way to keep it true.
    const input = String.raw`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/",
      "literals": [null, true, false]
    }`;

    expect(canonicalise(JSON.parse(input))).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f` +
        String.raw`\nA'B\"\\\\\"/"}`
    );
  });
});
