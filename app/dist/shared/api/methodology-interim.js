//#region shared/api/methodology-interim.ts
/** The manifest digest the interim scoring shape carried while it was stamped as Version 1. */
const INTERIM_VERSION_1_DIGEST = "sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f";
/** What a reader is told that digest is. */
const INTERIM_VERSION_1_LABEL = "unreleased interim variant of Version 1";
/**
* Whether a stamp's public methodology is the interim variant.
*
* Both fields are required, so a later version that happened to be sealed to the same bytes is never
* mistaken for it. The stored stamp says `released`, which is what it recorded at the time and is not
* a fact about the digest.
*/
function isInterimVersionOne(methodology) {
	return methodology?.publicVersion === 1 && methodology.manifestDigest === "sha256:3ffb685e36d092c91f52a93a172c1db7e32a2ec5f88f3efdab361390eb0dd71f";
}
/** A public methodology as a reader names it: `Version 2`, or the label for the interim variant. */
function methodologyVersionName(methodology) {
	return isInterimVersionOne(methodology) ? INTERIM_VERSION_1_LABEL : `Version ${String(methodology.publicVersion)}`;
}
//#endregion
export { INTERIM_VERSION_1_DIGEST, INTERIM_VERSION_1_LABEL, isInterimVersionOne, methodologyVersionName };
