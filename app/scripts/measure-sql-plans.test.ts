// Whether the apparatus measures the thing it says it measures.
//
// `scripts/measure-sql-plans.mjs` is a live script nothing in `verify` runs, so what is testable about
// it is not its readings — it is whether the statement it sent to the warehouse is the statement this
// repository ships. Q1e's whole output is a number about the bucket wrapper, and a number about a
// wrapper we do not ship is H1b's missing fixture column again: real, reproducible, and about nothing.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { bucketed as scriptBucketed, declaredSliceColumns, scansOf } from './measure-sql-plans.mjs';
import { bucketed as shippedBucketed } from '../server/collect/sql/buckets.js';
import { queryDirectory } from '../server/collect/sql/queries.js';
import { declaredSlice } from '../server/collect/sql/slices.js';

/** The four the slice headers declare a second axis for — the ones the script's cost pass runs. */
const SLICED = ['jobs_inventory', 'compute_cluster_inventory', 'serverless_job_spend', 'serverless_job_readiness'];

function text(name: string): string {
  return readFileSync(`${queryDirectory()}/${name}.sql`, 'utf8');
}

describe('the wrapper the measurement sends', () => {
  it.each(SLICED)('is the one buckets.ts builds, for %s', (name) => {
    const sql = text(name);
    const column = declaredSlice(sql)?.columns[1];
    if (column == null) throw new Error(`${name} declares no second axis`);

    expect(scriptBucketed(sql, column, 4, 1)).toBe(shippedBucketed(sql, column, { of: 4, index: 1 }));
  });

  it('differs from it the moment either changes, at every bucket index', () => {
    const sql = '-- Signal: sql:test\n-- Slice: workspace_id, job_id\nSELECT job_id FROM t GROUP BY job_id';

    for (const index of [0, 1, 2, 3]) {
      expect(scriptBucketed(sql, 'job_id', 4, index)).toBe(shippedBucketed(sql, 'job_id', { of: 4, index }));
    }
  });
});

