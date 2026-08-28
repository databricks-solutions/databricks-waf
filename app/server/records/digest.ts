// The digest of a record, and what one is for.
//
// A customer's auditor is handed a finding register, or a scan is exported and mailed on, and the
// question a month later is whether the artefact in hand is the one this app produced. Until now
// there was no way to answer it: a stored scan is a row, a row can be edited, and a document with
// no digest cannot be told apart from a document that was changed.
//
// So every record this app writes is stamped with the SHA-256 of its canonical bytes, and the same
// digest is recomputed whenever the record is read back or exported. That buys two specific things
// and it is worth being exact about them, because the gap between them and what a reader assumes is
// where this kind of feature usually misleads:
//
//   Detection of a change made behind the app's back. A body edited in `psql` no longer matches the
//   digest stored beside it, and `verify.ts` says which row and stops describing the estate as
//   verified.
//
//   Identity of an artefact that has left the building. The exported document is the canonical
//   bytes, so a recipient runs `shasum -a 256` on the file and compares it with the digest the app
//   shows — no library, no script, nothing of ours in the path.
//
// What it does not buy: an editor who changes the body and recomputes the digest defeats it, because
// nothing here is secret and nothing here is chained. That is the rest of A3c — the hash chain and
// the managed-key signature — and it is deliberately not implied by this file. SECURITY.md says so
// in the same words.

import { createHash } from 'node:crypto';
import { canonicalBytes } from './canonical.js';

export const ALGORITHM = 'sha256';

/**
 * A digest as it is written down and compared: lower-case hex, prefixed with its algorithm.
 *
 * Prefixed because the algorithm will change one day and a bare hex string gives a reader nothing to
 * decide with — a stored `sha256:…` can be told from a future `sha3-256:…` by looking, and a
 * comparison between the two fails as a mismatch of algorithms rather than a mismatch of content.
 * The shape is `git`'s and `subresource integrity`'s, near enough, and it is the same string a
 * recipient sees next to `shasum -a 256` output once the prefix is dropped.
 */
export type Digest = `${typeof ALGORITHM}:${string}`;

/** The digest of a JSON document, over its canonical bytes. */
export function digestOf(document: unknown): Digest {
  return fromBytes(canonicalBytes(document));
}

/** The digest of bytes already in canonical form — an exported file, as its recipient holds it. */
export function fromBytes(bytes: Buffer): Digest {
  return `${ALGORITHM}:${createHash(ALGORITHM).update(bytes).digest('hex')}`;
}

/**
 * The hex half, for a filename or a `shasum` comparison, where the prefix is noise.
 *
 * Takes a `string` rather than a `Digest`, because a caller who has one has read it out of a database
 * column or a header and has no business asserting its shape to ask this question.
 */
export function hexOf(digest: string): string {
  return digest.startsWith(`${ALGORITHM}:`) ? digest.slice(ALGORITHM.length + 1) : digest;
}

/**
 * Whether a stored digest matches one just computed.
 *
 * Constant-time, which is close to superstition here and costs one line. Nothing about these digests
 * is secret — the document they cover is served to whoever can read it — so there is no oracle to
 * time. It is written this way because `===` on a hash is the habit that is wrong everywhere else,
 * and a reader who finds it in the codebase should not have to work out which case they are looking
 * at.
 */
export function sameDigest(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let at = 0; at < left.length; at += 1) difference |= left.charCodeAt(at) ^ right.charCodeAt(at);
  return difference === 0;
}
