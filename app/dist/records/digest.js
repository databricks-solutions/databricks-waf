import { canonicalBytes } from "./canonical.js";
import { createHash } from "node:crypto";
//#region server/records/digest.ts
const ALGORITHM = "sha256";
/** The digest of a JSON document, over its canonical bytes. */
function digestOf(document) {
	return fromBytes(canonicalBytes(document));
}
/** The digest of bytes already in canonical form — an exported file, as its recipient holds it. */
function fromBytes(bytes) {
	return `${ALGORITHM}:${createHash(ALGORITHM).update(bytes).digest("hex")}`;
}
/**
* The hex half, for a filename or a `shasum` comparison, where the prefix is noise.
*
* Takes a `string` rather than a `Digest`, because a caller who has one has read it out of a database
* column or a header and has no business asserting its shape to ask this question.
*/
function hexOf(digest) {
	return digest.startsWith(`sha256:`) ? digest.slice(7) : digest;
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
function sameDigest(left, right) {
	if (left.length !== right.length) return false;
	let difference = 0;
	for (let at = 0; at < left.length; at += 1) difference |= left.charCodeAt(at) ^ right.charCodeAt(at);
	return difference === 0;
}
//#endregion
export { ALGORITHM, digestOf, fromBytes, hexOf, sameDigest };
