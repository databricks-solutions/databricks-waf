//#region server/collect/sql/rows.ts
/**
* Whether a column sorts as a number.
*
* The type names the Statement Execution API reports for its numeric types. `INTERVAL` and the date
* types are deliberately absent: they sort correctly as text in the ISO-8601 form the API returns
* them in, and `Number()` of one is `NaN`, which would sort every value equal.
*/
const NUMERIC_TYPES = /* @__PURE__ */ new Set([
	"BYTE",
	"SHORT",
	"INT",
	"INTEGER",
	"LONG",
	"BIGINT",
	"FLOAT",
	"DOUBLE",
	"DECIMAL"
]);
function isNumericType(type) {
	if (type == null || type === "") return void 0;
	return NUMERIC_TYPES.has(type.toUpperCase());
}
function text(row, column) {
	const value = row[column];
	if (value == null) return void 0;
	if (typeof value === "string") return value === "" ? void 0 : value;
	if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
}
/**
* A number, or undefined when the column is null or unparseable.
*
* Undefined rather than zero, because the two mean different things and the
* difference is exactly what the unpopulated-column problem turns on: a NULL
* `timeout_seconds` means the system table has not recorded one, and reading it
* as zero would report every long-standing job as having no timeout.
*/
function num(row, column) {
	const value = row[column];
	if (value == null || value === "") return void 0;
	const parsed = typeof value === "number" ? value : Number(value);
	return Number.isFinite(parsed) ? parsed : void 0;
}
/** A number with a floor of zero for genuine counts, where absent means none. */
function count(row, column) {
	return num(row, column) ?? 0;
}
function bool(row, column) {
	const value = row[column];
	if (value == null || value === "") return void 0;
	if (typeof value === "boolean") return value;
	const lower = text(row, column)?.toLowerCase();
	if (lower === "true" || lower === "t" || lower === "1") return true;
	if (lower === "false" || lower === "f" || lower === "0") return false;
}
function date(row, column) {
	const value = text(row, column);
	if (value == null) return void 0;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? void 0 : parsed;
}
/** Fraction with an explicit zero-denominator answer, so callers cannot produce NaN. */
function share(part, whole) {
	if (whole <= 0) return void 0;
	return part / whole;
}
//#endregion
export { bool, count, date, isNumericType, num, share, text };
