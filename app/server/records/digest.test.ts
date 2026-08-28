import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalBytes } from './canonical.js';
import { digestOf, fromBytes, hexOf, sameDigest } from './digest.js';

describe('the digest of a record', () => {
  it('names the algorithm it used', () => {
    expect(digestOf({ id: 'scan-1' })).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is the SHA-256 anybody else would compute over the same bytes', () => {
    // The property that makes an exported file verifiable without this app: the digest is the
    // plain hash of the document's canonical bytes, which is what `shasum -a 256` prints.
    const document = { id: 'scan-1', overall: 62 };
    const bytes = canonicalBytes(document);
    const independently = createHash('sha256').update(bytes).digest('hex');

    expect(hexOf(digestOf(document))).toBe(independently);
    expect(fromBytes(bytes)).toBe(digestOf(document));
  });

  it('changes when the document does', () => {
    expect(digestOf({ overall: 62 })).not.toBe(digestOf({ overall: 63 }));
    // A digest over a subset must not collide with one over the whole, which is what hashing the
    // canonical form of the document — rather than its values — gives.
    expect(digestOf({ a: '1', b: '2' })).not.toBe(digestOf({ a: '12' }));
  });

  it('is unchanged by a round trip through JSON, which is what a store does to it', () => {
    const document = { id: 'scan-1', startedAt: new Date('2026-08-02T00:00:00.000Z'), pillars: ['security'] };
    expect(digestOf(JSON.parse(JSON.stringify(document)))).toBe(digestOf(document));
  });

  it('is pinned, so a change of format is a change of this test', () => {
    // A stored digest outlives the build that wrote it. If canonicalisation changes shape, every
    // record already stamped starts reading as altered — so the format is fixed here deliberately,
    // and moving it means deciding what happens to the rows that carry the old one.
    expect(digestOf({ hello: 'world' })).toBe('sha256:93a23971a914e5eacbf0a8d25154cda309c3c1c72fbb9914d47c60f3cb681588');
  });

  it('reads the hex out of a digest, and leaves a bare hex string alone', () => {
    expect(hexOf('sha256:abc')).toBe('abc');
    expect(hexOf('abc')).toBe('abc');
  });

  describe('comparing two', () => {
    it('matches a digest with itself and nothing else', () => {
      const digest = digestOf({ a: 1 });
      expect(sameDigest(digest, digest)).toBe(true);
      expect(sameDigest(digest, digestOf({ a: 2 }))).toBe(false);
    });

    it('does not match a prefix of itself', () => {
      const digest = digestOf({ a: 1 });
      expect(sameDigest(digest, digest.slice(0, -1))).toBe(false);
    });
  });
});
