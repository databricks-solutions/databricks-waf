import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { declaredBound } from './bounds.js';
import { columnsOf } from './columns.js';
import { queryDirectory } from './queries.js';
import { SAMPLES } from './scale-fixtures.js';
import {
  GROWTH_MARGIN,
  INLINE_CAP_BYTES,
  SCALE_TARGETS,
  bytesAtScale,
  insufficientMargin,
  percentOfCap,
  rowsAtTarget,
} from './scale.js';

// What an unbounded statement actually costs at the size this app says it handles.
//
// H1a produced a list of eight statements whose row count grows with the estate, by counting `GROUP BY`
// clauses. The cap that kills a scan is not a row count, it is 25 MiB of inline JSON, so "unbounded"
// and "fails at the declared target" are different claims and nobody had measured the second.
//
// **Two of the eight are over the cap at target scale, and both fail below the target.**
// `compute_cluster_inventory` is 153% of an inline result at 150,000 clusters and fails at 97,759.
// `serverless_job_readiness` is 27.6 MiB at 100,000 jobs, 110%, and fails outright at 90,606 — so a
// customer with the estate this app claims to assess gets no serverless analysis at all, today. Two more
// fit and fail on growth: `jobs_inventory` at 124,034 and `serverless_job_spend` at 136,877.
//
// The cluster statement joined this list rather than being found on it. It measured 51% while its target
// was a guessed 50,000; E1 measured a real account at 135,177 live cluster definitions, the target became
// that, and the same statement is now the worst of the eight. Nothing about the statement changed. This
// is what a target chosen rather than measured buys you, and it is why they are pinned below.
//
// Read the first version of this file for how not to do it. It reported 99% for the readiness statement
// and concluded that nothing exceeded the cap, because the fixture behind it carried twenty-eight values
// against a statement returning twenty-nine — the `runtimes` list was missing, so the measurement was of
// a narrower statement than the real one, and the conclusion was confidently wrong in the direction
// nobody checks. A reviewer caught it. `has a sample as wide as the statement it measures` is now the
// first assertion here, and the lesson is that a measurement inherits the credibility of its apparatus
// and no more.
//
// The gate is still `GROWTH_MARGIN` rather than the cap, because a statement that fits at the target and
// fails at 1.24x is a statement that breaks on a customer's growth, which a cap comparison cannot
// express. It splits the eight four and four, and the split lands where the plan's own per-statement
// notes put it — the four that fail are the four described as wanting a `GROUP BY` or a top-N, the four
// that pass are the ones described as "the shape is wrong rather than the size" and "inside the
// ceiling". The plan's prose was right; only its summary, and then this file's first answer, were wrong.
//
// The eleven bounded statements are not measured here. Their ceilings are a fixed count under 1,000 or
// a parameter the collector binds, so there is no scale at which they grow, and `bounds.ts` holds them
// to it at runtime.

/**
 * The statements with too little room at target scale, and what makes each one wide.
 *
 * Every entry is a live defect. Not "fails today" for most of them — three fit at target and one is at
 * 51% — but a statement whose failure point is within a factor of two of the declared estate is a
 * statement that fails on a customer's growth, and it fails by returning nothing.
 *
 * Written to only shrink. An entry left behind after a statement is bounded fails as loudly as a new
 * one appearing, because that stale entry is what tells the next reader the work is still owed.
 */
const TOO_TIGHT = {
  serverless_job_readiness:
    'twenty-seven aggregate columns and two sampled lists, cluster names and runtimes, one row per job — and the only one of the eight already past the cap at target scale',
  jobs_inventory: 'sixteen columns including a job name, one row per job',
  serverless_job_spend: 'eleven columns including a SKU-name list, one row per job',
  compute_cluster_inventory:
    'twenty-two columns including two node types and a cluster name, one row per cluster — and `system.compute.clusters` holds a row per job-cluster definition, so a large account measures 135,177 live ones',
};

const statements = readdirSync(queryDirectory())
  .filter((name) => name.endsWith('.sql'))
  .map((name) => name.replace(/\.sql$/, ''))
  .sort();

/** The estate-scaled statements, read from the headers rather than listed again here. */
const scaled = statements
  .map((name) => {
    const text = readFileSync(join(queryDirectory(), `${name}.sql`), 'utf8');
    return { name, bound: declaredBound(text) };
  })
  .filter((entry) => entry.bound?.kind === 'estate-scaled')
  .map((entry) => ({ name: entry.name, per: entry.bound?.kind === 'estate-scaled' ? entry.bound.per : '' }));

