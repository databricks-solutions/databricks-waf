//#region server/collect/sql/bounds.ts
const DECLARATION = /^--\s*Rows:\s*(.+?)\s*$/im;
const FIXED = /^(\d+)$/;
const AT_MOST_FIXED = /^at most (\d+)$/i;
const AT_MOST_PARAMETER = /^at most :([a-z_][a-z0-9_]*)$/i;
const ONE_PER = /^one per ([a-z][a-z0-9 _-]*)$/i;
/**
* The bound a statement declares, or undefined when it declares none.
*
* Reads the loaded statement text rather than the file, so the runtime and the CI check parse the
* same string through the same function. `FileQuerySource` strips a trailing semicolon and expands
* `{{customer_catalog}}` fragments but leaves comments alone, which is what makes that possible.
*/
function declaredBound(statement) {
	const declaration = DECLARATION.exec(statement);
	if (declaration == null) return void 0;
	return parseBound(declaration[1]);
}
/** The declaration's value, parsed. Exported for the CI check, which reports on the text. */
function parseBound(text) {
	const fixed = FIXED.exec(text) ?? AT_MOST_FIXED.exec(text);
	if (fixed != null) return {
		kind: "fixed",
		rows: Number(fixed[1])
	};
	const parameterised = AT_MOST_PARAMETER.exec(text);
	if (parameterised != null) return {
		kind: "parameterised",
		parameter: parameterised[1]
	};
	const scaled = ONE_PER.exec(text);
	if (scaled != null) return {
		kind: "estate-scaled",
		per: scaled[1].trim()
	};
}
/**
* Why a statement's row count breaks its declaration, or undefined when it does not.
*
* Returns prose rather than throwing, and the caller decides what to do with it. At collection time
* the rows are already in hand and already parseable: discarding a usable reading because it was
* one row over a declaration would turn a documentation error into a lost measurement, which is the
* wrong trade in a tool whose whole argument is that coverage is a statement about the estate.
*
* Two ways to break a declaration, and the second is the one that hid. A statement can return more
* rows than it declared, and a statement can declare a ceiling that nothing supplies — where the
* answer is not "no violation" but "this statement is running unchecked". This function returned
* undefined for the second case, and said so in a comment claiming the parameter list test would
* catch it. That test strips comment lines before matching, so it never saw a parameter that appears
* only in a `-- Rows:` header. `at most :made_up_limit` passed the static check, passed the parameter
* test, and disabled this one, which is three layers agreeing because none of them looked.
*
* An estate-scaled declaration is the one thing genuinely unenforceable here, and that is what the
* manifest in `scripts/check-statement-bounds.mjs` is for: there is no ceiling to hold a statement
* to, so only the static check can refuse a new one.
*/
function boundProblem(bound, rows, limits = {}) {
	if (bound == null || bound.kind === "estate-scaled") return void 0;
	if (bound.kind === "fixed") return over(rows, bound.rows, String(bound.rows));
	const ceiling = limits[bound.parameter];
	if (ceiling == null) return `declares a ceiling of :${bound.parameter}, and no numeric value for that parameter was bound, so the ${rows.toLocaleString("en-US")} rows it returned were checked against nothing. Either the \`-- Rows:\` header names the wrong parameter, or the cap it names is no longer bound as a number. Until one of those is true the statement has no enforced ceiling, and an inline result is capped at 25 MiB by the Statement Execution API and fails rather than truncating.`;
	return over(rows, ceiling, `:${bound.parameter} (${String(ceiling)})`);
}
/** The overrun message, or undefined when the count is within the ceiling. */
function over(rows, ceiling, declared) {
	if (rows <= ceiling) return void 0;
	return `returned ${rows.toLocaleString("en-US")} rows against a declared ceiling of ${declared}. The statement's own \`-- Rows:\` header is wrong, or the statement lost its cap: an inline result is capped at 25 MiB by the Statement Execution API and fails rather than truncating, so this grows into a scan that cannot run on a larger estate.`;
}
//#endregion
export { boundProblem, declaredBound, parseBound };
