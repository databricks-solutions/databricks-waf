import { notApplicable, unmeasured } from "./helpers.js";
//#region server/resolve/resolvers/table-details.ts
const DETAILS = "describe:storage.table_details";
/**
* The answer when the per-table pass described nothing, or undefined when it described something
* and the control should carry on.
*
* Every control reading this signal reduces the described tables to a share, and a share over an
* empty population is zero — which reads as "no over-partitioned tables", "no clustering strategy"
* and "no shortened retention" from the same absence of evidence, one a false pass and two false
* failures. The collector already refuses to emit an empty result, so reaching this is a bug rather
* than an estate; it is handled anyway because the cost of being wrong here is a fabricated finding.
*
* `eligibleTables` is what separates the two answers. Zero eligible tables is a measurement of the
* metastore — there is nothing to lay out — so the control leaves the denominator. Eligible tables
* that went undescribed is a failure of the pass, so the control stays in and reports itself
* unmeasured.
*/
function describedNothing(details) {
	if (details.tables.length > 0) return void 0;
	if (details.eligibleTables === 0) return notApplicable("The metastore holds no Delta tables the scanning identity can see, so there is no table layout to assess.");
	return unmeasured(`None of the ${details.eligibleTables.toLocaleString("en-US")} eligible tables were described, so this is unmeasured rather than clean. Re-running the scan will pick it up if the per-table budget was the limit.`);
}
function nameOf(table) {
	return `${table.catalog}.${table.schema}.${table.table}`;
}
/** The described tables read in the scan window, or all of them where lineage recorded no reads. */
function activelyRead(details) {
	const active = details.tables.filter((table) => table.readEvents > 0);
	return active.length > 0 ? active : details.tables;
}
/** Up to `limit` names, with a count of the rest, for evidence that locates a finding. */
function someOf(tables, limit, describe) {
	const shown = tables.slice(0, limit).map(describe).join("; ");
	const rest = tables.length - Math.min(limit, tables.length);
	return rest > 0 ? `${shown}, and ${rest.toLocaleString("en-US")} more` : shown;
}
//#endregion
export { DETAILS, activelyRead, describedNothing, nameOf, someOf };
