//#region server/collect/sql/self.ts
/** The tag key on every statement the collector submits. */
const SELF_TAG_KEY = "databricks_waf";
/** The tag value. One value, since nothing distinguishes our statements from each other here. */
const SELF_TAG_VALUE = "assessment";
/**
* The comment prepended to every statement, and the fallback mark.
*
* A single line ending in a newline, so it cannot merge with whatever the file's first line is. The
* text is the app's own name rather than something generic: `-- assessment` would match a customer
* statement that happened to open with a comment saying so, and the exclusion is a `startswith`.
*/
const SELF_MARKER = "-- databricks-waf: assessment\n";
/** The `query_tags` field of a submit request. An array, not a map — see the header. */
const SELF_TAGS = [{
	key: SELF_TAG_KEY,
	value: SELF_TAG_VALUE
}];
/** Marks a statement as ours. Idempotent, so a caller that marks twice does not double the comment. */
function mark(statement) {
	return statement.startsWith("-- databricks-waf: assessment\n") ? statement : `${SELF_MARKER}${statement}`;
}
//#endregion
export { SELF_MARKER, SELF_TAGS, SELF_TAG_KEY, SELF_TAG_VALUE, mark };
