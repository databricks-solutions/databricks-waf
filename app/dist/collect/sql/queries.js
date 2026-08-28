import { shippedConfigDirectory } from "../../shipped-config.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
//#region server/collect/sql/queries.ts
/**
* Catalogs Databricks provisions and owns, which are not part of the customer's estate.
*
* `system` and `samples` are auto-created, read-only and present in every workspace. The
* customer cannot change a `samples` table's format or add a description to
* `system.billing.usage`, so counting them as assets under assessment produces findings
* about someone else's tables. Measured on the labs metastore: 130 of 141 catalogued
* tables were Databricks-owned, which took the table-format control to 73% and `partial`
* where the customer's own eleven tables were eleven of eleven and a pass. That is a
* false failure of the same kind as marking a serverless estate down for having no cluster
* policies.
*
* Identified by owner rather than by name, because `catalog_owner` is what actually
* distinguishes them and a future Databricks-provided catalog would be caught without a
* code change. The name list stays as a backstop in case that string is not stable, and
* costs nothing: none of these names can be taken by a customer catalog.
*
* Both halves of that missed a whole family, and row `80` is where it was found. The
* platform creates one internal catalog per workspace for materialised Lakeview datasets,
* named `__databricks_internal_catalog_lakeview_<workspace id>`. It is not the literal
* `__databricks_internal`, and it is not owned by `System user`, so it survived a predicate
* whose two halves were each written believing the other was the backstop. Measured on
* `large-estate` 2026-08-16: one such catalog held 28,248 of the 604,746 relations this
* expression called the customer's, which is 4.7% of the estate under assessment and the
* sixth-largest catalog in it. That is the false-failure this expression exists to prevent,
* at estate scale, in the direction the comment above says it is safe from.
*
* So the name backstop is a prefix rather than a list. A customer could in principle take a
* name beginning `__databricks_internal` — assume they will not; if they did, the cost is
* under-counting their estate, which this file has already argued is the cheaper mistake.
*/
const DATABRICKS_OWNED = "'system', 'samples'";
const DATABRICKS_INTERNAL = "'__databricks_internal'";
const SYSTEM_OWNER = "'System user'";
/**
* A boolean expression: is this catalog the customer's rather than Databricks'?
*
* Written as one expression usable in a `WHERE` or a `CASE`, so a query can either exclude
* these tables or count them separately without the two definitions drifting apart. That
* second half went four months unused and unchecked, and it is a stronger claim than the
* first: the expression holds an `IN` subquery, and a subquery in a projection is a
* narrower guarantee than one in a filter. Measured on labs 2026-08-11 it holds — a
* `WHERE`, a bare projection and a `CASE` over `system.information_schema.tables` return
* the same count, so Databricks decorrelates it either way. That is a reading of the one
* engine this app runs on and not of the SQL standard. `uc_lineage_coverage` is the first
* statement to depend on it, and needs to: an event's two sides are in scope
* independently, and a `WHERE` could only test one of them. The
* queries reference it as `{{customer_catalog <column>}}`; substitution happens on load,
* once, in `FileQuerySource`.
*
* It is a fragment rather than a bound parameter because it is structure, not a value —
* the Statement Execution API binds values, and a list of catalog names is neither
* something the caller supplies nor something that varies per scan.
*/
function customerCatalogPredicate(column) {
	return `(${column} NOT IN (SELECT catalog_name FROM system.information_schema.catalogs WHERE catalog_owner = ${SYSTEM_OWNER}) AND lower(${column}) NOT IN (${DATABRICKS_OWNED}) AND NOT startswith(lower(${column}), ${DATABRICKS_INTERNAL}))`;
}
const FRAGMENT = /\{\{customer_catalog ([A-Za-z_][\w.]*)\}\}/g;
/**
* Expands the fragments a query file references.
*
* An unrecognised `{{...}}` is left alone deliberately — silently dropping it would send a
* statement to the warehouse with a hole in its logic, which on a filter means assessing
* more than was intended. A test asserts no query ships with an unexpanded fragment.
*/
function expandFragments(statement) {
	return statement.replace(FRAGMENT, (_whole, column) => customerCatalogPredicate(column));
}
function queryDirectory(moduleUrl = import.meta.url) {
	return shippedConfigDirectory("statements", moduleUrl);
}
var FileQuerySource = class {
	directory;
	cache = /* @__PURE__ */ new Map();
	constructor(directory = queryDirectory()) {
		this.directory = directory;
	}
	text(name) {
		const cached = this.cache.get(name);
		if (cached != null) return cached;
		const path = join(this.directory, `${name}.sql`);
		let contents;
		try {
			contents = readFileSync(path, "utf8");
		} catch (cause) {
			throw new Error(`Query ${name} is missing from ${this.directory}; the app bundle is incomplete.`, { cause });
		}
		const statement = expandFragments(contents.replace(/;\s*$/, "").trim());
		this.cache.set(name, statement);
		return statement;
	}
};
//#endregion
export { FileQuerySource, customerCatalogPredicate, expandFragments, queryDirectory };
