import { isNumericType } from "./rows.js";
//#region server/collect/sql/concat.ts
/**
* The concatenated rows, in the order the statement's own `ORDER BY` puts them.
*
* Returns the input untouched when there is nothing to sort by. A statement with no `ORDER BY` has
* no order to preserve, so slice order — which is workspace order, and stable — is as good an answer
* as any, and inventing one would be a difference between the sliced and unsliced paths.
*/
function resort(rows, order, types) {
	const copy = [...rows];
	if (order == null || order.length === 0) return copy;
	const numeric = new Set(order.filter((by) => sortsAsNumber(rows, by.column, types)).map((by) => by.column));
	return copy.sort((left, right) => {
		for (const by of order) {
			const compared = compare(left[by.column], right[by.column], by.descending, numeric.has(by.column));
			if (compared !== 0) return compared;
		}
		return 0;
	});
}
/**
* Whether a column sorts as a number: the manifest's answer where there is one, the values' otherwise.
*
* The manifest first because the values cannot settle it. `job_id` is a STRING in
* `system.lakeflow.jobs` and holds nothing but digits, and it is the tiebreak in two of these four
* statements — so inferring from the values would sort it numerically where Spark sorted it byte by
* byte, and the rows a finding quotes as its examples would differ from the rows a customer sees
* running the same SQL by hand. That is the exact divergence this module exists to prevent.
*
* The inference stays as the fallback rather than being deleted, because a manifest with no types is
* a real case — a fixture, an older response shape — and text ordering on a count column is the worse
* failure of the two: it puts `9` above `10` on the primary sort key rather than reordering a tie.
*/
function sortsAsNumber(rows, column, types) {
	return isNumericType(types?.[column]) ?? allNumeric(rows, column);
}
/**
* Whether every present value in a column parses as a number.
*
* Decided per column over the whole result rather than per pair, so the comparison is transitive.
* A column where `'10'` and `'9'` compare numerically but `'10'` and `'abc'` compare as text has no
* consistent order at all, and `Array.prototype.sort` given an inconsistent comparator produces an
* arbitrary permutation rather than an error.
*/
function allNumeric(rows, column) {
	let seen = 0;
	for (const row of rows) {
		const value = row[column];
		if (value == null || value === "") continue;
		if (typeof value === "number" || typeof value === "bigint") {
			seen += 1;
			continue;
		}
		if (typeof value !== "string" || !Number.isFinite(Number(value))) return false;
		seen += 1;
	}
	return seen > 0;
}
/** One column's comparison, with Spark's null placement and the direction the statement asked for. */
function compare(left, right, descending, numeric) {
	const missing = (value) => value == null || value === "";
	if (missing(left) && missing(right)) return 0;
	if (missing(left)) return descending ? 1 : -1;
	if (missing(right)) return descending ? -1 : 1;
	const order = numeric ? sign(Number(left) - Number(right)) : text(left, right);
	return descending ? -order : order;
}
function text(left, right) {
	const [a, b] = [String(left), String(right)];
	return a < b ? -1 : a > b ? 1 : 0;
}
function sign(value) {
	return value < 0 ? -1 : value > 0 ? 1 : 0;
}
//#endregion
export { resort };
