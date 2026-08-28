//#region server/collect/sql/reads.ts
/**
* `catalog.schema.table` after FROM or JOIN, ignoring case and any amount of whitespace
* or newline between the keyword and the name.
*
* Three parts required. A bare or two-part name in these queries would be a reference to
* something in the caller's own catalog, which no system-table statement here does, and
* matching them would pick up CTE names — `FROM totals` is not a table anyone grants on.
*/
const REFERENCE = /\b(?:from|join)\s+([a-z_][\w]*\.[a-z_][\w]*\.[a-z_][\w]*)/gi;
/**
* The tables one statement reads, lowercased and sorted.
*
* Sorted because the output is displayed and compared: an order that followed the
* statement's own clause order would reshuffle the requirements page whenever a query was
* rewritten, and would make the drift test's failure message depend on where in the SQL
* the change happened.
*/
function tablesRead(statement) {
	const found = /* @__PURE__ */ new Set();
	for (const match of statement.matchAll(REFERENCE)) {
		const name = match[1];
		if (name != null) found.add(name.toLowerCase());
	}
	return [...found].sort();
}
/**
* The schema a grant would be made on: `system.billing` for `system.billing.usage`.
*
* Schema rather than table because that is the unit `GRANT SELECT` is realistically used
* at on system tables, and because a page listing eleven tables across five schemas as
* eleven separate requirements is a page nobody reads to the end of.
*/
function schemaOf(table) {
	const parts = table.split(".");
	return parts.length >= 2 ? `${parts[0]}.${parts[1]}` : table;
}
/** The distinct schemas a set of tables sits in, sorted. */
function schemasOf(tables) {
	return [...new Set(tables.map(schemaOf))].sort();
}
//#endregion
export { schemaOf, schemasOf, tablesRead };
