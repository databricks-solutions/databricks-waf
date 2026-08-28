// What dividing a workspace's slice into buckets has to get right.
//
// Every test here is about losslessness. A bucket is a filter, and a filter applied to a statement the
// app counts populations from is one wrong predicate away from reporting a smaller estate than the
// customer has — silently, because a short result looks exactly like a small estate.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FAN_OUT, bucketColumn, bucketed, describeBucket, refine } from './buckets.js';
import { queryDirectory } from './queries.js';
import { declaredSlice } from './slices.js';

/** The statements the slice headers declare a finer axis for, read off disk rather than restated. */
const SLICED = ['jobs_inventory', 'compute_cluster_inventory', 'serverless_job_spend', 'serverless_job_readiness'];

function text(name: string): string {
  return readFileSync(`${queryDirectory()}/${name}.sql`, 'utf8');
}

describe('the column a slice is bucketed on', () => {
  it('is the second axis the statement declares, which is the key inside a workspace', () => {
    expect(bucketColumn('-- q\n-- Slice: workspace_id, job_id\nSELECT 1')).toBe('job_id');
  });

  it('is absent when the statement declares only the workspace', () => {
    // Not a fallback to a plausible-looking id column. `slices.ts` checks each declared axis against the
    // SQL, so an undeclared one is an axis nobody checked, and bucketing on a column the aggregates
    // consume double-counts without failing — which is the whole failure mode that module exists for.
    expect(bucketColumn('-- q\n-- Slice: workspace_id\nSELECT 1')).toBeUndefined();
    expect(bucketColumn('-- q\nSELECT 1')).toBeUndefined();
  });

  it.each(SLICED)('%s has one, so a single huge workspace is divisible', (name) => {
    const sql = text(name);
    const column = bucketColumn(sql);

    expect(column).toBeDefined();
    // And it is a key of the statement's own grouping, which is what makes filtering its output rows a
    // partition of complete rows rather than a filter inside an aggregate.
    expect(declaredSlice(sql)?.columns[0]).toBe('workspace_id');
    expect(column).not.toBe('workspace_id');
  });
});

describe('refining a slice into buckets', () => {
  it('divides an undivided slice into FAN_OUT of them, covering every remainder', () => {
    expect(refine(undefined)).toEqual([
      { of: 4, index: 0 },
      { of: 4, index: 1 },
      { of: 4, index: 2 },
      { of: 4, index: 3 },
    ]);
    expect(refine(undefined)).toHaveLength(FAN_OUT);
  });

  it('divides a bucket into exactly the keys that bucket held', () => {
    // The property the recursion rests on. `pmod(h, 4) = 1` and `pmod(h, 16) ∈ {1, 5, 9, 13}` are the
    // same set of keys, because 4 divides 16 — so a child bucket needs no reference to its parent, and
    // the children of a bucket are that bucket. Get the stride wrong and the second level would ask for
    // rows the first level already excluded: some rows twice, most never.
    expect(refine({ of: 4, index: 1 })).toEqual([
      { of: 16, index: 1 },
      { of: 16, index: 5 },
      { of: 16, index: 9 },
      { of: 16, index: 13 },
    ]);
  });

  it('partitions every key at every depth, which is the claim the whole design makes', () => {
    // Checked by simulation rather than by argument: for each of a thousand hashes, exactly one bucket
    // at each level claims it, and the bucket that claims it at depth two is a child of the one that
    // claimed it at depth one.
    const first = refine(undefined);
    for (let hash = 0; hash < 1000; hash += 1) {
      const parents = first.filter((bucket) => hash % bucket.of === bucket.index);
      expect(parents).toHaveLength(1);

      const parent = parents[0];
      if (parent == null) throw new Error('unreachable');
      const children = refine(parent).filter((bucket) => hash % bucket.of === bucket.index);
      expect(children).toHaveLength(1);
    }
  });
});

describe('the statement, restricted to one bucket', () => {
  const statement = '-- jobs_inventory\n-- Rows: one per job\nSELECT job_id FROM x ORDER BY name';

  it('filters on the hash of the bucket column, over the statement’s own output', () => {
    const sql = bucketed(statement, 'job_id', { of: 4, index: 1 });

    expect(sql).toContain('SELECT * FROM (');
    expect(sql).toContain('WHERE pmod(hash(sliced.`job_id`), 4) = 1');
    // Wrapped, not edited: the original text — comments, parameters and all — travels through
    // unchanged, so the four `.sql` files carry no predicate that is inert on every estate but the
    // largest, and `slices.ts` never has to read a filter on the grouping key it exists to look for.
    expect(sql).toContain(statement);
  });

  it('keeps the statement’s name in the first comment, which is how a task is labelled', () => {
    // The ledger and the scan's task list both identify a statement by its leading comment. A wrapper
    // that put `SELECT` there would make every sub-slice anonymous in the one place a reader looks to
    // find out what the scan actually ran.
    expect(bucketed(statement, 'job_id', { of: 16, index: 5 }).split('\n')[0]).toBe(
      '-- jobs_inventory (bucket 6 of 16 on job_id)'
    );
  });

  it('names buckets from one, because a reader counting them starts there', () => {
    expect(describeBucket({ of: 4, index: 0 })).toBe('bucket 1/4');
    expect(describeBucket(undefined)).toBe('whole');
  });
});
