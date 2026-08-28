import { declaredSlice } from "./slices.js";
import { quoteIdent } from "../../scripts/sql-identifiers.js";
/**
* The column to bucket on, or undefined when the statement declared no finer axis than the workspace.
*
* Undefined is a real answer and not a missing one: a statement that declares only `workspace_id` has
* been shown safe on that axis alone, and bucketing it on a column nobody checked is exactly the
* silent double-counting `slices.ts` exists to prevent. The caller reports the shortfall instead.
*/
function bucketColumn(statement) {
	const columns = declaredSlice(statement)?.columns ?? [];
	return columns.length > 1 ? columns[1] : void 0;
}
/**
* The buckets a slice — or a bucket of one — divides into.
*
* The nesting is what makes recursion work without tracking a tree. A bucket is a congruence class:
* `pmod(hash, 4) = 1` is every key whose hash is 1 mod 4. Multiplying the modulus by the fan-out
* refines it, because 4 divides 16 and so `pmod(hash, 16) ∈ {1, 5, 9, 13}` is exactly the same set of
* keys, partitioned four ways. So a child bucket needs no reference to its parent: its own modulus and
* index say which rows it holds, and the rows of the children are the rows of the parent.
*/
function refine(bucket, fanOut = 4) {
	const of = (bucket?.of ?? 1) * fanOut;
	const start = bucket?.index ?? 0;
	const stride = bucket?.of ?? 1;
	return Array.from({ length: fanOut }, (_unused, step) => ({
		of,
		index: start + stride * step
	}));
}
/**
* The statement, returning only the rows of one bucket.
*
* Wrapped rather than edited. The alternative is a `:bucket` parameter in each of the four `.sql`
* files, which puts a predicate every author has to maintain into statements where it is inert for
* every estate but the largest — and puts it inside the SQL that `slices.ts` reads, where a filter on
* the grouping key is the shape that rule exists to look for.
*
* Filtering the statement's own output is correct here for a reason specific to these four: the bucket
* column is a key of the `GROUP BY`, so the statement returns one row per key and the aggregates in it
* were computed before this predicate is applied. Nothing is being filtered out of an aggregate — the
* rows of one bucket are complete rows, and the buckets together are the whole result.
*
* The wrapped statement's own `ORDER BY` is inside a subquery and is not guaranteed to survive the
* optimiser. It does not need to: the caller re-sorts the concatenation from the outer statement's
* declared order key. See concat.ts.
*/
function bucketed(statement, column, bucket) {
	const first = /^--.*$/m.exec(statement)?.[0] ?? "-- statement";
	const quoted = quoteIdent(column);
	if (quoted == null) throw new Error(`Cannot bucket on ${JSON.stringify(column)}: the column name is not a quotable identifier.`);
	return `${first} (bucket ${String(bucket.index + 1)} of ${String(bucket.of)} on ${column})\nSELECT * FROM (\n${statement}\n) AS sliced\nWHERE pmod(hash(sliced.${quoted}), ${String(bucket.of)}) = ${String(bucket.index)}`;
}
/** How a bucket reads in a task label and in a shortfall sentence. */
function describeBucket(bucket) {
	return bucket == null ? "whole" : `bucket ${String(bucket.index + 1)}/${String(bucket.of)}`;
}
//#endregion
export { bucketColumn, bucketed, describeBucket, refine };
