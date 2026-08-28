import { createHash } from "node:crypto";
//#region server/collect/sql/shape-version.ts
/** The statement the shape fingerprint lives in. Named once, so the reader and the file agree. */
const SHAPE_STATEMENT = "workload_query_shapes";
/**
* The version of the shape identity this statement computes.
*
* Throws on an empty statement, which is a packaging fault rather than a workspace condition — the same
* call `FileQuerySource` makes on a missing file, and for the same reason. A version that quietly fell
* back to a constant would be indistinguishable from a real one at the point it was compared, so there
* is no fallback.
*/
function shapeFingerprintVersion(statement) {
	if (statement.trim() === "") throw new Error(`${SHAPE_STATEMENT}.sql is empty, so the version its shapes are filed under cannot be read. Retained query plans record that version and cannot be filed without it.`);
	return `shape-${createHash("sha256").update(statement).digest("hex").slice(0, 8)}`;
}
//#endregion
export { SHAPE_STATEMENT, shapeFingerprintVersion };