describe('what the recording says about the bucket wrapper', () => {
  const recording = JSON.parse(
    readFileSync(new URL('../server/collect/sql/runtime-baseline/labs-plans.json', import.meta.url), 'utf8')
  ) as {
    bucketing: Record<string, { predicateAtScan?: boolean; scanFilterLines?: string[] }>;
    cost: Record<string, { rowsWhole?: number; rowsBucketed?: number; readAmplification?: number }>;
  };

  it('covers every statement the collector can bucket, and nothing it cannot', () => {
    // The set, not the count. A recording over three of the four would answer Q1e's question about a
    // subset and read as though it had answered it about the collector.
    expect(Object.keys(recording.bucketing).sort()).toEqual([...SLICED].sort());
    expect(Object.keys(recording.cost).sort()).toEqual([...SLICED].sort());
  });

  it('found the predicate at the scan on all four, which is the premise Q1e was scheduled on', () => {
    // Q1e existed to move this predicate below the grouping by hand. Measured, the engine already puts
    // it there — so this case is what fails if a future reading disagrees and the row's remedy becomes
    // worth building after all. It holds a recorded measurement rather than the engine: nothing in
    // `verify` has a warehouse.
    for (const [name, entry] of Object.entries(recording.bucketing)) {
      expect(entry.predicateAtScan, name).toBe(true);
      expect(entry.scanFilterLines?.join('\n'), name).toMatch(/pmod\(hash\(/);
    }
  });

  it('returned the same rows in four buckets as whole, on a real estate', () => {
    // Losslessness, measured rather than reasoned about. `buckets.test.ts` holds it over fixtures; this
    // holds what the warehouse did with the estate's own data on the day the recording was taken.
    for (const [name, entry] of Object.entries(recording.cost)) {
      expect(entry.rowsBucketed, name).toBe(entry.rowsWhole);
    }
  });
});

/**
 * Every relation a statement reads more than once, and why that read survived.
 *
 * `36k` found nine statements reading one relation several times, and `36m` through `36o` took four of them
 * to one read each — `uc_lineage_coverage` ten to one, `governance_audit_coverage` and
 * `estate_compute_profile` four to one, `workload_sql_paths` three to two. What is left is here, with the
 * reason, because the reasons are the part that gets lost: a scan count in a recording reads like a defect
 * to the next person, and four of these are the price of something the statement is right to want.
 *
 * Held in both directions below. A statement that starts reading something twice fails, and so does an
 * entry here whose statement stopped — otherwise a reason outlives the read it explained and the next
 * author inherits an argument for a shape nobody is using.
 *
 * The one lever measured to remove a repeated read is a `GROUP BY` on the columns whose distinct values are
 * wanted, computing an aggregate the outer query consumes; guards, joins, structs and `collect_set` do not.
 * The readings are in docs/design/q1a-runtime-baseline.md. Where an entry below says "two grains", that
 * lever does not apply, because the two reads are not the same rows asked for twice.
 */
const ACCOUNTED_REPEATS: Record<string, Record<string, { times: number; why: string }>> = {
  node_utilization: {
    'system.compute.node_timeline': {
      times: 3,
      why:
        'Blocked, not accepted: the one-aggregate rewrite measured 8% slower against read_bytes of 0 on ' +
        'both sides, because this relation is empty on labs. It needs an estate with node data (36n).',
    },
  },
  serverless_job_readiness: {
    'system.lakeflow.job_task_run_timeline': {
      times: 2,
      why: 'Two grains: an aggregate per workspace and job, and a per-row join to the cluster inventory.',
    },
  },
  serverless_job_spend: {
    'system.billing.usage': {
      times: 2,
      why: 'Two grains: aggregated per workspace and SKU to detect a region, per row to price it.',
    },
    'system.billing.list_prices': {
      times: 3,
      why:
        'serverless_rates is referenced by both published_regions and the rate join, and priced joins the ' +
        'price list itself. Removing the third means joining usage onto the rates rather than onto the ' +
        'region vocabulary, which changes what a tie in the region tiebreak weighs — a correctness ' +
        'question, not a performance one (36o).',
    },
  },
  workload_query_shapes: {
    'system.query.history': {
      times: 8,
      why:
        'per_shape computes percentile_approx, and a pre-group cannot carry a percentile: it discards the ' +
        'distribution the percentile is of, and there is no weighted form to recover it from the counts. ' +
        'Measured, size(collect_set(x)) is not a way around it — same scan count (36o).',
    },
  },
  workload_sql_paths: {
    'system.query.history': { times: 2, why: 'Two grains: the statement totals, and the client list.' },
    'system.compute.clusters': { times: 2, why: 'Two grains: the statement totals, and the client list.' },
  },
  workload_warehouse_pressure: {
    'system.query.history': {
      times: 3,
      why:
        'latency is separate from per_warehouse because, as the statement says beside it, a percentile of ' +
        'per-day percentiles is not a percentile. Same blocker as workload_query_shapes (36o).',
    },
    'system.compute.warehouse_events': {
      times: 3,
      why: 'Two grains: the events in the window, and the state carried in from before its boundary.',
    },
  },
};

describe('the repeated reads that survived', () => {
  const recording = JSON.parse(
    readFileSync(new URL('../server/collect/sql/runtime-baseline/labs-plans.json', import.meta.url), 'utf8')
  ) as { scanning: Record<string, { repeatedRelations?: Record<string, number> }> };

  it('are the ones accounted for, and no more times than accounted for', () => {
    for (const [name, entry] of Object.entries(recording.scanning)) {
      for (const [relation, times] of Object.entries(entry.repeatedRelations ?? {})) {
        const accounted = ACCOUNTED_REPEATS[name]?.[relation];
        expect(
          accounted,
          `${name} reads ${relation} ${String(times)} times and nothing says why. Either take it to one ` +
            'read, or add it above with the reason it stays.'
        ).toBeDefined();
        // Not equality: fewer reads than accounted for is an improvement, and a test that fails on one
        // teaches people to leave the number alone.
        expect(times, `${name} / ${relation}`).toBeLessThanOrEqual(accounted?.times ?? 0);
      }
    }
  });

  it('still read what the reasons above are about', () => {
    for (const [name, relations] of Object.entries(ACCOUNTED_REPEATS)) {
      const recorded = recording.scanning[name]?.repeatedRelations ?? {};
      for (const relation of Object.keys(relations)) {
        expect(
          recorded[relation],
          `${name} no longer reads ${relation} more than once. Delete its entry above rather than leaving ` +
            'a reason for a shape this statement has stopped having.'
        ).toBeGreaterThan(1);
      }
    }
  });
});

describe('what the plan reader counts as a read', () => {
  // The three shapes `EXPLAIN FORMATTED` returns for these statements, quoted from real plans taken on
  // labs 2026-08-11. This case exists because the first version of the reader recognised only the first
  // shape, so every statement whose reads arrive as local relations reported zero scans and "no relation
  // read twice" — a clean refutation of Q1k's premise, produced by a plan containing no reads at all.
  // Two of the four statements the premise named are in that group.
  const FILE_SCAN = [
    '(1) Scan parquet system.lakeflow.jobs',
    'Output [14]: [workspace_id#1, job_id#2L, name#3, run_as#4, trigger_type#5]',
    'ReadSchema: struct<workspace_id:string,job_id:bigint>',
    '',
    '(2) PhotonFilter',
    'Input [14]: [workspace_id#1]',
  ].join('\n');

  const EMPTY_LOCAL = [
    '(1) LocalTableScan',
    'Output [4]: [snapshot_date#23619, active_bytes#23629L, active_files#23630L, po#23633]',
    'Arguments: <empty>, [snapshot_date#23619]',
  ].join('\n');

  const METASTORE_LOCAL = ['(4) LocalTableScan', 'Output: []', 'Arguments: [catalog_name#7]'].join('\n');

  it('counts a file scan, with the columns the engine says it reads', () => {
    const { scans, folded } = scansOf(FILE_SCAN);

    expect(scans).toHaveLength(1);
    expect(scans[0]?.relation).toBe('system.lakeflow.jobs');
    expect(scans[0]?.columnCount).toBe(14);
    expect(folded).toHaveLength(0);
  });

  it('separates a read that folded because the relation is empty from one that did not', () => {
    // The distinction the recording turns on. Both are `LocalTableScan` and neither is a scan, but one
    // says "this estate holds none of it" and the other says "the metastore answered without a scan".
    // Collapsing them would put `storage_table_metrics`, whose table is empty on labs, in with the
    // `information_schema` statements, whose tables are not.
    expect(scansOf(EMPTY_LOCAL).folded[0]?.emptyArguments).toBe(true);
    expect(scansOf(METASTORE_LOCAL).folded[0]?.emptyArguments).toBe(false);
    expect(scansOf(EMPTY_LOCAL).scans).toHaveLength(0);
    expect(scansOf(METASTORE_LOCAL).scans).toHaveLength(0);
  });

  it('does not count the one-row source of a scalar projection as a read', () => {
    // `uc_platform_census` is eighteen scalar subqueries over a `OneRowRelation`, and counting that as a
    // scan put "1 scan, widest reads 0 columns" beside a statement that reads eighteen relations.
    expect(scansOf('(1) Scan OneRowRelation\nOutput: []').scans).toHaveLength(0);
  });

  it('counts one entry per time the plan performs the read, which is what a repeat is', () => {
    const twice = [FILE_SCAN, FILE_SCAN.replace('(1)', '(9)')].join('\n');

    expect(scansOf(twice).scans.map((scan) => scan.relation)).toEqual([
      'system.lakeflow.jobs',
      'system.lakeflow.jobs',
    ]);
  });
});

describe('the statements the measurement picks', () => {
  it('are the ones the shipped slice reader picks, and no others', () => {
    // The script reads the `-- Slice:` header with its own regex rather than importing `slices.ts`, for
    // the same build reason the wrapper is copied. Read off disk, the two have to select the same four:
    // a cost measured over a fifth statement, or missing one of these, describes a different scan.
    const chosen = SLICED.map(text).filter((sql) => declaredSliceColumns(sql).length > 1);

    expect(chosen).toHaveLength(SLICED.length);
    for (const sql of SLICED.map(text)) {
      expect(declaredSliceColumns(sql)).toEqual(declaredSlice(sql)?.columns);
    }
  });

  it('reads a mixed-case header the way the shipped reader does', () => {
    // None of the four is mixed case, so the case above cannot catch this. It matters because the two
    // readings disagreeing does not fail anything: the script would bucket on `Job_id` and the collector
    // on `job_id`, and the recording would describe a wrapper nobody sends.
    const sql = '-- Signal: sql:test\n-- Slice: Workspace_ID, Job_Id\nSELECT 1';

    expect(declaredSliceColumns(sql)).toEqual(['workspace_id', 'job_id']);
    expect(declaredSliceColumns(sql)).toEqual(declaredSlice(sql)?.columns);
  });
});
