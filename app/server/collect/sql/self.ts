// How this app's own statements are recognisable, so the advisor does not rank the tool.
//
// The workload advisor reads `system.query.history` and reports the estate's costliest query shapes.
// Every statement the collector runs is in that history, so on the first real run against a labs
// workspace eight of the top twelve shapes were this app's own signals, two rules fired on them, and
// the page invited the reader to go and optimise the thing they were reading. Measured on that
// workspace: 51.8% of all query time over twenty days was ours. An advisor whose loudest finding is
// itself is worse than one with no findings, because a reader has to know the tool well enough to
// recognise the queries before they can discount them.
//
// So every statement is marked, and the shapes statement excludes any of four marks: a query tag, a
// comment this module prepends, and two comment conventions every statement file already carries — the
// `-- Signal:` header and the `-- Rows:` bounds declaration.
//
// `query_tags` is the platform's own mechanism and the primary mark. It is a per-request field on the
// Statement Execution API, it survives comment stripping and text truncation, and it is queryable as a
// column rather than by matching text. It is also in Public Preview and takes an array of key/value
// objects — a map is accepted by the API and recorded as `{"tags_invalid": null}` in the history table,
// which is a silent failure discovered only by reading the column back on a real workspace. Hence the
// array shape below, and `self.integration.test.ts` reads a tag back rather than asserting the request
// body.
//
// The comment marker is the fallback for a workspace without the preview, where the tag is accepted and
// discarded. A marker prepended at submit time covers every statement by construction, including any
// added later by somebody who has not read this.
//
// Neither of those is retroactive, which the same workspace then demonstrated: after both marks shipped
// the advisor's top twelve was still eleven-twelfths this app, because the history was written before the
// marks existed and only one statement in the window carried the tag. Any existing pilot would see the
// same for a fortnight. Hence the two retroactive marks — the comment conventions already in the files,
// which are the only things about our past statements that can still be recognised. Two rather than one
// because the run after the first shipped still ranked three of our own shapes: the marks have to be
// matched anywhere in the text rather than at the start, and a file that gained its signal header late is
// recognisable only by the bounds header it has carried for longer.
//
// It also has a second use, which is not a side effect but a reason: a workspace admin looking at Query
// History can see which statements came from the assessment. The app already publishes what it runs and
// why on the consent surface, and this is the same disclosure at the other end.

/** The tag key on every statement the collector submits. */
export const SELF_TAG_KEY = 'databricks_waf';

/** The tag value. One value, since nothing distinguishes our statements from each other here. */
export const SELF_TAG_VALUE = 'assessment';

/**
 * The comment prepended to every statement, and the fallback mark.
 *
 * A single line ending in a newline, so it cannot merge with whatever the file's first line is. The
 * text is the app's own name rather than something generic: `-- assessment` would match a customer
 * statement that happened to open with a comment saying so, and the exclusion is a `startswith`.
 */
export const SELF_MARKER = '-- databricks-waf: assessment\n';

/**
 * The header every statement file carries, and the third mark — for history this app wrote before the
 * other two existed.
 *
 * Neither the tag nor the marker is retroactive, so on the workspace this was developed against the
 * advisor went on ranking a fortnight of its own queries after the fix, and would have done the same on
 * any existing pilot. The `-- Signal: sql:` header is a string this app has always written at the top of
 * every statement file, which makes it the one mark that can be applied backwards.
 *
 * `self.test.ts` holds every statement file to the convention, which now carries weight it did not when it
 * was only documentation: the one file that lacked a header ranked as a shape of its own in that same run,
 * and a twenty-first statement added without one would do it again.
 *
 * The namespace is included rather than matching `-- Signal:` alone. It is the difference between a string
 * a customer might plausibly write at the top of a query and one they would not.
 *
 * Matched anywhere in the text rather than at the start, which the run after this shipped is what taught:
 * three of the advisor's top twelve were still one of our own signals, because the execution's text opened
 * with the bounds header and the signal header was the line under it. A mark that only counts as the first
 * line is a mark any prefix defeats.
 */
export const SELF_HEADER = '-- Signal: sql:';

/**
 * The bounds header, and the fourth mark — for history written by a version of this app that predates the
 * signal header on the file in question.
 *
 * Every statement file has declared how many rows it can return since the row-bounds check shipped, which
 * is far longer than either the tag or the signal header has been on all of them. So this is the mark that
 * reaches furthest back, and on the workspace this was measured against it is the only one that recognises
 * the shape that ranked third.
 *
 * The prefix only, because what follows it varies by statement — `1`, `at most 40`, `one per table`. That is
 * the convention `check-statement-bounds` enforces, and matching the whole line would mean listing its
 * forms here and adding to them whenever a statement is written.
 *
 * A customer comment reading `-- Rows: 10` would match, which is the one false positive available here. It
 * costs a shape its place in a ranking of twelve rather than producing a wrong number, and the alternative
 * — leaving our own history in the ranking for a fortnight after every upgrade — is the failure this exists
 * to stop.
 */
export const SELF_BOUNDS = '-- Rows: ';

/** The `query_tags` field of a submit request. An array, not a map — see the header. */
export const SELF_TAGS: readonly { readonly key: string; readonly value: string }[] = [
  { key: SELF_TAG_KEY, value: SELF_TAG_VALUE },
];

/** Marks a statement as ours. Idempotent, so a caller that marks twice does not double the comment. */
export function mark(statement: string): string {
  return statement.startsWith(SELF_MARKER) ? statement : `${SELF_MARKER}${statement}`;
}