describe('an inline result at the declared estate size', () => {
  it('has a statement to measure, so a passing run is not an empty one', () => {
    expect(scaled.length).toBeGreaterThan(0);
  });

  it('has a sample for every estate-scaled statement', () => {
    // A statement with no fixture is a statement nobody measured, which is how eight of them went
    // unnoticed while a comment asserted they were all aggregates.
    expect(scaled.filter((entry) => !(entry.name in SAMPLES)).map((entry) => entry.name)).toEqual([]);
  });

  it('has a sample as wide as the statement it measures', () => {
    // The check this measurement most needed and did not have. The `serverless_job_readiness` sample
    // stopped at `cluster_names` and never carried the `runtimes` list after it, twenty-eight values
    // against twenty-nine columns, which measured a statement that does not exist and put it at 99% of
    // the cap rather than the 110% it is — the wrong headline for the pull request that added the
    // measuring. Nothing here caught that; a reviewer did.
    const wrong = scaled
      .map((entry) => {
        const columns = columnsOf(readFileSync(join(queryDirectory(), `${entry.name}.sql`), 'utf8'));
        const widths = new Set((SAMPLES[entry.name]?.() ?? []).map((row) => row.length));
        const width = widths.size === 1 ? [...widths][0] : undefined;
        if (width === columns.length) return undefined;
        if (width == null) {
          return `${entry.name} builds rows of differing widths (${[...widths].join(', ')}), so one of them is wrong`;
        }
        // From one before the shorter of the two, so the tail names the columns around the discrepancy
        // whichever side is short — a fixture wider than its statement would otherwise report nothing.
        const from = Math.max(0, Math.min(width, columns.length) - 1);
        return (
          `${entry.name} samples ${String(width)} values against ${String(columns.length)} columns, ` +
          `discrepancy at or after: ${columns.slice(from).map((column) => column ?? '?').join(', ')}`
        );
      })
      .filter((problem) => problem != null);

    expect(wrong).toEqual([]);
  });

  it('samples workspace urls from all three clouds, not just the widest one', () => {
    // Caught by review, not by a check. The sample issued only Azure URLs, which measures a plausible
    // width — the Azure form is the longest — and still describes an estate this app does not have: it
    // installs on AWS, Azure and GCP. A ceiling measured on one cloud's host names invites the reader
    // to treat the widest case as the only case.
    const urls = (SAMPLES.workspace_directory?.() ?? []).map((row) => row[2] ?? '');
    const clouds = {
      aws: urls.filter((url) => url.includes('.cloud.databricks.com')),
      azure: urls.filter((url) => url.includes('.azuredatabricks.net')),
      gcp: urls.filter((url) => url.includes('.gcp.databricks.com')),
    };

    expect(Object.entries(clouds).filter(([, matched]) => matched.length === 0).map(([cloud]) => cloud)).toEqual([]);
    // Every URL accounted for, so a malformed host cannot hide behind the three that matched.
    expect(clouds.aws.length + clouds.azure.length + clouds.gcp.length).toBe(urls.length);
    // Within the range measured from `system.access.workspaces_latest`, allowing for the vanity form's
    // spread: 41 to 56 there, and the generated forms sit inside it.
    const widths = urls.map((url) => url.length);
    expect(Math.min(...widths)).toBeGreaterThanOrEqual(35);
    expect(Math.max(...widths)).toBeLessThanOrEqual(70);
  });

  it('has a declared target for every axis a statement scales on', () => {
    const undeclared = scaled.filter((entry) => rowsAtTarget(entry.per) == null);
    expect(
      undeclared.map((entry) => `${entry.name} scales per ${entry.per}, which SCALE_TARGETS does not name`)
    ).toEqual([]);
  });

  it('has no sample for a statement that is not estate-scaled', () => {
    // The other direction, so a fixture left behind after a statement is bounded does not sit here
    // implying work that is done.
    const names = new Set(scaled.map((entry) => entry.name));
    expect(Object.keys(SAMPLES).filter((name) => !names.has(name))).toEqual([]);
  });

  describe.each(scaled)('$name', ({ name, per }) => {
    const rows = rowsAtTarget(per) ?? 0;
    const bytes = bytesAtScale(SAMPLES[name]?.() ?? [], rows);
    const tight = insufficientMargin(bytes, rows, per);
    const at = `${percentOfCap(bytes)} of the cap at ${rows.toLocaleString('en-US')} rows`;

    if (name in TOO_TIGHT) {
      it(`has too little room, at ${at}`, () => {
        expect(
          tight,
          `${name} now fits at ${String(GROWTH_MARGIN)}x the target (${at}). Take it off TOO_TIGHT here, ` +
            `off the ESTATE_SCALED manifest in scripts/check-statement-bounds.mjs if it is now bounded, and ` +
            `off the H1b list in docs/plan-status.md.`
        ).toBeDefined();
      });
    } else {
      it(`has room to grow, at ${at}`, () => {
        expect(tight, `${name} ${tight ?? ''}`).toBeUndefined();
      });
    }
  });

  it('names no statement in TOO_TIGHT that does not exist or is already bounded', () => {
    const names = new Set(scaled.map((entry) => entry.name));
    expect(Object.keys(TOO_TIGHT).filter((name) => !names.has(name))).toEqual([]);
  });

  it('measures against the targets it declares, not against numbers in the test', () => {
    // Pins the targets so a failing ceiling cannot be resolved by quietly shrinking the estate the app
    // claims to handle, which is the cheapest way to make all of this pass and learn nothing.
    //
    // `cluster` moved once, up, from a guessed 50,000 to a measured 135,177 rounded to 150,000. The pin
    // did its job: raising it had to be argued for here rather than edited into scale.ts alone.
    expect(SCALE_TARGETS).toEqual({
      workspace: 500,
      job: 100_000,
      cluster: 150_000,
      warehouse: 1_000,
      pipeline: 10_000,
      catalog: 1_000,
      table: 1_000_000,
      historyDays: 30,
    });
    expect(INLINE_CAP_BYTES).toBe(26_214_400);
    expect(GROWTH_MARGIN).toBe(2);
  });
});
