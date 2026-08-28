import { byList, withoutComments, words } from "./scan.js";
//#region server/collect/sql/slices.ts
/**
* The `-- Slice:` header a statement declares, or undefined when it declares none.
*
* Coarsest first, because that is the order the collector subdivides in: one execution per workspace,
* and only if a workspace is still too large does it bucket by the next axis. Read from the statement
* rather than held in a table here for the same reason `-- Rows:` is — the author changing the `GROUP BY`
* is the person who knows whether the axis survived, and they are looking at the SQL, not at this file.
*/
function declaredSlice(sql) {
	const header = /^--\s*Slice:\s*(.+)$/im.exec(sql);
	if (header == null) return void 0;
	const columns = (header[1] ?? "").split(",").map((column) => column.trim().toLowerCase()).filter((column) => column !== "");
	return columns.length === 0 ? void 0 : { columns };
}
/**
* The columns a statement's own top-level `ORDER BY` sorts on, unqualified, or undefined when it has none.
*
* Slicing preserves the row set and not the row order, which matters more than it sounds: `offenders()`
* takes the first five rows and names them as examples without sorting, trusting the statement's
* `ORDER BY` to have put the worst first. Concatenate per-workspace slices and those five come from
* whichever workspace was executed first — a real change in what a customer reads, from a change that
* keeps every row.
*
* So H1d re-sorts after concatenating, and this is what it sorts by. Exported from here rather than
* hard-coded there because the sort belongs to the statement, and a statement whose `ORDER BY` changes
* should move its consumers with it.
*/
function orderKey(sql) {
	const text = withoutComments(sql);
	let start;
	for (const word of words(text)) if (word.depth === 0 && word.word === "ORDER") start = word.at;
	if (start == null) return void 0;
	const after = /^ORDER\s+BY\b/i.exec(text.slice(start));
	if (after == null) return void 0;
	const columns = byList(text, start + after[0].length).split(",").map((part) => part.trim()).filter((part) => part !== "").map((part) => ({
		column: part.replace(/\s+(?:ASC|DESC)\b.*$/i, "").replace(/^.*\./, "").trim(),
		descending: /\bDESC\b/i.test(part)
	})).filter((part) => part.column !== "");
	return columns.length === 0 ? void 0 : columns;
}
//#endregion
export { declaredSlice, orderKey };
