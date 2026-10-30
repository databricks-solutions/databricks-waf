// The one manifest that was published under the Version 1 name and was never Version 1.
//
// Version 1 was released at one manifest digest. For a period afterwards the manifest on `main` was
// regenerated under the same name, and scans taken in that period stamped the changed digest as
// "Methodology Version 1, released". Version 1 has since been restored to the released artifact, so those
// stored stamps name a digest that no release ever carried. They are real records of what was measured and
// are never rewritten (decision D5 in docs/decisions.md); what changes is how a reader is told about them.
//
// Shared by the server and the browser for the reason `comparability.ts` is: the comparison refusal and
// the stamp a reader looks at have to name this digest the same way.

/** The manifest digest the interim scoring shape carried while it was stamped as Version 1. */
export const INTERIM_VERSION_1_DIGEST = 'sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f';

/** What a reader is told that digest is. */
export const INTERIM_VERSION_1_LABEL = 'unreleased interim variant of Version 1';

/** The part of a stamp's public methodology identity this module reads. */
export interface MethodologyDigestLike {
  readonly publicVersion: number;
  readonly manifestDigest: string;
}

/**
 * Whether a stamp's public methodology is the interim variant.
 *
 * Both fields are required, so a later version that happened to be sealed to the same bytes is never
 * mistaken for it. The stored stamp says `released`, which is what it recorded at the time and is not
 * a fact about the digest.
 */
export function isInterimVersionOne(methodology: MethodologyDigestLike | undefined): boolean {
  return methodology?.publicVersion === 1 && methodology.manifestDigest === INTERIM_VERSION_1_DIGEST;
}

/** A public methodology as a reader names it: `Version 2`, or the label for the interim variant. */
export function methodologyVersionName(methodology: MethodologyDigestLike): string {
  return isInterimVersionOne(methodology) ? INTERIM_VERSION_1_LABEL : `Version ${String(methodology.publicVersion)}`;
}
