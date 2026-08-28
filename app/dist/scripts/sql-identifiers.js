//#region scripts/sql-identifiers.mjs
/**
* A Databricks SQL identifier, backtick-quoted, or undefined when it must not be emitted.
*
* Backticks inside the value are doubled. A line break or an empty/whitespace-only value is refused
* rather than escaped: there is no escape for a newline inside an identifier, and emitting a
* multi-line grant captioned "runnable as written" is worse than emitting nothing.
*
* @param {string | null | undefined} value
* @returns {string | undefined}
*/
function quoteIdent(value) {
	if (value == null) return void 0;
	const text = String(value);
	if (text.trim() === "" || /[\r\n]/.test(text)) return void 0;
	return `\`${text.replaceAll("`", "``")}\``;
}
//#endregion
export { quoteIdent };
