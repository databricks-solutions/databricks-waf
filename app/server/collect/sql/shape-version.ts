// What a shape's identity is, named so a plan filed under it can be told apart from one that is not.
//
// A shape is a hash of normalised query text, and the normalisation is a stack of six regular
// expressions in `workload_query_shapes.sql`. Change one of them and every shape in the estate takes a
// new value: the same query that was `a1b2c3d4e5f60718` last week is something else this week. Nothing
// about the new value says it is new, which is the whole problem — a plan retained under the old
// identity and compared against a shape carrying the new one is a comparison of two different queries
// reported as a trend in one.
//
// So a retained plan records the version of the identity it was filed under, and this is where that
// version comes from. `plan-status.md` requires it, in the paragraph on why the order is what it is:
// a plan filed under a shape identity that later changes has to be rebuilt rather than silently
// mismatched.
//
// ## Derived rather than declared
//
// The obvious shape of this is a constant — `SHAPE_VERSION = 'shape-2'` — bumped by hand when the SQL
// changes. This repository has been bitten twice by a second copy of something that had to agree with
// the first, and a constant beside a file somebody edits is that: the version is wrong exactly when
// somebody forgot, which is exactly when the retained plans need it to be right.
//
// It is therefore read off the statement, which the server already loads through `FileQuerySource`.
// There is nothing to keep in sync and nothing to forget. The cost is that the value is opaque —
// `shape-4f1c8a2b` says nothing to a reader — and that is a fair trade for a field whose only job is
// to be compared with itself.
//
// ## The whole statement, not the fingerprint expression
//
// Only about fifty of this statement's six hundred lines produce the shape, so the narrower and more
// obvious design is to bound those lines with marker comments and digest what is between them. That was
// written, and the test suite refused it for a reason worth keeping here.
//
// Adding the markers changes the statement's text, and the runtime baseline fingerprints each statement's
// text beside the duration it measured — `statementSha` in `runtime-baseline/labs.json`, guarded by
// `runtime-baseline.test.ts`, which exists because a rewrite that preserved column count once left
// `auth_login_paths` holding a measured budget for a statement that no longer existed. So bounding the
// region would have invalidated the measurement, and the only way to restore it is a live warehouse.
// Two comments, to make a version more precise, at the cost of the performance budget for the statement
// they are comments in.
//
// Digesting the whole statement needs no edit and is the same answer wherever it matters. Its cost is
// the opposite one: an edit anywhere in the file mints a new version and discards a trend window that
// was still valid. That is acceptable *because* of the guard above — editing this statement already
// forces somebody to re-measure it, so a version bump lands inside an act that was already deliberate
// rather than riding along with a passing change.
//
// The text digested is the expanded text, after `{{customer_catalog}}` is substituted, because that is
// the text the warehouse ran and therefore the text that produced these shapes.

import { createHash } from 'node:crypto';

/** The statement the shape fingerprint lives in. Named once, so the reader and the file agree. */
export const SHAPE_STATEMENT = 'workload_query_shapes';

/**
 * The version of the shape identity this statement computes.
 *
 * Throws on an empty statement, which is a packaging fault rather than a workspace condition — the same
 * call `FileQuerySource` makes on a missing file, and for the same reason. A version that quietly fell
 * back to a constant would be indistinguishable from a real one at the point it was compared, so there
 * is no fallback.
 */
export function shapeFingerprintVersion(statement: string): string {
  if (statement.trim() === '') {
    throw new Error(
      `${SHAPE_STATEMENT}.sql is empty, so the version its shapes are filed under cannot be read. ` +
        'Retained query plans record that version and cannot be filed without it.'
    );
  }

  return `shape-${createHash('sha256').update(statement).digest('hex').slice(0, 8)}`;
}
