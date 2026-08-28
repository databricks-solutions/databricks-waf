// Dividing one workspace's slice into pieces, when the workspace itself is too large to return.
//
// H1d executes the four widest statements once per group of workspaces, which assumes an estate is
// spread across its workspaces. Real ones are not: at the declared target the mean slice is 200 jobs
// and 57 KB, and a single workspace holding 100,000 of them reproduces the entire problem inside one
// slice. No grouping of workspaces helps — the group is one workspace and it is the workspace that
// does not fit.
//
// So a slice the warehouse had to truncate is re-executed as hash buckets on the statement's next
// declared axis: `job_id` for three of them, `cluster_id` for the fourth. That is exact for the same
// reason the workspace axis is, and for a reason no wider than that one: both are key columns of the
// statement's own `GROUP BY`, so bucketing sends every row of an output group into exactly one bucket
// and every aggregate — including the twelve `count(DISTINCT …)` expressions in
// `serverless_job_readiness` — is computed over exactly the rows it would have been. `slices.ts`
// establishes that per statement, against the SQL, and `slices.test.ts` holds all four to declaring a
// finer axis than `workspace_id` for exactly this.
//
// Two things this deliberately does not do. It does not choose the axis — the statement declares it,
// coarsest first, and a bucket on a date or a SKU would double-count silently. And it does not decide
// when to subdivide: that is a truncated result, which is a fact from the warehouse rather than an
// estimate here. See `BYTE_LIMIT` in statements.ts.

import { declaredSlice } from './slices.js';
import { quoteIdent } from '../../../scripts/sql-identifiers.mjs';

/**
 * One of `of` disjoint pieces of a slice, identified by the remainder its keys hash to.
 *
 * `index` is in `[0, of)`. Two buckets of the same slice with different indices share no row, and the
 * `of` buckets together are the slice — which is the property that makes subdividing lossless rather
 * than a sample.
 */
export interface Bucket {
  readonly of: number;
  readonly index: number;
}

/** How many pieces a slice is divided into each time it is found to be too large. */
export const FAN_OUT = 4;

/**
 * The column to bucket on, or undefined when the statement declared no finer axis than the workspace.
 *
 * Undefined is a real answer and not a missing one: a statement that declares only `workspace_id` has
 * been shown safe on that axis alone, and bucketing it on a column nobody checked is exactly the
 * silent double-counting `slices.ts` exists to prevent. The caller reports the shortfall instead.
 */
export function bucketColumn(statement: string): string | undefined {
  const columns = declaredSlice(statement)?.columns ?? [];
  return columns.length > 1 ? columns[1] : undefined;
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
export function refine(bucket: Bucket | undefined, fanOut: number = FAN_OUT): Bucket[] {
  const of = (bucket?.of ?? 1) * fanOut;
  const start = bucket?.index ?? 0;
  const stride = bucket?.of ?? 1;
  return Array.from({ length: fanOut }, (_unused, step) => ({ of, index: start + stride * step }));
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
export function bucketed(statement: string, column: string, bucket: Bucket): string {
  // The statement's own first line, extended. These statements are identified by their leading comment
  // — `-- Signal: sql:jobs.inventory` — in the task list and anywhere a query is quoted back, and a
  // wrapper that put `SELECT * FROM (` there would make every sub-slice anonymous in the one place a
  // reader looks to find out what the scan ran. Kept whole rather than reduced to a name, because the
  // line is already the identifier and reducing it would be guessing at its shape.
  const first = /^--.*$/m.exec(statement)?.[0] ?? '-- statement';
  const quoted = quoteIdent(column);
  if (quoted == null) {
    throw new Error(`Cannot bucket on ${JSON.stringify(column)}: the column name is not a quotable identifier.`);
  }
  return (
    `${first} (bucket ${String(bucket.index + 1)} of ${String(bucket.of)} on ${column})\n` +
    `SELECT * FROM (\n${statement}\n) AS sliced\nWHERE pmod(hash(sliced.${quoted}), ${String(bucket.of)}) = ` +
    `${String(bucket.index)}`
  );
}

/** How a bucket reads in a task label and in a shortfall sentence. */
export function describeBucket(bucket: Bucket | undefined): string {
  return bucket == null ? 'whole' : `bucket ${String(bucket.index + 1)}/${String(bucket.of)}`;
}
